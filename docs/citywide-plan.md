# Citywide Copenhagen: expansion plan

Status: approved 2026-10-26. Scope: **Københavns Kommune plus Frederiksberg Kommune** (~97 km², about 43× the 2.25 km² Søerne / Nørrebro district). Implementation is done by Sonnet subagents milestone by milestone, with review and screenshots in the lead session. Facades outside the photo-atlas district use the measured tone plus procedural detail.

**Disk constraint:** the build machine has about 13 GB free. Citywide raw inputs (LAZ, ortho, CIR) must be streamed per tile: download, derive, delete. `data/raw/` must stay under 5 GB.

## Why the district build doesn't scale

| Assumption | Where | Breaks because |
|---|---|---|
| One origin and a ±750 m bbox, copied into five places | `tools/cph-geodata/frame.py:4-5`, `tools/lod2/common.py:19-21`, `lakes.py:37`, `ortho.py:37-40`, `fetch.py:22` | there is no notion of a tile |
| Whole-bbox raw cache (one `kk_<layer>.json` / `osm_<key>.json`) | `fetch.py` | one Overpass query over 88 km² times out |
| One JSON per layer, fetched at boot | `js/world.js:29-84`, `layout-cph.js:34` | `cph-geodata.json` would be ~760 MB; all layers together ~1.4 GB |
| LoD2 `prefetch()` loads every tile up front | `lod2-geometry.js:78`, `buildings-real.js:395` | ~150 MB of binaries plus a ~25 MB index |
| Buildings, furniture and surfaces are built for the whole bbox and only culled | `buildings-real.js:362-510`, `scene-culling.js`, `street-furniture-data.js:383` | GPU memory and boot time grow 40× |
| Road, cyclist and pedestrian graphs are built whole at boot | `road-network.js:23`, `cyclist-network.js:123` | build time, and agents spawn only near the camera anyway |
| `±750` clamps in the player and ground code | `city-config.js:29`, `controllers.js`, `ground-field-cph.js:78`, `lakes-cph.js`, `terrain-cph.js:157`, `water-cph.js:182` | the player can't leave the district |
| Single-place logic | Søerne basins split at DLB (`lakes.py`, `basins.py`, `ortho.py:289-301`), `bridge-dlb*`, `irma-neon*`, `swan-*`, NS37 hero | keep these as district features; other places get generic code |

## Target architecture

**Frame.** Keep one global origin (NS37), so existing local coordinates stay valid. A float32 world of about ±6 km keeps millimetre precision near the camera if positions are camera-relative. Check the vertex shaders, or rebase the origin per tile if needed.

**Tiles.** Use a fixed 500 m grid in EPSG:25832, aligned to the existing 1 km LoD2/DHM tile names (`6176_723`), so that four tiles fill one 1 km cell. The kommune covers about 400 tiles, and about 350 of them hold land.

- `data/tiles/<e>_<n>/` holds `buildings.bin`, `roads.json`, `surfaces.bin`, `furniture.bin`, `vegetation.bin`, `terrain.bin` and `lod2.bin`.
- `data/tiles/index.json` holds tile bboxes, per-layer byte sizes and building counts.
- `data/city/` holds city-wide sparse layers: the road graph (all streets, ~20 MB gzipped to ~4), lakes and harbour water, names, and a coarse building LOD for far tiles (one block mesh per tile).
- Geometry moves to binary (typed arrays plus a small JSON header). JSON stays only for the sparse metadata.

**Compiler.** `tools/cph-geodata/build.py --tile <e>_<n>` builds one tile from a 60 m-margin fetch, and `build_city.py` runs every tile in parallel and resumes where it stopped. The KK WFS and Overpass fetches are cached per tile. Cross-tile features (roads, lakes, long buildings) are clipped by centroid ownership, with no geometry split: a building belongs to the tile that holds its centroid. Roads are compiled once citywide, then sliced per tile for kerbs and surfaces.

**Engine streaming.** A `tile-streamer.js` keeps three rings around the camera:

| Ring | Radius | Contents |
|---|---|---|
| Near | ≤ 750 m (3×3 to 5×5 tiles) | everything at today's fidelity: facades, furniture, grass, agents |
| Mid | ≤ 2.5 km | buildings with tone facades and LoD2 roofs, roads, trees as impostors; no furniture or agents |
| Far | rest of the city | per-tile block meshes and the city water and ground |

Tiles load and unload with hysteresis, and the build is done in a worker. Existing modules get `addTile(tile)` / `removeTile(id)` instead of a one-shot build. The quadtree and `scene-culling.js` stay as the per-tile culling layer. Agents are already spawned within ~320 m of the camera; they need the graph only in the near ring and are despawned when their tile unloads.

## Data volume and access

- **Raw data:**
  - LoD2 LAZ needs about 20–30 GB, and the files are deleted after cropping (`docs/research/roofer-citywide.md`).
  - The 0.25 m ortho/CIR is 10–20 GB. Fetch it per tile, keep only the derived NDVI and facade tones, and never commit it.
  - The DHM WCS is already tiled at 800 m.
- **Runtime:**
  - The near ring is about 25–40 MB per position, similar to today.
  - The far layer is about 15–30 MB for the whole city.
  - The total hosted bundle is about 1–1.5 GB of static tiles, which is fine for R2.
- **Photo facades:** `data/tex` covers only the district today. Citywide, the twin uses tone plus procedural facades and keeps photo walls where atlases exist.
- **Licences:**
  - `docs/kk-licence-request.md` names only Søerne / Indre Nørrebro, so it must be resent with kommune scope before anything public.
  - Datafordeler terms are still unread, and service-user access ends on 15 Jan 2027. A citywide LAZ pull should happen before then.
  - Frederiksberg is a separate kommune with its own open-data portal, and the KK WFS layers don't cover it. GeoDanmark, BBR, DHM and OSM do.

## Milestones

| # | Work | Accept when |
|---|---|---|
| C0 | One frame module: `frame.py` exports the tile grid; the five copied bboxes import it | district rebuild is byte-identical apart from new metadata |
| C1 | Per-tile compiler and binary layers; build the current district as 3×3 tiles | the twin renders the district from tiles with no visible change; tests pass; boot is no slower |
| C2 | `tile-streamer.js` with near/mid/far rings; modules gain `addTile`/`removeTile`; clamps go to the city bounds | flying from NS37 to Nyhavn and back streams in and out without errors; heap stays flat after 3 round trips |
| C3 | Inner city (Indre By, Christianshavn, Vesterbro, Østerbro, Nørrebro; ~25 km², ~100 tiles) | headless walks at 10 teleports with no console errors; ≥ 60 fps near ring on an M-series laptop |
| C4 | Generic water: the harbour, canals and other lakes from GeoDanmark *Vandløb/Sø* plus the shoreline, with the DLB-specific basin logic kept as an override | the harbour edge at Nyhavn and Islands Brygge looks right in shots |
| C5 | Whole kommune (± Frederiksberg), far-LOD block meshes, more teleports | the coverage report shows ≥ 98% of GeoDanmark buildings; the road graph is connected; there is a perf sweep |

Effort: C0–C2 is the engine core, about 1.5–2 weeks. C3–C5 is mostly compute and QA, about 1–2 weeks. Implementation goes to Codex Astra milestone by milestone; review and screenshots stay in the lead session.

## C5 engine status (2026-10-26)

What the engine does with the citywide index (`data/tiles` + `data/city`), and the two post-process tools that feed it. Post-process layers are
registered in `data/city/post.json` (`cph-post/1`), which the tile store reads at open; the tile compiler's own files are never edited.

| Piece | Tool / module | Output |
|---|---|---|
| Far ring | `tools/cph-geodata/far_lod.py` -> `js/far-lod.js`, `js/far-lod-geometry.js` | `data/city/far.bin` + `far.json`: per tile a 16 x 16 ground grid, park bits and the buildings as prisms (footprint simplified to ~1.2 m Douglas-Peucker, flat top at the eave, wall + roof tone); water polygons with levels. 3.5 MB for the whole city (91 k of 178 k buildings: footprints under 22 m2 are dropped). The engine builds one ground mesh and one building mesh per tile within 9 km that is not resident, hides it while the streamer has the tile built, and draws the harbour, the lakes and a sea plane out to the horizon |
| Street layout per tile | `tools/cph-geodata/tile_streets.py` | `data/tiles/<id>/streets.json` (roads, extra road pieces, pavements, cycle tracks, footprint drops / clips, surface cuts of that tile) + `data/city/streets-graph.json` (the layout's fixes to the road graph, renumbered for the citywide graph when the whole-city document numbers another one). The `roads` and `streets` layers stream with the tile (near and mid rings); nothing is held for the whole index |
| Agents | `js/agent-region.js` | traffic, cyclists and pedestrians route on the citywide `roadgraph.json` cut to a 560 m region around the camera and place on the near ring's detailed roads, cycle tracks and signals; the region is rebuilt (one stage per frame) when the camera is 190 m from its centre, agents spawn and despawn inside it |
| Workers | `js/tile-pool.js`, `js/tile-worker.js` | the CPU halves of the buildings (`building-compute.js`), road surfaces (`road-compute.js`) and furniture placement (`furniture-compute.js`) run in Web Workers and return typed arrays; `?debug=noworker` runs them inline in slices |
| Mid ring | `building-geometry.js` `lite` | tone-only walls (one colour per building, plain vertex-colour material), flat deck roofs (LoD2 roofs stay), one wall and one roof mesh per tile; carriageways, kerbs and cycle tracks only |
| Teleports | `tools/cph-geodata/city_teleports.py` -> `js/city-teleports.js` | eight citywide presets on vehicular links of the citywide graph, offered where the index has a tile |

Water: see "C4 engine status" below (the far layer's water now rides with its tiles and uses the generic water material).

Re-run after the compiler has changed the tiles: `uv run tools/cph-geodata/far_lod.py`, `uv run tools/cph-geodata/tile_streets.py`, `uv run tools/cph-geodata/city_water.py`.

## C4 engine status (2026-10-26)

Generic citywide water and ground. Post-process of the tile compiler like `far_lod.py` and `tile_streets.py`; registered in `data/city/post.json` under `water`; the compiler's own files are never edited.

| Piece | Tool / module | Output |
|---|---|---|
| Sources and bodies | `tools/cph-geodata/city_water.py` (`--fetch` once for the raw files) | GeoDanmark `soe` + `bassin` polygons, OSM `natural=water`, the sea from the OSM coastline (polygonised against the request bbox; land is on the left of a way). Overlapping sources are unioned (GeoDanmark first), small islands under 30 m2 dropped. Per body: level, kind, name |
| Levels | same | the median of the compiled terrain (DTM chunks of the tiles) over the body; a body within 0.6 m of 0 m DVR90 (-6.84 local) or joined to the sea is at the sea. Ponds (under 1500 m2, not at the sea) are flat water 2 cm over their level, no walls, no ground cut |
| Shores | same | every boundary of the water is a shore. Densified at 8 m; wall top = median terrain 2 m inland + 0.08 m coping, at least 0.3 m over the water (as `shoreTop` in `js/lakes-cph.js`); `q` quay (granite wall + coping) where a building, pavement or road lies within 9 m, `b` natural bank (grass, 1:1.6 batter) elsewhere. 142 km of quay, 119 km of bank |
| Tile layer | `data/tiles/<id>/water.json` (`water` layer, near and mid ring) | bodies clipped to the tile (surface rings, level, wall runs with a top height per vertex), ground cut (4 m lattice anchored at -750 as `lake_cut` in `terrain.py`, skip cells run-length coded + partial-cell pieces), green ground (park / grass / cemetery / forest polygons), trimmed surface-register polygons (bridge decks stay) |
| City header | `data/city/water.json` | body table, `far`: simplified water pieces per tile (the far ring), `override`: the Soerne |
| Engine | `js/water-stream.js`, `js/water-tiles-cph.js` | one water mesh and one wall mesh per tile, ONE water material and ONE wall material; the ground layer cuts its mesh by the tile's cut (`buildTileGroundArrays` `tileCut`); the far layer builds the tile's water pieces with the tile and hides them with it, with the same water material, so the harbour reads as one water out to the horizon (the sea plane at 0 m DVR90 reaches 45 km) |
| Window rasters | `js/water-stream.js` | the water shader's shore distance (from the far pieces) and the ground shader's grass / lake-path field (from the resident tiles' green polygons) are 1536 m windows at 1.5 m that follow the camera (rebuilt after 384 m or when tiles change, about 25 ms) |
| Reflections | `js/water-stream.js`, `js/world.js` | ONE planar reflector for all generic water, at the level of the water nearest the camera (water at any other level reflects the sky), on only within 260 m of water and below 220 m; `?water=simple` never. The Soerne keep their own reflector; the world runs the nearer of the two |

Generic vs override. Everything is generic except the Soerne: they are the district's hand-made lakes (`lakes.py` closing over the Dronning Louises Bro strip, two basins at -0.94 m and -0.10 m, the hero bridge, swans, lake furniture, the gravel lake path), computed by `city_water.py` from the same sources without the district clip (`override` in `water.json`, the format of `data/cph-lakes.json`, ids `soerne:N`; the levels and deck heights go into the terrain header at load) and drawn by the district's global `buildLakes`. The generic layer leaves them out of its surfaces, walls and far pieces; they still cut the ground. Without `data/city/water.json` (the `?tiles=` district set, `?debug=notiles`) nothing changes.

Cost (headless M-series Chrome, 1600 x 900, unthrottled, while other builds ran on the machine, so only the ratios mean something): the planar reflection near water costs 30-45 % of the frame, as in the district (`?water=simple` and anywhere the camera is more than 260 m from water: none). Before C4 the Soerne's reflector ran everywhere in the city whenever the camera was below 450 m; it now runs only within 300 m of the lakes, and the pass leaves out the far ring and tiles beyond 1.1 km. Frame medians (ms) base / C4 / C4 `?water=simple`: Nyhavn 21.5 / 38 / 24, Knippelsbro 15 / 26 / 19, Islands Brygge 14 / 23 / 15, Dronning Louises Bro 16 / 28 / 16.

Not done: boats, waterway lines (streams as ribbons; Harrestrup Aa is partly a polygon), bridge soffits over generic water (the deck is the road surface, the ground under it is cut), a sand beach material (natural coast uses the bank), GeoDanmark `kyst` / `havn` lines (the OSM coastline is the sea), waves for open sea, the water and walls in the mid ring are the same meshes as in the near ring.
