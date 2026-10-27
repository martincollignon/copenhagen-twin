# Copenhagen Twin

A walkable, drivable and bikeable real-time 3D twin of Søerne and inner Nørrebro in Copenhagen (about 1.5 × 1.5 km around Nørre Søgade, Dronning Louises Bro, Peblinge Sø and Blågårds Plads), built with [three.js](https://threejs.org/) WebGPURenderer and TSL.

- Buildings at their real footprints and heights (GeoDanmark *Bygning*, BBR, DHM), with facades driven by measured parameters.
- Real streets, cycle tracks and signals, with cars, buses, pedestrians and cyclists on the real road graph, stopping for signal plans.
- Four ways to move: on foot, by car, by bicycle and by helicopter. Cameras, time of day and teleport presets (Nørre Søgade 37, Dronning Louises Bro, Peblinge Sø, Nørrebrogade, Blågårds Plads). Speeds are shown in km/h.
- Nørre Søgade 37 can be inserted as a drawing-accurate hero building.

Status and plan: [docs/PLAN.md](docs/PLAN.md). Data format: [docs/cph-geodata-schema.md](docs/cph-geodata-schema.md).

## Run it

You need a browser with WebGPU (current Chrome, Edge or Safari Technology Preview) and Python 3 for a static file server.

```sh
bash tools/link-heroes.sh        # optional: links the hero glTFs named in data/cph-geodata.json into data/heroes/
python3 -m http.server           # then open http://localhost:8000/
```

Useful query parameters: `?debug=footprints` draws the geodata's buildings, water and parks as flat polygons, `?debug=nobuildings` and `?debug=noroads` skip those layers, `?hooks` exposes the running scene as `globalThis.__twin` for headless checks.

`?water=simple` drops the planar reflection pass of the lakes (sky reflection only), `?debug=nowater` shows the plain ground, `?debug=nocal` the uncalibrated facade tones.

Lighting uses 26 October 2026 in Europe/Copenhagen: Golden Hour at 16:10, Midday at 12:00, Blue Hour at 17:20, and Night at 23:00. The solar position follows NOAA equations with the local UTM grid correction; the sun switches off below the horizon. AgX tone mapping and restrained saturation keep the sky and water pale.

| Query | Behaviour |
|---|---|
| `?date=2026-06-21` | Changes the scene date, retaining each preset's local clock time; CET/CEST is handled automatically. |
| `?time=12:00` | Overrides the solar clock time; the selected preset still supplies its lighting mood. |
| `?sky=overcast` | Broken overcast clouds, reduced sunlight, more daylight sky fill, and wetness 0.35. Clear remains the default. |
| `?wet=0.7` | Overrides ground wetness from 0 to 1; clear presets default to dry. |
| `?ao=1` | Enables half-resolution GTAO at 0.6 strength. It remains opt-in pending a GPU cost measurement. |

Citywide (the streamed tile index): every harbour basin, canal, lake and pond that is not one of the Soerne is generic water, a post-process like the far layer: `uv run tools/cph-geodata/city_water.py --fetch` (GeoDanmark soe / bassin / rekreativtomraade / begravelsesomraade / skov and OSM landuse into `data/raw/city/water/`, once) and `uv run tools/cph-geodata/city_water.py` write `data/city/water.json` and a `water` layer per tile (surface, quay walls or banks, the ground cut under the water, parks as grass). The Soerne stay the district's hand-made lakes. Details and limits: `docs/citywide-plan.md` (C4). `?water=simple` drops the planar reflection here too, `?debug=nowater` shows the ground without any water.

Water levels come from the DTM over the lakes. `data/cph-lakes.json` stores basin polygons and their measured levels, allowing basins separated by bridges to keep distinct elevations while nearby levels snap together. Lake outlines cut through the terrain or ground mesh; developed shores use quay walls and coping, while natural shores use bank geometry. A shared ground-field shader shades fine gravel along the lake edge and grass over measured park areas.

Capture and benchmark the atmospheric changes on a machine that permits a local browser/server:

```sh
uv run --with playwright python tools/shoot-m2.py --water --out .context/after-water
uv run --with playwright python tools/shoot-m2.py --water --query 'sky=overcast&wet=0.35' --out .context/after-overcast
uv run --with playwright python tools/shoot-m2.py --audit-sweep --out .context/after-atmos-sweep
uv run --with playwright python tools/shoot-m2.py --perf --query 'ao=0'
uv run --with playwright python tools/shoot-m2.py --perf --query 'ao=1'
```

The lead supplied browser captures for visual review: the lake benchmark recorded 37.7 FPS with planar reflection and 47.3 FPS with sky-only water. These measurements precede the subsequent shader, haze and coping-join corrections. This implementation sandbox still denies the screenshot server's localhost socket bind, so those corrections need a fresh browser capture. GTAO cost remains unmeasured: compare the two unthrottled `--perf` runs at 1440×900 before enabling it by default; its additional frame cost must stay below 2 ms. The water captures preserve `--query` overrides and switch the lighting and colour grade together through the preset UI.

Wet ground supplies its SSR weight through material context, which only the main scene MRT consumes. Material-level MRT overrides cannot be used here: the planar reflection target has an unnamed colour attachment and would produce an empty WGSL output structure. `tools/shader-pass-matrix.mjs` checks canvas, planar reflection, main MRT, partial normal/depth output, and Three's shadow-map override, including contact effects and colour-write/output overrides. With the matching Three bundles and loader cached locally:

```sh
node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/shader-pass-matrix.mjs
```

Clear midday haze uses density 0.00013 (about 12% attenuation at 1 km) and caps fog in-scatter luminance at 0.48 scene-linear to prevent the HDR sun lobe from washing out buildings.

Tests (Node 20+, no dependencies):

```sh
node --test tests/*.cjs tests/*.mjs
```

Headless browser check (Playwright; boots the twin, asserts the HUD and console, writes screenshots to `docs/cleanup/`):

```sh
uv run --with playwright python tools/shoot-m2.py --verify --query hooks --out docs/cleanup
```

Facade look: photo walls are on by default between about 14 m and 150 m of the camera (procedural brick, plaster and windows closer, tone + procedural beyond; `?tex=0` turns the photos off). They need `data/tex/` (photo atlases) and the processed `data/tex-look/` (`uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_look.py`); without them the twin falls back to the procedural facades. Ground-floor shopfronts come from `data/cph-groundfloor.json` (`uv run --with requests --with pyproj python tools/cph-geodata/groundfloor.py`). Facade shots: `uv run --with playwright python tools/shoot-look.py --out docs/look/facades/x [--perf]`.

## Rebuild the data

`data/cph-geodata.json` is generated and never edited by hand:

```sh
uv run tools/cph-geodata/build.py --env-file <path>   # a .env with DHM_TERRAIN_TOKEN (or GSEARCH_TOKEN) for DHM heights
```

Raw downloads are cached under `data/raw/`, so reruns are offline. See `tools/cph-geodata/build.py` for options. `tools/cph-geodata/frame.py` is the one place for the origin, the district bbox and the 500 m tile grid; compiler steps accept `--bbox` / `--tile` for another area.

The twin loads per-tile layers when `data/tiles/index.json` exists (generated, gitignored, otherwise the files above are used):

```sh
uv run tools/cph-geodata/tile_split.py   # data/cph-*.json + data/lod2 -> data/tiles/<e500>_<n500>/, data/city/ (format: docs/cph-geodata-schema.md)
```

The whole of Københavns + Frederiksberg Kommune (496 tiles, `data/city/tiles.json`) is compiled by one resumable script that writes the same tile format directly:

```sh
uv run tools/cph-geodata/build_city.py --workers 4            # all stages; secrets come from tools/adc-secret.sh (never printed)
uv run tools/cph-geodata/build_city.py --stage cells --cells 6176_723   # one 1 km cell; every stage and cell has a done-marker under data/city/work/state/
uv run tools/cph-geodata/build_city.py --stage vegetation --veg-limit 20 --veg-workers 6   # LiDAR + CIR streamed per cell, then deleted
```

Stages: `fetch fetch2` (citywide sources, cached in `data/raw/city/`), `buildings0`, `geo` (roads, one connected road graph, points), `cells` (DHM heights and terrain per 1 km cell), `surfaces furniture groundfloor streets entrances vegetation`, `index`, `report` (`data/city/coverage.md`: coverage, sources, Frederiksberg substitutions, what is still queued). Raw data stays under `data/raw/` and is never committed; keep an eye on `df -h`: the script stops below 5 GB free.

With tiles the engine **streams** (`js/tile-streamer.js`, milestone C2): it keeps the tiles around the camera resident in rings,
**near** (750 m: buildings with facades, LoD2 roofs and doors, road surfaces, furniture, trees, grass, ground floor) and **mid**
(2.5 km: buildings and roads), loads nearest first under a concurrency cap, aborts stale requests, and unloads a tile beyond its
ring + 250 m (disposing its geometries, materials and photo textures). `?stream=<near m>` (and `&streammid=<m>`) shrinks the rings
so streaming is visible inside the 2 km district; `?tiles=<url>` reads another tile index; `?debug=notiles` is the monolithic
fallback (whole district built once). With `?hooks`, `__twin.stream.snapshot()` reports resident tiles per ring, loads, unloads,
aborts and bytes. `uv run --with playwright python tools/shoot-stream.py` flies the district three times at `?stream=300`,
and checks the console, the unloads and that the JS heap stays flat.

`data/cph-surfaces.json` (ground-material polygons and road markings, M4) is a separate generated file:

```sh
uv run tools/cph-geodata/surfaces.py   # KK dp_belaegninger + afmaerkning_total + blaa_cykelfelt, OSM squares
```

It carries classes `kbh_fortov, raadhus, asphalt_road, asphalt_cycle, cobbles, setts, gravel, grass, other` per surface
(with `src`/`conf`) and marking `kind`s `white, crossing, arrow, symbol, bay, bump, bluecycle, yellow, service, ramp, red`.
The twin renders Københavnerfortov (slab rows with a sett line between, parallel to the kerb), Rådhusbelægning, cobbles
and setts procedurally (`js/surface-materials-cph.js`); pavements are the Københavnerfortov unless the register or a
plaza-sized polygon says otherwise. Without the file the twin still boots (pavements and lane paint only).

`data/cph-vegetation.json` (lawns and planting) is measured, not taken from a register: the colour-infrared orthophoto gives
NDVI and the DHM point cloud gives what stands above the ground (class 5 crowns, class 3/4 shrubs); the ground under park
crowns is lawn by the KK park register. The twin appends these polygons to the surfaces as `grass` ground and grows tufts
on them around the camera (`js/grass-cph.js`: one instanced draw call, 49 tiles of 8 m refilled as you move, wind and
fade in the shader; `?debug=nograss` switches both off). Method, thresholds and QA: `tools/cph-geodata/vegetation.py`.

```sh
python3 tools/cph-geodata/vegetation_rasters.py   # DHM Punktsky class counts at 1 m (pdal; tiles from tools/lod2/fetch.py)
uv run tools/cph-geodata/vegetation_cir.py        # CIR orthophoto -> NDVI (Dataforsyningen token from ADC `gsearch-token`)
uv run tools/cph-geodata/vegetation.py
uv run --with playwright python tools/shoot-grass.py   # shots and cost into docs/grass/
```

`data/cph-furniture.json` (street furniture, M4) is another separate generated file:

```sh
uv run tools/cph-geodata/furniture.py   # KK WFS + Citelum lamp GPKGs + Movia stops; `?debug=nofurniture` skips it in the viewer
uv run --with playwright python tools/shoot-m2.py --furniture   # shots + fps into docs/m4-furniture
uv run --with playwright python tools/shoot-m2.py --oneway      # traffic direction: live car check + contraflow / track / arrow-overlay shots into docs/oneway
node tools/audit/oneway.mjs                                     # cars and cyclists against the one-way / bicycle-direction data (10 simulated minutes)
```

Look shots for lakes, trees and night lighting: `uv run --with playwright python tools/shoot-look.py --tag after` (docs/look/lakes-trees).
`uv run tools/cph-geodata/basins.py` adds the per-basin water levels to `data/cph-lakes.json` (after `lakes.py`).

## Hosting the citywide data

The app (index.html, css, js) is deployed by GitHub Pages; the citywide data is too big for Pages (1 GB limit) and for git, so it sits on Cloudflare R2 (free egress), bucket `cph-twin-data`, public through its r2.dev URL, under a version prefix:

```
<public url>/v1/tiles/   index.json + <tile id>/<layer>.json|bin    from data/tiles
<public url>/v1/city/    meta, roadgraph, streets, post, far.bin ...  from data/city (the files the index and post.json name)
<public url>/v1/tex-look/ <building>.webp facade atlases              from gs://lun-integrations-dev-cph-twin/skraafoto/tex-look
```

**Engine.** `js/data-config.js` holds the one data base URL (`BUILD_DATA_BASE`, default `./data`, so local dev is unchanged). It is used for the tile store (`<base>/tiles`, and the city files through the tile index) and the facade atlases (`<base>/tex-look/...`). `?data=<url>` overrides it for one session (`?data=https://pub-74be4ee48611455badf5e844894d286f.r2.dev/v3`); `?tiles=<url>` still overrides the tile directory alone. Remote data is cached by the browser normally, local data is revalidated on every load as before.

**Pages build.** `.github/workflows/pages.yml` publishes only index.html, css and js and rewrites `BUILD_DATA_BASE` to the repository variable `CPH_DATA_URL` (default: the r2.dev URL above, `v3`).

**Publishing data.** `python3 tools/hosting/upload_r2.py [--version v1] [--only tiles,city,tex-look] [--dry-run]`. It lists the bucket and skips objects whose size and MD5 match, so rerun it after regenerating tiles or atlases. JSON is stored gzip-compressed (`Content-Encoding: gzip`, 1.2 GB of tiles become about 270 MB); layers and atlases get `Cache-Control: public, max-age=31536000, immutable`, the roots (`tiles/index.json`, `city/post.json`, `city/meta.json`) `no-cache`. Because of the immutable headers, publish regenerated data that visitors may already have cached under a new version (`--version v2`), then set `CPH_DATA_URL` to `.../v2`. Objects are written through the small ingest Worker in `tools/hosting/ingest-worker` (the Cloudflare REST object API allows about 4 requests/s, too slow for 158k atlases); its URL and secret are in `~/.config/cph-twin/r2-ingest.json`, never in the repo. GCS is read with an ADC access token (`gcloud auth application-default print-access-token`).

**One-time bucket setup** (done): `wrangler r2 bucket create cph-twin-data`, `wrangler r2 bucket dev-url enable cph-twin-data`, `wrangler r2 bucket cors set cph-twin-data --file tools/hosting/cors.json` (GET/HEAD from https://martincollignon.github.io and localhost:8000/8080/3000/5173), `wrangler deploy` in `tools/hosting/ingest-worker` plus `wrangler secret put INGEST_KEY`. All in the Plans Cloudflare account. The r2.dev endpoint is rate limited and not CDN-cached; for launch traffic put a custom domain on the bucket (Cloudflare dashboard, R2, Settings, Custom Domains) and set `CPH_DATA_URL` to it.

## Licence and attributions

The project code is available under the [MIT License](LICENSE).

Based on [Slop New York](https://github.com/mrdoob/slop-newyork/) by mrdoob (MIT): the renderer, post-processing, controls, cameras, audio, traffic and pedestrian engine come from that project.

The data bundle `data/cph-geodata.json` is a derived database and carries the licences of its sources:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). The OSM-derived parts of the bundle, and anything derived from them, stay under the ODbL (attribution, share-alike).
- Indeholder data fra Klimadatastyrelsen / GeoDanmark (Bygning), BBR og Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens).
- Københavns Kommune open data: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister, and for `data/cph-surfaces.json` dp_belaegninger, afmaerkning_total, blaa_cykelfelt (plus OSM squares, ODbL).

The same attributions are in the `attribution` field of the data file and in the loading screen. Third-party data and dependencies retain their respective licences.

## Building reconstruction skill

`.claude/skills/building-case-to-3d/` (also `.agents/skills/` for Codex) rebuilds a single building as LoD3 from its Filarkiv/byggesag drawings, reconciled against 2025 Skråfoto. Subagents: `drawing-archivist`, `skraafoto-registrar`, `twin-validator` (`.claude/agents/`, `.codex/agents/`). Output heroes (e.g. Nørre Søgade 37) are referenced from `data/cph-geodata.json` `heroes[]` and linked with `tools/link-heroes.sh`. Drawings and models stay outside git.
