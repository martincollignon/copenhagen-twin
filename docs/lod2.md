# LoD2 roofs (M4): `data/lod2/`

Pitched roofs for the Copenhagen buildings, reconstructed by [roofer](https://github.com/3DBAG/roofer) 1.1.0-beta.1 from the DHM Punktsky point cloud. Kept apart from `data/cph-geodata.json` on purpose: the engine joins the two by building id, so the geodata compiler never has to know about LoD2. Design and numbers: `docs/research/roofer-citywide.md`; per-run QA: `data/lod2/report.md`.

## Pipeline (`tools/lod2/`, `uv run --project tools/lod2 python tools/lod2/<step>.py`)

| step | does |
|---|---|
| `fetch.py [--bbox minE minN maxE maxN]` | 1 km Punktsky LAZ tiles covering the bbox (default: the district) into `data/raw/lod2/` (gitignored, resume-safe, API key from Secret Manager via ADC). Pass the municipality bbox for the whole commune. |
| `prep.py` | per tile: footprints (own tile plus a 25 m margin of neighbours, which are only LoD1.1 context), PDAL crop of classes 2+6 with the neighbours' points, `roofer.toml` with the scan year. BBR `year` after the scan year marks the roof `inferred`. |
| `run.py` | roofer in Docker, tiles in parallel. |
| `convert.py` | CityJSONSeq LoD2.2 -> `data/lod2/<tile>.bin` + `index.json` (local frame, cm, int16/uint16). Layout in the module docstring. |
| `qa.py` | `data/lod2/report.md`. |

## Contract

`index.json`: `{version: "lod2/1", frame, src, tiles: {tile: {file, bytes, scan_date}}, buildings: {"gdk:<id>": entry}}`. A measured entry has `tile, offset, length, conf: "measured", roof_type, planes, rmse, density, nodata, scan_date, closed`; an entry without `offset` has `conf: "inferred"` and a `reason` (built after the scan, too little coverage, roofer failure ...) and the engine keeps the flat extrusion.

Engine (`js/lod2-geometry.js`, `js/building-geometry.js addBuilding`): the roofer roof replaces the flat deck; the footprint-extruded facade walls (facade shader attributes) stay but end at the roofer eave of each footprint edge (`top`); roofer wall triangles survive only above that eave (gables) or as inner step walls, drawn as plain masonry. `?debug=nolod2` disables it for before/after comparisons.
