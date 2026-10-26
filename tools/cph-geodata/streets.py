# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "numpy"]
# ///
"""Street layout compiler for the Copenhagen twin -> data/cph-streets.json (cph-streets/1).

ONE street cross-section for every layer. The OSM centrelines of data/cph-geodata.json are 1-3 m off the real roads and
the carriageway width was a capped guess. This compiler measures the street instead:

  * `kk_vejkant` (GeoDanmark Vejkant, the surveyed road-edge lines: 'Koerevej' = carriageway edge, 'Cykelsti langs vej' =
    outer edge of a cycle track) and `fortovsmatrikel` (the KK pavement polygons) are ray-cast from every road sample to
    both sides. The carriageway edge is the first Vejkant line, else the pavement edge, else a building line minus 1.8 m;
    a cycle track is the strip between the carriageway edge and the next 'Cykelsti langs vej' line (or a KK cykelsti line
    / an OSM tag where the space allows);
  * the road is re-centred on the middle of the measured edges (a lateral shift per vertex) so every layer that follows
    the centreline (surfaces, traffic lanes, pedestrians, cyclists, parked cars) sits on the real street, the half
    width `hw` is the measured one, and the road-graph nodes / link widths move with it;
  * pavements are the KK polygons minus carriageway, cycle strips, buildings and water; cycle tracks are drawn once:
    KK cykelsti lines that run beside a road are already that road's strip and are dropped, the rest are clipped;
  * data errors: overlapping footprints are resolved by source precedence, buildings standing in lakes are dropped,
    carriageway pieces inside buildings are reported.

Everything is reproducible from the cached raw layers under data/raw (tools/cph-geodata/fetch.py):

    uv run tools/cph-geodata/streets.py
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
ORIGIN = (723900.0, 6176500.0, 6.84)

VEHICULAR = {"primary", "secondary", "residential", "service"}
LANE_W = 3.0  # the traffic simulation's lane pitch
KERB_W = 0.15
CYCLE_DEFAULT = 2.2
CYCLE_MIN, CYCLE_MAX = 1.4, 3.2
CAR_EDGE_TYPES = {"Kørevej", "Indkørselsvej", "Internvej", "Anden vej", "Supplerende vejkant"}
CYC_EDGE_TYPES = {"Cykelsti langs vej"}
MAX_REACH = 24.0  # how far a ray looks for an edge
NEIGHBOUR_REACH = 16.0  # how far a ray looks for the centreline of a parallel carriageway
BLD_FRONT = 1.8  # assumed pavement depth in front of a building line when nothing else is known
HALF_CAP = {"primary": 14.0, "secondary": 12.0, "residential": 9.0, "service": 6.0}
SAMPLE_STEP = 3.0
END_MARGIN = 6.0  # samples this close to a road end are skipped (junction mouths see side streets, not the edge)
SHIFT_MAX = 4.5  # m: the largest re-centring of an OSM centreline
MIN_PAVEMENT_M2 = 0.6
CLEARANCE = 0.1  # m kept between a carriageway edge and a building / the water
MIN_HALF = 1.4
CLAMP_END = 3.0
CLAMP_MIN_DIST = 0.6
CENTRED = {"measured", "pavement", "building"}  # provenances whose edges are known on BOTH sides: the road is re-centred


def r2(v):
    return round(float(v), 2)


def _flat(coords):
    out = []
    for x, z in list(coords)[:-1]:
        out += [r2(x), r2(z)]
    return out


def poly_of(ring, holes=()):
    pts = [(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]
    if len(pts) < 3:
        return None
    p = Polygon(pts, [[(h[i], h[i + 1]) for i in range(0, len(h), 2)] for h in holes if len(h) >= 6])
    if not p.is_valid:
        p = p.buffer(0)
    if p.is_empty:
        return None
    return p


def polys_of(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [g for g in geom.geoms if g.geom_type == "Polygon"]
    return []


def lines_of(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        return [g for g in geom.geoms if g.geom_type == "LineString"]
    return []


# ---------------------------------------------------------------------------------------------------- ray casting
class RayIndex:
    """Distances along a ray to the lines of a layer (a spatial index over LineStrings)."""

    def __init__(self, lines):
        self.lines = list(lines)
        self.tree = STRtree(self.lines) if self.lines else None

    def nearest_hit(self, a, b, skip=None, min_d=0.3):
        """(distance, index) of the nearest line crossing the segment a-b whose index is not `skip` (a set), else None."""
        if self.tree is None:
            return None
        ray = LineString([a, b])
        best = None
        for i in self.tree.query(ray):
            if skip and i in skip:
                continue
            g = ray.intersection(self.lines[i])
            if g.is_empty:
                continue
            for p in getattr(g, "geoms", [g]):
                if p.geom_type == "Point":
                    d = math.hypot(p.x - a[0], p.y - a[1])
                    if d > min_d and (best is None or d < best[0]):
                        best = (d, i)
        return best

    def hits(self, a, b, min_d=0.05):
        """Sorted distances from a at which the segment a-b crosses a line."""
        if self.tree is None:
            return []
        ray = LineString([a, b])
        out = []
        for i in self.tree.query(ray):
            g = ray.intersection(self.lines[i])
            if g.is_empty:
                continue
            for p in getattr(g, "geoms", [g]):
                if p.geom_type == "Point":
                    d = math.hypot(p.x - a[0], p.y - a[1])
                    if d > min_d:
                        out.append(d)
        out.sort()
        return out


def right_normals(pts):
    """Per-vertex unit right normal of a flat polyline, as js/road-surfaces-cph.js rightNormals (x east, z south)."""
    n = len(pts) // 2
    out = []
    for i in range(n):
        dx = dz = 0.0
        for a, b in ((i - 1, i), (i, i + 1)):
            if a < 0 or b >= n:
                continue
            sx, sz = pts[2 * b] - pts[2 * a], pts[2 * b + 1] - pts[2 * a + 1]
            ln = math.hypot(sx, sz) or 1.0
            dx += sx / ln
            dz += sz / ln
        ln = math.hypot(dx, dz) or 1.0
        out.append((-dz / ln, dx / ln))
    return out


def lane_count(road):
    return max(1, (road.get("lanesFwd") or 1) + (0 if road.get("oneway") else (road.get("lanesBack") if road.get("lanesBack") is not None else 1)))


def legacy_half(road):
    """The old capped half width (js/road-width-cph.js), used where nothing could be measured."""
    lanes = lane_count(road)
    extra = {"primary": 1.5, "secondary": 1.5, "residential": 3.6, "service": 0.5, "cycleway": 0.0}.get(road["class"], 1.0)
    need = lanes * 3.1 + extra
    w = road.get("width") or need
    return max(3.0, min(w, need, 20.0)) / 2


# ---------------------------------------------------------------------------------------------------- one road
def measure_road(road, ctx):
    """Edge distances left/right of the centreline of one vehicular road, sampled every SAMPLE_STEP metres.

    Returns {'left': [...], 'right': [...], 's': [...]} where each side entry is a dict
    {ec, src, cyc, kk_cyc, sw, bld, wat, car_hits}: ec = carriageway edge distance, src = what gave it ('car' | 'sw' | 'bld' |
    None), cyc = distance of the farthest 'Cykelsti langs vej' line behind it, kk_cyc = a KK cykelsti line behind it.
    """
    pts = road["pts"]
    ln = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
    L = ln.length
    ss = list(np.arange(END_MARGIN, L - END_MARGIN, SAMPLE_STEP)) if L > 2 * END_MARGIN + 2 else [L / 2]
    samples = {"s": ss, "left": [], "right": []}
    for s in ss:
        c = ln.interpolate(s)
        a = ln.interpolate(max(0.0, s - 1.0))
        b = ln.interpolate(min(L, s + 1.0))
        tx, tz = b.x - a.x, b.y - a.y
        l = math.hypot(tx, tz) or 1.0
        rx, rz = -tz / l, tx / l
        start_in_bld = ctx.bld_solid_contains(c.x, c.y)
        for sign, key in ((1, "right"), (-1, "left")):
            end = (c.x + sign * rx * MAX_REACH, c.y + sign * rz * MAX_REACH)
            o = (c.x, c.y)
            car = ctx.car.hits(o, end)
            cyc = ctx.cyc.hits(o, end)
            kk = ctx.kk_cyc.hits(o, end)
            sw = ctx.sw.hits(o, end)
            bld = [] if start_in_bld else ctx.bld.hits(o, end)
            wat = ctx.water.hits(o, end)
            nb = ctx.veh.nearest_hit(o, (c.x + sign * rx * NEIGHBOUR_REACH, c.y + sign * rz * NEIGHBOUR_REACH), skip={ctx.veh_index.get(road["id"], -1)})
            obstacle = min([d for d in (sw[:1] + bld[:1] + wat[:1])] or [MAX_REACH])
            samples[key].append({"car": [d for d in car if d <= obstacle + 0.4], "cyc": [d for d in cyc if d <= obstacle + 0.4],
                                 "kk": [d for d in kk if d <= obstacle + 0.4], "sw": sw[0] if sw else None, "bld": bld[0] if bld else None,
                                 "wat": wat[0] if wat else None, "obstacle": obstacle, "nb": nb[0] if nb else None})
    return samples


def lane_need(road):
    """Carriageway width (m) the traffic lanes need. Service roads and narrow residential streets share one lane
    (the data's 1 + 1 lanes there is a default, not a survey)."""
    lanes = lane_count(road)
    if road["class"] == "service":
        return 4.0
    if road["class"] == "residential":
        return min(lanes, 2) * 2.75
    return lanes * LANE_W


def side_cap(road):
    """The farthest a carriageway edge can plausibly lie from the centreline: half the lanes plus a parking lane, a cycle
    strip and a median kerb. A hit beyond it is another street's edge, not this one's."""
    return lane_need(road) / 2 + 6.5


def aggregate_side(samples, tags_cycle, cap=MAX_REACH):
    """One side's carriageway edge, cycle width and provenance from its ray samples."""
    ecs, cys, srcs, kks, obst = [], [], [], [], []
    for sm in samples:
        ec = src = None
        if sm["car"]:
            ec, src = sm["car"][0], "car"
        elif sm["sw"] is not None:
            ec, src = sm["sw"], "sw"
        elif sm["bld"] is not None:
            ec, src = max(sm["bld"] - BLD_FRONT, 1.0), "bld"
        elif sm["wat"] is not None:
            ec, src = max(sm["wat"] - 0.8, 1.0), "wat"
        ecs.append(ec)
        srcs.append(src)
        obst.append(sm["obstacle"])
        # the cycle track behind the carriageway edge: farthest Vejkant cycle line within 4.6 m of it
        if ec is not None and ec > cap:
            ec = src = None  # not this street's edge
        cy = None
        if ec is not None:
            behind = [d for d in sm["cyc"] if ec - 0.3 <= d <= ec + 4.6]
            if behind:
                cy = max(behind)
        cys.append(cy)
        kks.append(ec is not None and any(ec - 0.6 <= d <= ec + 4.6 for d in sm["kk"]))
    valid = [e for e in ecs if e is not None]
    if not valid:
        return None
    ec = float(np.percentile(valid, 30))
    src = Counter(s for s in srcs if s).most_common(1)[0][0]
    cyv = [c for c in cys if c is not None]
    kkn = sum(kks)
    out = {"ec": ec, "src": src, "n": len(valid), "of": len(samples), "obstacle": float(np.percentile(obst, 30))}
    out["cyc_edge"] = float(np.percentile(cyv, 50)) if len(cyv) >= max(1, 0.25 * len(samples)) else None
    out["kk_cyc"] = kkn >= max(1, 0.25 * len(samples))
    out["tag_cyc"] = bool(tags_cycle)
    return out


def cycle_width(side, ec):
    """Width (m) of the raised cycle strip on one side, 0 if there is none. The strip lies between two 0.15 m kerbs."""
    if side is None:
        return 0.0, None
    space = side["obstacle"] - ec - 2 * KERB_W - 0.1  # what fits before the pavement / building
    if side["cyc_edge"] is not None:
        w = side["cyc_edge"] - ec - 2 * KERB_W
        w = min(max(w, CYCLE_MIN), CYCLE_MAX)
        return (min(w, max(space, 0)) if space >= CYCLE_MIN else 0.0), "measured"
    if side["kk_cyc"] or side["tag_cyc"]:
        w = min(CYCLE_DEFAULT, space)
        return (w if w >= CYCLE_MIN else 0.0), ("kk" if side["kk_cyc"] else "tag")
    return 0.0, None


def build_road(road, samples, ctx_tags):
    """The street record of one road: shift (per vertex), half width, cycle widths and provenance."""
    pts = road["pts"]
    sides = {k: aggregate_side(samples[k], ctx_tags.get(k), side_cap(road)) for k in ("left", "right")}
    lanes = lane_count(road)
    need_w = lane_need(road)
    cap = HALF_CAP.get(road["class"], 9.0)
    prov = "inferred"
    hl, hr = (sides["left"]["ec"] if sides["left"] else None), (sides["right"]["ec"] if sides["right"] else None)
    leg = legacy_half(road)
    shift_by = None
    if hl is not None and hr is not None:
        prov = "measured" if all(sides[k]["src"] == "car" for k in sides) else "pavement" if all(sides[k]["src"] in ("car", "sw") for k in sides) else "building"
    elif hl is not None or hr is not None:
        known = hl if hl is not None else hr
        prov = "one-side"
        hl = hr = known  # the centre is assumed right, the other kerb mirrors the measured one
    else:
        hl = hr = leg
    # lane need: widen the narrow side(s) until the lanes fit (a median kerb seen as the edge, a bus-lane island ...)
    if hl + hr < need_w - 0.5:
        deficit = need_w - (hl + hr)
        hl += deficit / 2
        hr += deficit / 2
        prov = prov + "+lanes"
    hl = min(hl, cap)
    hr = min(hr, cap)
    # cycle strips (one each side) only when the side has a measured / tagged track
    cl = cycle_width(sides["left"], hl)
    cr = cycle_width(sides["right"], hr)
    if prov == "inferred":
        cl, cr = (0.0, None), (0.0, None)
        tag = road.get("cycleTrack")
        if tag in ("left", "both"):
            cl = (CYCLE_DEFAULT, "tag")
        if tag in ("right", "both"):
            cr = (CYCLE_DEFAULT, "tag")
    shift = (hr - hl) / 2 if prov.split("+")[0] in CENTRED else 0.0
    shift = max(-SHIFT_MAX, min(SHIFT_MAX, shift))
    # never into a building or the water: the carriageway [shift - hw, shift + hw] (right positive) stays clear of the
    # nearest footprint / shore on each side (5th percentile over the samples)
    clear = {}
    for k in ("left", "right"):
        d = [min(x for x in (sm["bld"], sm["wat"]) if x is not None) for sm in samples[k] if sm["bld"] is not None or sm["wat"] is not None]
        clear[k] = float(np.percentile(d, 5)) if d else None
        # a parallel carriageway (dual carriageway, frontage road) seen from most samples: ours ends halfway to its centreline
        nbs = [sm["nb"] for sm in samples[k] if sm["nb"] is not None]
        if nbs and len(nbs) >= 0.6 * max(1, len(samples[k])):
            half_gap = float(np.percentile(nbs, 20)) / 2 + CLEARANCE  # (clear - CLEARANCE below)
            clear[k] = half_gap if clear[k] is None else min(clear[k], half_gap)
    hw = (hl + hr) / 2
    limit = hw
    if clear["right"] is not None:
        limit = min(limit, clear["right"] - CLEARANCE - shift)
    if clear["left"] is not None:
        limit = min(limit, clear["left"] - CLEARANCE + shift)
    if limit < hw:
        hw_new = max(MIN_HALF, limit)
        hl = hr = hw_new
        prov += "+clear"
    return {"hl": hl, "hr": hr, "shift": shift, "cl": cl[0], "cr": cr[0], "cl_src": cl[1], "cr_src": cr[1], "prov": prov}


def smooth_shifts(samples_s, values, vertex_s, window=9.0):
    """Median of the sample shifts within +-window metres of each vertex (nearest sample when none)."""
    out = []
    for v in vertex_s:
        near = [x for s, x in zip(samples_s, values) if abs(s - v) <= window]
        if not near and values:
            k = int(np.argmin([abs(s - v) for s in samples_s]))
            near = [values[k]]
        out.append(float(np.median(near)) if near else 0.0)
    return out


# ---------------------------------------------------------------------------------------------------- the context
class Context:
    def __init__(self, geo, lakes, vejkant, local):
        self.geo = geo
        self.car = RayIndex([ln for k, lines in vejkant.items() if k == "car" for ln in lines])
        self.cyc = RayIndex(vejkant.get("cyc", []))
        self.kk_cyc = RayIndex([LineString([(c["pts"][i], c["pts"][i + 1]) for i in range(0, len(c["pts"]), 2)]) for c in geo.get("cycleTracks", []) if len(c["pts"]) >= 4])
        bpolys = [(b, poly_of(b["ring"], b.get("holes", ()))) for b in geo["buildings"]]
        self.bpolys = [p for _, p in bpolys if p is not None]
        self.bids = [b["id"] for b, p in bpolys if p is not None]
        self.bld = RayIndex([ln for p in self.bpolys for ln in lines_of(p.boundary)])
        self._btree = STRtree(self.bpolys)
        swpolys = [poly_of(s["ring"]) for s in geo["sidewalks"]]
        self.swpolys = [p for p in swpolys if p is not None]
        self.sw = RayIndex([ln for p in self.swpolys for ln in lines_of(p.boundary)])
        self.water_poly = lake_water(lakes)
        self.water = RayIndex([ln for p in polys_of(self.water_poly) for ln in lines_of(p.boundary)])
        # the other vehicular centrelines: a neighbouring carriageway ends halfway between the two lines
        self.veh_ids = [r["id"] for r in geo["roads"] if r["class"] in VEHICULAR and len(r["pts"]) >= 4]
        self.veh = RayIndex([LineString([(r["pts"][i], r["pts"][i + 1]) for i in range(0, len(r["pts"]), 2)]) for r in geo["roads"] if r["class"] in VEHICULAR and len(r["pts"]) >= 4])
        self.veh_index = {rid: i for i, rid in enumerate(self.veh_ids)}

    def bld_solid_contains(self, x, z):
        p = Point(x, z)
        for i in self._btree.query(p):
            if self.bpolys[i].contains(p):
                return True
        return False


def lake_water(lakes):
    polys = []
    for lk in lakes.get("lakes", []):
        p = poly_of(lk["ring"], lk.get("holes", ()))
        if p is not None:
            polys.append(p)
    ponds = [poly_of(p["ring"]) for p in lakes.get("ponds", [])]
    bridges = unary_union([poly_of(b["ring"]) for b in lakes.get("bridges", []) if poly_of(b["ring"]) is not None] or [Polygon()])
    w = unary_union(polys + [p for p in ponds if p is not None] or [Polygon()])
    return w.difference(bridges) if not w.is_empty else w


def load_vejkant(path=RAW / "kk_vejkant.json"):
    """GeoDanmark Vejkant lines in local metres: {'car': [...], 'cyc': [...]}."""
    fc = json.loads(Path(path).read_text())
    out = {"car": [], "cyc": []}
    for f in fc["features"]:
        t = f["properties"].get("vejtype")
        k = "car" if t in CAR_EDGE_TYPES else "cyc" if t in CYC_EDGE_TYPES else None
        if not k:
            continue
        for ln in f["geometry"]["coordinates"]:
            pts = [(c[0] - ORIGIN[0], -(c[1] - ORIGIN[1])) for c in ln]
            if len(pts) >= 2:
                out[k].append(LineString(pts))
    return out


# ---------------------------------------------------------------------------------------------------- roads + graph
def road_ribbon(pts, hw):
    ln = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
    return ln.buffer(hw, cap_style="flat", join_style="mitre", mitre_limit=3.0)


def side_strip(pts, hw, cw, side):
    """The raised cycle strip (kerb + track + kerb) beside the carriageway; side +1 = right of travel."""
    ln = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
    sgn = 1 if side > 0 else -1
    kw = 2 * KERB_W + cw
    outer = ln.buffer(sgn * (hw + kw), single_sided=True, cap_style="flat", join_style="mitre", mitre_limit=3.0)
    inner = ln.buffer(sgn * hw, single_sided=True, cap_style="flat", join_style="mitre", mitre_limit=3.0)
    return outer.difference(inner)


def apply_shift(pts, shifts):
    nr = right_normals(pts)
    out = []
    for i, (nx, nz) in enumerate(nr):
        out += [pts[2 * i] + nx * shifts[i], pts[2 * i + 1] + nz * shifts[i]]
    return out


def node_index(nodes, cell=2.0):
    grid = defaultdict(list)
    for i in range(len(nodes) // 2):
        grid[(int(nodes[2 * i] // cell), int(nodes[2 * i + 1] // cell))].append(i)

    def near(x, z, tol=0.8):
        best = None
        cx, cz = int(x // cell), int(z // cell)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for i in grid.get((cx + dx, cz + dz), ()):
                    d = math.hypot(nodes[2 * i] - x, nodes[2 * i + 1] - z)
                    if d <= tol and (best is None or d < best[0]):
                        best = (d, i)
        return best[1] if best else None

    return near


def compile_roads(geo, lakes, vejkant):
    ctx = Context(geo, lakes, vejkant, None)
    roads_out = {}
    rows = []
    for road in geo["roads"]:
        if road["class"] not in VEHICULAR or len(road["pts"]) < 4:
            continue
        sm = measure_road(road, ctx)
        tags = {"left": road.get("cycleTrack") in ("left", "both"), "right": road.get("cycleTrack") in ("right", "both")}
        rec = build_road(road, sm, tags)
        # per-vertex lateral shift: median of the per-sample (hr - hl) / 2, which is only meaningful with both sides measured
        pts = road["pts"]
        n = len(pts) // 2
        vs = [0.0]
        for i in range(1, n):
            vs.append(vs[-1] + math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]))
        per_sample = []
        for sl, sr in zip(sm["left"], sm["right"]):
            cap = side_cap(road)
            el = sl["car"][0] if sl["car"] else sl["sw"] if sl["sw"] is not None else None
            er = sr["car"][0] if sr["car"] else sr["sw"] if sr["sw"] is not None else None
            el = el if el is not None and el <= cap else None
            er = er if er is not None and er <= cap else None
            per_sample.append(None if el is None or er is None else (er - el) / 2)
        have = [(s, v) for s, v in zip(sm["s"], per_sample) if v is not None]
        if rec["prov"].split("+")[0] in CENTRED and have:
            sh = smooth_shifts([h[0] for h in have], [max(-SHIFT_MAX, min(SHIFT_MAX, h[1])) for h in have], vs)
        else:
            sh = [0.0] * n
        rec["vertex_shift"] = sh
        roads_out[road["id"]] = rec
        rows.append((road, rec, sm))
    return roads_out, rows, ctx


def build_graph_update(geo, roads_out):
    """Shift the road-graph nodes with the re-centred roads and give every vehicular link its measured width."""
    rg = geo["roadGraph"]
    nodes = rg["nodes"]
    near = node_index(nodes)
    acc = defaultdict(list)
    vertex_node = {}
    for road in geo["roads"]:
        rec = roads_out.get(road["id"])
        if not rec:
            continue
        pts = road["pts"]
        nr = right_normals(pts)
        for i in range(len(pts) // 2):
            ni = near(pts[2 * i], pts[2 * i + 1])
            vertex_node[(road["id"], i)] = ni
            if ni is not None and rec["prov"].split("+")[0] in CENTRED:
                acc[ni].append((nr[i][0] * rec["vertex_shift"][i], nr[i][1] * rec["vertex_shift"][i]))
    new_nodes = {}
    for ni, vs in acc.items():
        dx = sum(v[0] for v in vs) / len(vs)
        dz = sum(v[1] for v in vs) / len(vs)
        new_nodes[ni] = (nodes[2 * ni] + dx, nodes[2 * ni + 1] + dz)
    # link -> carriageway width (full), by the road whose consecutive vertices the link joins
    pair = {}
    for ri, road in enumerate(geo["roads"]):
        rec = roads_out.get(road["id"])
        if not rec:
            continue
        n = len(road["pts"]) // 2
        for i in range(n - 1):
            a, b = vertex_node.get((road["id"], i)), vertex_node.get((road["id"], i + 1))
            if a is not None and b is not None and a != b:
                pair[(min(a, b), max(a, b))] = road["id"]
    widths = {}
    for li, l in enumerate(rg["links"]):
        rid = pair.get((min(l[0], l[1]), max(l[0], l[1])))
        if rid is not None:
            rec = roads_out[rid]
            widths[li] = r2(rec["hl"] + rec["hr"])
    return new_nodes, widths, vertex_node


def finish_roads(geo, roads_out, new_nodes, vertex_node):
    """Final (shifted) polyline of every road; vertices that are graph nodes take the node's new position."""
    out = {}
    for road in geo["roads"]:
        rec = roads_out.get(road["id"])
        if not rec:
            continue
        pts = apply_shift(road["pts"], rec["vertex_shift"])
        for i in range(len(pts) // 2):
            ni = vertex_node.get((road["id"], i))
            if ni in new_nodes:
                pts[2 * i], pts[2 * i + 1] = new_nodes[ni]
        out[road["id"]] = [r2(v) for v in pts]
    return out


# ---------------------------------------------------------------------------------------------------- cycle strips
def arc_intervals(L, ok, step=0.5, min_len=2.0):
    """Maximal runs of arc length in [0, L] where ok(array of s) is True, as [[s0, s1], ...] (runs shorter than min_len are
    dropped, the others padded by half a step so neighbouring runs meet)."""
    s = np.arange(0.0, L + 1e-9, step)
    flags = ok(s)
    out = []
    i = 0
    n = len(s)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and flags[j + 1]:
            j += 1
        a, b = max(0.0, s[i] - step / 2), min(L, s[j] + step / 2)
        if b - a >= min_len:
            out.append([r2(a), r2(b)])
        i = j + 1
    return out


def strip_ok_fn(line, hw, cw, side, forbidden):
    """Vectorised test: is the cycle strip beside `line` (carriageway half width hw, strip width cw) free of `forbidden`?
    Tests the inner kerb, the middle and the outer kerb edge of the strip at every arc length."""
    L = line.length
    offs = [hw + KERB_W + 0.05, hw + KERB_W + cw / 2, hw + 2 * KERB_W + cw - 0.05]

    def ok(s):
        s = np.asarray(s, dtype=float)
        c = shapely.line_interpolate_point(line, s)
        pa = shapely.line_interpolate_point(line, np.maximum(0.0, s - 1.0))
        pb = shapely.line_interpolate_point(line, np.minimum(L, s + 1.0))
        cx, cz = shapely.get_x(c), shapely.get_y(c)
        tx, tz = shapely.get_x(pb) - shapely.get_x(pa), shapely.get_y(pb) - shapely.get_y(pa)
        ln = np.hypot(tx, tz)
        ln[ln == 0] = 1.0
        rx, rz = -tz / ln, tx / ln
        if forbidden.is_empty:
            return np.ones(len(s), dtype=bool)
        bad = np.zeros(len(s), dtype=bool)
        for o in offs:
            bad |= shapely.contains_xy(forbidden, cx + side * rx * o, cz + side * rz * o)
        return ~bad

    return ok


def slice_line(line, s0, s1):
    """The part of a LineString between arc lengths s0..s1."""
    from shapely.ops import substring  # noqa: PLC0415

    return substring(line, s0, s1)


def compile_cycles(items, ctx):
    """Per road piece and side: the arc-length intervals where its cycle strip can stand (not on another carriageway, in a
    building, in water, nor on a strip that already exists). `items` = [{id, pts, rec}]. Returns ({id: {'cl': [...], 'cr': [...]}},
    {id: carriageway polygon})."""
    carriage = {it["id"]: road_ribbon(it["pts"], (it["rec"]["hl"] + it["rec"]["hr"]) / 2) for it in items}
    ids = list(carriage)
    ctree = STRtree([carriage[i] for i in ids])
    wopen = ctx.water_poly
    wpolys = polys_of(wopen)
    wtree = STRtree(wpolys) if wpolys else None

    # priority: measured tracks first, then the rest, longer roads first
    def prio(it):
        rec = it["rec"]
        return (0 if rec["cl_src"] == "measured" or rec["cr_src"] == "measured" else 1, -LineString([(it["pts"][i], it["pts"][i + 1]) for i in range(0, len(it["pts"]), 2)]).length)

    placed = []  # strip polygons already decided
    placed_tree = [None, 0]  # (STRtree, how many of `placed` it covers)
    result = {}
    for it in sorted(items, key=prio):
        rec = it["rec"]
        pts = it["pts"]
        line = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
        hw = (rec["hl"] + rec["hr"]) / 2
        zone = line.buffer(hw + 8)
        # other carriageways shrunk a little: the strip may touch the road it ends at, but never lie on it
        others = [carriage[ids[j]].buffer(-0.3) for j in ctree.query(zone) if ids[j] != it["id"]]
        blds = [ctx.bpolys[j] for j in ctx._btree.query(zone)]
        waters = [wpolys[j] for j in wtree.query(zone)] if wtree is not None else []
        if placed:
            if placed_tree[1] != len(placed):
                placed_tree[0], placed_tree[1] = STRtree(placed), len(placed)
            taken = [placed[j].buffer(-0.2) for j in placed_tree[0].query(zone)]
        else:
            taken = []
        forb = unary_union([g for g in others + blds + waters + taken if not g.is_empty] or [Polygon()])
        out = {}
        for key, side, cw in (("cl", -1, rec["cl"]), ("cr", 1, rec["cr"])):
            if cw <= 0:
                out[key] = []
                continue
            iv = arc_intervals(line.length, strip_ok_fn(line, hw, cw, side, forb))
            out[key] = iv
            for a, b in iv:
                piece = slice_line(line, a, b)
                if piece.length > 0.5:
                    placed.append(side_strip([c for xy in piece.coords for c in xy], hw, cw, side))
        result[it["id"]] = out
    return result, carriage


def road_strip_polygons(items, cycles):
    """The cycle strips as polygons (what the engine draws), as (piece id, side key, polygon)."""
    out = []
    for it in items:
        rec = it["rec"]
        pts = it["pts"]
        line = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
        hw = (rec["hl"] + rec["hr"]) / 2
        for key, side, cw in (("cl", -1, rec["cl"]), ("cr", 1, rec["cr"])):
            for a, b in cycles[it["id"]][key] if cw > 0 else []:
                piece = slice_line(line, a, b)
                if piece.length > 0.3:
                    out.append((it["id"], key, side_strip([c for xy in piece.coords for c in xy], hw, cw, side)))
    return out


# ---------------------------------------------------------------------------------------------------- pavements
def clean_sidewalks(geo, carriage, strips, ctx):
    """KK pavement polygons minus carriageways, cycle strips, building footprints and water."""
    cutters = [g for g in carriage.values()] + [p for _, _, p in strips] + ctx.bpolys + ([ctx.water_poly] if not ctx.water_poly.is_empty else [])
    union = unary_union(cutters)
    tree = STRtree(cutters)
    out = []
    dropped = 0
    for sw in geo["sidewalks"]:
        p = poly_of(sw["ring"])
        if p is None:
            continue
        cut = unary_union([cutters[j] for j in tree.query(p)]) if len(tree.query(p)) else Polygon()
        rest = p.difference(cut) if not cut.is_empty else p
        k = 0
        for g in polys_of(rest):
            if g.area < MIN_PAVEMENT_M2:
                dropped += 1
                continue
            g = g.simplify(0.02)
            if g.is_empty or g.geom_type != "Polygon":
                continue
            rec = {"id": sw["id"] if k == 0 and rest.geom_type == "Polygon" else f"{sw['id']}#{k}", "ring": ring_ccw_flat(g.exterior)}
            if list(g.interiors):
                rec["holes"] = [ring_cw_flat(h) for h in g.interiors if Polygon(h).area >= 0.3]
            out.append(rec)
            k += 1
    return out, dropped


def ring_signed(coords):
    pts = list(coords)[:-1]
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def ring_ccw_flat(ring):
    """Flat ring in the geodata orientation (counter-clockwise seen from above: x east, z south = negative shoelace)."""
    coords = list(ring.coords)
    if ring_signed(coords) > 0:
        coords = coords[::-1]
    return _flat(coords)


def ring_cw_flat(ring):
    coords = list(ring.coords)
    if ring_signed(coords) < 0:
        coords = coords[::-1]
    return _flat(coords)


# ---------------------------------------------------------------------------------------------------- KK cycle lines
def dedupe_kk_cycle_lines(geo, strips, carriage, ctx):
    """KK cykelsti lines that run beside a road are already that road's strip; the rest are clipped to free ground."""
    strip_union = unary_union([p for _, _, p in strips]) if strips else Polygon()
    near_strip = strip_union.buffer(1.4) if not strip_union.is_empty else strip_union
    car_union = unary_union(list(carriage.values()))
    blocked = unary_union([g for g in (car_union.buffer(-0.2), unary_union(ctx.bpolys), ctx.water_poly, strip_union.buffer(0.3) if not strip_union.is_empty else Polygon()) if not g.is_empty])
    # the ribbon (about 1 m each side of the line) must be clear too, not just the line
    blocked_wide = blocked.buffer(1.0)
    out = []
    stats = {"kept": 0, "dropped_duplicate": 0, "clipped": 0, "dropped_blocked": 0}
    for c in geo.get("cycleTracks", []):
        if len(c["pts"]) < 4:
            continue
        ln = LineString([(c["pts"][i], c["pts"][i + 1]) for i in range(0, len(c["pts"]), 2)])
        if ln.length < 1:
            continue
        inside = ln.intersection(near_strip).length / ln.length if not near_strip.is_empty else 0.0
        if inside > 0.6:
            stats["dropped_duplicate"] += 1
            continue
        rest = ln.difference(blocked_wide) if not blocked_wide.is_empty else ln
        pieces = [g for g in lines_of(rest) if g.length >= 3.0]
        if not pieces:
            stats["dropped_blocked"] += 1
            continue
        if len(pieces) > 1 or abs(sum(g.length for g in pieces) - ln.length) > 0.5:
            stats["clipped"] += 1
        else:
            stats["kept"] += 1
        for k, g in enumerate(pieces):
            rec = {k_: v for k_, v in c.items() if k_ != "pts"}
            rec["id"] = c["id"] if len(pieces) == 1 else f"{c['id']}#{k}"
            rec["pts"] = [r2(v) for xy in g.coords for v in xy]
            out.append(rec)
    return out, stats


# ---------------------------------------------------------------------------------------------------- passages
PASSAGE_RATIO = 0.35
MIN_PIECE = 3.0  # m: a road piece shorter than this is dropped when a road is cut at a building


def cut_at_buildings(geo, newpts, roads_out, ctx):
    """Roads must not run through buildings. A road whose centreline mostly lies inside footprints is a gateway (dropped
    whole); otherwise the parts inside footprints are cut away and the rest kept as separate pieces.
    Returns (passages {id: ratio}, pieces {id: [flat pts, ...]}, inside_mids [(x, z)] of the removed stretches)."""
    bu = unary_union(ctx.bpolys + ([ctx.water_poly] if not ctx.water_poly.is_empty else []))  # water: a road is no ferry either
    shrunk = bu.buffer(-0.2)  # a road hugging a facade is not "inside"
    passages, pieces, removed = {}, {}, []
    for road in geo["roads"]:
        rid = road["id"]
        if rid not in roads_out:
            continue
        pts = newpts[rid]
        ln = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
        if ln.length < 1:
            continue
        inside = ln.intersection(shrunk)
        if inside.is_empty or inside.length < 2.0:
            continue
        ratio = ln.intersection(bu).length / ln.length
        if ratio >= PASSAGE_RATIO:
            passages[rid] = r2(ratio)
            continue
        keep = [g for g in lines_of(ln.difference(shrunk)) if g.length >= MIN_PIECE]
        if not keep:
            passages[rid] = r2(ratio)
            continue
        pieces[rid] = [[r2(c) for xy in g.coords for c in xy] for g in keep]
        for g in lines_of(inside):
            m = g.interpolate(0.5, normalized=True)
            removed.append((m.x, m.y))
    return passages, pieces, removed


def self_gap(pts, min_arc=20.0):
    """Smallest distance between two stretches of one polyline that are at least `min_arc` metres apart along it (a hairpin, a closed
    loop): a carriageway cannot be wider than that gap or it folds over itself."""
    n = len(pts) // 2
    segs = [LineString([(pts[2 * i], pts[2 * i + 1]), (pts[2 * i + 2], pts[2 * i + 3])]) for i in range(n - 1)]
    cum = [0.0]
    for sg in segs:
        cum.append(cum[-1] + sg.length)
    best = None
    for i in range(len(segs)):
        for j in range(i + 2, len(segs)):
            if cum[j] - cum[i + 1] < min_arc:
                continue
            d = segs[i].distance(segs[j])
            best = d if best is None else min(best, d)
    return best


# ---------------------------------------------------------------------------------------------------- data errors: footprints
def gdk_number(bid):
    """Numeric part of a GeoDanmark id ('gdk:1241239835' -> 1241239835): ids grow with the registration date, so the larger
    one is the newer survey. Other sources (KK) rank below any GeoDanmark footprint."""
    digits = "".join(c for c in str(bid) if c.isdigit())
    return int(digits) if str(bid).startswith("gdk:") and digits else 0


MIN_PIECE_M2 = 6.0


def resolve_buildings(geo, water):
    """Footprint errors, resolved by source precedence (newest GeoDanmark survey wins) and reported:
      * a footprint lying in a lake is dropped (>= 50 % in the water) or clipped by the lake outline;
      * a footprint that is >= 90 % inside one at least 4 x its size is hidden inside it: dropped (sheds drawn on the main roof);
      * any other overlap: the older footprint loses the overlap (a remainder under max(6 m2, 15 %) is dropped);
      * hero buildings (hand-built glTFs) are never changed, they win every overlap.
    Returns {'drop': {id: reason}, 'clip': {id: {'rings': [...]}}, 'report': [...]}"""
    heroes = {h.get("building_id") for h in geo.get("heroes", [])}
    polys = {}
    order = []
    for b in geo["buildings"]:
        p = poly_of(b["ring"], b.get("holes", ()))
        if p is not None:
            polys[b["id"]] = p
            order.append(b["id"])
    drop, clipped, report = {}, {}, []
    orig_area = {k: v.area for k, v in polys.items()}

    def apply_clip(bid, rest, reason, other):
        pieces = [g for g in polys_of(rest) if g.area >= MIN_PIECE_M2]
        if not pieces or sum(g.area for g in pieces) < max(MIN_PIECE_M2, 0.15 * orig_area[bid]):
            drop[bid] = reason
            polys.pop(bid, None)
            report.append({"id": bid, "action": "drop", "reason": reason, "with": other})
            return
        pieces.sort(key=lambda g: -g.area)
        clipped[bid] = {"reason": reason}
        polys[bid] = pieces[0]
        for k, g in enumerate(pieces[1:], 1):  # every piece is a footprint of its own from here on (later overlaps see it)
            polys[f"{bid}#{k}"] = g
            orig_area[f"{bid}#{k}"] = g.area
        report.append({"id": bid, "action": "clip", "reason": reason, "with": other, "area": r2(orig_area[bid]), "kept": r2(sum(g.area for g in pieces))})

    if not water.is_empty:
        wtree = STRtree(polys_of(water))
        wp = polys_of(water)
        for bid in list(order):
            p = polys.get(bid)
            if p is None or bid in heroes:
                continue
            cand = [wp[j] for j in wtree.query(p)]
            if not cand:
                continue
            wu = unary_union(cand)
            a = p.intersection(wu).area
            if a < 1.0:
                continue
            if a >= 0.5 * p.area:
                drop[bid] = "in-water"
                polys.pop(bid)
                report.append({"id": bid, "action": "drop", "reason": "in-water", "area": r2(p.area)})
            else:
                apply_clip(bid, p.difference(wu), "in-water", None)
    for _ in range(6):
        ids = list(polys)
        tree = STRtree([polys[i] for i in ids])
        pairs = []
        for ia, bid in enumerate(ids):
            for jb in tree.query(polys[bid]):
                if jb <= ia:
                    continue
                a, b = polys[bid], polys[ids[jb]]
                inter = a.intersection(b).area
                small = min(a.area, b.area)
                if inter >= 1.0 and inter / small >= 0.05:
                    pairs.append((inter, bid, ids[jb]))
        if not pairs:
            break
        changed = False
        for inter, x, y in sorted(pairs, key=lambda t: -t[0]):
            if x not in polys or y not in polys:
                continue
            a, b = polys[x], polys[y]
            if a.intersection(b).area < 1.0:
                continue
            small_id, big_id = (x, y) if a.area <= b.area else (y, x)
            sp, bp = polys[small_id], polys[big_id]
            inside = sp.intersection(bp).area / sp.area
            if small_id in heroes and big_id in heroes:
                continue
            if inside >= 0.9 and bp.area >= 4 * sp.area and small_id not in heroes:
                drop[small_id] = "inside-larger"
                polys.pop(small_id)
                report.append({"id": small_id, "action": "drop", "reason": "inside-larger", "with": big_id})
                changed = True
                continue
            # winner: hero, else the newer GeoDanmark footprint (larger id), else the larger one
            if x in heroes or y in heroes:
                win, lose = (x, y) if x in heroes else (y, x)
            else:
                kx, ky = gdk_number(x), gdk_number(y)
                win, lose = (x, y) if (kx, polys[x].area) >= (ky, polys[y].area) else (y, x)
            apply_clip(lose, polys[lose].difference(polys[win]), "overlap-older", win)
            changed = True
        if not changed:
            break
    # the final pieces of every clipped footprint: its own id first, then id#1, id#2 ...
    for bid, c in clipped.items():
        c["pieces"] = [polys[k] for k in [bid] + [f"{bid}#{n}" for n in range(1, 20)] if k in polys]
    return {"drop": drop, "clip": clipped, "report": report}


def building_records(geo, res):
    """The compact document form: drops and replacement rings (flat, geodata orientation)."""
    out = {"drop": [{"id": k, "reason": v} for k, v in sorted(res["drop"].items())], "clip": []}
    for bid, c in sorted(res["clip"].items()):
        if bid in res["drop"]:
            continue
        rec = {"id": bid, "reason": c["reason"], "pieces": []}
        for g in c["pieces"]:
            rec["pieces"].append({"ring": ring_ccw_flat(g.exterior), **({"holes": [ring_cw_flat(h) for h in g.interiors if Polygon(h).area >= 0.5]} if list(g.interiors) else {})})
        out["clip"].append(rec)
    return out


# ---------------------------------------------------------------------------------------------------- data errors: ground surfaces
PRIORITY_ROAD = "asphalt_road"


def compile_surfaces(surfaces, geo, lakes_water, carriage, strips, bpolys_union):
    """The ground-material register (data/cph-surfaces.json) against the street layout.
    A material polygon never lies on a carriageway or cycle strip, in a building or in the lake, and the huge OSM `place=square`
    outlines (Raadhuspladsen 25 600 m2, Jarmers Plads 23 400 m2: they enclose streets, parks and blocks) lose all of that and the
    KK park polygons too; where two polygons of different class overlap, the smaller (more specific) one keeps its ground and the
    larger loses it. Returns [{id, replace: [{id, ring, holes}]}] for every polygon that changed (empty replace = dropped)."""
    road_union = unary_union(list(carriage.values()) + [p for _, _, p in strips])
    parks = unary_union([poly_of(p["ring"], p.get("holes", ())) for p in geo.get("parks", []) if p.get("ring") and (p.get("ring") or [])])
    cut_street = unary_union([g for g in (road_union, bpolys_union, lakes_water) if not g.is_empty])
    items = []
    for sf in surfaces["surfaces"]:
        p = poly_of(sf["ring"], sf.get("holes", ()))
        if p is not None:
            items.append((sf, p))
    tree = STRtree([p for _, p in items])
    cuts, stats = [], Counter()
    # polygons that cover less than they overlap: smaller wins
    for k, (sf, p) in enumerate(items):
        cls = sf["cls"]
        is_osm = str(sf["id"]).startswith("osm:")
        sub = []
        if cls != PRIORITY_ROAD:
            sub.append(cut_street)
        else:
            sub += [g for g in (bpolys_union, lakes_water) if not g.is_empty]
        if is_osm and not parks.is_empty:
            sub.append(parks)
        # more specific ground wins: every overlapping polygon of another class that is smaller (or a KK register polygon vs an OSM one)
        for j in tree.query(p):
            if j == k:
                continue
            sf2, q = items[j]
            o_osm = str(sf2["id"]).startswith("osm:")
            smaller = q.area < p.area or (is_osm and not o_osm)
            if is_osm and not o_osm:
                smaller = True  # the register beats OSM
            elif o_osm and not is_osm:
                smaller = False
            # (a KK road-surface polygon only cuts an OSM square, never another KK polygon)
            if smaller and q.intersection(p).area > 0.5 and (sf2["cls"] != PRIORITY_ROAD or is_osm):
                sub.append(q)
        if not sub:
            continue
        cutter = unary_union(sub)
        if p.intersection(cutter).area < 1.0:
            continue
        rest = p.difference(cutter)
        pieces = [g for g in polys_of(rest) if g.area >= 2.0]
        replace = []
        for n, g in enumerate(pieces):
            rec = {"id": sf["id"] if len(pieces) == 1 else f"{sf['id']}~{n}", "ring": ring_ccw_flat(g.exterior)}
            if list(g.interiors):
                rec["holes"] = [ring_cw_flat(h) for h in g.interiors if Polygon(h).area >= 0.5]
            replace.append(rec)
        cuts.append({"id": sf["id"], "replace": replace})
        stats["osm" if is_osm else "kk"] += 1
        stats["dropped"] += 0 if replace else 1
        stats["area_removed_m2"] += int(p.area - sum(g.area for g in pieces))
    return cuts, dict(stats)


# ---------------------------------------------------------------------------------------------------------- the document
def build_doc(geo, lakes, vejkant, extra=None, surfaces=None):
    roads_out, rows, ctx = compile_roads(geo, lakes, vejkant)
    new_nodes, widths, vertex_node = build_graph_update(geo, roads_out)
    newpts = finish_roads(geo, roads_out, new_nodes, vertex_node)
    passages, cuts, removed = cut_at_buildings(geo, newpts, roads_out, ctx)
    by_id = {r["id"]: r for r in geo["roads"]}
    # road pieces: every kept road (or the pieces left of it after the cut), each with its own cross-section record
    items = []
    bwall = unary_union(ctx.bpolys + ([ctx.water_poly] if not ctx.water_poly.is_empty else []))
    clamped = 0
    for rid, rec in roads_out.items():
        if rid in passages:
            continue
        for k, pts in enumerate(cuts.get(rid, [newpts[rid]])):
            rec_k = dict(rec)
            # whatever the samples saw, the carriageway never reaches a footprint or the water along the line (the first and last
            # CLAMP_END metres, where junctions and building corners meet, are left out)
            ln = LineString([(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)])
            core = slice_line(ln, CLAMP_END, ln.length - CLAMP_END) if ln.length > 3 * CLAMP_END else ln
            dist = core.distance(bwall)
            hw = (rec_k["hl"] + rec_k["hr"]) / 2
            gap = self_gap(pts)
            if gap is not None and gap / 2 - CLEARANCE < hw:
                hw_new = max(MIN_HALF, gap / 2 - CLEARANCE)
                rec_k["hl"] = rec_k["hr"] = hw_new
                rec_k["prov"] = rec["prov"] + "+loop"
                hw = hw_new
                clamped += 1
            if CLAMP_MIN_DIST <= dist < hw + CLEARANCE:  # (a line that touches a footprint is cut or left, not shrunk to nothing)
                hw_new = max(MIN_HALF, dist - CLEARANCE)
                rec_k["hl"] = rec_k["hr"] = hw_new
                rec_k["prov"] = rec["prov"] + "+gap"
                clamped += 1
            items.append({"id": rid if k == 0 else f"{rid}#{k}", "base": rid, "pts": pts, "rec": rec_k})
    cycles, carriage = compile_cycles(items, ctx)
    strips = road_strip_polygons(items, cycles)
    sidewalks, dropped_sw = clean_sidewalks(geo, carriage, strips, ctx)
    cycle_tracks, kk_stats = dedupe_kk_cycle_lines(geo, strips, carriage, ctx)
    roads, extra_roads = {}, []
    for it in items:
        rec = it["rec"]
        r = {"p": it["pts"], "hw": r2((rec["hl"] + rec["hr"]) / 2), "prov": rec["prov"]}
        cyc = cycles[it["id"]]
        if rec["cl"] > 0 and cyc["cl"]:
            r["cl"] = [r2(rec["cl"]), cyc["cl"]]
        if rec["cr"] > 0 and cyc["cr"]:
            r["cr"] = [r2(rec["cr"]), cyc["cr"]]
        if it["id"] == it["base"]:
            roads[it["id"]] = r
        else:
            extra_roads.append({"id": it["id"], "base": it["base"], **r})
    for rid in passages:
        roads[rid] = {"p": newpts[rid], "hw": r2((roads_out[rid]["hl"] + roads_out[rid]["hr"]) / 2), "prov": roads_out[rid]["prov"], "drop": "passage"}
    # graph: links of dropped roads and links in cut-away stretches carry no lanes
    rg = geo["roadGraph"]
    drop_links = set()
    near = node_index(rg["nodes"])
    pair = defaultdict(list)
    for li, l in enumerate(rg["links"]):
        pair[(min(l[0], l[1]), max(l[0], l[1]))].append(li)
    for rid in passages:
        road = by_id[rid]
        ns = [near(road["pts"][2 * i], road["pts"][2 * i + 1]) for i in range(len(road["pts"]) // 2)]
        for a_, b_ in zip(ns, ns[1:]):
            if a_ is not None and b_ is not None and a_ != b_:
                drop_links.update(pair.get((min(a_, b_), max(a_, b_)), []))
    if removed:
        mids = shapely.points(np.array(removed))
        mtree = STRtree(mids)
        nodes = rg["nodes"]
        for li, l in enumerate(rg["links"]):
            if rg["classes"][l[7]] not in VEHICULAR:
                continue
            nx0 = new_nodes.get(l[0], (nodes[2 * l[0]], nodes[2 * l[0] + 1]))
            nx1 = new_nodes.get(l[1], (nodes[2 * l[1]], nodes[2 * l[1] + 1]))
            seg = LineString([nx0, nx1])
            if len(mtree.query(seg.buffer(1.0), predicate="intersects")):
                m = seg.interpolate(0.5, normalized=True)
                if ctx.bld_solid_contains(m.x, m.y):
                    drop_links.add(li)
    prov = Counter(r["prov"].split("+")[0] for r in roads_out.values())
    bres = resolve_buildings(geo, ctx.water_poly)
    surface_cuts, surf_stats = ([], {}) if surfaces is None else compile_surfaces(surfaces, geo, ctx.water_poly, carriage, strips, unary_union(ctx.bpolys))
    doc = {
        "version": "cph-streets/1",
        "frame": {"epsg": 25832, "origin": list(ORIGIN), "axes": "x=east, z=south, y=up"},
        "method": "Vejkant + fortovsmatrikel ray casting: carriageway edge, cycle strip, re-centred roads; see tools/cph-geodata/streets.py",
        "roads": roads,
        "extraRoads": extra_roads,
        "graph": {"nodes": [[ni, r2(x), r2(z)] for ni, (x, z) in sorted(new_nodes.items())], "widths": [[li, w] for li, w in sorted(widths.items())], "dropLinks": sorted(drop_links)},
        "sidewalks": sidewalks,
        "cycleTracks": cycle_tracks,
        "buildings": building_records(geo, bres),
        "buildingReport": bres["report"],
        "surfaceCuts": surface_cuts,
        "stats": {"roads": len(roads) + len(extra_roads), "clampedToBuildings": clamped, "provenance": dict(prov), "passages": len(passages), "cutRoads": len(cuts), "extraPieces": len(extra_roads),
                  "nodesMoved": len(new_nodes), "linkWidths": len(widths), "droppedLinks": len(drop_links),
                  "buildingsDropped": len(bres["drop"]), "buildingsClipped": len(bres["clip"]), "surfaces": surf_stats, "sidewalksBefore": len(geo["sidewalks"]), "sidewalksAfter": len(sidewalks), "sidewalkPiecesDropped": dropped_sw, "kkCycle": kk_stats,
                  "cycleStrips": len(strips)},
    }
    if extra:
        doc.update(extra)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "cph-streets.json"))
    ap.add_argument("--geodata", default=str(ROOT / "data" / "cph-geodata.json"))
    ap.add_argument("--lakes", default=str(ROOT / "data" / "cph-lakes.json"))
    ap.add_argument("--vejkant", default=str(RAW / "kk_vejkant.json"))
    ap.add_argument("--surfaces", default=str(ROOT / "data" / "cph-surfaces.json"))
    a = ap.parse_args(argv)
    if not Path(a.vejkant).exists():
        raise SystemExit(f"{a.vejkant} missing: fetch KK `vejkant` with tools/cph-geodata/fetch.py kk_layer('vejkant')")
    geo = json.loads(Path(a.geodata).read_text())
    lakes = json.loads(Path(a.lakes).read_text())
    surfaces = json.loads(Path(a.surfaces).read_text()) if Path(a.surfaces).exists() else None
    doc = build_doc(geo, lakes, load_vejkant(a.vejkant), surfaces=surfaces)
    Path(a.out).write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    print(json.dumps(doc["stats"], ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
