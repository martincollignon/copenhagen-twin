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
import traceback

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


# ------------------------------------------------------------------------------------------------------------ streets

STREETS_MARGIN = 120.0
_VK = None


def _vejkant_index(path):
    """KK + GeoDanmark Vejkant lines as (bbox array, features), loaded once per process."""
    global _VK
    if _VK is None:
        import numpy as np

        feats = json.loads(path.read_text())["features"]
        bb = np.array([BC._geom_bounds(f["geometry"]) for f in feats])
        _VK = (bb, feats)
    return _VK


def streets_cell_job(cell: str, tids: list[str]) -> dict:
    """streets.py's build_doc on one cell (+ margin), keeping what the cell's tiles own. The compiler's global unions and
    footprint-wide distance queries are quadratic, so the city is done in chunks, like the other layers."""
    name = f"streets-cell-{cell}"
    if BC.is_done(name):
        return {"cell": cell, "skipped": True}
    t0 = time.time()
    try:
        import numpy as np

        import streets as ST

        allowed = set(tids)
        core = BC.cell_bbox_utm(cell)
        e0, n0, e1, n1 = core
        m = STREETS_MARGIN
        region_tiles = [t for t in frame.tiles_for_bbox((e0, n0, e1, n1), margin=m) if (BC.TILES_DIR / t).is_dir()]
        x0, z0, x1, z1 = frame.utm_bbox_to_local((e0 - m, n0 - m, e1 + m, n1 + m))
        hit = lambda flat: not (max(flat[0::2]) < x0 or min(flat[0::2]) > x1 or max(flat[1::2]) < z0 or min(flat[1::2]) > z1)  # noqa: E731
        geo = {"roads": [], "sidewalks": [], "cycleTracks": [], "parks": [], "buildings": [], "heroes": []}
        own_road, own_bld, own_sw, own_cyc = set(), set(), set(), set()
        surf = {"surfaces": []}
        own_surf = set()
        for t in region_tiles:
            p = BC.TILES_DIR / t / "roads.json"
            if p.exists():
                d = json.loads(p.read_text())
                for r in d.get("roads", []):
                    if hit(r["pts"]):
                        geo["roads"].append(r)
                        if T.owner_of_line(r) in allowed:
                            own_road.add(r["id"])
                for k, key in (("sidewalks", "ring"), ("cycleTracks", "pts"), ("parks", "ring")):
                    for it in d.get(k, []):
                        if hit(it[key]):
                            geo[k].append(it)
            p = BC.TILES_DIR / t / "buildings.json"
            if p.exists():
                for b in json.loads(p.read_text())["buildings"]:
                    if hit(b["ring"]):
                        geo["buildings"].append(b)
                        if T.owner_of_ring(b) in allowed:
                            own_bld.add(b["id"])
            p = BC.TILES_DIR / t / "surfaces.json"
            if p.exists():
                for s_ in json.loads(p.read_text()).get("surfaces", []):
                    if hit(s_["ring"]):
                        surf["surfaces"].append(s_)
                        if T.owner_of_ring(s_) in allowed:
                            own_surf.add(s_["id"])
        graph = json.loads((BC.CITY_DIR / "roadgraph.json").read_text())
        geo["roadGraph"] = graph
        lakes_doc = json.loads((BC.CITY_DIR / "lakes.json").read_text())
        lakes = {"lakes": [l for l in lakes_doc["lakes"] if hit(l["ring"])], "ponds": [l for l in lakes_doc.get("ponds", []) if hit(l["ring"])],
                 "bridges": [l for l in lakes_doc.get("bridges", []) if hit(l["ring"])]}
        bb, feats = _vejkant_index(BC.WORK / "vejkant_city.json")
        ux0, uz0 = frame.to_utm(x0, z1)  # local box -> UTM corners (z south)
        ux1, uz1 = frame.to_utm(x1, z0)
        sel = np.nonzero((bb[:, 2] >= ux0) & (bb[:, 0] <= ux1) & (bb[:, 3] >= uz0) & (bb[:, 1] <= uz1))[0]
        from shapely.geometry import LineString

        vk = {"car": [], "cyc": []}
        for i in sel:
            f = feats[i]
            t_ = f["properties"].get("vejtype")
            k = "car" if t_ in ST.CAR_EDGE_TYPES else "cyc" if t_ in ST.CYC_EDGE_TYPES else None
            if not k:
                continue
            for ln in f["geometry"]["coordinates"]:
                pts = [(c[0] - frame.ORIGIN[0], -(c[1] - frame.ORIGIN[1])) for c in ln]
                if len(pts) >= 2:
                    vk[k].append(LineString(pts))
        owner_sw = lambda ring: T.owner_of_ring({"ring": ring})  # noqa: E731
        surfaces = {"surfaces": surf["surfaces"], "markings": []} if surf["surfaces"] else None
        doc = ST.build_doc(geo, lakes, vk, surfaces=surfaces)
        # what this cell's tiles own
        node = lambda ni: T.owner_of_point({"x": graph["nodes"][2 * ni], "z": graph["nodes"][2 * ni + 1]})  # noqa: E731
        base = lambda rid: rid.split("#")[0]  # noqa: E731
        out = {
            "roads": {k: v for k, v in doc["roads"].items() if k in own_road},
            "extraRoads": [e for e in doc["extraRoads"] if e["base"] in own_road],
            "graph": {"nodes": [n for n in doc["graph"]["nodes"] if node(n[0]) in allowed],
                      "widths": [w for w in doc["graph"]["widths"] if node(graph["links"][w[0]][0]) in allowed],
                      "dropLinks": [li for li in doc["graph"]["dropLinks"] if node(graph["links"][li][0]) in allowed]},
            "sidewalks": [sw for sw in doc["sidewalks"] if owner_sw(sw["ring"]) in allowed],
            "cycleTracks": [c for c in doc["cycleTracks"] if T.owner_of_line(c) in allowed],
            "buildings": {"drop": [d for d in doc["buildings"]["drop"] if base(d["id"]) in own_bld],
                          "clip": [c for c in doc["buildings"]["clip"] if base(c["id"]) in own_bld]},
            "buildingReport": [r for r in doc["buildingReport"] if base(r["id"]) in own_bld],
            "surfaceCuts": [c for c in doc["surfaceCuts"] if c["id"] in own_surf],
            "stats": {k: v for k, v in doc["stats"].items() if isinstance(v, (int, float))},
        }
        S.atomic_write(BC.WORK / "streets_cells" / f"{cell}.json", BC.dump(out))
        res = {"cell": cell, "roads": len(out["roads"]), "seconds": round(time.time() - t0, 1)}
        BC.mark_done(name, **{k: v for k, v in res.items() if k != "cell"})
        return res
    except Exception as e:  # noqa: BLE001
        return {"cell": cell, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-500:]}


def stage_streets(a, tiles, cells) -> None:
    """data/city/streets.json: streets.py's measured cross-sections for the whole city (Vejkant ray casting). KK Vejkant covers
    Koebenhavn; Frederiksberg's comes from GeoDanmark Vejkant (same type domain). Per cell, merged by ownership."""
    if BC.is_done("streets") and not a.force_stage("streets"):
        return
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor, as_completed

    t0 = time.time()
    BC.ensure_secrets("DATAFORDELER_USERNAME", "DATAFORDELER_PASSWORD")
    _citywide(tiles)
    vk_path = BC.WORK / "vejkant_city.json"
    if not vk_path.exists():
        info = S.fetch_geodk_vejkant((719500.0, 6173500.0, 724500.0, 6178500.0))  # Frederiksberg + margin
        kk = json.loads((BC.RAW_CITY / "kk_vejkant.json").read_text())["features"]
        frb_feats = json.loads((BC.RAW_CITY / "geodk_vejkant_frb.json").read_text())["features"]
        from shapely.geometry import shape
        from shapely.strtree import STRtree

        tree = STRtree([shape(f["geometry"]) for f in kk])  # KK first; GeoDanmark lines only where KK has none (Frederiksberg)
        extra = []
        for f in frb_feats:
            if len(tree.query(shape(f["geometry"]).buffer(1.0))) == 0:
                geom = f["geometry"]
                if geom["type"] == "LineString":  # the KK layer holds MultiLineStrings
                    f = {**f, "geometry": {"type": "MultiLineString", "coordinates": [geom["coordinates"]]}}
                extra.append(f)
        S.atomic_write(vk_path, BC.dump({"type": "FeatureCollection", "features": kk + extra}))
        log(f"[streets] vejkant: {len(kk)} KK + {len(extra)} GeoDanmark (Frederiksberg) lines; {info}")
    order = [c for c in sorted(cells) if (not a.cells or c in a.cells)]
    todo = [c for c in order if not BC.is_done(f"streets-cell-{c}")]
    log(f"[streets] {len(todo)} of {len(order)} cells to do, {a.streets_workers} workers")
    errors = {}
    with ProcessPoolExecutor(a.streets_workers, mp_context=mp.get_context("spawn")) as ex:
        futs = {ex.submit(streets_cell_job, c, cells[c]): c for c in todo}
        for n, f in enumerate(as_completed(futs), 1):
            r, c = f.result(), futs[f]
            if r.get("error"):
                errors[c] = r["error"]
                log(f"[streets] {c} FAILED: {r['error']} {r.get('trace', '')[-300:]}")
            else:
                log(f"[streets] {n}/{len(todo)} {c}: {r.get('roads', '-')} roads in {r.get('seconds', '-')}s")
    if errors or a.cells:
        log(f"[streets] not merged ({len(errors)} failures; --cells run)" if errors else "[streets] --cells run: not merged")
        return
    parts = [json.loads(p.read_text()) for p in sorted((BC.WORK / "streets_cells").glob("*.json"))]
    doc = {"version": "cph-streets/1", "frame": {"epsg": 25832, "origin": list(frame.ORIGIN), "axes": "x=east, z=south, y=up"},
           "method": "Vejkant + fortovsmatrikel ray casting: carriageway edge, cycle strip, re-centred roads; see tools/cph-geodata/streets.py "
                     "(compiled per 1 km cell with a 120 m margin, merged by tile ownership)",
           "roads": {}, "extraRoads": [], "graph": {"nodes": [], "widths": [], "dropLinks": []}, "sidewalks": [], "cycleTracks": [],
           "buildings": {"drop": [], "clip": []}, "buildingReport": [], "surfaceCuts": [], "stats": {}}
    for p in parts:
        doc["roads"].update(p["roads"])
        doc["extraRoads"] += p["extraRoads"]
        for k in ("nodes", "widths", "dropLinks"):
            doc["graph"][k] += p["graph"][k]
        for k in ("sidewalks", "cycleTracks", "buildingReport", "surfaceCuts"):
            doc[k] += p[k]
        for k in ("drop", "clip"):
            doc["buildings"][k] += p["buildings"][k]
    doc["stats"] = {"roads": len(doc["roads"]) + len(doc["extraRoads"]), "extraPieces": len(doc["extraRoads"]), "nodesMoved": len(doc["graph"]["nodes"]),
                    "linkWidths": len(doc["graph"]["widths"]), "droppedLinks": len(doc["graph"]["dropLinks"]),
                    "buildingsDropped": len(doc["buildings"]["drop"]), "buildingsClipped": len(doc["buildings"]["clip"]),
                    "sidewalksAfter": len(doc["sidewalks"]), "cycleTracks": len(doc["cycleTracks"]), "surfaceCuts": len(doc["surfaceCuts"]),
                    "passages": sum(1 for r in doc["roads"].values() if r.get("drop") == "passage"), "cells": len(parts),
                    "note": "per-cell compile with a 120 m margin; counts are of the merged, ownership-filtered document"}
    doc["graph"]["nodes"].sort()
    doc["graph"]["widths"].sort()
    doc["graph"]["dropLinks"].sort()
    S.atomic_write(BC.CITY_DIR / "streets.json", BC.dump(doc))
    BC.mark_done("streets", seconds=round(time.time() - t0), cells=len(parts), stats=doc["stats"])
    log(f"[streets] streets.json {(BC.CITY_DIR / 'streets.json').stat().st_size / 1e6:.1f} MB, {len(doc['roads'])} roads, {doc['stats']} ({time.time() - t0:.0f}s)")
