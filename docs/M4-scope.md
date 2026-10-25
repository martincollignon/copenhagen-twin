# M4 scope: make the twin feel real (built from the open-data sweeps)

Sources: `docs/research/open-data-static.md` and `docs/research/open-data-live.md`. Both sweeps were checked with live queries over the bbox on 2026-10-25.

M4 is ranked by visual or simulation impact per unit of effort. Data goes through `tools/cph-geodata` (the contract in `cph-geodata-schema.md`, additive fields only). Live feeds are fetched at runtime by a small `js/live/` layer, with a cached fallback in `data/live-cache/`.

## M4a: compiler additions (static)

| # | Data | Count in bbox | Use in the twin |
|---|---|---|---|
| 1 | **Skråfoto facade colour per wall**: mean of the rectified oblique in shadow-free areas, via `facade_rectify.py` | all buildings with a facing view | Replaces the uniform red-brick default with each building's real colour. Biggest daytime look fix. `conf: observed`. |
| 2 | **Citelum street lamps**: wire-hung (1,306) and mast (400), with type, wattage and LED vs sodium | 1,706 | Real night lighting, including Copenhagen's cable-hung lamps over the street; warm or cool by lamp type |
| 3 | **Road markings** (`afmaerkning_total`) | 13,187 polygons | Crossings, blue cycle crossings, arrows and parking bays as ground decals |
| 4 | **Detected tree crowns** joined to **Træ basis species and age** | 4,268 + 4,905 | Real crown size and height, model by species, seasonal colour |
| 5 | **Venues and shops**: KK `bevillinger` (476) + OSM shops (632, 301 with opening hours) | ~1,100 | Storefront signs and lit windows by clock time, nightlife glow |
| 6 | **Street life**: parking bays (782 polygons, 1,151 kerb lines), outdoor-seating permits (737), bollards (461) | ~3,100 | Parked cars in real bays, café terraces, bollards |
| 7 | **SAVE heritage scores** | 2,355 | Facade detail tier (cornices, frames) on high-value buildings, flagged as a style choice |
| 8 | **Monuments, fountains, Movia stop equipment** | 78 + 15 + 48 | Statues and fountains; bus shelters, benches and countdown signs at real stops |
| 9 | **Road noise 2022** (CC0) | 226 polygons, 16,917 points | Ambient audio level per street; optional overlay |

## M4b: dynamic (runtime)

| # | Feed | Use |
|---|---|---|
| 10 | **Rejseplanen static GTFS** (42 stops, 33 routes incl. 5C, 6A, 1A, 2A, 14, 15E) | Buses run real routes and timetables along the route shapes. No open GTFS-RT exists, so the timetable is the source. |
| 11 | **DMI open data** (CC BY 4.0, no key): Botanisk Have rain gauge, 5-min radar, forecast, lightning | Rain, wet-road shader, clouds and storm flashes; a time scrubber into the forecast |
| 12 | **KK traffic counts** (108 sites, e.g. Dronning Louises Bro about 33k bikes a day) | Calibrates car and cyclist demand per street |
| 13 | **KK roadworks and incidents** (156 active digs, incidents) and **street permits** (terraces, events, film shoots) | Barriers and closures at their real locations, refreshed daily |
| 14 | **GBFS scooters and bikes** (Dott 185, Donkey 227, Donkey CC0, every 60 s) | Parked shared bikes and scooters at their live positions |
| 15 | **OSM opening hours** (751) | Drives #5 by time of day |

## Fixes carried into M4

- Pedestrians walk on cycle tracks (M3 known issue). They must use the pavement bands only.
- Courtyard walls get shopfronts. `ground_type` should be set per wall: street-facing walls use the venue/shop data, courtyard walls are residential.
- Buildings with `ground < 0` are clipped by the flat ground. Use the DHM terrain, or at least the per-building ground level.
- Parked and moving cars: neutral models with Danish-style generic plates (no real plates).

## Licence checks before any public build

- KK layers with no stated licence: Træ basis, byinventar, vegetation cover, counts. Email bydata@kk.dk.
- Rejseplanen GTFS terms.
- Citelum lamps are CC BY 4.0.
- DMI is CC BY 4.0.
- The OSM-derived bundle is ODbL.

The build stays private (Cloudflare Access) until these are cleared.

## Order of work

1. M4a #1–4, then the cycle-track bug fix.
2. #10–11, then #5–6.
3. The rest.

Each item ships with a screenshot pair (before and after) and keeps the provenance and `conf` rules: observed vs inferred stays visible in the info panel.
