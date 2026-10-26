#!/usr/bin/env python3
"""One Cloud Run Job task = one 1 km Punktsky cell: LAZ (R2 cache first) -> PDAL crop -> roofer LoD2.2 + vegetation rasters.

CLOUD_RUN_TASK_INDEX picks the cell from the list in $CELLS_URI (default <store>/config/cells.txt, one `<N km>_<E km>` per line);
$CELL overrides (local runs). Inputs and outputs live in a store: gs://$BUCKET/... on Cloud Run, or a directory ($STORE_DIR) for local runs.

    in   cells-input/<cell>.json          footprints + 25 m margin (data/city/cells-input, from build_city.py --stage cellsinput)
    out  cells/<cell>/out/*.jsonl         roofer CityJSONSeq (LoD2.2 + rf_* quality attributes)
         cells/<cell>/manifest.json       tools/lod2 work layout (scan date, per own building BBR year / post_scan), read by convert.py
         cells/<cell>/{footprints.geojson,roofer.toml,roofer.log.gz}
         cells/<cell>/veg/c<class>_<cell>.tif, gint_<cell>.tif   1 m rasters of the cell, only with VEG=1 (tools/cph-geodata/vegetation_rasters.py)
         cells/<cell>/DONE.json           written last; a cell with a marker is skipped (FORCE=1 reruns), FAILED.json on error

LAZ resolution per tile (the shared Cloudflare R2 LiDAR cache contract, lidar_r2.py): R2 -> only if missing Datafordeler, then published
to R2 BEFORE processing. Neighbour tiles are only fetched when a footprint reaches into their 25 m strip; a neighbour that does not
exist upstream (sea) is skipped, the cell's own tile must exist.
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import os
import resource
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
for cand in (HERE.parents[2], Path("/app")):  # repo root (tools/lod2 + tools/cph-geodata) or the image's /app
    if (cand / "tools" / "lod2" / "common.py").exists():
        sys.path.insert(0, str(cand / "tools" / "lod2"))
        break

import common  # noqa: E402  (tools/lod2)

MARGIN = common.MARGIN_M
PUNKTSKY_URL = "https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey={key}&FileName={name}"
CLASSES = (2, 3, 4, 5, 6, 9, 17)  # vegetation_rasters.CLASSES
R2_MAX_TILE_BYTES = 1536 * 1024 * 1024


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------------------------------------- store
class Store:
    """gs://bucket/prefix or a local directory."""

    def __init__(self, root: str):
        self.gcs = root.startswith("gs://")
        if self.gcs:
            from google.cloud import storage  # noqa: PLC0415
            bucket, _, prefix = root[5:].partition("/")
            self.bucket = storage.Client().bucket(bucket)
            self.prefix = prefix.strip("/")
        else:
            self.dir = Path(root)

    def _key(self, rel: str) -> str:
        return f"{self.prefix}/{rel}" if self.prefix else rel

    def exists(self, rel: str) -> bool:
        return self.bucket.blob(self._key(rel)).exists() if self.gcs else (self.dir / rel).exists()

    def get_bytes(self, rel: str) -> bytes:
        return self.bucket.blob(self._key(rel)).download_as_bytes() if self.gcs else (self.dir / rel).read_bytes()

    def put_bytes(self, rel: str, data: bytes) -> None:
        if self.gcs:
            self.bucket.blob(self._key(rel)).upload_from_string(data)
        else:
            p = self.dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)

    def put_file(self, rel: str, path: Path) -> None:
        if self.gcs:
            self.bucket.blob(self._key(rel)).upload_from_filename(str(path))
        else:
            p = self.dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, p)

    def delete_prefix(self, rel: str) -> None:
        if self.gcs:
            for b in list(self.bucket.client.list_blobs(self.bucket, prefix=self._key(rel))):
                b.delete()
        else:
            shutil.rmtree(self.dir / rel, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------------- pure helpers
def pick_cell(cells_text: str, index: int) -> str:
    cells = [c.strip() for c in cells_text.splitlines() if c.strip() and not c.startswith("#")]
    if not 0 <= index < len(cells):
        raise SystemExit(f"task index {index} outside the {len(cells)} cells")
    return cells[index]


def neighbour_tiles_needed(cell: str, features: list[dict], margin: float = MARGIN) -> list[str]:
    """Neighbour cells whose strip (the part of the cell grown by margin that lies in them) is touched by a footprint bbox."""
    e0, n0, e1, n1 = common.tile_bounds(cell)
    n_km, e_km = (int(v) for v in cell.split("_"))
    boxes = []
    for f in features:
        xs, ys = [], []
        for ring in f["geometry"]["coordinates"][:1]:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    out = []
    for dn in (-1, 0, 1):
        for de in (-1, 0, 1):
            if dn == de == 0:
                continue
            t = common.tile_id(n_km + dn, e_km + de)
            tb = common.tile_bounds(t)
            win = (max(tb[0], e0 - margin), max(tb[1], n0 - margin), min(tb[2], e1 + margin), min(tb[3], n1 + margin))
            if win[0] >= win[2] or win[1] >= win[3]:
                continue
            if any(b[0] < win[2] + 1 and b[2] > win[0] - 1 and b[1] < win[3] + 1 and b[3] > win[1] - 1 for b in boxes):
                out.append(t)
    return out


def roofer_inputs(doc: dict, scan_year: int) -> tuple[dict, dict]:
    """cells-input document -> (roofer footprints FeatureCollection, manifest 'buildings' of the own buildings), as prep.tile_footprints."""
    feats, manifest = [], {}
    for f in doc["features"]:
        p = f["properties"]
        own = bool(p.get("own"))
        year = p.get("yoc") if isinstance(p.get("yoc"), int) else 0
        post_scan = bool(own and scan_year and year > scan_year)
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "id": p["id"], "yoc": year, "ground": p["ground"], "force_lod11": (not own) or post_scan}})
        if own:
            manifest[p.get("bid") or f"gdk:{p['id']}"] = {"year": year or None, "year_conf": p.get("year_conf"),
                                                           "post_scan": post_scan, "year_eq_scan": bool(scan_year and year == scan_year)}
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}}, "features": feats}
    return fc, manifest


def roofer_toml(scan_year: int, workdir: Path) -> str:
    sys.path.insert(0, str(Path(common.__file__).parent))  # tools/lod2 first: tools/cph-geodata has its own fetch.py
    import prep  # noqa: PLC0415  (the toml the district run uses; paths re-rooted)
    return prep.ROOFER_TOML.format(year=scan_year).replace("/data", str(workdir))


def crop_pipeline(src: Path, out: Path, bounds: tuple[float, float, float, float]) -> list[dict]:
    e0, n0, e1, n1 = bounds
    return [{"type": "readers.las", "filename": str(src)},
            {"type": "filters.range", "limits": "Classification[2:2],Classification[6:6]"},
            {"type": "filters.crop", "bounds": f"([{e0},{e1}],[{n0},{n1}])"},
            {"type": "writers.las", "filename": str(out), "compression": "laszip"}]


def veg_pipeline(laz: Path, cell: str, outdir: Path) -> list[dict]:
    """One pass over the cell's LAZ: per-class 1 m count rasters + mean ground intensity (same options as vegetation_rasters.py)."""
    b = [round(v) for v in common.tile_bounds(cell)]
    pipe: list[dict] = [{"type": "readers.las", "filename": str(laz), "tag": "src"},
                        {"type": "filters.crop", "inputs": ["src"], "bounds": f"([{b[0]},{b[2]}],[{b[1]},{b[3]}])", "tag": "cell"}]
    for name, c, extra in [(f"c{c}", c, {}) for c in CLASSES] + [("gint", 2, {"dimension": "Intensity", "output_type": "mean"})]:
        pipe.append({"type": "filters.range", "inputs": ["cell"], "limits": f"Classification[{c}:{c}]", "tag": f"f_{name}"})
        pipe.append({"type": "writers.gdal", "inputs": [f"f_{name}"], "filename": str(outdir / f"{name}_{cell}.tif"), "resolution": 1.0,
                     "output_type": "count", "origin_x": b[0], "origin_y": b[1], "width": b[2] - b[0], "height": b[3] - b[1],
                     "gdalopts": "COMPRESS=DEFLATE", "data_type": "float32", "nodata": 0, **extra})
    return pipe


# ---------------------------------------------------------------------------------------------------------- LAZ acquisition
def datafordeler_key() -> str:
    key = os.environ.get("DATAFORDELER_GRAPHQL_API_KEY", "").strip()
    if key:
        return key
    from google.cloud import secretmanager  # noqa: PLC0415
    name = os.environ.get("DATAFORDELER_SECRET", "projects/lun-integrations-dev/secrets/datafordeler-graphql-api-key/versions/latest")
    return secretmanager.SecretManagerServiceClient().access_secret_version(request={"name": name}).payload.data.decode().strip()


def download_upstream(name: str, dest: Path, key: str, attempts: int = 4) -> bool | None:
    """True = downloaded, None = the tile does not exist upstream (HTTP 4xx), False = failed after retries.
    The key goes to curl on stdin only and is scrubbed from any message."""
    part = dest.with_suffix(".laz.part")
    url = PUNKTSKY_URL.format(key=key, name=name)
    for attempt in range(1, attempts + 1):
        hdr = part.with_suffix(".hdr")
        p = subprocess.run(["curl", "-sS", "--max-time", "1500", "--speed-limit", "20000", "--speed-time", "60", "-o", str(part),
                            "-D", str(hdr), "-w", "%{http_code}", "-K", "-"], input=f'url = "{url}"\n', capture_output=True, text=True)
        status = p.stdout.strip()
        want = [int(l.split(":", 1)[1]) for l in (hdr.read_text(errors="ignore").splitlines() if hdr.exists() else [])
                if l.lower().startswith("content-length:")]
        hdr.unlink(missing_ok=True)
        ok = (status == "200" and p.returncode == 0 and part.exists() and part.read_bytes()[:4] == b"LASF" and part.stat().st_size > 100_000
              and (not want or part.stat().st_size == want[-1]))
        if ok:
            os.replace(part, dest)
            return True
        err = (p.stderr or "").replace(key, "***").strip()[:200]
        log(f"{name}: attempt {attempt}: http {status or '-'} rc={p.returncode} {err}")
        part.unlink(missing_ok=True)
        if status.startswith("4") and status not in ("408", "429"):
            return None
        time.sleep(min(30, 5 * attempt))
    return False


def verify_laz(path: Path) -> bool:
    """Full decode: the points pdal can read must equal the header's count (catches truncated downloads and bad chunk tables;
    LASF magic + sha256 alone, as in lidar_r2, accept a truncated file)."""
    try:
        head = subprocess.run(["pdal", "info", "--summary", str(path)], capture_output=True, text=True, check=True).stdout
        declared = json.loads(head)["summary"]["num_points"]
        full = subprocess.run(["pdal", "info", "--stats", "--dimensions", "GpsTime", str(path)], capture_output=True, text=True)
        return full.returncode == 0 and json.loads(full.stdout)["stats"]["statistic"][0]["count"] == declared
    except (subprocess.CalledProcessError, KeyError, ValueError, IndexError):
        return False


class Lidar:
    """R2 first, Datafordeler second (published to R2 before it is used)."""

    def __init__(self, laz_dir: Path):
        import lidar_r2  # noqa: PLC0415
        self.m = lidar_r2
        self.dir = laz_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir = laz_dir / "_r2"
        self.r2 = lidar_r2.R2TileCache.from_env(max_tile_bytes=R2_MAX_TILE_BYTES)
        self.r2.preflight()  # a broken bucket must not trigger an unbounded upstream download
        self.key: str | None = None
        self.sources: dict[str, str] = {}

    def get(self, tid: str, required: bool) -> Path | None:
        name = f"PUNKTSKY_1km_{tid}.laz"
        dest = self.dir / name
        m = self.m
        entry = self.r2.fetch_tile(dataset=m.DEFAULT_DATASET, release=m.UNKNOWN_RELEASE, tile=name, cache_dir=self.cache_dir)
        r2_bad = False
        if entry is not None and entry.path:
            os.replace(entry.path, dest)
            if verify_laz(dest):
                self.sources[tid] = "r2"
                return dest
            log(f"{name}: the R2 copy does not decode completely; using a fresh upstream download and NOT publishing it")
            dest.unlink(missing_ok=True)
            r2_bad = True
        if self.key is None:
            self.key = datafordeler_key()
        for attempt in range(1, 4):
            res = download_upstream(name, dest, self.key)
            if res is None and not required:
                self.sources[tid] = "absent"
                return None
            if res is not True:
                raise RuntimeError(f"{name}: not in R2 and Datafordeler download {'says it does not exist' if res is None else 'failed'}")
            if verify_laz(dest):
                break
            log(f"{name}: download attempt {attempt} does not decode completely")
            dest.unlink(missing_ok=True)
        else:
            raise RuntimeError(f"{name}: upstream download is incomplete after 3 attempts")
        if r2_bad:
            self.sources[tid] = "upstream-r2-corrupt"
            return dest
        self.r2.publish_tile(dest, dataset=m.DEFAULT_DATASET, release=m.UNKNOWN_RELEASE, tile=name,
                             provenance={"source": "datafordeler_prefetch", "workflow": "cph-twin-roofer", "verification": ["LASF_magic", "sha256_stream", "pdal_full_decode_count"]})
        self.sources[tid] = "published"
        return dest


# ---------------------------------------------------------------------------------------------------------- processing
def pdal(pipeline: list[dict], cfg: Path) -> None:
    cfg.write_text(json.dumps(pipeline))
    p = subprocess.run(["pdal", "pipeline", str(cfg)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"pdal failed: {p.stderr[-500:]}")


def scan_meta(laz: Path, tid: str) -> dict:
    out = subprocess.run(["pdal", "info", "--stats", "--dimensions", "GpsTime", str(laz)], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["stats"]["statistic"][0]
    return {"tile": tid, "count": s["count"], "gps_min": s["minimum"], "gps_max": s["maximum"],
            "scan_date_min": common.gps_to_date(s["minimum"]), "scan_date_max": common.gps_to_date(s["maximum"]),
            "scan_date": common.gps_to_date(s["average"])}


def process_cell(cell: str, store: Store, work: Path, jobs: int, force: bool) -> dict:
    t_start = time.time()
    if not force and store.exists(f"cells/{cell}/DONE.json"):
        log(f"{cell}: DONE marker present, skipping")
        return {"cell": cell, "skipped": True}
    store.delete_prefix(f"cells/{cell}/FAILED.json")
    doc = json.loads(store.get_bytes(f"cells-input/{cell}.json"))
    feats = doc["features"]
    n_own = sum(1 for f in feats if f["properties"].get("own"))
    log(f"{cell}: {n_own} own buildings, {len(feats)} footprints, {jobs} roofer jobs")

    wd = work / cell
    shutil.rmtree(wd, ignore_errors=True)
    (wd / "veg").mkdir(parents=True)
    lidar = Lidar(wd / "laz")
    own_laz = lidar.get(cell, required=True)
    t_dl = time.time()
    neighbours = {}
    for t in neighbour_tiles_needed(cell, feats):
        p = lidar.get(t, required=False)
        if p is not None:
            neighbours[t] = p
    log(f"{cell}: LAZ ready in {t_dl - t_start:.0f}s own + {time.time() - t_dl:.0f}s neighbours {sorted(neighbours)}: {lidar.sources}")

    meta = scan_meta(own_laz, cell)
    scan_year = int(meta["scan_date_max"][:4])
    fc, buildings = roofer_inputs(doc, scan_year)
    (wd / "footprints.geojson").write_text(json.dumps(fc))
    (wd / "roofer.toml").write_text(roofer_toml(scan_year, wd))
    manifest = {"tile": cell, "scan": meta, "buildings": buildings, "footprints": len(fc["features"]), "neighbour_tiles_read": sorted(neighbours)}
    (wd / "manifest.json").write_text(json.dumps(manifest))

    # vegetation rasters of the cell itself (one pass), then the roofer crop: own + neighbour strips -> merged cropped.laz
    t0 = time.time()
    if os.environ.get("VEG", "0") == "1":  # off by default: the 145 cells' rasters already exist locally (data/raw/veg)
        pdal(veg_pipeline(own_laz, cell, wd / "veg"), wd / "veg.json")
    e0, n0, e1, n1 = common.tile_bounds(cell)
    bounds = (e0 - MARGIN, n0 - MARGIN, e1 + MARGIN, n1 + MARGIN)
    parts = []
    for t, p in [(cell, own_laz)] + sorted(neighbours.items()):
        part = wd / f"part_{t}.laz"
        pdal(crop_pipeline(p, part, bounds), wd / f"crop_{t}.json")
        parts.append(part)
        if t != cell:
            p.unlink(missing_ok=True)
    if len(parts) == 1:
        os.replace(parts[0], wd / "cropped.laz")
    else:
        r = subprocess.run(["pdal", "merge", *map(str, parts), str(wd / "cropped.laz")], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"pdal merge failed: {r.stderr[-500:]}")
    for p in parts:
        p.unlink(missing_ok=True)
    own_laz.unlink(missing_ok=True)
    t_prep = time.time() - t0
    log(f"{cell}: veg + crop {t_prep:.0f}s")

    t0 = time.time()
    r = subprocess.run(["roofer", "-c", str(wd / "roofer.toml"), "-j", str(jobs), str(wd / "out")], capture_output=True, text=True)
    t_roofer = time.time() - t0
    rlog = r.stdout + r.stderr
    outs = sorted((wd / "out").glob("*.jsonl"))
    (wd / "roofer.log.gz").write_bytes(gzip.compress(rlog.encode()))
    if r.returncode != 0 or not outs:
        raise RuntimeError(f"roofer rc={r.returncode}, {len(outs)} outputs: {rlog[-600:]}")
    log(f"{cell}: roofer {t_roofer:.0f}s rc={r.returncode}")

    base = f"cells/{cell}"
    store.put_file(f"{base}/manifest.json", wd / "manifest.json")
    store.put_file(f"{base}/footprints.geojson", wd / "footprints.geojson")
    store.put_file(f"{base}/roofer.toml", wd / "roofer.toml")
    store.put_file(f"{base}/roofer.log.gz", wd / "roofer.log.gz")
    for p in outs:
        store.put_file(f"{base}/out/{p.name}", p)
    for p in sorted((wd / "veg").glob("*.tif")):
        store.put_file(f"{base}/veg/{p.name}", p)
    n_feat = sum(1 for p in outs for line in open(p) if '"CityJSONFeature"' in line)
    done = {"cell": cell, "finished": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "task_s": round(time.time() - t_start, 1), "download_s": round(t_dl - t_start, 1), "prep_s": round(t_prep, 1),
            "roofer_s": round(t_roofer, 1), "jobs": jobs, "own_buildings": n_own, "footprints": len(feats), "roofer_features": n_feat,
            "scan_date": meta["scan_date"], "lidar": lidar.sources,
            "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024),
            "image": os.environ.get("IMAGE_REF", "")}
    store.put_bytes(f"{base}/DONE.json", json.dumps(done, indent=1).encode())
    shutil.rmtree(wd, ignore_errors=True)
    log(f"{cell}: done in {done['task_s']:.0f}s")
    return done


def main() -> int:
    bucket = os.environ.get("BUCKET", "lun-integrations-dev-cph-twin")
    store = Store(os.environ.get("STORE_DIR") or f"gs://{bucket}")
    cell = os.environ.get("CELL")
    if not cell:
        uri = os.environ.get("CELLS_URI", "config/cells.txt")
        text = (Store(uri.rsplit("/", 1)[0]).get_bytes(uri.rsplit("/", 1)[1]) if uri.startswith("gs://") else store.get_bytes(uri)).decode()
        cell = pick_cell(text, int(os.environ.get("CLOUD_RUN_TASK_INDEX", "0")))
    jobs = int(os.environ.get("ROOFER_JOBS") or os.cpu_count() or 4)
    try:
        process_cell(cell, store, Path(os.environ.get("WORK", "/work")), jobs, os.environ.get("FORCE") == "1")
        return 0
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        print(tb, file=sys.stderr, flush=True)
        try:
            store.put_bytes(f"cells/{cell}/FAILED.json", json.dumps({
                "cell": cell, "when": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "attempt_error": str(e)[:1500], "traceback": tb[-3000:]}).encode())
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
