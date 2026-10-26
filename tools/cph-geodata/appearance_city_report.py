# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "rasterio", "pyproj", "requests", "numba", "shapely"]
# ///
"""Validation and coverage reports of the citywide appearance run.

    uv run tools/cph-geodata/appearance_city_report.py validate        # this run vs the district geodata, district buildings only
    uv run tools/cph-geodata/appearance_city_report.py coverage        # data/city/appearance-coverage.md + data/city/appearance-qa.png

`validate` compares the citywide pipeline's tones (final.pkl.gz `observed`, which is NOT what the tile layer carries for the
district) with the observed layer data/cph-geodata.json holds today: per-wall CIELAB dE76 and RGB error of `tone` and `tone_cal`,
per-building wall tone, per-building roof tone and roof type hint agreement, and the observed coverage on both sides.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import appearance as A  # noqa: E402
import appearance_city as C  # noqa: E402


def srgb_to_lab(rgb) -> np.ndarray:
    lin = A.srgb2lin(np.atleast_2d(np.asarray(rgb, float)))
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.column_stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])])


def de76(a, b) -> np.ndarray:
    return np.linalg.norm(srgb_to_lab(a) - srgb_to_lab(b), axis=1)


def q(x, ps=(50, 90)) -> dict:
    x = np.asarray(x, float)
    return {f"p{p}": round(float(np.percentile(x, p)), 3) for p in ps} if len(x) else {}


def validate() -> dict:
    geo = json.loads((C.ROOT / "data" / "cph-geodata.json").read_text())
    ref = {b["id"]: b["observed"] for b in geo["buildings"] if b.get("observed")}
    new = {}
    for cell in C.all_cells():
        p = C.cell_dir(cell) / "final.pkl.gz"
        if p.exists():
            for bid, o in C.load_pkl(p)["observed"].items():
                if bid in ref:
                    new[bid] = o
    common = [b for b in ref if b in new]
    res: dict = {"district_buildings": len(ref), "compared": len(common)}
    rows = {"tone": ([], []), "tone_cal": ([], [])}
    cov = {"ref_walls_obs": 0, "new_walls_obs": 0, "both": 0, "walls": 0, "sunlit_agree": 0}
    bw_ref, bw_new, rf_ref, rf_new, hint = [], [], [], [], [0, 0]
    for bid in common:
        rw = {(w["ring"], w["edge"]): w for w in ref[bid]["walls"]}
        nw = {(w["ring"], w["edge"]): w for w in new[bid]["walls"]}
        wt_r, wt_n = [], []
        for k, a in rw.items():
            b = nw.get(k)
            if b is None:
                continue
            cov["walls"] += 1
            ao, bo = a["conf"] != "inferred", b["conf"] != "inferred"
            cov["ref_walls_obs"] += ao
            cov["new_walls_obs"] += bo
            if ao and bo:
                cov["both"] += 1
                cov["sunlit_agree"] += bool(a.get("sunlit")) == bool(b.get("sunlit"))
                for key in rows:
                    if key in a and key in b:
                        rows[key][0].append(a[key]); rows[key][1].append(b[key])
            if ao:
                wt_r.append(a.get("tone_cal") or a["tone"])
            if bo:
                wt_n.append(b.get("tone_cal") or b["tone"])
        if wt_r and wt_n:
            bw_ref.append(np.median(wt_r, axis=0)); bw_new.append(np.median(wt_n, axis=0))
        ra, rb = ref[bid].get("roof") or {}, new[bid].get("roof") or {}
        if ra.get("conf") == "observed" and rb.get("conf") == "observed":
            rf_ref.append(ra["tone"]); rf_new.append(rb["tone"])
            hint[0] += 1
            hint[1] += ra.get("type_hint") == rb.get("type_hint")
    res["wall_coverage"] = cov
    for key, (a, b) in rows.items():
        if a:
            a, b = np.array(a), np.array(b)
            err = np.abs(a - b)
            res[f"wall_{key}"] = {"n": len(a), "dE76": q(de76(a, b)), "abs_rgb_err_255": {"median": [round(float(x) * 255, 2) for x in np.median(err, axis=0)],
                                                                                     "p90": [round(float(x) * 255, 2) for x in np.percentile(err, 90, axis=0)]},
                                   "mean_signed_rgb_255": [round(float(x) * 255, 2) for x in np.mean(b - a, axis=0)]}
    if bw_ref:
        a, b = np.array(bw_ref), np.array(bw_new)
        res["building_wall_tone_cal"] = {"n": len(a), "dE76": q(de76(a, b)), "abs_rgb_err_255_median": [round(float(x) * 255, 2) for x in np.median(np.abs(a - b), axis=0)]}
    if rf_ref:
        a, b = np.array(rf_ref), np.array(rf_new)
        res["roof_tone"] = {"n": len(a), "dE76": q(de76(a, b)), "abs_rgb_err_255_median": [round(float(x) * 255, 2) for x in np.median(np.abs(a - b), axis=0)],
                            "type_hint_agree": round(hint[1] / max(hint[0], 1), 3)}
    return res


def kommuner():
    from shapely.geometry import shape
    from shapely.prepared import prep

    doc = json.loads((C.ROOT / "data" / "city" / "boundary.geojson").read_text())
    out = {}
    for f in doc["features"]:
        if f["properties"].get("kind") == "kommune":
            out[f["properties"]["navn"]] = prep(shape(f["geometry"]))
    return out


def coverage() -> str:
    from PIL import Image, ImageDraw
    from shapely.geometry import Point

    kom = kommuner()
    idx = C.tile_index()
    rows: dict[str, dict] = {}
    pool = []
    def row(name):
        return rows.setdefault(name, {"buildings": 0, "wall_obs": 0, "roof_obs": 0, "atlas": 0, "walls": 0, "walls_observed": 0, "tile_bytes": 0})
    tex_look = C.ROOT / "data" / "tex-look"
    for tid, info in idx.items():
        pa, pb = C.TILES / tid / "appearance.json", C.TILES / tid / "buildings.json"
        if not pb.exists():
            continue
        bs = C.jload(pb)["buildings"]
        ap = C.jload(pa)["buildings"] if pa.exists() else {}
        tb = pa.stat().st_size if pa.exists() else 0
        for b in bs:
            if len(b.get("ring", [])) < 6:
                continue
            cx, cz = C.centroid(b)
            e, n = cx + 723900.0, 6176500.0 - cz
            name = next((k for k, g in kom.items() if g.contains(Point(e, n))), "outside DAGI boundary")
            r = row(name)
            r["buildings"] += 1
            r["tile_bytes"] += tb / max(len(bs), 1)
            a = ap.get(b["id"])
            if not a:
                continue
            obsw = [w for w in a["walls"] if w["conf"] != "inferred"]
            r["walls"] += len(a["walls"]); r["walls_observed"] += len(obsw)
            r["wall_obs"] += bool(obsw)
            roof = a.get("roof") or {}
            r["roof_obs"] += roof.get("conf") == "observed"
            has_atlas = bool(a.get("atlas")) and (tex_look / (b["id"].replace(":", "_") + ".webp")).exists()
            r["atlas"] += has_atlas
            pool.append((b["id"], name, tid, bool(obsw), roof.get("conf") == "observed", has_atlas))
    tot = {k: sum(r[k] for r in rows.values()) for k in ("buildings", "wall_obs", "roof_obs", "atlas", "walls", "walls_observed")}
    pct = lambda x, n: f"{100 * x / max(n, 1):.1f} %"
    L = ["# Citywide appearance coverage", "", f"Source: `data/tiles/<id>/appearance.json` (cph-appearance/1) of {sum(1 for t in idx if (C.TILES / t / 'appearance.json').exists())} tiles; "
         "kommune by building centroid in `data/city/boundary.geojson` (DAGI).", "",
         "| kommune | buildings | wall tone observed | roof tone observed | walls observed | photo atlas |", "|---|---:|---:|---:|---:|---:|"]
    for name, r in sorted(rows.items()):
        L.append(f"| {name} | {r['buildings']:,} | {r['wall_obs']:,} ({pct(r['wall_obs'], r['buildings'])}) | {r['roof_obs']:,} ({pct(r['roof_obs'], r['buildings'])}) | "
                 f"{r['walls_observed']:,} / {r['walls']:,} ({pct(r['walls_observed'], r['walls'])}) | {r['atlas']:,} ({pct(r['atlas'], r['buildings'])}) |")
    L.append(f"| **all** | {tot['buildings']:,} | {tot['wall_obs']:,} ({pct(tot['wall_obs'], tot['buildings'])}) | {tot['roof_obs']:,} ({pct(tot['roof_obs'], tot['buildings'])}) | "
             f"{tot['walls_observed']:,} / {tot['walls']:,} ({pct(tot['walls_observed'], tot['walls'])}) | {tot['atlas']:,} ({pct(tot['atlas'], tot['buildings'])}) |")
    sizes = sum(p.stat().st_size for p in C.TILES.glob("*/appearance.json"))
    look = sum(p.stat().st_size for p in tex_look.glob("*.webp")) if tex_look.exists() else 0
    L += ["", f"Tile layers total {sizes / 1e6:.1f} MB; `data/tex-look` holds {look / 1e6:.0f} MB of webp atlases.", ""]
    try:
        v = validate()
        L += ["## District validation (this pipeline vs `data/cph-geodata.json`, district buildings)", "", "```json", json.dumps(v, indent=1), "```", ""]
    except Exception as exc:  # noqa: BLE001
        L += [f"District validation not available: {exc}", ""]
    # contact sheet
    rng = np.random.default_rng(7)
    pick = [pool[i] for i in rng.choice(len(pool), size=min(20, len(pool)), replace=False)] if pool else []
    if pick:
        W, H, cols = 360, 190, 5
        sheet = Image.new("RGB", (W * cols, H * ((len(pick) + cols - 1) // cols)), (30, 30, 30))
        dr = ImageDraw.Draw(sheet)
        for i, (bid, name, tid, hw, hr, ha) in enumerate(pick):
            x, y = (i % cols) * W, (i // cols) * H
            a = C.jload(C.TILES / tid / "appearance.json")["buildings"][bid]
            tones = [w.get("tone_cal") or w["tone"] for w in a["walls"][:8]]
            for j, t in enumerate(tones):
                dr.rectangle([x + 6 + j * 24, y + 24, x + 28 + j * 24, y + 70], fill=tuple(int(c * 255) for c in t))
            roof = a.get("roof") or {}
            if roof.get("tone"):
                dr.rectangle([x + 6, y + 76, x + 80, y + 110], fill=tuple(int(c * 255) for c in roof["tone"]))
            dr.text((x + 6, y + 6), f"{bid} {name[:5]} {tid}", fill=(230, 230, 230))
            dr.text((x + 88, y + 80), f"roof {roof.get('conf', '-')} {roof.get('type_hint') or ''}", fill=(200, 200, 200))
            dr.text((x + 88, y + 96), f"walls obs {sum(1 for w in a['walls'] if w['conf'] != 'inferred')}/{len(a['walls'])}", fill=(200, 200, 200))
            if ha:
                try:
                    im = Image.open(tex_look / (bid.replace(":", "_") + ".webp")).convert("RGBA")
                    im.thumbnail((W - 12, 70))
                    bg = Image.new("RGB", im.size, (60, 60, 60))
                    bg.paste(im.convert("RGB"), mask=im.split()[3].point(lambda v: 255 if v else 0))
                    sheet.paste(bg, (x + 6, y + 116))
                except Exception:  # noqa: BLE001
                    pass
        out = C.ROOT / "data" / "city" / "appearance-qa.png"
        sheet.save(out)
        L += [f"QA contact sheet: `data/city/appearance-qa.png` ({len(pick)} random buildings: wall tone swatches (tone_cal), roof tone, atlas thumbnail where present).", ""]
    text = "\n".join(L)
    (C.ROOT / "data" / "city" / "appearance-coverage.md").write_text(text)
    return text


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["validate", "coverage"])
    a = ap.parse_args(argv)
    if a.cmd == "validate":
        print(json.dumps(validate(), indent=1))
    else:
        print(coverage())
    return 0


if __name__ == "__main__":
    sys.exit(main())
