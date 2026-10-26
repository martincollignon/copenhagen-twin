# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "numpy", "rasterio"]
# ///
"""Water basins for the Copenhagen twin -> adds `basins` to data/cph-lakes.json (everything else in the file is kept).

lakes.py closes bridge strips (Dronning Louises Bro) so Sortedams Soe and Peblinge Soe become ONE polygon, and
terrain.py takes one median level for it. The DTM says they are two water bodies: Peblinge Soe at about -0.94 m,
Sortedams Soe about 0.84 m higher (-0.10 m). One level for both made the walls of the high basin 0.84 m too tall
(2.4 m quays at the bridge). A basin is the part of a lake outside the bridge strips; its `level` is the median of the
raw DTM inside it (the DTM over still water IS the water surface). Lakes without a bridge strip keep one basin.

    uv run tools/cph-geodata/basins.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIN_BASIN_M2 = 400.0
STRIP_BUFFER_M = 0.3  # lakes.py overlaps strip and water by 0.1 m: the cut must clear that to separate the basins


def _terrain():
    spec = importlib.util.spec_from_file_location("cph_terrain_tool", ROOT / "tools/cph-geodata/terrain.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_basins(lakes: dict, raw_grid, tt) -> list[dict]:
    from shapely.geometry import Polygon  # noqa: PLC0415
    from shapely.ops import unary_union  # noqa: PLC0415

    def poly(ring, holes=()):
        pts = lambda r: [(r[i], r[i + 1]) for i in range(0, len(r), 2)]  # noqa: E731
        return Polygon(pts(ring), [pts(h) for h in holes if len(h) >= 6]).buffer(0)

    strips = [poly(b["ring"]).buffer(STRIP_BUFFER_M) for b in lakes.get("bridges", [])]
    strip_union = unary_union(strips) if strips else None
    out = []
    for lake in lakes["lakes"]:
        p = poly(lake["ring"], lake.get("holes", []))
        parts = [p]
        if strip_union is not None and p.intersects(strip_union):
            diff = p.difference(strip_union)
            parts = [g for g in getattr(diff, "geoms", [diff]) if g.geom_type == "Polygon" and g.area >= MIN_BASIN_M2]
        for k, g in enumerate(sorted(parts, key=lambda q: -q.area)):
            level = round(tt.region_median(raw_grid, g, tt.HALF, tt.CELL), 2)
            rec = {"id": f"{lake['id']}/{k}", "lake": lake["id"], "level": level, "area_m2": round(g.area, 1), "ring": tt._flat(g.exterior.coords)}
            holes = [tt._flat(h.coords) for h in g.interiors if Polygon(h).area >= 5]
            if holes:
                rec["holes"] = holes
            out.append(rec)
    return out


def main() -> int:
    tt = _terrain()
    path = ROOT / "data/cph-lakes.json"
    lakes = json.loads(path.read_text())
    arr, t = tt.load_dtm(ROOT / "data/raw/dhm")
    raw = tt.resample(arr, t)
    lakes["basins"] = build_basins(lakes, raw, tt)
    path.write_text(json.dumps(lakes, separators=(",", ":"), ensure_ascii=False))
    print({b["id"]: (b["level"], b["area_m2"]) for b in lakes["basins"]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
