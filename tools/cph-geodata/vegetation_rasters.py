"""Per-class 1 m point-count rasters from the DHM Punktsky LAZ tiles (tools/lod2/fetch.py) -> data/raw/veg/.

DHM classes: 2 ground, 3 low vegetation, 4 medium vegetation, 5 high vegetation, 6 building, 9 water, 17 bridge.
Needs `pdal` on PATH. Output: data/raw/veg/c<class>_<tile>.tif (float count per 1 m cell, EPSG:25832) and gint_<tile>.tif (mean LiDAR
intensity of the ground returns: the lidar pulse is near-infrared, so lawn reflects much more than asphalt or paving).

    python3 tools/cph-geodata/vegetation_rasters.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "lod2"))
import common  # noqa: E402

OUT = ROOT / "data" / "raw" / "veg"
CLASSES = (2, 3, 4, 5, 6, 9, 17)
MARGIN = 20.0


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    e0, n0, e1, n1 = common.DISTRICT_BBOX
    for tid in common.tiles_for_bbox(common.DISTRICT_BBOX, MARGIN):
        laz = common.tile_file(tid)
        if not laz.exists():
            raise SystemExit(f"missing {laz}: run tools/lod2/fetch.py")
        tb = common.tile_bounds(tid)
        # 1 m cells aligned to whole metres, clipped to the district + margin
        b = [max(tb[0], e0 - MARGIN), max(tb[1], n0 - MARGIN), min(tb[2], e1 + MARGIN), min(tb[3], n1 + MARGIN)]
        b = [round(v) for v in b]
        for name, c, extra in [(f"c{c}", c, {}) for c in CLASSES] + [("gint", 2, {"dimension": "Intensity", "output_type": "mean"})]:
            dest = OUT / f"{name}_{tid}.tif"
            if dest.exists():
                continue
            pipe = [
                {"type": "readers.las", "filename": str(laz)},
                {"type": "filters.range", "limits": f"Classification[{c}:{c}]"},
                {"type": "filters.crop", "bounds": f"([{b[0]},{b[2]}],[{b[1]},{b[3]}])"},
                {"type": "writers.gdal", "filename": str(dest), "resolution": 1.0, "output_type": "count",
                 "origin_x": b[0], "origin_y": b[1], "width": b[2] - b[0], "height": b[3] - b[1],
                 "gdalopts": "COMPRESS=DEFLATE", "data_type": "float32", "nodata": 0, **extra},
            ]
            cfg = OUT / "pipeline.json"
            cfg.write_text(json.dumps(pipe))
            subprocess.run(["pdal", "pipeline", str(cfg)], check=True, capture_output=True)
            print("wrote", dest.name, flush=True)


if __name__ == "__main__":
    main()
