#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "shapely>=2", "pyproj", "numpy", "rasterio", "scipy", "pillow", "laspy[lazrs]", "pyshp"]
# ///
"""Citywide compiler (milestone C1/C5 of docs/citywide-plan.md): Koebenhavns + Frederiksberg Kommune -> 500 m tiles.

    uv run tools/cph-geodata/build_city.py [--stage STAGE ...] [--workers 4] [--cells 6176_723 ...] [--force STAGE]

Writes, in the format tile_split.py writes and js/tile-store.js reads:
    data/tiles/<id>/<layer>.json   buildings, roads, terrain (stage 1); surfaces, furniture, entrances, groundfloor (2); vegetation (3)
    data/tiles/index.json          tile bboxes, per-layer byte sizes and counts
    data/city/{meta,roadgraph,lakes,streets}.json, data/city/coverage.md

Everything is resumable and idempotent: a stage (or one 1 km cell of a stage) writes a done-marker under
data/city/work/state/ when it is complete, and a re-run skips it (`--force STAGE` redoes it). Raw data is cached under
data/raw/city/ (citywide, one file per source layer; shared by all cells) and data/raw/cells/<cell>/ (a cell's slice of it
plus the DHM rasters, deleted when the cell is finished). Nothing under data/raw or data/tiles is committed.

Stages, in order (default: all that exist):
    fetch       citywide sparse layers once: KK WFS (paged, deduped by id, checked against resultType=hits), Overpass,
                GeoDanmark Bygning + BBR (Datafordeler) for Frederiksberg and for gaps in the KK layer
    buildings0  merge the building sources into one footprint list and slice it per 1 km cell (+50 m margin)
    geo         roads (one pass for the whole city, so the road graph is connected), roadGraph, cycle tracks, sidewalks,
                water, parks, signals, trees, racks, benches, lights -> tile layer `roads`; lakes.json
    cells       per 1 km cell (parallel): DHM DSM/DTM via WCS -> building heights, terrain grid -> tile layers
                `buildings` and `terrain`; the rasters are deleted when the cell is done
    index       data/tiles/index.json and data/city/meta.json from what is on disk
    report      data/city/coverage.md

Secrets are read from the environment (DATAFORDELER_USERNAME / _PASSWORD / _GRAPHQL_API_KEY, GSEARCH_TOKEN) or, if unset,
from tools/adc-secret.sh; they are never printed or written. The script aborts a step when free disk space falls below
MIN_FREE_GB.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import city_sources as S  # noqa: E402
import frame  # noqa: E402
import tile_split as T  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
TILES_DIR = DATA / "tiles"
CITY_DIR = DATA / "city"
WORK = CITY_DIR / "work"
STATE = WORK / "state"
RAW_CITY = S.RAW_CITY
RAW_CELLS = DATA / "raw" / "cells"
DISTRICT_REF = RAW_CITY / "district-tiles-ref"  # data/tiles + meta of the district-only build this one replaces

MIN_FREE_GB = float(os.environ.get("CPH_MIN_FREE_GB", "5.0"))  # lower it only on request
CELL_MARGIN = 50.0  # buildings slice per cell: footprints within this of the cell are kept (terrain masks, border buildings)
DHM_MARGIN = 100.0
TERRAIN_CELL = 2.0
GEO_VERSION = "cph-geodata/1"
CITY_BBOX_MARGIN = 100.0

KK_BASE = ["bygning", "bygning_kk", "Kommunevej", "trafikhastigheder", "ensrettede_gader", "cykelsti", "trafiksignal_oversigt",
           "fortovsmatrikel", "parkregister", "park_groent_omr_oversigtskort", "vejkant"]
KK_POINTS = ["cykelstativ", "baenke_borde_puma", "dp_byinventar_l", "trae_basis", "automatisk_detekterede_traeer_kk_beta"]
KK_LAYERS2 = ["dp_belaegninger", "afmaerkning_total", "blaa_cykelfelt", "automatisk_detekterede_kroner_kk_beta", "parkering_areal",
              "p_pladser", "parkomat", "affaldskurve_puma", "ask_glascontainer", "ask_standpladser_nokey", "pullert", "monumenter",
              "dp_byinventar_p", "dp_byinventar_f", "bevillinger"]
OSM_QUERIES2 = {  # keys and bodies are the ones the compiler modules use (surfaces.py, groundfloor.py) plus the FRB fallbacks
    "squares": '(way["place"="square"];way["highway"="pedestrian"]["area"="yes"];way["area:highway"~"pedestrian|footway|living_street"];'
               'relation["place"="square"];relation["highway"="pedestrian"];way["landuse"="pedestrian"];);out geom;',
    "groundfloor": None,  # groundfloor.QUERY, filled in below
    "street_nodes": '(node["amenity"="bench"];node["leisure"="picnic_table"];node["barrier"="bollard"];node["amenity"="waste_basket"];'
                    'node["amenity"="recycling"];node["amenity"="bicycle_parking"];node["highway"="bus_stop"];node["amenity"="shelter"]["shelter_type"="public_transport"];);out;',
}
OSM_QUERIES = {
    "roads": 'way["highway"];out geom tags;',
    "water_parks": '(way["natural"="water"];relation["natural"="water"];way["leisure"~"^(park|garden)$"];'
                   'relation["leisure"~"^(park|garden)$"];);out geom tags;',
    "nodes": '(node["highway"="traffic_signals"];node["highway"="street_lamp"];'
             'node["highway"="crossing"]["crossing"="traffic_signals"];);out;',
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------------------------------------------- state files

def done_path(name: str) -> Path:
    return STATE / f"{name}.json"


def is_done(name: str) -> bool:
    return done_path(name).exists()


def mark_done(name: str, **info) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    S.atomic_write(done_path(name), json.dumps({"done": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **info}))


def read_done(name: str) -> dict:
    p = done_path(name)
    return json.loads(p.read_text()) if p.exists() else {}


def free_gb() -> float:
    return shutil.disk_usage(DATA).free / 1e9


def check_disk() -> None:
    f = free_gb()
    if f < MIN_FREE_GB:
        raise SystemExit(f"ABORT: only {f:.1f} GB free (< {MIN_FREE_GB} GB); stop and report")


def dump(o) -> str:
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))


def ensure_secrets(*names: str) -> None:
    """Fill os.environ from tools/adc-secret.sh for names that are unset (never printed)."""
    table = {"DATAFORDELER_USERNAME": "datafordeler-username", "DATAFORDELER_PASSWORD": "datafordeler-password",
             "DATAFORDELER_GRAPHQL_API_KEY": "datafordeler-graphql-api-key", "GSEARCH_TOKEN": "gsearch-token"}
    for n in names:
        if os.environ.get(n):
            continue
        out = subprocess.run([str(ROOT / "tools" / "adc-secret.sh"), table[n]], capture_output=True, text=True)
        if out.returncode != 0 or not out.stdout.strip():
            raise SystemExit(f"secret {table[n]} not available (tools/adc-secret.sh)")
        os.environ[n] = out.stdout.strip()


# ------------------------------------------------------------------------------------------------------- tiles/cells

def load_tiles() -> dict:
    doc = json.loads((CITY_DIR / "tiles.json").read_text())
    return {t["id"]: t for t in doc["tiles"]}


def cell_of(tid: str) -> str:
    return frame.lod2_cell_of_tile(tid)  # "<N km>_<E km>", the DHM / LoD2 cell


def cell_bbox_utm(cell: str) -> tuple[float, float, float, float]:
    n, e = (int(v) for v in cell.split("_"))
    return (e * 1000.0, n * 1000.0, e * 1000.0 + 1000.0, n * 1000.0 + 1000.0)


def cells_of(tiles: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for tid in sorted(tiles):
        out.setdefault(cell_of(tid), []).append(tid)
    return out


def city_bbox_utm(tiles: dict) -> tuple[float, float, float, float]:
    b = [t["bounds"] for t in tiles.values()]
    m = CITY_BBOX_MARGIN
    return (min(x[0] for x in b) - m, min(x[1] for x in b) - m, max(x[2] for x in b) + m, max(x[3] for x in b) + m)


def write_layer(tid: str, layer: str, payload: dict) -> int:
    """data/tiles/<tid>/<layer>.json, atomically; returns the byte size."""
    payload = {k: v for k, v in payload.items() if not (k == "ord" and not v)}
    txt = dump(payload)
    S.atomic_write(TILES_DIR / tid / f"{layer}.json", txt)
    return len(txt.encode())


class Layers:
    """tile id -> layer payloads being collected (same shape as tile_split.Tiles, restricted to the tiles we own)."""

    def __init__(self, allowed):
        self.allowed = allowed
        self.t = T.Tiles()
        self.dropped = Counter()

    def add(self, tid, layer, key, item, ordinal):
        if tid in self.allowed:
            self.t.add(tid, layer, key, item, ordinal)
        else:
            self.dropped[f"{layer}.{key}"] += 1


# ----------------------------------------------------------------------------------------------------------- fetch

def stage_fetch2(a, tiles) -> None:
    """Sources of stage 2 (surfaces, furniture, groundfloor) and the Frederiksberg GC2 tables, fetched citywide once."""
    if is_done("fetch2") and not a.force_stage("fetch2"):
        return
    ensure_secrets("DATAFORDELER_USERNAME", "DATAFORDELER_PASSWORD", "DATAFORDELER_GRAPHQL_API_KEY")
    from concurrent.futures import ThreadPoolExecutor

    import groundfloor as GF
    import frb

    bbox = city_bbox_utm(tiles)
    q2 = dict(OSM_QUERIES2)
    q2["groundfloor"] = GF.QUERY
    errors = {}

    def run(label, fn):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            errors[label] = str(e)[:200]
            log(f"[fetch2] {label} FAILED: {e}")

    def kk_all():
        for layer in KK_LAYERS2:
            run(f"kk:{layer}", lambda layer=layer: S.fetch_kk(layer, bbox, force=a.force_fetch))

    def osm_all():
        for key, body in q2.items():
            run(f"osm:{key}", lambda key=key, body=body: S.fetch_overpass(key, body, force=a.force_fetch))

    with ThreadPoolExecutor(3) as ex:
        fs = [ex.submit(kk_all), ex.submit(osm_all), ex.submit(run, "frb:gc2", lambda: frb.fetch_all(force=a.force_fetch))]
        for f in fs:
            f.result()
    if errors:
        log(f"[fetch2] incomplete: {errors}")
        mark_done("fetch2-partial", errors=errors)
        raise SystemExit(f"fetch2 incomplete: {errors}")
    mark_done("fetch2")


def stage_fetch(a, tiles, groups=("base", "points")) -> None:
    ensure_secrets("DATAFORDELER_USERNAME", "DATAFORDELER_PASSWORD", "DATAFORDELER_GRAPHQL_API_KEY")
    from concurrent.futures import ThreadPoolExecutor

    bbox = city_bbox_utm(tiles)
    layers = (KK_BASE if "base" in groups else []) + (KK_POINTS if "points" in groups else [])
    errors = {}

    def run(label, fn):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            errors[label] = str(e)[:200]
            log(f"[fetch] {label} FAILED: {e}")

    def kk_all():
        for layer in layers:
            run(f"kk:{layer}", lambda layer=layer: S.fetch_kk(layer, bbox, force=a.force_fetch))

    def osm_all():
        for key, body in OSM_QUERIES.items():
            run(f"osm:{key}", lambda key=key, body=body: S.fetch_overpass(key, body, force=a.force_fetch))

    with ThreadPoolExecutor(4) as ex:
        fs = [ex.submit(kk_all), ex.submit(osm_all),
              ex.submit(run, "geodk:bygning", lambda: S.fetch_geodk_bygning(bbox)),
              ex.submit(run, "bbr:0147", lambda: S.fetch_bbr("0147")),
              ex.submit(run, "bbr:0101", lambda: S.fetch_bbr("0101"))]
        for f in fs:
            f.result()
    if errors:
        raise SystemExit(f"fetch incomplete: {errors}")
    mark_done("fetch-" + "-".join(groups))


# --------------------------------------------------------------------------------------- buildings: merge + slice

def _load_json(p: Path):
    return json.loads(p.read_text())


def _geom_bounds(geom) -> tuple[float, float, float, float]:
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for s in c:
                walk(s)

    walk(geom["coordinates"])
    return min(xs), min(ys), max(xs), max(ys)


def merge_building_features(tiles: dict) -> tuple[list, dict]:
    """One footprint list in the KK `bygning` property schema (buildings.compile_buildings reads it):
    KK bygning, + KK bygning_kk supplement, + GeoDanmark Bygning (GEODKV) for every footprint KK does not have
    (all of Frederiksberg), with BBR attributes from the Datafordeler BBR GraphQL service."""
    import buildings as B

    kk = _load_json(RAW_CITY / "kk_bygning.json")
    kk2 = _load_json(RAW_CITY / "kk_bygning_kk.json") if (RAW_CITY / "kk_bygning_kk.json").exists() else None
    feats = list(kk["features"])
    extra = B.supplement_from_bygning_kk(kk, kk2)
    feats += extra
    have = {f["properties"].get("fot_id") for f in feats}
    stats = {"kk_bygning": len(kk["features"]), "kk_bygning_kk_extra": len(extra)}
    # code -> text tables learnt from the KK layer itself (it carries both)
    roof, wall = {}, {}
    for f in kk["features"]:
        p = f["properties"]
        if p.get("tagdaekningsmaterialekode") is not None and p.get("tagdaekningsmateriale"):
            roof[str(p["tagdaekningsmaterialekode"])] = p["tagdaekningsmateriale"]
        if p.get("ydervaeggensmaterialekode") is not None and p.get("ydervaeggensmateriale"):
            wall[str(p["ydervaeggensmaterialekode"])] = p["ydervaeggensmateriale"]
    stats["roof_codes"], stats["wall_codes"] = roof, wall
    bbr = {}
    for k in ("0147", "0101"):
        p = RAW_CITY / f"bbr_{k}.json"
        if p.exists():
            bbr.update(_load_json(p))
    gd = _load_json(RAW_CITY / "geodk_bygning.json")["features"] if (RAW_CITY / "geodk_bygning.json").exists() else []
    added = outside = no_bbr = 0
    for f in gd:
        p = f["properties"]
        fot = p.get("fot_id")
        if fot in have or fot is None:
            continue
        x0, y0, x1, y1 = _geom_bounds(f["geometry"])
        if frame.tile_of_point((x0 + x1) / 2, (y0 + y1) / 2) not in tiles:
            outside += 1  # a neighbouring kommune beyond the tiles
            continue
        b = bbr.get(p.get("bbruuid") or "")
        if b is None:
            no_bbr += 1
        use = b.get("byg021BygningensAnvendelse") if b else None
        props = {"fot_id": fot, "bygningid": p.get("bbruuid") if b else None, "bygningstype": p.get("bygningstype"),
                 "bygningensanvendelsekode": int(use) if use and str(use).isdigit() else None,
                 "opfoerelselsaar": b.get("byg026Opfoerelsesaar") if b else None,
                 "ydervaeggensmateriale": wall.get(str(b.get("byg032YdervaeggensMateriale"))) if b else None,
                 "tagdaekningsmateriale": roof.get(str(b.get("byg033Tagdaekningsmateriale"))) if b else None,
                 "antaletager": b.get("byg054AntalEtager") if b else None}
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": props})
        added += 1
    stats.update({"geodanmark_added": added, "geodanmark_added_without_bbr": no_bbr, "geodanmark_total": len(gd), "geodanmark_outside_tiles": outside,
                  "bbr_records": len(bbr)})
    return feats, stats


def stage_buildings0(a, tiles, cells) -> None:
    """Slice the merged footprint list per cell (+ margin) into data/raw/cells/<cell>/kk_bygning.json."""
    if is_done("buildings0") and not a.force_stage("buildings0"):
        return
    t0 = time.time()
    feats, stats = merge_building_features(tiles)
    per_cell: dict[str, list] = {c: [] for c in cells}
    m = CELL_MARGIN
    for f in feats:
        try:
            x0, y0, x1, y1 = _geom_bounds(f["geometry"])
        except (ValueError, KeyError, TypeError):
            continue
        for e in range(math.floor((x0 - m) / 1000), math.floor((x1 + m) / 1000) + 1):
            for n in range(math.floor((y0 - m) / 1000), math.floor((y1 + m) / 1000) + 1):
                c = f"{n}_{e}"
                if c in per_cell:
                    per_cell[c].append(f)
    for c, fs in per_cell.items():
        S.atomic_write(RAW_CELLS / c / "kk_bygning.json", dump({"type": "FeatureCollection", "features": fs}))
    # facade tones measured from oblique photos (appearance.py) exist for the district only: keep them for those ids
    dist = DATA / "cph-geodata.json"
    if dist.exists():
        g = _load_json(dist)
        ov = {b["id"]: {"ring": b["ring"], "observed": b["observed"]} for b in g["buildings"] if b.get("observed")}
        S.atomic_write(RAW_CITY / "district_observed.json", dump(ov))
        stats["district_observed"] = len(ov)
    stats["footprints"] = len(feats)
    stats["seconds"] = round(time.time() - t0, 1)
    mark_done("buildings0", **stats)
    log(f"[buildings0] {len(feats)} footprints into {len(per_cell)} cells: {stats}")


# ------------------------------------------------------------------------------------------------------------- geo

def _kk_cached(name):
    p = RAW_CITY / f"kk_{name}.json"
    return _load_json(p) if p.exists() else None


def _osm_cached(key):
    p = RAW_CITY / f"osm_{key}.json"
    return _load_json(p) if p.exists() else None


def stage_geo(a, tiles, cells) -> None:
    """Everything sparse, compiled once for the whole city: roads (so the graph is connected across tiles), roadGraph,
    cycle tracks, sidewalks, water, parks, signals, trees, bike racks, benches, street lights."""
    if is_done("geo") and not a.force_stage("geo"):
        return
    import fetch
    import points as P
    import roads as R

    t0 = time.time()
    frame.set_area(city_bbox_utm(tiles))
    fetch.cache_dir = lambda: RAW_CITY  # noqa: E731 - the compiler modules read their raw layers from the citywide cache
    kk = {n: _kk_cached(n) for n in KK_BASE + KK_POINTS}
    osm = {k: _osm_cached(k) for k in OSM_QUERIES}
    missing = [f"kk:{n}" for n, v in kk.items() if v is None] + [f"osm:{k}" for k, v in osm.items() if v is None]
    if missing:
        raise SystemExit(f"geo: missing raw layers {missing}; run --stage fetch")
    allowed = set(tiles)
    L = Layers(allowed)
    lap = lambda what: log(f"[geo] {what} ({time.time() - t0:.0f}s)")  # noqa: E731

    sig, sig_utm = P.signals(kk["trafiksignal_oversigt"], osm["nodes"])
    lap(f"signals {len(sig)}")
    roads, ways, names, rstats = R.compile_roads(
        osm["roads"], {k: kk.get(k) for k in ("Kommunevej", "trafikhastigheder", "ensrettede_gader", "cykelsti")}, sig_utm)
    lap(f"roads {len(roads)}")
    # keep what a tile owns; the graph is built from exactly that set, once
    keep = [i for i, r in enumerate(roads) if T.owner_of_line(r) in allowed]
    dropped_roads = len(roads) - len(keep)
    roads_k = [roads[i] for i in keep]
    ways_k = [(j, ways[i][1]) for j, i in enumerate(keep)]
    graph = R.build_road_graph(roads_k, ways_k, names, sig_utm)
    lap(f"roadGraph {len(graph['nodes']) // 2} nodes, {len(graph['links'])} links")
    comp = graph_components(graph)

    wp = osm["water_parks"]
    geo = {
        "roads": roads_k,
        "cycleTracks": P.cycle_tracks(kk["cykelsti"]),
        "sidewalks": P.sidewalks(kk["fortovsmatrikel"]),
        "water": P.water(wp),
        "parks": P.parks(kk["parkregister"], kk["park_groent_omr_oversigtskort"], wp),
    }
    lap("cycleTracks/sidewalks/water/parks")
    pts = {"signals": sig, "trees": P.trees(kk["trae_basis"], kk["automatisk_detekterede_traeer_kk_beta"]),
           "bikeRacks": P.bike_racks(kk["cykelstativ"], kk["dp_byinventar_l"]), "benches": P.benches(kk["baenke_borde_puma"]),
           "lights": P.lights(osm["nodes"])}
    lap("points " + str({k: len(v) for k, v in pts.items()}))
    if (RAW_CITY / "frb" / "_status.json").exists():
        import frb

        pts, rows = frb.apply_points(pts, _osm_cached("street_nodes"))
        sw = frb.sidewalk_rings(geo["sidewalks"])
        geo["sidewalks"] += sw
        rows.append({"item": "pavements (sidewalks)", "source": "GC2 stab.fortovsareal (staff schema, provenance unclear)", "count": len(sw),
                     "note": "polygons as published; KK fortovsmatrikel is KK-only"})
        add_substitutions(rows)
    else:
        log("[geo] no Frederiksberg GC2 tables yet (run --stage fetch2): Frederiksberg trees/racks/benches/pavements are missing")

    for key in T.GEO_LINES:
        for i, it in enumerate(geo[key]):
            L.add(T.owner_of_line(it), "roads", key, it, i)
    for key in T.GEO_RINGS:
        for i, it in enumerate(geo[key]):
            L.add(T.owner_of_ring(it), "roads", key, it, i)
    for key, items in pts.items():
        for i, it in enumerate(items):
            L.add(T.owner_of_point(it), "roads", f"points.{key}", it, i)
    # a tile's roads file also exists (empty lists omitted) for tiles that only own e.g. a tree
    n_files = 0
    for tid in tiles:
        payload = L.t.layers.get(tid, {}).get("roads")
        if payload:
            write_layer(tid, "roads", payload)
            n_files += 1
        elif (TILES_DIR / tid / "roads.json").exists():
            (TILES_DIR / tid / "roads.json").unlink()  # stale file from an earlier build
    S.atomic_write(CITY_DIR / "roadgraph.json", dump(graph))

    geo_meta = {"version": GEO_VERSION, "generated": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
                "road_stats": dict(rstats), "roads_dropped_outside_tiles": dropped_roads,
                "counts": {**{k: len(v) for k, v in geo.items()}, **{f"points.{k}": len(v) for k, v in pts.items()}},
                "dropped_outside_tiles": dict(L.dropped), "points_keys": list(pts)}
    S.atomic_write(WORK / "geo_meta.json", dump(geo_meta))
    S.atomic_write(WORK / "graph_stats.json", dump(comp))
    build_lakes_citywide(geo, tiles)
    mark_done("geo", seconds=round(time.time() - t0, 1), roads=len(roads_k), tiles_with_roads=n_files, components=comp)
    log(f"[geo] done in {time.time() - t0:.0f}s; graph {comp}")


def graph_components(graph: dict) -> dict:
    """Connected components of the road graph (nodes that appear in a link), largest first."""
    import roadgraph as RG

    links = [(l[0], l[1]) for l in graph["links"]]
    sizes = RG.components(len(graph["nodes"]) // 2, links)
    used = sum(sizes)
    return {"nodes": len(graph["nodes"]) // 2, "links": len(links), "components": len(sizes), "largest": sizes[:10],
            "largest_share": round(sizes[0] / used, 4) if sizes else 0, "nodes_in_small_components": used - (sizes[0] if sizes else 0),
            "singletons_or_pairs": sum(1 for s in sizes if s <= 2)}


def add_substitutions(rows: list) -> None:
    """Rows of the 'Frederiksberg substitutions' table in coverage.md (keyed by `item`; a re-run replaces its rows)."""
    p = WORK / "frb_substitutions.json"
    cur = json.loads(p.read_text()) if p.exists() else []
    have = {r["item"] for r in rows}
    S.atomic_write(p, dump([r for r in cur if r["item"] not in have] + rows))


def build_lakes_citywide(geo: dict, tiles: dict) -> None:
    import lakes as LK

    doc = LK.build_lakes({"water": geo["water"], "parks": geo["parks"]}, None)
    S.atomic_write(CITY_DIR / "lakes.json", dump(doc))
    log(f"[geo] lakes.json: {len(doc['lakes'])} lakes, {len(doc['ponds'])} ponds, {len(doc['bridges'])} bridge strips")


# ------------------------------------------------------------------------------------------------------------ cells

def dhm_cell(work: Path, core, token: str):
    """DSM + DTM 1 m for the cell core grown by DHM_MARGIN: 2x2 WCS requests of <= 800 m per coverage, cached as GeoTIFFs
    in the cell folder (deleted by the caller). Returns ({'dsm': Raster, 'dtm': Raster}, (dtm array, transform))."""
    import numpy as np
    import rasterio
    from rasterio.merge import merge

    import dhm

    e0, n0, e1, n1 = core
    x0, y0, x1, y1 = e0 - DHM_MARGIN, n0 - DHM_MARGIN, e1 + DHM_MARGIN, n1 + DHM_MARGIN
    nx = ny = 2
    sx, sy = (x1 - x0) / nx, (y1 - y0) / ny
    out, dtm = {}, None
    for key, cov in (("dsm", "dhm_overflade"), ("dtm", "dhm_terraen")):
        srcs = []
        for i in range(nx):
            for j in range(ny):
                p = work / f"dhm_{key}_{i}_{j}.tif"
                if not p.exists():
                    bx0, by0 = x0 + i * sx, y0 + j * sy
                    params = dict(SERVICE="WCS", REQUEST="GetCoverage", VERSION="1.0.0", COVERAGE=cov, FORMAT="GTiff", CRS="EPSG:25832",
                                  BBOX=f"{bx0:.2f},{by0:.2f},{bx0 + sx:.2f},{by0 + sy:.2f}", WIDTH=int(sx), HEIGHT=int(sy))
                    r = S.request("GET", dhm.WCS, what=f"dhm:{key}", params=params, headers={"token": token})
                    if r.status_code in (401, 403):
                        raise RuntimeError(f"DHM WCS refused the token (http {r.status_code})")
                    r.raise_for_status()
                    if r.content[:4] not in (b"II*\x00", b"MM\x00*"):
                        raise RuntimeError(f"WCS {cov} returned non-TIFF")
                    p.write_bytes(r.content)
                srcs.append(rasterio.open(p))
        arr, t = merge(srcs, res=1.0)
        for s in srcs:
            s.close()
        out[key] = dhm.Raster(arr[0].astype("float32"), t, None)
        if key == "dtm":
            dtm = (arr[0].astype("float64"), t)
    return out, dtm


def _shift_ring(r, dx, dz):
    return [v - (dx if i % 2 == 0 else dz) for i, v in enumerate(r)]


def terrain_for_cell(cell, core, dtm, blds_all, owned_ids, tids, lakes_doc):
    """DTM 2 m grid for the cell, building footprints re-filled, street zone smoothed (terrain.py's pipeline on a grid
    centred on the cell), cut into one int16 chunk per 500 m tile."""
    import numpy as np

    import terrain as TR

    e0, n0, e1, n1 = core
    ce, cn = (e0 + e1) / 2, (n0 + n1) / 2
    half = (e1 - e0) / 2 + DHM_MARGIN
    cx, cz = frame.to_local(ce, cn)
    arr, t = dtm
    raw = TR.resample(arr, t, half=half, cell=TERRAIN_CELL, origin=(ce, cn, frame.ORIGIN[2]))
    sh = lambda r: _shift_ring(r, cx, cz)  # noqa: E731
    bl = [{"id": b["id"], "ring": sh(b["ring"])} for b in blds_all]
    mask = TR.ring_mask([b["ring"] for b in bl], half, TERRAIN_CELL)
    grid = TR.fill_masked(raw, mask)
    # street zone from the roads / sidewalks of the tiles around the cell (written by the geo stage)
    around = frame.tiles_for_bbox((e0, n0, e1, n1), margin=DHM_MARGIN + 20)
    roads, sidewalks = [], []
    for tid in around:
        p = TILES_DIR / tid / "roads.json"
        if p.exists():
            d = _load_json(p)
            roads += [{"class": r.get("class"), "pts": _shift_ring(r["pts"], cx, cz)} for r in d.get("roads", [])]
            sidewalks += [{"ring": sh(s["ring"])} for s in d.get("sidewalks", [])]
    lk = {"lakes": [], "ponds": []}
    if lakes_doc:
        for k in ("lakes", "ponds"):
            for l in lakes_doc.get(k, []):
                r = l["ring"]
                xs, zs = r[0::2], r[1::2]
                if max(xs) > cx - half and min(xs) < cx + half and max(zs) > cz - half and min(zs) < cz + half:
                    lk[k].append({**l, "ring": sh(r), "holes": [sh(h) for h in l.get("holes", [])]})
        lk["bridges"] = []
    geo = {"roads": roads, "sidewalks": sidewalks, "buildings": bl}
    grid = TR.smooth_streets(grid, TR.street_zone(geo, None, lk, half, TERRAIN_CELL), cell=TERRAIN_CELL)
    out = {}
    cm = np.clip(np.round(grid * 100.0), -32768, 32767).astype("<i2")
    bground = TR.building_ground([b for b in bl if b["id"] in owned_ids], grid, half, TERRAIN_CELL)
    for tid in tids:
        xmin, zmin, xmax, zmax = frame.tile_bounds_local(tid)
        c0 = round((xmin - (cx - half)) / TERRAIN_CELL)
        r0 = round((zmin - (cz - half)) / TERRAIN_CELL)
        w = round((xmax - xmin) / TERRAIN_CELL)
        h = round((zmax - zmin) / TERRAIN_CELL)
        sub = np.ascontiguousarray(cm[r0:r0 + h, c0:c0 + w])
        out[tid] = {"chunk": {"x0": xmin, "z0": zmin, "w": int(sub.shape[1]), "h": int(sub.shape[0]), "cell": TERRAIN_CELL,
                              "data": base64.b64encode(sub.tobytes()).decode()},
                    "min": float(sub.min()) / 100.0, "max": float(sub.max()) / 100.0}
    return out, bground


def cell_job(cell: str, tids: list[str], force: bool = False) -> dict:
    """buildings + terrain for one 1 km cell. Returns a small result dict; exceptions are returned, not raised."""
    name = f"cell-{cell}-core"
    t0 = time.time()
    if is_done(name) and not force:
        return {"cell": cell, "skipped": True}
    if free_gb() < MIN_FREE_GB:
        return {"cell": cell, "error": "low-disk"}
    work = RAW_CELLS / cell
    try:
        import buildings as B
        import fetch

        ensure_secrets("GSEARCH_TOKEN")
        core = cell_bbox_utm(cell)
        e0, n0, e1, n1 = core
        frame.set_area((e0 - CELL_MARGIN, n0 - CELL_MARGIN, e1 + CELL_MARGIN, n1 + CELL_MARGIN))
        fetch.cache_dir = lambda: work  # noqa: E731
        import dhm

        rasters, dtm = dhm_cell(work, core, os.environ["GSEARCH_TOKEN"])
        feats = _load_json(work / "kk_bygning.json")
        blds, stats = B.compile_buildings(feats, rasters, dhm)
        for b in blds:
            b.pop("preset", None)
        allowed = set(tids)
        mine = [b for b in blds if T.owner_of_ring(b) in allowed]
        overlay = apply_district_observed(mine)
        by_tile: dict[str, list] = {}
        for b in mine:
            by_tile.setdefault(T.owner_of_ring(b), []).append(b)
        lakes_p = CITY_DIR / "lakes.json"
        terr, bground = terrain_for_cell(cell, core, dtm, blds, {b["id"] for b in mine}, tids, _load_json(lakes_p) if lakes_p.exists() else None)
        sizes = {}
        for tid in tids:
            bl = by_tile.get(tid, [])
            if bl:
                write_layer(tid, "buildings", {"tile": tid, "ord": {"buildings": list(range(len(bl)))}, "buildings": bl})
            elif (TILES_DIR / tid / "buildings.json").exists():
                (TILES_DIR / tid / "buildings.json").unlink()
            tb = {b["id"]: bground[b["id"]] for b in bl if b["id"] in bground}
            sizes[tid] = write_layer(tid, "terrain", {"tile": tid, "ord": {}, "chunk": terr[tid]["chunk"], "buildings": tb})
        S.atomic_write(WORK / "terrain_range" / f"{cell}.json", dump({t: [terr[t]["min"], terr[t]["max"]] for t in tids}))
        res = {"cell": cell, "buildings": len(mine), "compiled": len(blds), "stats": stats, "observed_overlay": overlay,
               "seconds": round(time.time() - t0, 1)}
        mark_done(name, **{k: v for k, v in res.items() if k != "cell"})
        for p in work.glob("dhm_*.tif"):
            p.unlink()
        return res
    except SystemExit as e:
        return {"cell": cell, "error": f"exit: {e}"}
    except Exception as e:  # noqa: BLE001
        return {"cell": cell, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-600:]}


_OBSERVED = None


def apply_district_observed(blds: list) -> dict:
    """Copy `observed` (photo-measured wall tones) onto buildings whose footprint is the same as in the district file."""
    global _OBSERVED
    p = RAW_CITY / "district_observed.json"
    if _OBSERVED is None:
        _OBSERVED = _load_json(p) if p.exists() else {}
    n = mism = 0
    for b in blds:
        o = _OBSERVED.get(b["id"])
        if not o:
            continue
        r0, r1 = o["ring"], b["ring"]
        if len(r0) == len(r1) and max((abs(x - y) for x, y in zip(r0, r1)), default=0) < 0.6:
            b["observed"] = o["observed"]
            n += 1
        else:
            mism += 1
    return {"applied": n, "footprint_changed": mism} if (n or mism) else {}


def stage_cells(a, tiles, cells) -> None:
    ensure_secrets("GSEARCH_TOKEN")
    todo = [c for c in sorted(cells) if (not a.cells or c in a.cells) and (a.force_stage("cells") or not is_done(f"cell-{c}-core"))]
    log(f"[cells] {len(todo)} of {len(cells)} cells to do, {a.workers} workers, {free_gb():.1f} GB free")
    if not todo:
        return
    if any(not (RAW_CELLS / c / "kk_bygning.json").exists() for c in todo):  # slices are deleted when the city is done (20 s to rebuild)
        a2 = argparse.Namespace(**vars(a))
        a2.force_stage = lambda s: s == "buildings0"
        stage_buildings0(a2, tiles, cells)
    t0 = time.time()
    errors = {}
    import multiprocessing as mp

    with ProcessPoolExecutor(a.workers, mp_context=mp.get_context("spawn")) as ex:
        futs = {ex.submit(cell_job, c, cells[c], a.force_stage("cells")): c for c in todo}
        for n, f in enumerate(as_completed(futs), 1):
            r = f.result()
            c = futs[f]
            if r.get("error"):
                errors[c] = r["error"]
                log(f"[cells] {c} FAILED: {r['error']} {r.get('trace', '')[-200:]}")
                if r["error"] == "low-disk":
                    for g in futs:
                        g.cancel()
                    raise SystemExit("ABORT: low disk space")
            else:
                log(f"[cells] {n}/{len(todo)} {c}: {r.get('buildings', '-')} buildings in {r.get('seconds', '-')}s; {free_gb():.1f} GB free")
    log(f"[cells] done in {time.time() - t0:.0f}s, {len(errors)} failed {errors}")
    if errors:
        raise SystemExit(f"{len(errors)} cells failed: {errors}")


# ----------------------------------------------------------------------------------------------- index + meta + report

def scan_tiles(tiles: dict) -> dict:
    """Index entries from what is on disk (layer file sizes, per-layer counts)."""
    out = {}
    for tid in sorted(tiles):
        d = TILES_DIR / tid
        if not d.is_dir():
            continue
        entry = {"utm": list(frame.tile_bounds_utm(tid)), "local": list(frame.tile_bounds_local(tid)), "layers": {}, "counts": {}}
        for p in sorted(d.iterdir()):
            if p.suffix == ".json":
                entry["layers"][p.stem] = p.stat().st_size
                entry["counts"][p.stem] = T.counts_of(p.stem, json.loads(p.read_text()))
            elif p.name == "lod2.bin":
                entry["layers"]["lod2.bin"] = p.stat().st_size
        if not entry["layers"]:
            continue
        entry["bytes"] = sum(entry["layers"].values())
        out[tid] = entry
    return out


def city_local_bbox(tiles: dict) -> list[float]:
    bs = [frame.tile_bounds_local(t) for t in tiles]
    return [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)]


def stage_index(a, tiles, cells) -> None:
    import numpy as np

    idx_tiles = scan_tiles(tiles)
    bbox = city_local_bbox(tiles)
    old = DISTRICT_REF / "meta.json"
    meta = _load_json(old) if old.exists() else {}
    gm = _load_json(WORK / "geo_meta.json") if (WORK / "geo_meta.json").exists() else None
    # geodata block: what is not tile-owned
    g = dict(meta.get("geodata", {}))
    if gm:
        g.update({"version": GEO_VERSION, "generated": gm["generated"], "points_keys": gm["points_keys"],
                  "frame": {"epsg": 25832, "vertical": "DVR90", "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": bbox}})
        g["attribution"] = [
            "Indeholder data fra Klimadatastyrelsen / GeoDanmark (Bygning), BBR og Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens).",
            "© OpenStreetMap contributors (ODbL)",
            "Københavns Kommune open data: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister",
            "Frederiksberg Kommune: GeoDanmark Bygning, BBR og DHM (SDFI); øvrigt fra OSM",
        ]
        m = dict(g.get("meta", {}))
        m.update({"road_stats": gm["road_stats"], "roads_dropped_outside_tiles": gm["roads_dropped_outside_tiles"],
                  "scope": "Københavns + Frederiksberg Kommune (build_city.py)"})
        b0 = read_done("buildings0")
        if b0:
            m["building_sources"] = {k: v for k, v in b0.items() if k not in ("done", "roof_codes", "wall_codes")}
        g["meta"] = m
    meta["geodata"] = g
    # terrain header from the tile chunks
    terr = [(tid, e) for tid, e in idx_tiles.items() if "terrain" in e["layers"]]
    if terr:
        lo, hi = 1e9, -1e9
        for p in (WORK / "terrain_range").glob("*.json"):
            for mn, mx in _load_json(p).values():
                lo, hi = min(lo, mn), max(hi, mx)
        cellm = TERRAIN_CELL
        t = {"version": "cph-terrain/1", "frame": [],
             "method": f"DHM/Terrain {cellm:g} m mean per 1 km cell, building footprints (+{0.6} m) re-filled from surrounding ground, street zone low-passed; "
                       "int16 cm, row = z, col = x; sea = 0 m DVR90; citywide (build_city.py)",
             "bbox": bbox, "cell": cellm, "width": round((bbox[2] - bbox[0]) / cellm), "height": round((bbox[3] - bbox[1]) / cellm),
             "min": round(lo, 2), "max": round(hi, 2), "lakes": [], "ponds": [], "bridges": [],
             "cut": {"cell": 4.0, "half": 750.0, "skip": [], "pieces": []}}
        meta["terrain"] = t
    for part in sorted((WORK / "meta_parts").glob("*.json")) if (WORK / "meta_parts").exists() else []:
        meta[part.stem] = _load_json(part)  # surfaces, furniture, vegetation, entrances, groundfloor: citywide headers
    S.atomic_write(CITY_DIR / "meta.json", dump(meta))
    total = sum(e["bytes"] for e in idx_tiles.values())
    index = {"version": T.VERSION, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tileSize": frame.TILE_SIZE,
             "frame": {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": bbox},
             "city": {"meta": "../city/meta.json", "roadgraph": "../city/roadgraph.json",
                      "streets": "../city/streets.json" if (CITY_DIR / "streets.json").exists() else None,
                      "lakes": "../city/lakes.json" if (CITY_DIR / "lakes.json").exists() else None},
             "tiles": idx_tiles, "bytes": total}
    S.atomic_write(TILES_DIR / "index.json", dump(index))
    log(f"[index] {len(idx_tiles)} tiles, {total / 1e6:.1f} MB; meta.json {(CITY_DIR / 'meta.json').stat().st_size / 1e6:.2f} MB")


STAGES = ["fetch", "fetch2", "buildings0", "geo", "cells", "surfaces", "furniture", "groundfloor", "streets", "entrances", "cellsinput", "vegetation", "lod2", "index", "report"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", action="append", choices=STAGES + ["all"], help="stages to run (default: all); repeatable")
    ap.add_argument("--workers", type=int, default=4, help="parallel cell workers (<= 6)")
    ap.add_argument("--cells", nargs="*", default=None, help="only these 1 km cells, e.g. 6176_723")
    ap.add_argument("--force", action="append", default=[], metavar="STAGE", help="redo a stage (or 'cells') even if done")
    ap.add_argument("--veg-workers", type=int, default=3, help="parallel LiDAR cell downloads / derivations (the server gives about 1 MB/s per connection)")
    ap.add_argument("--veg-limit", type=int, default=0, help="at most this many vegetation raster cells per run (0 = all)")
    ap.add_argument("--veg-rasters-only", action="store_true", help="vegetation: derive the rasters (LiDAR classes, NDVI) but do not compile yet")
    ap.add_argument("--streets-workers", type=int, default=3, help="parallel cells for the streets stage")
    ap.add_argument("--force-fetch", action="store_true", help="refetch raw source layers")
    a = ap.parse_args(argv)
    a.workers = max(1, min(6, a.workers))
    a.veg_workers = max(1, min(6, a.veg_workers))
    a.streets_workers = max(1, min(6, a.streets_workers))
    a.force_stage = lambda s: s in a.force or "all" in a.force  # noqa: E731
    stages = STAGES if not a.stage or "all" in a.stage else [s for s in STAGES if s in a.stage]
    tiles = load_tiles()
    cells = cells_of(tiles)
    if a.cells:
        bad = [c for c in a.cells if c not in cells]
        if bad:
            raise SystemExit(f"unknown cells {bad}")
    check_disk()
    log(f"{len(tiles)} tiles in {len(cells)} cells; stages {stages}; {free_gb():.1f} GB free")
    for s in stages:
        t0 = time.time()
        check_disk()
        if s == "fetch":
            if not (is_done("fetch-base-points") and not a.force_stage("fetch")):
                stage_fetch(a, tiles)
        elif s == "fetch2":
            stage_fetch2(a, tiles)
        elif s == "buildings0":
            stage_buildings0(a, tiles, cells)
        elif s == "geo":
            stage_geo(a, tiles, cells)
        elif s == "cells":
            stage_cells(a, tiles, cells)
        elif s in ("surfaces", "furniture", "groundfloor", "streets"):
            import city_layers

            getattr(city_layers, f"stage_{s}")(a, tiles, cells)
        elif s in ("entrances", "vegetation", "cellsinput", "lod2"):
            import city_layers2

            getattr(city_layers2, f"stage_{s}")(a, tiles, cells)
        elif s == "index":
            stage_index(a, tiles, cells)
        elif s == "report":
            import city_report

            city_report.write_report(tiles, cells)
        log(f"stage {s}: {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
