"""Roads: OSM centrelines enriched with KK speed / one-way / cycle-track layers and
KK road-parcel widths; builds the roadGraph."""
from __future__ import annotations

import math
import statistics
from collections import Counter

from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, Point, box, shape
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

import bikedir
import frame
import roadgraph

_T = Transformer.from_crs(4326, 25832, always_xy=True)
CLASSES = ["primary", "secondary", "residential", "service", "cycleway", "footway"]
HW_CLASS = {
    "primary": "primary", "primary_link": "primary", "secondary": "secondary", "secondary_link": "secondary",
    "tertiary": "secondary", "tertiary_link": "secondary", "residential": "residential",
    "living_street": "residential", "unclassified": "residential", "service": "service",
    "cycleway": "cycleway", "footway": "footway", "pedestrian": "footway", "path": "footway",
}
DEFAULT_WIDTH = {"primary": 14.0, "secondary": 10.0, "residential": 7.0, "service": 4.0, "cycleway": 2.2, "footway": 2.0}
DEFAULT_SPEED = {"primary": 50, "secondary": 50, "residential": 30, "service": 20, "cycleway": 20, "footway": 5}
SIDEWALK_W = 2.5  # assumed per side when subtracting from the road-parcel width
CARRIAGEWAY = ("primary", "secondary", "residential", "service")


def _lines(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        return [g for g in geom.geoms if g.geom_type == "LineString"]
    return []


def _int(v):
    try:
        return int(str(v).split(";")[0])
    except (TypeError, ValueError):
        return None


def parse_oneway(tags: dict) -> int:
    """0 two-way, 1 forward, -1 reverse."""
    v = tags.get("oneway")
    if v in ("yes", "true", "1"):
        return 1
    if v == "-1":
        return -1
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


def osm_lanes(tags: dict, cls: str, oneway: int):
    """-> (fwd, back, inferred?)"""
    f, b = _int(tags.get("lanes:forward")), _int(tags.get("lanes:backward"))
    total = _int(tags.get("lanes"))
    if f is not None or b is not None:
        return (f or 0), (b or 0), False
    if cls in ("cycleway", "footway"):
        return 1, 1, True
    if oneway:
        n = total or 1
        return (n, 0, total is None) if oneway > 0 else (0, n, total is None)
    n = total or 2
    return math.ceil(n / 2), n // 2 if n > 1 else 1, total is None


def osm_cycle_sides(tags: dict) -> set[str]:
    sides = set()
    ok = lambda v: v is not None and v not in ("no", "none")  # noqa: E731
    if ok(tags.get("cycleway")) or ok(tags.get("cycleway:both")):
        sides |= {"left", "right"}
    if ok(tags.get("cycleway:left")):
        sides.add("left")
    if ok(tags.get("cycleway:right")):
        sides.add("right")
    return sides


def side_of(line: LineString, pt: Point) -> str:
    d = line.project(pt)
    a = line.interpolate(max(d - 1.0, 0))
    b = line.interpolate(min(d + 1.0, line.length))
    tx, ty = b.x - a.x, b.y - a.y
    dx, dy = pt.x - a.x, pt.y - a.y
    return "left" if tx * dy - ty * dx > 0 else "right"


def _samples(line: LineString, step=12.0):
    n = max(1, int(line.length // step))
    return [line.interpolate((i + 0.5) / n, normalized=True) for i in range(n)]


class Evidence:
    """Nearest-line lookups against a KK line layer."""

    def __init__(self, features, attr, max_d=12.0):
        self.geoms, self.vals = [], []
        for f in features:
            g = shape(f["geometry"])
            for ln in _lines(g) if g.geom_type != "LineString" else [g]:
                self.geoms.append(ln)
                self.vals.append(f["properties"].get(attr) if attr else f["properties"])
        self.tree = STRtree(self.geoms) if self.geoms else None
        self.max_d = max_d

    def near(self, pt):
        if not self.tree:
            return None
        i = self.tree.nearest(pt)
        if i is not None and self.geoms[i].distance(pt) <= self.max_d:
            return self.vals[i]
        return None

    def majority(self, line):
        c = Counter(v for v in (self.near(p) for p in _samples(line)) if v is not None)
        if not c:
            return None
        v, n = c.most_common(1)[0]
        return v if n >= max(1, len(_samples(line)) / 2) else None


def parcel_width(line: LineString, parcels, prepared) -> float | None:
    """Median cross-section width of the road parcel (UTM) around the centreline."""
    ws = []
    for p in _samples(line, 10.0):
        d = line.project(p)
        a, b = line.interpolate(max(d - 1, 0)), line.interpolate(min(d + 1, line.length))
        tx, ty = b.x - a.x, b.y - a.y
        n = math.hypot(tx, ty)
        if n == 0:
            continue
        nx, ny = -ty / n, tx / n
        cs = LineString([(p.x - nx * 30, p.y - ny * 30), (p.x + nx * 30, p.y + ny * 30)])
        if not prepared.intersects(cs):
            continue
        inter = parcels.intersection(cs)
        for seg in _lines(inter):
            if seg.distance(p) < 0.5:
                ws.append(seg.length)
                break
    return statistics.median(ws) if len(ws) >= 2 else None


def compile_roads(osm: dict, kk: dict, signal_pts_utm: list[tuple[float, float]]):
    """kk: dict of FeatureCollections (Kommunevej, trafikhastigheder, ensrettede_gader, cykelsti)."""
    bbox = box(*frame.area_utm())
    parcels = unary_union([shape(f["geometry"]).buffer(0) for f in kk.get("Kommunevej", {}).get("features", [])]) \
        if kk.get("Kommunevej") else None
    pparcels = prep(parcels) if parcels is not None else None
    speed_ev = Evidence(kk.get("trafikhastigheder", {}).get("features", []), "hastighedsgraense") if kk.get("trafikhastigheder") else None
    one_ev = Evidence(kk.get("ensrettede_gader", {}).get("features", []), "vejnavn") if kk.get("ensrettede_gader") else None
    cyc_ev = Evidence(kk.get("cykelsti", {}).get("features", []), None, max_d=14.0) if kk.get("cykelsti") else None
    contra_ev = Evidence(kk.get("ensrettede_gader", {}).get("features", []), "cykling_mod_ensretning") if kk.get("ensrettede_gader") else None
    ways_seen: dict[str, set] = {}

    names = [""]
    name_idx = {"": 0}
    roads, ways_for_graph = [], []
    stats = Counter()
    for el in osm.get("elements", []):
        if el["type"] != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        cls = HW_CLASS.get(tags.get("highway"))
        if not cls or tags.get("area") == "yes":
            continue
        pts = [_T.transform(p["lon"], p["lat"]) for p in el["geometry"]]
        if len(pts) < 2:
            continue
        ow = parse_oneway(tags)
        if ow == -1:
            pts = pts[::-1]
        line = LineString(pts)
        for k, seg in enumerate(_lines(line.intersection(bbox))):
            if seg.length < 1.0:
                continue
            fwd, back, lanes_inf = osm_lanes(tags, cls, 1 if ow else 0)
            conf_fields, src = {}, [f"osm:way/{el['id']}"]
            if lanes_inf:
                conf_fields["lanesFwd"] = conf_fields["lanesBack"] = "inferred"
            # speed
            kk_speed = speed_ev.majority(seg) if (speed_ev and cls in CARRIAGEWAY) else None
            osm_speed = _int(tags.get("maxspeed"))
            if kk_speed:
                speed, conf_fields["speedKmh"] = int(kk_speed), "observed"
                src.append("kk:trafikhastigheder")
            elif osm_speed:
                speed, conf_fields["speedKmh"] = osm_speed, "observed"
                src.append("osm:maxspeed")
            else:
                speed, conf_fields["speedKmh"] = DEFAULT_SPEED[cls], "inferred"
            # oneway evidence
            kk_one = one_ev.majority(seg) if (one_ev and cls in CARRIAGEWAY) else None
            if kk_one:
                src.append("kk:ensrettede_gader")
                if not ow:
                    stats["oneway_kk_only"] += 1
                else:
                    conf_fields["oneway"] = "observed"
            # width
            width, wconf = DEFAULT_WIDTH[cls], "inferred"
            if _int(tags.get("width")) and cls in CARRIAGEWAY:
                width, wconf = float(tags["width"].split(";")[0]), "observed"
                src.append("osm:width")
            elif pparcels is not None and cls in CARRIAGEWAY:
                w = parcel_width(seg, parcels, pparcels)
                if w:
                    sw = SIDEWALK_W * 2 if w > 8 else 0.0
                    width = round(min(max(w - sw, DEFAULT_WIDTH["service"]), 30.0), 1)
                    wconf = "scaled"
                    src.append("kk:Kommunevej")
            conf_fields["width"] = wconf
            # cycle tracks: OSM sides, merged with the KK cykelsti layer
            carriage = cls in CARRIAGEWAY
            osm_b = bikedir.parse_bike(tags, cls, ow, carriage)
            sides = bikedir.cycle_track_side_set(osm_b)
            if sides:
                src.append("osm:cycleway")
            kk_sides = {}
            if cyc_ev and carriage:
                for p in _samples(seg):
                    i = cyc_ev.tree.nearest(p)
                    g = cyc_ev.geoms[i]
                    d = g.distance(p)
                    if 2.0 <= d <= 14.0:
                        side = side_of(seg, g.interpolate(g.project(p)))
                        kk_sides[side] = "lane" if (cyc_ev.vals[i] or {}).get("sti_type") == 12 else "track"
                if kk_sides:
                    src.append("kk:cykelsti")
            # direction of cars and bicycles (bikedir.py): KK-only tracks get the right-hand-traffic default direction
            b = bikedir.parse_bike(tags, cls, ow, carriage, {s_: k for s_, k in kk_sides.items() if s_ not in sides})
            sides = bikedir.cycle_track_side_set(b)
            cyc = "both" if sides >= {"left", "right"} else (next(iter(sides)) if sides else "none")
            if carriage:
                kk_flag = contra_ev.majority(seg) if contra_ev else None
                verdict = bikedir.add_kk_contraflow(b, None if kk_flag is None else bool(int(kk_flag)))
                if verdict:
                    stats[f"contraflow_kk_{verdict}"] += 1
                    if verdict in ("granted", "agree"):
                        src.append("kk:ensrettede_gader:cykling_mod_ensretning")
                if tags.get("oneway:bicycle") or any(k.startswith("cycleway") for k in tags):
                    src.append("osm:bicycle-direction")
            conf_fields["bike"] = "inferred" if b["inferred"] or (sides and not b["explicit"]) else "observed"
            if b["contraflow"]:
                conf_fields["contraflow"] = "observed"
            wid = el["id"]
            if carriage:
                if b["contraflow"]:
                    ways_seen.setdefault("contraflow", set()).add(wid)
                    ways_seen.setdefault(f"contraflow_{b['contraKind']}", set()).add(wid)
                if b["left"] == "both" or b["right"] == "both":
                    ways_seen.setdefault("two_way_track", set()).add(wid)
                if b["ban"]:
                    ways_seen.setdefault("bike_ban", set()).add(wid)
                if b["sidepath"]:
                    ways_seen.setdefault("sidepath_side", set()).add(wid)
            elif cls == "cycleway":
                ways_seen.setdefault("cycleway_two_way" if b["carriageway"] == "both" else "cycleway_oneway", set()).add(wid)
            nm = tags.get("name", "")
            if nm not in name_idx:
                name_idx[nm] = len(names)
                names.append(nm)
            coords = list(seg.coords)
            roads.append({
                "id": f"osm:way/{el['id']}" + (f"#{k}" if k else ""),
                "name": nm, "class": cls,
                "pts": frame.flat([frame.to_local(x, y) for x, y in coords]),
                "width": width, "lanesFwd": fwd, "lanesBack": back, "oneway": bool(ow),
                "speedKmh": speed, "cycleTrack": cyc,
                "carDir": b["carDir"], "bike": {k: v for k, v in b.items() if not k.startswith("_") and k not in ("carDir", "explicit", "inferred")},
                "src": src, "conf": "observed", "conf_fields": conf_fields,
            })
            ways_for_graph.append((len(roads) - 1, coords))
    for k, v in ways_seen.items():
        stats[f"ways_{k}"] = len(v)
    return roads, ways_for_graph, names, stats


_KEY = lambda p: (round(p[0], 1), round(p[1], 1))  # noqa: E731


def simplify_keep_junctions(all_coords, i, tol=0.75):
    """Douglas-Peucker on way `i`, never dropping vertices shared with another way."""
    global _COUNTS
    if _COUNTS is None or _COUNTS[0] is not all_coords:
        c = Counter()
        for coords in all_coords:
            for k in set(map(_KEY, coords)):
                c[k] += 1
        _COUNTS = (all_coords, c)
    counts = _COUNTS[1]
    coords = all_coords[i]
    keep = [0] + [j for j in range(1, len(coords) - 1) if counts[_KEY(coords[j])] >= 2] + [len(coords) - 1]
    out = [coords[0]]
    for a, b in zip(keep, keep[1:]):
        piece = coords[a:b + 1]
        s = list(LineString(piece).simplify(tol, preserve_topology=False).coords) if len(piece) > 2 else piece
        out += s[1:]
    return out


_COUNTS = None


def build_road_graph(roads, ways_for_graph, names, signal_pts_utm, tol=0.5):
    all_coords = [c for _, c in ways_for_graph]  # one list object: simplify_keep_junctions caches its vertex counts on it
    polylines = [[frame.to_local(x, y) for x, y in simplify_keep_junctions(all_coords, i)] for i in range(len(ways_for_graph))]
    nodes, segs = roadgraph.build_graph(polylines, tol)
    sig = [frame.to_local(x, y) for x, y in signal_pts_utm]
    sig_tree = STRtree([Point(p) for p in sig]) if sig else None

    def has_signal(i):
        if not sig_tree:
            return 0
        n = Point(nodes[i])
        j = sig_tree.nearest(n)
        return 1 if Point(sig[j]).distance(n) <= 15.0 else 0

    cache = {}
    sigf = lambda i: cache.setdefault(i, has_signal(i))  # noqa: E731
    class_idx = {c: i for i, c in enumerate(CLASSES)}
    links = []
    for wi, a, b in segs:
        r = roads[ways_for_graph[wi][0]]
        links.append([a, b, r["lanesFwd"], r["lanesBack"], r["width"], r["speedKmh"],
                      names.index(r["name"]), class_idx[r["class"]], sigf(a), sigf(b)])
    flat_nodes = []
    for x, z in nodes:
        flat_nodes += [round(x, 2), round(z, 2)]
    return {"nodes": flat_nodes, "links": links, "names": names, "classes": CLASSES}
