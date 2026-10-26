# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "numpy", "rasterio", "scipy"]
# ///
"""Ground vegetation for the Copenhagen twin -> data/cph-vegetation.json: lawns and planting measured from the colour-infrared
orthophoto (NDVI) and the DHM point cloud (heights).

Sources: GeoDanmark CIR orthophoto as a 1 m NDVI raster (tools/cph-geodata/vegetation_cir.py) and the DHM Punktsky class
counts at 1 m (tools/cph-geodata/vegetation_rasters.py), both under data/raw/veg/. Neither alone is enough: a mown lawn is
classed `2 ground` like asphalt in the point cloud (its `3/4 low/medium vegetation` classes mark only what stands above the
grass), and LiDAR intensity proved unreliable (flight strips differ), while NDVI cannot tell a tree from a lawn. Together:

  * green      NDVI above a threshold calibrated on known hard ground (KK pavements, carriageways): its 97th percentile.
  * lawn       green, no high vegetation (class 5) above it, no class 3/4 returns (nothing stands on it).
  * planting   green with class 3/4 returns >= PLANTING_MIN per m2 (beds, shrubs, hedges).
  * parkfloor  the ground under tree crowns inside the KK park register polygons, which no image sees: lawn, inferred.
  * all cleaned (open/close, small blobs and pinholes removed), cut by building footprints, KK pavements and the lakes, and
    written as polygons (`cls: "grass"`, `kind`) in the surfaces-register shape so the engine can append them to the
    `surfaces` of cph-surfaces.json. `canopy` (class 5 footprint) is written for the audit only.

    python3 tools/cph-geodata/vegetation_rasters.py   # once, needs pdal
    uv run tools/cph-geodata/vegetation_cir.py        # once, needs the Dataforsyningen token
    uv run tools/cph-geodata/vegetation.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frame import LOCAL_BBOX, ORIGIN, flat, ring_to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "veg"
OUT = ROOT / "data" / "cph-vegetation.json"
HARD_CLASSES = ("asphalt_road", "kbh_fortov", "raadhus", "cobbles", "setts")
NDVI_MIN = 0.04  # floor of the vegetation threshold (the CIR image is not radiometrically calibrated)
SMOOTH = 3  # cells: window of the NDVI average
PLANTING_MIN = 4  # class 3/4 returns per cell
MIN_AREA = 6.0  # m2
MIN_HOLE = 4.0
SIMPLIFY = 0.25
UPSAMPLE = 3


def read(name, tid):
    import rasterio  # noqa: PLC0415

    with rasterio.open(RAW / f"{name}_{tid}.tif") as s:
        return s.read(1), s.transform


def box_mean(a, k):
    from scipy import ndimage  # noqa: PLC0415

    return ndimage.uniform_filter(a.astype("float64"), k, mode="constant")


def mosaic_classes(tids, e0, n1, shape):
    """Per-class count rasters of every tile -> one grid (1 m cells, top-left corner at e0 / n1)."""
    out = {k: np.zeros(shape, "float32") for k in (2, 3, 4, 5, 6, 9, 17)}
    for tid in tids:
        for k in out:
            a, t = read(f"c{k}", tid)
            r0, c0 = int(round(n1 - t.f)), int(round(t.c - e0))
            h, w = a.shape
            out[k][r0:r0 + h, c0:c0 + w] += a
    return out


def classify(c, ndvi, hard, in_park):
    """Boolean masks lawn / planting / canopy / parkfloor on the common grid."""
    from scipy import ndimage  # noqa: PLC0415

    solid = (c[6] > c[2]) | (c[9] > 0) | (c[17] > 0)  # roofs, water and bridge decks
    canopy = (c[5] >= 2) & (c[6] == 0)
    v = np.where(np.isfinite(ndvi), ndvi, -1.0)
    smooth = ndimage.uniform_filter(v, SMOOTH)
    hard_vals = smooth[hard & ~canopy & ~solid]
    thr = max(float(np.percentile(hard_vals, 97)), NDVI_MIN) if hard_vals.size > 1000 else NDVI_MIN
    green = (smooth > thr) & ~solid
    low = (c[3] + c[4]) >= PLANTING_MIN
    st = np.ones((3, 3), bool)
    lawn = green & ~canopy & ~low
    planting = green & ~canopy & low
    # the ground under the crowns of a park cannot be seen from the air or by NDVI: inside the KK park polygons it is lawn
    parkfloor = canopy & in_park & ~solid & ~lawn
    out = {}
    for name, m in (("lawn", lawn), ("planting", planting), ("canopy", canopy), ("parkfloor", parkfloor)):
        m = ndimage.binary_opening(m, st) if name != "canopy" else m
        out[name] = ndimage.binary_closing(m, st)
    return out, thr


def vectorise(mask, transform, kind):
    """Boolean 1 m raster -> shapely polygons (UTM). The mask is blurred and cut at 0.5 on a 3x finer grid, so the edges
    follow the data instead of the 1 m staircase."""
    from affine import Affine  # noqa: PLC0415
    from rasterio import features  # noqa: PLC0415
    from scipy import ndimage  # noqa: PLC0415
    from shapely.geometry import shape  # noqa: PLC0415

    fine = ndimage.zoom(ndimage.gaussian_filter(mask.astype("float32"), 0.7), UPSAMPLE, order=1) > 0.5
    t = transform * Affine.scale(1.0 / UPSAMPLE)
    return [shape(g) for g, v in features.shapes(fine.astype("uint8"), mask=fine, transform=t, connectivity=8) if v]


def main():
    import rasterio  # noqa: PLC0415
    from rasterio.features import geometry_mask  # noqa: PLC0415
    from rasterio.transform import from_origin  # noqa: PLC0415
    from shapely.geometry import LineString, MultiPolygon, Polygon  # noqa: PLC0415
    from shapely.ops import unary_union  # noqa: PLC0415

    sys.path.insert(0, str(ROOT / "tools" / "lod2"))
    import common  # noqa: PLC0415

    geo = json.loads((ROOT / "data" / "cph-geodata.json").read_text())
    surf = json.loads((ROOT / "data" / "cph-surfaces.json").read_text())
    lakes = json.loads((ROOT / "data" / "cph-lakes.json").read_text())

    def utm_poly(ring, holes=()):
        pts = lambda r: [(ORIGIN[0] + r[i], ORIGIN[1] - r[i + 1]) for i in range(0, len(r), 2)]  # noqa: E731
        return Polygon(pts(ring), [pts(h) for h in holes if len(h) >= 6]).buffer(0)

    hard_polys = [utm_poly(s["ring"]) for s in geo["sidewalks"]] + [utm_poly(s["ring"], s.get("holes", [])) for s in surf["surfaces"] if s["cls"] == "asphalt_road"]
    for r in geo["roads"]:
        if r["class"] in ("primary", "secondary") and len(r["pts"]) >= 4:
            hard_polys.append(LineString([(ORIGIN[0] + r["pts"][i], ORIGIN[1] - r["pts"][i + 1]) for i in range(0, len(r["pts"]), 2)]).buffer(min(r.get("width") or 8, 14) / 2 * 0.5))
    hard = unary_union([p for p in hard_polys if not p.is_empty])
    parks = unary_union([utm_poly(p["ring"], p.get("holes", [])) for p in geo["parks"] if ".161" not in p["id"]])
    cut = unary_union([utm_poly(b["ring"], b.get("holes", [])).buffer(0.4) for b in geo["buildings"]]
                      + [utm_poly(s["ring"]) for s in geo["sidewalks"]]
                      + [utm_poly(s["ring"], s.get("holes", [])) for s in surf["surfaces"] if s["cls"] in HARD_CLASSES]  # gravel and "other" are left to the NDVI
                      + [utm_poly(l["ring"]).buffer(0.3) for l in lakes["lakes"]])

    # the common 1 m grid: district + 20 m, whole metres (the NDVI raster and the class rasters share it)
    e0, n0, e1, n1 = (int(v) for v in (common.DISTRICT_BBOX[0] - 20, common.DISTRICT_BBOX[1] - 20, common.DISTRICT_BBOX[2] + 20, common.DISTRICT_BBOX[3] + 20))
    shape = (n1 - n0, e1 - e0)
    T = from_origin(e0, n1, 1.0, 1.0)
    c = mosaic_classes(common.tiles_for_bbox(common.DISTRICT_BBOX, 20.0), e0, n1, shape)
    with rasterio.open(RAW / "ndvi.tif") as s:
        ndvi = np.full(shape, np.nan, "float32")
        a, t = s.read(1), s.transform
        r0, c0 = int(round(n1 - t.f)), int(round(t.c - e0))
        ndvi[r0:r0 + a.shape[0], c0:c0 + a.shape[1]] = a
    masks, thr = classify(c, ndvi, geometry_mask([hard], shape, T, invert=True), geometry_mask([parks], shape, T, invert=True))
    print(f"NDVI threshold {thr:.3f}", file=sys.stderr)

    district = Polygon([(ORIGIN[0] + LOCAL_BBOX[0], ORIGIN[1] - LOCAL_BBOX[3]), (ORIGIN[0] + LOCAL_BBOX[2], ORIGIN[1] - LOCAL_BBOX[3]),
                        (ORIGIN[0] + LOCAL_BBOX[2], ORIGIN[1] - LOCAL_BBOX[1]), (ORIGIN[0] + LOCAL_BBOX[0], ORIGIN[1] - LOCAL_BBOX[1])])

    def records(kind, geoms, subtract=None):
        out = []
        for g in geoms:
            g = g.simplify(SIMPLIFY).buffer(0)
            if subtract is not None:
                g = g.difference(subtract)
            g = g.intersection(district)
            for p in (g.geoms if isinstance(g, MultiPolygon) or hasattr(g, "geoms") else [g]):
                if p.geom_type != "Polygon" or p.area < MIN_AREA:
                    continue
                holes = [h for h in p.interiors if Polygon(h).area >= MIN_HOLE]
                rec = {"id": f"dhm:{kind}:{len(out)}", "kind": kind, "area_m2": round(p.area, 1),
                       "ring": flat(ring_to_local(list(p.exterior.coords)))}
                if holes:
                    rec["holes"] = [flat(ring_to_local(list(h.coords))) for h in holes]
                out.append(rec)
        return out

    grass = []
    for kind, src, conf in (("lawn", "cir:ndvi+dhm:class5", "measured"), ("planting", "cir:ndvi+dhm:class3-4", "measured"), ("parkfloor", "kk:parkregister+dhm:class5", "inferred")):
        recs = records(kind, vectorise(masks[kind], T, kind), cut)
        for r in recs:
            r.update(cls="grass", src=[src], conf=conf)
        grass += recs
    canopy = records("canopy", vectorise(masks["canopy"], T, "canopy"))
    for g in canopy:
        g.update(src=["dhm:punktsky:class5"], conf="measured")

    area = lambda recs, k: round(sum(g["area_m2"] for g in recs if g["kind"] == k))  # noqa: E731
    stats = {"lawn_m2": area(grass, "lawn"), "planting_m2": area(grass, "planting"), "parkfloor_m2": area(grass, "parkfloor"),
             "canopy_m2": round(sum(g["area_m2"] for g in canopy)), "polygons": len(grass), "ndvi_threshold": round(thr, 3)}
    doc = {
        "version": "cph-vegetation/1",
        "frame": {"epsg": 25832, "origin": list(ORIGIN), "axes": "x=east, z=south, y=up", "bbox": list(LOCAL_BBOX)},
        "attribution": ["Indeholder data fra Klimadatastyrelsen (DHM Punktsky)", "GeoDanmark ortofoto (Styrelsen for Dataforsyning og Infrastruktur)"],
        "method": f"NDVI of the CIR orthophoto > hard-ground p97 (>= {NDVI_MIN}); lawn / planting split by DHM class 3/4 returns (>= {PLANTING_MIN}/m2); "
                  f"crown floor inside KK parks; {SMOOTH}x{SMOOTH} mean, open/close, min {MIN_AREA:.0f} m2, cut by buildings, KK pavements and lakes",
        "stats": stats,
        "surfaces": grass,
        "canopy": canopy,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)", stats)


if __name__ == "__main__":
    main()
