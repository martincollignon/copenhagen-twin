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
