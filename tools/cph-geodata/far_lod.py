#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "shapely>=2"]
# ///
"""Far-ring level of detail (milestone C5 of docs/citywide-plan.md): one compact city-wide layer for everything beyond the
mid ring. Post-process of the tile compiler: reads data/tiles/<id>/{buildings,terrain,roads}.json for whatever tiles exist and
data/city/lakes.json, writes

    data/city/far.bin     per tile one block (little endian, see below)
    data/city/far.json    header: tile table (byte offset / length / building count), water polygons, sea level
    data/city/post.json   the manifest the engine reads for post-process layers (this layer is registered under `far`)

Per tile block (tile origin = the tile's local north-west corner (xmin, zmin); all coordinates relative to it):

    u16 nB, u16 0
    i16 height[17 * 17]      ground at the tile's 16 x 16 cells, row = z, col = x, centimetres (local y); the engine meshes it
    u8  parks[32]            16 x 16 cells, bit (j * 16 + i): the cell is mostly park / lawn
    nB x building:
        u8 nOuter, u8 nHoles, i16 base_cm, i16 top_cm, u8 wallRGB[3], u8 roofRGB[3]   (sRGB 0-255)
        i16 outer[2 * nOuter]                       decimetres, CCW from above, no closing duplicate
        nHoles x (u8 n, i16 pts[2 * n])

A building is a prism: its footprint simplified to ~2 m (Douglas-Peucker), a flat top at the eave (pitched roofs: 55 % of
the way to the ridge), one wall tone and one roof tone. Footprints under --min-area m2 (sheds) and courtyards under
--min-hole m2 are dropped. Run:

    uv run tools/cph-geodata/far_lod.py [--tiles data/tiles] [--city data/city] [--workers 6]
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from shapely import contains_xy
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frame import tile_bounds_local  # noqa: E402

GRID = 16
VERSION = "cph-far/1"
SEA = -6.84  # DVR90 0 m in the local frame (origin height 6.84)

ROOF_COLOURS = {  # js/building-geometry.js ROOF_COLOURS (sRGB)
    "tagpap": (0.2, 0.2, 0.22), "tagpap med lille hældning": (0.2, 0.2, 0.22), "tagpap med stor hældning": (0.24, 0.23, 0.24),
    "tegl": (0.46, 0.19, 0.13), "betontagsten": (0.33, 0.27, 0.24), "fibercement herunder asbest": (0.23, 0.25, 0.27),
    "fibercement uden asbest": (0.23, 0.25, 0.27), "metal": (0.42, 0.46, 0.48), "glas": (0.35, 0.45, 0.5),
    "levende tage": (0.2, 0.32, 0.17), "plastmaterialer": (0.4, 0.4, 0.42), "andet materiale": (0.32, 0.31, 0.3),
}
ROOF_DEFAULT = (0.34, 0.33, 0.32)
WALL_DEFAULT = (0.7, 0.65, 0.58)


def read_json(path: Path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def u8(rgb) -> tuple[int, int, int]:
    return tuple(max(0, min(255, int(round(float(c) * 255)))) for c in rgb)


def wall_tone(b: dict):
    """Observed wall tone (median of the observed walls) when there is one, else the facade preset."""
    walls = (b.get("observed") or {}).get("walls") or []
    tones = [w.get("tone_cal") or w.get("tone") for w in walls if str(w.get("conf", "")).startswith("observed")]
    tones = [t for t in tones if t and len(t) == 3]
    if tones:
        return tuple(float(np.median([t[i] for t in tones])) for i in range(3))
    return tuple((b.get("facade") or {}).get("tone") or WALL_DEFAULT)


def roof_tone(b: dict):
    seen = (b.get("observed") or {}).get("roof") or {}
    if seen.get("conf") == "observed" and seen.get("tone") and len(seen["tone"]) == 3:
        return tuple(seen["tone"])
    return ROOF_COLOURS.get(b.get("roof_material"), ROOF_DEFAULT)


def top_height(b: dict) -> float:
    eave = float(b.get("eave", 0) or 0)
    ridge = float(b.get("ridge", eave) or eave)
    return eave + 0.55 * (ridge - eave) if ridge > eave + 0.3 else eave


def pts_of(flat: list[float]):
    return [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]


def simplify_building(b: dict, tol: float, min_area: float, min_hole: float):
    """-> (outer [(x, z)], holes [[(x, z)]]) CCW outer, or None when the footprint is dropped / degenerate."""
    ring = pts_of(b.get("ring") or [])
    if len(ring) < 3:
        return None
    try:
        poly = Polygon(ring, [pts_of(h) for h in (b.get("holes") or []) if len(h) >= 6])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return None
        if isinstance(poly, MultiPolygon):
            poly = max(poly.geoms, key=lambda g: g.area)
        if poly.area < min_area:
            return None
        s = poly.simplify(tol, preserve_topology=True)
        if isinstance(s, MultiPolygon):
            s = max(s.geoms, key=lambda g: g.area)
        if s.is_empty or s.area < min_area * 0.5:
            s = poly.minimum_rotated_rectangle
        outer = list(s.exterior.coords)[:-1]
        if len(outer) < 3:
            return None
        holes = []
        for h in s.interiors:
            hp = Polygon(h)
            if hp.area >= min_hole:
                holes.append(list(h.coords)[:-1])
        return outer, holes
    except Exception:  # noqa: BLE001 - a malformed footprint is dropped, not fatal
        return None


def ccw(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * (-z1) - x1 * (-z0)
    return pts if a > 0 else pts[::-1]


def decode_chunk(chunk: dict) -> np.ndarray:
    a = np.frombuffer(base64.b64decode(chunk["data"]), dtype="<i2").astype(np.float32) / 100.0
    return a.reshape(chunk["h"], chunk["w"])


def height_grid(chunk: dict | None, bounds) -> np.ndarray:
    """17 x 17 ground heights at the corners of the tile's 16 x 16 cells (bilinear from the 2 m chunk)."""
    xmin, zmin, xmax, zmax = bounds
    if not chunk:
        return np.full((GRID + 1, GRID + 1), SEA, dtype=np.float32)
    g = decode_chunk(chunk)
    cell = chunk["cell"]
    xs = xmin + (xmax - xmin) * np.arange(GRID + 1) / GRID
    zs = zmin + (zmax - zmin) * np.arange(GRID + 1) / GRID
    fx = np.clip((xs - chunk["x0"]) / cell - 0.5, 0, chunk["w"] - 1.0001)
    fz = np.clip((zs - chunk["z0"]) / cell - 0.5, 0, chunk["h"] - 1.0001)
    i = fx.astype(int)
    j = fz.astype(int)
    tx = (fx - i)[None, :]
    tz = (fz - j)[:, None]
    a = g[j][:, i]
    b = g[j][:, i + 1]
    c = g[j + 1][:, i]
    d = g[j + 1][:, i + 1]
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz).astype(np.float32)


def tile_block(tid: str, tiles_dir: Path, parks_union, tol: float, min_area: float, min_hole: float):
    """-> (bytes, nBuildings, heights ndarray) for one tile, or None when it has neither buildings nor terrain."""
    bounds = tile_bounds_local(tid)
    xmin, zmin, xmax, zmax = bounds
    bl = read_json(tiles_dir / tid / "buildings.json")
    tr = read_json(tiles_dir / tid / "terrain.json")
    if bl is None and tr is None:
        return None
    heights = height_grid(tr.get("chunk") if tr else None, bounds)
    out = bytearray()
    records = []
    for b in (bl or {}).get("buildings", []):
        s = simplify_building(b, tol, min_area, min_hole)
        if s is None:
            continue
        outer, holes = s
        outer = ccw(outer)
        holes = [ccw(h)[::-1] for h in holes]  # holes run clockwise
        base = float(b.get("ground", 0)) - 1.0
        top = max(top_height(b), float(b.get("ground", 0)) + 2.5)
        rec = bytearray()
        rec += struct.pack("<BBhh", min(len(outer), 255), min(len(holes), 255), int(round(base * 100)), int(round(top * 100)))
        rec += bytes(u8(wall_tone(b))) + bytes(u8(roof_tone(b)))
        def put(pts):
            for x, z in pts[:255]:
                rec.extend(struct.pack("<hh", int(round((x - xmin) * 10)), int(round((z - zmin) * 10))))
        put(outer)
        for h in holes[:255]:
            rec.extend(struct.pack("<B", min(len(h), 255)))
            put(h)
        records.append(bytes(rec))
    out += struct.pack("<HH", len(records), 0)
    out += np.round(heights * 100).astype("<i2").tobytes()
    # parks: bit per cell of the 16 x 16 grid (3 x 3 samples, mostly inside a park)
    bits = np.zeros(GRID * GRID, dtype=bool)
    if parks_union is not None:
        cw = (xmax - xmin) / GRID
        sub = (np.arange(3) + 0.5) / 3
        px = (xmin + (np.arange(GRID)[:, None] + sub[None, :]) * cw).reshape(-1)
        pz = (zmin + (np.arange(GRID)[:, None] + sub[None, :]) * cw).reshape(-1)
        gx, gz = np.meshgrid(px, pz)  # (GRID*3, GRID*3), row = z
        inside = contains_xy(parks_union, gx, gz).reshape(GRID, 3, GRID, 3).mean(axis=(1, 3))
        bits = (inside >= 0.5).reshape(-1)
    packed = np.packbits(bits, bitorder="little")
    out += packed.tobytes()
    for r in records:
        out += r
    return bytes(out), len(records), heights


def work(args):
    tid, tiles_dir, parks_wkb, tol, min_area, min_hole = args
    from shapely import wkb
    parks = wkb.loads(parks_wkb) if parks_wkb else None
    r = tile_block(tid, Path(tiles_dir), parks, tol, min_area, min_hole)
    return tid, r


def collect_parks(tiles_dir: Path, ids: list[str]):
    polys = []
    for tid in ids:
        rd = read_json(tiles_dir / tid / "roads.json")
        for p in (rd or {}).get("parks", []):
            ring = p.get("ring") or []
            if len(ring) >= 6:
                try:
                    g = Polygon(pts_of(ring))
                    if not g.is_valid:
                        g = g.buffer(0)
                    if not g.is_empty:
                        polys.append(g)
                except Exception:  # noqa: BLE001
                    pass
    return unary_union(polys) if polys else None


def water_polygons(city_dir: Path, heights: dict[str, np.ndarray], tol: float = 3.0):
    doc = read_json(city_dir / "lakes.json") or {}
    out = []

    def sample(x, z):
        ie = math.floor((x + 723900.0) / 500.0)
        in_ = math.floor((6176500.0 - z) / 500.0)
        h = heights.get(f"{ie}_{in_}")
        if h is None:
            return None
        xmin, zmin, xmax, zmax = tile_bounds_local(f"{ie}_{in_}")
        i = min(GRID, max(0, int(round((x - xmin) / (xmax - xmin) * GRID))))
        j = min(GRID, max(0, int(round((z - zmin) / (zmax - zmin) * GRID))))
        return float(h[j, i])

    for kind in ("lakes", "ponds"):
        for lk in doc.get(kind, []):
            ring = pts_of(lk.get("ring") or [])
            if len(ring) < 3:
                continue
            try:
                poly = Polygon(ring)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if isinstance(poly, MultiPolygon):
                    poly = max(poly.geoms, key=lambda g: g.area)
                s = poly.simplify(tol, preserve_topology=True)
                if s.is_empty or s.area < 150:
                    continue
                pts = list(s.exterior.coords)[:-1]
            except Exception:  # noqa: BLE001
                continue
            hs = [h for h in (sample(x, z) for x, z in pts[:: max(1, len(pts) // 40)]) if h is not None]
            level = float(np.percentile(hs, 20)) if hs else SEA
            if level < SEA + 1.2:  # the harbour and the sound sit at the sea
                level = SEA
            out.append({"id": lk.get("id"), "name": (lk.get("name") or "")[:60], "kind": kind, "level": round(level, 2),
                        "ring": [round(v, 1) for p in ccw(pts) for v in p]})
    return out


def update_manifest(city_dir: Path, key: str, value) -> None:
    p = city_dir / "post.json"
    doc = read_json(p) or {"version": "cph-post/1"}
    doc[key] = value
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, p)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tiles", default="data/tiles")
    ap.add_argument("--city", default="data/city")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--tol", type=float, default=1.2, help="Douglas-Peucker tolerance, m (about 2 m of footprint detail)")
    ap.add_argument("--min-area", type=float, default=22.0)
    ap.add_argument("--min-hole", type=float, default=60.0)
    ap.add_argument("--max-mb", type=float, default=30.0)
    args = ap.parse_args()
    tiles_dir = Path(args.tiles)
    city_dir = Path(args.city)
    ids = sorted(p.name for p in tiles_dir.iterdir() if p.is_dir() and (p / "terrain.json").exists())
    t0 = time.time()
    print(f"{len(ids)} tiles in {tiles_dir}")
    parks = collect_parks(tiles_dir, ids)
    parks_wkb = parks.wkb if parks is not None else None
    jobs = [(tid, str(tiles_dir), parks_wkb, args.tol, args.min_area, args.min_hole) for tid in ids]
    table = {}
    heights = {}
    blob = bytearray()
    nb = 0
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for tid, r in ex.map(work, jobs, chunksize=4):
            if r is None:
                continue
            data, n, h = r
            table[tid] = {"off": len(blob), "len": len(data), "n": n}
            heights[tid] = h
            blob += data
            nb += n
    water = water_polygons(city_dir, heights)
    header = {
        "version": VERSION, "grid": GRID, "tileSize": 500, "sea": SEA, "tolerance_m": args.tol,
        "tiles": table, "water": water, "bytes": len(blob), "buildings": nb,
        "method": "footprints simplified (Douglas-Peucker), flat prism tops, one wall and one roof tone; ground on a 16 x 16 grid per tile; "
                  "water from data/city/lakes.json; tools/cph-geodata/far_lod.py",
    }
    city_dir.mkdir(parents=True, exist_ok=True)
    (city_dir / "far.bin").write_bytes(bytes(blob))
    (city_dir / "far.json").write_text(json.dumps(header, separators=(",", ":")))
    update_manifest(city_dir, "far", {"header": "far.json", "bin": "far.bin", "bytes": len(blob), "tiles": len(table)})
    mb = len(blob) / 1e6
    print(f"far.bin {mb:.2f} MB, {len(table)} tiles, {nb} buildings, {len(water)} water polygons, {time.time() - t0:.1f} s")
    if mb > args.max_mb:
        print(f"WARNING: above the {args.max_mb} MB budget; raise --tol / --min-area", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
