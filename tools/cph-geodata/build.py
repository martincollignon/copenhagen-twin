# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "shapely>=2", "pyproj", "numpy", "rasterio"]
# ///
"""Copenhagen geodata compiler (M1): writes data/cph-geodata.json per docs/cph-geodata-schema.md.

    uv run tools/cph-geodata/build.py --out data/cph-geodata.json

Raw downloads are cached under data/raw/, so reruns are offline. Optional DHM DSM/DTM
heights need a Dataforsyningen token: set DHM_TERRAIN_TOKEN (or GSEARCH_TOKEN) in the
environment, or pass --env-file PATH (values are sanitised and never printed).
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import buildings as B  # noqa: E402
import fetch  # noqa: E402
import frame  # noqa: E402
import points as P  # noqa: E402
import roads as R  # noqa: E402

HERO_GDK = "gdk:1064715171"
HERO_DIR = Path("/Users/martincollignon/.local/share/building-case-3d/noerre-soegade-37/build")
KK_LAYERS = ["bygning", "bygning_kk", "ensrettede_gader", "trafikhastigheder", "cykelsti", "trafiksignal_oversigt",
             "trae_basis", "automatisk_detekterede_traeer_kk_beta", "cykelstativ", "baenke_borde_puma",
             "dp_byinventar_l", "Kommunevej", "park_groent_omr_oversigtskort", "parkregister", "fortovsmatrikel"]
OSM_QUERIES = {
    "roads": 'way["highway"];out geom tags;',
    "water_parks": '(way["natural"="water"];relation["natural"="water"];way["leisure"~"^(park|garden)$"];'
                   'relation["leisure"~"^(park|garden)$"];);out geom tags;',
    "nodes": '(node["highway"="traffic_signals"];node["highway"="street_lamp"];'
             'node["highway"="crossing"]["crossing"="traffic_signals"];);out;',
}


def load_layers(failed: dict, refresh: bool):
    kk, osm = {}, {}
    for name in KK_LAYERS:
        try:
            kk[name] = fetch.kk_layer(name, refresh)
        except Exception as e:  # noqa: BLE001
            failed[f"kk:{name}"] = str(e)[:200]
    for key, q in OSM_QUERIES.items():
        try:
            osm[key] = fetch.overpass(key, q, refresh)
        except Exception as e:  # noqa: BLE001
            failed[f"osm:{key}"] = str(e)[:200]
    return kk, osm


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/cph-geodata.json")
    ap.add_argument("--refresh", action="store_true", help="re-download raw layers")
    ap.add_argument("--env-file", help="optional .env with DHM_TERRAIN_TOKEN/GSEARCH_TOKEN for DSM/DTM heights")
    ap.add_argument("--no-dhm", action="store_true")
    a = ap.parse_args(argv)

    failed: dict[str, str] = {}
    kk, osm = load_layers(failed, a.refresh)
    meta: dict = {"failed": failed}

    rasters = dhm_mod = None
    if not a.no_dhm:
        tok = fetch.load_env_value(a.env_file, "DHM_TERRAIN_TOKEN", "GSEARCH_TOKEN")
        if tok:
            try:
                import dhm as dhm_mod

                rasters = dhm_mod.load_rasters(tok)
            except Exception as e:  # noqa: BLE001
                failed["dhm:wcs"] = str(e)[:200]
                rasters = None
        else:
            failed["dhm:wcs"] = "no DHM token available (set DHM_TERRAIN_TOKEN or pass --env-file); heights fall back to KK tagrendehoejde_estimat"

    bygning = kk.get("bygning", {"features": []})
    extra = B.supplement_from_bygning_kk(bygning, kk.get("bygning_kk"))
    meta["building_supplemented_from_bygning_kk"] = len(extra)
    blds, bstats = B.compile_buildings({"features": bygning["features"] + extra}, rasters, dhm_mod)
    meta["building_stats"] = bstats

    sig, sig_utm = P.signals(kk.get("trafiksignal_oversigt"), osm.get("nodes"))
    roads, ways, names, rstats = R.compile_roads(
        osm.get("roads", {"elements": []}),
        {k: kk.get(k) for k in ("Kommunevej", "trafikhastigheder", "ensrettede_gader", "cykelsti")}, sig_utm)
    graph = R.build_road_graph(roads, ways, names, sig_utm)
    meta["road_stats"] = dict(rstats)

    wp = osm.get("water_parks", {"elements": []})
    hero = []
    glb, bj = HERO_DIR / "building.glb", HERO_DIR / "building.json"
    if any(b["id"] == HERO_GDK for b in blds):
        hero.append({"building_id": HERO_GDK, "glb": str(glb), "frame": str(bj),
                     "src": ["building-case-to-3d"], "conf": "measured"})
        if not glb.exists():
            failed["hero:glb"] = f"{glb} not found"
    else:
        failed["hero:building"] = f"{HERO_GDK} not in compiled buildings"

    doc = {
        "version": "cph-geodata/1",
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "frame": {"epsg": 25832, "vertical": "DVR90", "origin": list(frame.ORIGIN),
                  "axes": "x=east, z=south, y=up", "bbox": list(frame.LOCAL_BBOX)},
        "attribution": [
            "Indeholder data fra Klimadatastyrelsen / GeoDanmark (Bygning), BBR og Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens).",
            "© OpenStreetMap contributors (ODbL)",
            "Københavns Kommune open data: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister",
        ],
        "buildings": blds,
        "roads": roads,
        "roadGraph": graph,
        "cycleTracks": P.cycle_tracks(kk.get("cykelsti")),
        "sidewalks": P.sidewalks(kk.get("fortovsmatrikel")),
        "water": P.water(wp),
        "parks": P.parks(kk.get("parkregister"), kk.get("park_groent_omr_oversigtskort"), wp),
        "points": {
            "signals": sig,
            "trees": P.trees(kk.get("trae_basis"), kk.get("automatisk_detekterede_traeer_kk_beta")),
            "bikeRacks": P.bike_racks(kk.get("cykelstativ"), kk.get("dp_byinventar_l")),
            "benches": P.benches(kk.get("baenke_borde_puma")),
            "lights": P.lights(osm.get("nodes")),
        },
        "heroes": hero,
        "meta": meta,
    }
    for b in doc["buildings"]:
        b.pop("preset", None)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    out.write_text(text)
    mb = len(text.encode()) / 1e6
    if mb >= 25:
        with gzip.open(str(out) + ".gz", "wt") as fh:
            fh.write(text)
        out.unlink()
        print(f"wrote {out}.gz ({mb:.1f} MB uncompressed; gzipped because >= 25 MB)")
    else:
        print(f"wrote {out} ({mb:.1f} MB)")
    print({k: (len(v) if isinstance(v, list) else {kk_: len(vv) for kk_, vv in v.items()} if k == "points" else "") for k, v in doc.items()
           if k in ("buildings", "roads", "cycleTracks", "sidewalks", "water", "parks", "points", "heroes")})
    if failed:
        print("failed/skipped:", json.dumps(failed, ensure_ascii=False))


if __name__ == "__main__":
    main()
