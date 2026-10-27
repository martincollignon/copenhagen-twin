"""The wall frame the engine draws, for the atlas pipeline: a faithful port of the parts of js/building-geometry.js addBuilding,
js/lod2-geometry.js (parseLod2Record, lod2EdgeTops, lod2WallPieces), js/appearance.js mapObservedEdges and js/layout-cph.js
(applyTerrainGround, the street layout's footprint fixes) that decide where a wall photo goes.

Per building (`frame(b)`):
  ground   the engine's ground (data/tiles/<t>/terrain.json `buildings`, else buildings.json `ground`); an inferred ground moves the
           eave with it, as applyTerrainGround does
  eave     max(eave, ground + 0.5): the top of every wall of a building without a LoD2 record (LoD1 / inferred buildings, and
           buildings whose footprint the street layout clipped: js/buildings-real.js gives those no LoD2)
  edges    per RAW ring edge (ring label, edge) the wall the engine draws for it: `top` = the roofer eave of the cleaned edge the raw
           edge lands on (lod2EdgeTops; the DSM eave where roofer has no top), `pieces` = the roofer wall triangles above that eave on
           the same cleaned edge (lod2WallPieces: gables, dormer-height steps), snapped onto the cleaned edge's line
  roof     roofer roof triangles (z-buffer occluders) and the inner step walls

The Python port is checked against the JS on real tiles (tools/audit/engine_wall_tops.mjs, tests/test_engine_walls.py).
"""
from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np

LOD2_NO_TOP = -32768
ROOF, WALL = 0, 1
MATCH_DIST = 0.12  # js/appearance.js MATCH_DIST (and lod2EdgeTops' 0.12)
MIN_PARALLEL = 0.5

f32 = lambda v: float(np.float32(v))  # noqa: E731  (Float32Array storage in the JS)


# ---------------------------------------------------------------------------------------------------------------------
# js/building-geometry.js


def ring_area(flat) -> float:
    n = len(flat) // 2
    a = 0.0
    for i in range(n):
        j = (i + 1) % n
        a += flat[2 * i] * -flat[2 * j + 1] - flat[2 * j] * -flat[2 * i + 1]
    return a / 2


def clean_ring(flat, ccw: bool):
    """cleanRing: [[x, z], ...] without duplicates and (near-)collinear vertices, in the requested orientation, or None."""
    pts = [[flat[i], flat[i + 1]] for i in range(0, len(flat), 2)]
    dedup = []
    for p in pts:
        q = dedup[-1] if dedup else None
        if q is None or math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05:
            dedup.append(p)
    if len(dedup) > 1 and math.hypot(dedup[0][0] - dedup[-1][0], dedup[0][1] - dedup[-1][1]) <= 0.05:
        dedup.pop()
    pts = dedup
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[(i + len(pts) - 1) % len(pts)], pts[i], pts[(i + 1) % len(pts)]
            cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            scale = math.hypot(b[0] - a[0], b[1] - a[1]) * math.hypot(c[0] - b[0], c[1] - b[1])
            dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
            if scale > 0 and abs(cross) / scale < 0.0087 and dot > 0:
                pts.pop(i)
                changed = True
                break
    if len(pts) < 3:
        return None
    if (ring_area([v for p in pts for v in p]) > 0) != ccw:
        pts.reverse()
    return pts


# ---------------------------------------------------------------------------------------------------------------------
# js/lod2-geometry.js


def parse_lod2_record(buf: bytes, off: int = 0, length: int | None = None) -> dict:
    """parseLod2Record: positions in absolute local metres (Float32, like the JS), tops in metres (NaN = no top)."""
    ox, oy, oz = struct.unpack_from("<fff", buf, off)
    nV, nT, nE = struct.unpack_from("<HHH", buf, off + 12)
    o = off + 18
    raw = np.frombuffer(buf, "<i2", 3 * nV, o).astype(np.float64); o += 6 * nV
    pos = np.empty(3 * nV, np.float32)
    pos[0::3] = ox + raw[0::3] / 100
    pos[1::3] = oy + raw[1::3] / 100
    pos[2::3] = oz + raw[2::3] / 100
    idx = np.frombuffer(buf, "<u2", 3 * nT, o).astype(np.int64); o += 6 * nT
    kind = np.frombuffer(buf, "u1", nT, o).copy(); o += nT
    edge = np.frombuffer(buf, "<i2", nT, o).astype(np.int64); o += 2 * nT
    top_raw = np.frombuffer(buf, "<i2", nE, o)
    top = np.where(top_raw == LOD2_NO_TOP, np.nan, (top_raw / 100).astype(np.float32)).astype(np.float64)
    return {"nV": nV, "nT": nT, "nE": nE, "pos": pos.astype(np.float64), "idx": idx, "kind": kind, "edge": edge, "top": top}


def raw_edges(b: dict) -> list[tuple]:
    """rawEdges / rawRingEdges: (ring label, edge index, x0, z0, x1, z1) over the outer ring then the holes (record edge order)."""
    out = []
    for ri, ring in enumerate([b["ring"], *(b.get("holes") or [])]):
        n = len(ring) // 2
        lab = 0 if ri == 0 else f"hole_{ri - 1}"
        for i in range(n):
            j = (i + 1) % n
            out.append((lab, i, ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]))
    return out


def dist_to_segment(px, pz, x0, z0, x1, z1) -> float:
    dx, dz = x1 - x0, z1 - z0
    l2 = dx * dx + dz * dz or 1
    t = max(0.0, min(1.0, ((px - x0) * dx + (pz - z0) * dz) / l2))
    return math.hypot(x0 + dx * t - px, z0 + dz * t - pz)


def cleaned_edges(clean_rings) -> list[tuple]:
    out = []
    for ring in clean_rings:
        for i in range(len(ring)):
            p, q = ring[i], ring[(i + 1) % len(ring)]
            out.append((p[0], p[1], q[0], q[1]))
    return out


def lod2_edge_tops(rec: dict, b: dict, clean_rings, fallback: float, min_top: float):
    """lod2EdgeTops: (tops per cleaned edge, raw -> cleaned index, cleaned edges)."""
    cleaned = cleaned_edges(clean_rings)
    raw = raw_edges(b)
    raw_to_clean = [-1] * len(raw)
    tops = [math.nan] * len(cleaned)
    for k, e in enumerate(raw):
        mx, mz = (e[2] + e[4]) / 2, (e[3] + e[5]) / 2
        best, bd = -1, 0.12
        for ci, c in enumerate(cleaned):
            d = dist_to_segment(mx, mz, *c)
            if d < bd:
                bd, best = d, ci
        raw_to_clean[k] = best
        t = rec["top"][k] if k < rec["nE"] else math.nan
        if best >= 0 and math.isfinite(t) and t >= min_top:
            tops[best] = min(tops[best], t) if math.isfinite(tops[best]) else t
    tops = [f32(t if math.isfinite(t) else fallback) for t in tops]
    return tops, raw_to_clean, cleaned


def tri_area2(t) -> float:
    u = [t[1][k] - t[0][k] for k in range(3)]
    v = [t[2][k] - t[0][k] for k in range(3)]
    return math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def clip_above(tri, y_min: float) -> list:
    """clipAbove: the part of a triangle at or above y = y_min, as 0..2 triangles."""
    poly = []
    for i in range(3):
        a, b = tri[i], tri[(i + 1) % 3]
        ain, bin_ = a[1] >= y_min, b[1] >= y_min
        if ain:
            poly.append(a)
        if ain != bin_:
            t = (y_min - a[1]) / (b[1] - a[1])
            poly.append([a[0] + (b[0] - a[0]) * t, y_min, a[2] + (b[2] - a[2]) * t])
    return [[poly[0], poly[i], poly[i + 1]] for i in range(1, len(poly) - 1)]


def record_tri(rec: dict, t: int) -> list:
    p = rec["pos"]
    return [[float(p[3 * v]), float(p[3 * v + 1]), float(p[3 * v + 2])] for v in rec["idx"][3 * t:3 * t + 3]]


def lod2_wall_pieces(rec: dict, tops, raw_to_clean, cleaned) -> list[tuple[int, list]]:
    """lod2WallPieces: (cleaned edge or -1, triangle) for the roofer outer walls above each edge's eave (snapped onto the edge's
    line) and the inner step walls."""
    out = []
    for t in range(rec["nT"]):
        if rec["kind"][t] != WALL:
            continue
        tri = record_tri(rec, t)
        raw = int(rec["edge"][t])
        if raw < 0:
            if tri_area2(tri) > 1e-4:
                out.append((-1, tri))
            continue
        ci = raw_to_clean[raw] if raw < len(raw_to_clean) else -1
        if ci < 0:
            continue
        x0, z0, x1, z1 = cleaned[ci]
        dx, dz = x1 - x0, z1 - z0
        l2 = dx * dx + dz * dz or 1
        for piece in clip_above(tri, tops[ci] - 1e-4):
            snapped = []
            for x, y, z in piece:
                t2 = ((x - x0) * dx + (z - z0) * dz) / l2
                snapped.append([x0 + dx * t2, y, z0 + dz * t2])
            if tri_area2(snapped) > 1e-4:
                out.append((ci, snapped))
    return out


def roof_triangles(rec: dict) -> list:
    return [record_tri(rec, t) for t in range(rec["nT"]) if rec["kind"][t] == ROOF]


# ---------------------------------------------------------------------------------------------------------------------
# js/appearance.js mapObservedEdges: the cleaned edge whose photo quad shows a raw edge's strip


def raw_to_quad(b: dict, cleaned) -> list[int]:
    out = []
    lens = [math.hypot(c[2] - c[0], c[3] - c[1]) for c in cleaned]
    for _, _, x0, z0, x1, z1 in raw_edges(b):
        rl = math.hypot(x1 - x0, z1 - z0)
        if rl < 0.05:
            out.append(-1)
            continue
        mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
        best, bd = -1, MATCH_DIST
        for ci, c in enumerate(cleaned):
            if lens[ci] < 0.05:
                continue
            cos = ((x1 - x0) * (c[2] - c[0]) + (z1 - z0) * (c[3] - c[1])) / (rl * lens[ci])
            if abs(cos) < MIN_PARALLEL:
                continue
            d = dist_to_segment(mx, mz, *c)
            if d < bd:
                bd, best = d, ci
        out.append(best)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# per building


def engine_ground(b: dict, terrain_ground: dict | None) -> tuple[float, float]:
    """(ground, eave) after applyTerrainGround."""
    g, e = float(b["ground"]), float(b["eave"])
    tg = (terrain_ground or {}).get(b["id"])
    if tg is not None and tg != b["ground"]:
        if (b.get("conf_fields") or {}).get("ground") == "inferred":
            e += tg - g
        g = float(tg)
    return g, e


def frame(b: dict, rec: dict | None, terrain_ground: dict | None = None) -> dict | None:
    """The engine's wall frame of one building (see the module doc). None when addBuilding would skip it (degenerate outline)."""
    outer = clean_ring(b["ring"], True)
    if outer is None:
        return None
    holes = [h for h in (clean_ring(h, False) for h in (b.get("holes") or [])) if h is not None]
    rings = [outer, *holes]
    ground, eave_src = engine_ground(b, terrain_ground)
    eave = max(eave_src, ground + 0.5)
    cleaned = cleaned_edges(rings)
    if rec is not None:
        tops, r2c, _ = lod2_edge_tops(rec, b, rings, eave, ground + 1.0)
        pieces = lod2_wall_pieces(rec, tops, r2c, cleaned)
    else:
        tops, pieces = [eave] * len(cleaned), []
    by_clean: dict[int, list] = {}
    inner = []
    for ci, tri in pieces:
        (by_clean.setdefault(ci, []) if ci >= 0 else inner).append(tri)
    q = raw_to_quad(b, cleaned)
    edges = {}
    for k, (lab, i, *_xy) in enumerate(raw_edges(b)):
        ci = q[k]
        if ci >= 0:
            edges[(lab, i)] = {"clean": ci, "top": tops[ci], "pieces": by_clean.get(ci, [])}
    return {"ground": ground, "eave": eave, "lod2": rec is not None, "edges": edges,
            "roof": roof_triangles(rec) if rec is not None else [], "inner": inner}


class TileFrames:
    """Loads the per-tile layers the engine reads for a building's frame (terrain ground, street-layout footprint fixes, LoD2 records)
    from data/tiles/<tile>/ and answers `frame(b, tile)`."""

    def __init__(self, tiles_dir: Path):
        self.dir = Path(tiles_dir)
        self.ground: dict[str, float] = {}
        self.fixed: set[str] = set()
        self.lod2: dict[str, tuple[str, dict]] = {}
        self.bins: dict[str, bytes | None] = {}
        self.loaded: set[str] = set()

    def load(self, tid: str) -> None:
        if tid in self.loaded:
            return
        self.loaded.add(tid)
        d = self.dir / tid
        if (d / "terrain.json").exists():
            self.ground.update(json.loads((d / "terrain.json").read_text()).get("buildings") or {})
        if (d / "streets.json").exists():
            fixes = json.loads((d / "streets.json").read_text()).get("buildings") or {}
            self.fixed.update(c["id"] for c in fixes.get("clip") or [])
        if (d / "lod2.json").exists():
            for bid, e in (json.loads((d / "lod2.json").read_text()).get("buildings") or {}).items():
                self.lod2[bid] = (tid, e)

    def record(self, bid: str) -> dict | None:
        """The parsed LoD2 record the engine would use (measured, inside its tile's binary), else None."""
        if bid in self.fixed or bid not in self.lod2:
            return None
        tid, e = self.lod2[bid]
        if e.get("conf") != "measured" or e.get("offset") is None:
            return None
        if tid not in self.bins:
            p = self.dir / tid / "lod2.bin"
            self.bins[tid] = p.read_bytes() if p.exists() else None
        buf = self.bins[tid]
        if buf is None or e["offset"] + e["length"] > len(buf):
            return None
        return parse_lod2_record(buf, e["offset"], e["length"])

    def frame(self, b: dict, tid: str | None = None) -> dict | None:
        if tid:
            self.load(tid)
        return frame(b, self.record(b["id"]), self.ground)
