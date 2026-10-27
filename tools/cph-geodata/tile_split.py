# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Split the citywide-style layer files into 500 m tiles (milestone C1 of docs/citywide-plan.md).

Input (all optional except cph-geodata.json): data/cph-geodata.json, cph-surfaces.json, cph-furniture.json,
cph-vegetation.json, cph-terrain.json, cph-entrances.json, cph-groundfloor.json, cph-streets.json, cph-lakes.json and
data/lod2/ (index.json + <cell>.bin).

Output:
  data/tiles/index.json            tile bboxes, per-layer byte sizes and counts
  data/tiles/<id>/<layer>.json     buildings, roads, surfaces, furniture, vegetation, terrain, entrances, groundfloor,
                                   lod2 (+ lod2.bin: the roofer records of the tile's buildings, copied byte for byte)
  data/city/meta.json              what is not tile-owned: versions, frames, attributions, stats, the terrain header and
                                   cut cells, heroes, appearance ...
  data/city/roadgraph.json         the citywide road graph (small; agents and the locator need it whole)
  data/city/streets.json, lakes.json   copied as they are (district-wide, small)

Ownership is by centroid (bbox centre of a ring / polyline, x/z of a point item): nothing is split, so a building, a
surface polygon or a road belongs to exactly one tile and may stick out of it. A tile layer also carries `ord`, the
index each item had in the source list, so assembling every tile gives back the source documents exactly (the engine
and tests/tile-store.test.mjs rely on it; for a partial set the order is just the source order).

Terrain is cut by cell ownership (cell centre inside the tile) into int16 chunks. Run:

    uv run tools/cph-geodata/tile_split.py [--data data] [--out data/tiles] [--city data/city]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VERSION = "cph-tiles/1"

# source key -> (layer file, list names owned by position)
GEO_RINGS = ("sidewalks", "water", "parks")
GEO_LINES = ("roads", "cycleTracks")
GEO_POINTS = ("signals", "trees", "bikeRacks", "benches", "lights")
FURNITURE_LISTS = ("trees", "lamps", "parkingBays", "parkMeters", "bins", "glassContainers", "binStands", "bollards",
                   "rescuePosts", "monuments", "benches", "bikeRacks", "busStops", "lakeLights")


# ------------------------------------------------------------------------------------------------------- ownership

def _bbox_centre(flat) -> tuple[float, float]:
    xs, zs = flat[0::2], flat[1::2]
    return (min(xs) + max(xs)) / 2.0, (min(zs) + max(zs)) / 2.0


def owner_of_ring(item: dict) -> str:
    return frame.tile_of_local(*_bbox_centre(item["ring"]))


def owner_of_line(item: dict) -> str:
    return frame.tile_of_local(*_bbox_centre(item["pts"]))


def owner_of_point(item: dict) -> str:
    return frame.tile_of_local(item["x"], item["z"])


class Tiles:
    """tile id -> layer name -> payload dict, with ordinals."""

    def __init__(self):
        self.layers: dict[str, dict[str, dict]] = {}

    def layer(self, tid: str, name: str) -> dict:
        return self.layers.setdefault(tid, {}).setdefault(name, {"tile": tid, "ord": {}})

    def add(self, tid: str, layer: str, key: str, item, ordinal: int):
        d = self.layer(tid, layer)
        d.setdefault(key, []).append(item)
        d["ord"].setdefault(key, []).append(ordinal)

    def put(self, tid: str, layer: str, key: str, ident: str, value):
        d = self.layer(tid, layer)
        d.setdefault(key, {})[ident] = value


def _load(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def _without(doc: dict, keys) -> dict:
    return {k: v for k, v in doc.items() if k not in keys}


# ----------------------------------------------------------------------------------------------------------- split

def split_all(data: Path):
    """Returns (tiles, city_meta, roadgraph, extra_files, lod2_bins) from the source files under data/."""
    tiles = Tiles()
    meta: dict = {}
    bin_chunks: dict[str, bytearray] = {}

    geo = _load(data / "cph-geodata.json")
    if geo is None:
        raise SystemExit(f"{data / 'cph-geodata.json'} not found")
    owner_of_building = {}
    for i, b in enumerate(geo["buildings"]):
        tid = owner_of_ring(b) if b.get("ring") else frame.tile_of_local(0, 0)
        owner_of_building[b["id"]] = tid
        tiles.add(tid, "buildings", "buildings", b, i)
    for key in GEO_LINES:
        for i, it in enumerate(geo.get(key, [])):
            tiles.add(owner_of_line(it), "roads", key, it, i)
    for key in GEO_RINGS:
        for i, it in enumerate(geo.get(key, [])):
            tiles.add(owner_of_ring(it), "roads", key, it, i)
    for key in GEO_POINTS:
        for i, it in enumerate(geo.get("points", {}).get(key, [])):
            tiles.add(owner_of_point(it), "roads", f"points.{key}", it, i)
    owned = ("buildings", "roadGraph", *GEO_LINES, *GEO_RINGS, "points")
    meta["geodata"] = _without(geo, owned)
    meta["geodata"]["points_keys"] = list(geo.get("points", {}))
    roadgraph = geo.get("roadGraph")

    surfaces = _load(data / "cph-surfaces.json")
    if surfaces:
        for i, s in enumerate(surfaces["surfaces"]):
            tiles.add(owner_of_ring(s), "surfaces", "surfaces", s, i)
        for i, m in enumerate(surfaces["markings"]):
            tiles.add(owner_of_ring(m), "surfaces", "markings", m, i)
        meta["surfaces"] = _without(surfaces, ("surfaces", "markings"))

    furniture = _load(data / "cph-furniture.json")
    if furniture:
        for key in FURNITURE_LISTS:
            for i, it in enumerate(furniture.get(key, [])):
                tiles.add(owner_of_point(it), "furniture", key, it, i)
        meta["furniture"] = _without(furniture, FURNITURE_LISTS)
        meta["furniture"]["list_keys"] = [k for k in FURNITURE_LISTS if k in furniture]

    veg = _load(data / "cph-vegetation.json")
    if veg:
        for key in ("surfaces", "canopy"):
            for i, s in enumerate(veg.get(key, [])):
                tiles.add(owner_of_ring(s), "vegetation", key, s, i)
        meta["vegetation"] = _without(veg, ("surfaces", "canopy"))

    ent = _load(data / "cph-entrances.json")
    if ent:
        ent_tile = {}
        for i, e in enumerate(ent["entrances"]):
            tid = owner_of_building.get(e.get("bid")) or owner_of_point(e)
            ent_tile[e["id"]] = tid
            tiles.add(tid, "entrances", "entrances", e, i)
        orphans = {}
        for sid, v in ent.get("stairwells", {}).items():
            if sid in ent_tile:
                tiles.put(ent_tile[sid], "entrances", "stairwells", sid, v)
            else:
                orphans[sid] = v
        meta["entrances"] = _without(ent, ("entrances", "stairwells"))
        if orphans:
            meta["entrances"]["stairwells"] = orphans  # no entrance with that id: kept citywide

    gf = _load(data / "cph-groundfloor.json")
    if gf:
        for i, v in enumerate(gf["venues"]):
            tiles.add(owner_of_point(v), "groundfloor", "venues", v, i)
        meta["groundfloor"] = _without(gf, ("venues",))

    terrain = _load(data / "cph-terrain.json")
    if terrain:
        split_terrain(terrain, tiles, owner_of_building)
        meta["terrain"] = _without(terrain, ("data", "buildings"))

    lod2_dir = data / "lod2"
    lod2 = _load(lod2_dir / "index.json")
    if lod2:
        cells = {name: (lod2_dir / t["file"]).read_bytes() for name, t in lod2.get("tiles", {}).items() if (lod2_dir / t["file"]).exists()}
        for bid, entry in lod2["buildings"].items():
            tid = owner_of_building.get(bid)
            if tid is None:
                continue
            e = dict(entry)
            cell = e.pop("tile", None)
            if "offset" in e and cell in cells:
                buf = bin_chunks.setdefault(tid, bytearray())
                rec = cells[cell][e["offset"]:e["offset"] + e["length"]]
                e["offset"] = len(buf)
                buf += rec
            tiles.put(tid, "lod2", "buildings", bid, e)
        meta["lod2"] = _without(lod2, ("buildings", "tiles"))

    extra = {}
    for name, src in (("streets", "cph-streets.json"), ("lakes", "cph-lakes.json")):
        p = data / src
        if p.exists():
            extra[name] = p
    return tiles, meta, roadgraph, extra, bin_chunks


def split_terrain(terrain: dict, tiles: Tiles, owner_of_building: dict):
    w, h, cell = terrain["width"], terrain["height"], terrain["cell"]
    bx0, bz0 = terrain["bbox"][0], terrain["bbox"][1]
    grid = np.frombuffer(base64.b64decode(terrain["data"]), dtype="<i2").reshape(h, w)
    cx = bx0 + (np.arange(w) + 0.5) * cell  # local x of cell centres
    cz = bz0 + (np.arange(h) + 0.5) * cell
    ie = np.floor((cx + frame.ORIGIN[0]) / frame.TILE_SIZE).astype(int)
    in_ = np.floor((frame.ORIGIN[1] - cz) / frame.TILE_SIZE).astype(int)
    for a in np.unique(ie):
        cols = np.nonzero(ie == a)[0]
        for b in np.unique(in_):
            rows = np.nonzero(in_ == b)[0]
            tid = frame.tile_id(int(a), int(b))
            sub = np.ascontiguousarray(grid[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1])
            d = tiles.layer(tid, "terrain")
            d["chunk"] = {"x0": bx0 + cols[0] * cell, "z0": bz0 + rows[0] * cell, "w": int(sub.shape[1]), "h": int(sub.shape[0]),
                          "cell": cell, "data": base64.b64encode(sub.astype("<i2").tobytes()).decode()}
    for bid, level in terrain.get("buildings", {}).items():
        tid = owner_of_building.get(bid)
        if tid is not None:
            tiles.put(tid, "terrain", "buildings", bid, level)


# ------------------------------------------------------------------------------------------------------ assemble

def assemble_layer_lists(parts: list[dict], key: str) -> list:
    """Items of `key` over tile payloads, in source order (by ordinal)."""
    pairs = []
    for p in parts:
        pairs.extend(zip(p.get("ord", {}).get(key, []), p.get(key, [])))
    pairs.sort(key=lambda t: t[0])
    return [v for _, v in pairs]


def assemble(tiles_dir: Path, city_dir: Path) -> dict:
    """The source documents rebuilt from tiles (used by the tests; the JS twin in js/tile-store.js does the same)."""
    meta = json.loads((city_dir / "meta.json").read_text())
    index = json.loads((tiles_dir / "index.json").read_text())
    layers: dict[str, list[dict]] = {}
    for tid in sorted(index["tiles"]):
        for name in index["tiles"][tid]["layers"]:
            if name.endswith(".bin"):
                continue
            layers.setdefault(name, []).append(json.loads((tiles_dir / tid / f"{name}.json").read_text()))
    out = {}
    g = dict(meta["geodata"])
    parts = layers.get("buildings", [])
    g["buildings"] = assemble_layer_lists(parts, "buildings")
    roads = layers.get("roads", [])
    for k in (*GEO_LINES, *GEO_RINGS):
        g[k] = assemble_layer_lists(roads, k)
    g["points"] = {k: assemble_layer_lists(roads, f"points.{k}") for k in g.pop("points_keys")}
    g["roadGraph"] = json.loads((city_dir / "roadgraph.json").read_text())
    out["geodata"] = g
    if "surfaces" in meta:
        out["surfaces"] = {**meta["surfaces"], "surfaces": assemble_layer_lists(layers.get("surfaces", []), "surfaces"),
                           "markings": assemble_layer_lists(layers.get("surfaces", []), "markings")}
    if "furniture" in meta:
        m = dict(meta["furniture"])
        keys = m.pop("list_keys")
        out["furniture"] = {**m, **{k: assemble_layer_lists(layers.get("furniture", []), k) for k in keys}}
    if "vegetation" in meta:
        out["vegetation"] = {**meta["vegetation"], **{k: assemble_layer_lists(layers.get("vegetation", []), k) for k in ("surfaces", "canopy")}}
    if "entrances" in meta:
        m = dict(meta["entrances"])
        sw = dict(m.pop("stairwells", {}))
        for p in layers.get("entrances", []):
            sw.update(p.get("stairwells", {}))
        out["entrances"] = {**m, "entrances": assemble_layer_lists(layers.get("entrances", []), "entrances"), "stairwells": sw}
    if "groundfloor" in meta:
        out["groundfloor"] = {**meta["groundfloor"], "venues": assemble_layer_lists(layers.get("groundfloor", []), "venues")}
    if "terrain" in meta:
        t = dict(meta["terrain"])
        w, h, cell = t["width"], t["height"], t["cell"]
        grid = np.zeros((h, w), dtype="<i2")
        for p in layers.get("terrain", []):
            c = p["chunk"]
            c0, r0 = round((c["x0"] - t["bbox"][0]) / cell), round((c["z0"] - t["bbox"][1]) / cell)
            grid[r0:r0 + c["h"], c0:c0 + c["w"]] = np.frombuffer(base64.b64decode(c["data"]), dtype="<i2").reshape(c["h"], c["w"])
        bl = {}
        for p in layers.get("terrain", []):
            bl.update(p.get("buildings", {}))
        out["terrain"] = {**t, "buildings": bl, "data": base64.b64encode(grid.tobytes()).decode()}
    if "lod2" in meta:
        bl = {}
        for p in layers.get("lod2", []):
            bl.update(p.get("buildings", {}))
        out["lod2"] = {**meta["lod2"], "buildings": bl}
    return out


# --------------------------------------------------------------------------------------------------------- writing

def counts_of(layer: str, payload: dict) -> dict:
    return {k: len(v) for k, v in payload.items() if k not in ("tile", "ord") and isinstance(v, (list, dict)) and k != "chunk"}


def write_all(tiles: Tiles, meta, roadgraph, extra, bins, out: Path, city: Path, data: Path):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    city.mkdir(parents=True, exist_ok=True)
    dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    rel = lambda name: Path(os.path.relpath((city / f"{name}.json").resolve(), out.resolve())).as_posix()  # noqa: E731  (../city/<name>.json by default)
    index = {"version": VERSION, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tileSize": frame.TILE_SIZE,
             "frame": {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": list(frame.LOCAL_BBOX)},
             "city": {"meta": rel("meta"), "roadgraph": rel("roadgraph"), "streets": rel("streets") if "streets" in extra else None,
                      "lakes": rel("lakes") if "lakes" in extra else None},
             "tiles": {}}
    for tid in sorted(set(tiles.layers) | set(bins)):
        tdir = out / tid
        tdir.mkdir()
        entry = {"utm": list(frame.tile_bounds_utm(tid)), "local": list(frame.tile_bounds_local(tid)), "layers": {}, "counts": {}}
        for name, payload in sorted(tiles.layers.get(tid, {}).items()):
            payload = {k: v for k, v in payload.items() if not (k == "ord" and not v)}
            txt = dump(payload)
            (tdir / f"{name}.json").write_text(txt)
            entry["layers"][name] = len(txt.encode())
            entry["counts"][name] = counts_of(name, payload)
        if tid in bins:
            (tdir / "lod2.bin").write_bytes(bytes(bins[tid]))
            entry["layers"]["lod2.bin"] = len(bins[tid])
        entry["bytes"] = sum(entry["layers"].values())
        index["tiles"][tid] = entry
    index["bytes"] = sum(t["bytes"] for t in index["tiles"].values())
    (out / "index.json").write_text(dump(index))
    (city / "meta.json").write_text(dump(meta))
    (city / "roadgraph.json").write_text(dump(roadgraph))
    for name, p in extra.items():
        shutil.copyfile(p, city / f"{name}.json")
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--city", default=None)
    a = ap.parse_args()
    data = Path(a.data)
    out = Path(a.out) if a.out else data / "tiles"
    city = Path(a.city) if a.city else data / "city"
    tiles, meta, roadgraph, extra, bins = split_all(data)
    index = write_all(tiles, meta, roadgraph, extra, bins, out, city, data)
    city_bytes = sum(p.stat().st_size for p in city.glob("*.json"))
    print(f"{len(index['tiles'])} tiles, {index['bytes'] / 1e6:.2f} MB in {out}; {city_bytes / 1e6:.2f} MB in {city}")


if __name__ == "__main__":
    main()
