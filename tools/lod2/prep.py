#!/usr/bin/env python3
"""Per tile: footprints from data/cph-geodata.json, a class 2+6 PDAL crop of the tile (+25 m margin), roofer.toml.

Writes data/raw/lod2/work/<tile>/{footprints.geojson, cropped.laz, roofer.toml, manifest.json}.
`manifest.json` records, per own building, the BBR year and whether it post-dates the scan (those roofs are marked
`inferred` and get no mesh: the point cloud cannot contain them).

    uv run --project tools/lod2 python tools/lod2/prep.py [--bbox ...] [--tiles 6176_723 ...] [--force]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

import common
import fetch


def tile_footprints(geo: dict, tid: str, margin: float, scan_year: int | None) -> tuple[dict, dict]:
    """GeoJSON FeatureCollection (EPSG:25832) for the tile + margin, and the per-building manifest of own buildings."""
    e0, n0, e1, n1 = common.tile_bounds(tid)
    feats, manifest = [], {}
    for b in geo["buildings"]:
        ring = common.ring_to_en(b["ring"])
        if len(ring) < 3:
            continue
        ce = sum(p[0] for p in ring) / len(ring)
        cn = sum(p[1] for p in ring) / len(ring)
        own = e0 <= ce < e1 and n0 <= cn < n1
        near = e0 - margin <= ce < e1 + margin and n0 - margin <= cn < n1 + margin
        if not (own or near):
            continue
        rings = [ring] + [common.ring_to_en(h) for h in b.get("holes", [])]
        coords = [[[round(p[0], 3), round(p[1], 3)] for p in r] + [[round(r[0][0], 3), round(r[0][1], 3)]] for r in rings]
        year = b.get("year")
        post_scan = bool(own and scan_year and isinstance(year, int) and year > scan_year)
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords}, "properties": {
            "id": common.bare_id(b["id"]),
            "yoc": year if isinstance(year, int) else 0,
            "ground": round(b["ground"] + common.ORIGIN[2], 3),
            # margin neighbours only give the cropper context: cheap LoD1.1 extrusion, discarded by convert.py
            "force_lod11": (not own) or post_scan,
        }})
        if own:
            manifest[b["id"]] = {"year": year, "year_conf": (b.get("conf_fields") or {}).get("year", b.get("conf")),
                                 "post_scan": post_scan, "year_eq_scan": bool(scan_year and year == scan_year)}
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}}, "features": feats}
    return fc, manifest


def crop(tid: str, margin: float, out) -> list[str]:
    """PDAL: tile + neighbours that exist, cropped to the tile grown by margin, classes 2 and 6 only. Returns the tiles read."""
    e0, n0, e1, n1 = common.tile_bounds(tid)
    n_km, e_km = (int(v) for v in tid.split("_"))
    used, stages = [], []
    for dn in (-1, 0, 1):
        for de in (-1, 0, 1):
            t = common.tile_id(n_km + dn, e_km + de)
            if common.tile_file(t).exists():
                used.append(t)
                stages.append({"type": "readers.las", "filename": str(common.tile_file(t)), "tag": f"r{len(used)}"})
    bounds = f"([{e0 - margin},{e1 + margin}],[{n0 - margin},{n1 + margin}])"
    pipeline = stages + [
        {"type": "filters.merge", "inputs": [s["tag"] for s in stages]} if len(stages) > 1 else None,
        {"type": "filters.range", "limits": "Classification[2:2],Classification[6:6]"},
        {"type": "filters.crop", "bounds": bounds},
        {"type": "writers.las", "filename": str(out), "compression": "laszip"},
    ]
    pipeline = [p for p in pipeline if p]
    cfg = out.parent / "crop.json"
    cfg.write_text(json.dumps(pipeline))
    subprocess.run(["pdal", "pipeline", str(cfg)], check=True, capture_output=True)
    return used


ROOFER_TOML = """[input]
polygon-source = "/data/footprints.geojson"
id-attribute = "id"
yoc-attribute = "yoc"
force-lod11-attribute = "force_lod11"
h-terrain-attribute = "ground"

[[input.pointclouds]]
name = "punktsky"
quality = 1
date = {year}  # acquisition year (roofer: buildings built after it are flagged mutated)
source = ["/data/cropped.laz"]
building_class = 6
ground_class = 2

[crop]
ceil-point-density = 20
min-building-density = 1
clear-insufficient = true

[reconstruction]
lod12 = false
lod22 = true

[output]
output-directory = "/data/out"
"""


def prep_tile(tid: str, geo: dict, margin: float, force: bool) -> dict:
    wd = common.WORK_DIR / tid
    wd.mkdir(parents=True, exist_ok=True)
    meta = fetch.scan_meta(tid)
    scan_year = int(meta["scan_date_max"][:4])
    fc, manifest = tile_footprints(geo, tid, margin, scan_year)
    (wd / "footprints.geojson").write_text(json.dumps(fc))
    cropped = wd / "cropped.laz"
    used = []
    if force or not cropped.exists():
        used = crop(tid, margin, cropped)
    (wd / "roofer.toml").write_text(ROOFER_TOML.format(year=scan_year))
    man = {"tile": tid, "scan": meta, "buildings": manifest, "footprints": len(fc["features"]), "neighbour_tiles_read": used}
    (wd / "manifest.json").write_text(json.dumps(man))
    return man


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, default=common.DISTRICT_BBOX)
    ap.add_argument("--tiles", nargs="*")
    ap.add_argument("--margin", type=float, default=common.MARGIN_M)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    geo = common.load_geodata()
    for tid in a.tiles or common.tiles_for_bbox(a.bbox, a.margin):
        if not common.tile_file(tid).exists():
            print(f"{tid}: no LAZ (run fetch.py)")
            continue
        m = prep_tile(tid, geo, a.margin, a.force)
        print(f"{tid}: {len(m['buildings'])} own buildings, {m['footprints']} footprints, scan {m['scan']['scan_date']}, "
              f"{sum(v['post_scan'] for v in m['buildings'].values())} post-scan", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
