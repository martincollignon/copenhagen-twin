#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "requests", "pyproj"]
# ///
"""Citywide boundary and 500 m tile list for Københavns + Frederiksberg Kommune.

Outputs (EPSG:25832):
  data/city/boundary.geojson  kommune 0101, 0147, and their union (simplified to ~5 m)
  data/city/tiles.json        500 m tiles intersecting the boundary

Inputs (cached under data/raw/city/, refetched with --refresh):
  dagi_kommuner.json   DAGI kommuneinddeling_current (Datafordeler WFS, needs
                       DATAFORDELER_USERNAME / DATAFORDELER_PASSWORD)
  osm_coastline.json   OSM natural=coastline  (ODbL), land/sea split
  osm_water.json       OSM natural=water      (ODbL), lakes/canals/ponds

Tile id is "<floor(E/500)>_<floor(N/500)>", bounds are [e0, n0, e1, n1] in metres.
land_frac = share of the tile's in-boundary area that is land (not sea or inland water);
area_frac = share of the tile inside the boundary. DAGI stops at the coastline, so
land_frac mostly reflects lakes.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "city"
OUT = ROOT / "data" / "city"
TILE = 500
SIMPLIFY_M = 5.0
UA = "cph-twin-geodata/0.1 (open-data compiler)"
DAGI_WFS = "https://wfs.datafordeler.dk/DAGI/DAGI_WFS/1.0.0/WFS"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
OSM_BBOX = "55.58,12.43,55.74,12.74"  # S,W,N,E covering both kommuner with margin
KOMMUNER = {"0101": "København", "0147": "Frederiksberg"}
_to_utm = Transformer.from_crs(4326, 25832, always_xy=True)


def log(*a):
    print(*a, file=sys.stderr)


def overpass(query: str) -> dict:
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": query}, headers={"User-Agent": UA}, timeout=240)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"overpass failed: {last}")


def load_dagi(refresh: bool) -> dict:
    p = RAW / "dagi_kommuner.json"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    user, pw = os.environ.get("DATAFORDELER_USERNAME"), os.environ.get("DATAFORDELER_PASSWORD")
    if not (user and pw):
        raise SystemExit("set DATAFORDELER_USERNAME/PASSWORD (tools/adc-secret.sh datafordeler-username|password)")
    r = requests.get(DAGI_WFS, params={
        "username": user, "password": pw, "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "dagi_v001:kommuneinddeling_current", "outputFormat": "application/json",
        "cql_filter": "kommunekode IN ('" + "','".join(KOMMUNER) + "')",
    }, headers={"User-Agent": UA}, timeout=300)
    r.raise_for_status()
    RAW.mkdir(parents=True, exist_ok=True)
    p.write_text(r.text)
    return r.json()


def load_osm(name: str, query: str, refresh: bool) -> dict:
    p = RAW / f"osm_{name}.json"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    d = overpass(f"[out:json][timeout:180][bbox:{OSM_BBOX}];{query}out geom;")
    RAW.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(d))
    return d


def _line(geom) -> LineString:
    return LineString([_to_utm.transform(p["lon"], p["lat"]) for p in geom])


def land_polygons(boundary, coast: dict, water: dict):
    """Land inside `boundary`: a frame around it is cut by the OSM coastline (land on the LEFT of the way
    direction); pieces are classified on their longest shared coast edge. Returns (land, land minus water)."""
    frame = box(*boundary.buffer(1500).bounds)
    raw = [_line(e["geometry"]) for e in coast["elements"] if e["type"] == "way" and len(e.get("geometry", [])) > 1]
    lines = []
    for l in raw:
        c = l.intersection(frame)
        lines += [g for g in getattr(c, "geoms", [c]) if g.geom_type == "LineString" and g.length > 0]
    cut = unary_union([frame.boundary, *lines])
    near = unary_union(lines).buffer(0.5)
    land_parts = []
    for piece in polygonize(cut):
        shared = piece.boundary.intersection(near)
        parts = [g for g in getattr(shared, "geoms", [shared]) if g.length > 0]
        if not parts:
            continue  # touches only the frame: not classifiable, treat as water
        seg = max(parts, key=lambda g: g.length)
        m = seg.interpolate(0.5, normalized=True)
        best = min(lines, key=lambda l: l.distance(m))
        d = best.project(m)
        a, b2 = best.interpolate(max(d - 0.5, 0)), best.interpolate(min(d + 0.5, best.length))
        dx, dy = b2.x - a.x, b2.y - a.y
        n = math.hypot(dx, dy) or 1.0
        left = Point(m.x - dy / n * 2.0, m.y + dx / n * 2.0)
        if piece.buffer(0.01).contains(left):
            land_parts.append(piece)
    land = unary_union(land_parts).intersection(boundary) if land_parts else Polygon()
    wpolys = []
    for e in water["elements"]:
        if e["type"] == "way" and len(e.get("geometry", [])) > 3 and e["geometry"][0] == e["geometry"][-1]:
            wpolys.append(Polygon(_line(e["geometry"]).coords))
        elif e["type"] == "relation":
            outers = [_line(m["geometry"]) for m in e.get("members", []) if m.get("role") == "outer" and m["type"] == "way" and "geometry" in m]
            inners = [_line(m["geometry"]) for m in e.get("members", []) if m.get("role") == "inner" and m["type"] == "way" and "geometry" in m]
            o = unary_union(list(polygonize(unary_union(outers)))) if outers else Polygon()
            i = unary_union(list(polygonize(unary_union(inners)))) if inners else Polygon()
            wpolys.append(o.difference(i))
    wat = unary_union([w.buffer(0) for w in wpolys if not w.is_empty]) if wpolys else Polygon()
    return land.buffer(0), land.difference(wat).buffer(0)


def build_boundary(refresh: bool):
    dagi = load_dagi(refresh)
    by = {f["properties"]["kommunekode"]: shape(f["geometry"]).buffer(0) for f in dagi["features"]}
    miss = set(KOMMUNER) - set(by)
    if miss:
        raise SystemExit(f"DAGI missing kommunekode {miss}")
    union = unary_union(list(by.values()))
    simp = {k: g.simplify(SIMPLIFY_M, preserve_topology=True) for k, g in by.items()}
    simp_union = union.simplify(SIMPLIFY_M, preserve_topology=True)
    feats = [{"type": "Feature", "properties": {"kommunekode": k, "navn": KOMMUNER[k], "kind": "kommune",
                                                  "area_km2": round(by[k].area / 1e6, 3)}, "geometry": mapping(simp[k])}
             for k in KOMMUNER]
    feats.append({"type": "Feature", "properties": {"kind": "union", "navn": "København + Frederiksberg",
                                                    "area_km2": round(union.area / 1e6, 3)}, "geometry": mapping(simp_union)})
    OUT.mkdir(parents=True, exist_ok=True)
    fc = {"type": "FeatureCollection",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}},
          "source": "DAGI kommuneinddeling_current via Datafordeler WFS (SDFI), simplified to 5 m",
          "features": feats}
    (OUT / "boundary.geojson").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    return by, union


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="refetch DAGI and OSM inputs")
    a = ap.parse_args()

    by, union = build_boundary(a.refresh)
    coast = load_osm("coastline", '(way["natural"="coastline"];);', a.refresh)
    water = load_osm("water", '(way["natural"="water"];relation["natural"="water"];);', a.refresh)
    land, dry = land_polygons(union, coast, water)
    log(f"[city] boundary {union.area/1e6:.1f} km2, land {land.area/1e6:.1f} km2, land minus inland water {dry.area/1e6:.1f} km2")

    pu, pd = prep(union), prep(dry)
    pk = {k: prep(g) for k, g in by.items()}
    x0, y0, x1, y1 = union.bounds
    tiles = []
    for i in range(math.floor(x0 / TILE), math.floor(x1 / TILE) + 1):
        for j in range(math.floor(y0 / TILE), math.floor(y1 / TILE) + 1):
            b = box(i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE)
            if not pu.intersects(b):
                continue
            inter = b.intersection(union)
            if inter.area < 1.0:
                continue
            ks = [k for k in KOMMUNER if pk[k].intersects(b) and b.intersection(by[k]).area >= 1.0]
            land_a = b.intersection(dry).area if pd.intersects(b) else 0.0
            tiles.append({
                "id": f"{i}_{j}", "bounds": [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE],
                "kommune": ks, "area_frac": round(inter.area / b.area, 3),
                "land_frac": round(land_a / inter.area, 3),
            })
    tiles.sort(key=lambda t: (t["bounds"][0], t["bounds"][1]))
    n_land = sum(1 for t in tiles if t["land_frac"] > 0)
    n_mostly = sum(1 for t in tiles if t["land_frac"] >= 0.5)
    out = {"crs": "EPSG:25832", "tile_size": TILE, "count": len(tiles), "count_land": n_land,
           "count_land_ge_50pct": n_mostly, "tiles": tiles}
    (OUT / "tiles.json").write_text(json.dumps(out, separators=(",", ":")))
    both = sum(1 for t in tiles if len(t["kommune"]) > 1)
    print(f"tiles: {len(tiles)} total, {n_land} with land, {n_mostly} with land_frac>=0.5, {both} straddle both kommuner")


if __name__ == "__main__":
    main()
