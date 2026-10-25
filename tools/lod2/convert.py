#!/usr/bin/env python3
"""roofer CityJSONSeq (LoD2.2) -> per-building roof/wall triangle meshes in the twin's local frame -> data/lod2/<tile>.bin.

Local frame: x = E - 723900, z = -(N - 6176500), y = DVR90 - 6.84 (docs/cph-geodata-schema.md).

Binary layout (little-endian), one record per building, addressed by index.json (`offset`, `length` in bytes):

    float32 ox, oy, oz           record origin in the local frame (x, z rounded to whole metres, oy = 0)
    uint16  nV, nT, nE           vertices, triangles, footprint edges of the building (outer ring then holes, as in geodata)
    int16   pos[3*nV]            x, y, z in whole centimetres relative to the origin
    uint16  idx[3*nT]            triangle corners; counter-clockwise seen from outside
    uint8   kind[nT]             0 roof, 1 wall
    int16   edge[nT]             walls: footprint edge (index over the concatenated rings = observed.walls order),
                                 -1 for inner steps / roofs
    int16   top[nE]              per footprint edge, y (cm, absolute local y, not relative to the origin) of the lowest
                                 point of the roofer outer wall above its foot, i.e. its eave; -32768 = edge not matched
    (padded to a multiple of 4 bytes)

Roofer ground faces are dropped (the engine draws its own floor/extrusion).

    uv run --project tools/lod2 python tools/lod2/convert.py [--tiles ...]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import mapbox_earcut as earcut

import common

NO_TOP = -32768
ROOF, WALL = 0, 1
MATCH_DIST = 0.30      # m: wall foot to footprint edge line
MATCH_ANGLE = 0.9962   # cos(5 deg)
FOOT_GROUND = 0.75     # m: a foot this close to the roofer ground counts as standing on the ground
FOOT_TOL = 0.05        # m: vertices within this of the face's lowest z are its foot
MIN_DENSITY = 4.0      # pts/m2 below which a roof is not trusted
MAX_NODATA = 0.30      # share of the footprint without points above which a roof is not trusted


# ---------------------------------------------------------------------------------------------------------------
# CityJSONSeq reading
# ---------------------------------------------------------------------------------------------------------------
def read_cityjsonseq(path: Path):
    """Yield (transform, feature) for every CityJSONFeature line; the first line carries the transform."""
    transform = None
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            if obj.get("type") == "CityJSON":
                transform = obj["transform"]
                continue
            yield transform, obj


def feature_vertices(transform, feature) -> np.ndarray:
    v = np.asarray(feature["vertices"], dtype=np.float64).reshape(-1, 3)
    return v * np.asarray(transform["scale"]) + np.asarray(transform["translate"])


def lod22_solids(feature: dict, bid: str):
    """[(boundaries-of-shell, semantics)] of every BuildingPart child's LoD2.2 Solid (or MultiSurface) of building `bid`."""
    objs = feature["CityObjects"]
    out = []
    for cid in objs[bid].get("children", []) or []:
        for g in objs[cid].get("geometry", []):
            if str(g["lod"]) != "2.2":
                continue
            sem = g.get("semantics", {})
            surfaces, values = sem.get("surfaces", []), sem.get("values", [])
            if g["type"] == "Solid":
                for shell, vals in zip(g["boundaries"], values):
                    out.append((shell, [surfaces[i]["type"] if i is not None else None for i in vals], [surfaces[i] if i is not None else {} for i in vals]))
            elif g["type"] == "MultiSurface":
                out.append((g["boundaries"], [surfaces[i]["type"] if i is not None else None for i in values], [surfaces[i] if i is not None else {} for i in values]))
    return out


# ---------------------------------------------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------------------------------------------
def newell(poly: np.ndarray) -> np.ndarray:
    n = np.zeros(3)
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        n += np.array([(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
    return n


def triangulate_face(rings: list[np.ndarray]):
    """rings: [outer, hole...] as (n, 3) local-frame arrays. Returns (points (m,3), triangles (k,3) into points, normal)
    with every triangle wound like the outer ring (so a face's orientation is that of its Newell normal)."""
    outer = rings[0]
    normal = newell(outer)
    nl = np.linalg.norm(normal)
    if nl < 1e-9:
        return None
    normal = normal / nl
    drop = int(np.argmax(np.abs(normal)))
    keep = [i for i in range(3) if i != drop]
    pts = np.concatenate(rings)
    p2 = pts[:, keep].astype(np.float64)
    ends, c = [], 0
    for r in rings:
        c += len(r)
        ends.append(c)
    tri = earcut.triangulate_float64(p2, np.asarray(ends, dtype=np.uint32)).reshape(-1, 3)
    if len(tri) == 0:
        return None
    out = []
    for a, b, c3 in tri:
        n = np.cross(pts[b] - pts[a], pts[c3] - pts[a])
        if np.dot(n, normal) < 0:
            b, c3 = c3, b
        out.append((a, b, c3))
    return pts, np.asarray(out, dtype=np.int64), normal


def footprint_edges(b: dict):
    """[(x0, z0, x1, z1, outward nx, nz, len)] over outer ring then holes, indexed like observed.walls."""
    edges = []
    rings = [b["ring"]] + list(b.get("holes", []))
    for ri, r in enumerate(rings):
        n = len(r) // 2
        for i in range(n):
            j = (i + 1) % n
            x0, z0, x1, z1 = r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]
            ln = math.hypot(x1 - x0, z1 - z0)
            nx, nz = ((-(z1 - z0) / ln, (x1 - x0) / ln) if ln > 0 else (0.0, 0.0))
            edges.append((x0, z0, x1, z1, nx, nz, ln))
    return edges


def match_wall_edge(poly: np.ndarray, normal: np.ndarray, edges, h_ground: float | None):
    """Footprint edge index for a wall face, or -1. Local-frame polygon; the foot is its lowest vertices."""
    zmin = poly[:, 1].min()
    if h_ground is not None and zmin - h_ground > 0.75:
        return -1, None
    foot = poly[poly[:, 1] <= zmin + FOOT_TOL]
    if len(foot) < 2:
        return -1, None
    xz = foot[:, [0, 2]]
    d = xz.max(axis=0) - xz.min(axis=0)
    axis = 0 if d[0] >= d[1] else 1
    a, b = xz[np.argmin(xz[:, axis])], xz[np.argmax(xz[:, axis])]
    seg = np.linalg.norm(b - a)
    if seg < 0.2:  # a sliver at a footprint corner: give it the nearest edge so the corner has no hole
        mid = (a + b) / 2
        best, best_d = -1, MATCH_DIST
        for k, (x0, z0, x1, z1, nx, nz, ln) in enumerate(edges):
            if ln < 0.05 or normal[0] * nx + normal[2] * nz <= 0:
                continue
            e = np.array([(x1 - x0) / ln, (z1 - z0) / ln])
            s = min(max(float(np.dot(mid - [x0, z0], e)), 0.0), ln)
            d = float(np.linalg.norm(mid - [x0 + e[0] * s, z0 + e[1] * s]))
            if d < best_d:
                best, best_d = k, d
        return best, None
    t = (b - a) / seg
    best, best_ov = -1, 0.0
    for k, (x0, z0, x1, z1, nx, nz, ln) in enumerate(edges):
        if ln < 0.05:
            continue
        e = np.array([(x1 - x0) / ln, (z1 - z0) / ln])
        if abs(float(np.dot(t, e))) < MATCH_ANGLE:
            continue
        if normal[0] * nx + normal[2] * nz <= 0:
            continue
        dist = max(abs((a[0] - x0) * -e[1] + (a[1] - z0) * e[0]), abs((b[0] - x0) * -e[1] + (b[1] - z0) * e[0]))
        if dist > MATCH_DIST:
            continue
        s0, s1 = sorted([float(np.dot(a - [x0, z0], e)), float(np.dot(b - [x0, z0], e))])
        ov = min(s1, ln) - max(s0, 0.0)
        if ov > best_ov:
            best, best_ov = k, ov
    if best >= 0 and best_ov >= 0.5 * seg:
        top = poly[poly[:, 1] > zmin + 0.3]
        return best, (float(top[:, 1].min()) if len(top) else None)
    return -1, None


def building_mesh(feature: dict, bid: str, verts_en: np.ndarray, geo_b: dict):
    """Triangles of one roofer building in the local frame, or None when it has no LoD2.2 solid.

    verts_en: the feature's vertices in EPSG:25832 + DVR90. Returns dict(pos, tri, kind, edge, top, stats)."""
    solids = lod22_solids(feature, bid)
    if not solids:
        return None
    h_ground = feature["CityObjects"][bid].get("attributes", {}).get("rf_h_ground")
    h_ground_local = None if h_ground is None else h_ground - common.ORIGIN[2]
    loc = np.stack([verts_en[:, 0] - common.ORIGIN[0], verts_en[:, 2] - common.ORIGIN[2], -(verts_en[:, 1] - common.ORIGIN[1])], axis=1)
    edges = footprint_edges(geo_b)
    top = [None] * len(edges)
    P, T, K, E = [], [], [], []
    base = 0
    flagged = {"wall_edge_geo": 0, "wall_flag_edge": 0, "wall_agree": 0}
    dropped_ground_walls = 0
    manifold_ok = True
    edge_use: dict[tuple[int, int], int] = {}
    for shell, types, sems in solids:
        for face, typ, sem in zip(shell, types, sems):
            for r in face:  # closed-shell check over every face, ground included
                for i in range(len(r)):
                    k = tuple(sorted((r[i], r[(i + 1) % len(r)])))
                    edge_use[k] = edge_use.get(k, 0) + 1
            if typ == "GroundSurface":
                continue
            rings = [loc[np.asarray(r)] for r in face]
            tr = triangulate_face(rings)
            if tr is None:
                continue
            pts, tris, normal = tr
            kind = ROOF if typ == "RoofSurface" else WALL
            edge = -1
            if kind == ROOF:
                if normal[1] < 0:  # a roof can not face down: roofer should not emit one, flip defensively
                    tris = tris[:, [0, 2, 1]]
            else:
                edge, t = match_wall_edge(rings[0], normal, edges, h_ground_local)
                if edge < 0 and h_ground_local is not None and rings[0][:, 1].min() - h_ground_local <= FOOT_GROUND:
                    # a wall that stands on the ground but not on the footprint (balcony fins, recesses, footprint
                    # simplification): the extruded facade already stands there, drawing it would add fins
                    dropped_ground_walls += 1
                    continue
                if edge >= 0 and t is not None:
                    top[edge] = t if top[edge] is None else min(top[edge], t)
                flagged["wall_edge_geo"] += edge >= 0
                flagged["wall_flag_edge"] += bool(sem.get("on_footprint_edge"))
                flagged["wall_agree"] += (edge >= 0) == bool(sem.get("on_footprint_edge"))
            P.append(pts)
            T.append(tris + base)
            K.extend([kind] * len(tris))
            E.extend([edge] * len(tris))
            base += len(pts)
    if not P:
        return None
    manifold_ok = all(v == 2 for v in edge_use.values())
    return {"pos": np.concatenate(P), "tri": np.concatenate(T), "kind": np.asarray(K, np.uint8), "edge": np.asarray(E, np.int16),
            "top": top, "n_edges": len(edges), "closed": manifold_ok, "flags": flagged, "dropped_ground_walls": dropped_ground_walls}


# ---------------------------------------------------------------------------------------------------------------
# Binary record
# ---------------------------------------------------------------------------------------------------------------
def pack_record(mesh: dict) -> bytes:
    """Quantise to whole centimetres, weld equal vertices, drop degenerate triangles, and serialise (layout above)."""
    pos = mesh["pos"]
    ox = float(round((pos[:, 0].min() + pos[:, 0].max()) / 2))
    oz = float(round((pos[:, 2].min() + pos[:, 2].max()) / 2))
    q = np.stack([np.round((pos[:, 0] - ox) * 100), np.round(pos[:, 1] * 100), np.round((pos[:, 2] - oz) * 100)], axis=1).astype(np.int64)
    if np.abs(q).max() > 32767:
        raise ValueError("building extent exceeds int16 centimetres")
    uniq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    tri = inv[mesh["tri"]]
    keep = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    tri, kind, edge = tri[keep], mesh["kind"][keep], mesh["edge"][keep]
    used = np.unique(tri)
    remap = -np.ones(len(uniq), np.int64)
    remap[used] = np.arange(len(used))
    uniq, tri = uniq[used], remap[tri]
    if len(uniq) > 65535:
        raise ValueError("too many vertices")
    top = np.array([NO_TOP if t is None else int(round(t * 100)) for t in mesh["top"]], dtype=np.int16)
    body = [struct.pack("<3f3H", ox, 0.0, oz, len(uniq), len(tri), mesh["n_edges"]),
            uniq.astype("<i2").tobytes(), tri.astype("<u2").tobytes(), kind.astype("u1").tobytes(), edge.astype("<i2").tobytes(),
            top.astype("<i2").tobytes()]
    raw = b"".join(body)
    return raw + b"\0" * (-len(raw) % 4)


def unpack_record(buf: bytes) -> dict:
    """Inverse of pack_record (used by tests and qa.py); positions come back in local metres."""
    ox, oy, oz, nv, nt, ne = struct.unpack_from("<3f3H", buf, 0)
    o = 18
    pos = np.frombuffer(buf, "<i2", 3 * nv, o).reshape(-1, 3).astype(np.float64) / 100.0
    o += 6 * nv
    tri = np.frombuffer(buf, "<u2", 3 * nt, o).reshape(-1, 3).astype(np.int64)
    o += 6 * nt
    kind = np.frombuffer(buf, "u1", nt, o).copy()
    o += nt
    edge = np.frombuffer(buf, "<i2", nt, o).astype(np.int64)
    o += 2 * nt
    top = np.frombuffer(buf, "<i2", ne, o).astype(np.float64)
    top = [None if t == NO_TOP else t / 100.0 for t in top]
    pos[:, 0] += ox
    pos[:, 1] += oy
    pos[:, 2] += oz
    return {"pos": pos, "tri": tri, "kind": kind, "edge": edge, "top": top, "origin": (ox, oy, oz)}


# ---------------------------------------------------------------------------------------------------------------
# Quality gate and tile conversion
# ---------------------------------------------------------------------------------------------------------------
def attr(a: dict, name: str):
    """roofer suffixes per-pointcloud attributes with the pointcloud name (rf_pt_density_punktsky)."""
    for k in (f"rf_{name}_punktsky", f"rf_{name}"):
        if k in a and a[k] is not None:
            return a[k]
    return None


def gate(a: dict, post_scan: bool) -> tuple[str, str | None]:
    """('measured' | 'inferred', reason)."""
    if post_scan:
        return "inferred", "built after the point cloud was scanned"
    if not a.get("rf_success", False):
        return "inferred", "roofer failed"
    if a.get("rf_pointcloud_unusable"):
        return "inferred", "point cloud unusable"
    if a.get("rf_extrusion_mode") not in (None, "standard"):
        return "inferred", f"roofer extrusion mode {a.get('rf_extrusion_mode')}"
    nodata, dens = attr(a, "nodata_frac"), attr(a, "pt_density")
    if nodata is not None and nodata > MAX_NODATA:
        return "inferred", f"{nodata:.0%} of the footprint has no points"
    if dens is not None and dens < MIN_DENSITY:
        return "inferred", f"point density {dens:.1f}/m2"
    if a.get("rf_roof_type") in ("no points", "no planes"):
        return "inferred", f"roof type: {a.get('rf_roof_type')}"
    return "measured", None


def convert_tile(tid: str, geo_by_id: dict, out_dir: Path, work: Path | None = None, skip_ids: frozenset = frozenset()) -> dict:
    work = work or common.WORK_DIR / tid
    manifest = json.loads((work / "manifest.json").read_text())
    own = manifest["buildings"]
    scan_date = manifest["scan"]["scan_date"]
    index, blob, off = {}, bytearray(), 0
    skipped = {}
    for jl in sorted((work / "out").glob("*.jsonl")):
        for transform, feat in read_cityjsonseq(jl):
            verts = feature_vertices(transform, feat)
            for oid, o in feat["CityObjects"].items():
                if o["type"] != "Building":
                    continue
                gid = f"gdk:{oid}"
                if gid not in own or gid not in geo_by_id or gid in skip_ids:
                    continue  # margin neighbour, or a hero building (loaded from its glTF, never from LoD2)
                a = o.get("attributes", {})
                conf, reason = gate(a, own[gid]["post_scan"])
                meta = {"tile": tid, "conf": conf, "roof_type": a.get("rf_roof_type"), "planes": a.get("rf_roof_planes"),
                        "rmse": None if a.get("rf_rmse_lod22") is None else round(a["rf_rmse_lod22"], 3),
                        "density": None if attr(a, "pt_density") is None else round(attr(a, "pt_density"), 1),
                        "nodata": None if attr(a, "nodata_frac") is None else round(attr(a, "nodata_frac"), 3),
                        "scan_date": scan_date}
                if conf != "measured":
                    skipped[gid] = {**meta, "reason": reason}
                    continue
                try:
                    mesh = building_mesh(feat, oid, verts, geo_by_id[gid])
                    if mesh is None:
                        skipped[gid] = {**meta, "conf": "inferred", "reason": "no LoD2.2 geometry"}
                        continue
                    rec = pack_record(mesh)
                except ValueError as e:
                    skipped[gid] = {**meta, "conf": "inferred", "reason": str(e)}
                    continue
                meta.update({"offset": off, "length": len(rec), "closed": mesh["closed"],
                             "roofer_ridge": a.get("rf_h_roof_max"), "roofer_ground": a.get("rf_h_ground")})
                index[gid] = meta
                blob += rec
                off += len(rec)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{tid}.bin").write_bytes(bytes(blob))
    for gid, s in skipped.items():
        index[gid] = s
    return {"tile": tid, "index": index, "bytes": len(blob), "scan": manifest["scan"], "skipped": len(skipped)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", nargs="*")
    ap.add_argument("--out", default=str(common.OUT_DIR))
    a = ap.parse_args()
    geo = common.load_geodata()
    by_id = {b["id"]: b for b in geo["buildings"]}
    heroes = frozenset(h["building_id"] for h in geo.get("heroes", []))
    tiles = a.tiles or sorted(p.name for p in common.WORK_DIR.iterdir() if (p / "out").exists())
    out_dir = Path(a.out)
    index_path = out_dir / "index.json"
    doc = {"version": "lod2/1", "frame": geo["frame"], "src": [f"roofer:{common.ROOFER_IMAGE.split(':')[-1]}", "dhm:punktsky"],
           "units": "positions in cm relative to the record origin; see tools/lod2/convert.py", "tiles": {}, "buildings": {}}
    if index_path.exists():
        old = json.loads(index_path.read_text())
        doc["tiles"], doc["buildings"] = old.get("tiles", {}), old.get("buildings", {})
    for tid in tiles:
        r = convert_tile(tid, by_id, out_dir, skip_ids=heroes)
        doc["buildings"] = {k: v for k, v in doc["buildings"].items() if v.get("tile") != tid}
        doc["buildings"].update(r["index"])
        doc["tiles"][tid] = {"file": f"{tid}.bin", "bytes": r["bytes"], "scan_date": r["scan"]["scan_date"]}
        n_mesh = sum(1 for v in r["index"].values() if "offset" in v)
        print(f"{tid}: {n_mesh} meshes, {r['skipped']} inferred/skipped, {r['bytes'] / 1e6:.2f} MB", flush=True)
    index_path.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True))
    print(f"index.json: {len(doc['buildings'])} buildings, {index_path.stat().st_size / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
