# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "pyproj", "shapely", "pyshp"]
# ///
"""Street-furniture compiler for the Copenhagen twin -> data/cph-furniture.json (M4).

A separate file: it never touches data/cph-geodata.json (it reads roads and buildings from it for orientation).
Same local frame (x = E - 723900, z = -(N - 6176500), bbox +-750 m). Raw downloads are cached in data/raw/.

Sources
  Trees      k101:automatisk_detekterede_traeer_kk_beta (height, crown area) + ..._kroner_kk_beta (crown polygons)
             + k101:trae_basis (species, genus, planting year) + the trees already in cph-geodata.json
  Lamps      Citelum/KK CKAN belysning-master (mast-mounted) and belysning-wirer (wire-suspended) GPKGs, CC BY 4.0;
             belysning-ledninger (2018 shapefile) for wire geometry where a lamp sits on a line
  Parking    k101:p_pladser (kerb lines) + k101:parkering_areal (polygons) -> bays; k101:parkomat
  Bins       k101:affaldskurve_puma, k101:ask_glascontainer, k101:ask_standpladser_nokey
  Others     k101:pullert, baenke_borde_puma + dp_byinventar_f (Bænkflade), cykelstativ + dp_byinventar_l,
             Movia Stoppestedsudstyr (ArcGIS), k101:monumenter, dp_byinventar_p (Redningsposte, Borner)

Every feature has src / conf / licence. Orientation fields (`yaw`) are the direction the object FACES: local +z of the
model maps to (sin yaw, cos yaw) in (x, z), i.e. three.js rotation.y = yaw.

    uv run tools/cph-geodata/furniture.py [--refresh]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402
from frame import area_local, ORIGIN, to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "cph-furniture.json"
CITELUM = ROOT / "data" / "raw" / "citelum"
CKAN_FILES = {
    "master.gpkg": "https://admin.opendata.dk/dataset/752b1594-bbf9-4276-873a-fd43fd1be38a/resource/51c8134b-bda6-4c8e-91a0-f31c015fc41b/download/mastophaengt_armatur.gpkg",
    "wire.gpkg": "https://admin.opendata.dk/dataset/04899d81-509d-4f5c-82f6-0d4a6c2bfe05/resource/087ffb4d-1ddf-4670-9590-88faaa86a797/download/wireophaenge_armatur.gpkg",
    "ledninger.zip": "https://admin.opendata.dk/dataset/ddb4a075-b3cf-4815-9198-a893ba5ddc89/resource/17df35d0-30ff-473f-9b72-d8898151de81/download/ledninger.zip",
}
MOVIA = "https://geoservices.moviatrafik.dk/arcgis/rest/services/Registrering2/PublicReadOnly/MapServer/0/query"
YEAR = 2026
LIC_KK = "CC-BY-4.0"
LIC_NONE = "unstated"  # CKAN licence_id is null: treat as unconfirmed (ask bydata@kk.dk before redistribution)


def in_bbox(x: float, z: float) -> bool:
    x0, z0, x1, z1 = area_local()
    return x0 <= x <= x1 and z0 <= z <= z1


def r2(v: float) -> float:
    return round(v, 2) + 0.0


def num(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------- pure mappings

TREE_GENERA = [  # (needle in lower-cased "slaegtsnavn traeart dansk_navn", key); first hit wins
    ("tilia", "lime"), ("lind", "lime"),
    ("aesculus", "chestnut"), ("hestekastanie", "chestnut"), ("kastanie", "chestnut"),
    ("ulmus", "elm"), ("elm", "elm"),
    ("acer", "maple"), ("løn", "maple"),
    ("platan", "plane"),
    ("quercus", "oak"), ("eg ", "oak"), ("eg", "oak"),
    ("prunus", "cherry"), ("kirsebær", "cherry"), ("blomme", "cherry"),
    ("robin", "robinia"), ("sophora", "robinia"),
    ("populus", "poplar"), ("poppel", "poplar"),
    ("salix", "willow"), ("pil", "willow"),
    ("fraxinus", "ash"), ("ask", "ash"), ("ailanthus", "ash"),
    ("betula", "birch"), ("birk", "birch"),
    ("crataegus", "hawthorn"), ("tjørn", "hawthorn"), ("tretorn", "hawthorn"), ("malus", "hawthorn"), ("æble", "hawthorn"),
    ("pyrus", "hawthorn"), ("pære", "hawthorn"), ("bærmispel", "hawthorn"), ("sorbus", "hawthorn"), ("røn", "hawthorn"),
    ("corylus", "hawthorn"), ("hassel", "hawthorn"), ("skyrækker", "hawthorn"),
    ("metasequoia", "conifer"), ("vandgran", "conifer"), ("pinus", "conifer"), ("fyr", "conifer"), ("picea", "conifer"),
]


def genus_key(slaegtsnavn=None, traeart=None, dansk=None) -> str:
    """Normalised genus family the twin has a procedural tree for. The register's genus name decides first, then the
    Latin name, then the Danish one; 'generic' when nothing matches."""
    for field in (slaegtsnavn, traeart, dansk):
        words = re.findall(r"[a-zæøåéü]+", str(field or "").lower())
        for needle, key in TREE_GENERA:
            if any(w.startswith(needle) for w in words[:2]):
                return key
    return "generic"


def tree_age(planteaar) -> int | None:
    y = num(planteaar)
    return int(YEAR - y) if y and 1700 < y <= YEAR else None


def height_from_age(age: int | None, genus: str) -> float:
    """Fallback when no canopy-height detection exists: a saturating growth curve. Marked `inferred`."""
    full = {"poplar": 26, "plane": 24, "lime": 20, "chestnut": 18, "elm": 20, "oak": 20, "maple": 17, "ash": 20,
            "willow": 14, "birch": 16, "conifer": 20, "cherry": 9, "hawthorn": 7, "robinia": 14}.get(genus, 13)
    if age is None:
        return round(full * 0.6, 1)
    return round(max(2.5, full * (1 - math.exp(-age / 28.0))), 1)


MAST_KIND = [("københavner", "kbh"), ("rørmast", "tube"), ("parklygte", "park"), ("ørestad", "oerestad")]


def parse_mast(text: str | None) -> dict:
    """'Københavnermast 9,0m' -> {kind: 'kbh', h: 9.0}; 'Ørestadsmast 7,5/2,4m' -> h 7.5, arm 2.4; unknown -> kind 'tube'."""
    t = (text or "").lower()
    kind = next((k for needle, k in MAST_KIND if needle in t), "tube")
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:/\s*(\d+(?:[.,]\d+)?))?\s*m\b", t)
    h = num(m.group(1)) if m else None
    arm = num(m.group(2)) if m and m.group(2) else None
    if h is None:
        h = {"kbh": 9.0, "park": 3.5, "oerestad": 7.5}.get(kind, 6.0)
    return {"kind": kind, "h": h, "arm": arm}


def cct_from_text(t: str) -> int | None:
    """Colour temperature written in the fixture/lamp text: '2700K', or a lamp colour code (827/830/840, 727/730/740)."""
    m = re.search(r"\b(\d{4})\s*k\b", t)
    if m and 1800 <= int(m.group(1)) <= 6500:
        return int(m.group(1))
    m = re.search(r"(?<!\d)[789](\d)(\d)(?!\d)", t)
    if m:
        k = {"27": 2700, "28": 2800, "30": 3000, "35": 3500, "40": 4000, "65": 6500}.get(m.group(1) + m.group(2))
        if k:
            return k
    return None


def classify_lamp(armatur: str | None, lyskilde: str | None, watt=None) -> dict:
    """Light-source class and colour temperature from the fixture and lamp text. LED 3000-4000 K, sodium 2000 K,
    ceramic metal halide ~3000 K, fluorescent / induction ~3000 K; the explicit K or colour code wins."""
    t = f"{armatur or ''} {lyskilde or ''}".lower()
    cct = cct_from_text(t)
    if "led" in t or re.search(r"\bgrn\d|light engine|uplight|becco|maxiwoody|\d\s?lm\b", t):
        src, cct = "led", cct or 3000
        if cct > 5000:  # '865' style codes in fixture names are not street-light colour temperatures
            cct = 4000
    elif re.search(r"\bhna\b|natrium|\bsox\b|son-t|\bson\b|\bhsl\b", t):
        src, cct = "sodium", 2000
    elif re.search(r"halogen|\bmhn|\bcdm|cdo|\bhci|\bhit\b|\bhie\b", t):
        src, cct = "metalhalide", cct or 3000
    elif re.search(r"lysstof|\bpl-|dulux|fluor|\bql\b|induktion", t):
        src, cct = "fluorescent", cct or 3000
    elif re.search(r"kviks|\bhql\b|\bhme\b", t):
        src, cct = "mercury", cct or 4200
    else:
        src, cct = "unknown", cct or 3000
    w = num(watt)
    return {"light": src, "cct": cct, "watt": int(w) if w else None, "led": src == "led"}


def bench_yaw(face_dx: float, face_dz: float) -> float:
    return round(math.atan2(face_dx, face_dz), 3)


def bay_layout(length: float, count: int | None, kind: str) -> tuple[int, float]:
    """(number of cars, spacing) along a kerb line. `count` is the register's antal_pladser; angled/perpendicular bays are
    ~2.5 m wide, parallel bays ~5.3 m long."""
    pitch = 5.4 if kind == "par" else 2.6
    n = int(count) if count else int(length // pitch)
    n = max(0, min(n, int(length // (pitch * 0.55)) or 1))
    if n == 0:
        return 0, 0.0
    return n, length / n


def parking_kind(p_type: str | None) -> tuple[str, float]:
    """('par' | 'ang' | 'perp', angle in degrees from the kerb). Unmarked 'Uafmærket parkering' is parallel."""
    t = (p_type or "").lower()
    m = re.search(r"(\d+)\s*°", t)
    if "skråparkering" in t and m:
        a = float(m.group(1))
        return ("perp" if a >= 85 else "ang"), a
    return "par", 0.0


# ---------------------------------------------------------------------------------------------- geodata access

class RoadIndex:
    """Nearest car-road centreline segment lookup (grid hash) for orienting furniture relative to the carriageway."""

    def __init__(self, roads):
        self.cell = 40.0
        self.segs = []
        self.grid: dict[tuple[int, int], list[int]] = {}
        for r in roads:
            if r["class"] not in ("primary", "secondary", "residential", "service"):
                continue
            p = r["pts"]
            for i in range(0, len(p) - 2, 2):
                s = (p[i], p[i + 1], p[i + 2], p[i + 3], r["width"] or 6.0, r.get("name") or "")
                k = len(self.segs)
                self.segs.append(s)
                for ix in range(int(min(s[0], s[2]) // self.cell) - 1, int(max(s[0], s[2]) // self.cell) + 2):
                    for iz in range(int(min(s[1], s[3]) // self.cell) - 1, int(max(s[1], s[3]) // self.cell) + 2):
                        self.grid.setdefault((ix, iz), []).append(k)

    def nearest(self, x: float, z: float, radius: float = 40.0):
        """(distance, foot x, foot z, tangent dx, tangent dz, road width, name) of the nearest centreline, or None."""
        best = None
        seen = set()
        for ix in range(int((x - radius) // self.cell), int((x + radius) // self.cell) + 1):
            for iz in range(int((z - radius) // self.cell), int((z + radius) // self.cell) + 1):
                for k in self.grid.get((ix, iz), ()):
                    if k in seen:
                        continue
                    seen.add(k)
                    ax, az, bx, bz, w, name = self.segs[k]
                    dx, dz = bx - ax, bz - az
                    l2 = dx * dx + dz * dz or 1.0
                    t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / l2))
                    fx, fz = ax + dx * t, az + dz * t
                    d = math.hypot(x - fx, z - fz)
                    if best is None or d < best[0]:
                        l = math.sqrt(l2)
                        best = (d, fx, fz, dx / l, dz / l, w, name)
        return best


def side_to_road(roads: RoadIndex, x: float, z: float):
    """Unit vector from (x, z) towards the nearest road centreline plus the tangent; (None) if no road within 40 m."""
    n = roads.nearest(x, z)
    if not n:
        return None
    d, fx, fz, tx, tz, w, _ = n
    if d < 1e-6:
        return -tz, tx, tx, tz, d, w
    return (fx - x) / d, (fz - z) / d, tx, tz, d, w


def load_json(path: Path):
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------------------------- downloads

def ensure_citelum(refresh: bool) -> None:
    import requests

    CITELUM.mkdir(parents=True, exist_ok=True)
    for name, url in CKAN_FILES.items():
        path = CITELUM / name
        if path.exists() and path.stat().st_size > 1000 and not refresh:
            continue
        r = requests.get(url, headers={"User-Agent": "cph-twin-furniture/0.1"}, timeout=300)
        r.raise_for_status()
        path.write_bytes(r.content)
        print(f"[fetch] citelum {name}: {len(r.content)} bytes", file=sys.stderr)


def read_gpkg_points(path: Path):
    """[(E, N, attrs dict)] of a one-table MULTIPOINT/POINT GeoPackage, no GDAL needed."""
    from shapely import wkb

    con = sqlite3.connect(path)
    table = con.execute("select table_name from gpkg_contents").fetchone()[0]
    cols = [r[1] for r in con.execute(f'pragma table_info("{table}")')]
    out = []
    for row in con.execute(f'select * from "{table}"'):
        rec = dict(zip(cols, row))
        blob = rec.pop("geom")
        env = (blob[3] >> 1) & 7
        g = wkb.loads(bytes(blob[8 + [0, 32, 48, 48, 64][env]:]))
        pts = list(g.geoms) if g.geom_type == "MultiPoint" else [g]
        for p in pts:
            out.append((p.x, p.y, rec))
    con.close()
    return out


def movia_stops(refresh: bool):
    import requests
    from fetch import RAW, utm_bbox

    path = RAW / "movia_stoppestedsudstyr.json"
    if path.exists() and not refresh:
        return load_json(path)
    x0, y0, x1, y1 = utm_bbox()
    r = requests.get(MOVIA, params={
        "where": "1=1", "geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope", "inSR": "25832",
        "outSR": "25832", "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "f": "json", "returnGeometry": "true"},
        timeout=90, headers={"User-Agent": "cph-twin-furniture/0.1"})
    r.raise_for_status()
    d = r.json()
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(d, ensure_ascii=False))
    print(f"[fetch] movia: {len(d.get('features', []))} stops", file=sys.stderr)
    return d


# ---------------------------------------------------------------------------------------------- builders

def pts_of(geom):
    if geom.geom_type == "Point":
        return [geom]
    if geom.geom_type == "MultiPoint":
        return list(geom.geoms)
    return []


def build_trees(kk, geo):
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    det = []
    for f in kk("automatisk_detekterede_traeer_kk_beta")["features"]:
        pr = f["properties"]
        for p in pts_of(shape(f["geometry"])):
            det.append((p, pr.get("traehoejde"), pr.get("kroneareal"), pr.get("treeid")))
    crowns = {}
    for f in kk("automatisk_detekterede_kroner_kk_beta")["features"]:
        g = shape(f["geometry"])
        if not g.is_empty and f["properties"].get("treeid") is not None:
            crowns[f["properties"]["treeid"]] = g
    tree = STRtree([d[0] for d in det])
    used = set()
    out = []

    def crown_r(tid, area_attr, kd, h):
        g = crowns.get(tid)
        if g is not None and g.area > 1:
            return round(math.sqrt(g.area / math.pi), 1), "observed", "crown polygon"
        a = num(area_attr)
        if a and a > 1:
            return round(math.sqrt(a / math.pi), 1), "observed", "crown area"
        d = num(kd)
        if d:
            return round(d / 2, 1), "observed", "register"
        return round(max(1.5, h * 0.4), 1), "inferred", "height ratio"

    for f in kk("trae_basis")["features"]:
        pr = f["properties"]
        for p in pts_of(shape(f["geometry"])):
            x, z = to_local(p.x, p.y)
            if not in_bbox(x, z):
                continue
            genus = genus_key(pr.get("slaegtsnavn"), pr.get("traeart"), pr.get("dansk_navn"))
            age = tree_age(pr.get("planteaar"))
            src = [f"kk:trae_basis:{pr.get('uuid')}"]
            cf = {}
            h, tid, area = None, None, None
            best = None
            for i in tree.query(p.buffer(4.0)):
                i = int(i)
                if i in used:
                    continue
                d = det[i][0].distance(p)
                if d <= 4.0 and (best is None or d < best[0]):
                    best = (d, i)
            if best:
                used.add(best[1])
                _, h, area, tid = det[best[1]][0], det[best[1]][1], det[best[1]][2], det[best[1]][3]
                src.append(f"kk:automatisk_detekterede_traeer:{tid}")
            if h:
                cf["height"] = "observed"
            else:
                h, cf["height"] = height_from_age(age, genus), "inferred"
            cr, cc, _ = crown_r(tid, area, pr.get("kronediameter") if num(pr.get("kronediameter")) else None, h)
            cf["crown_radius"] = cc
            if genus == "generic":
                cf["genus"] = "inferred"
            out.append({"x": r2(x), "z": r2(z), "height": round(float(h), 1), "crown_radius": cr, "genus": genus,
                        "species": pr.get("traeart") or None, "name": pr.get("dansk_navn") or None, "age": age,
                        "category": pr.get("kategori") or None, "src": src, "conf": "observed", "conf_fields": cf,
                        "licence": LIC_KK})
    for i, (p, h, area, tid) in enumerate(det):
        if i in used or not h:
            continue
        x, z = to_local(p.x, p.y)
        if not in_bbox(x, z):
            continue
        cr, cc, _ = crown_r(tid, area, None, float(h))
        out.append({"x": r2(x), "z": r2(z), "height": round(float(h), 1), "crown_radius": cr, "genus": "generic",
                    "species": None, "name": None, "age": None, "category": None,
                    "src": [f"kk:automatisk_detekterede_traeer:{tid}"], "conf": "observed",
                    "conf_fields": {"genus": "inferred", "height": "observed", "crown_radius": cc}, "licence": LIC_NONE})
    # trees already in the geodata bundle that neither source above reproduced (e.g. OSM nodes) are kept
    if geo:
        pts = [Point(t["x"], t["z"]) for t in out]
        st = STRtree(pts)
        added = 0
        for t in geo.get("points", {}).get("trees", []):
            if len(st.query(Point(t["x"], t["z"]).buffer(3.0))) == 0 and in_bbox(t["x"], t["z"]):
                sp = t.get("species")
                genus = genus_key(None, sp if sp != "unknown" else None)
                out.append({"x": t["x"], "z": t["z"], "height": t.get("height", 10.0), "crown_radius": round(t.get("crown", 5.0) / 2, 1),
                            "genus": genus, "species": sp if sp != "unknown" else None, "name": None, "age": None, "category": None,
                            "src": t["src"] + ["cph-geodata:points.trees"], "conf": t.get("conf", "observed"),
                            "conf_fields": t.get("conf_fields", {}), "licence": LIC_KK})
                added += 1
        print(f"[trees] kept {added} geodata trees not reproduced by the KK layers", file=sys.stderr)
    return out


def build_lamps(roads: RoadIndex, buildings, refresh: bool):
    from shapely.geometry import LineString, Point
    from shapely.strtree import STRtree
    import shapefile

    ensure_citelum(refresh)
    # wire geometry (2018 shapefile of lighting lines), local frame
    sf = shapefile.Reader(str(extract_ledninger()))
    lines = []
    for shp in sf.iterShapes():
        for part in range(len(shp.parts)):
            a = shp.parts[part]
            b = shp.parts[part + 1] if part + 1 < len(shp.parts) else len(shp.points)
            pl = [to_local(e, n) for e, n in shp.points[a:b]]
            if len(pl) >= 2 and any(in_bbox(*p) for p in pl):
                lines.append(LineString(pl))
    line_tree = STRtree(lines) if lines else None
    wall_segs = building_wall_segments(buildings)

    out, wires = [], []
    for e, n, rec in read_gpkg_points(CITELUM / "master.gpkg"):
        x, z = to_local(e, n)
        if not in_bbox(x, z):
            continue
        m = parse_mast(rec.get("maste_data"))
        c = classify_lamp(rec.get("armatur_data"), rec.get("lyskilde_data"), rec.get("watt"))
        out.append({"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "mount": "mast", "pole": m["kind"], "pole_h": m["h"], "arm": m["arm"],
                    "pole_text": rec.get("maste_data"), "fixture": rec.get("armatur_data"), "source_text": rec.get("lyskilde_data"),
                    **c, "installed": rec.get("installations_dato"),
                    "src": [f"citelum:belysning-master:{rec.get('id_element')}"], "conf": "observed", "licence": LIC_KK})
    n_line = n_facade = n_none = 0
    for e, n, rec in read_gpkg_points(CITELUM / "wire.gpkg"):
        x, z = to_local(e, n)
        if not in_bbox(x, z):
            continue
        c = classify_lamp(rec.get("armatur_data"), rec.get("lyskilde_data"), rec.get("watt"))
        lamp = {"x": r2(x), "z": r2(z), "mount": "wire", "pole": None, "pole_h": None, "arm": None,
                "pole_text": rec.get("maste_data"), "fixture": rec.get("armatur_data"), "source_text": rec.get("lyskilde_data"),
                **c, "installed": rec.get("installations_dato"),
                "src": [f"citelum:belysning-wirer:{rec.get('id_element')}"], "conf": "observed", "licence": LIC_KK}
        span = None
        if line_tree is not None:
            p = Point(x, z)
            near = [(lines[int(i)].distance(p), int(i)) for i in line_tree.query(p.buffer(6.0))]
            near = [t for t in near if t[0] <= 4.0]
            if near:
                d, i = min(near)
                span = line_span(lines[i], x, z)
                if span:
                    lamp["src"].append("citelum:belysning-ledninger")
                    lamp["span_conf"] = "observed"
                    n_line += 1
        if span is None:
            span = facade_span(x, z, roads, wall_segs)
            if span:
                lamp["span_conf"] = "inferred"
                n_facade += 1
        if span:
            lamp["span"] = [r2(v) for v in span]
        else:
            n_none += 1
        out.append(lamp)
    print(f"[lamps] {len(out)} total; wire spans: {n_line} from ledninger, {n_facade} facade-to-facade inferred, {n_none} none", file=sys.stderr)
    return out


def extract_ledninger() -> Path:
    d = CITELUM / "ledninger"
    shp = d / "Ledninger.shp"
    if not shp.exists():
        d.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(CITELUM / "ledninger.zip") as z:
            z.extractall(d)
    return shp


def line_span(line, x: float, z: float):
    """Segment of a wire polyline through the lamp: the two vertices around its projection, extended to the ends of a
    single straight span (a lighting wire is one span between two anchors)."""
    from shapely.geometry import Point

    s = line.project(Point(x, z))
    pts = list(line.coords)
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    for i in range(len(pts) - 1):
        if cum[i] <= s <= cum[i + 1] + 1e-6:
            a, b = pts[i], pts[i + 1]
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 6.0:  # too short for a cross-street span
                return None
            return a[0], a[1], b[0], b[1]
    return None


def building_wall_segments(buildings):
    segs = []
    for b in buildings or []:
        for ring in [b["ring"]] + (b.get("holes") or []):
            n = len(ring) // 2
            for i in range(n):
                j = (i + 1) % n
                segs.append((ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], b.get("eave", 10.0) - b.get("ground", 0.0)))
    return segs


class WallIndex:
    def __init__(self, segs, cell=30.0):
        self.cell = cell
        self.segs = segs
        self.grid: dict = {}
        for k, s in enumerate(segs):
            for ix in range(int(min(s[0], s[2]) // cell), int(max(s[0], s[2]) // cell) + 1):
                for iz in range(int(min(s[1], s[3]) // cell), int(max(s[1], s[3]) // cell) + 1):
                    self.grid.setdefault((ix, iz), []).append(k)

    def ray(self, x, z, dx, dz, maxd=40.0):
        """Distance and wall height of the first wall hit along a ray, or None."""
        best = None
        seen = set()
        steps = int(maxd // self.cell) + 2
        for i in range(steps + 1):
            cx, cz = x + dx * i * self.cell * 0.9, z + dz * i * self.cell * 0.9
            for k in self.grid.get((int(cx // self.cell), int(cz // self.cell)), ()):
                if k in seen:
                    continue
                seen.add(k)
                ax, az, bx, bz, h = self.segs[k]
                ex, ez = bx - ax, bz - az
                den = dx * ez - dz * ex
                if abs(den) < 1e-9:
                    continue
                t = ((ax - x) * ez - (az - z) * ex) / den
                u = ((ax - x) * dz - (az - z) * dx) / den
                if 0.3 < t <= maxd and 0 <= u <= 1 and (best is None or t < best[0]):
                    best = (t, h)
        return best


_WALL_CACHE: dict = {}


def facade_span(x: float, z: float, roads: RoadIndex, segs):
    """Fallback wire geometry: across the street, perpendicular to the nearest carriageway, from the facade on one side
    to the facade on the other. The anchors sit 6.5 m up (or just under the eave). `inferred`."""
    key = id(segs)
    if key not in _WALL_CACHE:
        _WALL_CACHE[key] = WallIndex(segs)
    wi = _WALL_CACHE[key]
    n = roads.nearest(x, z, 30.0)
    if not n:
        return None
    tx, tz = n[3], n[4]
    px, pz = -tz, tx
    a = wi.ray(x, z, px, pz)
    b = wi.ray(x, z, -px, -pz)
    if not a or not b or a[0] + b[0] > 45 or a[0] + b[0] < 6:
        return None
    return x + px * a[0], z + pz * a[0], x - px * b[0], z - pz * b[0]


def build_parking(kk, roads: RoadIndex):
    from shapely.geometry import shape, LineString, Polygon
    from shapely.strtree import STRtree

    areal = kk("parkering_areal")["features"]
    lines = kk("p_pladser")["features"]
    area_line_ids = {f["properties"]["linje_id"] for f in areal if f["properties"].get("linje_id") is not None}
    bays = []

    def push(x, z, yaw, kind, pr, src):
        if in_bbox(x, z):
            bays.append({"x": r2(x), "z": r2(z), "yaw": round(yaw, 3), "kind": kind,
                         "ordning": pr.get("p_ordning"), "src": src, "conf": "observed", "licence": LIC_KK})

    n_line = n_area = 0
    for f in lines:
        pr = f["properties"]
        if pr["id"] in area_line_ids:
            continue
        kind, ang = parking_kind(pr.get("p_type"))
        g = shape(f["geometry"])
        for ls in (list(g.geoms) if g.geom_type == "MultiLineString" else [g]):
            pts = [to_local(*c[:2]) for c in ls.coords]
            L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
            n, step = bay_layout(L, pr.get("antal_pladser") if g.geom_type == "LineString" else None, kind)
            for i in range(n):
                s = (i + 0.5) * step
                x, z, tx, tz = point_along(pts, s)
                side = side_to_road(roads, x, z)
                if side is None:
                    continue
                sx, sz = side[0], side[1]
                off = {"par": 1.05, "ang": 2.0, "perp": 2.3}[kind]
                cx, cz = x + sx * off, z + sz * off
                if kind == "par":
                    yaw = math.atan2(tx, tz)
                else:
                    # cars point their nose to the kerb at the register's angle: axis = side vector rotated by the angle
                    a = math.radians(90.0 - ang) if kind == "ang" else 0.0
                    sgn = 1 if (tx * sz - tz * sx) > 0 else -1
                    yaw = math.atan2(-sx, -sz) + sgn * a  # nose towards the kerb, leaning along the street
                push(cx, cz, yaw, kind, pr, [f"kk:p_pladser:{pr.get('uuid')}"])
                n_line += 1
    for f in areal:
        pr = f["properties"]
        kind, ang = parking_kind(pr.get("p_type"))
        g = shape(f["geometry"])
        for poly in (list(g.geoms) if g.geom_type == "MultiPolygon" else [g]):
            if poly.is_empty or poly.area < 6:
                continue
            for x, z, yaw in bays_in_polygon(poly, pr.get("antal_p_pladser"), kind):
                push(x, z, yaw, kind, pr, [f"kk:parkering_areal:{pr.get('v_id')}"])
                n_area += 1
    print(f"[parking] bays: {n_line} from kerb lines, {n_area} from polygons", file=sys.stderr)
    return bays


def point_along(pts, s):
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        if acc + l >= s and l > 0:
            t = (s - acc) / l
            return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / l, (b[1] - a[1]) / l
        acc += l
    a, b = pts[-2], pts[-1]
    l = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
    return b[0], b[1], (b[0] - a[0]) / l, (b[1] - a[1]) / l


def bays_in_polygon(poly, count, kind):
    """Bay centres inside a parking polygon (UTM): along the minimum rotated rectangle's long axis."""
    rect = poly.minimum_rotated_rectangle
    c = list(rect.exterior.coords)[:4]
    e1 = (c[1][0] - c[0][0], c[1][1] - c[0][1])
    e2 = (c[2][0] - c[1][0], c[2][1] - c[1][1])
    l1, l2 = math.hypot(*e1), math.hypot(*e2)
    (lx, lz), (sx, sz), L, S = (e1, e2, l1, l2) if l1 >= l2 else (e2, e1, l2, l1)
    ux, uy = lx / L, lz / L  # long axis (UTM)
    vx, vy = sx / S, sz / S
    ox, oy = c[0] if l1 >= l2 else c[1]
    out = []
    if kind == "par" or S < 3.6:
        n = int(count) if count else max(1, int(L // 5.4))
        n = max(1, min(n, int(L // 4.6) or 1))
        rows = 1
        step = L / n
        slots = [((i + 0.5) * step, S / 2) for i in range(n)]
    else:
        rows = max(1, int(round(S / 4.9)))
        per = max(1, int(L // 2.5))
        want = int(count) if count else per * rows
        slots = []
        for r in range(rows):
            for i in range(per):
                slots.append(((i + 0.5) * L / per, (r + 0.5) * S / rows))
        slots = slots[:max(1, min(want, len(slots)))]
    for a, b in slots:
        ex, ey = ox + ux * a + vx * b, oy + uy * a + vy * b
        x, z = to_local(ex, ey)
        # yaw from UTM axis (E, N) to the local frame: z = -N, so the heading (de, dn) -> (dx, dz) = (de, -dn)
        out.append((x, z, math.atan2(ux if kind == "par" or S < 3.6 else vx, -(uy if kind == "par" or S < 3.6 else vy))))
    return out


def single_points(kk, layer):
    from shapely.geometry import shape

    for f in kk(layer)["features"]:
        for p in pts_of(shape(f["geometry"])):
            x, z = to_local(p.x, p.y)
            if in_bbox(x, z):
                yield x, z, f["properties"], f


def build_simple(kk, roads: RoadIndex):
    from shapely.geometry import shape

    out = {}
    out["parkMeters"] = [{"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "zone": pr.get("p_zone"), "working": not pr.get("virker_ikke"),
                          "src": [f"kk:parkomat:{pr.get('id')}"], "conf": "observed", "licence": LIC_KK}
                         for x, z, pr, _ in single_points(kk, "parkomat") if pr.get("type") != "Nedlagt"]
    out["bins"] = []
    for x, z, pr, _ in single_points(kk, "affaldskurve_puma"):
        cat = (pr.get("kgb_kategori") or "").lower()
        kind = "big" if any(k in cat for k in ("underjord", "big", "molok", "container")) else "litter"
        out["bins"].append({"x": r2(x), "z": r2(z), "kind": kind, "model": pr.get("kgb_kategori"), "yaw": face_road(roads, x, z),
                            "src": [f"kk:affaldskurve_puma:{pr.get('id')}"], "conf": "observed", "licence": LIC_KK})
    out["glassContainers"] = [{"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "address": pr.get("adresse"),
                               "src": [f"kk:ask_glascontainer:{pr.get('id')}"], "conf": "observed", "licence": LIC_KK}
                              for x, z, pr, _ in single_points(kk, "ask_glascontainer")]
    out["binStands"] = [{"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "fraction": pr.get("affaldsfraktion"),
                         "src": [f"kk:ask_standpladser_nokey:{pr.get('standpladsnr')}"], "conf": "observed", "licence": LIC_KK}
                        for x, z, pr, _ in single_points(kk, "ask_standpladser_nokey")]
    out["bollards"] = []
    for x, z, pr, _ in single_points(kk, "pullert"):
        t = (pr.get("pullert_type") or "").lower()
        mat = "granite" if "granit" in t else "galvanised" if "galv" in t else "other"
        ov = (pr.get("pullert_overflade") or "").lower()
        colour = "green" if "grøn" in ov else "grey" if "grå" in ov else "raw"
        out["bollards"].append({"x": r2(x), "z": r2(z), "material": mat, "colour": colour, "mount": pr.get("pullert_montage"),
                                "type": pr.get("pullert_type"), "src": [f"kk:pullert:{pr.get('id')}"], "conf": "observed", "licence": LIC_KK})
    # city-inventory bollards (Borner, pullerter) and rescue posts / monuments from dp_byinventar_p
    byi = [(x, z, pr) for x, z, pr, _ in single_points(kk, "dp_byinventar_p")]
    have = [(b["x"], b["z"]) for b in out["bollards"]]
    extra = 0
    for x, z, pr in byi:
        if pr.get("under_element") == "Borner, pullerter mv." and not any(math.hypot(x - a, z - b) < 1.0 for a, b in have):
            out["bollards"].append({"x": r2(x), "z": r2(z), "material": "other", "colour": "raw", "mount": None, "type": "Bornholmer/pullert (byinventar)",
                                    "src": ["kk:dp_byinventar_p:" + str(pr.get("uuid"))], "conf": "observed", "licence": LIC_NONE})
            extra += 1
    out["rescuePosts"] = [{"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "src": ["kk:dp_byinventar_p:" + str(pr.get("uuid"))],
                           "conf": "observed", "licence": LIC_NONE} for x, z, pr in byi if pr.get("under_element") == "Redningsposte"]
    mons = {}
    for x, z, pr, _ in single_points(kk, "monumenter"):
        mons[(round(x), round(z))] = {"x": r2(x), "z": r2(z), "name": pr.get("navn"), "src": [f"kk:monumenter:{pr.get('id')}"],
                                      "conf": "observed", "licence": LIC_KK}
    for x, z, pr in byi:
        if pr.get("under_element") == "Monumenter og skulpturer" and not any(math.hypot(x - m["x"], z - m["z"]) < 3 for m in mons.values()):
            mons[(round(x), round(z), 1)] = {"x": r2(x), "z": r2(z), "name": pr.get("monument_navn"),
                                             "src": ["kk:dp_byinventar_p:" + str(pr.get("uuid"))], "conf": "observed", "licence": LIC_NONE}
    out["monuments"] = list(mons.values())
    # benches: puma points + Bænkflade polygons (oriented), deduplicated within 1.2 m
    benches = []
    for x, z, pr, _ in single_points(kk, "baenke_borde_puma"):
        t = (pr.get("geoobjekttype") or "").lower()
        if "bænk" in t or "bank" in t:
            benches.append({"x": r2(x), "z": r2(z), "yaw": face_road(roads, x, z), "length": 1.8, "src": [f"kk:baenke_borde_puma:{pr.get('id')}"],
                            "conf": "observed", "licence": LIC_NONE})
    for f in kk("dp_byinventar_f")["features"]:
        pr = f["properties"]
        if pr.get("under_element") != "Bænkflade":
            continue
        g = shape(f["geometry"])
        for poly in (list(g.geoms) if g.geom_type == "MultiPolygon" else [g]):
            c = poly.centroid
            x, z = to_local(c.x, c.y)
            if not in_bbox(x, z) or any(math.hypot(x - b["x"], z - b["z"]) < 1.2 for b in benches):
                continue
            rect = list(poly.minimum_rotated_rectangle.exterior.coords)[:4]
            e1 = (rect[1][0] - rect[0][0], rect[1][1] - rect[0][1])
            e2 = (rect[2][0] - rect[1][0], rect[2][1] - rect[1][1])
            long_, ln = (e1, math.hypot(*e1)) if math.hypot(*e1) >= math.hypot(*e2) else (e2, math.hypot(*e2))
            ax, az = long_[0] / ln, -long_[1] / ln  # to local frame
            yaw = face_road(roads, x, z, axis=(ax, az))
            benches.append({"x": r2(x), "z": r2(z), "yaw": yaw, "length": round(min(4.0, max(1.2, ln)), 1),
                            "src": [f"kk:dp_byinventar_f:{pr.get('uuid')}"], "conf": "observed", "licence": LIC_NONE})
    out["benches"] = benches
    return out, extra


def face_road(roads: RoadIndex, x: float, z: float, axis=None) -> float:
    """Yaw that makes a piece of street furniture face the carriageway (backs to the building). With `axis` (a bench's
    long axis) it faces the road side perpendicular to that axis."""
    s = side_to_road(roads, x, z)
    if s is None:
        return 0.0 if axis is None else round(math.atan2(-axis[1], axis[0]), 3)
    sx, sz = s[0], s[1]
    if axis is not None:
        nx, nz = -axis[1], axis[0]
        if nx * sx + nz * sz < 0:
            nx, nz = -nx, -nz
        return round(math.atan2(nx, nz), 3)
    return round(math.atan2(sx, sz), 3)


def build_bike_racks(kk, roads: RoadIndex):
    from shapely.geometry import shape

    out = []
    for x, z, pr, _ in single_points(kk, "cykelstativ"):
        cap = pr.get("antal_pladser")
        s = side_to_road(roads, x, z)
        yaw = round(math.atan2(s[2], s[3]), 3) if s else 0.0  # rack row runs along the street
        out.append({"x": r2(x), "z": r2(z), "yaw": yaw, "capacity": int(cap) if cap else 6,
                    "src": [f"kk:cykelstativ:{pr.get('id', '')}"], "conf": "observed", "licence": LIC_KK})
    for f in kk("dp_byinventar_l")["features"]:
        pr = f["properties"]
        if pr.get("under_element") != "Cykelstativer":
            continue
        g = shape(f["geometry"])
        for ls in (list(g.geoms) if g.geom_type == "MultiLineString" else [g]):
            if ls.length < 0.5:
                continue
            c = ls.centroid
            x, z = to_local(c.x, c.y)
            if not in_bbox(x, z):
                continue
            co = list(ls.coords)
            a, b = to_local(*co[0][:2]), to_local(*co[-1][:2])
            m = re.match(r"\s*(\d+)\s*x\s*(\d+)", pr.get("kommentar") or "")
            cap = int(m.group(1)) * int(m.group(2)) if m else max(2, int(ls.length / 0.8))
            out.append({"x": r2(x), "z": r2(z), "yaw": round(math.atan2(b[0] - a[0], b[1] - a[1]), 3), "length": round(ls.length, 1),
                        "capacity": cap, "src": ["kk:dp_byinventar_l:" + str(pr.get("uuid"))], "conf": "observed",
                        "conf_fields": {} if m else {"capacity": "inferred"}, "licence": LIC_NONE})
    return out


def build_bus_stops(refresh: bool, roads: RoadIndex):
    out = []
    for f in movia_stops(refresh).get("features", []):
        a, g = f["attributes"], f["geometry"]
        x, z = to_local(g["x"], g["y"])
        if not in_bbox(x, z):
            continue
        s = side_to_road(roads, x, z)
        yaw = round(math.atan2(s[0], s[1]), 3) if s else 0.0
        tx, tz = (s[2], s[3]) if s else (1.0, 0.0)
        out.append({"x": r2(x), "z": r2(z), "yaw": yaw, "tangent": [round(tx, 3), round(tz, 3)], "name": a.get("Name"), "lines": a.get("Buslines"),
                    "shelter": bool(a.get("Windbreaker") or a.get("ComFinancedWindbreaker") or a.get("OtherShelter")),
                    "bench": bool(a.get("Bench")), "bin": bool(a.get("TrashCan")), "cycle_parking": bool(a.get("CycleParking")),
                    "countdown": bool(a.get("CountdownType")), "length": a.get("BusstopLength"),
                    "src": [f"movia:stoppestedsudstyr:{a.get('Number')}"], "conf": "observed",
                    "conf_fields": {"yaw": "inferred", "shelter": "observed"}, "licence": LIC_NONE})
    return out


def build_lake_lights(geo, roads: RoadIndex):
    """Low CitySwan-style bollard lights along the lake paths (docs/research/visual-refs.md section 1c: ~1 m posts, ~15 m
    repeat, 3000 K). Positions are INFERRED from the water edge (the survey is not open data): every 15 m on a line 2.5 m
    outside the lake polygons larger than 15,000 m2, skipping buildings and carriageways."""
    from shapely.geometry import Point, Polygon
    from shapely.ops import unary_union
    from shapely.strtree import STRtree

    bld = [Polygon([(b["ring"][i], b["ring"][i + 1]) for i in range(0, len(b["ring"]), 2)]) for b in geo["buildings"] if len(b["ring"]) >= 6]
    tree = STRtree(bld)
    out = []
    for w in geo["water"]:
        poly = Polygon([(w["ring"][i], w["ring"][i + 1]) for i in range(0, len(w["ring"]), 2)])
        if poly.area < 15000:
            continue
        edge = poly.buffer(2.5).exterior
        n = int(edge.length // 15)
        for k in range(n):
            p = edge.interpolate((k + 0.5) * edge.length / max(1, n))
            if not in_bbox(p.x, p.y) or len(tree.query(p.buffer(0.8))) and any(bld[int(i)].contains(p) for i in tree.query(p)):
                continue
            nr = roads.nearest(p.x, p.y, 8.0)
            if nr and nr[0] < nr[5] / 2 + 0.5:
                continue
            out.append({"x": r2(p.x), "z": r2(p.y), "height": 1.0, "cct": 3000, "watt": 12,
                        "src": [f"inferred:water-edge:{w['id']}"], "conf": "inferred", "licence": "ODbL"})
    print(f"[lake lights] {len(out)}", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--out", default=None)
    frame.add_area_args(ap)
    args = ap.parse_args()
    frame.apply_area_args(args)
    out_path = frame.resolve_out(args, OUT)
    from fetch import kk_layer

    kk = lambda name: kk_layer(name, refresh=args.refresh)  # noqa: E731
    geo = load_json(ROOT / "data" / "cph-geodata.json")
    roads = RoadIndex(geo["roads"])
    doc = {
        "version": "cph-furniture/1",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "frame": {"epsg": 25832, "origin": list(ORIGIN), "axes": "x=east, z=south, y=up", "bbox": list(area_local())},
        "yaw": "direction the object faces: model +z -> (sin yaw, cos yaw) in (x, z); bays/racks: axis of the row/car",
        "attribution": [
            "Københavns Kommune open data (CC BY 4.0): trae_basis, pullert, affaldskurve, parkeringspladser, parkomater, ask_glascontainer, monumenter, cykelstativ",
            "Citelum / Københavns Kommune, Belysning master + wirer + ledninger (CC BY 4.0)",
            "Movia Stoppestedsudstyr (licence not stated)",
            "KK automatisk detekterede træer (beta), byinventar (licence not stated: confirm with bydata@kk.dk before redistribution)",
        ],
        "licences": {LIC_KK: "Creative Commons Attribution 4.0", LIC_NONE: "dataset has no licence statement; treat as unconfirmed"},
    }
    doc["trees"] = build_trees(kk, geo)
    doc["lamps"] = build_lamps(roads, geo["buildings"], args.refresh)
    doc["parkingBays"] = build_parking(kk, roads)
    simple, extra = build_simple(kk, roads)
    doc.update(simple)
    doc["bikeRacks"] = build_bike_racks(kk, roads)
    doc["busStops"] = build_bus_stops(args.refresh, roads)
    doc["lakeLights"] = build_lake_lights(geo, roads)
    doc["stats"] = {k: len(v) for k, v in doc.items() if isinstance(v, list)}
    doc["stats"]["lamps_wire_with_span"] = sum(1 for l in doc["lamps"] if l.get("span"))
    doc["stats"]["tree_genera"] = dict(Counter(t["genus"] for t in doc["trees"]).most_common())
    doc["stats"]["lamp_light"] = dict(Counter(l["light"] for l in doc["lamps"]))
    out_path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(doc["stats"], ensure_ascii=False, indent=1))
    print(f"wrote {out_path} ({out_path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
