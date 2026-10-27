#!/usr/bin/env python3
"""Ground-floor venues -> data/cph-groundfloor.json (cph-groundfloor/1).

Shops, food/drink and service venues from OSM (Overpass: shop=*, amenity in cafe/restaurant/bar/pub/fast_food/...,
craft, office with a public front) and the KK `bevillinger` (serveringsbevillinger) WFS layer, in the twin's local frame.
The engine (js/groundfloor.js) assigns each venue to the street-facing wall of the building it stands in or beside; only
walls with a venue get a shopfront, everything else is a residential ground floor.

    uv run tools/cph-geodata/groundfloor.py            # cached raw layers under data/raw/ make reruns offline
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch import kk_layer, overpass  # noqa: E402
import frame  # noqa: E402
from frame import area_local, to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "cph-groundfloor.json"

AMENITY = {"cafe", "restaurant", "bar", "pub", "fast_food", "ice_cream", "bakery", "biergarten", "nightclub", "pharmacy",
           "bank", "post_office", "dentist", "doctors", "veterinary", "driving_school", "marketplace", "food_court"}
QUERY = (
    '(nwr["shop"];nwr["amenity"~"^(' + "|".join(sorted(AMENITY)) + ')$"];nwr["craft"];'
    'nwr["office"]["addr:housenumber"];nwr["tourism"~"^(hotel|hostel|gallery)$"];);out center tags;'
)


def kind_of(tags: dict) -> str:
    shop, amenity = tags.get("shop"), tags.get("amenity")
    if amenity in ("cafe", "restaurant", "bar", "pub", "fast_food", "ice_cream", "bakery", "biergarten", "nightclub", "food_court"):
        return "food"
    if shop in ("supermarket", "convenience", "bakery", "greengrocer", "butcher", "kiosk", "deli", "alcohol", "beverages"):
        return "grocery"
    if shop:
        return "shop"
    if amenity:
        return "service"
    if tags.get("craft"):
        return "craft"
    if tags.get("tourism"):
        return "hotel"
    return "office"


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    frame.add_area_args(ap)
    args = ap.parse_args()
    frame.apply_area_args(args)
    out_path = frame.resolve_out(args, OUT)
    x0, z0, x1, z1 = area_local()
    out, seen = [], set()
    from pyproj import Transformer

    wgs = Transformer.from_crs(4326, 25832, always_xy=True)
    for el in overpass("groundfloor", QUERY).get("elements", []):
        tags = el.get("tags") or {}
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        if lon is None or lat is None:
            continue
        x, z = to_local(*wgs.transform(lon, lat))
        if not (x0 <= x <= x1 and z0 <= z <= z1):
            continue
        k = (round(x, 1), round(z, 1))
        seen.add(k)
        out.append({"x": round(x, 2), "z": round(z, 2), "kind": kind_of(tags), "name": tags.get("name"),
                    "level": tags.get("level"), "src": [f"osm:{el['type']}/{el['id']}"], "conf": "observed"})
    n_osm = len(out)
    try:
        for f in kk_layer("bevillinger").get("features", []):
            g = f.get("geometry") or {}
            c = g.get("coordinates")
            if g.get("type") == "MultiPoint" and c:
                c = c[0]
            elif g.get("type") != "Point":
                continue
            x, z = to_local(*c[:2])
            if not (x0 <= x <= x1 and z0 <= z <= z1):
                continue
            p = f.get("properties") or {}
            out.append({"x": round(x, 2), "z": round(z, 2), "kind": "food", "name": p.get("navn") or p.get("virksomhed"),
                        "koncept": p.get("koncept"), "night": bool(p.get("nattilladelse")), "src": ["kk:bevillinger"], "conf": "observed"})
    except Exception as exc:  # noqa: BLE001 - KK layer is optional
        print(f"[groundfloor] kk bevillinger skipped: {exc}", file=sys.stderr)
    doc = {"version": "cph-groundfloor/1", "frame": "cph-geodata local (x east, z south)",
           "attribution": ["© OpenStreetMap contributors (ODbL)", "Københavns Kommune, bevillinger (open data)"],
           "venues": out}
    out_path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"venues: {len(out)} (osm {n_osm}, kk {len(out) - n_osm}) -> {out_path}")


if __name__ == "__main__":
    main()
