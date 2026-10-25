"""Local frame transform and ring helpers (pure functions, no I/O)."""
from __future__ import annotations

ORIGIN = (723900.0, 6176500.0, 6.84)  # E, N (EPSG:25832), DVR90 height
LOCAL_BBOX = (-750.0, -750.0, 750.0, 750.0)  # xmin, zmin, xmax, zmax


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
