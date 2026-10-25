#!/usr/bin/env python3
"""Download the DHM Punktsky 1 km LAZ tiles covering a bbox into data/raw/lod2/ (gitignored, resume-safe).

    uv run --project tools/lod2 python tools/lod2/fetch.py                     # district (local +-750 m)
    uv run --project tools/lod2 python tools/lod2/fetch.py --bbox 715000 6170000 735000 6185000   # EPSG:25832, e.g. the commune

The API key (Datafordeler FileDownloads GetPointCloudFile) is read from $DATAFORDELER_GRAPHQL_API_KEY or, if unset,
from Secret Manager via ADC (tools/adc-secret.sh datafordeler-graphql-api-key). It is never printed.
Existing tiles are skipped; tiles are written to <tile>.laz.part and renamed when complete (the server ignores Range, so an interrupted tile restarts).
`--seed DIR` (repeatable) copies tiles already cached elsewhere (APFS clone) instead of downloading them.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import shutil
import subprocess
import sys
import time

import common

URL = "https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey={key}&FileName={name}"
DEFAULT_SEEDS = [
    os.path.expanduser("~/.cache/dk-lidar"),
    os.path.expanduser("~/conductor/cph-twin/docs/research/roofer-spike/raw"),
]


def api_key() -> str:
    key = os.environ.get("DATAFORDELER_GRAPHQL_API_KEY")
    if key:
        return key.strip()
    out = subprocess.run([str(common.ROOT / "tools" / "adc-secret.sh"), "datafordeler-graphql-api-key"],
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


def is_laz(path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"LASF"
    except OSError:
        return False


def seed(tid: str, seeds: list[str]) -> bool:
    dest = common.tile_file(tid)
    for d in seeds:
        src = os.path.join(d, dest.name)
        if os.path.isfile(src) and is_laz(src):
            tmp = dest.with_suffix(".laz.part")
            subprocess.run(["cp", "-c", src, str(tmp)], check=False) if sys.platform == "darwin" else shutil.copyfile(src, tmp)
            if not tmp.exists():
                shutil.copyfile(src, tmp)
            os.replace(tmp, dest)
            return True
    return False


def download(tid: str, key: str, retries: int = 6) -> str:
    """curl (system CA store; the server ignores Range, so an interrupted tile restarts). The key goes via a curl config on
    stdin so it never appears in the process list or in output."""
    dest = common.tile_file(tid)
    part = dest.with_suffix(".laz.part")
    url = URL.format(key=key, name=dest.name)
    for attempt in range(1, retries + 1):
        p = subprocess.run(["curl", "-sS", "--fail", "--max-time", "1500", "--speed-limit", "20000", "--speed-time", "60",
                            "-o", str(part), "-K", "-"], input=f'url = "{url}"\n', capture_output=True, text=True)
        if p.returncode == 0 and is_laz(part) and part.stat().st_size > 1_000_000:
            os.replace(part, dest)
            return f"{tid}: ok {dest.stat().st_size / 1e6:.0f} MB"
        err = p.stderr.replace(key, "***").strip()[:200]
        print(f"{tid}: attempt {attempt}: curl rc={p.returncode} {err}", flush=True)
        part.unlink(missing_ok=True)
        time.sleep(min(30, 4 * attempt))
    return f"{tid}: FAILED after {retries} attempts"


def scan_meta(tid: str) -> dict:
    """Point count and acquisition date range (from adjusted GPS time) of a tile, cached as <tile>.meta.json."""
    meta_path = common.RAW_DIR / f"PUNKTSKY_1km_{tid}.meta.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    out = subprocess.run(["pdal", "info", "--stats", "--dimensions", "GpsTime", str(common.tile_file(tid))],
                         capture_output=True, text=True, check=True).stdout
    stat = json.loads(out)["stats"]["statistic"][0]
    meta = {"tile": tid, "count": stat["count"], "gps_min": stat["minimum"], "gps_max": stat["maximum"],
            "scan_date_min": common.gps_to_date(stat["minimum"]), "scan_date_max": common.gps_to_date(stat["maximum"]),
            "scan_date": common.gps_to_date(stat["average"])}
    meta_path.write_text(json.dumps(meta, indent=1))
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("MINE", "MINN", "MAXE", "MAXN"), default=common.DISTRICT_BBOX)
    ap.add_argument("--margin", type=float, default=common.MARGIN_M)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--seed", action="append", default=None, help="directory with already downloaded tiles (repeatable)")
    ap.add_argument("--list", action="store_true", help="only print the tile ids")
    a = ap.parse_args()
    tiles = common.tiles_for_bbox(a.bbox, a.margin)
    print(f"{len(tiles)} tiles: {' '.join(tiles)}")
    if a.list:
        return 0
    common.RAW_DIR.mkdir(parents=True, exist_ok=True)
    todo = []
    for tid in tiles:
        dest = common.tile_file(tid)
        if dest.exists() and is_laz(dest):
            print(f"{tid}: present")
        elif seed(tid, a.seed if a.seed is not None else DEFAULT_SEEDS):
            print(f"{tid}: seeded from local cache")
        else:
            todo.append(tid)
    if todo:
        key = api_key()
        with cf.ThreadPoolExecutor(max_workers=a.jobs) as ex:
            for msg in ex.map(lambda t: download(t, key), todo):
                print(msg, flush=True)
    bad = [t for t in tiles if not common.tile_file(t).exists()]
    for tid in tiles:
        if common.tile_file(tid).exists():
            m = scan_meta(tid)
            print(f"{tid}: {m['count']:,} pts, scanned {m['scan_date_min']}..{m['scan_date_max']}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
