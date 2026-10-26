#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2.0", "numpy"]
# ///
"""Cross-layer conflict audit of the Copenhagen twin (measure only, nothing is fixed here).

Runtime layout comes from the engine's own pure JS modules (tools/audit/dump_layout.mjs: carriageway half widths,
ground-height field, placed street-furniture plan incl. parked cars and wire spans); everything else is rebuilt from
the data files with the same rules the engine uses (road-surfaces-cph.js: carriageway = centreline ribbon of
carriagewayWidth(), cycle track = 0.15 m kerb + 2.2 m strip beside it, pavement = geo.sidewalks, water = lakes minus
bridges). Frame: x = E - 723900, z = -(N - 6176500).

  node tools/audit/dump_layout.mjs            # (run automatically if tools/audit/out/layout.json is missing)
  uv run tools/audit/audit.py                 # writes docs/qa/audit-tables.md, docs/qa/results.json, docs/qa/sweep-points.json
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools/audit/out"
QA = ROOT / "docs/qa"
KERB_W, CYCLE_W, LANE_W = 0.15, 2.2, 3.0


# ----------------------------------------------------------------------------------------------------------- helpers
def load(p):
    return json.loads((ROOT / p).read_text())


def ring_poly(ring, holes=None):
    pts = [(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]
    if len(pts) < 3:
        return None
    p = Polygon(pts, [[(h[i], h[i + 1]) for i in range(0, len(h), 2)] for h in (holes or []) if len(h) >= 6])
    if not p.is_valid:
        p = make_valid(p)
        if p.geom_type != "Polygon":
            polys = [g for g in getattr(p, "geoms", []) if g.geom_type == "Polygon"]
            p = max(polys, key=lambda g: g.area) if polys else None
    return p


def obb(x, z, yaw, w, d, off_z=0.0):
    """Footprint of a model whose local x width is w and local z depth is d: x' = x + lx cos + lz sin, z' = z - lx sin + lz cos."""
    c, s = math.cos(yaw), math.sin(yaw)
    pts = []
    for lx, lz in ((-w / 2, -d / 2 + off_z), (w / 2, -d / 2 + off_z), (w / 2, d / 2 + off_z), (-w / 2, d / 2 + off_z)):
        pts.append((x + lx * c + lz * s, z - lx * s + lz * c))
    return Polygon(pts)


def seg_dir_nearest(road_lines, road_ids, tree, x, z):
    i = tree.nearest(Point(x, z))
    line = road_lines[i]
    d = line.project(Point(x, z))
    a = line.interpolate(max(0, d - 1.0))
    b = line.interpolate(min(line.length, d + 1.0))
    return i, math.atan2(b.x - a.x, b.y - a.y), line.distance(Point(x, z))  # heading as (sin, cos) angle


RESULTS: list[dict] = []
EXAMPLES_BY_LOC: list[dict] = []  # for the worst-locations list


def check(cid, layer, title, count, total, severity, examples, note="", weight=0.0, visible=True):
    """examples: list of (id, x, z, metric_str, metric_value). weight ranks the check's examples for the sweep."""
    ex = sorted(examples, key=lambda e: -abs(e[4]))[:10]
    RESULTS.append({
        "id": cid, "layer": layer, "title": title, "count": int(count), "total": int(total),
        "pct": round(100.0 * count / total, 2) if total else 0.0, "severity": severity, "note": note,
        "examples": [{"id": str(e[0]), "x": round(float(e[1]), 1), "z": round(float(e[2]), 1), "metric": e[3]} for e in ex],
    })
    if weight and examples and visible:
        for e in sorted(examples, key=lambda e: -abs(e[4]))[:12]:
            EXAMPLES_BY_LOC.append({"check": cid, "id": str(e[0]), "x": float(e[1]), "z": float(e[2]), "w": weight, "metric": e[3], "v": float(e[4])})
    print(f"[{severity:>4}] {cid:<34} {count:>6}/{total:<6} ({100.0 * count / total if total else 0:5.1f}%)  {title}")


def centroid(g):
    c = g.representative_point() if g.geom_type != "Point" else g
    return c.x, c.y


def overlaps(A, B, min_area=0.5, same=False):
    """Pairs (i, j, area) of intersecting polygons between lists A and B (same=True: only i<j)."""
    if not len(A) or not len(B):
        return []
    tree = STRtree(B)
    ii, jj = tree.query(A, predicate="intersects")
    out = []
    if len(ii) == 0:
        return out
    if same:
        m = ii < jj
        ii, jj = ii[m], jj[m]
    areas = shapely.area(shapely.intersection(np.array(A, dtype=object)[ii], np.array(B, dtype=object)[jj]))
    for i, j, a in zip(ii, jj, areas):
        if a >= min_area:
            out.append((int(i), int(j), float(a)))
    return out


# ----------------------------------------------------------------------------------------------------------- load
if not (OUT / "layout.json").exists():
    subprocess.run(["node", str(ROOT / "tools/audit/dump_layout.mjs")], check=True)
geo = load("data/cph-geodata.json")
surf = load("data/cph-surfaces.json")
lakes = load("data/cph-lakes.json")
fur = load("data/cph-furniture.json")
lod_index = load("data/lod2/index.json")
lay = json.loads((OUT / "layout.json").read_text())
plan = lay["plan"]
# the furniture records AFTER placement (racks, bays, bus stops): the audit judges what the engine builds, not the register
for _k, _v in (lay.get("placed") or {}).items():
    if _v is not None:
        fur[_k] = _v

# buildings, as the engine stands them (terrain ground applied by js/layout-cph.js; see dump_layout.mjs)
B = geo["buildings"]
_lb = {b["id"]: b for b in lay.get("buildings", [])}
for b in B:
    if b["id"] in _lb:
        b["ground"] = _lb[b["id"]]["ground"]
        b["street"] = _lb[b["id"]]["street"]
        b["terrain"] = _lb[b["id"]]["terrain"]
bpoly = [ring_poly(b["ring"], b.get("holes")) for b in B]
bvalid = [i for i, p in enumerate(bpoly) if p is not None and not p.is_empty]
bgeoms = [bpoly[i] for i in bvalid]
btree = STRtree(bgeoms)
bunion = unary_union(bgeoms)
print(f"buildings {len(B)} ({len(bgeoms)} valid polygons)")

# carriageways (the engine's capped width) and moving-traffic corridors
roads = [r for r in lay["roads"] if r["veh"] and not r.get("drop")]
road_lines = [LineString(np.array(r["pts"]).reshape(-1, 2)) for r in roads]
carriage = [ln.buffer(r["half"], cap_style="flat", join_style="mitre", mitre_limit=3.0) for ln, r in zip(road_lines, roads)]
carriage_union = unary_union(carriage)
ctree = STRtree(carriage)
corr = []
for ln, r in zip(road_lines, roads):
    # the strip the simulated traffic sweeps (dump_layout.mjs movingHalfWidth: lanes at 1.5 m + n x 3 m, cars 1.9 m wide)
    corr.append(ln.buffer(r["moving"], cap_style="flat", join_style="mitre", mitre_limit=3.0))
corr_union = unary_union(corr)
rtree = STRtree(road_lines)

# cycle tracks: the road-side strips as the engine reads them (width + the arc-length ranges where they stand) + KK cykelsti lines
def strip_polygon(ln, hw, w, side, a=None, b=None):
    from shapely.ops import substring
    piece = ln if a is None else substring(ln, a, b)
    if piece.length < 0.3:
        return None
    kw = 2 * KERB_W + w
    outer = piece.buffer(side * (hw + kw), single_sided=True, cap_style="flat", join_style="mitre", mitre_limit=3.0)
    inner = piece.buffer(side * hw, single_sided=True, cap_style="flat", join_style="mitre", mitre_limit=3.0)
    p = outer.difference(inner)
    return None if p.is_empty else p


cyc, cyc_id = [], []
for ln, r in zip(road_lines, roads):
    for sp in r.get("strips", []):
        for rng in (sp["ranges"] if sp["ranges"] is not None else [None]):
            poly = strip_polygon(ln, r["half"], sp["w"], sp["side"], *(rng or (None, None)))
            if poly is not None:
                cyc.append(poly)
                cyc_id.append(f"{r['id']}:{'right' if sp['side'] > 0 else 'left'}")
for c in lay["cycleTracks"]:
    if len(c["pts"]) >= 4:
        cyc.append(LineString(np.array(c["pts"]).reshape(-1, 2)).buffer((c.get("width") or CYCLE_W) / 2, cap_style="flat"))
        cyc_id.append(c["id"])
cyc_union = unary_union(cyc)
cyctree = STRtree(cyc)

# what the engine really draws (asphalt / cycle-strip triangles dumped by dump_layout.mjs): used for props
def tri_union(flat):
    if not flat:
        return Polygon()
    a = np.array(flat, dtype=float).reshape(-1, 3, 2) / 100.0
    polys = shapely.polygons(a[:, [0, 1, 2, 0], :])
    polys = polys[shapely.area(polys) > 1e-6]
    return unary_union(polys)

eng_asphalt = tri_union(lay["layers"]["asphalt"])
eng_cycle = tri_union(lay["layers"]["cycle"])
# props are judged against what is drawn (the per-road polygons above, with mitred corners, are a little wider at bends)
carriage_union = eng_asphalt
cyc_union = eng_cycle

# pavement
sw = [ring_poly(s["ring"], s.get("holes")) for s in lay["sidewalks"]]
sw_ids = [s["id"] for s, p in zip(lay["sidewalks"], sw) if p is not None]
sw = [p for p in sw if p is not None]
sw_union = unary_union(sw)

# water (lakes minus bridge decks), ponds, raw geodata water
lake_polys = [ring_poly(l["ring"]) for l in lakes["lakes"]]
bridge_polys = [ring_poly(b["ring"]) for b in lakes["bridges"]]
pond_polys = [ring_poly(p["ring"]) for p in lakes["ponds"]]
bridge_union = unary_union([b for b in bridge_polys if b])
water_open = unary_union([p for p in lake_polys + pond_polys if p]).difference(bridge_union)
water_all = unary_union([p for p in lake_polys + pond_polys if p])
geo_water = [ring_poly(w["ring"]) for w in geo["water"]]
wtree_geoms = [p for p in lake_polys + pond_polys if p]

# ----------------------------------------------------------------------------------------------------------- 1. buildings
print("\n== buildings ==")
# footprint overlaps
pairs = overlaps(bgeoms, bgeoms, 1.0, same=True)
ex = []
dup = 0
zfight = 0
for i, j, a in pairs:
    pi, pj = bgeoms[i], bgeoms[j]
    small = min(pi.area, pj.area)
    if a / small < 0.05:
        continue
    bi, bj = B[bvalid[i]], B[bvalid[j]]
    iou = a / (pi.area + pj.area - a)
    if iou > 0.8:
        dup += 1
    x, z = centroid(pi.intersection(pj))
    if abs(bi["eave"] - bj["eave"]) < 0.3:
        zfight += 1
    ex.append((f"{bi['id']} x {bj['id']}", x, z, f"{a:.0f} m2 ({100 * a / small:.0f}% of smaller), eave {bi['eave']:.1f}/{bj['eave']:.1f}", a))
check("bld-bld-overlap", "buildings", "Footprint overlaps another footprint (>= 1 m2 and >= 5% of the smaller)", len(ex), len(B), "high", ex,
      f"{dup} pairs are near-duplicates (IoU > 0.8); {zfight} pairs have eaves within 0.3 m (coplanar roofs: z-fighting)", weight=3)

for name, geoms, ids, sev, note in (
    ("bld-carriageway", carriage, [r["id"] for r in roads], "med", "road asphalt/kerbs run through the building volume (visible where the road leaves the building)"),
    ("bld-cycletrack", cyc, cyc_id, "med", "raised cycle track strip inside a footprint"),
):
    pr = overlaps(bgeoms, geoms, 2.0)
    per = defaultdict(float)
    loc = {}
    for i, j, a in pr:
        per[i] += a
        loc.setdefault(i, (ids[j], centroid(bgeoms[i].intersection(geoms[j]))))
    ex = [(B[bvalid[i]]["id"] + " x " + loc[i][0], *loc[i][1], f"{a:.0f} m2 overlap", a) for i, a in per.items()]
    check(name, "buildings", f"Building footprint overlaps {name.split('-')[1]} (>= 2 m2)", len(per), len(B), sev, ex, note, weight=2)

# deep road intrusions: carriageway area inside footprint / carriageway length
deep = []
for k, c in enumerate(carriage):
    a = c.intersection(bunion).area
    if a > 8:
        x, z = centroid(c.intersection(bunion))
        deep.append((roads[k]["id"], x, z, f"{roads[k]['name'] or '-'}: {a:.0f} m2 of the carriageway inside buildings", a))
check("road-through-bld", "roads", "Carriageway has >= 8 m2 inside building footprints", len(deep), len(roads), "high", deep,
      "the road's capped width reaches into a house (centreline too close to the facade or width over-estimated)", weight=3)

# pavement vs buildings (pavement polygon covering footprint)
pr = overlaps(sw, bgeoms, 3.0)
per = defaultdict(float)
loc = {}
for i, j, a in pr:
    per[i] += a
    loc.setdefault(i, (B[bvalid[j]]["id"], centroid(sw[i].intersection(bgeoms[j]))))
ex = [(sw_ids[i] + " x " + loc[i][0], *loc[i][1], f"{a:.0f} m2 pavement inside a footprint", a) for i, a in per.items()]
check("pavement-in-bld", "pavement", "Pavement polygon overlaps a building footprint (>= 3 m2)", len(per), len(sw), "low", ex,
      "mostly hidden inside the wall volume; matters where the building ground is below the pavement 0.2 m", weight=0.5, visible=False)

# buildings vs water
pr = overlaps(bgeoms, wtree_geoms, 1.0)
per = defaultdict(float)
loc = {}
for i, j, a in pr:
    per[i] += a
    loc.setdefault(i, centroid(bgeoms[i].intersection(wtree_geoms[j])))
ex = [(B[bvalid[i]]["id"], *loc[i], f"{a:.0f} m2 in lake", a) for i, a in per.items()]
check("bld-water", "buildings", "Building footprint overlaps a lake (>= 1 m2)", len(per), len(B), "high", ex,
      "walls rise out of the water / lake wall + building wall intersect (e.g. houses on the dossering over the lake edge)", weight=3)

# building ground vs the street the engine draws beside it (terrain + layer offsets: pavement 0.2, carriageway 0.02)
street_gap = [(b, p, b["ground"] - b["street"]) for b, p in zip((B[i] for i in bvalid), bgeoms) if "street" in b]
gs = np.array([b["ground"] for b in B])
bad = [(b["id"], *centroid(p), f"ground {b['ground']:+.2f} vs street {b['street']:+.2f} ({g:+.2f} m)", abs(g)) for b, p, g in street_gap if abs(g) > 0.5]
n_up = sum(1 for _, _, g in street_gap if g > 0.5)
n_dn = sum(1 for _, _, g in street_gap if g < -0.5)
check("bld-ground-vs-street", "buildings", "Building `ground` differs from the walking height just outside its outline by > 0.5 m (floating / sunken ground floor)", len(bad), len(B), "high", bad,
      f"{n_up} float more than 0.5 m above the street they face, {n_dn} are sunk. Percentiles 5/50/95 of ground - street: "
      f"{np.percentile([g for _, _, g in street_gap], 5):.2f} / {np.percentile([g for _, _, g in street_gap], 50):.2f} / {np.percentile([g for _, _, g in street_gap], 95):.2f}. "
      "(Replaces bld-ground-vs-flat-plane and bld-ground-range, which compared the terrain `ground` with the flat plane y = 0.)", weight=3)
tdiff = [(b["id"], *centroid(p), f"ground {b['ground']:+.2f} vs terrain along outline {b['terrain']:+.2f}", abs(b["ground"] - b["terrain"])) for b, p in zip((B[i] for i in bvalid), bgeoms)
         if "terrain" in b and abs(b["ground"] - b["terrain"]) > 0.5]
check("bld-ground-terrain", "buildings", "Building `ground` differs from the terrain model along its outline by > 0.5 m", len(tdiff), len(B), "high", tdiff,
      f"ground min {gs.min():.2f} max {gs.max():.2f} median {np.median(gs):.2f}: one height model for buildings, roads, lakes and props means these agree", weight=2)
step = []
pairs_t = overlaps([g.buffer(0.8) for g in bgeoms], bgeoms, 0.01, same=True)
for i, j, a in pairs_t:
    dg = abs(B[bvalid[i]]["ground"] - B[bvalid[j]]["ground"])
    if dg > 1.5:
        c = bgeoms[i].buffer(0.8).intersection(bgeoms[j]).representative_point()
        step.append((f"{B[bvalid[i]]['id']} / {B[bvalid[j]]['id']}", c.x, c.y, f"party-wall neighbours' ground differ {dg:.1f} m", dg))
check("bld-ground-step-neighbours", "buildings", "Touching buildings whose `ground` differs by > 1.5 m (stepped base along one frontage)", len(step), len(B), "high", step,
      "a continuous Copenhagen block front gets a staircase of base lines / floating ground floors", weight=2.5)
# heights
hts = []
for b, p in zip((B[i] for i in bvalid), bgeoms):
    h = b["eave"] - b["ground"]
    st = b.get("storeys") or 0
    if h > 60 or (st and (h / st > 6.5 or h / st < 2.0)) or h < 2.5:
        hts.append((b["id"], *centroid(p), f"h {h:.1f} m, {st} storeys, {b.get('conf_fields', {}).get('eave', '?')}", abs(h)))
check("bld-height-sanity", "buildings", "Height implausible: > 60 m, < 2.5 m, or > 6.5 / < 2.0 m per storey", len(hts), len(B), "med", hts, "", weight=1)

# ---------------------------------------------------------------------------------------------------------- LoD2
print("\n== lod2 ==")
tiles = {}
def tile_buf(name):
    if name not in tiles:
        tiles[name] = (ROOT / "data/lod2" / lod_index["tiles"][name]["file"]).read_bytes()
    return tiles[name]


def parse_lod2(buf, off, length):
    ox, oy, oz = struct.unpack_from("<fff", buf, off)
    nV, nT, nE = struct.unpack_from("<HHH", buf, off + 12)
    o = off + 18
    raw = np.frombuffer(buf, dtype="<i2", count=3 * nV, offset=o).reshape(-1, 3)
    o += 6 * nV
    pos = raw / 100.0 + np.array([ox, oy, oz])
    idx = np.frombuffer(buf, dtype="<u2", count=3 * nT, offset=o).reshape(-1, 3)
    o += 6 * nT
    kind = np.frombuffer(buf, dtype="u1", count=nT, offset=o)
    o += nT
    o += 2 * nT
    top = np.frombuffer(buf, dtype="<i2", count=nE, offset=o).astype(float)
    top = np.where(top == -32768, np.nan, top / 100.0)
    return pos, idx, kind, top


bid2i = {B[i]["id"]: k for k, i in enumerate(bvalid)}
lod_n = lod_meas = 0
out_ex, out_ex2, eave_ex, high_ex = [], [], [], []
outside_area_tot = 0.0
for bid, e in lod_index["buildings"].items():
    lod_n += 1
    if "offset" not in e or bid not in bid2i:
        continue
    lod_meas += 1
    k = bid2i[bid]
    b = B[bvalid[k]]
    poly = bgeoms[k]
    pos, idx, kind, top = parse_lod2(tile_buf(e["tile"]), e["offset"], e["length"])
    used = np.unique(idx[kind == 0]) if (kind == 0).any() else np.unique(idx)
    pts = shapely.points(pos[used][:, [0, 2]])
    d = shapely.distance(poly, pts)
    md = float(d.max()) if len(d) else 0.0
    if md > 0.5:
        # area of roof triangles outside the footprint
        tris = pos[idx[kind == 0]][:, :, [0, 2]]
        tp = [Polygon(t) for t in tris if abs(np.cross(t[1] - t[0], t[2] - t[0])) > 1e-6]
        a_out = unary_union(tp).difference(poly).area if tp else 0.0
        outside_area_tot += a_out
        x, z = centroid(poly)
        out_ex.append((bid, x, z, f"roof vertex {md:.1f} m outside, {a_out:.0f} m2 of roof outside the footprint", md))
        if md > 1.5:
            out_ex2.append((bid, x, z, f"{md:.1f} m", md))
    tt = top[~np.isnan(top)]
    if len(tt):
        diff = float(np.median(tt) - b["eave"])
        if abs(diff) > 2.0:
            eave_ex.append((bid, *centroid(poly), f"LoD2 median eave {np.median(tt):.1f} vs geodata eave {b['eave']:.1f} ({diff:+.1f} m)", abs(diff)))
    rtop = float(pos[:, 1].max())
    if rtop - b["eave"] > 8:
        high_ex.append((bid, *centroid(poly), f"roof top {rtop:.1f} vs eave {b['eave']:.1f}", rtop - b["eave"]))
check("lod2-beyond-footprint", "lod2", "LoD2 mesh has a vertex > 0.5 m outside its footprint", len(out_ex), lod_meas, "high", out_ex,
      f"{len(out_ex2)} exceed 1.5 m; total roof area outside footprints {outside_area_tot:.0f} m2. Roofer eave overhangs / neighbour points; the facade walls stop at the footprint so the roof overhangs or floats", weight=3)
check("lod2-eave-mismatch", "lod2", "LoD2 median eave differs from geodata eave by > 2 m", len(eave_ex), lod_meas, "med", eave_ex,
      "facade walls are cut to the LoD2 eave per edge, so this changes the wall height silently", weight=1.5)
check("lod2-spire", "lod2", "LoD2 roof top > 8 m above geodata eave", len(high_ex), lod_meas, "med", high_ex, "tall pitched roofs / towers / vegetation points in the cloud", weight=1)
print(f"  lod2 index buildings {lod_n}, measured {lod_meas}, buildings without lod2 entry {len(B) - lod_n}")

# ---------------------------------------------------------------------------------------------------------- 2. water
print("\n== water ==")
for name, geoms, ids, sev, note, wt in (
    ("water-carriageway", carriage, [r["id"] for r in roads], "high",
     "road asphalt over open water (bridges other than bridge:0 are not modelled as bridges: the water plane is cut, the road is not)", 3),
    ("water-cycletrack", cyc, cyc_id, "high", "cycle track strip over the lake", 2),
    ("water-pavement", sw, sw_ids, "high", "pavement polygon over the lake (floats above the sunk water)", 3),
):
    pr = overlaps(geoms, [water_open], 1.0)
    ex = []
    for i, _, a in pr:
        x, z = centroid(geoms[i].intersection(water_open))
        ex.append((ids[i], x, z, f"{a:.0f} m2 over open water", a))
    check(name, "water", f"{name.split('-')[1].capitalize()} overlaps open water (>= 1 m2)", len(ex), len(geoms), sev, ex, note, weight=wt)

# raw non-vehicular paths (footway/cycleway/service roads as lines)
paths = [r for r in lay["roads"] if not r["veh"]]
ex = []
for r in paths:
    ln = LineString(np.array(r["pts"]).reshape(-1, 2))
    L = ln.intersection(water_open).length
    if L > 3:
        pt = ln.intersection(water_open).representative_point()
        ex.append((r["id"], pt.x, pt.y, f"{r['cls']} {r['name'] or ''}: {L:.0f} m in water", L))
check("water-paths", "water", "Footway/cycleway centreline runs > 3 m through open water", len(ex), len(paths), "low", ex, "pedestrian/cyclist routes through the lake (OSM path across a bridge not in the bridge list)", weight=1)

# surfaces vs lakes
cut_ids = {c["id"] for c in lakes["surface_cuts"]}
S = surf["surfaces"]
spoly, scls, sid = [], [], []
for s in S:
    if s["id"] in cut_ids:
        for rep in next(c for c in lakes["surface_cuts"] if c["id"] == s["id"])["replace"]:
            p = ring_poly(rep["ring"], rep.get("holes"))
            if p:
                spoly.append(p); scls.append(rep.get("cls", s["cls"])); sid.append(rep["id"])
        continue
    p = ring_poly(s["ring"], s.get("holes"))
    if p:
        spoly.append(p); scls.append(s["cls"]); sid.append(s["id"])
pr = overlaps(spoly, [water_open], 1.0)
ex = [(sid[i], *centroid(spoly[i].intersection(water_open)), f"{scls[i]}: {a:.0f} m2 over water (after the engine's surface_cuts)", a) for i, _, a in pr]
check("water-surface", "water", "Ground-material polygon overlaps open water after surface_cuts (>= 1 m2)", len(ex), len(spoly), "med", ex, "register ground drawn at 0.014 above the sunk water", weight=1.5)

# lake walls: with one height model the wall top follows the terrain at the shore; the water sits at its measured level
lw = lay.get("lakeWalls")
if lw:
    fb = lw["freeboards"]
    tall = [f for f in fb if f["free"] > 2.0]
    ex = [(f["id"], f["x"], f["z"], f"wall {f['free']:.2f} m above the water", f["free"]) for f in tall]
    check("lake-wall-too-tall", "water", "Lake wall more than 2.0 m above the water at a shore vertex (8 m spacing)", len(tall), len(fb), "med", ex,
          f"free-board p5/p50/p95 {np.percentile([f['free'] for f in fb], 5):.2f} / {np.percentile([f['free'] for f in fb], 50):.2f} / {np.percentile([f['free'] for f in fb], 95):.2f} m; "
          "the water level is the measured DTM level of each lake, the wall top follows the terrain at the shore", weight=1)

# lake lights
ll = plan["lakeLights"]
ex, inw = [], 0
wtree = STRtree([water_open])
llpts = [Point(l["x"], l["z"]) for l in ll]
for l, p in zip(ll, llpts):
    d = water_open.distance(p)
    if water_open.contains(p):
        inw += 1
        ex.append(("lakelight", l["x"], l["z"], "inside the lake", 10))
    elif d > 6:
        ex.append(("lakelight", l["x"], l["z"], f"{d:.0f} m from the water edge", d))
check("lakelights-water", "furniture", "Lake-path lights inside the lake or > 6 m from its edge", len(ex), len(ll), "med", ex, f"{inw} are inside open water", weight=2)

# ---------------------------------------------------------------------------------------------------------- 3. surfaces
print("\n== surfaces ==")
pairs = overlaps(spoly, spoly, 2.0, same=True)
ex_diff, ex_same = [], []
for i, j, a in pairs:
    x, z = centroid(spoly[i].intersection(spoly[j]))
    if scls[i] != scls[j]:
        ex_diff.append((f"{sid[i][-12:]} ({scls[i]}) x {sid[j][-12:]} ({scls[j]})", x, z, f"{a:.0f} m2", a))
    else:
        ex_same.append((f"{sid[i][-12:]} x {sid[j][-12:]} ({scls[i]})", x, z, f"{a:.0f} m2", a))
check("surf-surf-diffclass", "surfaces", "Two ground-material polygons of different class overlap (>= 2 m2)", len(ex_diff), len(spoly), "med", ex_diff,
      "the later polygon wins per triangle; the loser leaks through as z-fighting patches (both at y 0.014)", weight=2)
check("surf-surf-sameclass", "surfaces", "Duplicate / overlapping polygons of the same class (>= 2 m2)", len(ex_same), len(spoly), "low", ex_same, "", weight=0.5, visible=False)
pr = overlaps(spoly, bgeoms, 5.0)
per = defaultdict(float)
for i, j, a in pr:
    per[i] += a
ex = [(sid[i], *centroid(spoly[i]), f"{scls[i]}: {a:.0f} m2 ({100 * a / spoly[i].area:.0f}%) under buildings", a) for i, a in per.items() if a / spoly[i].area > 0.3]
check("surf-under-bld", "surfaces", "Ground-material polygon > 30% under buildings (and >= 5 m2)", len(ex), len(spoly), "low", ex, "hidden by the wall volumes", weight=0.5, visible=False)
pav_cls = {"kbh_fortov", "raadhus", "cobbles", "setts", "gravel"}
pr = overlaps([p for p, c in zip(spoly, scls) if c in pav_cls], carriage, 5.0)
sp_pav = [i for i, c in enumerate(scls) if c in pav_cls]
per = defaultdict(float)
for i, j, a in pr:
    per[sp_pav[i]] += a
ex = [(sid[i], *centroid(spoly[i].intersection(carriage_union)), f"{scls[i]}: {a:.0f} m2 under carriageway", a) for i, a in per.items()]
check("surf-under-road", "surfaces", "Pavement-class ground polygon overlaps a carriageway (>= 5 m2)", len(ex), len(sp_pav), "med", ex,
      "ground at 0.014 under asphalt at 0.02: 6 mm apart, z-fighting at distance", weight=1.5)

# ---------------------------------------------------------------------------------------------------------- 4. road/cycle/pavement mutual
print("\n== roads / cycle / pavement ==")
# graph nodes of degree >= 3
rg = lay["roadGraph"]
nodes = np.array(rg["nodes"]).reshape(-1, 2)
deg = Counter()
for l in rg["links"]:
    deg[l[0]] += 1
    deg[l[1]] += 1
jn = np.array([nodes[i] for i, d in deg.items() if d >= 3])
jtree = STRtree(shapely.points(jn))
ends = shapely.points(np.array([[ln.coords[0], ln.coords[-1]] for ln in road_lines]).reshape(-1, 2))
etree = STRtree(ends)

def near_node(x, z, r):
    return len(jtree.query(Point(x, z).buffer(r))) > 0 or len(etree.query(Point(x, z).buffer(r))) > 0

pr = overlaps(carriage, carriage, 3.0, same=True)
ex, junc = [], 0
for i, j, a in pr:
    c = carriage[i].intersection(carriage[j])
    x, z = centroid(c)
    r = roads[i]["half"] + roads[j]["half"] + 4
    if near_node(x, z, r):
        junc += 1
        continue
    ex.append((f"{roads[i]['name'] or roads[i]['id']} x {roads[j]['name'] or roads[j]['id']}", x, z, f"{a:.0f} m2 away from any junction/road end", a))
check("road-road-overlap", "roads", "Two carriageways overlap away from junctions / road ends (>= 3 m2)", len(ex), len(roads), "med", ex,
      f"{junc} further overlaps are at junctions (expected); here: duplicate/parallel centrelines or an unmodelled bridge/underpass crossing", weight=2)

pr = overlaps(cyc, carriage, 3.0)
ex, junc = [], 0
for i, j, a in pr:
    if cyc_id[i].startswith(roads[j]["id"] + ":"):
        continue
    x, z = centroid(cyc[i].intersection(carriage[j]))
    if near_node(x, z, roads[j]["half"] + 6):
        junc += 1
        continue
    ex.append((f"{cyc_id[i]} x {roads[j]['name'] or roads[j]['id']}", x, z, f"{a:.0f} m2", a))
check("cycle-carriageway", "cycle tracks", "Cycle track strip overlaps another road's carriageway away from a junction (>= 3 m2)", len(ex), len(cyc), "med", ex,
      f"{junc} more are at junction mouths", weight=2)

pr = overlaps(cyc, cyc, 2.0, same=True)
ex = []
for i, j, a in pr:
    if cyc_id[i].split(":")[0] == cyc_id[j].split(":")[0]:
        continue
    x, z = centroid(cyc[i].intersection(cyc[j]))
    ex.append((f"{cyc_id[i]} x {cyc_id[j]}", x, z, f"{a:.0f} m2", a))
check("cycle-cycle-overlap", "cycle tracks", "Two cycle tracks overlap (KK cykelsti vs road-side strips; >= 2 m2)", len(ex), len(cyc), "med", ex,
      "doubled cycle track meshes at 0.12 / 0.118: coplanar z-fighting", weight=2)

pr = overlaps(sw, carriage, 2.0)
ex, per = [], defaultdict(float)
loc = {}
for i, j, a in pr:
    per[i] += a
    loc.setdefault(i, (roads[j]["name"] or roads[j]["id"], centroid(sw[i].intersection(carriage[j]))))
ex = [(f"{sw_ids[i][-14:]} x {loc[i][0]}", *loc[i][1], f"{a:.0f} m2 pavement over carriageway", a) for i, a in per.items()]
check("pavement-carriageway", "pavement", "Pavement polygon overlaps a carriageway (>= 2 m2)", len(ex), len(sw), "med", ex,
      "pavement at 0.2 sits 18 cm above the asphalt: a raised slab in the roadway (carriageway cap wider than the real kerb-to-kerb)", weight=2.5)

pr = overlaps(sw, cyc, 2.0)
per = defaultdict(float)
loc = {}
for i, j, a in pr:
    per[i] += a
    loc.setdefault(i, (cyc_id[j], centroid(sw[i].intersection(cyc[j]))))
ex = [(f"{sw_ids[i][-14:]} x {loc[i][0]}", *loc[i][1], f"{a:.0f} m2", a) for i, a in per.items()]
check("pavement-cycletrack", "pavement", "Pavement polygon overlaps a cycle track (>= 2 m2; the engine cuts pavement where cycle tracks pass, so this is the area it removes)",
      len(ex), len(sw), "low", ex, "handled by `skip` in buildGroundBuckets; reported to show how much pavement the cycle layer deletes", weight=0.5, visible=False)

# carriageway width capping: roads whose data width differs a lot from the engine width
caps = [(r["id"], *list(LineString(np.array(r["pts"]).reshape(-1, 2)).interpolate(0.5, normalized=True).coords)[0],
         f"{r['name'] or '-'} {r['cls']}: data width {r['width']:.0f} m -> engine {2 * r['half']:.1f} m ({r['lanesFwd']}+{0 if r['oneway'] else r['lanesBack']} lanes)",
         r["width"] - 2 * r["half"]) for r in roads if r["width"] and r["width"] - 2 * r["half"] > 10]
check("road-width-cap", "roads", "Engine carriageway is > 10 m narrower than the data width", len(caps), len(roads), "low", caps,
      "expected by design (width includes parking/cycle/pavement); the strip between the capped kerb and the facades is filled by pavement polygons or stays bare ground", weight=0, visible=False)

# ground height jumps
jumps = lay["jumps"]
mid = [j for j in jumps if j["off"] == 0]
big = [j for j in jumps if abs(j["dh"]) > 0.25]
ex = [(j["road"], j["x"], j["z"], f"{j['name'] or ''} offset {j['off']} dh {j['dh']:+.2f}", abs(j["dh"])) for j in big]
check("ground-jump-gt25cm", "ground height", "Walking-height field steps by > 0.25 m over 1 m (carriageway edge/centre probes)", len(big), lay["jumpsTotalProbes"], "med", ex,
      f"{len(jumps)} steps > 0.15 m total, {len(mid)} on carriageway centrelines (should be 0: asphalt is flat at 0.02). Kerb steps are 0.10-0.18 m by design", weight=1)
ex = [(j["road"], j["x"], j["z"], f"{j['name'] or ''} centreline dh {j['dh']:+.2f}", abs(j["dh"])) for j in mid]
check("ground-jump-centreline", "ground height", "Height step > 0.15 m ALONG a carriageway centreline", len(mid), lay["jumpsTotalProbes"], "med", ex,
      "cars/cyclists/pedestrians read this field: a step on the roadway = a pavement/cycle/surface slab covering the asphalt there", weight=1.5)

# ---------------------------------------------------------------------------------------------------------- 5. points
print("\n== point layers ==")
DIMS = {  # (w, d, off_z) of the footprint, from js/street-furniture-geometry.js
    "cars": None, "meters": (0.46, 0.32, 0), "bins": (0.52, 0.52, 0), "glass": (3.8, 1.2, 0), "stands": (1.9, 0.72, 0), "benches": None,
    "hoops": (0.06, 0.45, 0), "bikes": (0.5, 1.75, 0), "flags": (0.1, 0.1, 0), "shelters": (3.2, 1.7, 0), "rescue": (0.5, 0.2, 0), "monuments": (1.3, 1.3, 0),
}
items = []  # (cat, idx, x, z, footprint)
def add_cat(cat, lst, fp):
    for i, it in enumerate(lst):
        items.append((cat, i, it["x"], it["z"], fp(it)))

add_cat("trees", plan["trees"], lambda t: Point(t["x"], t["z"]).buffer(0.3))
masts = [l for l in plan["lamps"] if l["mount"] == "mast" or l["bracket"]]
add_cat("lamp-poles", masts, lambda l: Point(l["x"], l["z"]).buffer(0.18))
add_cat("cars", plan["cars"], lambda c: obb(c["x"], c["z"], c["yaw"], 1.9, 4.6) if c["body"] == "sedan" else obb(c["x"], c["z"], c["yaw"], 1.95, 4.7))
add_cat("bollards", plan["bollards"], lambda b: obb(b["x"], b["z"], 0, 0.3, 0.3) if b["material"] == "granite" else Point(b["x"], b["z"]).buffer(0.08))
add_cat("benches", plan["benches"], lambda b: obb(b["x"], b["z"], b["yaw"], b["length"] or 1.8, 0.55, -0.03))
for cat, dims in DIMS.items():
    if dims is None:
        continue
    w, d, oz = dims
    add_cat(cat, plan[cat], lambda it, w=w, d=d, oz=oz: obb(it["x"], it["z"], it.get("yaw", 0), w, d, oz))
add_cat("lakeLights", plan["lakeLights"], lambda l: Point(l["x"], l["z"]).buffer(0.08))

cats = defaultdict(list)
for k, (cat, i, x, z, fp) in enumerate(items):
    cats[cat].append(k)
fps = [it[4] for it in items]
fp_tree = STRtree(fps)
cat_of = [it[0] for it in items]
print({c: len(v) for c, v in cats.items()})

def hits_in(region_union, cat, lo=0.25, hi=1.01):
    """Footprints of `cat` whose covered fraction by the region is in [lo, hi): list of (idx, x, z, fraction)."""
    out = []
    for k in cats[cat]:
        _, i, x, z, fp = items[k]
        a = fp.intersection(region_union).area / fp.area if fp.area > 0 else 0
        if lo <= a < hi:
            out.append((i, x, z, a))
    return out


def emit(cid, cat, title, rows, sev, note="", weight=2.0, metric=lambda r: f"{100 * r[3]:.0f}% of footprint", visible=True):
    ex = [(f"{cat}[{r[0]}]", r[1], r[2], metric(r), r[3]) for r in rows]
    check(f"{cid}:{cat}", cat, f"{cat} {title}", len(rows), len(cats[cat]), sev, ex, note, weight=weight if visible else 0.3, visible=visible)


# in buildings: poking through a facade (25-90% inside, visible) vs fully inside (>= 90%, hidden inside the wall volume)
POKE_SEV = {"cars": "high", "trees": "high", "lamp-poles": "high", "benches": "high", "bins": "high", "glass": "high", "monuments": "high", "meters": "high", "bollards": "med"}
for cat in cats:
    part = hits_in(bunion, cat, 0.25, 0.9)
    full = hits_in(bunion, cat, 0.9)
    if part:
        emit("in-building-partial", cat, "straddles a facade (25-90% of footprint inside a building)", part, POKE_SEV.get(cat, "med"), "half inside the wall: visible poking through the facade")
    if full:
        emit("in-building-hidden", cat, "entirely inside a building footprint (>= 90%)", full, "low" if cat in ("stands", "hoops", "bikes", "monuments") or len(full) < 8 else "med",
             "hidden inside the wall volume (invisible, but a data/placement error and wasted instances)", visible=False)

# in water: depth = distance to the shore
wb = water_open.boundary
for cat in cats:
    rows = hits_in(water_open, cat, 0.25)
    if not rows:
        continue
    rows = [(i, x, z, wb.distance(Point(x, z))) for i, x, z, a in rows]
    deep = sum(1 for r in rows if r[3] > 1.0)
    emit("in-water", cat, "in open water (>= 25% of footprint)", rows, "high" if deep else "med",
         f"{deep} are more than 1 m from the shore; the rest sit on the quay edge. Items stand at y = ground field (0) while the water plane is 0.8 m lower",
         weight=2.5, metric=lambda r: f"{r[3]:.1f} m from shore")

CYC_SEV = {"cars": "high", "trees": "med", "lamp-poles": "low", "bikes": "low", "hoops": "low"}
for cat in cats:
    rows = hits_in(cyc_union, cat, 0.25)
    if rows:
        emit("on-cycletrack", cat, "on a cycle track (>= 25% of footprint)", rows, CYC_SEV.get(cat, "med"), "blocks the track (bikes/hoops: racks laid over the track)", weight=2)

ROAD_SEV = {"trees": "high", "lamp-poles": "high", "bins": "high", "benches": "high", "bollards": "low", "cars": "low", "meters": "med", "flags": "med", "shelters": "high",
            "glass": "high", "stands": "high", "monuments": "high", "rescue": "high", "hoops": "med", "bikes": "med", "lakeLights": "high"}
for cat in cats:
    rows = hits_in(carriage_union, cat, 0.25)
    if rows:
        emit("on-carriageway", cat, "on the capped carriageway (>= 25% of footprint)", rows, ROAD_SEV.get(cat, "med"),
             "standing in the roadway (cars/bollards/flags at the kerb are partly expected)", weight=2)

# tree crowns vs facades ------------------------------------------------------------------------------------------
tr = plan["trees"]
ex, trunk_ex = [], []
bg_arr = np.array(bgeoms, dtype=object)
for i, t in enumerate(tr):
    p = Point(t["x"], t["z"])
    near = btree.query(p.buffer(t["crownR"] + 0.5))
    if not len(near):
        continue
    crown_base = max(1.4, t["height"] * 0.3)
    for j in near:
        poly = bgeoms[j]
        b = B[bvalid[j]]
        if poly.contains(p):
            continue
        d = poly.distance(p)
        top = b["eave"] - b["ground"]  # height of the eave above the building's own ground (the terrain is not flat)
        if top <= crown_base:
            continue
        depth = t["crownR"] - d
        if depth > 1.0:
            ex.append((f"tree[{i}] {t['genus']} h{t['height']:.0f} r{t['crownR']:.1f}", t["x"], t["z"], f"crown reaches {depth:.1f} m into {b['id']} (eave {top:.1f})", depth))
            break
for i, t in enumerate(tr):
    p = Point(t["x"], t["z"])
    for j in btree.query(p.buffer(0.6)):
        if bgeoms[j].distance(p) < 0.5 and not bgeoms[j].contains(p):
            trunk_ex.append((f"tree[{i}]", t["x"], t["z"], f"trunk {bgeoms[j].distance(p):.2f} m from facade", 1 - bgeoms[j].distance(p)))
            break
check("tree-crown-facade", "trees", "Crown penetrates a facade by > 1 m (crown base below the eave)", len(ex), len(tr), "med", ex,
      "leaf cards and the mid-LOD crown blob cut through walls; the engine places trees at data x,z and never moves them off buildings", weight=1.5)
check("tree-trunk-facade", "trees", "Trunk < 0.5 m from a facade", len(trunk_ex), len(tr), "low", trunk_ex, "", weight=0.3, visible=False)

# pairwise overlaps between footprints -----------------------------------------------------------------------------
flag_pts = [(f["x"], f["z"]) for f in plan["flags"]]
flag_tree = STRtree(shapely.points(np.array(flag_pts))) if flag_pts else None
def near_flag(x, z, r=6.0):
    return flag_tree is not None and len(flag_tree.query(Point(x, z).buffer(r))) > 0
ii, jj = fp_tree.query(fps, predicate="intersects")
m = ii < jj
ii, jj = ii[m], jj[m]
A = shapely.area(shapely.intersection(np.array(fps, dtype=object)[ii], np.array(fps, dtype=object)[jj]))
pair_ex = defaultdict(list)
pair_n = Counter()
STOP = {"flags", "shelters", "benches", "bins", "countdowns"}
for i, j, a in zip(ii, jj, A):
    ci, cj = cat_of[i], cat_of[j]
    small = min(fps[i].area, fps[j].area)
    if a < 0.02 or a / small < 0.2:
        continue
    if ci == cj == "bikes" or {ci, cj} == {"bikes", "hoops"} or ci == cj == "hoops":
        continue
    xi, zi = items[i][2], items[i][3]
    if (ci in STOP or cj in STOP) and near_flag(xi, zi):
        continue
    key = tuple(sorted((ci, cj)))
    pair_n[key] += 1
    pair_ex[key].append((f"{ci}[{items[i][1]}] x {cj}[{items[j][1]}]", xi, zi, f"{a:.2f} m2 ({100 * a / small:.0f}% of smaller)", a))
for key, n in sorted(pair_n.items(), key=lambda kv: -kv[1]):
    tot = len(cats[key[0]]) if key[0] == key[1] else len(cats[key[0]]) + len(cats[key[1]])
    sev = "high" if key[0] == key[1] == "cars" or ("cars" in key and n > 5) else ("med" if n > 5 else "low")
    check(f"overlap:{key[0]}+{key[1]}", "furniture", f"{key[0]} overlaps {key[1]} (>= 20% of the smaller footprint)", n, tot, sev, pair_ex[key], "", weight=2 if sev != "low" else 0.3, visible=sev != "low")

# bike rack rows ---------------------------------------------------------------------------------------------------
racks = fur["bikeRacks"]
caps = np.array([r.get("capacity") or 6 for r in racks])
rows = []
for r in racks:
    slots = max(2, min(48, r.get("capacity") or 6))
    L = slots * 0.5
    dx, dz = math.sin(r["yaw"]), math.cos(r["yaw"])
    rows.append(LineString([(r["x"] - dx * L / 2, r["z"] - dz * L / 2), (r["x"] + dx * L / 2, r["z"] + dz * L / 2)]).buffer(0.45, cap_style="flat"))
ex = []
for k, row in enumerate(rows):
    a_b = row.intersection(bunion).area
    a_c = row.intersection(carriage_union).area
    a_w = row.intersection(water_open).area
    if a_b > 0.3 * row.area or a_c > 0.3 * row.area or a_w > 0.1 * row.area:
        ex.append((f"rack[{k}] cap {racks[k].get('capacity')}", racks[k]["x"], racks[k]["z"],
                   f"row {rows[k].length / 2:.0f} m: {100 * a_b / row.area:.0f}% in building, {100 * a_c / row.area:.0f}% on carriageway, {100 * a_w / row.area:.0f}% water", max(a_b, a_c, a_w)))
check("rack-rows", "bikeRacks", "Rack row (capacity x 0.5 m, centred on the point) >= 30% in a building / on the carriageway or in water", len(ex), len(racks), "med", ex,
      f"capacity median {np.median(caps):.0f}, p95 {np.percentile(caps, 95):.0f}, max {caps.max()}; engine caps rows at 48 slots = 24 m, centred on the data point", weight=1.5)
long_rows = [(f"rack[{k}] cap {r.get('capacity')}", r["x"], r["z"], f"{min(48, r.get('capacity') or 6) * 0.5:.0f} m row", min(48, r.get("capacity") or 6)) for k, r in enumerate(racks)
             if (r.get("capacity") or 6) > 40]
check("rack-giant", "bikeRacks", "Rack with capacity > 40 (> 20 m row, > 40 bikes)", len(long_rows), len(racks), "med", long_rows,
      "one record per whole KK stand field; the engine lays a single straight row of up to 24 m", weight=1)

# ---------------------------------------------------------------------------------------------------------- 6. parked cars
print("\n== parked cars ==")
cars = plan["cars"]
bays = fur["parkingBays"]
bay_pts = shapely.points(np.array([[b["x"], b["z"]] for b in bays]))
bay_tree = STRtree(bay_pts)
bay_poly = [ring_poly(m["ring"]) for m in surf["markings"] if m["kind"] == "bay" and m.get("ring")]
bay_poly = [p for p in bay_poly if p]
bay_union = unary_union(bay_poly)
car_fp = [fps[k] for k in cats["cars"]]
n_c = len(cars)
support_union = unary_union([carriage_union, bay_union])
off_ex, pave_ex, lane_ex, orient_ex, wrongway = [], [], [], [], []
road_lines_arr = road_lines
for i, c in enumerate(cars):
    fp = car_fp[i]
    a_sup = fp.intersection(support_union).area / fp.area
    a_sw = fp.intersection(sw_union).area / fp.area
    a_ln = fp.intersection(corr_union).area / fp.area
    a_b = fp.intersection(bunion).area / fp.area
    nb = bay_tree.nearest(Point(c["x"], c["z"]))
    kind = bays[nb]["kind"]
    ri = rtree.nearest(Point(c["x"], c["z"]))
    dist_road = road_lines[ri].distance(Point(c["x"], c["z"]))
    if a_sup < 0.5 and a_b < 0.25:
        off_ex.append((f"car[{i}] {kind}", c["x"], c["z"], f"{100 * a_sup:.0f}% on carriageway/bay paint, {100 * a_sw:.0f}% on pavement, {dist_road:.1f} m from centreline", 1 - a_sup))
    if a_sw > 0.4:
        pave_ex.append((f"car[{i}] {kind}", c["x"], c["z"], f"{100 * a_sw:.0f}% on pavement", a_sw))
    if a_ln > 0.25:
        lane_ex.append((f"car[{i}] {kind}", c["x"], c["z"], f"{100 * a_ln:.0f}% inside the moving-lane corridor ({road_lines and roads[ri]['name']})", a_ln))
    # orientation vs nearest kerb
    ln = road_lines[ri]
    d = ln.project(Point(c["x"], c["z"]))
    a = ln.interpolate(max(0, d - 1.0)); b2 = ln.interpolate(min(ln.length, d + 1.0))
    hd = math.atan2(b2.x - a.x, b2.y - a.y)
    ang = abs(((c["yaw"] - hd + math.pi / 2) % math.pi) - math.pi / 2)  # 0 = parallel to the road, pi/2 = perpendicular
    if kind == "par" and ang > math.radians(25) and dist_road < 15:
        orient_ex.append((f"car[{i}] par", c["x"], c["z"], f"{math.degrees(ang):.0f} deg to the road (parallel bay)", ang))
    if kind == "perp" and ang < math.radians(35) and dist_road < 15:
        orient_ex.append((f"car[{i}] perp", c["x"], c["z"], f"{math.degrees(ang):.0f} deg to the road (perpendicular bay)", math.pi / 2 - ang))
check("car-off-carriageway", "cars", "Parked car < 50% on carriageway/bay paint (and not mostly in a building)", len(off_ex), n_c, "high", off_ex,
      "bay points come from kerb lines / parking polygons; where the engine's capped carriageway is narrower than the real kerb-to-kerb the car sits on pavement or bare ground", weight=3)
check("car-on-pavement", "cars", "Parked car >= 40% on a pavement polygon", len(pave_ex), n_c, "high", pave_ex, "wheels on the raised pavement at y 0.2 vs car y from the same field", weight=3)
check("car-in-moving-lane", "cars", "Parked car >= 25% inside the moving-traffic corridor (lanes x 3.0 m around the centreline)", len(lane_ex), n_c, "high", lane_ex,
      "the traffic sim drives through parked cars", weight=3)
check("car-orientation", "cars", "Parked car axis > 25 deg off the kerb for parallel bays, or < 35 deg for perpendicular bays", len(orient_ex), n_c, "med", orient_ex,
      "bay `yaw` is a kerb-line direction; the 90-degree convention of angled/perp bays is derived without the road side", weight=2)
print(f"  cars {n_c}, bays {len(bays)}, occupancy {100 * n_c / len(bays):.0f}%")

# ---------------------------------------------------------------------------------------------------------- 7. lamps & wires
print("\n== lamps / wires ==")
lamps = plan["lamps"]
wires = [l for l in lamps if l["wire"]]
thru, low, floating, long_, short, sunk = [], [], [], [], [], []
bd = [bgeoms[i] for i in range(len(bgeoms))]
for i, l in enumerate(wires):
    p = np.array(l["wire"]["pts"]).reshape(-1, 3)
    ln = LineString(p[:, [0, 2]])
    ys = p[:, 1]
    # facade anchors: distance from each end to nearest building boundary
    d0 = bunion.distance(Point(*p[0, [0, 2]]))
    d1 = bunion.distance(Point(*p[-1, [0, 2]]))
    if max(d0, d1) > 2.5:
        floating.append((f"lamp[{i}]", p[0, 0], p[0, 2], f"anchors {d0:.1f} / {d1:.1f} m from any facade", max(d0, d1)))
    # crossing a building above its eave? the wire passes through the volume where eave > wire height
    inside = ln.intersection(bunion.buffer(-0.4))
    if inside.length > 1.0:
        top_here = 0
        for j in btree.query(ln):
            if bgeoms[j].buffer(-0.4).intersects(ln):
                top_here = max(top_here, B[bvalid[j]]["eave"])
        wy = float(np.mean(ys))
        if top_here > wy - 0.3:
            c = inside.representative_point()
            thru.append((f"lamp[{i}]", c.x, c.y, f"{inside.length:.1f} m of the span inside a building (eave {top_here:.1f} > wire {wy:.1f})", inside.length))
    miny = float(ys.min()) - l["y"]
    if miny < 5.0 or l["lampY"] - l["y"] < 5.0:
        low.append((f"lamp[{i}]", l["x"], l["z"], f"wire min {miny:.1f} m, lantern {l['lampY'] - l['y']:.1f} m above ground", 5.0 - min(miny, l["lampY"] - l["y"])))
    if l["wire"]["len"] > 45:
        long_.append((f"lamp[{i}]", l["x"], l["z"], f"span {l['wire']['len']:.0f} m", l["wire"]["len"]))
    if l["wire"]["len"] < 8:
        short.append((f"lamp[{i}]", l["x"], l["z"], f"span {l['wire']['len']:.0f} m", 8 - l["wire"]["len"]))
n_w = len(wires)
check("wire-through-building", "lamps", "Wire span crosses a building volume (> 1 m inside the footprint shrunk by 0.4 m, eave above the wire)", len(thru), n_w, "high", thru,
      "the span is facade-to-facade `inferred` across the street, or the 2018 line crosses a courtyard; pendant and wire pass through a house", weight=3)
check("wire-floating-anchor", "lamps", "Wire anchor > 2.5 m from the nearest facade", len(floating), n_w, "med", floating, "the cable ends in mid-air at 8.9 m", weight=2)
check("wire-too-low", "lamps", "Wire or lantern lower than 5 m above ground (KK clearance 8.5 m published; modelled 8 m)", len(low), n_w, "med", low, "", weight=1)
check("wire-too-long", "lamps", "Wire span > 45 m (visual-refs 25-35 m)", len(long_), n_w, "low", long_, "", weight=1)
check("wire-too-short", "lamps", "Wire span < 8 m", len(short), n_w, "low", short, "", weight=0.5, visible=False)
brk = [l for l in lamps if l["bracket"]]
check("wire-no-span", "lamps", "Wire-mounted lamp without span geometry (engine stands it on a 6.2 m tube pole)", len(brk), len([l for l in lamps if l["mount"] == "wire"]), "low",
      [(f"lamp", l["x"], l["z"], "bracket on a tube pole", 1) for l in brk], "", weight=0.3, visible=False)
mast = [l for l in lamps if l["mount"] == "mast"]
zero_h = [(f"lamp", l["x"], l["z"], f"pole {l['pole']} poleH {l['poleH']}", 3 - l["poleH"]) for l in mast if l["poleH"] < 2.5]
tall = [(f"lamp", l["x"], l["z"], f"pole {l['pole']} poleH {l['poleH']}", l["poleH"]) for l in mast if l["poleH"] > 10]
check("mast-height-low", "lamps", "Mast with pole height < 2.5 m (park-type bollards, 'pole_h' 0 renders a head at ground level)", len(zero_h), len(mast), "low", zero_h, "", weight=0.3, visible=False)
check("mast-height-high", "lamps", "Mast taller than 10 m (visual-refs: 5-9 m)", len(tall), len(mast), "low", tall, "", weight=0.5)
print("  mast poleH quantiles", np.percentile([l["poleH"] for l in mast], [0, 5, 50, 95, 100]).round(1).tolist())

# ---------------------------------------------------------------------------------------------------------- 8. signals / bus stops
print("\n== signals / bus stops ==")
sig = geo["points"]["signals"]
ex = []
for i, s in enumerate(sig):
    d = float(np.hypot(jn[:, 0] - s["x"], jn[:, 1] - s["z"]).min())
    if d > 12:
        ex.append((s.get("name", f"signal[{i}]"), s["x"], s["z"], f"{d:.0f} m from the nearest road-graph junction (degree >= 3)", d))
check("signal-no-junction", "signals", "Signal point > 12 m from any road-graph junction node", len(ex), len(sig), "med", ex,
      "the engine matches signals to junction nodes; unmatched ones get no signal heads or phase", weight=1.5)
sig_in_b = [(s.get("name", ""), s["x"], s["z"], "inside a building", 1) for s in sig if bunion.contains(Point(s["x"], s["z"]))]
check("signal-in-building", "signals", "Signal point inside a building", len(sig_in_b), len(sig), "med", sig_in_b, "", weight=2)
flagged = Counter(l[8] for l in rg["links"]) + Counter(l[9] for l in rg["links"])
n_flag_nodes = len({n for l in rg["links"] for n in (l[0] if l[8] else None, l[1] if l[9] else None) if n is not None})
print(f"  road-graph signalised nodes {n_flag_nodes} vs signal points {len(sig)}")

stops = fur["busStops"]
ex, onroad, in_b = [], [], []
cls_count = Counter()
for i, s in enumerate(stops):
    p = Point(s["x"], s["z"])
    ri = rtree.nearest(p)
    d_edge = carriage[ri].distance(p)
    cls_count[roads[ri]["cls"]] += 1
    if carriage_union.contains(p):
        onroad.append((f"stop[{i}] {s['name']}", s["x"], s["z"], "flag inside the carriageway", 1))
    elif d_edge > 5:
        ex.append((f"stop[{i}] {s['name']}", s["x"], s["z"], f"flag {d_edge:.1f} m from the nearest carriageway edge ({roads[ri]['cls']} {roads[ri]['name']})", d_edge))
    if bunion.contains(p):
        in_b.append((f"stop[{i}] {s['name']}", s["x"], s["z"], "flag inside a building", 1))
sh_bad = []
for k, sh in enumerate(plan["shelters"]):
    fp = obb(sh["x"], sh["z"], sh["yaw"], 3.2, 1.7)
    a_b, a_c, a_y = fp.intersection(bunion).area / fp.area, fp.intersection(carriage_union).area / fp.area, fp.intersection(cyc_union).area / fp.area
    if a_b > 0.15 or a_c > 0.1 or a_y > 0.1:
        sh_bad.append((f"shelter[{k}]", sh["x"], sh["z"], f"{100 * a_b:.0f}% in building, {100 * a_c:.0f}% on carriageway, {100 * a_y:.0f}% on cycle track", max(a_b, a_c, a_y)))
check("busstop-far-from-road", "bus stops", "Stop flag > 5 m from the nearest carriageway edge", len(ex), len(stops), "med", ex, f"nearest road classes: {dict(cls_count)}", weight=2)
check("busstop-in-carriageway", "bus stops", "Stop flag inside the capped carriageway", len(onroad), len(stops), "low", onroad, "expected for kerbside poles on narrow caps", weight=0.5, visible=False)
check("busstop-in-building", "bus stops", "Stop flag inside a building", len(in_b), len(stops), "med", in_b, "", weight=2)
check("shelter-conflict", "bus stops", "Shelter footprint >= 15% in a building, or >= 10% on the carriageway / cycle track", len(sh_bad), len(plan["shelters"]), "med", sh_bad, "", weight=2)
print("  note: bus routes are not in the data; 'next to a road with a bus route' can only be checked as proximity to a carriageway")

# ---------------------------------------------------------------------------------------------------------- 9. scale sanity
print("\n== scale ==")
trees = fur["trees"]
H = np.array([t["height"] for t in trees])
CR = np.array([t["crown_radius"] for t in trees])
clamp_h = sum(1 for h in H if h < 2.5 or h > 40)
ex = [(f"tree[{i}] {t['genus']}", t["x"], t["z"], f"h {t['height']:.0f} m, crown r {t['crown_radius']:.1f} m", t["height"]) for i, t in enumerate(trees) if t["height"] > 28 or t["crown_radius"] > 9]
check("tree-giant", "trees", "Tree height > 28 m or crown radius > 9 m", len(ex), len(trees), "med", ex, f"height p50 {np.median(H):.0f} p95 {np.percentile(H, 95):.0f} max {H.max():.0f}; crown p50 {np.median(CR):.1f} p95 {np.percentile(CR, 95):.1f} max {CR.max():.1f}", weight=1)
gen = Counter(t["genus"] for t in trees)
check("tree-generic-genus", "trees", "Tree genus not resolved ('generic' look)", gen["generic"], len(trees), "low", [], f"genus mix {dict(gen)}", visible=False)
ratio = [(f"tree[{i}]", t["x"], t["z"], f"crown r {t['crown_radius']:.1f} / h {t['height']:.1f} = {t['crown_radius'] / max(t['height'], 1):.2f}", t["crown_radius"] / max(t["height"], 1))
         for i, t in enumerate(trees) if t["crown_radius"] > 0.75 * max(2.5, min(40, t["height"]))]
check("tree-crown-clamped", "trees", "Crown radius > 0.75 x height (engine clamps to 0.75 h)", len(ratio), len(trees), "low", ratio, "", weight=0.3, visible=False)
DIM_TABLE = [
    ("Pole mast head / lantern", "pendant Ø0.46 x 0.36 (CGS441)", "published 462 x 363 mm", "ok"),
    ("Wire lantern height", f"model ~8.3 m (anchor 8.9 m, sag 3 %)", "visual-refs 1a: 8 m", "ok"),
    ("Mast height", f"median {np.median([l['poleH'] for l in mast]):.1f} m, max {max(l['poleH'] for l in mast):.1f}", "SAB: 5-9 m (park posts lower)", "check tails"),
    ("Lake post", "0.98 m", "est. 0.9-1.1 m", "ok"),
    ("Round bollard", "Ø0.15-0.16 x 0.82 m", "published Ø89/114 mm x 800 mm", "~35% fat"),
    ("Granite bollard", "0.30 x 0.30 x 0.76 m", "est. 0.25 x 0.25 x 0.8", "ok"),
    ("Litter bin", "Ø0.52 x 0.87 m", "Københavnerkurv 0.68 m / Pizzakurv 0.65 x 0.65 x 1.1", "ok-ish"),
    ("Glass container cluster", "3 cylinders Ø1.16 x 1.8 m in a 3.8 x 1.2 m row", "old cube 1.3 x 1.3 x 1.6 each", "ok per unit; one record = 3"),
    ("Bin stand (wheelies)", "3 bins 0.56 x 0.66 x 0.78 in a 1.9 m row", "no source figure", "plausible"),
    ("Bench", "1.8 x 0.55 x 0.9 m, seat 0.46", "Københavnerbænk 1.8-2.17 m", "ok"),
    ("Bike", "1.75 m long, rack pitch 0.5 m", "est. 1.75-1.9 x 0.55-0.7 m", "ok"),
    ("Parking meter", "0.46 x 0.32 x 1.5 m", "est. H1.5-1.8", "ok"),
    ("Bus flag", "3.9 m", "published 3.87 m", "ok"),
    ("Bus shelter", "3.2 x 1.7 x 2.4 m", "KK narrow model 1.2 x 3.85 m", "ok"),
    ("Car", "4.5 x 1.86 / 4.6 x 1.92 m", "typical 4.4-4.7 x 1.8-1.9", "ok"),
    ("Tree", f"height p50 {np.median(H):.0f} m, p95 {np.percentile(H, 95):.0f} m, max {H.max():.0f} m", "KK trae_basis", "check tails"),
]
RESULTS.append({"id": "dim-table", "layer": "scale", "title": "Prop dimensions vs visual-refs", "table": DIM_TABLE, "count": 0, "total": 0, "pct": 0, "severity": "info", "note": "", "examples": []})

# ---------------------------------------------------------------------------------------------------------- output
sev_rank = {"high": 0, "med": 1, "low": 2, "info": 3}
RESULTS.sort(key=lambda r: (sev_rank.get(r["severity"], 9), -r["pct"]))
QA.mkdir(parents=True, exist_ok=True)
(QA / "results.json").write_text(json.dumps(RESULTS, indent=1, ensure_ascii=False))


def md_escape(s):
    return str(s).replace("|", "\\|")


lines = ["<!-- generated by tools/audit/audit.py; do not edit -->", ""]
by_layer = defaultdict(list)
for r in RESULTS:
    by_layer[r["layer"]].append(r)
lines += ["### Summary (all checks, sorted by severity then share of the layer)", "", "| severity | check | layer | count | of | % |", "|---|---|---|---:|---:|---:|"]
for r in RESULTS:
    if r["id"] == "dim-table":
        continue
    lines.append(f"| {r['severity']} | `{r['id']}` | {r['layer']} | {r['count']} | {r['total']} | {r['pct']} |")
lines.append("")
for r in RESULTS:
    if r["id"] == "dim-table":
        lines += ["### Scale: prop dimensions vs visual-refs", "", "| item | engine | reference | verdict |", "|---|---|---|---|"]
        lines += [f"| {a} | {b} | {c} | {d} |" for a, b, c, d in r["table"]]
        lines.append("")
        continue
    lines += [f"#### `{r['id']}` ({r['severity']}): {r['title']}", "", f"Count **{r['count']}** of {r['total']} ({r['pct']}%). {r['note']}", ""]
    if r["examples"]:
        lines += ["| # | id | x, z | measure |", "|---:|---|---|---|"]
        for k, e in enumerate(r["examples"], 1):
            lines.append(f"| {k} | {md_escape(e['id'])} | {e['x']}, {e['z']} | {md_escape(e['metric'])} |")
        lines.append("")
(QA / "audit-tables.md").write_text("\n".join(lines))

# ------------------------------------------------------------------------ sweep points (deterministic)
WORST_ORDER = ["road-through-bld", "bld-water", "water-carriageway", "wire-through-building", "car-on-pavement", "car-in-moving-lane", "on-cycletrack:cars",
               "in-water:trees", "shelter-conflict", "bld-bld-overlap", "bld-ground-step-neighbours", "overlap:cars+cars", "wire-floating-anchor",
               "in-building-partial:cars", "tree-crown-facade", "rack-rows", "surf-surf-diffclass", "lod2-spire"]


def cluster_worst(items, k=10, sep=60.0):
    """Top-k conflict locations: the largest example of each check in WORST_ORDER, one per 60 m neighbourhood."""
    chosen = []
    for cid in WORST_ORDER:
        ex = [e for e in items if e["check"] == cid]
        for e in sorted(ex, key=lambda e: -abs(e.get("v", 0))):
            if all(math.hypot(e["x"] - c["x"], e["z"] - c["z"]) > sep for c in chosen):
                near = sorted({o["check"] for o in items if math.hypot(o["x"] - e["x"], o["z"] - e["z"]) < 40})
                chosen.append({"x": e["x"], "z": e["z"], "score": round(abs(e.get("v", 0)), 2), "checks": [cid] + [c for c in near if c != cid][:3], "what": e["metric"], "id": e["id"]})
                break
        if len(chosen) == k:
            break
    return chosen

worst = cluster_worst([e for e in EXAMPLES_BY_LOC if abs(e["x"]) < 740 and abs(e["z"]) < 740])


def pick_view(x, z, dist=13.0):
    """Eye-level camera position that is outside buildings/water, looking at (x, z)."""
    best = None
    for k in range(16):
        a = k * math.pi / 8
        cx, cz = x + math.sin(a) * dist, z + math.cos(a) * dist
        p = Point(cx, cz)
        if bunion.contains(p) or water_open.contains(p):
            continue
        clear = min(bunion.distance(p), 12.0)
        if best is None or clear > best[0]:
            best = (clear, cx, cz)
    if best is None:
        return x + dist, z + dist
    return best[1], best[2]

streets = {}
for r in lay["roads"]:
    if r["veh"] and r["name"]:
        streets.setdefault(r["name"], []).append(r)
def street_pt(name, f):
    rs = sorted(streets[name], key=lambda r: -LineString(np.array(r["pts"]).reshape(-1, 2)).length)
    ln = LineString(np.array(rs[0]["pts"]).reshape(-1, 2))
    d = ln.length * f
    a, b = ln.interpolate(max(0, d - 2)), ln.interpolate(min(ln.length, d + 2))
    tx, tz = b.x - a.x, b.y - a.y
    l = math.hypot(tx, tz) or 1
    tx, tz = tx / l, tz / l
    h = rs[0]["half"]
    c = ln.interpolate(d)
    off = h + 1.2  # kerb side
    return c.x + (-tz) * off, c.y + tx * off, tx, tz

sweep = {"streets": [], "lake": [], "squares": [], "worst": [], "aerial": []}
for name, f in (("Nørre Søgade", 0.3), ("Nørre Søgade", 0.7), ("Dronning Louises Bro", 0.5), ("Nørrebrogade", 0.35), ("Nørrebrogade", 0.8), ("Ravnsborggade", 0.5),
                ("Blågårdsgade", 0.5), ("Sankt Hans Gade", 0.5), ("Nørre Farimagsgade", 0.5), ("H.C. Andersens Boulevard", 0.5)):
    if name not in streets:
        continue
    cx, cz, tx, tz = street_pt(name, f)
    sweep["streets"].append({"label": f"{name} {int(f * 100)}%", "pos": [round(cx, 1), 1.7, round(cz, 1)], "look": [round(cx + tx * 30, 1), 3.0, round(cz + tz * 30, 1)], "fov": 66})
# lake path: along the Peblinge outline, 3 m outside the water edge
lk = lake_polys[0]
ring = LineString(lk.exterior.coords)
for f in (0.08, 0.28, 0.45, 0.62, 0.85):
    d = ring.length * f
    c = ring.interpolate(d)
    a, b = ring.interpolate(d - 3), ring.interpolate(min(ring.length, d + 3))
    tx, tz = b.x - a.x, b.y - a.y
    l = math.hypot(tx, tz) or 1
    tx, tz = tx / l, tz / l
    for sgn in (1, -1):
        px, pz = c.x + sgn * (-tz) * 3.0, c.y + sgn * tx * 3.0
        if not water_all.contains(Point(px, pz)) and not bunion.contains(Point(px, pz)):
            break
    sweep["lake"].append({"label": f"Lake path {int(f * 100)}%", "pos": [round(px, 1), 1.7, round(pz, 1)], "look": [round(px + tx * 25, 1), 1.0, round(pz + tz * 25, 1)], "fov": 68})
# squares: largest cobbles / raadhus / setts / kbh_fortov polygons + Blaagaards Plads
big = sorted([(p.area, p, sid[i], scls[i]) for i, p in enumerate(spoly) if scls[i] in ("cobbles", "raadhus", "setts", "kbh_fortov", "gravel")], key=lambda t: -t[0])
chosen = []
for area, p, i_, c in big:
    cx, cz = centroid(p)
    if all(math.hypot(cx - o[0], cz - o[1]) > 120 for o in chosen):
        chosen.append((cx, cz, area, c))
    if len(chosen) == 4:
        break
chosen.append((-314.6, -448.0, 0, "Blågårds Plads"))
for cx, cz, area, c in chosen:
    px, pz = pick_view(cx, cz, 14.0)
    sweep["squares"].append({"label": f"Square {c} ({area:.0f} m2) {cx:.0f},{cz:.0f}", "pos": [round(px, 1), 1.7, round(pz, 1)], "look": [round(cx, 1), 1.2, round(cz, 1)], "fov": 68})
for k, w in enumerate(worst, 1):
    px, pz = pick_view(w["x"], w["z"], 12.0)
    sweep["worst"].append({"label": f"Worst #{k}: {', '.join(w['checks'][:3])}", "pos": [round(px, 1), 1.7, round(pz, 1)], "look": [round(w["x"], 1), 1.2, round(w["z"], 1)], "fov": 68, "detail": w})
sweep["aerial"] = [
    {"label": "Aerial SW", "pos": [-420, 330, 380], "look": [20, 0, -20], "fov": 50},
    {"label": "Aerial NE", "pos": [440, 300, -420], "look": [0, 0, 0], "fov": 52},
    {"label": "Aerial N lakes", "pos": [0, 260, -700], "look": [20, 0, -300], "fov": 52},
    {"label": "Aerial S", "pos": [-80, 250, 700], "look": [20, 0, 300], "fov": 52},
    {"label": "Aerial lakes low", "pos": [-150, 90, -330], "look": [50, 0, -460], "fov": 58},
    {"label": "Aerial Nørrebro low", "pos": [-300, 100, -300], "look": [-100, 0, -520], "fov": 58},
]
(QA / "sweep-points.json").write_text(json.dumps(sweep, indent=1, ensure_ascii=False))
print("\nworst locations:")
for w in worst:
    print(f"  ({w['x']:.0f}, {w['z']:.0f}) score {w['score']} {w['checks']}")
print("done")
