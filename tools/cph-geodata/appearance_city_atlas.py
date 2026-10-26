# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "rasterio", "pyproj", "requests", "numba"]
# ///
"""Phase 2 of the citywide appearance run: photo facade atlases, per 1 km cell (after `appearance_city_final.py finalize`).

Per cell: the views that were the `best` source of some observed wall (tone pass, final.pkl.gz) are read at FULL resolution,
cropped to the walls they serve (not the whole tone-pass window), the walls are rectified to 10 cm/px strips exactly as
appearance.make_textures does (z-buffer of the cell + 100 m ring of neighbour buildings, DSM occlusion, shadow-sourced strips
carry the tone/tone_raw gain), packed into one atlas per building, passed through facade_look.process_building (shadow division,
window and unobserved masks, normalisation to tone_cal) and written ONLY as data/tex-look/<gdk id>.webp. The JPEG intermediate and
the raw images are deleted at the end of the cell. The atlas descriptors go into data/tiles/<tile>/appearance.json
(`buildings[id].atlas = { file, size, walls[] }`, `file` keeps the district's "tex/<id>.jpg" naming; the engine swaps tex/ -> tex-look/ and
.jpg -> .webp, so the .jpg itself does not exist for city buildings).

District buildings keep their existing atlases (data/tex, data/tex-look are never overwritten).

    uv run tools/cph-geodata/appearance_city_atlas.py atlas 723_6176 [--texel 0.10]
    uv run tools/cph-geodata/appearance_city_atlas.py atlas inner --workers 4        # cells nearest the centre first
    uv run tools/cph-geodata/appearance_city_atlas.py atlas all --workers 4
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import appearance as A  # noqa: E402
import appearance_city as C  # noqa: E402
import appearance_city_final as F  # noqa: E402
import skraafoto_city as SC  # noqa: E402

CENTRE_UTM = (722500.0, 6175300.0)  # Raadhuspladsen / Indre By: "inner city first" is measured from here
TEX_LOOK = C.ROOT / "data" / "tex-look"
MAX_ATLAS_BUILDINGS_PER_CELL = 100000


def cell_priority(cell: str) -> float:
    cx, cy = map(int, cell.split("_"))
    return math.hypot(cx * 1000 + 500 - CENTRE_UTM[0], cy * 1000 + 500 - CENTRE_UTM[1])


def texel_for(cell: str, policy: str) -> float:
    """Texel size by distance from the centre. `policy` 'flat:<m>' or 'rings' (0.10 m inside 3.5 km, 0.15 m to 6 km, 0.20 m beyond)."""
    if policy.startswith("flat:"):
        return float(policy[5:])
    d = cell_priority(cell)
    return 0.10 if d <= 3500 else 0.15 if d <= 6000 else 0.20


def district_ids() -> set[str]:
    p = C.ROOT / "data" / "cph-geodata.json"
    if not p.exists():
        return set()
    g = json.loads(p.read_text())
    return {b["id"] for b in g["buildings"] if (b.get("observed") or {}).get("atlas")}


def wall_bbox_px(scene: A.Scene, cam: A.Camera, sids: list[int], pad: int = 80):
    pts = []
    for sid in sids:
        a, b = scene.surf_a[sid], scene.surf_b[sid]
        g, h = scene.surf_ground[sid], scene.surf_height[sid]
        for p in (a, b):
            for y in (g, g + h):
                pts.append([p[0], y, p[1]])
    col, row, z = cam.project(np.array(pts))
    ok = z > 1
    if not ok.any():
        return None
    return (int(np.floor(col[ok].min())) - pad, int(np.floor(row[ok].min())) - pad,
            int(np.ceil(col[ok].max())) + pad, int(np.ceil(row[ok].max())) + pad)


def process_atlas(cell: str, texel: float = 0.10, force: bool = False) -> dict:
    import facade_look as FL

    cd = C.cell_dir(cell)
    done = cd / "atlas.done"
    if done.exists() and not force:
        return json.loads(done.read_text())
    if not (cd / "final.done").exists():
        return {"cell": cell, "skipped": "no final.done"}
    if C.free_gb(C.WORK) < C.MIN_FREE_GB:
        raise SystemExit(f"free disk {C.free_gb(C.WORK):.1f} GB < {C.MIN_FREE_GB} GB: stopping")
    t0 = time.time()
    idx = C.tile_index()
    B, owned = C.load_cell_buildings(cell, idx)
    bi_of = {b["id"]: i for i, b in enumerate(B)}
    final = C.load_pkl(cd / "final.pkl.gz")
    views = {F_["view_id"]: F_ for F_ in C.load_pkl(cd / "views.pkl.gz")}
    short2id = {A.short_view(v): v for v in views}
    skip = district_ids()
    # the walls to texture: (building index, ring, edge) -> entry, grouped by the best view
    by_view: dict[str, list[tuple[int, dict]]] = {}
    scene = A.build_scene(B)
    for bid, obs in final["observed"].items():
        if bid in skip or (TEX_LOOK / (bid.replace(":", "_") + ".webp")).exists() and not force:
            continue
        bi = bi_of.get(bid)
        if bi is None:
            continue
        for w in obs["walls"]:
            if w["conf"] == "inferred" or "best" not in w:
                continue
            ri = 0 if w["ring"] == 0 else int(str(w["ring"]).split("_")[1]) + 1
            sid = scene.wall_of.get((bi, ri, w["edge"]))
            if sid is None or w["best"] not in short2id:
                continue
            by_view.setdefault(short2id[w["best"]], []).append((sid, w))
    cx, cy = map(int, cell.split("_"))
    blocks = SC.dsm_blocks((cx * 1000 - C.DSM_RING_M, cy * 1000 - C.DSM_RING_M, cx * 1000 + 1000 + C.DSM_RING_M, cy * 1000 + 1000 + C.DSM_RING_M), C.WORK / "dsm")
    dsm = A.DSM.from_tiles(blocks)
    raw = C.WORK / "raw_atlas" / cell
    raw.mkdir(parents=True, exist_ok=True)
    strips: dict[int, list] = {}
    filled_all = []
    nbytes = 0
    for vid, items in by_view.items():
        v = views[vid]
        cam = A.Camera.from_pers(v["pers"])
        sids = [s for s, _ in items]
        bb = wall_bbox_px(scene, cam, sids)
        if bb is None:
            continue
        W, H = v["image_size"]
        x0, y0 = max(0, bb[0]), max(0, bb[1])
        x1, y1 = min(W, bb[2]), min(H, bb[3])
        if x1 - x0 < 32 or y1 - y0 < 32:
            continue
        rec = {"view_id": vid, "href": v["href"], "file": v["file"], "crop": {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "overview_factor": 1}}
        nbytes += SC.fetch_window(rec, raw, 1)
        vb = A.render_view(scene, cam, rec["crop"], 0.5)
        full = np.asarray(Image.open(raw / rec["file"]).convert("RGB"))
        for sid, c in items:
            S = scene.surfaces[sid]
            tx = max(texel, scene.surf_len[sid] / 4096)
            px, valid = A.wall_texture(scene, sid, vb, full, rec["crop"], tx, dsm=dsm, veg=False)
            img, fill = A.fill_texture(px, valid, tx)
            if img is None:
                continue
            mult = None
            if not c["sunlit"]:
                mult = np.clip(A.srgb2lin(np.array(c["tone"])) / np.maximum(A.srgb2lin(np.array(c["tone_raw"])), 1e-3), 0.3, 8.0)
                lin = A.srgb2lin(img.astype(np.float64) / 255.0) * mult
                img = np.clip(np.round(A.lin2srgb(lin) * 255), 0, 255).astype(np.uint8)
            filled_all.append(fill)
            strips.setdefault(S.bid, []).append((
                {"edge": S.edge, "ring": A.ring_label(S.ring), "len_m": round(float(scene.surf_len[sid]), 2),
                 "h_m": round(float(scene.surf_height[sid]), 2), "texel_m": round(float(tx), 3), "filled_frac": round(fill, 2),
                 "sunlit": bool(c["sunlit"]), "year": c["year"], "wb_applied": mult is not None}, img))
        del full, vb
        (raw / rec["file"]).unlink(missing_ok=True)
    # pack, process (facade_look), keep only the webp
    tmp = C.WORK / "tmp_atlas" / cell
    (tmp / "data" / "tex").mkdir(parents=True, exist_ok=True)
    TEX_LOOK.mkdir(parents=True, exist_ok=True)
    FL.ROOT, FL.OUT = tmp, TEX_LOOK
    atlases: dict[str, dict] = {}
    nweb = webp_bytes = 0
    win = unobs = area = 0.0
    for bi, lst in strips.items():
        bid = B[bi]["id"]
        lst.sort(key=lambda t: (str(t[0]["ring"]), t[0]["edge"]))
        atlas_img, metas = A.pack_atlas(lst)
        name = bid.replace(":", "_") + ".jpg"
        Image.fromarray(atlas_img).save(tmp / "data" / "tex" / name, quality=85)
        atlas = {"file": f"tex/{name}", "size": [atlas_img.shape[1], atlas_img.shape[0]], "walls": metas}
        cal = {(w["ring"], w["edge"]): (w.get("tone_cal") or w.get("tone")) for w in final["observed"][bid]["walls"] if w["conf"] != "inferred"}
        _, st = FL.process_building((bid, atlas, cal))
        (tmp / "data" / "tex" / name).unlink(missing_ok=True)
        look = TEX_LOOK / (Path(name).stem + ".webp")
        if st and look.exists():
            nweb += 1
            webp_bytes += look.stat().st_size
            area += st["area"]; win += st["win"]; unobs += st["unobs"]
            atlases[bid] = {"file": atlas["file"], "size": atlas["size"], "walls": [
                {k: m[k] for k in ("edge", "ring", "len_m", "h_m", "texel_m", "filled_frac", "uv", "px") if k in m} for m in metas]}
    shutil.rmtree(raw, ignore_errors=True)
    shutil.rmtree(tmp, ignore_errors=True)
    C.save_pkl(cd / "atlas.pkl.gz", atlases)
    patch_tiles(cell, atlases, final["tid_of"])
    stats = {"cell": cell, "texel": texel, "views": len(by_view), "mb_read": round(nbytes / 1e6, 1), "atlases": nweb,
             "webp_mb": round(webp_bytes / 1e6, 2), "mean_filled": round(float(np.mean(filled_all)), 3) if filled_all else None,
             "t": round(time.time() - t0, 1)}
    done.write_text(json.dumps(stats))
    return stats


def patch_tiles(cell: str, atlases: dict[str, dict], tid_of: dict[str, str]) -> None:
    by_tile: dict[str, dict] = {}
    for bid, a in atlases.items():
        by_tile.setdefault(tid_of[bid], {})[bid] = a
    for tid, d in by_tile.items():
        p = C.TILES / tid / "appearance.json"
        if not p.exists():  # cloud task: the tile layers are merged later (task.py MODE=attach)
            continue
        doc = C.jload(p)
        for bid, a in d.items():
            if bid in doc["buildings"]:
                doc["buildings"][bid]["atlas"] = a
        C.save_json(p, doc)


def _job(args):
    cell, texel, force = args
    try:
        return process_atlas(cell, texel, force)
    except SystemExit as e:
        return {"cell": cell, "error": str(e), "stop": True}
    except Exception:  # noqa: BLE001
        return {"cell": cell, "error": traceback.format_exc()[-1000:]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["atlas"])
    ap.add_argument("cells", nargs="+", help="cell ids, 'inner' (within 3.5 km of the centre) or 'all'")
    ap.add_argument("--texel", default="rings", help="'rings' (0.10 / 0.15 / 0.20 m by distance) or 'flat:<m>'")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    avail = [c for c in C.all_cells() if (C.cell_dir(c) / "final.done").exists()]
    if a.cells == ["all"]:
        cells = avail
    elif a.cells == ["inner"]:
        cells = [c for c in avail if cell_priority(c) <= 3500]
    else:
        cells = a.cells
    cells.sort(key=cell_priority)
    jobs = [(c, texel_for(c, a.texel), a.force) for c in cells]
    if a.workers <= 1:
        for j in jobs:
            print(json.dumps(_job(j)), flush=True)
    else:
        with ProcessPoolExecutor(a.workers, max_tasks_per_child=1) as ex:
            for f in as_completed([ex.submit(_job, j) for j in jobs]):
                print(json.dumps(f.result()), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
