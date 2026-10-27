# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Facade colour calibration post-pass: adds `buildings[].observed.walls[].tone_cal` to data/cph-geodata.json.

The photogrammetric tones (`tone`, appearance/2) have three problems when they are shown as albedo:
  * 53% of the observed walls come from a shadowed view; white-balancing leaves them dark and with a blue/purple cast
    (OKLab hue 260-320 deg is the commonest hue among their coloured walls), which reads flat next to the sunlit walls;
  * the sunlit walls are nearly neutral (median chroma 0.008) and very light, so whole streets look washed out;
  * brick buildings come out as pale pink ("salmon") instead of Copenhagen red-brown or yellow ("gule") brick.

`tone_cal` (sRGB 0-1, additive: `tone`/`tone_raw` are untouched) is made per wall in OKLab:
  1. shadow-sourced walls get the building's own sunlit-vs-shadow offset (median sunlit minus median shadow of the same
     building: same material, different light); buildings without sunlit walls take the median offset of buildings within
     NEIGHBOUR_R metres that have both (same street side by proximity), else a global transfer fitted on all such
     buildings (L' = a + b L, chroma-plane shift);
  2. chroma is restored (CHROMA_GAIN, soft-capped);
  3. BBR `mursten` walls with a pinkish hue become red-brown brick (darker) or yellow brick (lighter);
  4. lightness is compressed above L_SHOULDER and floored, and the colour is clipped to the sRGB gamut by reducing chroma.
`cal` records the route: own | neighbours | global | none (sunlit / unchanged), `cal_brick` marks rule 3.

    uv run tools/cph-geodata/appearance_calibrate.py [--check]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
NEIGHBOUR_R = 90.0
MIN_NEIGHBOURS = 3
CHROMA_GAIN = 2.2
CHROMA_SOFT_MAX = 0.09
L_SHOULDER = 0.70
L_MAX = 0.84
L_MIN = 0.28
OFFSET_L_RANGE = (-0.05, 0.25)
OFFSET_AB_MAX = 0.06

_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
_M1I = np.linalg.inv(_M1)
_M2I = np.linalg.inv(_M2)


def _to_lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _to_srgb(c):
    c = np.clip(np.asarray(c, float), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def srgb_to_oklab(rgb):
    return _M2 @ np.cbrt(_M1 @ _to_lin(rgb))


def oklab_to_linear(lab):
    return _M1I @ (_M2I @ np.asarray(lab, float)) ** 3


def in_gamut(lab, eps=1e-4):
    lin = oklab_to_linear(lab)
    return bool(np.all(lin >= -eps) and np.all(lin <= 1 + eps))


def clip_to_gamut(lab):
    """Reduce chroma (keeping lightness and hue) until the colour is inside sRGB; returns sRGB 0-1."""
    lab = np.array(lab, float)
    lab[0] = float(np.clip(lab[0], 0.0, 1.0))
    if not in_gamut(lab):
        lo, hi = 0.0, 1.0
        for _ in range(24):
            mid = (lo + hi) / 2
            if in_gamut([lab[0], lab[1] * mid, lab[2] * mid]):
                lo = mid
            else:
                hi = mid
        lab[1:] *= lo
    return _to_srgb(np.clip(oklab_to_linear(lab), 0, 1))


def lch(lab):
    return float(lab[0]), float(np.hypot(lab[1], lab[2])), float(np.degrees(np.arctan2(lab[2], lab[1])) % 360)


def from_lch(L, C, h):
    r = np.radians(h)
    return np.array([L, C * np.cos(r), C * np.sin(r)])


def brick_rule(lab):
    """Pinkish (hue 15-75 deg, C >= 0.03) brick: darker ones become red-brown brick, light ones yellow brick."""
    L, C, h = lch(lab)
    if C < 0.03 or not 15 <= h <= 75:
        return lab, False
    if L > 0.70:  # pale pink: cream / "gule mursten"
        return from_lch(min(L, 0.78), float(np.clip(C * 1.5, 0.05, 0.08)), 88.0), True
    return from_lch(min(L, 0.56), float(np.clip(max(C * 1.8, 0.07), 0.07, 0.11)), 42.0 + 0.3 * (h - 42.0)), True


def finish(lab, mursten=False):
    """Steps 2-4 of the module docstring on an OKLab colour; returns (sRGB, brick_flag)."""
    L, C, h = lch(lab)
    gain = CHROMA_GAIN
    C2 = C * gain
    if C2 > CHROMA_SOFT_MAX:  # soft cap: do not push already vivid walls further
        C2 = CHROMA_SOFT_MAX + (C2 - CHROMA_SOFT_MAX) * 0.3
        C2 = min(C2, max(C, CHROMA_SOFT_MAX))
    lab2 = from_lch(L, C2, h)
    brick = False
    if mursten:
        lab2, brick = brick_rule(lab2)
    L2 = lab2[0]
    if L2 > L_SHOULDER:
        L2 = L_SHOULDER + (L2 - L_SHOULDER) * 0.55
    lab2[0] = float(np.clip(L2, L_MIN, L_MAX))
    return clip_to_gamut(lab2), brick


def _centroid(ring):
    n = len(ring) // 2
    return sum(ring[0::2]) / n, sum(ring[1::2]) / n


def _is_observed(w):
    return w.get("conf", "").startswith("observed") and isinstance(w.get("tone"), list)


def building_offsets(buildings):
    """{id: (offset OKLab 3-vector, centroid)} for buildings with sunlit and shadow-sourced observed walls."""
    out = {}
    for b in buildings:
        walls = [w for w in (b.get("observed") or {}).get("walls", []) if _is_observed(w)]
        sun = [srgb_to_oklab(w["tone"]) for w in walls if w.get("sunlit")]
        sh = [srgb_to_oklab(w["tone"]) for w in walls if not w.get("sunlit")]
        if not sun or not sh:
            continue
        off = np.median(sun, axis=0) - np.median(sh, axis=0)
        off[0] = np.clip(off[0], *OFFSET_L_RANGE)
        n = np.hypot(off[1], off[2])
        if n > OFFSET_AB_MAX:
            off[1:] *= OFFSET_AB_MAX / n
        out[b["id"]] = (off, _centroid(b["ring"]), float(np.median([x[0] for x in sh])))
    return out


def global_transfer(offsets):
    """(alpha, beta, dab): L' = alpha + beta L, (a, b)' = (a, b) + dab, fitted on buildings having both sunlit and shadow walls."""
    if len(offsets) < 5:
        return 0.0, 1.0, np.zeros(2)
    ls = np.array([v[2] for v in offsets.values()])
    dl = np.array([v[0][0] for v in offsets.values()])
    beta1, alpha1 = np.polyfit(ls, ls + dl, 1)
    dab = np.median([v[0][1:] for v in offsets.values()], axis=0)
    return float(alpha1), float(beta1), dab


def calibrate(geo: dict, offsets: dict | None = None, transfer: tuple | None = None) -> dict:
    """Adds tone_cal / cal / cal_brick to every observed wall entry of `geo` in place; returns statistics.

    `offsets` / `transfer` (default: derived from `geo` itself) let a citywide run pass the sunlit-vs-shadow offsets of the
    buildings around a cell (neighbours across the cell border) and the citywide global transfer."""
    buildings = geo["buildings"]
    if offsets is None:
        offsets = building_offsets(buildings)
    alpha, beta, dab = transfer if transfer is not None else global_transfer(offsets)
    ids = list(offsets)
    cents = np.array([offsets[i][1] for i in ids]) if ids else np.zeros((0, 2))
    offs = np.array([offsets[i][0] for i in ids]) if ids else np.zeros((0, 3))
    stats = {"routes": {"own": 0, "neighbours": 0, "global": 0, "none": 0}, "brick": 0}
    for b in buildings:
        obs = b.get("observed")
        if not obs:
            continue
        mursten = b.get("wall_material") == "mursten"
        c = _centroid(b["ring"])
        own = offsets.get(b["id"])
        neigh = None
        cal_tones = []
        for w in obs["walls"]:
            if not _is_observed(w):
                continue
            lab = srgb_to_oklab(w["tone"])
            route = "none"
            if not w.get("sunlit"):
                if own is not None:
                    lab = lab + own[0]
                    route = "own"
                else:
                    if neigh is None:
                        neigh = False
                        if len(ids):
                            d = np.hypot(cents[:, 0] - c[0], cents[:, 1] - c[1])
                            m = d <= NEIGHBOUR_R
                            if m.sum() >= MIN_NEIGHBOURS:
                                neigh = np.median(offs[m], axis=0)
                    if neigh is not False:
                        lab = lab + neigh
                        route = "neighbours"
                    else:
                        lab = np.array([alpha + beta * lab[0], lab[1] + dab[0], lab[2] + dab[1]])
                        route = "global"
            rgb, brick = finish(lab, mursten)
            w["tone_cal"] = [round(float(x), 3) for x in rgb]
            w["cal"] = route
            if brick:
                w["cal_brick"] = True
                stats["brick"] += 1
            stats["routes"][route] += 1
            cal_tones.append(w["tone_cal"])
        # unseen walls (conf inferred) follow the calibrated median of their building
        for w in obs["walls"]:
            if _is_observed(w):
                continue
            if cal_tones:
                w["tone_cal"] = [round(float(x), 3) for x in np.median(cal_tones, axis=0)]
                w["cal"] = "building"
            elif isinstance(w.get("tone"), list):
                rgb, _ = finish(srgb_to_oklab(w["tone"]), False)
                w["tone_cal"] = [round(float(x), 3) for x in rgb]
                w["cal"] = "none"
    stats["global"] = {"alpha": round(alpha, 4), "beta": round(beta, 4), "dab": [round(float(x), 4) for x in dab], "pair_buildings": len(offsets)}
    geo.setdefault("appearance", {})["calibration"] = {"version": "appearance-cal/1", **{k: stats[k] for k in ("routes", "brick", "global")}}
    return stats


def summarise(geo: dict, key: str) -> dict:
    """Mean OKLab L and chroma of observed walls by group for tone field `key` (tone | tone_cal)."""
    groups = {"all": [], "sunlit": [], "shadow": [], "brick": []}
    for b in geo["buildings"]:
        for w in (b.get("observed") or {}).get("walls", []):
            if not _is_observed(w) or key not in w:
                continue
            L, C, _ = lch(srgb_to_oklab(w[key]))
            groups["all"].append((L, C))
            groups["sunlit" if w.get("sunlit") else "shadow"].append((L, C))
            if b.get("wall_material") == "mursten":
                groups["brick"].append((L, C))
    return {k: {"n": len(v), "L": round(float(np.mean([x[0] for x in v])), 3), "C": round(float(np.mean([x[1] for x in v])), 4)} for k, v in groups.items() if v}


def main(argv=None) -> int:
    path = ROOT / "data/cph-geodata.json"
    geo = json.loads(path.read_text())
    before = summarise(geo, "tone")
    stats = calibrate(geo)
    after = summarise(geo, "tone_cal")
    print(json.dumps({"before": before, "after": after, **stats}, indent=1))
    if "--check" not in (argv or sys.argv[1:]):
        path.write_text(json.dumps(geo, separators=(",", ":"), ensure_ascii=False))
        print("wrote", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
