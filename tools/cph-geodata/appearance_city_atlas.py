# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "rasterio", "pyproj", "requests", "numba"]
# ///
"""Phase 2 of the citywide appearance run: photo facade atlases, per 1 km cell (after `appearance_city_final.py finalize`).

Per cell: every observed wall gets its TEXTURE view (texture_view: the finest source sampling on the wall times its visible share,
from the per-view observations in obs.pkl.gz; not the tone pass's `best`, which prefers the newest, sunlit flight and so
mostly picked the 2025 obliques at ~0.134 m/px up the wall where the 2023 flight samples ~0.098 m/px). Those views are read at
FULL resolution, cropped to the walls they serve (not the whole tone-pass window), the walls are rectified to 10 cm/px strips exactly as
appearance.make_textures does (z-buffer of the cell + 100 m ring of neighbour buildings, DSM occlusion, shadow-sourced strips
carry the tone/tone_raw gain), packed into one atlas per building, passed through facade_look.process_building (shadow division,
window and unobserved masks, normalisation to tone_cal) and written ONLY as data/tex-look/<gdk id>.webp. A quality gate (strip_gate) then keeps only the strips
with a fine enough source sampling, a not-too-grazing view and a mostly observed look strip; a building whose strips all fail gets
no descriptor and keeps its tone facade. The JPEG intermediate and
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

CENTRE_UTM = (724378.0, 6175783.0)  # Raadhuspladsen: "inner city first" is measured from here
DEFAULT_TEXEL = "flat:0.10"  # every cell at the district's 10 cm/px (the 2023 obliques sample ~0.1 m/px; 'rings' used 0.15 / 0.20 m outside)
# quality gate (strip_gate): what a strip must meet to get a descriptor
GATE_MAX_SRC_M = 0.16  # coarsest source sampling (m per photo pixel, along or up the wall) of the texture view
GATE_MIN_COS = 0.34  # view incidence (cos to the wall normal): beyond ~70 degrees the strip is a smear
GATE_MIN_OBSERVED = 0.5  # share of the look strip that is observed (alpha > 0) after facade_look
GATE_MIN_H = 4.0  # m: lower walls (sheds, annexes, garden walls) are mostly roof / ground / neighbour in a 45 degree oblique
TEX_LOOK = C.ROOT / "data" / "tex-look"
MAX_ATLAS_BUILDINGS_PER_CELL = 100000


def cell_priority(cell: str) -> float:
    cx, cy = map(int, cell.split("_"))
    return math.hypot(cx * 1000 + 500 - CENTRE_UTM[0], cy * 1000 + 500 - CENTRE_UTM[1])


def texel_for(cell: str, policy: str) -> float:
    """Texel size: `policy` 'flat:<m>' (default flat:0.10) or 'rings' (0.10 m inside 3.5 km of CENTRE_UTM, 0.15 m to 6 km, 0.20 m beyond)."""
    if policy.startswith("flat:"):
        return float(policy[5:])
    d = cell_priority(cell)
    return 0.10 if d <= 3500 else 0.15 if d <= 6000 else 0.20


def source_res(scene: A.Scene, cam: A.Camera, sid: int) -> tuple[float, float]:
    """Metres per photo pixel along and up wall `sid` at its centre (the local Jacobian of the projection)."""
    a, b = scene.surf_a[sid], scene.surf_b[sid]
    L = max(float(scene.surf_len[sid]), 1e-6)
    u = (b - a) / L
    mid = (a + b) / 2
    y = float(scene.surf_ground[sid] + scene.surf_height[sid] / 2)
    col, row, _ = cam.project(np.array([[mid[0], y, mid[1]], [mid[0] + u[0], y, mid[1] + u[1]], [mid[0], y + 1.0, mid[1]]]))
    along = math.hypot(col[1] - col[0], row[1] - row[0])
    up = math.hypot(col[2] - col[0], row[2] - row[0])
    return 1.0 / max(along, 1e-6), 1.0 / max(up, 1e-6)


def texture_score(o: dict, res: tuple[float, float], area: float, factor: int) -> float:
    """Texture merit of one view of a wall: visible share / (coarsest sampling)^2, a little less for shadowed walls.
    `o["px"]` counts the wall's visible samples on the tone pass's 1/factor grid, so px * factor^2 * along * up is the visible area."""
    along, up = res
    vis = min(1.0, o["px"] * factor * factor * along * up / max(area, 1e-3)) * (1.0 - float(o.get("occluded_frac") or 0.0))
    grazing = 0.1 if float(o.get("cos", 1.0)) < GATE_MIN_COS else 1.0  # a grazing view only when nothing else sees the wall
    return vis / max(along, up) ** 2 * (1.0 - 0.25 * float(o.get("shadow_frac") or 0.0)) * grazing


def texture_view(obs_list: list[dict], wall: dict, res_of, area: float, factor: int):
    """(observation, (along, up)) of the view a wall's strip is cut from: the best texture_score among the views of the flight
    the wall's tone came from (`wall["year"]`). The older flight samples finer (2023 ~0.098 m/px up the wall, 2025 ~0.134) but
    shows what stood there two years earlier (scaffolding, since repainted facades), and its uncalibrated per-view tones cannot
    tell the two apart, so it is used only where the tone itself is from that flight."""
    cand = [o for o in obs_list if o.get("kind", "wall") == "wall" and o.get("px", 0) > 0]
    cand = [o for o in cand if o["year"] == wall.get("year")] or cand
    best = None
    for o in cand:
        r = res_of(o["view"])
        if r is None:
            continue
        s = texture_score(o, r, area, factor)
        if best is None or s > best[0]:
            best = (s, o, r)
    return (best[1], best[2]) if best else (None, None)


def strip_gate(meta: dict, rgba: np.ndarray) -> list[str]:
    """Reasons a finished look strip (RGBA of its atlas rectangle) fails the gate; empty = keep it."""
    why = []
    if meta.get("h_m", GATE_MIN_H) < GATE_MIN_H:
        why.append("low_wall")
    if meta.get("src_m") is not None and meta["src_m"] > GATE_MAX_SRC_M:
        why.append("low_res")
    if meta.get("cos") is not None and meta["cos"] < GATE_MIN_COS:
        why.append("grazing")
    if rgba.size == 0 or float((rgba[..., 3] > 0).mean()) < GATE_MIN_OBSERVED:
        why.append("unobserved")
    return why


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
    # per-view observations of every wall (tone pass): the candidates of the texture view
    obs_d = C.load_pkl(cd / "obs.pkl.gz") if (cd / "obs.pkl.gz").exists() else {"obs": {}, "factor": 2}
    vobs, factor = obs_d["obs"], int(obs_d.get("factor", 2))
    cams: dict[str, A.Camera] = {}

    def cam_of(vid):
        if vid not in cams:
            cams[vid] = A.Camera.from_pers(views[vid]["pers"])
        return cams[vid]
    # the walls to texture, grouped by their texture view: view id -> [(surface id, wall entry, observation, (along, up))]
    by_view: dict[str, list[tuple]] = {}
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
            if sid is None:
                continue
            area = float(scene.surf_len[sid] * scene.surf_height[sid])
            o, r = texture_view(vobs.get((bid, ri, w["edge"]), []), w,
                                lambda vid, sid=sid: source_res(scene, cam_of(vid), sid) if vid in views else None, area, factor)
            if o is None:  # no per-view observations (old cell): the tone pass's best view
                if w["best"] not in short2id:
                    continue
                vid = short2id[w["best"]]
                o, r = None, source_res(scene, cam_of(vid), sid)
            else:
                vid = o["view"]
            by_view.setdefault(vid, []).append((sid, w, o, r))
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
        sids = [it[0] for it in items]
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
        for sid, c, o, res in items:
            S = scene.surfaces[sid]
            tx = max(texel, scene.surf_len[sid] / 4096)
            px, valid = A.wall_texture(scene, sid, vb, full, rec["crop"], tx, dsm=dsm, veg=False)
            img, fill = A.fill_texture(px, valid, tx)
            if img is None:
                continue
            mult = None
            same = o is None or A.short_view(o["view"]) == c["best"]
            if same and not c["sunlit"]:  # the tone's own view: its white-balanced / photographed ratio
                mult = np.clip(A.srgb2lin(np.array(c["tone"])) / np.maximum(A.srgb2lin(np.array(c["tone_raw"])), 1e-3), 0.3, 8.0)
            elif not same and (o.get("from_shadow") or o.get("shadow_frac", 0) > 0.5):  # another view in shadow: its own shadow gain
                mult = np.clip(np.asarray(o["tone_lin"], float) / np.maximum(np.asarray(o["raw_lin"], float), 1e-3), 0.3, 8.0)
            if mult is not None:
                lin = A.srgb2lin(img.astype(np.float64) / 255.0) * mult
                img = np.clip(np.round(A.lin2srgb(lin) * 255), 0, 255).astype(np.uint8)
            filled_all.append(fill)
            strips.setdefault(S.bid, []).append((
                {"edge": S.edge, "ring": A.ring_label(S.ring), "len_m": round(float(scene.surf_len[sid]), 2),
                 "h_m": round(float(scene.surf_height[sid]), 2), "texel_m": round(float(tx), 3), "filled_frac": round(fill, 2),
                 "sunlit": bool(c["sunlit"]) if same else bool(o.get("shadow_frac", 1) < 0.5), "year": int(o["year"]) if o else c["year"],
                 "wb_applied": mult is not None, "src_m": round(float(max(res)), 3), "cos": round(float(o["cos"]), 3) if o else None}, img))
        del full, vb
        (raw / rec["file"]).unlink(missing_ok=True)
    # pack, process (facade_look), keep only the webp
    tmp = C.WORK / "tmp_atlas" / cell
    (tmp / "data" / "tex").mkdir(parents=True, exist_ok=True)
    TEX_LOOK.mkdir(parents=True, exist_ok=True)
    FL.ROOT, FL.OUT = tmp, TEX_LOOK
    atlases: dict[str, dict] = {}
    nweb = webp_bytes = 0
    gate = {"strips": 0, "kept": 0, "buildings_dropped": 0}
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
            rgba = np.asarray(Image.open(look))
            keep = []
            for m in metas:
                x, y, w_, h_ = m["px"]
                why = strip_gate(m, rgba[y:y + h_, x:x + w_])
                for r_ in why:
                    gate[r_] = gate.get(r_, 0) + 1
                if not why:
                    keep.append(m)
            gate["strips"] += len(metas)
            gate["kept"] += len(keep)
            if not keep:  # every strip failed: tone facade, no atlas
                look.unlink(missing_ok=True)
                gate["buildings_dropped"] += 1
                continue
            nweb += 1
            webp_bytes += look.stat().st_size
            area += st["area"]; win += st["win"]; unobs += st["unobs"]
            atlases[bid] = {"file": atlas["file"], "size": atlas["size"], "walls": [
                {k: m[k] for k in ("edge", "ring", "len_m", "h_m", "texel_m", "filled_frac", "uv", "px") if k in m} for m in keep]}
    shutil.rmtree(raw, ignore_errors=True)
    shutil.rmtree(tmp, ignore_errors=True)
    C.save_pkl(cd / "atlas.pkl.gz", atlases)
    patch_tiles(cell, atlases, final["tid_of"])
    stats = {"cell": cell, "texel": texel, "views": len(by_view), "mb_read": round(nbytes / 1e6, 1), "atlases": nweb,
             "webp_mb": round(webp_bytes / 1e6, 2), "mean_filled": round(float(np.mean(filled_all)), 3) if filled_all else None,
             "gate": gate, "t": round(time.time() - t0, 1)}
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
    ap.add_argument("--texel", default=DEFAULT_TEXEL, help="'flat:<m>' (default flat:0.10) or 'rings' (0.10 / 0.15 / 0.20 m by distance)")
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
