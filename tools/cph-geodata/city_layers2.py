"""Stage 2/3 of build_city.py that need per-building or per-cell work: entrances (DAR/BBR) and vegetation (LiDAR classes + CIR).

Vegetation is streamed per 1 km LiDAR cell: download the Punktsky LAZ -> 1 m class-count rasters (numpy, one pass) + the CIR
orthophoto -> NDVI 1 m raster -> delete the LAZ at once. Only the derived rasters (a few MB per cell) stay under
data/raw/veg/. Then vegetation.py runs per cell on those rasters and the cell's buildings / pavements / roads / lakes.
"""
from __future__ import annotations

import io
import json
import math
import os
import subprocess
import sys
import time
import traceback

import build_city as BC
import city_sources as S
import frame
import tile_split as T

log = BC.log
VEG = BC.DATA / "raw" / "veg"
LAZ_DIR = BC.DATA / "raw" / "lazwork"
CLASSES = (2, 3, 4, 5, 6, 9, 17)
WMS = "https://api.dataforsyningen.dk/orto_foraar_DAF"
# inner city first: Indre By, Christianshavn, Vesterbro, Oesterbro, Noerrebro, Frederiksberg (UTM, metres)
INNER = (718000, 6172000, 727000, 6178500)


def cell_priority(cells: dict) -> list[str]:
    def key(c):
        e0, n0, e1, n1 = BC.cell_bbox_utm(c)
        cx, cy = (e0 + e1) / 2, (n0 + n1) / 2
        inner = INNER[0] <= cx <= INNER[2] and INNER[1] <= cy <= INNER[3]
        return (0 if inner else 1, math.hypot(cx - 724000, cy - 6176500), c)

    return sorted(cells, key=key)


# -------------------------------------------------------------------------------------------------------- rasters

def download_laz(cell: str, key: str, tries: int = 8) -> "Path":  # noqa: F821
    """Punktsky LAZ by curl (the server stalls now and then and ignores Range: abort on a slow stretch and restart). The key
    goes in on stdin and never shows up in the process list or in output."""
    LAZ_DIR.mkdir(parents=True, exist_ok=True)
    dest = LAZ_DIR / f"PUNKTSKY_1km_{cell}.laz"
    part = dest.with_suffix(".part")
    url = f"https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey={key}&FileName={dest.name}"
    last = ""
    for attempt in range(1, tries + 1):
        p = subprocess.run(["curl", "-sS", "--fail", "--max-time", "900", "--speed-limit", "50000", "--speed-time", "45", "-o", str(part), "-K", "-"],
                           input=f'url = "{url}"\n', capture_output=True, text=True)
        ok = p.returncode == 0 and part.exists() and part.stat().st_size > 1_000_000
        if ok:
            with open(part, "rb") as f:
                ok = f.read(4) == b"LASF"
        if ok:
            part.replace(dest)
            return dest
        last = p.stderr.replace(key, "***").strip()[:160]
        part.unlink(missing_ok=True)
        time.sleep(min(60, 5 * attempt))
    raise RuntimeError(f"LAZ {cell}: {tries} attempts failed ({last})")


def class_rasters(laz, cell: str, out_dir) -> dict:
    """1 m point-count rasters per DHM class for the cell (one pass over the points)."""
    import laspy
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    e0, n0, e1, n1 = BC.cell_bbox_utm(cell)
    size = 1000
    counts = {c: np.zeros(size * size, dtype=np.float32) for c in CLASSES}
    n_pts = 0
    with laspy.open(laz) as rd:
        for chunk in rd.chunk_iterator(4_000_000):
            x = np.floor(np.asarray(chunk.x) - e0).astype(np.int64)
            row = np.floor(n1 - np.asarray(chunk.y)).astype(np.int64)  # north-up: row 0 = northern edge
            cl = np.asarray(chunk.classification)
            ok = (x >= 0) & (x < size) & (row >= 0) & (row < size)
            n_pts += int(ok.sum())
            idx = row * size + x
            for c in CLASSES:
                m = ok & (cl == c)
                if m.any():
                    counts[c] += np.bincount(idx[m], minlength=size * size).astype(np.float32)
    t = from_origin(e0, n1, 1.0, 1.0)
    for c, a in counts.items():
        with rasterio.open(out_dir / f"c{c}_{cell}.tif", "w", driver="GTiff", height=size, width=size, count=1, dtype="float32", crs="EPSG:25832",
                           transform=t, compress="deflate", nodata=0) as d:
            d.write(a.reshape(size, size), 1)
    return {"points": n_pts}


def ndvi_raster(cell: str, token: str, out_dir) -> None:
    """CIR orthophoto (WMS) over the cell + 20 m -> NDVI at 1 m (the CIR image is false colour: R = near-infrared, G = red)."""
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.transform import from_origin

    e0, n0, e1, n1 = BC.cell_bbox_utm(cell)
    e0, n0, e1, n1 = int(e0) - 20, int(n0) - 20, int(e1) + 20, int(n1) + 20
    px = 0.5
    W, H = int((e1 - e0) / px), int((n1 - n0) / px)
    ndvi = np.full((H, W), np.nan, "float32")
    step = 520
    for be in range(e0, e1, step):
        for bn in range(n0, n1, step):
            ee, nn = min(be + step, e1), min(bn + step, n1)
            w, h = int((ee - be) / px), int((nn - bn) / px)
            r = S.request("GET", WMS, what="cir", params=dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS="orto_foraar_cir", STYLES="",
                                                              CRS="EPSG:25832", BBOX=f"{be},{bn},{ee},{nn}", WIDTH=w, HEIGHT=h, FORMAT="image/png"),
                          headers={"token": token}, timeout=300)
            r.raise_for_status()
            im = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype("float32")
            nir, red = im[..., 0], im[..., 1]
            r0, c0 = int((n1 - nn) / px), int((be - e0) / px)
            ndvi[r0:r0 + h, c0:c0 + w] = (nir - red) / np.maximum(nir + red, 1.0)
    n1m = np.nanmean(ndvi.reshape(H // 2, 2, W // 2, 2), axis=(1, 3))
    with rasterio.open(out_dir / f"ndvi_{cell}.tif", "w", driver="GTiff", height=n1m.shape[0], width=n1m.shape[1], count=1, dtype="float32",
                       crs="EPSG:25832", transform=from_origin(e0, n1, 1.0, 1.0), compress="deflate") as d:
        d.write(n1m.astype("float32"), 1)


def veg_raster_job(cell: str) -> dict:
    name = f"veg-raster-{cell}"
    if BC.is_done(name):
        return {"cell": cell, "skipped": True}
    if BC.free_gb() < BC.MIN_FREE_GB + 1:
        return {"cell": cell, "error": "low-disk"}
    t0 = time.time()
    laz = None
    try:
        BC.ensure_secrets("DATAFORDELER_GRAPHQL_API_KEY", "GSEARCH_TOKEN")
        VEG.mkdir(parents=True, exist_ok=True)
        laz = download_laz(cell, os.environ["DATAFORDELER_GRAPHQL_API_KEY"])
        t1 = time.time()
        info = class_rasters(laz, cell, VEG)
        laz.unlink()  # streamed: the point cloud is deleted as soon as the rasters are derived
        laz = None
        t2 = time.time()
        ndvi_raster(cell, os.environ["GSEARCH_TOKEN"], VEG)
        res = {"cell": cell, **info, "download_s": round(t1 - t0), "classes_s": round(t2 - t1), "ndvi_s": round(time.time() - t2),
               "seconds": round(time.time() - t0, 1)}
        BC.mark_done(name, **{k: v for k, v in res.items() if k != "cell"})
        return res
    except Exception as e:  # noqa: BLE001
        return {"cell": cell, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-400:]}
    finally:
        if laz is not None and laz.exists():
            laz.unlink()
        for p in LAZ_DIR.glob(f"PUNKTSKY_1km_{cell}.*"):
            p.unlink(missing_ok=True)


# --------------------------------------------------------------------------------------------------- compile per cell

def _around(cell: str, margin: float) -> list[str]:
    e0, n0, e1, n1 = BC.cell_bbox_utm(cell)
    return frame.tiles_for_bbox((e0, n0, e1, n1), margin=margin)


def veg_compile_job(cell: str, tids: list[str], neighbours_ready: bool) -> dict:
    name = f"veg-cell-{cell}"
    if BC.is_done(name):
        return {"cell": cell, "skipped": True}
    t0 = time.time()
    try:
        import vegetation

        core = BC.cell_bbox_utm(cell)
        around = [t for t in _around(cell, 100.0) if (BC.TILES_DIR / t).is_dir()]
        geo = {"sidewalks": [], "roads": [], "parks": [], "cycleTracks": [], "buildings": []}
        surf = {"surfaces": []}
        for t in around:
            for layer, keys in (("roads", ("sidewalks", "roads", "parks", "cycleTracks")), ("buildings", ("buildings",))):
                p = BC.TILES_DIR / t / f"{layer}.json"
                if p.exists():
                    d = json.loads(p.read_text())
                    for k in keys:
                        geo[k] += d.get(k, [])
            p = BC.TILES_DIR / t / "surfaces.json"
            if p.exists():
                surf["surfaces"] += json.loads(p.read_text()).get("surfaces", [])
        e0, n0, e1, n1 = core
        x0, z0, x1, z1 = frame.utm_bbox_to_local((e0 - 100, n0 - 100, e1 + 100, n1 + 100))
        lakes_doc = json.loads((BC.CITY_DIR / "lakes.json").read_text()) if (BC.CITY_DIR / "lakes.json").exists() else {"lakes": []}
        lakes = {"lakes": [l for l in lakes_doc["lakes"] if max(l["ring"][0::2]) > x0 and min(l["ring"][0::2]) < x1
                           and max(l["ring"][1::2]) > z0 and min(l["ring"][1::2]) < z1]}
        inp = BC.WORK / "veg_in" / cell
        inp.mkdir(parents=True, exist_ok=True)
        files = {}
        for k, doc in (("geodata", geo), ("surfaces", surf), ("lakes", lakes), ("streets", {"roads": {}, "extraRoads": []})):
            files[k] = inp / f"{k}.json"
            files[k].write_text(BC.dump(doc))
        out = inp / "vegetation.json"
        argv = sys.argv
        sys.argv = ["vegetation.py", "--bbox", *map(str, core), "--out", str(out), "--geodata", str(files["geodata"]), "--surfaces", str(files["surfaces"]),
                    "--lakes", str(files["lakes"]), "--streets", str(files["streets"]), "--ndvi", f"ndvi_{cell}.tif", "--veg-dir", str(VEG)]
        try:
            vegetation.main()
        finally:
            sys.argv = argv
        doc = json.loads(out.read_text())
        by: dict[str, dict] = {}
        for key in ("surfaces", "canopy"):
            for i, s in enumerate(doc[key]):
                tid = T.owner_of_ring(s)
                if tid in tids:
                    by.setdefault(tid, {"tile": tid, "ord": {}}).setdefault(key, []).append(s)
                    by[tid]["ord"].setdefault(key, []).append(len(by[tid][key]) - 1)
        for tid in tids:
            if tid in by:
                BC.write_layer(tid, "vegetation", by[tid])
            elif (BC.TILES_DIR / tid / "vegetation.json").exists():
                (BC.TILES_DIR / tid / "vegetation.json").unlink()
        for p in inp.glob("*.json"):
            p.unlink()
        res = {"cell": cell, "stats": doc["stats"], "seconds": round(time.time() - t0, 1), "edge_complete": neighbours_ready,
               "meta": T._without(doc, ("surfaces", "canopy", "stats"))}
        BC.mark_done(name, **{k: v for k, v in res.items() if k != "cell"})
        return res
    except SystemExit as e:
        return {"cell": cell, "error": f"exit: {e}"}
    except Exception as e:  # noqa: BLE001
        return {"cell": cell, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-500:]}


def stage_vegetation(a, tiles, cells) -> None:
    """Rasters per cell (queue: inner city first; `--veg-limit N` cells per run), then the vegetation compile for every cell
    whose rasters and neighbours' rasters exist. Resumable: both steps leave a marker per cell."""
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor, as_completed

    BC.ensure_secrets("DATAFORDELER_GRAPHQL_API_KEY", "GSEARCH_TOKEN")
    order = cell_priority(cells)
    if a.cells:
        order = [c for c in order if c in a.cells]
    todo = [c for c in order if not BC.is_done(f"veg-raster-{c}")]
    if a.veg_limit:
        todo = todo[:a.veg_limit]
    log(f"[vegetation] rasters: {len(todo)} cells queued of {len(order)} ({len(order) - len(todo)} done), {a.veg_workers} workers, {BC.free_gb():.1f} GB free")
    errors = {}
    t0 = time.time()
    if todo:
        with ProcessPoolExecutor(a.veg_workers, mp_context=mp.get_context("spawn")) as ex:
            futs = {ex.submit(veg_raster_job, c): c for c in todo}
            for n, f in enumerate(as_completed(futs), 1):
                r, c = f.result(), futs[f]
                if r.get("error"):
                    errors[c] = r["error"]
                    log(f"[vegetation] {c} FAILED: {r['error']} {r.get('trace', '')[-160:]}")
                    if r["error"] == "low-disk":
                        for g in futs:
                            g.cancel()
                        break
                else:
                    log(f"[vegetation] rasters {n}/{len(todo)} {c}: {r.get('download_s', '-')}s download, {r.get('classes_s', '-')}s classes, "
                        f"{r.get('ndvi_s', '-')}s ndvi; {BC.free_gb():.1f} GB free")
    if a.veg_rasters_only:
        return
    # compile: a cell whose own rasters exist; edge exactness needs the neighbours' too (missing ones are skipped by vegetation.py)
    ready = [c for c in order if BC.is_done(f"veg-raster-{c}") and not BC.is_done(f"veg-cell-{c}")]
    log(f"[vegetation] compiling {len(ready)} cells")
    with ProcessPoolExecutor(min(a.workers, 4), mp_context=mp.get_context("spawn")) as ex:
        futs = {}
        for c in ready:
            nb_ok = all(BC.is_done(f"veg-raster-{n}") for n in _neighbour_cells(c, cells))
            futs[ex.submit(veg_compile_job, c, cells[c], nb_ok)] = c
        for n, f in enumerate(as_completed(futs), 1):
            r, c = f.result(), futs[f]
            if r.get("error"):
                errors[f"compile {c}"] = r["error"]
                log(f"[vegetation] compile {c} FAILED: {r['error']} {r.get('trace', '')[-200:]}")
            else:
                log(f"[vegetation] compiled {n}/{len(ready)} {c} in {r.get('seconds', '-')}s")
    done = [c for c in order if BC.is_done(f"veg-cell-{c}")]
    if done:
        st = {}
        for c in done:
            for k, v in BC.read_done(f"veg-cell-{c}").get("stats", {}).items():
                if k.endswith("_m2") or k == "polygons":
                    st[k] = st.get(k, 0) + v
        meta = BC.read_done(f"veg-cell-{done[0]}").get("meta", {})
        meta = {**meta, "frame": {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": BC.city_local_bbox(tiles)},
                "stats": st, "cells_done": len(done), "cells_total": len(cells)}
        S.atomic_write(BC.WORK / "meta_parts" / "vegetation.json", BC.dump(meta))
    left = [c for c in order if not BC.is_done(f"veg-cell-{c}")]
    queue = (f"- vegetation (CIR NDVI + LiDAR classes): {len(done)} of {len(cells)} cells done; queue (inner city first, resumable with "
             f"`--stage vegetation`): {len(left)} cells" + (f", e.g. {', '.join(left[:6])}" if left else ""))
    S.atomic_write(BC.WORK / "queue_vegetation.md", queue + "\n")
    BC.mark_done("vegetation-run", cells_done=len(done), cells_left=len(left), seconds=round(time.time() - t0))
    if errors:
        log(f"[vegetation] {len(errors)} failures: {errors}")


def _neighbour_cells(cell: str, cells: dict) -> list[str]:
    n, e = (int(v) for v in cell.split("_"))
    return [f"{n + dn}_{e + de}" for dn in (-1, 0, 1) for de in (-1, 0, 1) if (dn or de) and f"{n + dn}_{e + de}" in cells]


# ---------------------------------------------------------------------------------------------------------- entrances

def stage_entrances(a, tiles, cells) -> None:
    """DAR husnumre + BBR opgange for the city (entrances.py on the buildings of the tiles >= 20 m2), cut into tiles by the building
    each entrance belongs to."""
    if BC.is_done("entrances") and not a.force_stage("entrances"):
        return
    t0 = time.time()
    BC.ensure_secrets("DATAFORDELER_USERNAME", "DATAFORDELER_PASSWORD", "DATAFORDELER_GRAPHQL_API_KEY")
    import fetch

    frame.set_area(BC.city_bbox_utm(tiles))
    fetch.cache_dir = lambda: BC.RAW_CITY  # noqa: E731
    import entrances

    owner, blds = {}, []
    for tid in sorted(tiles):
        p = BC.TILES_DIR / tid / "buildings.json"
        if not p.exists():
            continue
        for b in json.loads(p.read_text())["buildings"]:
            owner[b["id"]] = tid
            r = b["ring"]
            if _ring_area(r) >= 20.0:
                blds.append({k: b[k] for k in ("id", "bbr_id", "ring", "holes")})
    src = BC.WORK / "entrances_buildings.json"
    S.atomic_write(src, BC.dump({"buildings": blds}))
    out = BC.WORK / "entrances_city.json"
    log(f"[entrances] {len(blds)} buildings >= 20 m2 of {len(owner)}; DAR lookups (cached under data/raw/dar)")
    argv = sys.argv
    sys.argv = ["entrances.py", "--bbox", *map(str, BC.city_bbox_utm(tiles)), "--out", str(out), "--geodata", str(src)]
    try:
        entrances.main()
    finally:
        sys.argv = argv
    doc = json.loads(out.read_text())
    L = BC.Layers(set(tiles))
    ent_tile = {}
    for i, e in enumerate(doc["entrances"]):
        tid = owner.get(e.get("bid")) or T.owner_of_point(e)
        ent_tile[e["id"]] = tid
        L.add(tid, "entrances", "entrances", e, i)
    orphans = {}
    for sid, v in doc.get("stairwells", {}).items():
        tid = owner.get(sid)
        if tid in tiles:
            L.t.put(tid, "entrances", "stairwells", sid, v)
        else:
            orphans[sid] = v
    n = 0
    for tid in tiles:
        payload = L.t.layers.get(tid, {}).get("entrances")
        if payload:
            BC.write_layer(tid, "entrances", payload)
            n += 1
        elif (BC.TILES_DIR / tid / "entrances.json").exists():
            (BC.TILES_DIR / tid / "entrances.json").unlink()
    meta = T._without(doc, ("entrances", "stairwells"))
    if orphans:
        meta["stairwells"] = orphans
    S.atomic_write(BC.WORK / "meta_parts" / "entrances.json", BC.dump(meta))
    BC.mark_done("entrances", seconds=round(time.time() - t0), tiles=n, entrances=len(doc["entrances"]), buildings=len(blds))
    log(f"[entrances] {len(doc['entrances'])} entrances in {n} tiles ({time.time() - t0:.0f}s)")


def _ring_area(r) -> float:
    n = len(r) // 2
    return abs(sum(r[2 * i] * r[2 * ((i + 1) % n) + 1] - r[2 * ((i + 1) % n)] * r[2 * i + 1] for i in range(n))) / 2
