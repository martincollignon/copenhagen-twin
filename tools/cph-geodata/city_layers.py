"""Stage 2 of build_city.py: surfaces, furniture, groundfloor (and the Frederiksberg substitutions) for the whole city.

These layers are sparse, so they are compiled once citywide (area = the city bbox) with the same functions the district build
uses, reading the citywide raw layers under data/raw/city/ (fetch.cache_dir is pointed there), and then cut into the 500 m
tiles by centroid ownership exactly as tile_split.py does. Entrances and vegetation are per-cell / per-street jobs and live in
city_layers2.py.
"""
from __future__ import annotations

import json
import sys
import time

import build_city as BC
import city_sources as S
import frame
import tile_split as T

log = BC.log


def _citywide(tiles):
    import fetch

    frame.set_area(BC.city_bbox_utm(tiles))
    fetch.cache_dir = lambda: BC.RAW_CITY  # noqa: E731
    return fetch


def _put_meta(name: str, meta: dict) -> None:
    S.atomic_write(BC.WORK / "meta_parts" / f"{name}.json", BC.dump(meta))


def _write_tiles(L: BC.Layers, layer: str, tiles: dict) -> int:
    """Write the layer files from collected payloads; tiles that got nothing lose a stale file of an earlier build."""
    n = 0
    for tid in tiles:
        payload = L.t.layers.get(tid, {}).get(layer)
        if payload:
            BC.write_layer(tid, layer, payload)
            n += 1
        elif (BC.TILES_DIR / tid / f"{layer}.json").exists():
            (BC.TILES_DIR / tid / f"{layer}.json").unlink()
    return n


def load_tile_lists(tiles: dict, layer: str, keys: list[str]) -> dict[str, list]:
    out = {k: [] for k in keys}
    for tid in sorted(tiles):
        p = BC.TILES_DIR / tid / f"{layer}.json"
        if p.exists():
            d = json.loads(p.read_text())
            for k in keys:
                out[k] += d.get(k, [])
    return out


_add_subst = BC.add_substitutions


# ----------------------------------------------------------------------------------------------------------- surfaces

def stage_surfaces(a, tiles, cells) -> None:
    if BC.is_done("surfaces") and not a.force_stage("surfaces"):
        return
    t0 = time.time()
    _citywide(tiles)
    import frb
    import surfaces

    out = BC.WORK / "surfaces_city.json"
    argv = sys.argv
    sys.argv = ["surfaces.py", "--bbox", *map(str, BC.city_bbox_utm(tiles)), "--out", str(out)]
    try:
        surfaces.main()
    finally:
        sys.argv = argv
    doc = json.loads(out.read_text())
    crossings = frb.crossing_markings()
    doc["markings"] += crossings
    doc["attribution"] = doc.get("attribution", []) + ["Frederiksberg Kommune GC2: fodgængerfelter", "© OpenStreetMap contributors (ODbL)"]
    L = BC.Layers(set(tiles))
    for i, s in enumerate(doc["surfaces"]):
        L.add(T.owner_of_ring(s), "surfaces", "surfaces", s, i)
    for i, m in enumerate(doc["markings"]):
        L.add(T.owner_of_ring(m), "surfaces", "markings", m, i)
    n = _write_tiles(L, "surfaces", tiles)
    meta = {k: v for k, v in doc.items() if k not in ("surfaces", "markings")}
    meta["frame"] = {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": BC.city_local_bbox(tiles)}
    _put_meta("surfaces", meta)
    _add_subst([
        {"item": "surface materials (paving classes)", "source": "none (KK dp_belaegninger is KK-only); OSM place=square / pedestrian areas citywide",
         "count": 0, "note": "Frederiksberg pavements are drawn from the sidewalk polygons with the engine's default Københavnerfortov; roads default asphalt"},
        {"item": "pedestrian crossings (markings)", "source": "GC2 vej.fodgaengerfelt", "count": len(crossings),
         "note": "line buffered to a 3 m strip (width inferred); no other marking register exists (no lane paint, arrows, bays, blue cycle fields)"},
    ])
    BC.mark_done("surfaces", seconds=round(time.time() - t0, 1), tiles=n, surfaces=len(doc["surfaces"]), markings=len(doc["markings"]))
    log(f"[surfaces] {len(doc['surfaces'])} surfaces + {len(doc['markings'])} markings in {n} tiles ({time.time() - t0:.0f}s)")


# ----------------------------------------------------------------------------------------------------------- furniture

def movia_stops_citywide(bbox) -> dict:
    """Movia Stoppestedsudstyr (ArcGIS MapServer) for the city bbox, paged (the service caps a response)."""
    import furniture as F

    path = BC.RAW_CITY / "movia_stoppestedsudstyr.json"
    if path.exists():
        return json.loads(path.read_text())
    x0, y0, x1, y1 = bbox
    feats, off = [], 0
    while True:
        r = S.request("GET", F.MOVIA, what="movia", params={
            "where": "1=1", "geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope", "inSR": "25832", "outSR": "25832",
            "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "f": "json", "returnGeometry": "true",
            "resultOffset": off, "resultRecordCount": 1000})
        r.raise_for_status()
        d = r.json()
        got = d.get("features", [])
        feats += got
        if not got or not d.get("exceededTransferLimit"):
            break
        off += len(got)
    doc = {"features": feats}
    S.atomic_write(path, BC.dump(doc))
    return doc


def stage_furniture(a, tiles, cells) -> None:
    if BC.is_done("furniture") and not a.force_stage("furniture"):
        return
    t0 = time.time()
    fetch = _citywide(tiles)
    import frb
    import furniture as F

    bbox = BC.city_bbox_utm(tiles)
    movia = movia_stops_citywide(bbox)
    F.movia_stops = lambda refresh: movia  # noqa: E731 - the module fetches per area without paging
    rl = load_tile_lists(tiles, "roads", ["roads", "water", "points.trees"])
    bl = load_tile_lists(tiles, "buildings", ["buildings"])
    geo = {"roads": rl["roads"], "water": rl["water"], "buildings": bl["buildings"], "points": {"trees": rl["points.trees"]}}
    log(f"[furniture] inputs: {len(geo['roads'])} roads, {len(geo['buildings'])} buildings, {len(geo['points']['trees'])} geodata trees")
    roads = F.RoadIndex(geo["roads"])
    kk = lambda name: fetch.kk_layer(name)  # noqa: E731 - cached citywide files
    doc = {
        "version": "cph-furniture/1", "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "frame": {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up", "bbox": BC.city_local_bbox(tiles)},
        "yaw": "direction the object faces: model +z -> (sin yaw, cos yaw) in (x, z); bays/racks: axis of the row/car",
        "attribution": [
            "Københavns Kommune open data (CC BY 4.0): trae_basis, pullert, affaldskurve, parkeringspladser, parkomater, ask_glascontainer, monumenter, cykelstativ",
            "Citelum / Københavns Kommune, Belysning master + wirer + ledninger (CC BY 4.0)",
            "Movia Stoppestedsudstyr (licence not stated)",
            "KK automatisk detekterede træer (beta), byinventar (licence not stated: confirm with bydata@kk.dk before redistribution)",
            "Frederiksberg Kommune GC2 (licence not stated): træregister, skraldespande, cykelstativer, bænke, glascontainere, busstoppesteder, parkeringspladser, monumenter",
            "© OpenStreetMap contributors (ODbL): Frederiksberg bollards, street lamps, waste baskets",
        ],
        "licences": {F.LIC_KK: "Creative Commons Attribution 4.0", F.LIC_NONE: "dataset has no licence statement; treat as unconfirmed",
                     "ODbL": "Open Database License 1.0"},
    }
    doc["trees"] = F.build_trees(kk, geo)
    log(f"[furniture] trees {len(doc['trees'])} ({time.time() - t0:.0f}s)")
    doc["lamps"] = F.build_lamps(roads, geo["buildings"], False)
    doc["parkingBays"] = F.build_parking(kk, roads)
    simple, _extra = F.build_simple(kk, roads)
    doc.update(simple)
    doc["bikeRacks"] = F.build_bike_racks(kk, roads)
    doc["busStops"] = F.build_bus_stops(False, roads)
    doc["lakeLights"] = F.build_lake_lights(geo, roads)
    log(f"[furniture] KK/Citelum/Movia lists done ({time.time() - t0:.0f}s)")

    # Frederiksberg: GC2 registers + OSM
    osm_nodes = json.loads((BC.RAW_CITY / "osm_street_nodes.json").read_text()) if (BC.RAW_CITY / "osm_street_nodes.json").exists() else None
    osm_lamps = json.loads((BC.RAW_CITY / "osm_nodes.json").read_text())
    fr, _ = frb.furniture(F, roads, osm_nodes)
    poly = frb.frb_polygon()
    n_before = {k: len(doc[k]) for k in fr}
    have_bus = frb._Grid([(b["x"], b["z"]) for b in doc["busStops"]])
    for k, items in fr.items():
        if k == "busStops":
            items = [b for b in items if not have_bus.near(b["x"], b["z"], 15.0)]
        doc[k] = doc.get(k, []) + items
    # benches / bike racks from the Frederiksberg point registers (same records as the geodata points, with a yaw)
    for b in frb.bench_points(poly, osm_nodes):
        doc["benches"].append({"x": b["x"], "z": b["z"], "yaw": F.face_road(roads, b["x"], b["z"]), "length": 1.8, "src": b["src"],
                               "conf": "observed", "conf_fields": {"yaw": "inferred", "length": "inferred"}, "licence": frb.LIC})
    for r in frb.rack_points():
        s = F.side_to_road(roads, r["x"], r["z"])
        doc["bikeRacks"].append({"x": r["x"], "z": r["z"], "yaw": round(math_atan2(s[2], s[3]), 3) if s else 0.0, "capacity": r["capacity"],
                                 "src": r["src"], "conf": "observed", "conf_fields": {**r.get("conf_fields", {}), "yaw": "inferred"}, "licence": frb.LIC})
    # street lamps: OSM street_lamp nodes inside Frederiksberg (no lamp register is published); fixture details are defaults
    n_lamps = 0
    for el in osm_lamps.get("elements", []):
        if el.get("type") != "node" or el.get("tags", {}).get("highway") != "street_lamp":
            continue
        e, n = frb.S_to_utm(el["lon"], el["lat"])
        if not poly.contains(frb._point(e, n)):
            continue
        x, z = frb._local((e, n))
        c = F.classify_lamp(None, None, None)
        doc["lamps"].append({"x": x, "z": z, "yaw": F.face_road(roads, x, z), "mount": "mast", "pole": "tube", "pole_h": 6.0, "arm": None,
                             "pole_text": None, "fixture": None, "source_text": None, **c, "installed": None,
                             "src": [f"osm:node/{el['id']}"], "conf": "observed",
                             "conf_fields": {"mount": "inferred", "pole": "inferred", "pole_h": "inferred", "light": "inferred", "cct": "inferred"},
                             "licence": "ODbL"})
        n_lamps += 1
    added = {k: len(doc[k]) - n_before.get(k, 0) for k in fr}
    doc["stats"] = {k: len(v) for k, v in doc.items() if isinstance(v, list)}
    doc["stats"]["frederiksberg_added"] = {**added, "lamps": n_lamps}

    L = BC.Layers(set(tiles))
    for key in T.FURNITURE_LISTS:
        for i, it in enumerate(doc.get(key, [])):
            L.add(T.owner_of_point(it), "furniture", key, it, i)
    n = _write_tiles(L, "furniture", tiles)
    meta = T._without(doc, T.FURNITURE_LISTS)
    meta["list_keys"] = [k for k in T.FURNITURE_LISTS if k in doc]
    _put_meta("furniture", meta)
    _add_subst([
        {"item": "street lamps", "source": "OSM highway=street_lamp (no Frederiksberg lamp inventory is open)", "count": n_lamps,
         "note": "mast type, height 6 m, light source and colour temperature are defaults (inferred); no wire-suspended lamps"},
        {"item": "bollards", "source": "OSM barrier=bollard (no register)", "count": added.get("bollards", 0), "note": "material/colour defaults (inferred)"},
        {"item": "bins, glass containers", "source": "GC2 byrum.skraldespande, affald.glascontainere (+ OSM waste baskets)",
         "count": added.get("bins", 0) + added.get("glassContainers", 0), "note": "bin stands (ask_standpladser) not available"},
        {"item": "bus stops", "source": "Movia Stoppestedsudstyr (regional) + GC2 busstoppesteder_frederiksberg where Movia has none within 15 m",
         "count": added.get("busStops", 0), "note": "GC2 stops: shelter/bin/countdown flags from the table, bench/cycle parking unknown"},
        {"item": "parking bays", "source": "GC2 mobilitet.parkeringspladser (polygons)", "count": added.get("parkingBays", 0),
         "note": "bay kind and orientation inferred from the polygon shape; occupancy by the engine as elsewhere"},
        {"item": "monuments", "source": "GC2 byrum_ekstern.monumenter (current versions)", "count": added.get("monuments", 0), "note": ""},
        {"item": "benches, bike racks (furniture lists)", "source": "GC2 byrum.baenk + OSM; GC2 cykelstativer + 2020 cykelparkering",
         "count": added.get("benches", 0) + added.get("bikeRacks", 0), "note": "bench length 1.8 m default; byinventar (KK) has no Frederiksberg equivalent"},
    ])
    BC.mark_done("furniture", seconds=round(time.time() - t0, 1), tiles=n, stats=doc["stats"])
    log(f"[furniture] {doc['stats']} in {n} tiles ({time.time() - t0:.0f}s)")


def math_atan2(y, x):
    import math

    return math.atan2(y, x)


# --------------------------------------------------------------------------------------------------------- groundfloor

def stage_groundfloor(a, tiles, cells) -> None:
    if BC.is_done("groundfloor") and not a.force_stage("groundfloor"):
        return
    t0 = time.time()
    _citywide(tiles)
    import groundfloor

    out = BC.WORK / "groundfloor_city.json"
    argv = sys.argv
    sys.argv = ["groundfloor.py", "--bbox", *map(str, BC.city_bbox_utm(tiles)), "--out", str(out)]
    try:
        groundfloor.main()
    finally:
        sys.argv = argv
    doc = json.loads(out.read_text())
    L = BC.Layers(set(tiles))
    for i, v in enumerate(doc["venues"]):
        L.add(T.owner_of_point(v), "groundfloor", "venues", v, i)
    n = _write_tiles(L, "groundfloor", tiles)
    _put_meta("groundfloor", T._without(doc, ("venues",)))
    _add_subst([{"item": "ground-floor venues", "source": "OSM shops/amenities citywide (KK bevillinger is KK-only)", "count": sum(
        1 for v in doc["venues"] if any(s.startswith("osm:") for s in v.get("src", [])) and frb_contains(v)), "note": "no serving-permit layer for Frederiksberg"}])
    BC.mark_done("groundfloor", seconds=round(time.time() - t0, 1), tiles=n, venues=len(doc["venues"]))
    log(f"[groundfloor] {len(doc['venues'])} venues in {n} tiles ({time.time() - t0:.0f}s)")


def frb_contains(v) -> bool:
    import frb
    from shapely.geometry import Point

    global _FRB
    try:
        _FRB
    except NameError:
        _FRB = frb.frb_polygon()
    e, n = frame.to_utm(v["x"], v["z"])
    return _FRB.contains(Point(e, n))
