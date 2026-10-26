"""Point layers (signals, trees, racks, benches, lights) and area layers (water, parks, sidewalks, cycle tracks)."""
from __future__ import annotations

import math
import re
from collections import Counter

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

import frame

_T = Transformer.from_crs(4326, 25832, always_xy=True)


def _bbox():
    """The active area (frame.area_utm()) as a shapely box."""
    return box(*frame.area_utm())


def _pts(geom):
    if geom.geom_type == "Point":
        return [geom]
    if geom.geom_type == "MultiPoint":
        return list(geom.geoms)
    return []


def _inside(p):
    return _bbox().contains(p)


def _num(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def signals(kk_sig, osm_nodes):
    out, utm = [], []
    for f in (kk_sig or {}).get("features", []):
        for p in _pts(shape(f["geometry"])):
            if _inside(p):
                x, z = frame.to_local(p.x, p.y)
                out.append({"x": round(x, 2), "z": round(z, 2), "kind": "junction",
                            "name": f["properties"].get("krydsets_navn"),
                            "src": ["kk:trafiksignal_oversigt"], "conf": "observed"})
                utm.append((p.x, p.y))
    kk_tree = STRtree([Point(u) for u in utm]) if utm else None
    for el in (osm_nodes or {}).get("elements", []):
        t = el.get("tags", {})
        if el.get("type") != "node" or not (t.get("highway") == "traffic_signals" or t.get("crossing") == "traffic_signals"):
            continue
        x, y = _T.transform(el["lon"], el["lat"])
        p = Point(x, y)
        if not _inside(p):
            continue
        if kk_tree and Point(utm[kk_tree.nearest(p)]).distance(p) < 25:
            continue
        lx, lz = frame.to_local(x, y)
        out.append({"x": round(lx, 2), "z": round(lz, 2), "kind": "crossing" if t.get("crossing") or t.get("highway") == "crossing" else "junction",
                    "src": [f"osm:node/{el['id']}"], "conf": "observed"})
        utm.append((x, y))
    return out, utm


def trees(trae_basis, detected):
    """Inventory trees (species) joined to detected crowns (height, crown) within 4 m;
    unmatched detections are added with species unknown."""
    det = []
    for f in (detected or {}).get("features", []):
        for p in _pts(shape(f["geometry"])):
            pr = f["properties"]
            det.append((p, pr.get("traehoejde"), pr.get("kroneareal"), pr.get("treeid")))
    tree = STRtree([d[0] for d in det]) if det else None
    used = set()
    out = []
    for f in (trae_basis or {}).get("features", []):
        pr = f["properties"]
        for p in _pts(shape(f["geometry"])):
            if not _inside(p):
                continue
            h = crown = None
            src = [f"kk:trae_basis:{pr.get('uuid')}"]
            cf = {}
            if tree:
                i = tree.nearest(p)
                if i is not None and det[i][0].distance(p) <= 4.0 and i not in used:
                    used.add(i)
                    h, area = det[i][1], det[i][2]
                    crown = round(2 * math.sqrt(area / math.pi), 1) if area else None
                    src.append(f"kk:automatisk_detekterede_traeer:{det[i][3]}")
                    cf = {"height": "observed", "crown": "observed"}
            kd = _num(pr.get("kronediameter"))
            if kd and not crown:
                crown, cf["crown"] = kd, "observed"
            if not h:
                h, cf["height"] = 10.0, "inferred"
            if not crown:
                crown, cf["crown"] = round(h * 0.5, 1), "inferred"
            x, z = frame.to_local(p.x, p.y)
            sp = pr.get("slaegt") or pr.get("traeart")
            out.append({"x": round(x, 2), "z": round(z, 2), "height": round(float(h), 1), "crown": crown,
                        "species": (pr.get("traeart") or sp or "unknown"), "src": src, "conf": "observed", "conf_fields": cf})
    for i, (p, h, area, tid) in enumerate(det):
        if i in used or not _inside(p) or not h:
            continue
        x, z = frame.to_local(p.x, p.y)
        crown = round(2 * math.sqrt(area / math.pi), 1) if area else round(h * 0.5, 1)
        out.append({"x": round(x, 2), "z": round(z, 2), "height": round(float(h), 1), "crown": crown, "species": "unknown",
                    "src": [f"kk:automatisk_detekterede_traeer:{tid}"], "conf": "observed",
                    "conf_fields": {"species": "inferred"}})
    return out


def bike_racks(cykelstativ, byinv_l):
    out = []
    for f in (cykelstativ or {}).get("features", []):
        for p in _pts(shape(f["geometry"])):
            if _inside(p):
                x, z = frame.to_local(p.x, p.y)
                cap = f["properties"].get("antal_pladser")
                out.append({"x": round(x, 2), "z": round(z, 2), "capacity": int(cap) if cap else 5,
                            "src": ["kk:cykelstativ"], "conf": "observed",
                            **({} if cap else {"conf_fields": {"capacity": "inferred"}})})
    for f in (byinv_l or {}).get("features", []):
        pr = f["properties"]
        if pr.get("under_element") != "Cykelstativer":
            continue
        g = shape(f["geometry"])
        c = g.centroid
        if not _inside(c):
            continue
        m = re.match(r"\s*(\d+)\s*x\s*(\d+)", pr.get("kommentar") or "")
        if m:
            cap, cf = int(m.group(1)) * int(m.group(2)), {}
        else:
            cap, cf = max(2, int(g.length / 0.8)), {"capacity": "inferred"}
        x, z = frame.to_local(c.x, c.y)
        out.append({"x": round(x, 2), "z": round(z, 2), "capacity": cap, "src": ["kk:dp_byinventar_l"],
                    "conf": "observed", **({"conf_fields": cf} if cf else {})})
    return out


def benches(puma):
    out = []
    for f in (puma or {}).get("features", []):
        if "bænk" not in (f["properties"].get("geoobjekttype") or "").lower() and "bænk" not in (f["properties"].get("geoobjekttype") or "").lower():
            continue
        for p in _pts(shape(f["geometry"])):
            if _inside(p):
                x, z = frame.to_local(p.x, p.y)
                out.append({"x": round(x, 2), "z": round(z, 2), "src": ["kk:baenke_borde_puma"], "conf": "observed"})
    return out


def lights(osm_nodes):
    out = []
    for el in (osm_nodes or {}).get("elements", []):
        if el.get("type") == "node" and el.get("tags", {}).get("highway") == "street_lamp":
            x, y = _T.transform(el["lon"], el["lat"])
            if _inside(Point(x, y)):
                lx, lz = frame.to_local(x, y)
                out.append({"x": round(lx, 2), "z": round(lz, 2), "src": [f"osm:node/{el['id']}"], "conf": "observed"})
    return out


# ---------------------------------------------------------------- areas

def _polys(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for g in geom.geoms for p in _polys(g)]
    return []


def _ring(poly):
    return frame.flat(frame.ring_to_local(poly.exterior.coords))


def osm_polygons(elements, keep):
    """Polygons (UTM) with tags for ways and multipolygon relations accepted by keep(tags)."""
    res = []
    for el in elements:
        t = el.get("tags", {})
        if not keep(t):
            continue
        if el["type"] == "way" and "geometry" in el and len(el["geometry"]) >= 4:
            pts = [_T.transform(p["lon"], p["lat"]) for p in el["geometry"]]
            if pts[0] == pts[-1]:
                res.append((f"osm:way/{el['id']}", t, Polygon(pts).buffer(0)))
        elif el["type"] == "relation":
            lines = [LineString([_T.transform(p["lon"], p["lat"]) for p in m["geometry"]])
                     for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
            if lines:
                polys = list(polygonize(unary_union(lines)))
                if polys:
                    res.append((f"osm:relation/{el['id']}", t, unary_union(polys)))
    return res


def water(osm_wp):
    out = []
    for oid, t, g in osm_polygons(osm_wp.get("elements", []), lambda t: t.get("natural") == "water"):
        for i, p in enumerate(_polys(g.intersection(_bbox()))):
            if p.area < 20:
                continue
            out.append({"id": oid + (f"#{i}" if i else ""), "name": t.get("name", ""), "ring": _ring(p),
                        "level": 0.0, "src": [oid], "conf": "observed",
                        "conf_fields": {"level": "inferred"}})
    return out


def parks(kk_parkreg, kk_green, osm_wp):
    out, kk_union = [], []
    for nm, fc, key in (("parkregister", kk_parkreg, "navn_arealer"), ("park_groent_omr_oversigtskort", kk_green, "objekt_type")):
        for f in (fc or {}).get("features", []):
            pr = f["properties"]
            for i, p in enumerate(_polys(shape(f["geometry"]).buffer(0).intersection(_bbox()))):
                if p.area < 50:
                    continue
                if any(p.intersection(u).area > 0.6 * p.area for u in kk_union):
                    continue
                kk_union.append(p)
                name = pr.get("navn_arealer") or pr.get("navn_parker") or ""
                out.append({"id": f"kk:{nm}:{f.get('id')}" + (f"#{i}" if i else ""), "name": name, "ring": _ring(p),
                            "src": [f"kk:{nm}"], "conf": "observed"})
    ku = unary_union(kk_union) if kk_union else None
    for oid, t, g in osm_polygons(osm_wp.get("elements", []), lambda t: t.get("leisure") in ("park", "garden")):
        for i, p in enumerate(_polys(g.intersection(_bbox()))):
            if p.area < 50 or (ku is not None and p.intersection(ku).area > 0.5 * p.area):
                continue
            out.append({"id": oid + (f"#{i}" if i else ""), "name": t.get("name", ""), "ring": _ring(p),
                        "src": [oid], "conf": "observed"})
    return out


def sidewalks(fortov):
    out = []
    for f in (fortov or {}).get("features", []):
        pr = f["properties"]
        if pr.get("geom_status") not in (None, "Nuværende"):
            continue
        g = shape(f["geometry"]).buffer(0).intersection(_bbox())
        for i, p in enumerate(_polys(g)):
            if p.area < 2:
                continue
            out.append({"id": f"kk:fortovsmatrikel:{pr.get('uuid') or f.get('id')}" + (f"#{i}" if i else ""),
                        "ring": _ring(p), "src": ["kk:fortovsmatrikel"], "conf": "observed"})
    return out


def cycle_tracks(kk_cykelsti):
    out = []
    for f in (kk_cykelsti or {}).get("features", []):
        pr = f["properties"]
        g = shape(f["geometry"]).intersection(_bbox())
        lines = [g] if g.geom_type == "LineString" else [x for x in getattr(g, "geoms", []) if x.geom_type == "LineString"]
        for i, ln in enumerate(lines):
            if ln.length < 2:
                continue
            w = _num(pr.get("bredde"))
            out.append({"id": f"kk:cykelsti:{pr.get('id')}" + (f"#{i}" if i else ""),
                        "pts": frame.flat([frame.to_local(x, y) for x, y in ln.coords]),
                        "width": w if w else 2.2, "side": "separate", "name": pr.get("vejnavn"),
                        "src": ["kk:cykelsti"], "conf": "observed",
                        **({} if w else {"conf_fields": {"width": "inferred"}})})
    return out
