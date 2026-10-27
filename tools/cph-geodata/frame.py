"""The ONE frame module: origin, district bbox, tile grid, local transform and ring helpers (pure, no I/O).

Everything that needs the origin, the district bbox or a tile id imports it from here (tools/lod2/common.py,
fetch.py, lakes.py, ortho.py, roads.py, points.py ...). The JS mirror is js/tile-grid.js; keep the two in step.

Tile grid: a fixed 500 m grid in EPSG:25832. Tile id "<e500>_<n500>" = (floor(E / 500), floor(N / 500)), so four
tiles fill one 1 km DHM / LoD2 cell (e.g. LoD2 cell 6176_723 = tiles 1446_12352, 1447_12352, 1446_12353, 1447_12353).
"""
from __future__ import annotations

import math

ORIGIN = (723900.0, 6176500.0, 6.84)  # E, N (EPSG:25832), DVR90 height
LOCAL_BBOX = (-750.0, -750.0, 750.0, 750.0)  # xmin, zmin, xmax, zmax

TILE_SIZE = 500.0  # metres
FETCH_MARGIN = 60.0  # metres beyond an area so edge geometry is complete

# District bbox in EPSG:25832: (minE, minN, maxE, maxN)
DISTRICT_UTM_BBOX = (ORIGIN[0] + LOCAL_BBOX[0], ORIGIN[1] - LOCAL_BBOX[3], ORIGIN[0] + LOCAL_BBOX[2], ORIGIN[1] - LOCAL_BBOX[1])


def to_local(e: float, n: float) -> tuple[float, float]:
    """EPSG:25832 (E, N) -> local (x east, z south)."""
    return e - ORIGIN[0], -(n - ORIGIN[1])


def to_local_y(h: float) -> float:
    return h - ORIGIN[2]


def to_utm(x: float, z: float) -> tuple[float, float]:
    return x + ORIGIN[0], ORIGIN[1] - z


def signed_area(pts: list[tuple[float, float]]) -> float:
    """Shoelace area in the (x, -z) plane, i.e. the north-up map plane seen from
    above. Positive means counter-clockwise from above."""
    a = 0.0
    n = len(pts)
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        a += x0 * (-z1) - x1 * (-z0)
    return a / 2.0


def orient_ccw(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return pts if signed_area(pts) > 0 else pts[::-1]


def open_ring(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if len(pts) > 1 and pts[0] == pts[-1]:
        return pts[:-1]
    return pts


def flat(pts, nd: int = 2) -> list[float]:
    out: list[float] = []
    for x, z in pts:
        out.append(round(x, nd) + 0.0)
        out.append(round(z, nd) + 0.0)
    return out


def ring_to_local(utm_ring) -> list[tuple[float, float]]:
    """UTM ring (closed or not) -> open, CCW local ring."""
    pts = [to_local(p[0], p[1]) for p in utm_ring]
    return orient_ccw(open_ring(pts))


# ------------------------------------------------------------------------------------------------------- tile grid

def local_bbox_to_utm(bbox) -> tuple[float, float, float, float]:
    """Local (xmin, zmin, xmax, zmax) -> UTM (minE, minN, maxE, maxN)."""
    x0, z0, x1, z1 = bbox
    return (ORIGIN[0] + x0, ORIGIN[1] - z1, ORIGIN[0] + x1, ORIGIN[1] - z0)


def utm_bbox_to_local(bbox) -> tuple[float, float, float, float]:
    """UTM (minE, minN, maxE, maxN) -> local (xmin, zmin, xmax, zmax)."""
    e0, n0, e1, n1 = bbox
    return (e0 - ORIGIN[0], ORIGIN[1] - n1, e1 - ORIGIN[0], ORIGIN[1] - n0)


def tile_id(ie: int, in_: int) -> str:
    return f"{ie}_{in_}"


def parse_tile_id(tid: str) -> tuple[int, int]:
    ie, in_ = tid.split("_")
    return int(ie), int(in_)


def tile_of_point(e: float, n: float) -> str:
    """Tile id of a UTM point (E, N)."""
    return tile_id(math.floor(e / TILE_SIZE), math.floor(n / TILE_SIZE))


def tile_of_local(x: float, z: float) -> str:
    return tile_of_point(*to_utm(x, z))


def tile_bounds_utm(tid: str) -> tuple[float, float, float, float]:
    """(minE, minN, maxE, maxN) of a tile."""
    ie, in_ = parse_tile_id(tid)
    return (ie * TILE_SIZE, in_ * TILE_SIZE, (ie + 1) * TILE_SIZE, (in_ + 1) * TILE_SIZE)


def tile_bounds_local(tid: str) -> tuple[float, float, float, float]:
    """(xmin, zmin, xmax, zmax) of a tile in the local frame (x east, z south)."""
    return utm_bbox_to_local(tile_bounds_utm(tid))


def tiles_for_bbox(bbox, margin: float = 0.0) -> list[str]:
    """Sorted ids of the tiles a UTM bbox (minE, minN, maxE, maxN), grown by margin, touches. Tiles that only share an
    edge with the bbox are not included."""
    e0, n0, e1, n1 = bbox
    e0, n0, e1, n1 = e0 - margin, n0 - margin, e1 + margin, n1 + margin
    out = []
    for ie in range(math.floor(e0 / TILE_SIZE), math.ceil(e1 / TILE_SIZE)):
        for in_ in range(math.floor(n0 / TILE_SIZE), math.ceil(n1 / TILE_SIZE)):
            out.append(tile_id(ie, in_))
    return sorted(out)


def lod2_cell_of_tile(tid: str) -> str:
    """The 1 km DHM / LoD2 cell '<N km>_<E km>' (e.g. 6176_723) that holds a tile."""
    ie, in_ = parse_tile_id(tid)
    return f"{in_ // 2}_{ie // 2}"


# ---------------------------------------------------------------------------------------------- area CLI override

def add_area_args(ap) -> None:
    """--bbox MINE MINN MAXE MAXN (EPSG:25832) and --tile <e500>_<n500> (repeatable): build any area, not just the district."""
    g = ap.add_argument_group("area (default: the district)")
    g.add_argument("--bbox", nargs=4, type=float, metavar=("MINE", "MINN", "MAXE", "MAXN"), default=None,
                   help="area in EPSG:25832 metres")
    g.add_argument("--tile", action="append", default=None, metavar="E500_N500",
                   help="a 500 m tile id like 1447_12353 (repeatable; the area is their union)")


_AREA_UTM = DISTRICT_UTM_BBOX


def set_area(bbox_utm) -> None:
    """Make every compiler step that asks frame.area_utm() / area_local() work on this UTM bbox (default: the district)."""
    global _AREA_UTM
    _AREA_UTM = tuple(float(v) for v in bbox_utm)


def area_utm() -> tuple[float, float, float, float]:
    return _AREA_UTM


def area_local() -> tuple[float, float, float, float]:
    return utm_bbox_to_local(_AREA_UTM)


def is_district() -> bool:
    return _AREA_UTM == DISTRICT_UTM_BBOX


def apply_area_args(args) -> tuple[float, float, float, float]:
    """area_from_args() + set_area(); returns the UTM bbox."""
    bbox = area_from_args(args)
    set_area(bbox)
    return bbox


def area_from_args(args) -> tuple[float, float, float, float]:
    """UTM bbox (minE, minN, maxE, maxN) chosen by add_area_args(); the district when neither flag was given."""
    tiles = getattr(args, "tile", None)
    bbox = getattr(args, "bbox", None)
    if tiles and bbox:
        raise SystemExit("give --bbox or --tile, not both")
    if tiles:
        bs = [tile_bounds_utm(t) for t in tiles]
        return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))
    if bbox:
        return tuple(float(v) for v in bbox)
    return DISTRICT_UTM_BBOX


def resolve_out(args, default):
    """Output path for a compiler step: --out, or the default. A non-district area must not overwrite the district file."""
    out = getattr(args, "out", None)
    if out:
        return type(default)(out)
    if not is_district():
        raise SystemExit("--bbox/--tile builds an area other than the district: pass --out so data/*.json is not overwritten")
    return default
