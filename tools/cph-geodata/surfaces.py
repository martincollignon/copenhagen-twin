# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "pyproj"]
# ///
"""Ground-surface and road-marking compiler for the Copenhagen twin -> data/cph-surfaces.json.

Sources (Københavns Kommune open WFS, CC BY 4.0 / Open Data DK licens, no auth):
  k101:dp_belaegninger   surface material polygons (parks, squares, some streets)
  k101:afmaerkning_total road markings (crossings, arrows, bays, white lines, ...)
  k101:blaa_cykelfelt    blue cycle crossings (merged with the matching afmaerkning type)
  OSM place=square / highway=pedestrian areas (ODbL): squares and pedestrian streets KK's register does not cover
There is no kerb-stone layer in the KK WFS (vejkant is the GeoDanmark road edge), so kerbs are geometry in the viewer.

Same local frame as cph-geodata.json (x = E - 723900, z = -(N - 6176500), bbox +-750 m). Raw responses are cached
under data/raw/. This is a separate file so it never touches data/cph-geodata.json.

    uv run tools/cph-geodata/surfaces.py [--refresh]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frame import LOCAL_BBOX, ORIGIN, flat, ring_to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "cph-surfaces.json"
CLASSES = ("kbh_fortov", "raadhus", "asphalt_road", "asphalt_cycle", "cobbles", "setts", "gravel", "grass", "other")
MARGIN = 10.0


def classify_surface(under_element: str | None, byrumstype: str | None = None, underordnet: str | None = None) -> tuple[str, str]:
    """KK dp_belaegninger `under_element` (+ urban-space type) -> (twin class, confidence).

    'observed' where the register names the material outright, 'inferred' where the pattern is our reading
    (e.g. concrete slabs on a street are the Københavner fortov, on a square the Rådhusbelægning).
    """
    u = (under_element or "").strip().lower()
    street = (byrumstype or "") == "Gader og pladser"
    square = (underordnet or "") == "Øvrig plads" or (underordnet or "") == "Grøn plads"
    if u.startswith("natursten"):
        return ("cobbles" if square or not street else "setts"), "inferred"
    if u.startswith("betonsten"):
        return ("raadhus" if square else "kbh_fortov"), "inferred"
    if u.startswith("grus") or u.startswith("perlesten"):
        return "gravel", "observed"
    if u.startswith("asfalt") or u.startswith("ob-belægning"):
        return "asphalt_road", "observed"
    if u.startswith("klinker") or u.startswith("beton"):
        return "other", "observed"
    if u.startswith("træhulsrist"):
        return "other", "observed"
    return "other", "inferred"


MARKING_KIND = {
    "Hvidafmærkning": "white",
    "Gul afmærkning": "yellow",
    "Parkering": "bay",
    "Symboler på kørebane": "symbol",
    "Pileafmærkning": "arrow",
    "Fodgængerfelt": "crossing",
    "Blå cykelfelt": "bluecycle",
    "Vejbump": "bump",
    "Cykel rampe": "ramp",
    "Servicemarkering (10m regel)": "service",
    "Rød belægning (OB)": "red",
}


def classify_osm(tags: dict) -> tuple[str, str]:
    """OSM square / pedestrian-area tags -> (twin class, confidence). OSM rarely says which paving, so most are inferred."""
    surface = (tags.get("surface") or "").lower()
    if surface in ("sett", "cobblestone", "unhewn_cobblestone"):
        return ("setts" if surface == "sett" else "cobbles"), "observed"
    if surface in ("paving_stones", "paved", "concrete:plates"):
        return "raadhus", "inferred"
    return "cobbles", "inferred"  # an unlabelled Copenhagen square: granite brosten


def polygons(geom):
    if not geom:
        return
    if geom["type"] == "Polygon":
        yield geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        yield from geom["coordinates"]


def centroid(ring):
    n = len(ring)
    return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n


def inside_bbox(c):
    x0, z0, x1, z1 = LOCAL_BBOX
    return x0 - MARGIN <= c[0] <= x1 + MARGIN and z0 - MARGIN <= c[1] <= z1 + MARGIN


def convert(fc, mapper, prefix):
    out = []
    for f in fc["features"]:
        for k, poly in enumerate(polygons(f.get("geometry"))):
            ring = ring_to_local(poly[0])
            if len(ring) < 3 or not inside_bbox(centroid(ring)):
                continue
            holes = [flat(ring_to_local(h)) for h in poly[1:] if len(h) >= 4]
            rec = mapper(f["properties"])
            rec.update(id=f"{prefix}:{f['properties'].get('uuid') or f['properties'].get('id')}#{k}", ring=flat(ring))
            if holes:
                rec["holes"] = holes
            out.append(rec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    import fetch  # noqa: PLC0415 (needs requests)

    belag = fetch.kk_layer("dp_belaegninger", args.refresh)
    afm = fetch.kk_layer("afmaerkning_total", args.refresh)
    blue = fetch.kk_layer("blaa_cykelfelt", args.refresh)

    def surf(p):
        cls, conf = classify_surface(p.get("under_element"), p.get("byrumstype"), p.get("underordnet_byrumstype"))
        return {"cls": cls, "material": p.get("under_element"), "space": p.get("underordnet_byrumstype") or p.get("byrumstype"),
                "src": ["kk:dp_belaegninger"], "conf": conf}

    surfaces = convert(belag, surf, "kk:belaegning")

    # OSM squares and pedestrian areas (closed ways only), after the KK register so KK wins where both cover a spot
    from pyproj import Transformer  # noqa: PLC0415

    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    osm = fetch.overpass(
        "squares",
        '(way["place"="square"];way["highway"="pedestrian"]["area"="yes"];way["area:highway"~"pedestrian|footway|living_street"];'
        'relation["place"="square"];relation["highway"="pedestrian"];way["landuse"="pedestrian"];);out geom;',
    )
    n_osm = 0
    for e in osm["elements"]:
        geom = e.get("geometry") or []
        if e["type"] != "way" or len(geom) < 4 or (geom[0]["lat"], geom[0]["lon"]) != (geom[-1]["lat"], geom[-1]["lon"]):
            continue
        ring = ring_to_local([to_utm.transform(g["lon"], g["lat"]) for g in geom])
        if len(ring) < 3 or not inside_bbox(centroid(ring)):
            continue
        cls, conf = classify_osm(e.get("tags", {}))
        surfaces.append({"cls": cls, "material": e["tags"].get("surface") or "place=square", "space": e["tags"].get("name"),
                         "src": ["osm:way"], "conf": conf, "id": f"osm:way/{e['id']}", "ring": flat(ring)})
        n_osm += 1
    print("osm squares/pedestrian areas", n_osm)

    def mark(p):
        t = p.get("type")
        return {"kind": MARKING_KIND.get(t, "other"), "src": ["kk:afmaerkning_total"], "conf": "observed"}

    markings = convert(afm, mark, "kk:afm")
    # blaa_cykelfelt duplicates most afmaerkning 'Blå cykelfelt' polygons: add only those without a twin within 1.5 m
    have = [centroid([(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]) for m in markings if m["kind"] == "bluecycle" for ring in [m["ring"]]]
    for m in convert(blue, lambda p: {"kind": "bluecycle", "src": ["kk:blaa_cykelfelt"], "conf": "observed"}, "kk:blaa"):
        c = centroid([(m["ring"][i], m["ring"][i + 1]) for i in range(0, len(m["ring"]), 2)])
        if not any((c[0] - h[0]) ** 2 + (c[1] - h[1]) ** 2 < 2.25 for h in have):
            markings.append(m)

    doc = {
        "version": "cph-surfaces/1",
        "frame": {"epsg": 25832, "origin": list(ORIGIN), "axes": "x=east, z=south, y=up", "bbox": list(LOCAL_BBOX)},
        "attribution": ["Indeholder data fra Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens)"],
        "classes": list(CLASSES),
        "surfaces": surfaces,
        "markings": markings,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)")
    print("surfaces", len(surfaces), dict(Counter(s["cls"] for s in surfaces)))
    print("  by material", dict(Counter(s["material"] for s in surfaces)))
    print("markings", len(markings), dict(Counter(m["kind"] for m in markings)))


if __name__ == "__main__":
    main()
