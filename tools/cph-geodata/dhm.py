"""Optional DHM DSM/DTM sampling via the Dataforsyningen WCS (needs a token).

Credentials come from the process environment or an explicit --env-file; they are
sent as a `token` header (and as the documented URL parameter only as a fallback)
and are never printed or written to disk. Rasters are cached as compressed GeoTIFFs
under data/raw/ at 1 m (bbox-limited, no LAZ tiles).
"""
from __future__ import annotations

import sys

import numpy as np
import requests

import fetch
from frame import ORIGIN

WCS = "https://api.dataforsyningen.dk/dhm_wcs_DAF"
TILE = 800.0
RES = 1.0


class Raster:
    def __init__(self, arr, transform, nodata):
        self.arr, self.t, self.nodata = arr, transform, nodata

    def values(self, geom):
        """Valid pixel values whose centres fall inside `geom` (shapely, UTM)."""
        from rasterio import features
        from rasterio.windows import from_bounds

        if geom.is_empty:
            return np.array([])
        w = from_bounds(*geom.bounds, transform=self.t).round_offsets().round_lengths()
        r0, c0 = max(int(w.row_off), 0), max(int(w.col_off), 0)
        r1 = min(int(w.row_off + w.height) + 1, self.arr.shape[0])
        c1 = min(int(w.col_off + w.width) + 1, self.arr.shape[1])
        if r1 <= r0 or c1 <= c0:
            return np.array([])
        from rasterio.transform import Affine

        sub_t = self.t * Affine.translation(c0, r0)
        mask = features.geometry_mask([geom], out_shape=(r1 - r0, c1 - c0), transform=sub_t, invert=True)
        v = self.arr[r0:r1, c0:c1][mask]
        v = v[np.isfinite(v)]
        if self.nodata is not None:
            v = v[v != self.nodata]
        return v[v > -100]


def _tiles():
    x0, y0, x1, y1 = fetch.utm_bbox(margin=40)
    xs = np.arange(x0, x1, TILE)
    ys = np.arange(y0, y1, TILE)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            yield i, j, x, y, min(x + TILE, x1), min(y + TILE, y1)


def load_rasters(token: str):
    """Return {'dsm': Raster, 'dtm': Raster}; raises on failure."""
    import rasterio
    from rasterio.merge import merge

    out = {}
    for key, cov in (("dsm", "dhm_overflade"), ("dtm", "dhm_terraen")):
        paths = []
        for i, j, x0, y0, x1, y1 in _tiles():
            p = fetch.cache_dir() / f"dhm_{key}_{i}_{j}.tif"
            if not p.exists():
                w, h = int(np.ceil((x1 - x0) / RES)), int(np.ceil((y1 - y0) / RES))
                params = dict(SERVICE="WCS", REQUEST="GetCoverage", VERSION="1.0.0", COVERAGE=cov, FORMAT="GTiff",
                              CRS="EPSG:25832", BBOX=f"{x0:.2f},{y0:.2f},{x1:.2f},{y1:.2f}", WIDTH=w, HEIGHT=h)
                r = requests.get(WCS, params=params, headers={"token": token, "User-Agent": fetch.UA}, timeout=300)
                if r.status_code in (401, 403):
                    r = requests.get(WCS, params={**params, "token": token}, headers={"User-Agent": fetch.UA}, timeout=300)
                r.raise_for_status()
                if not r.content[:4] in (b"II*\x00", b"MM\x00*"):
                    raise RuntimeError(f"WCS {cov} returned non-TIFF")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(r.content)
                print(f"[fetch] dhm:{key} tile {i},{j}", file=sys.stderr)
            paths.append(p)
        srcs = [rasterio.open(p) for p in paths]
        arr, t = merge(srcs, res=RES)
        nd = srcs[0].nodata
        for s in srcs:
            s.close()
        out[key] = Raster(arr[0].astype("float32"), t, nd)
    return out


def building_heights(rasters, poly_utm):
    """-> dict(ground, eave, ridge) in DVR90 or None. Eave = 60th percentile of the
    DSM inside the footprint shrunk by 1 m, ridge = 95th percentile, ground = DTM
    median under the footprint plus a 1.5 m ring."""
    inner = poly_utm.buffer(-1.0)
    if inner.is_empty:
        inner = poly_utm
    dsm = rasters["dsm"].values(inner)
    ring = poly_utm.buffer(1.5).difference(poly_utm)
    dtm = rasters["dtm"].values(ring if not ring.is_empty else poly_utm)
    if dtm.size == 0:
        dtm = rasters["dtm"].values(poly_utm)
    if dsm.size < 4 or dtm.size == 0:
        return None
    return {"ground": float(np.median(dtm)), "eave": float(np.percentile(dsm, 60)), "ridge": float(np.percentile(dsm, 95))}
