# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "rasterio", "pyproj", "requests", "numba"]
# ///
"""Citywide photogrammetric appearance (observed wall / roof tones, then photo facade atlases) per 1 km cell.

Reads the tile compiler's `data/tiles/<id>/buildings.json` (never writes there) and writes, per 500 m tile, the new layer
`data/tiles/<id>/appearance.json` (cph-appearance/1: `buildings[<gdk id>] = observed`, the structure appearance.py writes today,
slimmed to what the engine / far LOD read), plus rectified-and-processed facade atlases to data/tex-look/<id>.webp.

Pipeline (all resumable: every step writes a done marker under the work dir, `--force` redoes it)

  tones <cell|all>   Stage 1, per 1 km cell (parallel, --workers): STAC search (2025, then 2023), view selection, windows read
                     from the COG *overviews* (--factor 2 = the half resolution appearance.py has always sampled at), DSM blocks
                     (DHM WCS, cached), z-buffer of the cell's buildings PLUS a 100 m ring of neighbour buildings (occlusion across
                     cell borders), appearance.observe_view per view. Saves the raw per-surface observations + the same-surface
                     lit/shadow pairs; the images are deleted at the end of the cell.
  calibrate          Stage 2, global: per-view lighting calibration (pairs pooled over every cell that view serves), then the
                     2023 -> 2025 radiometric gains. These were district-wide medians in appearance.py; here they pool citywide.
  finalize           Stage 3, global then per cell: view fusion (appearance.combine), BBR brick prior with a citywide reference,
                     neighbour fallback for unseen walls / roofs across cell borders, appearance_calibrate (tone_cal) with
                     citywide neighbour offsets, per-tile appearance.json.
  register           Adds the layer to data/city/post.json (key `appearance`), the file the tile store reads at open.
  atlas <cell|all>   Phase 2: full-resolution windows of the views that were `best` for some wall -> rectified 10 cm/px strips
                     (appearance.wall_texture, z-buffer including the neighbour ring) -> facade_look -> data/tex-look/<id>.webp,
                     raw images and the JPEG intermediate are deleted per cell. Atlas descriptors are merged into appearance.json.
  report             data/city/appearance-coverage.md + QA contact sheet.

    export GSEARCH_TOKEN="$(tools/adc-secret.sh gsearch-token)"
    uv run tools/cph-geodata/appearance_city.py tones all --workers 4
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import pickle
import shutil
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parents[1]

import appearance as A  # noqa: E402
import appearance_calibrate as AC  # noqa: E402
import skraafoto_city as SC  # noqa: E402

TILES = ROOT / "data" / "tiles"
WORK = Path(os.environ.get("APPEARANCE_WORK", Path.home() / "conductor/cph-twin/data/appearance-city"))
RING_M = 100.0  # neighbour buildings kept in the z-buffer around a cell
DSM_RING_M = 250.0  # DSM kept around a cell (rays travel along the viewing direction)
COLLECTIONS = ("skraafotos2025", "skraafotos2023")
MIN_FREE_GB = 6.0
VERSION = "cph-appearance/1"


# ---------------------------------------------------------------------------------------------------------------------
# cells and tiles


def jload(path: Path, tries: int = 5):
    for k in range(tries):
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            time.sleep(1 + k)
    raise RuntimeError(f"cannot read {path}")


def tile_index() -> dict:
    return jload(TILES / "index.json")["tiles"]


def cell_of_tile(info: dict) -> tuple[int, int]:
    u = info["utm"]
    return int(u[0] // 1000), int(u[1] // 1000)


def all_cells(idx: dict | None = None) -> dict[str, list[str]]:
    """{ '<E km>_<N km>': [tile ids] } for the cells that hold buildings."""
    idx = idx or tile_index()
    cells: dict[str, list[str]] = {}
    for tid, info in idx.items():
        if info.get("counts", {}).get("buildings", {}).get("buildings", 0) > 0:
            cx, cy = cell_of_tile(info)
            cells.setdefault(f"{cx}_{cy}", []).append(tid)
    return dict(sorted(cells.items()))


def cell_bbox_local(cell: str) -> tuple[float, float, float, float]:
    cx, cy = map(int, cell.split("_"))
    x0, z1 = A.ORIGIN[0] * 0 + cx * 1000 - 723900.0, -(cy * 1000 - 6176500.0)
    return x0, z1 - 1000.0, x0 + 1000.0, z1  # (x0, zmin, x1, zmax)


def centroid(b: dict) -> tuple[float, float]:
    r = b["ring"]
    n = len(r) // 2
    return sum(r[0::2]) / n, sum(r[1::2]) / n


def load_cell_buildings(cell: str, idx: dict, ring_m: float = RING_M):
    """(buildings, owned mask) of a cell: its own tiles' buildings then neighbours whose centroid is within `ring_m`."""
    cells = all_cells(idx)
    own = set(cells[cell])
    bx0, bz0, bx1, bz1 = cell_bbox_local(cell)
    ex = (bx0 - ring_m, bz0 - ring_m, bx1 + ring_m, bz1 + ring_m)
    B, owned = [], []
    for tid, info in idx.items():
        lx0, lz0, lx1, lz1 = info["local"]
        if lx1 < ex[0] or lx0 > ex[2] or lz1 < ex[1] or lz0 > ex[3]:
            continue
        if not (TILES / tid / "buildings.json").exists():
            continue
        for b in jload(TILES / tid / "buildings.json")["buildings"]:
            if len(b.get("ring", [])) < 6:
                continue
            if tid in own:
                B.append(b); owned.append(True)
            else:
                cx, cz = centroid(b)
                if ex[0] <= cx <= ex[2] and ex[1] <= cz <= ex[3]:
                    B.append(b); owned.append(False)
    return B, np.array(owned, bool)


def wall_edges(b: dict):
    """[(ring label, edge)] of the wall quads appearance.build_scene makes for `b` (same skips)."""
    out = []
    rings = [A.ring_pts(b["ring"])] + [A.ring_pts(h) for h in b.get("holes", [])]
    for ri, p in enumerate(rings):
        if len(p) < 3:
            continue
        m = len(p)
        for i in range(m):
            a, c = p[i], p[(i + 1) % m]
            if math.hypot(c[0] - a[0], c[1] - a[1]) < 0.05:
                continue
            out.append((A.ring_label(ri), i))
    return out


def free_gb(path: Path) -> float:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free / 1e9


def save_pkl(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with gzip.open(tmp, "wb", compresslevel=3) as f:
        pickle.dump(obj, f, protocol=4)
    tmp.replace(path)


def load_pkl(path: Path):
    with gzip.open(path, "rb") as f:
        return pickle.load(f)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)


# ---------------------------------------------------------------------------------------------------------------------
# stage 1: observations per cell


class OwnedRender:
    """appearance.render_view with the neighbour ring hidden from *sampling* (still in the z-buffer, so it occludes)."""

    def __init__(self, scene: A.Scene, owned: np.ndarray):
        self.owned_surf = owned[np.array([s.bid for s in scene.surfaces], dtype=np.int64)]
        self._orig = A.render_view

    def __call__(self, scene, cam, crop, scale):
        vb = self._orig(scene, cam, crop, scale)
        keep = np.append(self.owned_surf, False)  # index -1 (no surface) -> False
        vb.surf = np.where(keep[vb.surf], vb.surf, -1).astype(np.int32)
        return vb


def sun_for(rec: dict, shadows: dict, scene: A.Scene) -> None:
    import datetime as dt

    when = dt.datetime.fromisoformat(rec["datetime"].replace("Z", "+00:00"))
    key = int(when.timestamp() // 600)
    az, el = A.sun_position(dt.datetime.fromtimestamp(key * 600 + 300, dt.timezone.utc))
    rec["_sun_key"], rec["_sun_vec"], rec["_sun"] = key, A.sun_vector(az, el), (az, el)
    if key not in shadows:
        shadows[key] = A.ShadowMap(scene, rec["_sun_vec"])


def cell_dir(cell: str) -> Path:
    return WORK / "cells" / cell


def select_cell_views(cell: str, B: list[dict], owned: np.ndarray, factor: int, collections=COLLECTIONS) -> list[dict]:
    bx0, bz0, bx1, bz1 = cell_bbox_local(cell)
    ow = [b for b, o in zip(B, owned) if o]
    g = np.array([b["ground"] for b in ow])
    e = np.array([b["eave"] for b in ow])
    y_lo, y_hi = float(np.min(g)) - 1.0, float(max(np.max(e), np.max(g) + 12.0)) + 2.0
    y_ref = float(np.median(g))
    m = 40.0
    area = (bx0 - m, bz0 - m, bx1 + m, bz1 + m)
    cx, cy = map(int, cell.split("_"))
    utm = (cx * 1000 - 60.0, cy * 1000 - 60.0, cx * 1000 + 1060.0, cy * 1000 + 1060.0)
    recs = []
    for coll in collections:
        feats = SC.stac_items(coll, utm, WORK / "stac" / f"{cell}_{coll}.json")
        recs += SC.select_views(feats, area, y_ref, y_lo, y_hi, factor=factor)
    return recs


def process_tones(cell: str, factor: int = 2, collections=COLLECTIONS, force: bool = False, quiet: bool = False) -> dict:
    cd = cell_dir(cell)
    done = cd / "tones.done"
    if done.exists() and not force:
        return json.loads(done.read_text())
    t0 = time.time()
    if free_gb(WORK) < MIN_FREE_GB:
        raise SystemExit(f"free disk {free_gb(WORK):.1f} GB < {MIN_FREE_GB} GB: stopping")
    idx = tile_index()
    B, owned = load_cell_buildings(cell, idx)
    n_own = int(owned.sum())
    log = (lambda *a: None) if quiet else (lambda *a: print(f"[{cell}]", *a, flush=True))
    if n_own == 0:
        done.parent.mkdir(parents=True, exist_ok=True)
        done.write_text(json.dumps({"cell": cell, "buildings": 0}))
        return {"cell": cell, "buildings": 0}
    scale = 1.0 / factor
    recs = select_cell_views(cell, B, owned, factor, collections)
    raw = WORK / "raw" / cell
    raw.mkdir(parents=True, exist_ok=True)
    t_f = time.time()
    nbytes = 0
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(3) as ex:
        for n in ex.map(lambda r: SC.fetch_window(r, raw, factor), recs):
            nbytes += n
    t_fetch = time.time() - t_f
    log(f"{len(recs)} views, {nbytes / 1e6:.0f} MB read in {t_fetch:.0f}s; {n_own} owned + {len(B) - n_own} ring buildings")
    # DSM
    cx, cy = map(int, cell.split("_"))
    blocks = SC.dsm_blocks((cx * 1000 - DSM_RING_M, cy * 1000 - DSM_RING_M, cx * 1000 + 1000 + DSM_RING_M, cy * 1000 + 1000 + DSM_RING_M), WORK / "dsm")
    dsm = A.DSM.from_tiles(blocks)
    scene = A.build_scene(B)
    own_roof = {bi: sid for bi, sid in scene.roof_of.items() if owned[bi]}
    pit_scene = type("S", (), {"roof_of": own_roof})()
    pitched_pts, rise_by = A.pitched_roofs(pit_scene, B, dsm)
    shadows: dict = {}
    for rec in recs:
        sun_for(rec, shadows, scene)
    masked = OwnedRender(scene, owned)
    A.render_view = masked
    per_surface: dict[int, list[dict]] = {}
    try:
        for k, rec in enumerate(recs):
            obs, dtv = A.observe_view(scene, rec, raw, scale, shadows, B, dsm=dsm, occlusion="dsm", pitched=pitched_pts)
            for sid, o in obs.items():
                per_surface.setdefault(sid, []).append(o)
    finally:
        A.render_view = masked._orig
    # keyed, slim, picklable
    obs_by_key: dict = {}
    for sid, lst in per_surface.items():
        S = scene.surfaces[sid]
        if not owned[S.bid]:
            continue
        key = (B[S.bid]["id"], "roof", -1) if S.kind == "roof" else (B[S.bid]["id"], A.ring_label(S.ring), S.edge)
        for o in lst:
            o.pop("_best_raw", None)
        obs_by_key[key] = lst
    views = [{"view_id": r["view_id"], "direction": r["direction"], "datetime": r["datetime"], "year": A.view_year(r["view_id"]),
              "sun_key": r["_sun_key"], "crop": r["crop"], "pers": r["pers"], "href": r["href"], "image_size": r["image_size"],
              "file": r["file"]} for r in recs]
    keys = ("view", "kind", "lit_lin", "sh_lin", "n_lit", "n_sh", "cos_sun")  # all appearance.surface_pair reads
    pairs = [{k: o[k] for k in keys} for lst in obs_by_key.values() for o in lst if A.surface_pair(o) is not None]
    rises = {B[bi]["id"]: round(float(r), 2) for bi, r in rise_by.items() if owned[bi]}
    save_pkl(cd / "obs.pkl.gz", {"cell": cell, "factor": factor, "views": views, "obs": obs_by_key, "rise": rises,
                                 "pitched": [B[scene.surfaces[sid].bid]["id"] for sid in pitched_pts if owned[scene.surfaces[sid].bid]]})
    save_pkl(cd / "pairs.pkl.gz", pairs)
    save_pkl(cd / "views.pkl.gz", views)
    shutil.rmtree(raw, ignore_errors=True)
    stats = {"cell": cell, "buildings": n_own, "ring": len(B) - n_own, "views": len(recs), "mb_read": round(nbytes / 1e6, 1),
             "t_fetch": round(t_fetch, 1), "t_total": round(time.time() - t0, 1), "surfaces": len(obs_by_key), "factor": factor}
    done.write_text(json.dumps(stats))
    log(f"done in {stats['t_total']}s ({len(obs_by_key)} observed surfaces)")
    return stats


def _tones_job(args):
    cell, factor, collections, force = args
    try:
        return process_tones(cell, factor, collections, force, quiet=False)
    except SystemExit as e:
        return {"cell": cell, "error": str(e), "stop": True}
    except Exception as e:  # noqa: BLE001
        return {"cell": cell, "error": traceback.format_exc()[-800:]}


# ---------------------------------------------------------------------------------------------------------------------
# stage 2/3 are in appearance_city_final.py (global passes); the CLI below dispatches to them


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("tones")
    p.add_argument("cells", nargs="+")
    p.add_argument("--factor", type=int, default=2)
    p.add_argument("--years", default="2025,2023")
    p.add_argument("--workers", type=int, default=1)
    p.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "tones":
        cells = list(all_cells()) if a.cells == ["all"] else a.cells
        colls = tuple(c for c in COLLECTIONS if c[-4:] in a.years.split(","))
        jobs = [(c, a.factor, colls, a.force) for c in cells]
        if a.workers <= 1:
            for j in jobs:
                print(json.dumps(_tones_job(j)))
        else:
            with ProcessPoolExecutor(a.workers, max_tasks_per_child=1) as ex:
                for f in as_completed([ex.submit(_tones_job, j) for j in jobs]):
                    print(json.dumps(f.result()), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
