# Copenhagen twin v1: implementation plan (slop-newyork base)

Status: draft, 2026-10-25. Base: [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) (MIT, three.js WebGPURenderer + TSL, about 33k lines).
Context: `docs/research/valdrada-copenhagen-2026-10-10.md`, the `building-case-to-3d` skill and the Nørre Søgade 37 (NS37) reconstruction.

## Goal

A walkable, drivable and bikeable real-time twin of one Copenhagen district, rendered in the browser:

- every building at its **real footprint and height**;
- **facades driven by measured parameters**, not invented ones;
- real streets, lakes, trees and signals;
- NS37 inserted as a drawing-accurate LoD3 hero building.

**Not in v1:**

- generated facade textures (that is the separate texture spike);
- a perception-label renderer or CARLA-style API (Valdrada's domain);
- the full city.

**District:** Søerne / inner Nørrebro around NS37, about 1.5 × 1.5 km (Dronning Louises Bro, Nørre Søgade, Peblinge Sø, Ravnsborggade, Blågårdsgade). It is chosen for its mix: perimeter blocks, 1960s slab blocks, lake edge, heavy cycle traffic and signalised junctions.

## What we keep, replace and drop from slop-newyork

| Area | Files | Verdict |
|---|---|---|
| Renderer, post-processing, lighting, cameras, controls (foot, car, bike, helicopter), audio | `main.js`, `post-processing.js`, `lighting.js`, `cameras.js`, `controllers.js`, `audio-*` | **Keep** (light edits for origin and units) |
| Facade shaders (window grid, piers, storefronts, interior mapping) | `tsl-materials.js` | **Keep and adapt.** It assumes walls aligned to two axes (`facadeCell` picks the dominant world axis), so it needs a per-wall frame (M2). |
| Traffic and pedestrians | `traffic.js`, `pedestrian*.js`, `actor-models.js`, `vehicle-lights.js` | **Keep.** Feed them a non-grid road network (M3). |
| Road network | `road-network.js` | **Adapt.** Drop the Manhattan grid corridors (section 4a). Generalise the existing `GEO.roadGraph` centreline path (section 4b) to carry all streets. |
| Geography compiler | `tools/build-geodata.mjs`, `geo-*.mjs` | **Replace** with a Copenhagen compiler (M1) that emits the same `GEO` shape. |
| Synthetic Manhattan lots, boroughs, Central Park, NYC landmarks, fire escapes, water towers | `buildings.js` (lot generator), `city-grid.js`, `boroughs.js`, `landmarks.js`, `fire-escapes.js`, `city-config.js` | **Drop or gate.** Replaced by real buildings (M2). Keep the `Quadtree` streaming from `buildings.js`. |

## Repository layout

- **New repo `cph-twin`,** forked from slop-newyork. It holds the engine (JS) and keeps the upstream remote for cherry-picks; slop-newyork moves fast (commits daily).
- **Data compiler in `dk-building-data`:** `cmd/twin-geodata` (Go) or `tools/twin_geodata/` (Python, like the skill scripts). It reuses the existing fetchers and writes `cph-geodata.json` plus a building binary into the twin repo's `data/`. Generated data is versioned and never edited by hand.
- **NS37 hero model:** the skill outputs (`building.glb`, `building.json`) are referenced by id, not copied into git. The drawings stay out of git.

## Milestones

### M0: fork and de-Manhattan (2–3 days)

- Fork the repo and add `city.config.json`: an EPSG:25832 origin (district centre, DVR90), bbox and frame axes x = east, z = south. Do not reuse slop-newyork's grid rotated 29°.
- Put Manhattan-only modules behind a `city` flag. The engine boots to an empty ground plane with controls, sky and post-processing.
- **Accept when:** `npm test` passes the boot, camera and controller tests, and the viewer loads at the Copenhagen origin with no console errors (driven headless).

### M1: Copenhagen geodata compiler (5–7 days)

Inputs (all already reachable from this repo):

| Need | Source |
|---|---|
| Footprints | GeoDanmark *Bygning*, matched to BBR by UUID |
| Building attributes | BBR: storeys, use, year, wall and roof material |
| Heights | DSM minus DTM per footprint (`horizon`/`lidar` code), eave and ridge; roofer LoD2 where available |
| Roads | GeoDanmark *Vejmidte*, kerb lines from *Vejkant*; OSM `lanes`/`oneway`/`maxspeed`; KK one-way, speed and signal layers |
| Cycle tracks | KK `cykelsti`/`cykeldata`, GeoDanmark "Cykelsti langs vej" |
| Water and parks | GeoDanmark *Sø* (the lakes), KK green areas |
| Trees and furniture | KK *Træ basis* plus detected crowns, `cykelstativ`, `byinventar` |

Output: the engine's `GEO` keys (`roads`, `roadGraph{nodes,links,names}`, `parks`, `points`, …) plus a new `buildings[]`:

- `id`, BBR id, `ring` (local metres), `ground`, `eave`, `ridge`, `storeys`, `use`, `year`, `wall_material`, `roof_material`;
- `facade` parameters per wall;
- `src` and `conf` per field, under the same evidence rules as the skill.

**Accept when:**
- footprint coverage is at least 98% of GeoDanmark buildings in the bbox;
- the road graph is one connected component, apart from known dead ends;
- every building has a height source;
- a provenance report is written.

### M2: real buildings (7–10 days)

This is the main engine work.

- **`buildings-real.js`:** extrude arbitrary-angle polygon footprints. Light courts become holes, and courtyard blocks become rings. Each vertex carries:
  - **wall frame attributes:** `u` (metres along the wall), wall id and facade normal;
  - **facade parameters:** floor height, window width, bay width, ground-floor type and tone.
- **`tsl-materials.js`:** `facadeCell` reads `u`/`v` and the wall normal from attributes instead of the dominant world axis. Box-local mode stays for slop-newyork's own props. Add tests extending `tests/facade-projection.test.cjs` for walls at 0°, 15° and 45° and for concave rings.
- **Facade parameters, honest by default:**
  1. **Measured (NS37):** from `building.json`. The hero model replaces the extrusion entirely; its glTF is loaded with its own materials.
  2. **Data-driven defaults:**
     - floor height from height ÷ BBR storeys;
     - window rhythm and type from a small preset table keyed by BBR use, year band and wall material (karré 1870–1915, functionalist brick, 1960s slab, post-2000);
     - colour from BBR material, refined by sampling Skråfoto (reuse `cmd/twinviz` `collage_color.go`).
     - Every default is marked `conf: inferred` and shown as such in the viewer's info panel.
  3. **Later (texture spike):** per-building atlases replace the procedural colour.
- **Roofs:** flat with a parapet at the eave by default. Use roofer LoD2 meshes where they exist, else pitched roofs from the eave/ridge difference only when DSM supports it.
- **Accept when:**
  - silhouettes match the Skråfoto camera overlays for the district: port the NS37 viewer's calibrated photo-comparison mode, and confirm the envelope only;
  - NS37 shows its traced facades;
  - performance stays above 60 fps on an M-series laptop for the district (instancing and quadtree streaming).

### M3: roads, traffic, cyclists (7–10 days)

- **`road-network.js`:** build all streets from the centreline graph. Lane counts and widths come from OSM plus kerb spacing, falling back to a road-class default (flagged). Signals come from KK *trafiksignaler*; phases are simple fixed-time per junction for v1.
- **Pedestrians:** pavement bands from the kerb-to-building-line gap; crossings at signals and marked crossings (KK `afmaerkning`).
- **Cyclists (Copenhagen's defining feature):** a cycle-track lane class between the kerb and the pavement, plus a cyclist agent reusing the car agent's car-following model with bike parameters and the slop-newyork bike model. v1 keeps them on their own lane class; mixing with turning cars is out of scope.
- **Accept when:** traffic runs for 10 minutes with no stuck agents or tunnelling; cyclists use cycle tracks on Nørre Søgade, Dronning Louises Bro and Nørrebrogade.

### M4: environment and polish (3–5 days)

- The lakes as water with lake-edge paths, trees (species to model archetype), bike racks and benches, and street lights from KK data where available.
- Terrain can be a flat DHM median for v1, since Copenhagen is flat. Add DHM relief only if it is visibly wrong.
- Attribution panel: GeoDanmark, BBR, DHM, Skråfoto, KK, OSM (ODbL) and slop-newyork (MIT).

### M5: validation, packaging, hosting (3–4 days)

- **Automated checks:**
  - provenance coverage;
  - building height vs DSM (median absolute error per building);
  - footprint IoU;
  - road graph connectivity;
  - headless viewer run (no console errors, every mode works, screenshots).
- **Visual check:** calibrated Skråfoto comparison views (2017 and 2025) for 10 buildings.
- **Hosting:** static build on Cloudflare (Pages, or R2 for data), with versioned, immutable data folders.

## Effort and staffing

- **Effort:** about 4–6 weeks for one engineer-equivalent.
- **Split:** per the code-arbitrage workflow, implementation goes to Codex (Luna, medium) milestone by milestone with a written spec and acceptance tests. Judgment, visual validation, data decisions and git stay in the review session. M2's shader change and the facade-parameter honesty rules are the parts to review hardest.

## Risks

- **The facade shader assumes axis alignment.** It is the biggest technical risk. Prototype it first (M2 day 1–2) on NS37 and one angled perimeter block.
- **WebGPU only.** Fine for Chrome, Edge and Safari 26+. Decide whether a WebGL fallback matters.
- **Upstream churn.** Pin a commit and cherry-pick deliberately.
- **Honest defaults vs looks.** Preset facades will look generic until the texture spike. The info panel must show `inferred`, so nobody mistakes it for measured detail. This is the NS37 lesson.
- **Licences.** The compiled data includes OSM (ODbL), so the data bundle is ODbL. The engine stays MIT. The drawings are never published.

## Open decisions

1. Repo: new `cph-twin` fork (recommended) vs a subfolder here.
2. District bbox: confirm Søerne / Nørrebro around NS37.
3. Cyclist agents in v1 (recommended), or the player bike only.
4. Hosting: private Cloudflare Access-gated, or public.
