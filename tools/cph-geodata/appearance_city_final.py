# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "rasterio", "pyproj", "requests", "numba"]
# ///
"""Global passes of the citywide appearance run (after `appearance_city.py tones`): calibrate, finalize, register.

    uv run tools/cph-geodata/appearance_city_final.py calibrate
    uv run tools/cph-geodata/appearance_city_final.py finalize --workers 4
    uv run tools/cph-geodata/appearance_city_final.py register

`calibrate` pools the same-surface lit/shadow pairs of every cell per view (appearance.estimate_calibrations; a view serves
several cells, so its shadow->lit gain and skylight cast are estimated from all of them) and the 2023 -> 2025 radiometric
gains (appearance.collection_gains, sunlit-in-both walls over the whole city).

`finalize` then runs, per cell and in parallel: B finalize_obs + gains + appearance.combine; C brick prior with the citywide
brick reference, observed wall / roof entries and the tone tables; D neighbour fallback for unseen walls and roofs (KD-trees over
the whole city, so cell borders are seamless), appearance_calibrate.calibrate with the offsets of the buildings around the cell,
and the per-tile data/tiles/<id>/appearance.json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import appearance as A  # noqa: E402
import appearance_calibrate as AC  # noqa: E402
import appearance_city as C  # noqa: E402

WORK = C.WORK
GAIN_MIN_PX, GAIN_MIN_PAIRS, NEWEST = 150, 30, 2025


def cells_done(stage_file: str, cells: list[str] | None = None) -> list[str]:
    cells = cells or list(C.all_cells())
    return [c for c in cells if (C.cell_dir(c) / stage_file).exists()]


def owned_buildings(cell: str, idx: dict) -> tuple[dict, dict]:
    """({gdk id: building}, {gdk id: tile id}) for the buildings the cell owns (compiler centroid ownership)."""
    cells = C.all_cells(idx)
    out, tid_of = {}, {}
    for tid in cells[cell]:
        p = C.TILES / tid / "buildings.json"
        if not p.exists():
            continue
        for b in C.jload(p)["buildings"]:
            if len(b.get("ring", [])) >= 6:
                out[b["id"]] = b
                tid_of[b["id"]] = tid
    return out, tid_of


# ---------------------------------------------------------------------------------------------------------------------
# calibrate


def calibrate_all() -> dict:
    cells = cells_done("tones.done")
    views, pairs = {}, []
    for c in cells:
        for v in C.load_pkl(C.cell_dir(c) / "views.pkl.gz"):
            views[v["view_id"]] = {"view_id": v["view_id"], "_sun_key": v["sun_key"]}
        pairs += C.load_pkl(C.cell_dir(c) / "pairs.pkl.gz")
    cal = A.estimate_calibrations({i: [o] for i, o in enumerate(pairs)}, list(views.values()))
    src = {}
    for v in cal.values():
        src[v["src"]] = src.get(v["src"], 0) + 1
    # collection gains need the finalised tones of every cell: second sweep
    ratios: dict[int, list] = {}
    for c in cells:
        d = C.load_pkl(C.cell_dir(c) / "obs.pkl.gz")["obs"]
        for lst in d.values():
            for o in lst:
                A.finalize_obs(o, cal.get(o["view"]) or A.default_cal())
        for y, r in collection_ratios(d).items():
            ratios.setdefault(y, []).extend(r)
        print(f"  ratios {c}", flush=True)
    gains = {y: np.median(r, axis=0) for y, r in ratios.items() if len(r) >= GAIN_MIN_PAIRS}
    out = {"cal": cal, "gains": gains, "views": len(views), "pairs": len(pairs), "cells": len(cells), "src": src,
           "median_G": {str(y): float(np.median([v["G"] for vid, v in cal.items() if A.view_year(vid) == y])) for y in (2023, 2025)
                        if any(A.view_year(vid) == y for vid in cal)}}
    C.save_pkl(WORK / "calibration.pkl.gz", out)
    print("calibration:", json.dumps({k: v for k, v in out.items() if k not in ("cal", "gains")}),
          "gains:", {y: np.round(g, 2).tolist() for y, g in gains.items()}, flush=True)
    return out


def collection_ratios(per_surface: dict) -> dict[int, list]:
    """appearance.collection_gains split in a per-cell part (a surface lies in exactly one cell)."""
    ratios: dict[int, list] = {}
    for key, obs in per_surface.items():
        if key[1] == "roof" or obs[0]["kind"] != "wall":
            continue
        new = [o["tone_lin"] for o in obs if o["sunlit"] and o["year"] == NEWEST and o["px"] >= GAIN_MIN_PX]
        if not new:
            continue
        tn = np.median(new, axis=0)
        for y in {o["year"] for o in obs} - {NEWEST}:
            old = [o["tone_lin"] for o in obs if o["sunlit"] and o["year"] == y and o["px"] >= GAIN_MIN_PX]
            if old:
                ratios.setdefault(y, []).append(tn / np.maximum(np.median(old, axis=0), 1e-3))
    return ratios


# ---------------------------------------------------------------------------------------------------------------------
# pass B: finalize + combine


def pass_b(cell: str) -> dict:
    cal = C.load_pkl(WORK / "calibration.pkl.gz")
    d = C.load_pkl(C.cell_dir(cell) / "obs.pkl.gz")
    obs = d["obs"]
    for lst in obs.values():
        for o in lst:
            A.finalize_obs(o, cal["cal"].get(o["view"]) or A.default_cal())
    A.apply_collection_gains(obs, cal["gains"])
    combined = {}
    for key, lst in obs.items():
        c = A.combine(lst, "roof" if key[1] == "roof" else "wall")
        if c is None:
            continue
        c.pop("_best_raw", None)
        combined[key] = c
    C.save_pkl(C.cell_dir(cell) / "combined.pkl.gz", {"combined": combined, "rise": d["rise"], "pitched": set(d["pitched"])})
    idx = C.tile_index()
    bmap, _ = owned_buildings(cell, idx)
    brick = [c["tone"] for key, c in combined.items() if key[1] != "roof" and c["sunlit"] and c["px"] >= 100
             and (bmap[key[0]].get("wall_material") or "").lower() in A.BRICK_MATERIALS and A.is_brick_hue(c["tone"])]
    (C.cell_dir(cell) / "combine.done").write_text(json.dumps({"walls": sum(1 for k in combined if k[1] != "roof"),
                                                              "roofs": sum(1 for k in combined if k[1] == "roof")}))
    return {"cell": cell, "brick": brick}


# ---------------------------------------------------------------------------------------------------------------------
# pass C: brick prior, entries, tone tables


def wall_entry(key, c) -> dict:
    e = {"edge": key[2], "ring": key[1], "tone": c["tone"], "conf": "observed+prior" if c.get("prior") else "observed",
         "views": c["views"], "angle_deg": c["angle_deg"], "px": c["px"], "shadow_frac": c["shadow_frac"], "tone_raw": c["tone_raw"],
         "agree": c["agree"], "shadow_corrected": c["shadow_corrected"], "sunlit": c["sunlit"], "year": c["year"],
         "wb_cast": c["wb_cast"], "best": c["best"]}
    if c["flags"]:
        e["flags"] = c["flags"]
    if c.get("prior"):
        e["prior"] = c["prior"]
        e["tone_observed"] = c["tone_prior_free"]
    return e


def pass_c(cell: str, brick_glob: list[float]) -> dict:
    d = C.load_pkl(C.cell_dir(cell) / "combined.pkl.gz")
    combined, rise, pitched = d["combined"], d["rise"], d["pitched"]
    idx = C.tile_index()
    bmap, tid_of = owned_buildings(cell, idx)
    per_b: dict[str, list] = {}
    ref_b: dict[str, list] = {}
    contradicted = set()
    for key, c in combined.items():
        if key[1] == "roof":
            continue
        per_b.setdefault(key[0], []).append((key, c))
        b = bmap[key[0]]
        if c["sunlit"] and c["px"] >= 300 and not A.is_brick_hue(c["tone"]):
            lum_s = float(A.lin2srgb(A.luminance(A.srgb2lin(np.array(c["tone"])))))
            if A.sat_of(c["tone"]) >= 0.12 or lum_s > 0.75:
                contradicted.add(key[0])
        if (b.get("wall_material") or "").lower() in A.BRICK_MATERIALS and c["sunlit"] and A.is_brick_hue(c["tone"]) and c["px"] >= 100:
            ref_b.setdefault(key[0], []).append(c["tone"])
    n_prior = 0
    for bid, lst in per_b.items():
        if (bmap[bid].get("wall_material") or "").lower() in A.BRICK_MATERIALS and bid not in contradicted:
            ref = np.median(ref_b[bid], axis=0) if bid in ref_b else np.asarray(brick_glob)
            for key, c in lst:
                n_prior += A.apply_brick_prior(c, ref)
    table, entries, offsets = {}, {}, {}
    pseudo = []
    for bid, b in bmap.items():
        lst = sorted(per_b.get(bid, []), key=lambda kc: (str(kc[0][1]), kc[0][2]))
        walls = [wall_entry(k, c) for k, c in lst]
        roof_c = combined.get((bid, "roof", -1))
        cx, cz = C.centroid(b)
        wt = A.weighted_median(np.array([c["tone"] for _, c in lst]), np.array([c["px"] for _, c in lst], float)) if lst else None
        table[bid] = (cx, cz, wt, np.array(roof_c["tone"]) if roof_c else None)
        entries[bid] = {"walls": walls, "roof": roof_c}
        if walls:
            pseudo.append({"id": bid, "ring": b["ring"], "observed": {"walls": walls}})
    offsets = AC.building_offsets(pseudo)
    C.save_pkl(C.cell_dir(cell) / "entries.pkl.gz", {"entries": entries, "table": table, "tid_of": tid_of})
    C.save_pkl(C.cell_dir(cell) / "offsets.pkl.gz", offsets)
    (C.cell_dir(cell) / "prior.done").write_text(json.dumps({"prior": int(n_prior), "contradicted": len(contradicted)}))
    return {"cell": cell, "prior": int(n_prior)}


# ---------------------------------------------------------------------------------------------------------------------
# pass D: fallback, calibration, per-tile layer


_DISTRICT = None


def district_observed() -> dict:
    """{gdk id: observed} of data/cph-geodata.json (the district pass as it is today)."""
    global _DISTRICT
    if _DISTRICT is None:
        p = C.ROOT / "data" / "cph-geodata.json"
        _DISTRICT = {b["id"]: b["observed"] for b in json.loads(p.read_text())["buildings"] if b.get("observed")} if p.exists() else {}
    return _DISTRICT


def slim_wall(w: dict) -> dict:
    o = {"edge": w["edge"], "ring": w["ring"], "tone": w["tone"]}
    if "tone_cal" in w:
        o["tone_cal"] = w["tone_cal"]
    o["conf"] = w["conf"]
    if w["conf"] == "inferred":
        o["fallback"] = w.get("fallback")
    else:
        o["sunlit"] = w["sunlit"]
        o["year"] = w["year"]
        o["px"] = w["px"]
        if w.get("flags"):
            o["flags"] = w["flags"]
        if w.get("prior"):
            o["prior"] = w["prior"]
    if w.get("cal"):
        o["cal"] = w["cal"]
    if w.get("cal_brick"):
        o["cal_brick"] = True
    return o


def slim_roof(r: dict | None) -> dict | None:
    if r is None:
        return None
    keep = ("tone", "conf", "type_hint", "pitched", "sunlit", "year", "px", "solar_frac", "green_frac", "ridge_rise_m", "flags")
    return {k: r[k] for k in keep if k in r and r[k] is not None or k in ("tone", "conf")}


class Tables:
    """Citywide wall / roof tone tables for the neighbour fallback (nearest observed buildings within 60 m)."""

    def __init__(self, tables: list[dict]):
        from scipy.spatial import cKDTree

        w_pts, w_val, r_pts, r_val = [], [], [], []
        for t in tables:
            for bid, (cx, cz, wt, rt) in t.items():
                if wt is not None:
                    w_pts.append((cx, cz)); w_val.append(wt)
                if rt is not None:
                    r_pts.append((cx, cz)); r_val.append(rt)
        self.w = (cKDTree(np.array(w_pts)), np.array(w_val)) if w_pts else None
        self.r = (cKDTree(np.array(r_pts)), np.array(r_val)) if r_pts else None

    @staticmethod
    def _near(tree_vals, pt, k=6, radius=60.0):
        if tree_vals is None:
            return None
        tree, vals = tree_vals
        d, i = tree.query(pt, k=k, distance_upper_bound=radius)
        i = np.atleast_1d(i)
        i = i[np.isfinite(np.atleast_1d(d))]
        return np.median(vals[i], axis=0) if len(i) else None

    def wall(self, pt):
        return self._near(self.w, pt)

    def roof(self, pt):
        return self._near(self.r, pt)


def full_roof(c, b, rise, is_pitched):
    if c is not None:
        return {"tone": c["tone"], "conf": "observed", "views": c["views"], "px": c["px"], "shadow_frac": c["shadow_frac"],
                "angle_deg": c["angle_deg"], "type_hint": A.roof_type_hint(c["tone"], b.get("roof"), c["veg_frac"], c.get("solar_frac", 0)),
                "solar_frac": c.get("solar_frac", 0.0), "green_frac": c["veg_frac"], "sunlit": c["sunlit"], "year": c["year"],
                "pitched": is_pitched, "ridge_rise_m": rise, "sampled_on": "dsm_surface" if is_pitched else "eave_plane",
                **({"flags": c["flags"]} if c["flags"] else {})}
    return None


def pass_d(cell: str) -> dict:
    t0 = time.time()
    idx = C.tile_index()
    bmap, tid_of = owned_buildings(cell, idx)
    e = C.load_pkl(C.cell_dir(cell) / "entries.pkl.gz")
    glob = C.load_pkl(WORK / "tables.pkl.gz")
    tables = Tables(glob["tables"])
    d = C.load_pkl(C.cell_dir(cell) / "combined.pkl.gz")
    rise, pitched = d["rise"], d["pitched"]
    bx0, bz0, bx1, bz1 = C.cell_bbox_local(cell)
    near = {bid: v for bid, v in glob["offsets"].items()
            if bx0 - 120 <= v[1][0] <= bx1 + 120 and bz0 - 120 <= v[1][1] <= bz1 + 120}
    pseudo = []
    stats = {"walls": 0, "walls_obs": 0, "roofs_obs": 0, "buildings": 0, "fallback": {"building": 0, "neighbours": 0, "preset": 0}}
    for bid, b in bmap.items():
        ent = e["entries"][bid]
        obs_walls = {(w["ring"], w["edge"]): w for w in ent["walls"]}
        cx, cz, wt, rt = e["table"][bid]
        walls = []
        for ring, edge in sorted(C.wall_edges(b), key=lambda re: (str(re[0]), re[1])):
            stats["walls"] += 1
            w = obs_walls.get((ring, edge))
            if w is not None:
                stats["walls_obs"] += 1
                walls.append(w)
                continue
            if wt is not None:
                tone, how = wt, "building"
            else:
                t = tables.wall((cx, cz))
                tone, how = (t, "neighbours") if t is not None else (np.array(b["facade"]["tone"]), "preset")
            stats["fallback"][how] += 1
            walls.append({"edge": edge, "ring": ring, "tone": [round(float(x), 3) for x in tone], "conf": "inferred", "views": [],
                          "angle_deg": None, "px": 0, "shadow_frac": None, "fallback": how})
        is_p = bid in pitched
        rr = rise.get(bid)
        roof = full_roof(ent["roof"], b, rr, is_p)
        if roof is not None:
            stats["roofs_obs"] += 1
        else:
            t = tables.roof((cx, cz))
            roof = {"tone": [round(float(x), 3) for x in t] if t is not None else None, "conf": "inferred", "views": [], "px": 0,
                    "type_hint": None, "pitched": is_p, "ridge_rise_m": rr}
        stats["buildings"] += 1
        pseudo.append({"id": bid, "ring": b["ring"], "wall_material": b.get("wall_material"), "observed": {"walls": walls, "roof": roof}})
    cal_stats = AC.calibrate({"buildings": pseudo}, offsets=near, transfer=glob["transfer"])
    stats["routes"] = cal_stats["routes"]
    # The 1.5 km district keeps the observed layer it has today (data/cph-geodata.json, atlases included); this run's version of those
    # buildings stays in final.pkl.gz for the validation report.
    district = district_observed() if os.environ.get("APPEARANCE_DISTRICT", "geodata") == "geodata" else {}
    stats["district_kept"] = 0
    city_version = {p["id"]: p["observed"] for p in pseudo}
    for p in pseudo:
        if p["id"] in district:
            p["observed"] = district[p["id"]]
            stats["district_kept"] += 1
    # per-tile layer
    by_tile: dict[str, dict] = {}
    for p in pseudo:
        o = p["observed"]
        wall_t = [w.get("tone_cal") or w.get("tone") for w in o["walls"] if w["conf"] != "inferred" and w.get("tone")]
        summary = {"wall": [round(float(np.median([t[i] for t in wall_t])), 3) for i in range(3)] if wall_t else None,
                   "roof": o["roof"]["tone"] if o["roof"].get("conf") == "observed" else None}
        rec = {"walls": [slim_wall(w) for w in o["walls"]], "roof": slim_roof(o["roof"]), "summary": summary}
        if o.get("atlas"):
            rec["atlas"] = {"file": o["atlas"]["file"], "size": o["atlas"]["size"], "walls": [
                {k: m[k] for k in ("edge", "ring", "len_m", "h_m", "texel_m", "filled_frac", "uv", "px") if k in m} for m in o["atlas"]["walls"]]}
        by_tile.setdefault(tid_of[p["id"]], {})[p["id"]] = rec
    atl = C.cell_dir(cell) / "atlas.pkl.gz"
    if atl.exists():  # keep atlas descriptors of an earlier phase-2 run when this pass is repeated
        for bid, a in C.load_pkl(atl).items():
            if bid in tid_of and bid in by_tile.get(tid_of[bid], {}):
                by_tile[tid_of[bid]][bid]["atlas"] = a
    sizes = {}
    for tid, bs in by_tile.items():
        path = C.TILES / tid / "appearance.json"
        C.save_json(path, {"version": C.VERSION, "tile": tid, "buildings": bs})
        sizes[tid] = path.stat().st_size
    C.save_pkl(C.cell_dir(cell) / "final.pkl.gz", {"observed": city_version, "tid_of": tid_of})
    stats["tiles"] = sizes
    stats["t"] = round(time.time() - t0, 1)
    (C.cell_dir(cell) / "final.done").write_text(json.dumps(stats))
    return {"cell": cell, **{k: v for k, v in stats.items() if k != "tiles"}}


# ---------------------------------------------------------------------------------------------------------------------
# orchestration


def _job(args):
    fn, cell, extra = args
    try:
        return {"fn": fn, **{"B": pass_b, "C": pass_c, "D": pass_d}[fn](cell, *extra)}
    except Exception:  # noqa: BLE001
        return {"fn": fn, "cell": cell, "error": traceback.format_exc()[-1000:]}


def run_pool(fn: str, cells: list[str], workers: int, extra=()) -> list[dict]:
    out = []
    t0 = time.time()
    with ProcessPoolExecutor(workers) as ex:
        futs = [ex.submit(_job, (fn, c, extra)) for c in cells]
        for f in as_completed(futs):
            r = f.result()
            out.append(r)
            if "error" in r:
                print("ERROR", r["cell"], r["error"], flush=True)
            else:
                print(f"  {fn} {r['cell']} ({len(out)}/{len(cells)}, {time.time() - t0:.0f}s)", flush=True)
    return out


def finalize(workers: int, force: bool = False) -> None:
    cells = cells_done("tones.done")
    todo = [c for c in cells if force or not (C.cell_dir(c) / "combine.done").exists()]
    print(f"pass B: {len(todo)} cells", flush=True)
    res = run_pool("B", todo, workers)
    brick = []
    for c in cells:
        pass
    # brick reference: citywide median of confident brick walls (needs every cell: re-derive from combine for cached cells)
    for c in cells:
        r = next((x for x in res if x["cell"] == c and "brick" in x), None)
        if r is None:
            r = _job(("B", c, ()))  # cached cell: recompute only the samples
        brick += r["brick"]
    brick_glob = np.median(brick, axis=0) if len(brick) >= 10 else A.BRICK_DEFAULT_SRGB
    print(f"brick reference {np.round(brick_glob, 3).tolist()} from {len(brick)} walls", flush=True)
    print("pass C", flush=True)
    run_pool("C", cells, workers, (list(map(float, brick_glob)),))
    tables, offsets = [], {}
    for c in cells:
        tables.append(C.load_pkl(C.cell_dir(c) / "entries.pkl.gz")["table"])
        offsets.update(C.load_pkl(C.cell_dir(c) / "offsets.pkl.gz"))
    transfer = AC.global_transfer(offsets)
    C.save_pkl(WORK / "tables.pkl.gz", {"tables": tables, "offsets": offsets, "transfer": transfer})
    print("transfer", transfer, flush=True)
    print("pass D", flush=True)
    run_pool("D", cells, workers)


def register() -> None:
    city = C.ROOT / "data" / "city"
    tiles = {}
    n_b = 0
    for p in sorted(C.TILES.glob("*/appearance.json")):
        tiles[p.parent.name] = p.stat().st_size
    post = city / "post.json"
    doc = C.jload(post) if post.exists() else {"version": "cph-post/1"}
    doc["appearance"] = {"version": C.VERSION, "layer": "appearance.json", "tiles": tiles,
                         "atlas": {"dir": "tex-look", "ext": "webp", "note": "walls[].ring/edge strips: building.observed.atlas of the tile layer"}}
    C.save_json(post, doc)
    print(f"registered {len(tiles)} tile layers in {post}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["calibrate", "finalize", "register"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "calibrate":
        calibrate_all()
    elif a.cmd == "finalize":
        finalize(a.workers, a.force)
    else:
        register()
    return 0


if __name__ == "__main__":
    sys.exit(main())
