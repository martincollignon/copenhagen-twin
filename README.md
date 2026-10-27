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

Live demo: https://martincollignon.github.io/copenhagen-twin/

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

Ground actors share a collision pass before their render batches are written: people, city and cargo bikes, cars and buses separate from one another and from buildings, parked vehicles and solid street furniture. Building footprints preserve courtyards and concave recesses; tree and lamp collisions use trunks and poles. Player movement also sweeps its path to stop fast crossings through thin obstacles. Nearby spatial queries bound the contact work.

The required CI check includes collision geometry and actor regressions. On a WebGPU machine, exercise the real controller, NPC routes and rendered positions with:

```sh
uv run --with playwright python tools/check-collisions.py --out .context/collisions.json
```

Add `--perf` for paired CPU timings with the collision stage enabled and disabled. This comparison pauses the animation loop while updating simulations and render batches; it does not measure frame rate.

## Performance budget check

Every pull request runs the required `texture-memory-budget` check. It replays the committed camera route against the real facade-atlas dimensions and fails if the selected facade textures exceed 48 MiB or 56 residents:

```sh
node --test tests/texture-memory-budget.test.mjs
```

The same required check tests building-batch picking and streaming visibility, preserves the sun shadow depth target, and checks module loading. Static building cells share material batches while retaining their geometry and individual culling. On WebGPU, the sun cascades use their original depth maps without allocating an unused colour attachment; at 3072 pixels per cascade this saves 72 MiB without changing shadow resolution.

The [rendering measurements](docs/research/rendering-optimization.md) record the allocation and frame-time comparisons, verification and remaining limits.

On a WebGPU machine, the local browser harness samples the live resident and in-flight facade estimate while moving through that route, fails on rendering errors, and prints the renderer's texture estimate for context. That estimate excludes some backing allocations, including multisampled colour textures; it is not a physical GPU memory reading:

```sh
uv run --with playwright python tools/shoot-m2.py --perf
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

Raw downloads are cached under `data/raw/`, so reruns are offline. See `tools/cph-geodata/build.py` for options.

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

## Licence and attributions

The project code is available under the [MIT License](LICENSE).

Based on [Slop New York](https://github.com/mrdoob/slop-newyork/) by mrdoob (MIT): the renderer, post-processing, controls, cameras, audio, traffic and pedestrian engine come from that project.

The data bundle `data/cph-geodata.json` is a derived database and carries the licences of its sources:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). The OSM-derived parts of the bundle, and anything derived from them, stay under the ODbL (attribution, share-alike).
- Indeholder data fra Klimadatastyrelsen / GeoDanmark (Bygning), BBR og Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens).
- Facade photos use Skråfoto 2023 and 2025 from Styrelsen for Dataforsyning og Infrastruktur (retrieved October 2026); the processed atlases are derived from those photos. [Terms for free geographic data](https://dataforsyningen.dk/asset/PDF/rettigheder_vilkaar/Vilk%C3%A5r%20for%20frie%20geografiske%20data%20og%20CC%20BY%204_0%20licens.pdf).
- Københavns Kommune open data: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister, and for `data/cph-surfaces.json` dp_belaegninger, afmaerkning_total, blaa_cykelfelt (plus OSM squares, ODbL).

The map and facade sources are credited in the loading screen and their data files. Third-party data and dependencies retain their respective licences.

## Building reconstruction skill

`.claude/skills/building-case-to-3d/` (also `.agents/skills/` for Codex) rebuilds a single building as LoD3 from its Filarkiv/byggesag drawings, reconciled against 2025 Skråfoto. Subagents: `drawing-archivist`, `skraafoto-registrar`, `twin-validator` (`.claude/agents/`, `.codex/agents/`). Output heroes (e.g. Nørre Søgade 37) are referenced by building ID in `data/cph-geodata.json` `heroes[]` and linked with `tools/link-heroes.sh`. The script reads the model build from `CPH_HERO_DIR` (default: `~/.local/share/building-case-3d/noerre-soegade-37/build`). Drawings and models stay outside git.
