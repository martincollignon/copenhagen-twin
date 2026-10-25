# City-wide LoD2.2 roofs with `roofer`: how 3DBAG does it, and how we do Copenhagen (and Denmark)

Status: research + spike, 2026-10-25. Not committed. Spike files: `docs/research/roofer-spike/` (large outputs gitignored).

## 1. How 3DBAG produces the Netherlands model

Sources (all fetched and confirmed to exist on 2026-10-25):

- Pipeline repo: <https://github.com/3DBAG/3dbag-pipeline> (default branch `develop`; docs at <https://innovation.3dbag.nl/3dbag-pipeline/>). Raw docs read: `docs/data_flow.md`, `docs/production.md`, `docs/source_datasets.md`, `packages/core/src/bag3d/core/assets/reconstruction/reconstruction.py` (same repo, `develop`).
- Reconstructor: <https://github.com/3DBAG/roofer> (GPL-3.0; docs <https://innovation.3dbag.nl/roofer/>). Latest release `v1.1.0-beta.1` (2026-07-30), Docker image `3dgi/roofer:v1.1.0-beta.1` (pulled, arm64 works).
- Paper: Peters et al., *Automated 3D reconstruction of LoD2 and LoD1 models for all 10 million buildings of the Netherlands*, PE&RS 88(3), <https://arxiv.org/abs/2201.01191>.
- `docs.3dbag.nl` did not respond from here (connection refused), so nothing below depends on it.

**Orchestration.** Dagster (Python), almost all heavy work is done by external tools. Stages hand data to each other through the filesystem (`stages/<name>/...`), with PostgreSQL/PostGIS as side store for footprints, AHN tile metadata and tile membership. Jobs in order (`docs/production.md`): `bgt` -> `ahn_tile_index` -> `ahn3/4/5/6` (download LAZ, partitioned by AHN tile) -> `ahn_metadata_index` -> `source_input` (BAG + TOP10NL, tiling) -> `reconstruct` (partitioned by tile) -> `export` (tyler) -> `deploy` -> `release`. Extension packages add party walls and floor estimation.

**Tiling.** A quadtree over the footprints, not over the point cloud: leaves hold at most 3500 buildings, so per-tile work and per-tile download size are balanced (paper section 4.1). The same tiles are used for reconstruction, download and 3D Tiles. Tile output lands at `stages/reconstruction/{z}/{x}/{y}/<tile>.city.jsonl`. Each tile is one `roofer --config roofer.toml <outdir> -j 10` invocation; footprints come from a PostGIS view of the tile, and the LAZ list is the AHN tiles intersecting the tile's buildings.

**Input prep and time mismatch.** BAG footprints (monthly national extract, dropped and rebuilt each run; `oorspronkelijkbouwjaar` passed as `yoc-attribute`), TOP10NL to flag greenhouses and warehouses (forced to LoD1.1), AHN 3/4/5/6 LAZ. The config lists all AHN versions as separate `[[pointclouds]]` with a `quality` rank; roofer picks per building: the newest cloud when the building was mutated, otherwise the one with best coverage. It writes `b3_mutatie`, `b3_pw_bron`, `b3_pw_datum`, `b3_pw_selectie_reden`, `b3_nodata_fractie`, `b3_puntdichtheid` per building. The docs warn that buildings built after the scan are missing or wrong.

**Outputs.** Per building LoD1.2, 1.3 and 2.2 (`lod12/lod13/lod22 = true`), as CityJSONSeq per tile. Export via tyler: per-tile CityJSON, GeoPackage, OBJ, a national GeoPackage, and OGC 3D Tiles for each LoD. Quality attributes per building: `val3dity_lod*` (validity code produced inside roofer), `rmse_lod*`, `volume_lod*`, roof type, plane count, ridge height.

**Compute (published).** Paper: 10 M buildings in about 40 h with 30 concurrent processes on one machine (2 x Xeon E5-2650, 128 GB), i.e. about 0.4 core-seconds per building for all three LoDs, with an older roofer. `docs/production.md`: full pipeline for a single AHN tile needs about 70 GB scratch and 1-2 h. Cost scales linearly with building count (buildings are independent).

**Cadence.** Driven by BAG (monthly extract on the 8th) and by AHN releases (a sensor re-triggers downloads when PDOK changes checksum files). I could not confirm a fixed 3DBAG release schedule; do not quote one.

## 2. Mapping to Denmark

| 3DBAG | Denmark |
|---|---|
| BAG footprints | GeoDanmark *Bygning* (we already hold `gdk:<id>` in `data/cph-geodata.json`), BBR for year/use/storeys |
| AHN LAZ, ~8 pts/m2 | DHM *Punktsky*, classified LAZ in 1 x 1 km tiles `PUNKTSKY_1km_<N km>_<E km>.laz`, EPSG:25832 + DVR90 |
| Mutation / year of construction | BBR opførelsesår and ombygningsår as `yoc-attribute`, plus pointcloud acquisition date |
| Quadtree of 3500 | Use the 1 km Punktsky grid as the unit (one tile = one roofer run), cap by building count |
| Greenhouse / warehouse LoD1 fallback | BBR use codes, area threshold (`lod11-fallback-area`) |

### Punktsky access (verified today)

- The LAZ tile **download via the Datafordeler FileDownloads API still works**. I downloaded `PUNKTSKY_1km_6176_723.laz` with `GET https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey=...&FileName=PUNKTSKY_1km_6176_723.laz`: HTTP 200, 147 MB, 136 s (about 1 MB/s for one stream). This is the call in `internal/fetcher/sources/lidar/lidar.go` (`downloadTile`).
- **Auth: an API key is required for point clouds; service-user username/password cannot be used** (Datafordeler doc "Fildownload på Datafordeleren", <https://confluence.kds.dk/x/CVUPCQ>, v3.3, modified 2026-09-28). The same page says service-user (web user) access and Filudtræk end **2027-01-15**. The key is `datafordeler-graphql-api-key` in Secret Manager.
- Filudtræk for raster and point cloud ended **2026-04-29**; only the tabular Filudtræk remains until 2027-01-15 (<https://confluence.kds.dk/pages/viewpage.action?pageId=25722925>). Fildownload replaces it.
- The docs also describe `GetPointCloudMultipleFiles` / `GetPointCloudMultipleSize` (bbox, register `dhm`, dataset `punktsky`), delivering ZIPs of 10 x 10 km groups of 1 x 1 km tiles. I did not exercise these, and one transition guide shows a raster method name for the point cloud example, so verify against the live API before scripting. The per-tile `GetPointCloudFile` call is the proven path.
- Terms: DHM is described as freely available data, but I did not find the licence text. Read the Datafordeler terms before publishing derived tiles (attribution is already in `cph-geodata.json`).
- **Not verified**: the Punktsky rescan cycle. Searches returned nothing current. The tile I downloaded has GPS times on **2019-04-07** (sampled via pdal stats), which is 7 years old, so recently built Copenhagen blocks (Nordhavn, Ørestad infill) will be missing. Ask KDS or check the Dataforsyningen product page before promising a cadence.

### What the existing parcel-level code does (`dk-building-data`, worktree `kolkata-v4`)

- `cmd/twinviz/lidar.go`: `fetchPunktskyLAZ` downloads the one 1 km tile covering a coordinate (~150-400 MB), cached as `PUNKTSKY_<N>_<E>.laz`. Cache dir `~/.cache/dk-lidar/` holds six tiles now.
- `cmd/twinviz/lod2_roofer.py`: runs once per export extent. (1) PDAL pipeline crops the tile to the bbox and keeps classes 2 (ground) and 6 (building); (2) writes a `roofer.toml` and runs `docker run 3dgi/roofer:v1.1.0-beta.1 --id-attribute id --lod22 <laz> <footprints.geojson> <out>` with footprints as an EPSG:25832 GeoJSON having a string `id`; (3) reads `*.city.jsonl`, takes the LoD2.2 geometry of `BuildingPart` children, ear-clips faces into triangle soup tagged roof/wall/ground; (4) returns `ridgeZ`. Failure-tolerant (empty result plus warning).
- `cmd/twinviz/collage_lod2.go`: `runRooferBatch` calls the script, `convertRooferBuilding` moves vertices to the local frame, fixes winding and classifies triangles (tested in Go).
- What tiling needs: it is already batch-per-extent, so a city run is mostly a loop over tiles. Changes: iterate tiles, take footprints per tile, skip the per-parcel DSM comparison, write output per tile instead of JSON for a collage, drop interior-ring dropping (hole support), pass pointcloud date and BBR year, and run N Docker containers in parallel (the script currently shells out per run with `--platform` guess). The Go glue is not needed for the twin; a Python tool in `cph-twin` is simpler.

## 3. Estimates

Measured inputs from the spike (section 4): **0.05 core-s per building** for LoD2.2 only (roofer-reported `t_run` summed 27.9 s for 573 buildings, matches wall-clock 10 s on 3 threads). 3DBAG's published 0.4 core-s per building (3 LoDs, older CPUs and roofer) is the conservative bound. Dense central Copenhagen buildings are slower (p90 136 ms, max 1.4 s per building), so budget 0.1 core-s as base and 0.5 as pessimistic.

Assumptions marked (est.) are not measured: tile counts, average LAZ size, price per core-hour, download parallelism.

| | Københavns Kommune | Denmark |
|---|---|---|
| Footprints | ~144k incl. small (given) | ~4-5 M (given) |
| 1 km LAZ tiles | ~110-130 (est.; land footprint ~90 km2 plus edges) | ~43-46 k (est.) |
| LAZ download | ~20-30 GB (tiles 150-250 MB; my tile 147 MB, cached tiles 170-400 MB) | ~3-5 TB (est.; rural tiles are lighter, so ~70-110 MB average) |
| Download time at 1 MB/s per stream | ~6 h serial, <1 h with 8 streams | ~50 days serial; ~3-5 days with 16-32 streams if the API allows (unmeasured) |
| Roofer CPU | 144k x 0.05-0.5 s = **2-20 core-h** | 4.5 M x 0.05-0.5 s = **60-625 core-h** |
| PDAL class filter + crop | 6 s per tile (measured, 13 M points) = ~0.2 core-h | ~45 k x 3-6 s = ~40-75 core-h |
| Wall-clock | under 1 h on 8 cores after download | ~1-3 days on 32 cores after/while downloading |
| Cost (est. $0.03-0.08 per vCPU-h on Hetzner/RunPod CPU) | **well under $5** compute | **~$5-60** compute; the cost is bandwidth and engineering, not CPU |
| Raw LAZ storage | ~25 GB, delete after crop | ~4 TB if kept; stream tile by tile instead (crop to class 2+6 is 22% of size: 147 -> 32 MB) |
| Output | CityJSONSeq 4.1 KB/building (measured 2.37 MB for 573) = ~0.6 GB raw, ~0.15 GB gz; glTF similar order | ~18 GB raw, ~5 GB gz |
| Update cadence | tied to Punktsky rescans (unknown, tile is 2019) and GeoDanmark/BBR changes; re-run only tiles whose footprints changed | same |

Hardware notes: roofer on the Colima VM (4 CPUs, 7.7 GB) used 3 worker threads; memory was no problem for 573 buildings. 3DBAG uses `-j 10` per tile with a 3500-building cap. A 1 km Copenhagen tile has 500-3000 buildings, so the 3500 cap fits our 1 km grid.

## 4. Spike: roofer on the tile containing Nørre Søgade 37

Tile `PUNKTSKY_1km_6176_723.laz` (E 723-724 km, N 6176-6177 km): 12,996,282 points (13 pts/m2), 147 MB, acquired 2019-04-07 (sampled GPS times), EPSG:25832 + DVR90.

Steps (all in `docs/research/roofer-spike/`): `dl_tile.sh` (download), `prep.py` (573 footprints from `cph-geodata.json`, fully inside the tile with 10 m margin, local frame back to EPSG:25832, `id` = GeoDanmark id), `crop.json` (pdal: keep classes 2 and 6, 6 s), Docker `3dgi/roofer:v1.1.0-beta.1 --id-attribute id --lod22 -j 4`, `analyze.py`.

Result:

- **Runtime**: 16 s wall for the roofer run (crop 3.8 s, analyse 2.1 s, reconstruct 9.7 s on 3 threads) for 573 buildings; summed per-building `t_run` 27.9 s (median 8 ms, p90 136 ms, max 1.36 s).
- **Coverage**: 573/573 reported `success`; 512 got LoD2.2 geometry. 61 skipped extrusion, of which 50 are under 25 m2 (sheds, median 5 m2). Of the 512: 401 `slanted`, 106 `horizontal`, 4 `multiple horizontal`; some `unknown`/`no planes`/`no points` have no LoD2.2. 102 buildings had `HIGHEST_YET_INSUFFICIENT_COVERAGE` (nodata gaps).
- **Heights vs our DSM-derived values** (n = 511; absolute DVR90 in both, ours from `eave`/`ridge` in `cph-geodata.json` + 6.84 offset):
  - roofer ridge (`h_roof_max`) minus DSM ridge: median +0.08 m, MAE 1.65 m, p90 5.4 m. LoD2.2 mesh max z minus DSM ridge: median +0.07 m, MAE 1.65 m.
  - roofer roof p50 minus DSM eave: median -0.32 m, MAE 1.42 m (our eave is a DSM percentile, not a true eave, so this is a definition gap).
  - roofer ground minus DTM ground: median -0.23 m, MAE 0.39 m.
  - The MAE tails are probably DSM-percentile artefacts for large or complex roofs (our DSM approach is the cruder one), but I did not hand-inspect individual buildings. Treat roofer as at least as good, not proven better.
  - 405/511 have non-horizontal roofs. Only 12 buildings have DSM ridge-eave over 1.5 m yet came out horizontal. So roofer finds pitched roofs where our "flat at eave" extrusion has none.
- **Roofer's own rmse** (`rf_rmse_lod22`): median 1.00 m, p90 2.96 m. That is high; I did not establish its definition or units, so do not use it for gating until checked. Plane count median 2, p90 22, max 115 (large complex blocks).
- **Wall geometry**: 13,745 LoD2.2 wall faces; 66% have their bottom edge exactly on a footprint edge (<0.15 m). The remainder are inner step walls between roof levels (or from footprint simplification).
- **Not done**: no visual comparison against Skråfoto overlays and no val3dity run. `pc_year` printed 2026 because I gave roofer no acquisition date (so mutation logic was off). Output ~2.4 MB for the tile.

Disk: `raw/` 141 MB, `work/` 33 MB.

## 5. Recommended architecture for the twin

**Tile unit = DHM 1 km tile.** Tile id `N_E` (e.g. `6176_723`) as in the Punktsky name. Footprints assigned to the tile containing their centroid, so every building is reconstructed exactly once; a building's points may spill across a tile edge, so crop LAZ with a 25 m margin from the 8 neighbours (reading neighbour tiles costs download but avoids cut roofs). The district (1.5 x 1.5 km) touches about 4-6 tiles; the whole commune ~120.

**`tools/lod2/` pipeline** (Python, idempotent per tile, content-hashed in a manifest):

1. `fetch_tiles.py`: Datafordeler `GetPointCloudFile` with API key (secret `datafordeler-graphql-api-key` via `tools/adc-secret.sh`), parallel 4-8 streams, retries, resume. Skip existing.
2. `prep_tile.py`: PDAL crop (tile + margin) and class filter 2/6 -> `work/<tile>/cropped.laz`; footprints from `cph-geodata.json` (later from GeoDanmark directly) -> GeoJSON with `id`, plus BBR `opførelsesår` for `yoc-attribute`. Record the acquisition date from GpsTime and pass it to roofer's pointcloud config (check the roofer docs for the exact key) so mutated/new buildings are flagged.
3. `run_roofer.py`: `docker run 3dgi/roofer:v1.1.0-beta.1 ... -j N`, one container per tile, pinned image digest. Keep roofer's `rf_*` quality attributes.
4. `convert.py`: CityJSONSeq -> per building roof/wall mesh; reuse the triangulation in `dk-building-data/cmd/twinviz/lod2_roofer.py` (copy, do not import; read-only repo). Output **our geodata field** plus a binary.
5. `qa.py`: compare roofer ridge/ground with DSM/DTM (the numbers above), run val3dity on a sample, count buildings with `rf_success=false`, `no points`, low density, and report tile-level percentages.
6. `merge.py`: write results into `data/cph-lod2/<tile>.json` + `.bin`, and a top-level `index.json` (building id -> tile, hash).

**Data contract (additive to `cph-geodata.json`, no change to current fields).** Keep the main JSON small: buildings get a pointer, geometry lives in per-tile binaries.

```json
"roof_mesh": {
  "tile": "6176_723", "offset": 123456, "len": 4096,
  "type": "slanted", "planes": 3,
  "src": ["roofer:1.1.0-beta.1", "punktsky:2019-04-07"],
  "conf": "measured",
  "q": {"rmse": 0.41, "density": 13.0, "nodata": 0.04, "val3dity": 0}
}
```

`roof` (`flat|pitched|...`) is filled from roofer's `rf_roof_type`; `eave`/`ridge` stay for the fallback path. `conf: measured` only when `rf_success` and density/nodata pass; else `inferred` and the current flat extrusion remains. Roofer's LoD2.2 mesh is sometimes cut off in the data (`no points`, `skip`), so the fallback must stay.

**Engine (three.js).** Mesh binary per tile: indexed triangle arrays (`Uint32` index, `Float32` positions relative to the building origin in the local frame) with per-triangle `kind` (wall/roof/ground) and for walls the owning footprint `edge`. The engine already streams buildings by quadtree; load the tile binary when a building's quadtree cell becomes visible, build one `BufferGeometry` per building (or merged per cell with per-attribute `buildingId`), and keep the extruded fallback when `roof_mesh` is absent. Because 3D Tiles/glTF is the standard unit when a viewer must stream, consider emitting `3dtiles` later via tyler (same tool 3DBAG uses); for the single-city twin the custom binary is simpler and avoids a tile server.

**Facade parameters on LoD2 walls.** `cph-geodata.json` keys `facade` and `observed.walls[]` by ring `edge`. In the spike, 66% of roofer wall faces sit exactly on a footprint edge. Plan:

1. For each roofer wall face, find its bottom edge (vertices within 5 cm of the face's minimum z), and match to the nearest ring edge (<0.15 m, collinear). That face inherits `edge`.
2. Inner step walls (the other 34%) are not exposed facades: give them `edge = -1` and use the building's `facade.tone` with `conf: inferred`. When a roof-height step splits one footprint edge into several wall faces, all share the edge's `u` coordinate frame; compute `u` along the footprint edge, not along the face, so window rhythm stays continuous across the split.
3. Gable and mansard end walls (the triangle above the eave) belong to the same `edge`; the facade shader should clamp window rows to the eave height and use the upper part as plain wall.
4. Roofer simplifies and buffers footprints internally; keep our ring as the authority for wall frames and only use roofer for roof surfaces and eave heights if the match fails.

**Provenance and honesty.** Add `roofer` version, Punktsky tile and acquisition date to `src`. Show roof source and scan year in the info panel; a building built after 2019 must show `inferred`. Suggested rule: if BBR `opførelsesår` or `ombygningsår` is after the scan year, or `nodata_frac` above 0.3, or density under 4 pts/m2, mark the roof `inferred` and keep the flat extrusion.

**Staging.** (1) Run the full 6176_723 tile through steps 2-6 and render side by side with the flat version on NS37's block (half a day). (2) Tiles covering the 1.5 x 1.5 km district. (3) Kommune. (4) Denmark only if there is a product need: CPU cost is trivial, bandwidth (~4 TB) and a licence read are the real work.

## Open items

- Confirm Punktsky rescan cycle and the newest scan year per tile with KDS.
- Exercise `GetPointCloudMultipleFiles` for 10 x 10 km ZIPs and measure parallel throughput.
- Find roofer's pointcloud date key and test mutation handling with BBR years.
- Check what `rf_rmse_lod22` measures (median 1.0 m looks too high for a good fit).
- Skråfoto overlay and val3dity QA of the spike output.
- 15 Jan 2027: service-user access and tabular Filudtræk end; our point cloud path uses the API key, so it should not be affected, but confirm the key stays valid.
