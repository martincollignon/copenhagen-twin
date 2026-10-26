#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Street layout per tile (milestone C5 of docs/citywide-plan.md). Post-process of the tile compiler.

data/city/streets.json (tools/cph-geodata/streets.py: measured carriageways, cycle strips, pavements, footprint fixes) is one
document that grows with the area it covers. This tool buckets it by tile so the engine streams it with the tile:

    data/tiles/<id>/streets.json   { tile, roads: {id: rec}, extraRoads, sidewalks, cycleTracks, buildings: {drop, clip}, surfaceCuts }
                                   for every tile the layout touches; owners are the tile of the road / building / surface it
                                   refers to (looked up in the tile layers), the tile of the centre of a pavement / cycle track
    data/city/streets-graph.json   the layout's fixes to the road graph (node moves, link widths, dropped links), renumbered for the
                                   CITYWIDE graph (data/city/roadgraph.json): streets.json refers to the district's graph, whose
                                   indices the citywide graph does not share. Nodes are matched by position (0.1 m), links by their
                                   end nodes; what does not match is left out (reported)
    data/city/post.json            registers both under `streets` (bytes per tile) for js/tile-store.js

    uv run tools/cph-geodata/tile_streets.py [--tiles data/tiles] [--city data/city] [--data data]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frame import tile_id, tile_of_local, parse_tile_id, tile_bounds_local  # noqa: E402


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def bbox_centre(flat):
    xs, zs = flat[0::2], flat[1::2]
    return (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2


def owner(flat) -> str | None:
    if not flat or len(flat) < 2:
        return None
    return tile_of_local(*bbox_centre(flat))


def update_manifest(city_dir: Path, key: str, value) -> None:
    p = city_dir / "post.json"
    doc = read_json(p) or {"version": "cph-post/1"}
    doc[key] = value
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, p)


def doc_extent(doc) -> tuple[float, float, float, float]:
    xs, zs = [], []

    def add(flat):
        xs.extend(flat[0::2])
        zs.extend(flat[1::2])
    for rec in doc.get("roads", {}).values():
        add(rec["p"])
    for e in doc.get("extraRoads", []):
        add(e["p"])
    for s in doc.get("sidewalks", []):
        add(s["ring"])
    for c in doc.get("cycleTracks", []):
        add(c["pts"])
    return min(xs), min(zs), max(xs), max(zs)


def remap_graph(graph: dict, survey: dict | None, city: dict) -> tuple[dict, dict]:
    """streets graph fixes (district indices) -> citywide indices."""
    report = {"nodes": [0, 0], "widths": [0, 0], "dropLinks": [0, 0], "identity": False}
    cn = city["nodes"]

    def fits() -> bool:
        """The layout's graph indices already number the citywide graph (a citywide streets.json, or the district's own graph)."""
        nodes = graph["nodes"]
        if not nodes:
            return True
        step = max(1, len(nodes) // 40)
        for i, x, z in nodes[::step]:
            if 2 * i + 1 >= len(cn) or math.hypot(cn[2 * i] - x, cn[2 * i + 1] - z) > 30:
                return False
        return True

    if fits() or survey is None:
        report["identity"] = True
        return {"nodes": graph["nodes"], "widths": graph["widths"], "dropLinks": graph.get("dropLinks", [])}, report
    at: dict[tuple[float, float], int] = {}
    for i in range(len(cn) // 2):
        at.setdefault((round(cn[2 * i], 1), round(cn[2 * i + 1], 1)), i)
    sn = survey["nodes"]
    node_map: dict[int, int] = {}
    for i in range(len(sn) // 2):
        j = at.get((round(sn[2 * i], 1), round(sn[2 * i + 1], 1)))
        if j is not None:
            node_map[i] = j
    ends: dict[tuple[int, int], int] = {}
    for li, l in enumerate(city["links"]):
        ends.setdefault((l[0], l[1]), li)
        ends.setdefault((l[1], l[0]), li)

    def link_of(li: int):
        if not 0 <= li < len(survey["links"]):
            return None
        l = survey["links"][li]
        a, b = node_map.get(l[0]), node_map.get(l[1])
        return None if a is None or b is None else ends.get((a, b))

    out = {"nodes": [], "widths": [], "dropLinks": []}
    for i, x, z in graph["nodes"]:
        report["nodes"][1] += 1
        j = node_map.get(i)
        if j is not None:
            out["nodes"].append([j, x, z])
            report["nodes"][0] += 1
    for li, w in graph["widths"]:
        report["widths"][1] += 1
        j = link_of(li)
        if j is not None:
            out["widths"].append([j, w])
            report["widths"][0] += 1
    for li in graph.get("dropLinks", []):
        report["dropLinks"][1] += 1
        j = link_of(li)
        if j is not None:
            out["dropLinks"].append(j)
            report["dropLinks"][0] += 1
    return out, report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tiles", default="data/tiles")
    ap.add_argument("--city", default="data/city")
    ap.add_argument("--data", default="data", help="where cph-geodata.json (the district's survey road graph) is")
    args = ap.parse_args()
    tiles_dir, city_dir = Path(args.tiles), Path(args.city)
    doc = read_json(city_dir / "streets.json")
    if doc is None:
        print("no streets.json in", city_dir)
        return 1
    ids = sorted(p.name for p in tiles_dir.iterdir() if p.is_dir())
    x0, z0, x1, z1 = doc_extent(doc)
    cand = [t for t in ids if (lambda b: not (b[2] < x0 - 300 or b[0] > x1 + 300 or b[3] < z0 - 300 or b[1] > z1 + 300))(tile_bounds_local(t))]
    print(f"streets cover x {x0:.0f}..{x1:.0f}, z {z0:.0f}..{z1:.0f}: {len(cand)} candidate tiles of {len(ids)}")

    road_tile, bld_tile, surf_tile = {}, {}, {}
    for t in cand:
        for name, key, dst in (("roads", "roads", road_tile), ("buildings", "buildings", bld_tile), ("surfaces", "surfaces", surf_tile), ("vegetation", "surfaces", surf_tile)):
            p = read_json(tiles_dir / t / f"{name}.json")
            for it in (p or {}).get(key, []):
                dst[it["id"]] = t

    per: dict[str, dict] = {}

    def slot(t):
        return per.setdefault(t, {"tile": t, "roads": {}, "extraRoads": [], "sidewalks": [], "cycleTracks": [], "buildings": {"drop": [], "clip": []}, "surfaceCuts": []})
    miss = {"roads": 0, "extraRoads": 0, "buildings": 0, "surfaceCuts": 0}
    for rid, rec in doc.get("roads", {}).items():
        t = road_tile.get(rid)
        if t is None:
            miss["roads"] += 1
            continue
        slot(t)["roads"][rid] = rec
    for e in doc.get("extraRoads", []):
        t = road_tile.get(e["base"])
        if t is None:
            miss["extraRoads"] += 1
            continue
        slot(t)["extraRoads"].append(e)
    for s in doc.get("sidewalks", []):
        t = owner(s["ring"])
        if t:
            slot(t)["sidewalks"].append(s)
    for c in doc.get("cycleTracks", []):
        t = owner(c["pts"])
        if t:
            slot(t)["cycleTracks"].append(c)
    for kind in ("drop", "clip"):
        for b in (doc.get("buildings") or {}).get(kind, []):
            t = bld_tile.get(b["id"])
            if t is None:
                miss["buildings"] += 1
                continue
            slot(t)["buildings"][kind].append(b)
    for c in doc.get("surfaceCuts", []):
        t = surf_tile.get(c["id"]) or surf_tile.get(str(c["id"]).split("#")[0])
        if t is None:
            miss["surfaceCuts"] += 1
            continue
        slot(t)["surfaceCuts"].append(c)

    sizes = {}
    for t, payload in per.items():
        if not (tiles_dir / t).is_dir():  # a tile the compiler has not made (yet): nothing to put it in
            miss["tiles"] = miss.get("tiles", 0) + 1
            continue
        data = json.dumps(payload, separators=(",", ":")).encode()
        (tiles_dir / t / "streets.json").write_bytes(data)
        sizes[t] = len(data)

    city = read_json(city_dir / "roadgraph.json")
    survey_doc = read_json(Path(args.data) / "cph-geodata.json")
    survey = (survey_doc or {}).get("roadGraph")
    graph, rep = remap_graph(doc["graph"], survey, city) if doc.get("graph") and city else ({"nodes": [], "widths": [], "dropLinks": []}, {})
    (city_dir / "streets-graph.json").write_text(json.dumps(graph, separators=(",", ":")))
    update_manifest(city_dir, "streets", {"graph": "streets-graph.json", "tiles": sizes, "version": doc.get("version")})
    total = sum(sizes.values())
    print(f"{len(sizes)} tiles with a streets layer, {total / 1e6:.2f} MB; unplaced {miss}; graph {rep}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
