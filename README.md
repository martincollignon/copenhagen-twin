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

The lake promenade is inferred at runtime from the lake rings because this checkout lacks `data/raw/`. It supplies a four-metre gravel path and a two-metre grass bank where roads, bridges, buildings and registered surfaces leave space, using the existing surface renderer. These are approximate bands, not surveyed path outlines. Connected large Søerne basins use a +0.35 m visual water-level adjustment relative to the DTM; small lakes and ponds keep their measured levels. Terrain still controls the shoreline, so freeboard varies near banks and bridge approaches. Some land-side bank samples on `lake:1` and `lake:2` lie below the corrected water elevation, outside the water footprint; their profile needs visual review before any coordinated terrain and walking-height correction.

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

Clear midday haze uses density 0.00013 (about 12% attenuation at 1 km) and caps fog in-scatter luminance at 0.48 scene-linear to prevent the HDR sun lobe from washing out buildings. Where terrain sits below the coping, a landward granite face now joins the ledge to the gravel; inferred gravel overlaps the coping edge by 5 mm.

Tests (Node 20+, no dependencies):

```sh
node --test tests/*.cjs tests/*.mjs
```

Headless browser check (Playwright; boots the twin, asserts the HUD and console, writes screenshots to `docs/cleanup/`):

```sh
uv run --with playwright python tools/shoot-m2.py --verify --query hooks --out docs/cleanup
```

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

`data/cph-furniture.json` (street furniture, M4) is another separate generated file:

```sh
uv run tools/cph-geodata/furniture.py   # KK WFS + Citelum lamp GPKGs + Movia stops; `?debug=nofurniture` skips it in the viewer
uv run --with playwright python tools/shoot-m2.py --furniture   # shots + fps into docs/m4-furniture
uv run --with playwright python tools/shoot-m2.py --oneway      # traffic direction: live car check + contraflow / track / arrow-overlay shots into docs/oneway
node tools/audit/oneway.mjs                                     # cars and cyclists against the one-way / bicycle-direction data (10 simulated minutes)
```

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
