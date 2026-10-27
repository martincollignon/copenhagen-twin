# cph-roofer: citywide LoD2.2 roofs on Cloud Run Jobs

One Cloud Run Job task per 1 km Punktsky cell (145 cells of Københavns + Frederiksberg Kommune). Each task gets the cell's LAZ (shared R2 LiDAR cache first),
crops classes 2+6 with a 25 m margin from the neighbouring cells, and runs roofer 1.1.0-beta.1 (LoD2.2) exactly as `tools/lod2/prep.py` + `run.py` do for the district.

## Resources (project `lun-integrations-dev`, `europe-west1`, all labelled `app=cph-twin`)

| what | name |
|---|---|
| bucket | `gs://lun-integrations-dev-cph-twin` (uniform access, public access prevented, `scratch/` deleted after 30 days) |
| Artifact Registry | `europe-west1-docker.pkg.dev/lun-integrations-dev/cph-twin/cph-roofer` (image pinned by digest in the job) |
| Cloud Run Job | `cph-roofer`: 4 vCPU / 16 GiB, timeout 3 h, maxRetries 2, parallelism 30, gen2 |
| runtime SA | default compute SA `368722833767-compute@developer.gserviceaccount.com`: secretAccessor on `datafordeler-graphql-api-key` (lun-integrations-dev) and on `dk-lidar-r2-access-key-id` / `dk-lidar-r2-secret-access-key` (project `integrations-484814`, granted for this job), objectAdmin on the bucket |
| secrets | Datafordeler key mounted from Secret Manager as env (never logged); R2 credentials are read in-process via ADC (`R2_SECRET_PROJECT`) |

Bucket layout: `cells-input/<cell>.json` (from `data/city/cells-input`), `config/cells.txt` (task index -> cell), `cells/<cell>/{DONE.json|FAILED.json, manifest.json, footprints.geojson, roofer.toml, roofer.log.gz, out/*.jsonl}`, `scratch/build/` (Cloud Build sources).

## LAZ resolution (R2 contract)

Per tile: R2 (`lidar_r2.py`, dataset `punktsky`, release `source-version-unknown`, SHA-256 index, write-once) -> only if missing Datafordeler (`GetPointCloudFile`), then published to R2
before processing. Added here: every tile is fully decoded with PDAL and its point count compared with the header before it is used or published (the R2 contract itself only
checks the LASF magic and the SHA, which accept a truncated download). A tile in R2 that does not decode is not used (fresh upstream download, not republished, marked
`upstream-r2-corrupt` in `DONE.json`). `lidar_r2.py` / `r2_credentials.py` are vendored unchanged (header says from where).
Neighbour tiles are only fetched when a footprint reaches into their 25 m strip; neighbours that do not exist upstream (sea) are skipped.

## Operate (`python3 tools/cloud/roofer/cloudctl.py <cmd>`, needs `gcloud auth application-default login`)

```
infra      bucket + repo (idempotent)            build     Cloud Build linux/amd64 -> prints the digest
inputs     upload data/city/cells-input          deploy    [--digest sha256:..] [--parallelism N]
run        [--cells A B ..] [--force]            status    last execution
report     DONE/FAILED, task-hours, cost, R2 vs published   sync  [--cells ..] -> data/raw/lod2-out/<cell>/{manifest.json,out/*.jsonl}
cancel     stop running executions               delete --yes   job + repo + bucket
```

Rerun: `run` skips cells with a `DONE.json`; `run --cells <failed...>` retries just those (`--force` recomputes). The vegetation rasters are off (`VEG=1` turns them on; they already exist
locally for all cells); the task writes them to `cells/<cell>/veg/` in the `data/raw/veg` naming. Image changes: edit, `build`, `deploy --digest <new>`.
Tests: `uv run --with pytest python -m pytest tools/cloud/roofer/tests`. Local run of the exact image: build `Dockerfile` from `cloudctl.stage()` output and run with
`STORE_DIR=/store CELL=<cell>` plus mounted ADC (see the head of `task.py`).

## Delete everything

`python3 tools/cloud/roofer/cloudctl.py delete --yes` removes the job, the Artifact Registry repo and the bucket with its objects. It does not touch the R2 cache or any secret.
The IAM grants on the two R2 secrets in `integrations-484814` can be removed separately (Secret Manager, `roles/secretmanager.secretAccessor` for the compute SA).

## Cost

Cloud Run Jobs (tier 1) 0.000024 USD per vCPU-s and 0.0000025 per GiB-s: 4 vCPU / 16 GiB = 0.49 USD per task-hour. Tasks are download-bound (Datafordeler ~1 MB/s per stream);
roofer itself takes about 1 minute per cell at -j 4.

## Handoff

`sync` writes the tools/lod2 work layout `data/raw/lod2-out/<cell>/{manifest.json,out/*.jsonl}` that `build_city.py --stage lod2` (`city_layers2.lod2_cell_job`, which calls `convert.convert_tile`) reads.
See `data/city/lod2-coverage.md` for the run's numbers.
