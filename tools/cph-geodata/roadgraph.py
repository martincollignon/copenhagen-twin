"""Pure road-graph construction: snap vertices, split polylines at junctions."""
from __future__ import annotations

import math


class _UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def cluster_points(pts: list[tuple[float, float]], tol: float = 0.5) -> list[int]:
    """Cluster ids so that points closer than `tol` share an id (single linkage)."""
    uf = _UF(len(pts))
    cell = tol
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (x, z) in enumerate(pts):
        cx, cz = int(math.floor(x / cell)), int(math.floor(z / cell))
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for j in grid.get((cx + dx, cz + dz), ()):
                    if math.hypot(pts[j][0] - x, pts[j][1] - z) <= tol:
                        uf.union(i, j)
        grid.setdefault((cx, cz), []).append(i)
    roots: dict[int, int] = {}
    out = []
    for i in range(len(pts)):
        out.append(roots.setdefault(uf.find(i), len(roots)))
    return out


def build_graph(polylines: list[list[tuple[float, float]]], tol: float = 0.5):
    """Return (nodes, segments).

    nodes: list of (x, z) cluster centroids.
    segments: list of (way_index, node_a, node_b) in digitisation order. Polylines are
    split at every vertex (callers simplify first), so a node exists wherever two ways
    meet or touch within `tol`.
    """
    flat: list[tuple[float, float]] = []
    owner: list[tuple[int, int]] = []
    for wi, pl in enumerate(polylines):
        for vi, p in enumerate(pl):
            flat.append(p)
            owner.append((wi, vi))
    ids = cluster_points(flat, tol)
    k = max(ids) + 1 if ids else 0
    sx = [0.0] * k
    sz = [0.0] * k
    cnt = [0] * k
    for (x, z), c in zip(flat, ids):
        sx[c] += x
        sz[c] += z
        cnt[c] += 1
    nodes = [(sx[i] / cnt[i], sz[i] / cnt[i]) for i in range(k)]
    segs = []
    pos = 0
    for wi, pl in enumerate(polylines):
        n = len(pl)
        for vi in range(n - 1):
            a, b = ids[pos + vi], ids[pos + vi + 1]
            if a != b:
                segs.append((wi, a, b))
        pos += n
    return nodes, segs


def components(n_nodes: int, links: list[tuple[int, int]]) -> list[int]:
    """Component sizes (in nodes), largest first, counting only nodes that appear in links."""
    uf = _UF(n_nodes)
    used = set()
    for a, b in links:
        uf.union(a, b)
        used.add(a)
        used.add(b)
    sizes: dict[int, int] = {}
    for v in used:
        r = uf.find(v)
        sizes[r] = sizes.get(r, 0) + 1
    return sorted(sizes.values(), reverse=True)
