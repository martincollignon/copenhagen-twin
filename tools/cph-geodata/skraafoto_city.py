# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "pyproj", "requests"]
# ///
"""Citywide Skraafoto + DHM access for the appearance pass (one 1 km cell at a time).

Differences from skraafoto_prefetch.py (which serves the 1.5 km district):
  * the area is any bbox (a cell), the ground / eave range of the window comes from the cell's buildings;
  * windows can be read from a COG *overview* (`factor` 2 or 4): the tone pass samples at half or quarter resolution, so it
    never needs the full-resolution pixels (a quarter-resolution cell is ~1/16 of the bytes);
  * every network read is retried with exponential back-off (HTTP 429 / 5xx / GDAL curl errors), STAC pages are cached on disk;
  * a DSM (DHM WCS, 1 m) block cache replaces the district's hand-copied dhm_dsm_*.tif.
The token (env GSEARCH_TOKEN or SKRAAFOTO_STAC_TOKEN) is only ever sent as a header and never printed.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / ".claude/skills/building-case-to-3d/scripts"))
sys.path.insert(0, str(HERE))
import skraafoto as S  # noqa: E402
from frame import ORIGIN  # noqa: E402

WCS = "https://api.dataforsyningen.dk/dhm_wcs_DAF"
DSM_BLOCK = 500


def token() -> str:
    return S._token(None)


# ---------------------------------------------------------------------------------------------------------------------
# STAC


def _retry(fn, what: str, tok: str, tries: int = 7):
    last = None
    for attempt in range(tries):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(min(60.0, 1.5 * 2 ** attempt) * (0.5 + np.random.rand()))
    raise RuntimeError(f"{what} failed after {tries} tries: {S._redact(last, tok)}")


def stac_items(collection: str, bbox_utm: tuple[float, float, float, float], cache: Path | None) -> list[dict]:
    """All items of `collection` intersecting the UTM bbox, reduced to what the pipeline needs (cached as JSON)."""
    if cache is not None and cache.exists():
        return json.loads(cache.read_text())
    from pyproj import Transformer

    tok = token()
    tr = Transformer.from_crs(25832, 4326, always_xy=True)
    lon0, lat0 = tr.transform(bbox_utm[0], bbox_utm[1])
    lon1, lat1 = tr.transform(bbox_utm[2], bbox_utm[3])
    url = f"{S.BASE_URL}/collections/{collection}/items?" + urlencode(
        {"bbox": ",".join(f"{v:.6f}" for v in (lon0, lat0, lon1, lat1)), "limit": 200})
    feats: list[dict] = []
    while url:
        page = _retry(lambda u=url: S._request_json(u, tok), "STAC", tok)
        for f in page.get("features", []):
            pers = S._pers(f)
            if not pers or "data" not in f.get("assets", {}):
                continue
            p = f["properties"]
            feats.append({"id": f["id"], "collection": f["collection"], "direction": p.get("direction"),
                          "datetime": p.get("datetime"), "gsd": p.get("gsd"), "href": f["assets"]["data"]["href"], "pers": pers})
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".tmp")
        tmp.write_text(json.dumps(feats))
        tmp.replace(cache)
    return feats


def select_views(feats: list[dict], area_local: tuple[float, float, float, float], y_ref: float, y_lo: float, y_hi: float,
                 step: float = 60.0, margin: float = 0.06, pad_px: int = 64, factor: int = 1) -> list[dict]:
    """Per direction and 60 m grid point the image with the point closest to its centre; one window per image covering
    every point it serves from y_lo to y_hi (local heights). Returns camera records (no `file` yet).
    area_local = (x0, z0, x1, z1) in the local frame."""
    import appearance as A

    x0, z0, x1, z1 = area_local
    gx = np.arange(x0, x1 + 1e-6, step)
    gz = np.arange(z0, z1 + 1e-6, step)
    grid = np.array([(x, z) for x in gx for z in gz])
    P = np.column_stack([grid[:, 0], np.full(len(grid), y_ref), grid[:, 1]])
    by_dir: dict[str, list[dict]] = {}
    for f in feats:
        by_dir.setdefault(f["direction"] or "?", []).append(f)
    served: dict[str, list[int]] = {}
    feat_by_id = {f["id"]: f for f in feats}
    for d, fs in by_dir.items():
        best = np.full(len(P), 9.0)
        who = np.full(len(P), -1)
        for k, f in enumerate(fs):
            cam = A.Camera.from_pers(f["pers"])
            col, row, z = cam.project(P)
            u, v = col / cam.W, row / cam.H
            ok = (z > 1) & (u >= margin) & (u <= 1 - margin) & (v >= margin) & (v <= 1 - margin)
            dist = np.where(ok, (u - 0.5) ** 2 + (v - 0.5) ** 2, 9.0)
            upd = dist < best
            best[upd], who[upd] = dist[upd], k
        for i, k in enumerate(who):
            if k >= 0:
                served.setdefault(fs[k]["id"], []).append(i)
    recs = []
    for iid, idx in served.items():
        f = feat_by_id[iid]
        cam = A.Camera.from_pers(f["pers"])
        cs, rs = [], []
        for i in idx:
            gx_, gz_ = grid[i]
            for dx in (-step / 2, step / 2):
                for dz in (-step / 2, step / 2):
                    for y in (y_lo, y_hi):
                        col, row, z = cam.project(np.array([gx_ + dx, y, gz_ + dz]))
                        if z > 1:
                            cs.append(float(col)); rs.append(float(row))
        if not cs:
            continue
        W, H = int(cam.W), int(cam.H)
        fx = factor
        cx0 = max(0, (int(min(cs)) - pad_px) // fx * fx)
        cy0 = max(0, (int(min(rs)) - pad_px) // fx * fx)
        cx1 = min(W // fx * fx, -(-(int(max(cs)) + pad_px) // fx) * fx)
        cy1 = min(H // fx * fx, -(-(int(max(rs)) + pad_px) // fx) * fx)
        if cx1 - cx0 < 64 * fx or cy1 - cy0 < 64 * fx:
            continue
        vid = S._view_id(f["collection"], f["direction"], f["id"])
        recs.append({"view_id": vid, "item_id": f["id"], "collection": f["collection"], "direction": f["direction"],
                     "datetime": f["datetime"], "gsd": f["gsd"], "href": f["href"], "image_size": [W, H],
                     "crop": {"x0": cx0, "y0": cy0, "x1": cx1, "y1": cy1, "overview_factor": fx},
                     "file": vid + ".jpg", "pers": f["pers"], "grid_points_served": len(idx)})
    recs.sort(key=lambda r: r["view_id"])
    return recs


def fetch_window(rec: dict, out_dir: Path, factor: int, quality: int = 92) -> int:
    """Read rec['crop'] of the COG at 1/factor resolution into out_dir/rec['file'] (JPEG). Returns bytes written."""
    import rasterio
    from PIL import Image
    from rasterio.enums import Resampling
    from rasterio.windows import Window

    tok = token()
    path = out_dir / rec["file"]
    if path.exists():
        return path.stat().st_size
    c = rec["crop"]
    w, h = c["x1"] - c["x0"], c["y1"] - c["y0"]

    def read():
        env = dict(GDAL_HTTP_HEADERS=f"token: {tok}", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                   GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2", GDAL_HTTP_TIMEOUT="90", VSI_CACHE="TRUE",
                   CPL_VSIL_CURL_CACHE_SIZE="64000000")
        with rasterio.Env(**env):
            with rasterio.open("/vsicurl/" + rec["href"]) as ds:
                return ds.read([1, 2, 3], window=Window(c["x0"], c["y0"], w, h),
                               out_shape=(3, h // factor, w // factor), resampling=Resampling.average if factor > 1 else Resampling.nearest)

    arr = _retry(read, f"read {rec['view_id']}", tok)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part.jpg")
    Image.fromarray(np.moveaxis(arr, 0, -1)).save(tmp, quality=quality)
    tmp.replace(path)
    return path.stat().st_size


# ---------------------------------------------------------------------------------------------------------------------
# DSM


def dsm_blocks(area_utm: tuple[float, float, float, float], cache: Path) -> list[Path]:
    """Cached 500 m / 1 m DSM GeoTIFF blocks (aligned to the 500 m grid) covering the UTM bbox."""
    import requests

    tok = token()
    e0, n0, e1, n1 = area_utm
    paths = []
    for be in range(int(math.floor(e0 / DSM_BLOCK)), int(math.floor(e1 / DSM_BLOCK)) + 1):
        for bn in range(int(math.floor(n0 / DSM_BLOCK)), int(math.floor(n1 / DSM_BLOCK)) + 1):
            p = cache / f"dsm_{be}_{bn}.tif"
            if not p.exists():
                x0, y0 = be * DSM_BLOCK, bn * DSM_BLOCK
                params = dict(SERVICE="WCS", REQUEST="GetCoverage", VERSION="1.0.0", COVERAGE="dhm_overflade", FORMAT="GTiff",
                              CRS="EPSG:25832", BBOX=f"{x0},{y0},{x0 + DSM_BLOCK},{y0 + DSM_BLOCK}", WIDTH=DSM_BLOCK, HEIGHT=DSM_BLOCK)

                def get():
                    r = requests.get(WCS, params=params, headers={"token": tok, "User-Agent": S.USER_AGENT}, timeout=300)
                    r.raise_for_status()
                    if r.content[:4] not in (b"II*\x00", b"MM\x00*"):
                        raise RuntimeError("WCS returned non-TIFF")
                    return r.content

                data = _retry(get, f"DSM block {be}_{bn}", tok)
                cache.mkdir(parents=True, exist_ok=True)
                tmp = p.with_suffix(".part")
                tmp.write_bytes(data)
                tmp.replace(p)
            paths.append(p)
    return paths
