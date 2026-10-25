"""Dependency-free polygon-with-holes triangulation (hole bridging + ear clipping).

appearance.py prefers mapbox-earcut when installed, but the roof mesh must never depend on an
optional wheel: without it v1 silently fell back to a fan over the outer ring, which ignores
holes and concave outlines (the v1 test failure: a 400 m2 courtyard block with a 100 m2
hole got a 400 m2 roof).
"""
from __future__ import annotations

import numpy as np


def _area2(p: np.ndarray, idx: list[int]) -> float:
    q = p[idx]
    return float(np.sum(q[:, 0] * np.roll(q[:, 1], -1) - np.roll(q[:, 0], -1) * q[:, 1]))


def _in_tri(pt, a, b, c) -> bool:
    d1 = (pt[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pt[1] - b[1])
    d2 = (pt[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (pt[1] - c[1])
    d3 = (pt[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (pt[1] - a[1])
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def _seg_cross(p1, p2, q1, q2) -> bool:
    """Proper intersection of segments p1p2 and q1q2 (touching at shared endpoints allowed)."""
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (p1 == q1).all() or (p1 == q2).all() or (p2 == q1).all() or (p2 == q2).all():
        return False
    d1, d2, d3, d4 = o(p1, p2, q1), o(p1, p2, q2), o(q1, q2, p1), o(q1, q2, p2)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0


def _locally_inside(p: np.ndarray, poly: list[int], k: int, m: np.ndarray) -> bool:
    n = len(poly)
    a, b, c = p[poly[k - 1]], p[poly[k]], p[poly[(k + 1) % n]]

    def o(u, v, w):
        return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    if o(a, b, c) >= 0:  # convex vertex (CCW polygon)
        return o(b, m, a) >= 0 and o(b, c, m) >= 0
    return not (o(b, m, c) >= 0 and o(b, a, m) >= 0)


def _bridge(p: np.ndarray, poly: list[int], hole: list[int], others: list[list[int]]) -> list[int]:
    """Merge one hole (clockwise) into the polygon (counter-clockwise) with a mutually
    visible bridge: nearest polygon vertex whose segment to the hole's right-most vertex
    crosses no polygon or hole edge and leaves the polygon on its interior side."""
    hm = max(range(len(hole)), key=lambda i: (p[hole[i], 0], -p[hole[i], 1]))
    M = p[hole[hm]]
    edges = []
    for ring in [poly, hole] + others:
        for i in range(len(ring)):
            edges.append((p[ring[i]], p[ring[(i + 1) % len(ring)]]))
    order = sorted(range(len(poly)), key=lambda k: float(np.hypot(*(p[poly[k]] - M))))
    for k in order:
        Q = p[poly[k]]
        if not _locally_inside(p, poly, k, M):
            continue
        if any(_seg_cross(M, Q, e0, e1) for e0, e1 in edges):
            continue
        rot = hole[hm:] + hole[:hm]
        return poly[: k + 1] + rot + [rot[0]] + [poly[k]] + poly[k + 1:]
    return poly  # no visible vertex (degenerate input): leave the hole filled


def triangulate(rings: list[np.ndarray]) -> np.ndarray:
    """rings[0] = outer, rest = holes, each (k,2) in any orientation. Returns (m,3) indices into
    np.vstack(rings)."""
    p = np.vstack(rings).astype(np.float64)
    offs = np.cumsum([0] + [len(r) for r in rings])
    outer = list(range(offs[0], offs[1]))
    if _area2(p, outer) < 0:
        outer.reverse()
    holes = []
    for i in range(1, len(rings)):
        h = list(range(offs[i], offs[i + 1]))
        if len(h) >= 3:
            if _area2(p, h) > 0:
                h.reverse()
            holes.append(h)
    holes.sort(key=lambda h: -max(p[i, 0] for i in h))
    poly = outer
    for i, h in enumerate(holes):
        poly = _bridge(p, poly, h, holes[i + 1:])
    return _ear_clip(p, poly)


def _ear_clip(p: np.ndarray, poly: list[int]) -> np.ndarray:
    poly = list(poly)
    out = []
    guard = 0
    while len(poly) > 3 and guard < 20 * len(p) + 1000:
        guard += 1
        n = len(poly)
        clipped = False
        for k in range(n):
            ia, ib, ic = poly[k - 1], poly[k], poly[(k + 1) % n]
            a, b, c = p[ia], p[ib], p[ic]
            cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(cr) < 1e-12:  # degenerate (bridge spike / collinear): drop vertex
                poly.pop(k)
                clipped = True
                break
            if cr < 0:
                continue
            ok = True
            for j in poly:
                if j in (ia, ib, ic):
                    continue
                q = p[j]
                if (q == a).all() or (q == b).all() or (q == c).all():
                    continue
                if _in_tri(q, a, b, c):
                    ok = False
                    break
            if ok:
                out.append((ia, ib, ic))
                poly.pop(k)
                clipped = True
                break
        if not clipped:  # numerically stuck: force-clip the sharpest convex vertex
            out.append((poly[-1], poly[0], poly[1]))
            poly.pop(0)
    if len(poly) == 3:
        out.append(tuple(poly))
    return np.array(out, dtype=np.int64).reshape(-1, 3)
