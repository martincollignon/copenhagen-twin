# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "numpy", "rasterio", "pillow"]
# ///
"""GeoDanmark colour-infrared orthophoto (Dataforsyningen WMS `orto_foraar_cir`) -> NDVI 1 m raster data/raw/veg/ndvi.tif.

The CIR image is false colour: its R channel is near-infrared, G is red, B is green, so NDVI = (R - G) / (R + G) on the
image channels. Fetched at 0.5 m in 2 x 2 blocks over the district + 20 m, averaged to 1 m cells aligned with the LiDAR
class rasters (tools/cph-geodata/vegetation_rasters.py). The token (Secret Manager `gsearch-token`, or $GSEARCH_TOKEN /
$DHM_TERRAIN_TOKEN) goes in a header and is never printed.

    uv run tools/cph-geodata/vegetation_cir.py
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "veg"
WMS = "https://api.dataforsyningen.dk/orto_foraar_DAF"
BBOX = (723130, 6175730, 724670, 6177270)  # district + 20 m margin, whole metres
PX = 0.5


def token() -> str:
    for k in ("GSEARCH_TOKEN", "DHM_TERRAIN_TOKEN"):
        if os.environ.get(k):
            return os.environ[k].strip()
    return subprocess.run([str(ROOT / "tools" / "adc-secret.sh"), "gsearch-token"], capture_output=True, text=True, check=True).stdout.strip()


def main():
    from PIL import Image  # noqa: PLC0415
    import rasterio  # noqa: PLC0415
    from rasterio.transform import from_origin  # noqa: PLC0415

    RAW.mkdir(parents=True, exist_ok=True)
    tok = token()
    e0, n0, e1, n1 = BBOX
    W, H = int((e1 - e0) / PX), int((n1 - n0) / PX)
    ndvi = np.full((H, W), np.nan, "float32")
    bright = np.zeros((H, W), "float32")
    step = 770  # m per block: 1540 px
    for be in range(e0, e1, step):
        for bn in range(n0, n1, step):
            ee, nn = min(be + step, e1), min(bn + step, n1)
            w, h = int((ee - be) / PX), int((nn - bn) / PX)
            r = requests.get(WMS, params=dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS="orto_foraar_cir", STYLES="", CRS="EPSG:25832",
                                              BBOX=f"{be},{bn},{ee},{nn}", WIDTH=w, HEIGHT=h, FORMAT="image/png"), headers={"token": tok}, timeout=300)
            r.raise_for_status()
            im = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype("float32")
            nir, red = im[..., 0], im[..., 1]
            v = (nir - red) / np.maximum(nir + red, 1.0)
            r0, c0 = int((n1 - nn) / PX), int((be - e0) / PX)
            ndvi[r0:r0 + h, c0:c0 + w] = v
            bright[r0:r0 + h, c0:c0 + w] = (nir + red) / 2
            print(f"block {be},{bn}: ndvi p5/50/95 {np.nanpercentile(v, [5, 50, 95]).round(2)}", file=sys.stderr)
    # 0.5 m -> 1 m mean
    n1m = np.nanmean(ndvi.reshape(H // 2, 2, W // 2, 2), axis=(1, 3))
    t = from_origin(e0, n1, 1.0, 1.0)
    with rasterio.open(RAW / "ndvi.tif", "w", driver="GTiff", height=n1m.shape[0], width=n1m.shape[1], count=1, dtype="float32", crs="EPSG:25832", transform=t, compress="deflate") as d:
        d.write(n1m.astype("float32"), 1)
    print("wrote", RAW / "ndvi.tif", n1m.shape)


if __name__ == "__main__":
    main()
