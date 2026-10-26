#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "shapely>=2", "pyproj", "requests"]
# ///
"""Citywide water and green ground (milestone C4 of docs/citywide-plan.md): a post-process of the tile compiler, like far_lod.py and
tile_streets.py. It never edits what build_city.py / city_layers2.py write; it reads the tile `terrain` / `roads` / `buildings` /
`surfaces` layers and the raw OSM + GeoDanmark files and writes

    data/city/water.json            header: water bodies (table), the far-ring water pieces per tile, the Soerne override, the sea level
    data/tiles/<id>/water.json      one `water` layer per tile that has water or green ground:
                                      bodies  clipped surface polygons at their level + the shore walls (polylines with the wall-top
                                              height, quay or bank), flat ponds
                                      cut     ground-mesh cells the water takes out (4 m lattice anchored at -750 like terrain.py lake_cut)
                                      green   park / grass / cemetery / forest polygons clipped to the tile (the ground shader paints grass)
                                      surfaceCuts  surface-register polygons trimmed by the water
    data/city/post.json             registers the layer under `water`  (the engine's tile store reads it at open)
    data/raw/city/water/            the raw GeoDanmark (soe, bassin, rekreativtomraade, begravelsesomraade, skov) and OSM extras (landuse,
                                    waterway) this tool fetches with `--fetch`

Sources (water): GeoDanmark `soe` + `bassin` polygons, OSM natural=water (data/raw/city/osm_water.json), the sea from the OSM coastline
(land on the left of a way; polygonised against the OSM request bbox, so harbour basins and Oeresund come out as water).
Level of a body: the median of the compiled terrain (DTM) over it, 0 m DVR90 (the sea, -6.84 local) when it lies within 0.25 m of that.
Shores: every boundary of the water union is a shore wall. Water at the sea level (the harbour, Sydhavn, Nordhavn, the canals) is quayed
(`q`: granite wall + coping) by default, as the real harbour is, except where OSM says the coast is natural: `s` (sand beach) near
natural=beach / sand / shingle, `b` (grassed bank) near wetland / bare rock / forest / meadow / nature reserve land that no building, pavement
or road touches (Amager Strandpark, Vestamager, Kalvebod Faelled). Fortification moats (OSM water=moat: Stadsgraven, Kastelsgraven, Kastrup Fort)
and every other water use the old rule: `q` where a building, pavement or road lies within QUAY_NEAR_M, `b` elsewhere. The Soerne (parkregister .161 + OSM Peblinge) are NOT generic: they are the district's hand-made
lakes (bridge strip split at Dronning Louises Bro, basins, hero bridge, swans) and ship as `override` in the same format as data/cph-lakes.json,
unclipped to the city; the generic layer leaves them out of the surfaces, walls and far water but they cut the ground.

    uv run tools/cph-geodata/city_water.py --fetch      # network: GeoDanmark + OSM extras into data/raw/city/water/ (once)
    uv run tools/cph-geodata/city_water.py              # build water.json + the tile layers + post.json
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree, contains_xy
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.geometry.polygon import orient
from shapely.ops import polygonize, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "city"
RAW_WATER = RAW / "water"
VERSION = "cph-water/1"
SEA = -6.84  # DVR90 0 m in the local frame (origin height 6.84)
SEA_SNAP_M = 0.6  # a body whose terrain median is this close to the sea is at the sea (the DTM over harbour basins wobbles by a few dm)
POND_MAX_M2 = 1500.0  # smaller water is a fountain / pool: flat water, no walls, no ground cut (lakes.py POND_MAX_M2)
MIN_WATER_M2 = 20.0
CUT_CELL = 4.0  # the ground lattice (terrain.py MESH_CELL) anchored at -MESH_HALF
CUT_HALF = 750.0
WALL_STEP = 8.0  # m, densified shore (js/lakes-cph.js WATER.wallStep)
SHORE_PROBE = 2.0  # m: land-side probe distance for the quay height
WALL_TOP = 0.08
MIN_FREEBOARD = 0.3
QUAY_NEAR_M = 9.0  # developed shore: a building / pavement / road this close
FAR_TOL_M = 2.0  # far-ring water pieces: Douglas-Peucker tolerance
GREEN_TOL_M = 1.0
MIN_GREEN_M2 = 40.0
MIN_CUT_M2 = 2.0  # overlaps smaller than this are ignored (lakes.py MIN_CUT_M2)
DECK_ABOVE_M = 1.0  # a surface whose terrain over the water stands this far above it is a bridge deck
SOERNE_NAMES = ("Søerne", "Peblinge", "Sortedam", "Sankt Jørgens", "Sankt Jorgens")
SOERNE_REGISTER_PREFIX = "kk:parkregister:parkregister.161"
GDK_TYPES = ("soe", "bassin", "rekreativtomraade", "begravelsesomraade", "skov", "kyst", "havn")  # kyst / havn: the coast lines
OSM_EXTRA = ('[out:json][timeout:240][bbox:55.58,12.43,55.74,12.74];('
             'way["landuse"~"^(grass|cemetery|village_green|recreation_ground|meadow|allotments|forest)$"];'
             'relation["landuse"~"^(grass|cemetery|village_green|recreation_ground|meadow|allotments|forest)$"];'
             'way["natural"~"^(grassland|wood|scrub|heath)$"];relation["natural"~"^(grassland|wood|scrub|heath)$"];'
             'way["leisure"~"^(common|golf_course|nature_reserve)$"];relation["leisure"~"^(common|golf_course|nature_reserve)$"];'
             'way["waterway"~"^(river|canal|stream)$"];);out geom tags;')
OSM_SHORE = ('[out:json][timeout:180][bbox:55.58,12.43,55.74,12.74];(way["natural"~"^(beach|shingle|sand|bare_rock|wetland|shoal)$"];'
             'relation["natural"~"^(beach|shingle|sand|wetland)$"];way["man_made"~"^(quay|pier|breakwater|groyne|dyke|embankment)$"];'
             'way["waterway"="dock"];way["leisure"~"^(bathing_place|marina|slipway)$"];node["leisure"="bathing_place"];node["name"~"Strand$"];);out geom tags;')
HAVN_NEAR_M = 20.0  # GeoDanmark `havn` line (harbour coast: quay, jetty) this close: quay
KYST_NEAR_M = 20.0  # GeoDanmark `kyst` line (open coast) this close: natural coast
BEACH_NODE_M = 350.0  # a natural coast this close to a bathing place / "... Strand" node (OSM) is a beach
SAND_NATURAL = ("beach", "sand", "shingle")  # a shore near these is a beach
NATURE_NATURAL = ("wetland", "bare_rock", "grassland", "scrub", "heath", "wood")  # a shore near these (and not developed) is a natural bank
NATURE_LANDUSE = ("forest", "meadow")
NATURE_LEISURE = ("nature_reserve",)
HARBOUR_MIN_M2 = 40000.0  # a sea-level body this big is harbour
NATURAL_NEAR_M = 30.0  # a shore vertex this close to natural land is natural coast
MOAT_NAME = ("stadsgrav", "kastelsgrav", "voldgrav")
CITY_UTM_BBOX = (716400.0, 6168400.0, 735100.0, 6182600.0)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def read_json(path: Path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------------------------------------------------- fetch

def _secret(name: str, secret: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        out = subprocess.run([str(ROOT / "tools" / "adc-secret.sh"), secret], capture_output=True, text=True)
        if out.returncode != 0 or not out.stdout.strip():
            raise SystemExit(f"secret {secret} not available (tools/adc-secret.sh)")
        v = out.stdout.strip()
        os.environ[name] = v
    return v


def fetch_shore(force: bool = False) -> None:
    """OSM shore evidence (beaches, sand, wetland, piers, breakwaters, marinas) into data/raw/city/water/osm_shore.json (small)."""
    import city_sources as S

    path = RAW_WATER / "osm_shore.json"
    if path.exists() and not force:
        return
    RAW_WATER.mkdir(parents=True, exist_ok=True)
    for url in S.OVERPASS:
        r = S.request("POST", url, what="overpass", data={"data": OSM_SHORE}, tries=4)
        if r.status_code == 200:
            S.atomic_write(path, json.dumps(r.json(), ensure_ascii=False, separators=(",", ":")))
            log(f"[fetch] osm shore evidence: {len(r.json().get('elements', []))} elements")
            return
    raise SystemExit("overpass unavailable")


def fetch(force: bool = False) -> None:
    """GeoDanmark (Datafordeler GEODKV WFS) soe / bassin / rekreativtomraade / begravelsesomraade / skov for the city bbox and the OSM
    extras (landuse, waterway) into data/raw/city/water/. Credentials come from tools/adc-secret.sh and are never printed."""
    import city_sources as S

    RAW_WATER.mkdir(parents=True, exist_ok=True)
    user, pw = _secret("DATAFORDELER_USERNAME", "datafordeler-username"), _secret("DATAFORDELER_PASSWORD", "datafordeler-password")
    x0, y0, x1, y1 = CITY_UTM_BBOX
    for t in GDK_TYPES:
        path = RAW_WATER / f"gdk_{t}.json"
        if path.exists() and not force:
            continue
        feats, seen, start, page = [], set(), 0, 5000
        while True:
            r = S.request("GET", S.GEODKV, what=f"geodk:{t}@{start}", params={
                "username": user, "password": pw, "service": "WFS", "version": "2.0.0", "request": "GetFeature",
                "typeNames": f"geodkv_v001:{t}_current", "outputFormat": "application/json", "count": page, "startIndex": start,
                "bbox": f"{x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::25832"})
            r.raise_for_status()
            got = r.json().get("features", [])
            for f in got:
                p = f["properties"]
                fid = p.get("id_lokalId")
                if fid in seen:
                    continue
                seen.add(fid)
                keep = {k: p.get(k) for k in ("id_lokalId", "soetype", "bassintype", "anvendelse", "havnetype") if p.get(k) is not None}
                feats.append({"type": "Feature", "geometry": f["geometry"], "properties": keep})
            if len(got) < page:
                break
            start += page
        S.atomic_write(path, json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))
        log(f"[fetch] gdk {t}: {len(feats)} features")
    fetch_shore(force)
    path = RAW_WATER / "osm_extra.json"
    if force or not path.exists():
        doc = None
        for url in S.OVERPASS:
            r = S.request("POST", url, what="overpass", data={"data": OSM_EXTRA}, tries=4)
            if r.status_code == 200:
                doc = r.json()
                break
        if doc is None:
            raise SystemExit("overpass unavailable")
        S.atomic_write(path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        log(f"[fetch] osm extras: {len(doc.get('elements', []))} elements")


# ------------------------------------------------------------------------------------------------------------ loading

_T = None


def _to_local_xy(lon: float, lat: float):
    """WGS84 -> map plane (x east, y north) in the local frame (y = -z)."""
    global _T
    if _T is None:
        from pyproj import Transformer

        _T = Transformer.from_crs(4326, 25832, always_xy=True)
    e, n = _T.transform(lon, lat)
    return e - frame.ORIGIN[0], n - frame.ORIGIN[1]


def _geom_pts(g):
    return [_to_local_xy(p["lon"], p["lat"]) for p in g]


def osm_geoms(elements, keep):
    """[(src id, tags, shapely geometry in the local map plane)] for closed ways and multipolygon relations accepted by keep(tags)."""
    out = []
    for el in elements:
        t = el.get("tags", {})
        if not keep(t):
            continue
        try:
            if el["type"] == "way" and el.get("geometry") and len(el["geometry"]) >= 4:
                pts = _geom_pts(el["geometry"])
                if pts[0] == pts[-1]:
                    out.append((f"osm:way/{el['id']}", t, Polygon(pts).buffer(0)))
            elif el["type"] == "relation":
                outer = [LineString(_geom_pts(m["geometry"])) for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
                inner = [LineString(_geom_pts(m["geometry"])) for m in el.get("members", []) if m.get("role") == "inner" and m.get("geometry")]
                if outer:
                    o = unary_union(list(polygonize(unary_union(outer))))
                    if inner:
                        i = unary_union(list(polygonize(unary_union(inner))))
                        o = o.difference(i)
                    if not o.is_empty:
                        out.append((f"osm:relation/{el['id']}", t, o))
        except Exception:  # noqa: BLE001
            continue
    return out


def gdk_geoms(path: Path, props=("soetype", "bassintype", "anvendelse")):
    doc = read_json(path)
    out = []
    if not doc:
        return out
    for f in doc.get("features", []):
        try:
            g = shape(f["geometry"])
            g = shapely.force_2d(g)
            g = shapely.transform(g, lambda a: np.column_stack([a[:, 0] - frame.ORIGIN[0], a[:, 1] - frame.ORIGIN[1]]))
            g = g.buffer(0)
            if not g.is_empty:
                out.append((f"gdk:{path.stem[4:]}/{f['properties'].get('id_lokalId')}", f["properties"], g))
        except Exception:  # noqa: BLE001
            continue
    return out


def polys(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    return [p for x in getattr(g, "geoms", []) for p in polys(x)]


# ---------------------------------------------------------------------------------------------------------------- DTM

class Dtm:
    """The compiled terrain (data/tiles/<id>/terrain.json chunks, 2 m cells, int16 cm) pasted into one raster over the city frame."""

    def __init__(self, tiles_dir: Path, header: dict):
        self.x0, self.z0 = header["bbox"][0], header["bbox"][1]
        self.cell = header["cell"]
        self.w, self.h = header["width"], header["height"]
        self.grid = np.full((self.h, self.w), np.nan, dtype=np.float32)
        self.tiles = 0
        for p in sorted(tiles_dir.glob("*/terrain.json")):
            d = read_json(p)
            c = (d or {}).get("chunk")
            if not c:
                continue
            a = np.frombuffer(base64.b64decode(c["data"]), dtype="<i2").reshape(c["h"], c["w"]).astype(np.float32) / 100.0
            i0 = round((c["x0"] - self.x0) / self.cell)
            j0 = round((c["z0"] - self.z0) / self.cell)
            self.grid[j0:j0 + c["h"], i0:i0 + c["w"]] = a
            self.tiles += 1

    def at(self, x, z):
        """Nearest cell value (NaN outside the compiled tiles). x, z arrays or scalars (local frame, z south)."""
        i = np.floor((np.asarray(x, dtype=float) - self.x0) / self.cell).astype(int)
        j = np.floor((np.asarray(z, dtype=float) - self.z0) / self.cell).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < self.w) & (j < self.h)
        out = np.full(np.shape(i), np.nan, dtype=float)
        out[ok] = self.grid[j[ok], i[ok]]
        return out

    def median_in(self, poly):
        """Median terrain over a polygon (x / z coordinates) sampled at the cell size; None when nothing is covered."""
        inner = poly.buffer(-1.0)
        use = inner if not inner.is_empty else poly
        x0, z0, x1, z1 = use.bounds
        step = self.cell
        n = max(1.0, ((x1 - x0) / step) * ((z1 - z0) / step))
        if n > 3_000_000:  # a huge polygon: a coarser sample is as good for a median
            step *= math.sqrt(n / 3_000_000)
        xs = np.arange(x0 + step / 2, x1, step)
        zs = np.arange(z0 + step / 2, z1, step)
        v = np.array([])
        if len(xs) and len(zs):
            xx, zz = np.meshgrid(xs, zs)
            m = contains_xy(use, xx, zz)
            if m.any():
                v = self.at(xx[m], zz[m])
                v = v[~np.isnan(v)]
        if not len(v):
            c = use.representative_point()
            r = self.at(c.x, c.y)
            return None if np.isnan(r) else float(r)
        return float(np.median(v))


# ------------------------------------------------------------------------------------------------------- orientation

def to_xz(g):
    """Map plane (x east, y north; what the loaders return) -> render plane (x east, z south): the same shape mirrored (z = -y)."""
    return shapely.transform(g, lambda a: np.column_stack([a[:, 0], -a[:, 1]]))


def ring_flat(pts, nd=2, ccw_from_above=True):
    """Open flat [x, z, ...] ring. `ccw_from_above` (the geodata convention for exteriors) = negative shoelace in x / z; holes the other way."""
    pts = list(pts)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    if (area < 0) != ccw_from_above:
        pts.reverse()
    out = []
    for x, z in pts:
        out += [round(x, nd) + 0.0, round(z, nd) + 0.0]
    return out


def poly_rec(p, nd=2):
    """{ring, holes?} of a render-plane polygon: exterior counter-clockwise seen from above, holes the other way."""
    rec = {"ring": ring_flat(p.exterior.coords, nd, True)}
    holes = [ring_flat(h.coords, nd, False) for h in p.interiors]
    holes = [h for h in holes if len(h) >= 6]
    if holes:
        rec["holes"] = holes
    return rec


# ------------------------------------------------------------------------------------------------------------ the sea

def osm_bbox_quad():
    return [_to_local_xy(lon, lat) for lat, lon in ((55.58, 12.43), (55.58, 12.74), (55.74, 12.74), (55.74, 12.43))]


def sea_polygon(coast_elements):
    """The sea (map plane) from the OSM coastline. Ways are cut at the request bbox, so they are polygonised together with the bbox
    quadrilateral and a face is sea when the coast lines on its boundary have it on their right (OSM: land on the left of the way)."""
    lines = [LineString(_geom_pts(el["geometry"])) for el in coast_elements if el.get("geometry") and len(el["geometry"]) >= 2]
    quad = osm_bbox_quad()
    faces = list(polygonize(unary_union(lines + [LineString(quad + [quad[0]])])))
    return sea_faces(lines, faces)


def sea_faces(lines, faces):
    segs = []
    for ln in lines:
        c = list(ln.coords)
        segs += list(zip(c[:-1], c[1:]))
    seg_geoms = [LineString(s) for s in segs]
    tree = STRtree(seg_geoms)
    sea = []
    for f in faces:
        left = right = 0.0
        for idx in tree.query(f.boundary.buffer(0.05)):
            (ax, ay), (bx, by) = segs[idx]
            L = math.hypot(bx - ax, by - ay)
            if L < 1e-6:
                continue
            mx, my = (ax + bx) / 2, (ay + by) / 2
            nx, ny = -(by - ay) / L, (bx - ax) / L  # left normal in the map plane
            on_left = f.contains(Point(mx + nx * 0.3, my + ny * 0.3))
            on_right = f.contains(Point(mx - nx * 0.3, my - ny * 0.3))
            if on_left and not on_right:
                left += L
            elif on_right and not on_left:
                right += L
        if right > left:
            sea.append(f)
    return unary_union(sea) if sea else None


# ----------------------------------------------------------------------------------------------------------- geometry

def densify(coords, step):
    pts = [tuple(coords[0])]
    for a, b in zip(coords[:-1], coords[1:]):
        n = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        for k in range(1, n + 1):
            pts.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    return pts


def tile_box(tid):
    return frame.tile_bounds_local(tid)


def lattice_cut(water, tile_ids):
    """Ground-lattice cells (4 m, anchored at -750 like terrain.py lake_cut) the water takes out, per tile (a cell belongs to the tile its
    centre lies in): `skip` [i, j] cells fully inside water, `pieces` [i, j, flat ring] the part of a touched cell outside it."""
    out = {}
    if water is None or water.is_empty:
        return out
    shapely.prepare(water)
    for tid in tile_ids:
        x0, z0, x1, z1 = tile_box(tid)
        wb = water.intersection(box(x0 - CUT_CELL, z0 - CUT_CELL, x1 + CUT_CELL, z1 + CUT_CELL))
        if wb.is_empty:
            continue
        i0 = math.ceil((x0 + CUT_HALF) / CUT_CELL - 0.5 - 1e-9)
        j0 = math.ceil((z0 + CUT_HALF) / CUT_CELL - 0.5 - 1e-9)
        i1 = math.floor((x1 + CUT_HALF) / CUT_CELL - 0.5 - 1e-9)
        j1 = math.floor((z1 + CUT_HALF) / CUT_CELL - 0.5 - 1e-9)
        # cells whose centre (-750 + (i + 0.5) * 4) lies inside the tile
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        ii, jj = ii.ravel(), jj.ravel()
        if not len(ii):
            continue
        cx = -CUT_HALF + ii * CUT_CELL
        cz = -CUT_HALF + jj * CUT_CELL
        boxes = shapely.box(cx, cz, cx + CUT_CELL, cz + CUT_CELL)
        shapely.prepare(wb)
        touch = shapely.intersects(wb, boxes)
        skip, pieces = [], []
        for i, j, b in zip(ii[touch], jj[touch], boxes[touch]):
            rest = b.difference(wb)
            if rest.is_empty or rest.area < 0.02:
                skip.append([int(i), int(j)])
                continue
            for g in polys(rest):
                if g.area >= 0.02:
                    pieces.append([int(i), int(j), ring_flat(g.exterior.coords, 2, True)])
        if skip or pieces:
            out[tid] = {"cell": CUT_CELL, "half": CUT_HALF, "keyed": True, "skip": rle_cells(skip), "pieces": pieces}
    return out


def rle_cells(cells):
    """[[i, j], ...] -> [[j, i0, n], ...]: runs of consecutive i along a row (a tile of open sea is one run per row)."""
    runs = []
    for i, j in sorted(cells, key=lambda c: (c[1], c[0])):
        if runs and runs[-1][0] == j and runs[-1][1] + runs[-1][2] == i:
            runs[-1][2] += 1
        else:
            runs.append([j, i, 1])
    return runs


def wall_tops(points, level, water, dtm, probe=SHORE_PROBE):
    """Height of the quay top at shore vertices (`points` an (n, 2) array in x / z): the median terrain on the land side (8 probes at
    `probe` metres; the DTM right at the outline is partly water or bed) plus the coping, never lower than MIN_FREEBOARD over the water
    (js/lakes-cph.js shoreTop). `level` is the water level per vertex."""
    pts = np.asarray(points, dtype=float)
    ang = np.arange(8) * math.pi / 4
    px = pts[:, 0:1] + np.cos(ang)[None, :] * probe
    pz = pts[:, 1:2] + np.sin(ang)[None, :] * probe
    wet = contains_xy(water, px, pz)
    h = dtm.at(px, pz)
    h = np.where(wet | np.isnan(h), np.nan, h)
    import warnings

    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore")
        ground = np.nanmedian(h, axis=1)
    lvl = np.asarray(level, dtype=float)
    ground = np.where(np.isnan(ground), lvl + 0.8, ground)
    return np.maximum(ground + WALL_TOP, lvl + MIN_FREEBOARD)


def smooth_flags(flags, passes=1):
    """Majority filter over a closed or open run of booleans (isolated flips of one vertex are noise)."""
    f = list(flags)
    for _ in range(passes):
        g = f[:]
        for i in range(1, len(f) - 1):
            if f[i - 1] == f[i + 1] != f[i]:
                g[i] = f[i - 1]
        f = g
    return f


def natural_shore_geoms():
    """(sand, nature): shapely geometries (x / z) of the OSM beaches and of the natural land (wetland, bare rock, scrub, forest, meadow,
    nature reserve; GeoDanmark skov) that make a harbour shore natural coast. Open ways (a beach drawn as a line) become lines."""
    sand, nature = [], []
    for el in (read_json(RAW_WATER / "osm_shore.json") or {}).get("elements", []):
        t = el.get("tags", {})
        if t.get("natural") in SAND_NATURAL + ("wetland", "bare_rock"):
            (sand if t.get("natural") in SAND_NATURAL else nature).append(el)
    sand_g, nature_g = [], []
    for els, out in ((sand, sand_g), (nature, nature_g)):
        for i, t, g in osm_geoms(els, lambda t: True):
            out.append(to_xz(g))
        for el in els:
            if el["type"] == "way" and el.get("geometry") and len(el["geometry"]) >= 2:
                pts = _geom_pts(el["geometry"])
                if pts[0] != pts[-1]:
                    out.append(to_xz(LineString(pts)).buffer(3.0))
    extra = (read_json(RAW_WATER / "osm_extra.json") or {}).get("elements", [])
    nat = lambda t: (t.get("natural") in NATURE_NATURAL or t.get("landuse") in NATURE_LANDUSE or t.get("leisure") in NATURE_LEISURE)  # noqa: E731
    nature_g += [to_xz(g) for _, _, g in osm_geoms([e for e in extra if "waterway" not in e.get("tags", {})], nat)]
    nature_g += [to_xz(g) for _, _, g in gdk_geoms(RAW_WATER / "gdk_skov.json")]
    return [g for g in sand_g if not g.is_empty], [g for g in nature_g if not g.is_empty]


def gdk_lines(name):
    """GeoDanmark coast lines (`kyst`: open coast, `havn`: harbour coast and landing jetties) in x / z (lines are not made valid, buffer(0) would empty them)."""
    doc = read_json(RAW_WATER / f"gdk_{name}.json")
    out = []
    for f in (doc or {}).get("features", []):
        try:
            g = shapely.force_2d(shape(f["geometry"]))
            g = shapely.transform(g, lambda a: np.column_stack([a[:, 0] - frame.ORIGIN[0], -(a[:, 1] - frame.ORIGIN[1])]))
            if not g.is_empty:
                out.append(g)
        except Exception:  # noqa: BLE001
            continue
    return out


def beach_nodes():
    """Points (x / z) of OSM bathing places and "... Strand" name nodes (Amager Strandpark, Hellerup Strand)."""
    out = []
    for el in (read_json(RAW_WATER / "osm_shore.json") or {}).get("elements", []):
        t = el.get("tags", {})
        if el["type"] == "node" and (t.get("leisure") == "bathing_place" or (set(t) <= {"name", "source"} and (t.get("name") or "").endswith("Strand"))):
            x, y = _to_local_xy(el["lon"], el["lat"])
            out.append(Point(x, -y))
    return out


def near_flags(V, geoms, dist):
    """Boolean per shore vertex: some geometry of `geoms` lies within `dist` metres."""
    out = np.zeros(len(V), dtype=bool)
    if geoms and len(V):
        tree = STRtree(geoms)
        hit = tree.query(shapely.buffer(shapely.points(V), dist), predicate="intersects")
        out[np.unique(hit[0])] = True
    return out


def developed_geoms(ids_needed, tiles_dir: Path):
    """Footprints, pavements and road corridors of the given tiles as shapely geometries (x / z): what makes a shore a quay."""
    out = []
    for tid in sorted(ids_needed):
        b = read_json(tiles_dir / tid / "buildings.json")
        for bd in (b or {}).get("buildings", []):
            r = bd.get("ring") or []
            if len(r) >= 6:
                out.append(Polygon([(r[i], r[i + 1]) for i in range(0, len(r) - 1, 2)]))
        d = read_json(tiles_dir / tid / "roads.json")
        for sd in (d or {}).get("sidewalks", []):
            r = sd.get("ring") or []
            if len(r) >= 6:
                out.append(Polygon([(r[i], r[i + 1]) for i in range(0, len(r) - 1, 2)]))
        for rd in (d or {}).get("roads", []):
            q = rd.get("pts") or []
            if len(q) >= 4:
                out.append(LineString([(q[i], q[i + 1]) for i in range(0, len(q) - 1, 2)]).buffer(max(1.5, (rd.get("width") or 6.0) / 2)))
    out = [g for g in out if g.is_valid and not g.is_empty]
    return out


def neighbours(tid: str, exists):
    ie, in_ = frame.parse_tile_id(tid)
    return [t for a in (-1, 0, 1) for b in (-1, 0, 1) if (t := frame.tile_id(ie + a, in_ + b)) and exists(t)]


def clean_union(geoms, grow=0.2):
    """Union of polygons that touch or nearly touch (a harbour basin against the sea): closed over sub-grow gaps."""
    gs = [g for g in geoms if g is not None and not g.is_empty]
    if not gs:
        return Polygon()
    u = unary_union([g.buffer(grow) for g in gs]).buffer(-grow)
    return u


def drop_small_holes(p, min_area=30.0):
    if p.geom_type != "Polygon":
        return p
    return Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area >= min_area])


def classify_kind(tags_list, sea, area):
    if sea:
        return "sea"
    for t in tags_list:
        w = (t or {}).get("water")
        if w in ("canal", "harbour", "moat", "basin", "lock", "river", "reservoir", "lake", "pond"):
            return w
    return "lake"


# ----------------------------------------------------------------------------------------------------- Soerne override

def soerne_override(dtm: Dtm):
    """The district's hand-made lakes, unclipped to the city: lakes.py on the full OSM + parkregister water (the closing merges Peblinge and
    Sortedams Soe over the Dronning Louises Bro strip), keeping the lakes the KK register calls Soerne, their bridge strips, the basins
    (the part of a lake outside the strips, each with its own measured level) and the levels / deck heights the terrain header would
    carry. Same format as data/cph-lakes.json (+ `terrain`)."""
    import lakes as LK
    import points as P

    frame.set_area(CITY_UTM_BBOX)
    wp = read_json(RAW / "osm_water_parks.json")
    geo = {"water": P.water(wp), "parks": P.parks(read_json(RAW / "kk_parkregister.json"), read_json(RAW / "kk_park_groent_omr_oversigtskort.json"), wp)}
    full = LK.build_lakes(geo, None)
    keep = [lk for lk in full["lakes"] if "kk:parkregister" in lk.get("src", []) or any(n in lk.get("name", "") for n in SOERNE_NAMES)]
    ids = {}
    lakes = []
    for k, lk in enumerate(sorted(keep, key=lambda l: -l["area_m2"])):
        ids[lk["id"]] = f"soerne:{k}"
        lakes.append({**lk, "id": ids[lk["id"]]})

    def poly(ring, holes=()):
        pts = lambda r: [(r[i], r[i + 1]) for i in range(0, len(r), 2)]  # noqa: E731
        return Polygon(pts(ring), [pts(h) for h in holes if len(h) >= 6]).buffer(0)

    lake_polys = [poly(l["ring"], l.get("holes", [])) for l in lakes]
    near = unary_union(lake_polys).buffer(1.0)
    bridges = []
    for b in full["bridges"]:
        if poly(b["ring"]).intersects(near):
            bridges.append({**b, "id": f"soerne-bridge:{len(bridges)}"})
    strip_union = unary_union([poly(b["ring"]).buffer(LK_STRIP_BUFFER) for b in bridges]) if bridges else None
    basins = []
    for lk, p in zip(lakes, lake_polys):
        parts = [p]
        if strip_union is not None and p.intersects(strip_union):
            diff = p.difference(strip_union)
            parts = [g for g in polys(diff) if g.area >= MIN_BASIN_M2]
        for k, g in enumerate(sorted(parts, key=lambda q: -q.area)):
            lvl = dtm.median_in(g)
            rec = {"id": f"{lk['id']}/{k}", "lake": lk["id"], "level": round(lvl if lvl is not None else SEA, 2), "area_m2": round(g.area, 1),
                   "ring": [round(v, 2) + 0.0 for xy in list(g.exterior.coords)[:-1] for v in xy]}
            holes = [[round(v, 2) + 0.0 for xy in list(h.coords)[:-1] for v in xy] for h in g.interiors if Polygon(h).area >= 5]
            if holes:
                rec["holes"] = holes
            basins.append(rec)
    levels, decks = [], []
    for lk, p in zip(lakes, lake_polys):
        v = dtm.median_in(p)
        levels.append({"id": lk["id"], "level": round(v if v is not None else SEA, 2)})
    for b in bridges:
        v = dtm.median_in(poly(b["ring"]))
        decks.append({"id": b["id"], "deck": round(v if v is not None else SEA, 2)})
    doc = {"version": "cph-lakes/1", "method": full["method"] + "; the lakes the KK register calls Soerne, unclipped (tools/cph-geodata/city_water.py)",
           "lakes": lakes, "bridges": bridges, "ponds": [], "surface_cuts": [], "basins": basins,
           "terrain": {"lakes": levels, "ponds": [], "bridges": decks}}
    return doc, unary_union(lake_polys)


LK_STRIP_BUFFER = 0.3  # basins.py STRIP_BUFFER_M
MIN_BASIN_M2 = 400.0  # basins.py MIN_BASIN_M2


# ------------------------------------------------------------------------------------------------------------- build

def green_geoms(tiles_dir: Path, ids):
    """Park / grass / cemetery / forest polygons (x / z): the tiles' own `parks` (KK register + OSM park / garden, the layer the far ring
    uses) plus GeoDanmark rekreativtomraade / begravelsesomraade / skov and the OSM landuse extras."""
    out = []
    for tid in ids:
        d = read_json(tiles_dir / tid / "roads.json")
        for pk in (d or {}).get("parks", []):
            if str(pk.get("id", "")).startswith(SOERNE_REGISTER_PREFIX):
                continue  # the Soerne water, not park
            r = pk.get("ring") or []
            if len(r) >= 6:
                try:
                    g = Polygon([(r[i], r[i + 1]) for i in range(0, len(r) - 1, 2)], [[(h[i], h[i + 1]) for i in range(0, len(h) - 1, 2)] for h in pk.get("holes", []) if len(h) >= 6]).buffer(0)
                    if not g.is_empty:
                        out.append(g)
                except Exception:  # noqa: BLE001
                    pass
    for n in ("rekreativtomraade", "begravelsesomraade", "skov"):
        out += [to_xz(g) for _, _, g in gdk_geoms(RAW_WATER / f"gdk_{n}.json")]
    extra = (read_json(RAW_WATER / "osm_extra.json") or {}).get("elements", [])
    out += [to_xz(g) for _, _, g in osm_geoms([e for e in extra if "waterway" not in e.get("tags", {})], lambda t: True)]
    return [g for g in out if not g.is_empty]


def build(args) -> int:
    t0 = time.time()
    tiles_dir, city_dir = Path(args.tiles), Path(args.city)
    index = read_json(tiles_dir / "index.json")
    ids = sorted(index["tiles"])
    idset = set(ids)
    meta = read_json(city_dir / "meta.json")
    dtm = Dtm(tiles_dir, meta["terrain"])
    log(f"terrain: {dtm.tiles} tile chunks")
    area = unary_union([box(*tile_box(t)) for t in ids])
    window = area.buffer(400.0)
    tile_geoms = [box(*tile_box(t)) for t in ids]
    tile_tree = STRtree(tile_geoms)

    # ---- sources
    osm_w = [(i, t, to_xz(g)) for i, t, g in osm_geoms(read_json(RAW / "osm_water.json")["elements"], lambda t: t.get("natural") == "water")]
    gdk = []
    for n in ("soe", "bassin"):
        gdk += [(i, t, to_xz(g)) for i, t, g in gdk_geoms(RAW_WATER / f"gdk_{n}.json")]
    sea_map = sea_polygon(read_json(RAW / "osm_coastline.json")["elements"])
    sea = to_xz(sea_map).intersection(window) if sea_map is not None else Polygon()
    log(f"sources: {len(osm_w)} OSM water, {len(gdk)} GeoDanmark soe/bassin, sea {sea.area / 1e6:.1f} km2")

    ovr_doc, ovr_union = soerne_override(dtm)
    ovr_zone = ovr_union.buffer(5.0)
    log(f"Soerne override: {[(l['id'], l['area_m2']) for l in ovr_doc['lakes']]}, {len(ovr_doc['bridges'])} strips, basins {[(b['id'], b['level']) for b in ovr_doc['basins']]}")

    def mostly_in(g, zone, frac):
        return g.area > 0 and g.intersection(zone).area > frac * g.area

    gdk_union = unary_union([g for _, _, g in gdk]) if gdk else Polygon()
    srcs = [(i, t, g) for i, t, g in gdk if not mostly_in(g, ovr_zone, 0.4)]
    srcs += [(i, t, g) for i, t, g in osm_w if not mostly_in(g, ovr_zone, 0.4) and not (not gdk_union.is_empty and mostly_in(g, gdk_union, 0.5))]
    gen = clean_union([g for _, _, g in srcs] + ([sea] if not sea.is_empty else [])).intersection(window)
    gen = gen.difference(ovr_union.buffer(1.0))
    parts = [drop_small_holes(p) for p in polys(gen) if p.area >= MIN_WATER_M2]
    parts.sort(key=lambda p: -p.area)
    log(f"generic water: {len(parts)} bodies, {sum(p.area for p in parts) / 1e6:.2f} km2")

    # ---- bodies: level, kind, name
    src_tree = STRtree([g for _, _, g in srcs])
    name_src = osm_w  # names come from every OSM polygon, also those a GeoDanmark polygon replaced as the geometry
    sea_prep = sea
    shapely.prepare(sea_prep)
    bodies = []
    for k, p in enumerate(parts):
        is_sea = bool(not sea.is_empty and sea_prep.intersects(p))
        hits = [srcs[j] for j in src_tree.query(p, predicate="intersects")]
        named = sorted(((s[2].intersection(p).area, s[1].get("name", "")) for s in name_src if s[1].get("name") and s[2].intersects(p)), reverse=True)
        lvl = SEA if is_sea else dtm.median_in(p)
        if lvl is None:
            lvl = SEA
        if abs(lvl - SEA) < SEA_SNAP_M:
            lvl = SEA
        moat = any((t.get("water") == "moat" or any(m in (t.get("name") or "").lower() for m in MOAT_NAME)) and g.intersection(p).area > 0.3 * g.area
                   for _, t, g in osm_w if g.intersects(p))
        pond = p.area < POND_MAX_M2 and not is_sea
        kind = "pond" if pond else classify_kind([s[1] for s in hits], is_sea, p.area)
        bodies.append({"id": f"w:{k}", "poly": p, "level": round(float(lvl), 2), "pond": pond, "kind": kind, "name": named[0][1] if named else "", "sea": is_sea, "moat": moat})
    lakes_b = [b for b in bodies if not b["pond"]]
    cut_water = unary_union([b["poly"] for b in lakes_b] + [ovr_union])
    all_water = unary_union([cut_water] + [b["poly"] for b in bodies if b["pond"]])
    shapely.prepare(all_water)

    # ---- shores
    quad = Polygon([(x, -y) for x, y in osm_bbox_quad()])
    edge_zone = unary_union([window.boundary, quad.boundary]).buffer(1.0)
    shapely.prepare(edge_zone)
    V, LV = [], []  # shore vertices (x, z) and the water level at each
    rings = []  # (body, start, end)
    for b in lakes_b:
        pp = orient(b["poly"], 1.0)  # exterior counter-clockwise in (x, z): the water is on the LEFT of travel on every ring
        for r in [pp.exterior, *pp.interiors]:
            pts = densify(list(r.coords), WALL_STEP)
            if len(pts) < 3:
                continue
            rings.append((b, len(V), len(V) + len(pts)))
            V += pts
            LV += [b["level"]] * len(pts)
    V = np.array(V, dtype=float).reshape(-1, 2)
    LV = np.array(LV, dtype=float)
    log(f"shore: {len(rings)} rings, {len(V)} vertices")
    tops = wall_tops(V, LV, all_water, dtm) if len(V) else np.zeros(0)
    owners = [frame.tile_of_local(float(x), float(z)) for x, z in V]
    need = set()
    for t in set(owners):
        if t in idset:
            need.update(neighbours(t, idset.__contains__))
    dev_geoms = developed_geoms(need, tiles_dir)
    log(f"developed: {len(dev_geoms)} footprints / pavements / road corridors near the shores")
    dev = np.zeros(len(V), dtype=bool)
    if dev_geoms and len(V):
        tree = STRtree(dev_geoms)
        buf = shapely.buffer(shapely.points(V), QUAY_NEAR_M)
        hit = tree.query(buf, predicate="intersects")
        dev[np.unique(hit[0])] = True

    sand_g, nature_g = natural_shore_geoms()
    near_sand = near_flags(V, sand_g, NATURAL_NEAR_M)
    near_nature = near_flags(V, nature_g, NATURAL_NEAR_M)
    log(f"natural shore evidence: {len(sand_g)} beach / sand, {len(nature_g)} natural land polygons; vertices near sand {int(near_sand.sum())}, near nature {int(near_nature.sum())}")

    havn_g, kyst_g = gdk_lines("havn"), gdk_lines("kyst")
    near_havn = near_flags(V, havn_g, HAVN_NEAR_M)
    near_kyst = near_flags(V, kyst_g, KYST_NEAR_M) & ~near_havn
    near_beach_node = near_flags(V, beach_nodes(), BEACH_NODE_M)
    log(f"GeoDanmark coast: {len(havn_g)} havn lines (vertices near {int(near_havn.sum())}), {len(kyst_g)} kyst lines (vertices near {int(near_kyst.sum())})")

    def harbour(b):
        # the sea-level harbour and its canals and docks: quayed unless the coast is natural. Small sea-level lakes (Oerestad's park lakes)
        # and moats keep the developed / not developed rule
        return (abs(b["level"] - SEA) < 0.05 and not b["moat"]
                and (b["sea"] or b["poly"].area >= HARBOUR_MIN_M2 or b["kind"] in ("canal", "harbour", "basin") or any(k in b["name"].lower() for k in ("kanal", "havn", "brygge"))))

    walls = {}  # body id -> tile id -> [runs]
    shore_m = {"q": 0.0, "b": 0.0, "s": 0.0}
    for b, s, e in rings:
        flags = smooth_flags(list(dev[s:e]), 2)
        if harbour(b):
            # GeoDanmark `havn` (harbour coast) is quay; `kyst` (open coast) is natural: sand near a beach, else a grassed bank; shores no
            # GeoDanmark line covers (inner canals, docks) are quay unless OSM puts beach / natural land right there
            sandf = smooth_flags(list((near_sand[s:e] | (near_kyst[s:e] & near_beach_node[s:e])) & ~near_havn[s:e]), 2)
            natf = smooth_flags(list((near_kyst[s:e] | (near_nature[s:e] & ~dev[s:e])) & ~near_havn[s:e]), 2)
            vstyle = ["s" if sandf[i] else "b" if natf[i] else "q" for i in range(e - s)]
        else:
            vstyle = ["q" if f else "b" for f in flags]
        run = None
        for k in range(s, e - 1):
            x0, z0, x1, z1 = V[k][0], V[k][1], V[k + 1][0], V[k + 1][1]
            mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
            if edge_zone.contains(Point(mx, mz)):
                run = None
                continue
            a_, b_ = vstyle[k - s], vstyle[k + 1 - s]
            style = a_ if a_ == b_ else "s" if "s" in (a_, b_) else "q" if "q" in (a_, b_) else "b"
            owner = frame.tile_of_local(mx, mz)
            if owner not in idset:
                run = None
                continue
            if run is None or run["s"] != style or run["tile"] != owner:
                run = {"s": style, "tile": owner, "pts": [round(float(x0), 2), round(float(z0), 2)], "top": [round(float(tops[k]), 2)]}
                walls.setdefault(b["id"], {}).setdefault(owner, []).append(run)
            run["pts"] += [round(float(x1), 2), round(float(z1), 2)]
            run["top"].append(round(float(tops[k + 1]), 2))
            shore_m[style] += math.hypot(x1 - x0, z1 - z0)
    log(f"shore walls: quay {shore_m['q'] / 1000:.1f} km, natural bank {shore_m['b'] / 1000:.1f} km, beach {shore_m['s'] / 1000:.1f} km")

    # ---- per tile
    layers = {tid: {"tile": tid, "ord": {}, "bodies": []} for tid in ids}
    far = {}
    for b in bodies:
        p = b["poly"]
        for ti in tile_tree.query(p, predicate="intersects"):
            tid = ids[ti]
            piece = p.intersection(tile_geoms[ti])
            pl = [g for g in polys(piece) if g.area >= 0.5]
            if not pl:
                continue
            rec = {"id": b["id"], "kind": b["kind"], "level": b["level"], "polys": [poly_rec(g) for g in pl]}
            if b["pond"]:
                rec["pond"] = 1
            ws = [{"s": r["s"], "pts": r["pts"], "top": r["top"]} for r in walls.get(b["id"], {}).get(tid, [])]
            if ws:
                rec["walls"] = ws
            layers[tid]["bodies"].append(rec)
            if not b["pond"] or p.area >= 150:
                fl = []
                for g in pl:
                    sg = g.simplify(FAR_TOL_M, preserve_topology=True)
                    for q in polys(sg):
                        if q.area >= 80:
                            fl.append(poly_rec(q, 1))
                if fl:
                    far.setdefault(tid, []).append({"l": b["level"], "p": fl})
    # walls whose owner tile holds no piece of the body (a segment on the very edge): attach to the tile as a body-less run
    for bid, per in walls.items():
        for tid, runs in per.items():
            if not any(r["id"] == bid for r in layers[tid]["bodies"]):
                body = next(b for b in bodies if b["id"] == bid)
                layers[tid]["bodies"].append({"id": bid, "kind": body["kind"], "level": body["level"], "polys": [], "walls": [{"s": r["s"], "pts": r["pts"], "top": r["top"]} for r in runs]})

    # ---- ground cuts
    cuts = lattice_cut(cut_water, ids)
    for tid, c in cuts.items():
        layers[tid]["cut"] = c
    log(f"ground cuts: {sum(len(c['skip']) for c in cuts.values())} cells out, {sum(len(c['pieces']) for c in cuts.values())} pieces in {len(cuts)} tiles")

    # ---- ground-surface polygons (the register: paving, gravel, cobbles ...) the water covers are trimmed; a polygon over a bridge deck is not
    body_tree = STRtree([b["poly"] for b in lakes_b])
    cut_prep = cut_water
    shapely.prepare(cut_prep)
    ncut = ndeck = 0
    for tid in ids:
        d = read_json(tiles_dir / tid / "surfaces.json")
        out = []
        for srf in (d or {}).get("surfaces", []):
            r = srf.get("ring") or []
            if len(r) < 6:
                continue
            try:
                sp = Polygon([(r[i], r[i + 1]) for i in range(0, len(r) - 1, 2)], [[(h[i], h[i + 1]) for i in range(0, len(h) - 1, 2)] for h in srf.get("holes", []) if len(h) >= 6]).buffer(0)
            except Exception:  # noqa: BLE001
                continue
            if sp.is_empty or not sp.intersects(cut_prep):
                continue
            over = sp.intersection(cut_water)
            if over.area < MIN_CUT_M2:
                continue
            hit = [lakes_b[j] for j in body_tree.query(over, predicate="intersects")]
            lvl = hit[0]["level"] if hit else SEA
            m = dtm.median_in(max(polys(over), key=lambda g: g.area))
            hand_made = over.intersection(ovr_union).area > 0.5 * over.area  # the Soerne: the district cuts everything the lakes cover
            if not hand_made and m is not None and m - lvl > DECK_ABOVE_M:
                ndeck += 1
                continue  # a bridge or pier deck: it stands over the water on purpose
            replace = []
            for k, q in enumerate(sorted(polys(sp.difference(cut_water)), key=lambda g: -g.area)):
                if q.area < 1.0:
                    continue
                rec = {"id": srf["id"] if k == 0 else f"{srf['id']}~lake{k}", **poly_rec(q)}
                replace.append(rec)
            out.append({"id": srf["id"], "replace": replace})
        if out:
            layers[tid]["surfaceCuts"] = out
            ncut += len(out)
    log(f"surface cuts: {ncut} polygons trimmed, {ndeck} left over bridge decks")

    # ---- green ground
    gs = green_geoms(tiles_dir, ids)
    green = unary_union([g.buffer(0) for g in gs]).difference(all_water) if gs else Polygon()
    ngreen = 0
    for ti in (tile_tree.query(green, predicate="intersects") if not green.is_empty else []):
        tid = ids[ti]
        piece = green.intersection(tile_geoms[ti])
        out = []
        for g in polys(piece):
            sg = g.simplify(GREEN_TOL_M, preserve_topology=True)
            for q in polys(sg):
                if q.area >= MIN_GREEN_M2:
                    out.append(poly_rec(q, 1))
        if out:
            layers[tid]["green"] = out
            ngreen += len(out)
    green_in = green.intersection(area).area if not green.is_empty else 0.0
    log(f"green: {len(gs)} source polygons, {ngreen} tile pieces, {green_in / 1e6:.2f} km2 inside the tiles")

    # ---- write
    sizes = {}
    for tid, lay in layers.items():
        path = tiles_dir / tid / "water.json"
        if lay["bodies"] or lay.get("cut") or lay.get("green") or lay.get("surfaceCuts"):
            text = json.dumps(lay, separators=(",", ":"), ensure_ascii=False)
            tmp = path.with_name(path.name + f".tmp{os.getpid()}")
            tmp.write_text(text)
            tmp.replace(path)
            sizes[tid] = len(text.encode())
        elif path.exists():
            path.unlink()
    table = [{"id": b["id"], "name": b["name"], "kind": b["kind"], "level": b["level"], "area_m2": round(b["poly"].area, 1),
              "bbox": [round(v) for v in b["poly"].bounds], "sea": b["sea"]} for b in lakes_b]
    header = {
        "version": VERSION, "sea": SEA,
        "method": "GeoDanmark soe + bassin and OSM natural=water polygons, the sea from the OSM coastline; levels from the compiled terrain; "
                  "shore walls by development; Soerne as the district override; tools/cph-geodata/city_water.py",
        "stats": {"bodies": len(lakes_b), "ponds": len(bodies) - len(lakes_b), "quay_km": round(shore_m["q"] / 1000, 1), "bank_km": round(shore_m["b"] / 1000, 1), "beach_km": round(shore_m["s"] / 1000, 1),
                  "water_km2": round(cut_water.area / 1e6, 3), "green_km2": round(green_in / 1e6, 3), "tiles": len(sizes)},
        "bodies": table, "far": far, "override": ovr_doc,
    }
    (city_dir).mkdir(parents=True, exist_ok=True)
    text = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    tmp = city_dir / "water.json.tmp"
    tmp.write_text(text)
    tmp.replace(city_dir / "water.json")
    update_manifest(city_dir, "water", {"header": "water.json", "bytes": len(text.encode()), "tiles": sizes})
    log(f"water.json {len(text) / 1e6:.2f} MB, {len(sizes)} tile layers ({sum(sizes.values()) / 1e6:.2f} MB), {time.time() - t0:.0f} s")
    for b in table[:40]:
        log(f"  {b['id']:6} {b['kind']:9} {b['level']:7.2f} {b['area_m2']:11.0f} m2  {b['name'][:50]}")
    return 0


def update_manifest(city_dir: Path, key: str, value) -> None:
    p = city_dir / "post.json"
    doc = read_json(p) or {"version": "cph-post/1"}
    doc[key] = value
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, p)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tiles", default="data/tiles")
    ap.add_argument("--city", default="data/city")
    ap.add_argument("--fetch", action="store_true", help="download the GeoDanmark and OSM extras into data/raw/city/water/ first")
    ap.add_argument("--force-fetch", action="store_true")
    args = ap.parse_args()
    if args.fetch or args.force_fetch:
        fetch(args.force_fetch)
    return build(args)


if __name__ == "__main__":
    raise SystemExit(main())
