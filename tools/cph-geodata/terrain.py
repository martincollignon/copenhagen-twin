# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "numpy", "rasterio"]
# ///
"""Terrain compiler for the Copenhagen twin -> data/cph-terrain.json: ONE ground height field for the whole scene.

Source: the DHM/Terrain (DTM) tiles that tools/cph-geodata/dhm.py caches under data/raw/ (dhm_dtm_*.tif, 1 m, DVR90).
Everything else (buildings, roads, pavements, lakes, furniture, cars, pedestrians) takes its ground height from this one
grid (js/terrain-cph.js) and only adds its own layer offset (kerb steps, pavement 0.2 m, ...).

  * the DTM is averaged to a CELL x CELL m grid over the district plus a margin; heights are local y (DVR90 - origin)
    stored as int16 centimetres, little-endian, base64 in the JSON;
  * the DTM under buildings is interpolated by the survey and often dips (pits 1-4 m deep under blocks); cells inside a
    footprint (+ MASK_BUFFER_M) are re-filled from the surrounding ground so neighbouring buildings share one ground;
  * lake interiors are left alone: the DTM there IS the water level (flat), which is the measured `level` per lake;
  * bridge decks are measured too (`deck`: median terrain inside the bridge strip).

    uv run tools/cph-geodata/terrain.py
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
ORIGIN = (723900.0, 6176500.0, 6.84)
CELL = 2.0
MESH_CELL = 4.0  # ground mesh cell (m); the lake cut pieces refer to this grid over [-MESH_HALF, MESH_HALF]
MESH_HALF = 750.0
FRAME_HALF = 4000.0  # the ground reaches to the horizon: a frame polygon from the district edge out to here
FAR = 2400.0  # lakes that touch the district edge continue to here (js/lakes-cph.js WATER.far)
HALF = 770.0  # grid covers [-HALF, HALF] in x and z (district +-750 plus a margin)
MASK_BUFFER_M = 0.6
STREET_SIGMA_M = 5.0  # the DTM resolves kerbs, cars and kerb ramps; in the street zone it is low-passed with this sigma
STREET_HALF_WIDTH = {"primary": 9.0, "secondary": 8.0, "residential": 6.5, "service": 4.0, "cycleway": 2.5, "footway": 2.0}
PAVED_CLASSES = {"kbh_fortov", "raadhus", "cobbles", "setts", "gravel"}
FILL_ITERATIONS = 400


def load_dtm(raw: Path = RAW):
    """Merged 1 m DTM -> (array, affine). Heights are DVR90 metres."""
    import rasterio  # noqa: PLC0415
    from rasterio.merge import merge  # noqa: PLC0415

    srcs = [rasterio.open(p) for p in sorted(raw.glob("dhm_dtm_*.tif"))]
    if not srcs:
        raise SystemExit("no data/raw/dhm_dtm_*.tif: run tools/cph-geodata/build.py with a DHM token first")
    arr, t = merge(srcs)
    return arr[0].astype("float64"), t


def resample(arr, t, half=HALF, cell=CELL, origin=ORIGIN):
    """Mean of the source pixels per grid cell (north-up raster, 1 m pixels aligned with the grid), local y (origin height
    subtracted). Cell (i, j) covers x in [-half + i cell, ...) and z in [-half + j cell, ...); z is south."""
    n = int(round(2 * half / cell))
    sub = int(round(cell / abs(t.a)))
    c0 = int(round((origin[0] - half - t.c) / t.a))
    r_top = int(round((t.f - (origin[1] + half)) / -t.e))  # row of the northernmost cell edge
    need_r, need_c = n * sub, n * sub
    if r_top < 0 or c0 < 0 or r_top + need_r > arr.shape[0] or c0 + need_c > arr.shape[1]:
        raise SystemExit(f"DTM does not cover the grid: need rows {r_top}..{r_top + need_r}, cols {c0}..{c0 + need_c}, have {arr.shape}")
    blk = arr[r_top:r_top + need_r, c0:c0 + need_c].reshape(n, sub, n, sub)
    return blk.mean(axis=(1, 3)) - origin[2]


def ring_mask(rings, half=HALF, cell=CELL, buffer=MASK_BUFFER_M):
    """Boolean grid: cells whose centre lies inside any flat ring (x, z) grown by `buffer` metres."""
    from shapely import contains_xy  # noqa: PLC0415
    from shapely.geometry import Polygon  # noqa: PLC0415
    from shapely.strtree import STRtree  # noqa: PLC0415

    n = int(round(2 * half / cell))
    mask = np.zeros((n, n), dtype=bool)
    polys = []
    for r in rings:
        if len(r) >= 6:
            p = Polygon([(r[i], r[i + 1]) for i in range(0, len(r), 2)])
            p = p.buffer(0).buffer(buffer) if buffer else p.buffer(0)
            if not p.is_empty:
                polys.append(p)
    tree = STRtree(polys)
    for k, p in enumerate(polys):
        x0, z0, x1, z1 = p.bounds
        i0 = max(0, int((x0 + half) // cell))
        i1 = min(n - 1, int((x1 + half) // cell))
        j0 = max(0, int((z0 + half) // cell))
        j1 = min(n - 1, int((z1 + half) // cell))
        if i1 < i0 or j1 < j0:
            continue
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        xs = -half + (ii + 0.5) * cell
        zs = -half + (jj + 0.5) * cell
        mask[jj, ii] |= contains_xy(p, xs, zs)
    del tree
    return mask


def _neighbours(a):
    """Sum of the four neighbours, replicating the edge (no wrap-around)."""
    p = np.pad(a, 1, mode="edge")
    return p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]


def fill_masked(grid, mask, iterations=FILL_ITERATIONS):
    """Replace masked cells by a smooth interpolation of the unmasked ones (nearest-value seed, then Jacobi relaxation
    of the Laplace equation inside the mask only)."""
    g = grid.copy()
    if not mask.any():
        return g
    known = ~mask & np.isfinite(g)
    # seed: grow the known values into the mask one ring per pass
    seeded = known.copy()
    g[~known] = 0.0
    for _ in range(max(grid.shape)):
        if seeded.all():
            break
        ssum = _neighbours(np.where(seeded, g, 0.0))
        csum = _neighbours(seeded.astype(float))
        grow = (~seeded) & (csum > 0)
        if not grow.any():
            break
        g[grow] = ssum[grow] / csum[grow]
        seeded |= grow
    free = mask | ~known
    for _ in range(iterations):
        g = np.where(free, _neighbours(g) / 4.0, g)
    return g


def _gauss(a, sigma_cells):
    """Separable Gaussian blur with edge replication."""
    r = max(1, int(np.ceil(3 * sigma_cells)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_cells) ** 2)
    k /= k.sum()
    out = np.pad(a, r, mode="edge")
    out = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, out)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, out)


def street_zone(geo, surfaces, lakes, half=HALF, cell=CELL):
    """Cells that belong to the street space: pavements, paved squares and the corridor of every carriageway / path,
    without building footprints and water."""
    from shapely.geometry import LineString  # noqa: PLC0415
    from shapely.ops import unary_union  # noqa: PLC0415

    rings = [sd["ring"] for sd in geo.get("sidewalks", []) if len(sd.get("ring", [])) >= 6]
    rings += [sf["ring"] for sf in (surfaces or {}).get("surfaces", []) if sf.get("cls") in PAVED_CLASSES and len(sf.get("ring", [])) >= 6]
    zone = ring_mask(rings, half, cell, buffer=0.0)
    corridors = []
    for r in geo.get("roads", []):
        w = STREET_HALF_WIDTH.get(r.get("class"))
        if w and r.get("pts") and len(r["pts"]) >= 4:
            corridors.append(LineString([(r["pts"][i], r["pts"][i + 1]) for i in range(0, len(r["pts"]), 2)]).buffer(w))
    if corridors:
        flat = []
        for g in unary_union(corridors).geoms if hasattr(unary_union(corridors), "geoms") else [unary_union(corridors)]:
            flat.append([c for xy in g.exterior.coords for c in xy])
        zone |= ring_mask(flat, half, cell, buffer=0.0)
    zone &= ~ring_mask([b["ring"] for b in geo.get("buildings", [])], half, cell, buffer=0.5)
    water = _water(lakes) if lakes else None
    if water is not None and not water.is_empty:
        wr = [[c for xy in g.exterior.coords for c in xy] for g in getattr(water.buffer(1.0), "geoms", [water.buffer(1.0)])]
        zone &= ~ring_mask(wr, half, cell, buffer=0.0)
    return zone


def smooth_streets(grid, zone, sigma_m=STREET_SIGMA_M, cell=CELL):
    """Low-pass the terrain inside the street zone only (weights = zone, so parks, courtyards and water do not bleed
    into it), feathered back to the raw terrain over about one sigma outside it."""
    if not zone.any():
        return grid
    sig = sigma_m / cell
    w = zone.astype(float)
    num = _gauss(grid * w, sig)
    den = _gauss(w, sig)
    smooth = np.where(den > 1e-6, num / np.maximum(den, 1e-6), grid)
    alpha = np.clip(_gauss(w, sig * 0.6) * 1.0, 0.0, 1.0)
    alpha = np.where(zone, np.maximum(alpha, 0.85), alpha * (den > 0.05))
    return alpha * smooth + (1 - alpha) * grid


def sample(grid, x, z, half=HALF, cell=CELL):
    """Bilinear height at local (x, z), clamped at the grid edge (the same rule as js/terrain-cph.js)."""
    n = grid.shape[0]
    fx = np.clip((np.asarray(x, dtype=float) + half) / cell - 0.5, 0, n - 1.000001)
    fz = np.clip((np.asarray(z, dtype=float) + half) / cell - 0.5, 0, n - 1.000001)
    i = np.floor(fx).astype(int)
    j = np.floor(fz).astype(int)
    tx = fx - i
    tz = fz - j
    top = grid[j, i] * (1 - tx) + grid[j, i + 1] * tx
    bot = grid[j + 1, i] * (1 - tx) + grid[j + 1, i + 1] * tx
    return top * (1 - tz) + bot * tz


def _poly(ring):
    from shapely.geometry import Polygon  # noqa: PLC0415

    return Polygon([(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]).buffer(0)


def region_median(grid, poly, half=HALF, cell=CELL):
    from shapely import contains_xy  # noqa: PLC0415

    x0, z0, x1, z1 = poly.bounds
    xs = np.arange(x0, x1 + cell, cell / 2)
    zs = np.arange(z0, z1 + cell, cell / 2)
    xx, zz = np.meshgrid(xs, zs)
    m = contains_xy(poly, xx, zz)
    if not m.any():
        c = poly.representative_point()
        return float(sample(grid, c.x, c.y, half, cell))
    return float(np.median(sample(grid, xx[m], zz[m], half, cell)))


def _flat(coords):
    pts = list(coords)[:-1]
    out = []
    for x, z in pts:
        out += [round(x, 2), round(z, 2)]
    return out


def _water(lakes):
    from shapely.ops import unary_union  # noqa: PLC0415

    polys = []
    for lk in lakes.get("lakes", []):
        p = _poly(lk["ring"])
        for h in lk.get("holes", []):
            p = p.difference(_poly(h))
        polys.append(p)
    return unary_union(polys) if polys else None


def lake_cut(lakes, cell=MESH_CELL, half=MESH_HALF):
    """The ground mesh grid cells the lakes touch. `skip`: cell indices (j * n + i) fully inside water (not drawn);
    `pieces`: [i, j, flat ring] polygons of a cell outside the water (earcut at runtime). Cells are
    [-half + i cell, -half + (i + 1) cell] in x and likewise z."""
    import shapely  # noqa: PLC0415
    from shapely.geometry import MultiPolygon, Polygon  # noqa: PLC0415

    n = int(round(2 * half / cell))
    W = _water(lakes)
    if W is None or W.is_empty:
        return {"cell": cell, "half": half, "skip": [], "pieces": []}
    x0, z0, x1, z1 = W.bounds
    i0 = max(0, int((x0 + half) // cell))
    i1 = min(n - 1, int((x1 + half) // cell))
    j0 = max(0, int((z0 + half) // cell))
    j1 = min(n - 1, int((z1 + half) // cell))
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
    ii, jj = ii.ravel(), jj.ravel()
    boxes = shapely.box(-half + ii * cell, -half + jj * cell, -half + (ii + 1) * cell, -half + (jj + 1) * cell)
    shapely.prepare(W)
    touch = shapely.intersects(W, boxes)
    skip, pieces = [], []
    for i, j, b in zip(ii[touch], jj[touch], boxes[touch]):
        rest = b.difference(W)
        if rest.is_empty or rest.area < 0.02:
            skip.append(int(j * n + i))
            continue
        geoms = list(rest.geoms) if isinstance(rest, MultiPolygon) or rest.geom_type == "GeometryCollection" else [rest]
        for g in geoms:
            if isinstance(g, Polygon) and g.area >= 0.02:
                ring = g.exterior
                if not ring.is_ccw:
                    ring = shapely.geometry.LinearRing(list(ring.coords)[::-1])
                pieces.append([int(i), int(j), _flat(ring.coords)])
    return {"cell": cell, "half": half, "skip": skip, "pieces": pieces}


def frame_polygon(lakes, half=MESH_HALF, outer=FRAME_HALF, far=FAR):
    """Ground outside the district: the square +-outer minus the district square minus the part of each lake that
    continues beyond the district edge (js/lakes-cph.js extendBeyondBbox). Returns [{ring, holes}] (flat rings)."""
    from shapely.geometry import LineString, Polygon, box  # noqa: PLC0415
    from shapely.ops import unary_union  # noqa: PLC0415

    inner = box(-half, -half, half, half)
    W = _water(lakes)
    outs = []
    if W is not None and not W.is_empty:
        edge = inner.boundary
        for g in getattr(W, "geoms", [W]):
            if g.area < 20000:  # small ponds cut by the edge just end there
                continue
            run = g.exterior.intersection(edge)
            for seg in getattr(run, "geoms", [run]):
                if not isinstance(seg, LineString) or seg.length < 1:
                    continue
                a, b = seg.coords[0], seg.coords[-1]

                def push(p):
                    x, z = p
                    x = -far if x <= -half + 0.01 else far if x >= half - 0.01 else x
                    z = -far if z <= -half + 0.01 else far if z >= half - 0.01 else z
                    return (x, z)

                outs.append(Polygon([a, b, push(b), push(a)]).buffer(0))
    hole = unary_union([inner] + outs)
    frame = box(-outer, -outer, outer, outer).difference(hole)
    res = []
    for g in getattr(frame, "geoms", [frame]):
        if g.geom_type != "Polygon":
            continue
        res.append({"ring": _flat(g.exterior.coords), "holes": [_flat(h.coords) for h in g.interiors]})
    return res


def building_ground(buildings, grid, half=HALF, cell=CELL, step=3.0):
    """Ground height of every footprint: the median terrain along its outline (the street side of the plinth), so
    buildings that touch share nearly the same ground. {id: metres}."""
    out = {}
    for b in buildings:
        r = b["ring"]
        n = len(r) // 2
        xs, zs = [], []
        for i in range(n):
            j = (i + 1) % n
            ax, az, bx, bz = r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]
            k = max(1, int(np.hypot(bx - ax, bz - az) // step))
            for t in np.arange(k) / k:
                xs.append(ax + (bx - ax) * t)
                zs.append(az + (bz - az) * t)
        out[b["id"]] = round(float(np.median(sample(grid, np.array(xs), np.array(zs), half, cell))), 2)
    return out


def build_doc(raw_grid, geo, lakes, half=HALF, cell=CELL, surfaces=None):
    """Terrain document from the raw averaged DTM grid, the geodata (buildings) and the lake document."""
    mask = ring_mask([b["ring"] for b in geo.get("buildings", [])], half, cell)
    grid = fill_masked(raw_grid, mask)
    grid = smooth_streets(grid, street_zone(geo, surfaces, lakes, half, cell), cell=cell)
    levels = []
    for lk in lakes.get("lakes", []):
        p = _poly(lk["ring"])
        levels.append({"id": lk["id"], "level": round(region_median(raw_grid, p, half, cell), 2)})
    ponds = [{"id": pd["id"], "level": round(region_median(raw_grid, _poly(pd["ring"]), half, cell), 2)} for pd in lakes.get("ponds", [])]
    decks = [{"id": b["id"], "deck": round(region_median(grid, _poly(b["ring"]), half, cell), 2)} for b in lakes.get("bridges", [])]
    cm = np.clip(np.round(grid * 100.0), -32768, 32767).astype("<i2")
    return {
        "version": "cph-terrain/1",
        "frame": {"epsg": 25832, "vertical": "DVR90", "origin": list(ORIGIN), "axes": "x=east, z=south, y=up"},
        "method": f"DHM/Terrain {cell:g} m mean, building footprints (+{MASK_BUFFER_M} m) re-filled from surrounding ground; int16 cm, row = z, col = x",
        "bbox": [-half, -half, half, half],
        "cell": cell,
        "width": int(grid.shape[1]),
        "height": int(grid.shape[0]),
        "min": round(float(grid.min()), 2),
        "max": round(float(grid.max()), 2),
        "lakes": levels,
        "ponds": ponds,
        "bridges": decks,
        "buildings": building_ground(geo.get("buildings", []), grid, half, cell),
        "cut": lake_cut(lakes),
        "frame": frame_polygon(lakes),
        "data": base64.b64encode(cm.tobytes()).decode("ascii"),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "cph-terrain.json"))
    ap.add_argument("--geodata", default=str(ROOT / "data" / "cph-geodata.json"))
    ap.add_argument("--lakes", default=str(ROOT / "data" / "cph-lakes.json"))
    ap.add_argument("--surfaces", default=str(ROOT / "data" / "cph-surfaces.json"))
    a = ap.parse_args(argv)
    arr, t = load_dtm()
    raw = resample(arr, t)
    geo = json.loads(Path(a.geodata).read_text())
    lakes = json.loads(Path(a.lakes).read_text())
    surfaces = json.loads(Path(a.surfaces).read_text()) if Path(a.surfaces).exists() else None
    doc = build_doc(raw, geo, lakes, surfaces=surfaces)
    Path(a.out).write_text(json.dumps(doc, separators=(",", ":")))
    print(f"[terrain] {doc['width']}x{doc['height']} cells, y {doc['min']}..{doc['max']} m, lakes {doc['lakes']}, ponds {doc['ponds']}, bridges {doc['bridges']}", file=sys.stderr)


if __name__ == "__main__":
    main()
