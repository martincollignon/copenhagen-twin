#!/usr/bin/env python3
"""Run roofer (Docker, 3dgi/roofer:v1.1.0-beta.1) per tile; tiles run in parallel. Output: work/<tile>/out/*.city.jsonl

    uv run --project tools/lod2 python tools/lod2/run.py [--bbox ...] [--tiles ...] [--workers N] [--jobs-per-tile N]

Uses work/<tile>/roofer.toml (written by prep.py). If the Docker daemon's CPU count is C, `workers` tiles run at once,
each with `-j C/workers` roofer jobs (roofer uses jobs-1 reconstruction threads).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import platform
import shutil
import subprocess
import sys
import time

import common


def docker_cpus() -> int:
    try:
        return int(subprocess.run(["docker", "info", "--format", "{{.NCPU}}"], capture_output=True, text=True, check=True).stdout.strip())
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return 4


def run_tile(tid: str, jobs: int, force: bool) -> tuple[str, float, str]:
    wd = common.WORK_DIR / tid
    out = wd / "out"
    if not (wd / "roofer.toml").exists():
        return tid, 0.0, "not prepped"
    if out.exists() and any(out.glob("*.jsonl")) and not force:
        return tid, 0.0, "cached"
    shutil.rmtree(out, ignore_errors=True)
    arch = "linux/arm64" if platform.machine().lower() in ("arm64", "aarch64") else "linux/amd64"
    cmd = ["docker", "run", "--rm", "--platform", arch, "-v", f"{wd}:/data", common.ROOFER_IMAGE,
           "-c", "/data/roofer.toml", "-j", str(jobs), "/data/out"]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    (wd / "roofer.log").write_text(p.stdout + p.stderr)
    dt_s = time.time() - t0
    if p.returncode != 0 or not any(out.glob("*.jsonl")):
        return tid, dt_s, f"FAILED rc={p.returncode}: {(p.stdout + p.stderr)[-300:]}"
    return tid, dt_s, "ok"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, default=common.DISTRICT_BBOX)
    ap.add_argument("--tiles", nargs="*")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--jobs-per-tile", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    tiles = a.tiles or common.tiles_for_bbox(a.bbox, common.MARGIN_M)
    cpus = docker_cpus()
    workers = a.workers or max(1, min(len(tiles), cpus // 2))
    jobs = a.jobs_per_tile or max(2, cpus // workers)
    print(f"{len(tiles)} tiles, docker cpus {cpus}: {workers} parallel x -j {jobs}", flush=True)
    t0 = time.time()
    bad = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for tid, secs, msg in ex.map(lambda t: run_tile(t, jobs, a.force), tiles):
            print(f"{tid}: {msg} ({secs:.0f}s)", flush=True)
            bad += msg.startswith("FAILED")
    print(f"wall {time.time() - t0:.0f}s")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
