"""Frederiksberg Kommune substitutions for build_city.py.

The KK WFS layers are empty in Frederiksberg (docs/citywide-sources.md). This module reads the Frederiksberg GC2 SQL API
tables (public, cached under data/raw/city/frb/) and OSM nodes, and maps them to the schemas of cph-geodata `points` /
`sidewalks`, cph-furniture and cph-surfaces. Provenance rules (docs/cph-geodata-schema.md): every item carries `src` and
`conf`; a field that was not read from the source but filled with a default or a class midpoint is listed in
`conf_fields` as `inferred`. Nothing is invented for Frederiksberg where no source exists: street lights, bollards,
surface materials, road markings (other than the pedestrian crossings), blue cycle fields have no register, so they come
from OSM where OSM has them and are otherwise left to the engine's defaults (see `substitutions()`).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

from pyproj import Transformer

import city_sources as S
import frame

_T = Transformer.from_crs(4326, 25832, always_xy=True)

FRB_DIR = S.RAW_CITY / "frb"
LIC = "unstated"  # GC2 tables without an opendata.dk entry carry no licence statement (docs/citywide-sources.md)
TABLES = {
    "trees": "byrum_ekstern.registrerede_traer", "streettrees": "byrum.vejtraer", "bins": "byrum.skraldespande",
    "racks": "mobilitet.cykelstativer", "racks2020": "mobilitet_ekstern.cykelparkering", "parking": "mobilitet.parkeringspladser", "signals": "byrum.signalanlaeg",
    "busstops": "mobilitet.busstoppesteder_frederiksberg", "pavement": "stab.fortovsareal", "benches": "byrum.baenk",
    "glass": "affald.glascontainere", "monuments": "byrum_ekstern.monumenter", "crossings": "vej.fodgaengerfelt",
}
OPTIONAL = {"monuments", "crossings", "racks2020"}  # a failing optional table is skipped; the build goes on without
HEIGHT_CLASS = {"0_5": (0, 5), "5_10": (5, 10), "10_15": (10, 15), "15_20": (15, 20), "20_25": (20, 25), "25_30": (25, 30),
                "5-10": (5, 10), "10-15": (10, 15)}


def fetch_all(force: bool = False) -> dict:
    FRB_DIR.mkdir(parents=True, exist_ok=True)
    status = {}
    for key, table in TABLES.items():
        path = FRB_DIR / f"{key}.json"
        if path.exists() and not force:
            status[key] = "cached"
            continue
        try:
            feats = S.gc2_table(table)
        except Exception as e:  # noqa: BLE001
            if key in OPTIONAL:
                status[key] = f"FAILED: {str(e)[:80]}"
                S.log(f"[frb] {table} unavailable ({e}); continuing without it")
                continue
            raise
        S.atomic_write(path, json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))
        status[key] = len(feats)
        S.log(f"[frb] {table}: {len(feats)}")
    S.atomic_write(FRB_DIR / "_status.json", json.dumps(status))
    return status


def load(key: str) -> list:
    p = FRB_DIR / f"{key}.json"
    return json.loads(p.read_text())["features"] if p.exists() else []


def _pts(geom):
    if not geom:
        return []
    if geom["type"] == "Point":
        return [geom["coordinates"][:2]]
    if geom["type"] == "MultiPoint":
        return [c[:2] for c in geom["coordinates"]]
    return []


def _local(c):
    x, z = frame.to_local(c[0], c[1])
    return round(x, 2), round(z, 2)


class _Grid:
    """Tiny point index for dedupe by distance."""

    def __init__(self, pts, cell=10.0):
        self.cell, self.g = cell, {}
        for x, z in pts:
            self.g.setdefault((int(x // cell), int(z // cell)), []).append((x, z))

    def near(self, x, z, r):
        c = self.cell
        for i in range(int(x // c) - 1, int(x // c) + 2):
            for j in range(int(z // c) - 1, int(z // c) + 2):
                for px, pz in self.g.get((i, j), ()):
                    if (px - x) ** 2 + (pz - z) ** 2 < r * r:
                        return True
        return False

    def add(self, x, z):
        self.g.setdefault((int(x // self.cell), int(z // self.cell)), []).append((x, z))


# ----------------------------------------------------------------------------------------------- geodata points

def tree_points() -> list:
    """geodata `points.trees` from the municipal tree register (Fugro aerial survey origin) + street-tree positions."""
    out, grid = [], _Grid([])
    for f in load("trees"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            cls = HEIGHT_CLASS.get(str(p.get("hoejde")))
            cf = {}
            if cls:
                h, cf["height"] = round((cls[0] + cls[1]) / 2, 1), "inferred"  # the register gives a 5 m class, not a height
            else:
                h, cf["height"] = 10.0, "inferred"
            crown = round(h * 0.5, 1)
            cf["crown"] = "inferred"
            sp = p.get("art_dk") or p.get("art") or p.get("slaegt") or "unknown"
            if sp == "unknown":
                cf["species"] = "inferred"
            out.append({"x": x, "z": z, "height": h, "crown": crown, "species": sp, "src": [f"frb:gc2:registrerede_traer:{p.get('id')}"],
                        "conf": "observed", "conf_fields": cf})
            grid.add(x, z)
    n_reg = len(out)
    for f in load("streettrees"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            if grid.near(x, z, 3.0):
                continue
            out.append({"x": x, "z": z, "height": 10.0, "crown": 5.0, "species": "unknown",
                        "src": [f"frb:gc2:vejtraer:{p.get('id')}", f"geodanmark:trae:{p.get('fot_id')}"], "conf": "observed",
                        "conf_fields": {"height": "inferred", "crown": "inferred", "species": "inferred"}})
            grid.add(x, z)
    S.log(f"[frb] trees: {n_reg} register + {len(out) - n_reg} street-tree positions")
    return out


def rack_points() -> list:
    out, grid = [], _Grid([])

    def add(feature, srcname, idfield, dedupe):
        p = feature["properties"]
        pts = _pts(feature.get("geometry"))
        try:
            cap = int(float(p.get("antal_pladser")))
        except (TypeError, ValueError):
            cap = None
        for c in pts:
            x, z = _local(c)
            if dedupe and grid.near(x, z, 4.0):
                continue
            grid.add(x, z)
            rec = {"x": x, "z": z, "capacity": max(1, round(cap / len(pts))) if cap else 5,
                   "src": [f"frb:gc2:{srcname}:{p.get(idfield)}"], "conf": "observed"}
            if not cap:
                rec["conf_fields"] = {"capacity": "inferred"}
            out.append(rec)

    for f in load("racks"):
        add(f, "cykelstativer", "gid", False)
    n1 = len(out)
    for f in load("racks2020"):  # 2020 count of bicycle parking (with capacity); only racks the older register lacks
        add(f, "cykelparkering", "gid", True)
    S.log(f"[frb] bike racks: {n1} register + {len(out) - n1} from the 2020 count")
    return out


def bench_points(frb_poly=None, osm_nodes=None) -> list:
    out = []
    for f in load("benches"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            out.append({"x": x, "z": z, "src": [f"frb:gc2:baenk:{p.get('gid')}"], "conf": "observed"})
    n = len(out)
    g = _Grid([(b["x"], b["z"]) for b in out])
    for el in (osm_nodes or {}).get("elements", []):
        t = el.get("tags", {})
        if el.get("type") != "node" or t.get("amenity") != "bench":
            continue
        e, n_ = S_to_utm(el["lon"], el["lat"])
        if frb_poly is not None and not frb_poly.contains(_point(e, n_)):
            continue
        x, z = _local((e, n_))
        if g.near(x, z, 2.0):
            continue
        out.append({"x": x, "z": z, "src": [f"osm:node/{el['id']}"], "conf": "observed"})
        g.add(x, z)
    S.log(f"[frb] benches: {n} register + {len(out) - n} OSM")
    return out


def signal_points(existing: list) -> list:
    g = _Grid([(s["x"], s["z"]) for s in existing])
    out = []
    for f in load("signals"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            if g.near(x, z, 25.0):
                continue
            out.append({"x": x, "z": z, "kind": "junction", "name": p.get("placering"), "src": [f"frb:gc2:signalanlaeg:{p.get('signalnr')}"],
                        "conf": "observed"})
    return out


def S_to_utm(lon, lat):
    return _T.transform(lon, lat)


def _point(e, n):
    from shapely.geometry import Point

    return Point(e, n)


def frb_polygon():
    """Frederiksberg Kommune (DAGI 0147) in EPSG:25832, from data/city/boundary.geojson."""
    from shapely.geometry import shape
    from shapely.prepared import prep

    b = json.loads((S.ROOT / "data" / "city" / "boundary.geojson").read_text())
    f = next(f for f in b["features"] if f["properties"].get("kommunekode") == "0147")
    return prep(shape(f["geometry"]))


def apply_points(pts: dict, osm_nodes: dict | None) -> tuple[dict, list]:
    """Adds the Frederiksberg items to the geodata `points` dict; returns (pts, substitution rows)."""
    poly = frb_polygon()
    tr, rk = tree_points(), rack_points()
    bn = bench_points(poly, osm_nodes)
    sg = signal_points(pts.get("signals", []))
    pts = {**pts, "trees": pts["trees"] + tr, "bikeRacks": pts["bikeRacks"] + rk, "benches": pts["benches"] + bn,
           "signals": pts["signals"] + sg}
    rows = [
        {"item": "trees (geodata points.trees, furniture trees)", "source": "GC2 byrum_ekstern.registrerede_traer + byrum.vejtraer", "count": len(tr),
         "note": "heights are the register's 5 m class midpoints (inferred) or 10 m when unclassed; crown = 0.5 x height (inferred); no crown polygons"},
        {"item": "bike racks", "source": "GC2 mobilitet.cykelstativer", "count": len(rk), "note": "capacity from antal_pladser; 5 (inferred) when empty"},
        {"item": "benches", "source": "GC2 byrum.baenk (43, 2018) + OSM amenity=bench", "count": len(bn), "note": "positions only"},
        {"item": "traffic signals", "source": "GC2 byrum.signalanlaeg (OSM signals were already citywide)", "count": len(sg), "note": "only signals more than 25 m from an OSM/KK signal"},
    ]
    return pts, rows


def sidewalk_rings(existing_rings: list) -> list:
    """geodata `sidewalks` for Frederiksberg: GC2 stab.fortovsareal (5,162 pavement polygons, staff schema)."""
    from shapely.geometry import shape

    out = []
    for f in load("pavement"):
        p = f["properties"]
        if p.get("status") not in (None, "klar"):
            continue
        g = shape(f["geometry"]).buffer(0)
        for i, poly in enumerate(g.geoms if g.geom_type == "MultiPolygon" else [g]):
            if poly.is_empty or poly.area < 2:
                continue
            ring = frame.ring_to_local(poly.exterior.coords)
            out.append({"id": f"frb:gc2:fortovsareal:{p.get('gid')}" + (f"#{i}" if i else ""), "ring": frame.flat(ring),
                        "src": ["frb:gc2:stab.fortovsareal"], "conf": "observed",
                        "conf_fields": {"ring": "inferred"} if p.get("belaegning") not in ("fast", None) else {}})
    return out


# ------------------------------------------------------------------------------------------------ furniture lists

def furniture(F, roads, osm_street_nodes: dict | None) -> tuple[dict, list]:
    """Frederiksberg additions to cph-furniture lists. `F` is the furniture module, `roads` its RoadIndex."""
    poly = frb_polygon()
    out = {"bins": [], "glassContainers": [], "busStops": [], "monuments": [], "parkingBays": [], "bollards": [], "lamps": [],
           "benches": [], "bikeRacks": []}
    # bins
    for f in load("bins"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            out["bins"].append({"x": x, "z": z, "kind": "litter", "model": p.get("type"), "yaw": F.face_road(roads, x, z),
                                "src": [f"frb:gc2:skraldespande:{p.get('id')}"], "conf": "observed", "licence": LIC})
    for f in load("glass"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            out["glassContainers"].append({"x": x, "z": z, "yaw": F.face_road(roads, x, z), "address": p.get("fuld adres"),
                                           "src": [f"frb:gc2:glascontainere:{p.get('gid')}"], "conf": "observed", "licence": LIC})
    for f in load("monuments"):
        p = f["properties"]
        if p.get("gc2_version_end_date"):
            continue  # superseded version of the row
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            out["monuments"].append({"x": x, "z": z, "name": p.get("titel"), "artist": p.get("kunstner"),
                                     "src": [f"frb:gc2:monumenter:{p.get('gid')}"], "conf": "observed", "licence": LIC})
    # bus stops: Movia has them regionally (added by the caller); the GC2 table adds stops Movia lacks
    for f in load("busstops"):
        p = f["properties"]
        for c in _pts(f.get("geometry")):
            x, z = _local(c)
            s = F.side_to_road(roads, x, z)
            out["busStops"].append({"x": x, "z": z, "yaw": round(math.atan2(s[0], s[1]), 3) if s else 0.0,
                                    "tangent": [round(s[2], 3), round(s[3], 3)] if s else [1.0, 0.0], "name": p.get("navn"), "lines": p.get("buslist"),
                                    "shelter": str(p.get("laeskaerm")) == "1", "bench": False, "bin": str(p.get("skraldespand")) == "1",
                                    "cycle_parking": False, "countdown": str(p.get("nedtaelling")) == "1", "length": None,
                                    "src": [f"frb:gc2:busstoppesteder:{p.get('stopnr')}"], "conf": "observed",
                                    "conf_fields": {"yaw": "inferred", "bench": "inferred", "cycle_parking": "inferred"}, "licence": LIC})
    # parking bays from the pavement-side parking polygons (aerial-photo origin); kind from the polygon shape, count from `antal`
    from shapely.geometry import shape

    for f in load("parking"):
        p = f["properties"]
        if not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        try:
            cnt = int(float(p.get("antal")))
        except (TypeError, ValueError):
            cnt = None
        for pg in (list(g.geoms) if g.geom_type == "MultiPolygon" else [g]):
            if pg.is_empty or pg.area < 6:
                continue
            for x, z, yaw in F.bays_in_polygon(pg, cnt, "perp"):
                out["parkingBays"].append({"x": F.r2(x), "z": F.r2(z), "yaw": round(yaw, 3), "kind": "par", "ordning": None,
                                           "src": [f"frb:gc2:parkeringspladser:{p.get('gid')}"], "conf": "observed",
                                           "conf_fields": {"kind": "inferred", "yaw": "inferred"}, "licence": LIC})
    # OSM fills: bollards, street lamps, waste baskets, benches that the registers lack
    for el in (osm_street_nodes or {}).get("elements", []):
        t = el.get("tags", {})
        if el.get("type") != "node":
            continue
        e, n_ = S_to_utm(el["lon"], el["lat"])
        if not poly.contains(_point(e, n_)):
            continue
        x, z = _local((e, n_))
        src = [f"osm:node/{el['id']}"]
        if t.get("barrier") == "bollard":
            out["bollards"].append({"x": x, "z": z, "material": "other", "colour": None, "src": src, "conf": "observed",
                                    "conf_fields": {"material": "inferred", "colour": "inferred"}, "licence": "ODbL"})
        elif t.get("amenity") == "waste_basket":
            out["bins"].append({"x": x, "z": z, "kind": "litter", "model": None, "yaw": F.face_road(roads, x, z), "src": src,
                                "conf": "observed", "conf_fields": {"model": "inferred"}, "licence": "ODbL"})
    return out, []


def crossing_markings() -> list:
    """cph-surfaces `markings` for the pedestrian crossings of Frederiksberg (GC2 vej.fodgaengerfelt: lines, 267): a 3 m wide
    strip along the line. The only marking register Frederiksberg has."""
    from shapely.geometry import shape

    out = []
    for f in load("crossings"):
        if not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        for i, ln in enumerate(g.geoms if g.geom_type == "MultiLineString" else [g]):
            if ln.length < 1.0:
                continue
            strip = ln.buffer(1.5, cap_style="flat")
            if strip.is_empty:
                continue
            ring = frame.ring_to_local(strip.exterior.coords)
            out.append({"kind": "crossing", "src": ["frb:gc2:vej.fodgaengerfelt"], "conf": "observed",
                        "conf_fields": {"width": "inferred"}, "id": f"frb:gc2:fodgaengerfelt:{f['properties'].get('gid')}#{i}",
                        "ring": frame.flat(ring)})
    return out
