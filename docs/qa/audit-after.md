# Copenhagen twin: cross-layer audit, after the coherence fixes

Branch `fix-coherence`. Same tool (`tools/audit/dump_layout.mjs` + `audit.py`), run on the engine at the QA commit (before) and on this branch (after).
"Before" was re-measured with the final audit tool on the old engine (`docs/qa/results-before.json`); the numbers published in `audit.md`
(original definitions) are in `docs/qa/results-before-original-audit.json`. After: `docs/qa/results.json`, tables `audit-tables.md`, sweep `docs/qa/sweep-after/`.
Reproduce: `node tools/audit/dump_layout.mjs && uv run tools/audit/audit.py && uv run tools/audit/compare.py` (about 2 min).

## Architecture (what changed)

1. ONE height model: `data/cph-terrain.json` (DHM terrain 2 m, pits under footprints refilled, street zones low-passed, measured lake levels / bridge decks) -> `js/terrain-cph.js heightAt`. Every layer is terrain + its own offset.
2. ONE street cross-section: `tools/cph-geodata/streets.py` -> `data/cph-streets.json` (Vejkant + pavement polygons ray-cast; roads re-centred, measured half width, cycle strips with ranges, graph nodes/widths, cleaned pavements, KK cycle dedupe).
3. ONE constraint system: `js/zones-cph.js` (raster of building/water/road/swept-lanes/cycle/pavement) + `js/placement-cph.js`.
4. Data errors resolved by source precedence (footprints, OSM squares) in `streets.py`, reported in `data/cph-streets.json` (`buildingReport`, `surfaceCuts`).

Definition changes (applied to before and after alike): `bld-ground-vs-flat-plane`/`bld-ground-range` became `bld-ground-vs-street`/`bld-ground-terrain`
(ground vs walking height beside the facade / vs the terrain); the moving-lane corridor is the strip the sim sweeps (lanes at 1.5 m + n x 3 m, cars 1.9 m wide) instead of lanes x 3 m;
props are judged against the asphalt/cycle triangles the engine draws; racks, bays and bus stops are the placed records; tree-crown check uses eave above the building's own ground.

## What was dropped / moved (placement report, `layout.placement`)

- Parked cars: 3430 bays -> 1067 cars on 1377 kept bays (random occupancy); 1671 bays had no legal room beside the swept lanes, 237 blocked/duplicate, 111 off the carriageway, 34 no road; 973 aligned.
- Wire lamps: 502 anchored facade-to-facade across the street (the surveyed 2018 lines run ALONG the street: they are feed routes, not spans), 789 became 6.2 m masts (open side / no tall facade), 15 dropped.
- Trees: 97 dropped (no ground), 26 in water, 460 moved, 205 crowns trimmed (`crown_conf: trimmed`). Racks: 343 dropped, 376 clipped, 381 shifted; benches 80, bins 29, stands 229 (mostly courtyards), bollards 86 dropped. Bus: 6 stops with no pavement dropped, 2 shelters without room.
- Buildings: 21 footprints dropped (shed inside main building, duplicate, 2 in Peblinge Soe), 2 clipped; 22 gateway roads dropped, 5 roads cut at footprints; 38 ground polygons cut (45 000 m2, mostly OSM `place=square` outlines).

## Before / after, every check

| severity | check | before (count / of, %) | after (count / of, %) |
|---|---|---:|---:|
| high | `bld-ground-vs-street` | 1558 / 2517 (61.9%) | 16 / 2497 (0.64%) |
| high | `bld-ground-terrain` | 1555 / 2517 (61.78%) | 13 / 2497 (0.52%) |
| high | `car-off-carriageway` | 1326 / 2694 (49.22%) | 0 / 1067 (0.0%) |
| high | `on-cycletrack:cars` | 819 / 2694 (30.4%) | 0 (none found) |
| high | `on-carriageway:glass` | 6 / 23 (26.09%) | 0 (none found) |
| high | `car-in-moving-lane` | 692 / 2694 (25.69%) | 0 / 1067 (0.0%) |
| high | `on-carriageway:shelters` | 4 / 21 (19.05%) | 0 (none found) |
| high | `on-carriageway:benches` | 104 / 938 (11.09%) | 0 (none found) |
| high | `overlap:cars+cars` | 286 / 2694 (10.62%) | 0 (none found) |
| high | `bld-ground-step-neighbours` | 239 / 2517 (9.5%) | 5 / 2497 (0.2%) |
| high | `on-carriageway:lamp-poles` | 38 / 467 (8.14%) | 0 (none found) |
| high | `on-carriageway:bins` | 40 / 539 (7.42%) | 0 (none found) |
| high | `road-through-bld` | 38 / 931 (4.08%) | 9 / 916 (0.98%) |
| high | `on-carriageway:stands` | 30 / 740 (4.05%) | 0 (none found) |
| high | `in-building-partial:monuments` | 3 / 76 (3.95%) | 0 (none found) |
| high | `on-carriageway:trees` | 178 / 4905 (3.63%) | 0 (none found) |
| high | `overlap:bikes+cars` | 249 / 9796 (2.54%) | 0 (none found) |
| high | `in-water:trees` | 112 / 4905 (2.28%) | 0 (none found) |
| high | `car-on-pavement` | 60 / 2694 (2.23%) | 0 / 1067 (0.0%) |
| high | `overlap:cars+hoops` | 143 / 8822 (1.62%) | 0 (none found) |
| high | `on-carriageway:monuments` | 1 / 76 (1.32%) | 0 (none found) |
| high | `overlap:benches+cars` | 39 / 3632 (1.07%) | 0 (none found) |
| high | `bld-bld-overlap` | 22 / 2517 (0.87%) | 0 / 2497 (0.0%) |
| high | `in-building-partial:benches` | 4 / 938 (0.43%) | 0 (none found) |
| high | `in-water:benches` | 4 / 938 (0.43%) | 0 (none found) |
| high | `overlap:cars+trees` | 30 / 7599 (0.39%) | 0 (none found) |
| high | `in-water:bins` | 2 / 539 (0.37%) | 0 (none found) |
| high | `wire-through-building` | 4 / 1239 (0.32%) | 0 / 502 (0.0%) |
| high | `in-building-partial:cars` | 6 / 2694 (0.22%) | 0 (none found) |
| high | `in-building-partial:lamp-poles` | 1 / 467 (0.21%) | 0 (none found) |
| high | `in-building-partial:bins` | 1 / 539 (0.19%) | 0 (none found) |
| high | `overlap:cars+stands` | 6 / 3434 (0.17%) | 0 (none found) |
| high | `water-carriageway` | 1 / 931 (0.11%) | 0 / 916 (0.0%) |
| high | `bld-water` | 2 / 2517 (0.08%) | 0 / 2497 (0.0%) |
| high | `in-building-partial:trees` | 3 / 4905 (0.06%) | 0 (none found) |
| high | `lod2-beyond-footprint` | 0 / 2114 (0.0%) | 0 / 2097 (0.0%) |
| high | `water-cycletrack` | 0 / 679 (0.0%) | 0 / 583 (0.0%) |
| high | `water-pavement` | 0 / 983 (0.0%) | 0 / 1026 (0.0%) |
| med | `wire-floating-anchor` | 1203 / 1239 (97.09%) | 0 / 502 (0.0%) |
| med | `shelter-conflict` | 12 / 21 (57.14%) | 0 / 17 (0.0%) |
| med | `lod2-eave-mismatch` | 1138 / 2114 (53.83%) | 1119 / 2097 (53.36%) |
| med | `pavement-carriageway` | 390 / 983 (39.67%) | 0 / 1026 (0.0%) |
| med | `on-cycletrack:flags` | 18 / 47 (38.3%) | 0 (none found) |
| med | `cycle-cycle-overlap` | 249 / 679 (36.67%) | 0 / 583 (0.0%) |
| med | `on-cycletrack:shelters` | 7 / 21 (33.33%) | 0 (none found) |
| med | `rack-rows` | 275 / 1035 (26.57%) | 0 / 982 (0.0%) |
| med | `on-carriageway:flags` | 11 / 47 (23.4%) | 0 (none found) |
| med | `on-carriageway:bikes` | 1324 / 7102 (18.64%) | 0 (none found) |
| med | `on-carriageway:meters` | 7 / 47 (14.89%) | 0 (none found) |
| med | `on-carriageway:hoops` | 884 / 6128 (14.43%) | 0 (none found) |
| med | `signal-no-junction` | 23 / 164 (14.02%) | 21 / 164 (12.8%) |
| med | `surf-surf-diffclass` | 30 / 229 (13.1%) | 0 / 309 (0.0%) |
| med | `on-cycletrack:glass` | 3 / 23 (13.04%) | 0 (none found) |
| med | `bld-height-sanity` | 298 / 2517 (11.84%) | 288 / 2497 (11.53%) |
| med | `on-cycletrack:bins` | 59 / 539 (10.95%) | 0 (none found) |
| med | `busstop-far-from-road` | 5 / 47 (10.64%) | 6 / 41 (14.63%) |
| med | `surf-under-road` | 15 / 143 (10.49%) | 0 / 227 (0.0%) |
| med | `overlap:benches+benches` | 92 / 938 (9.81%) | 0 (none found) |
| med | `on-cycletrack:meters` | 4 / 47 (8.51%) | 0 (none found) |
| med | `cycle-carriageway` | 56 / 679 (8.25%) | 3 / 583 (0.51%) |
| med | `on-cycletrack:bollards` | 26 / 396 (6.57%) | 0 (none found) |
| med | `in-building-partial:stands` | 47 / 740 (6.35%) | 0 (none found) |
| med | `on-cycletrack:benches` | 51 / 938 (5.44%) | 2 / 860 (0.23%) |
| med | `on-cycletrack:monuments` | 3 / 76 (3.95%) | 0 (none found) |
| med | `ground-jump-centreline` | 183 / 4655 (3.93%) | 245 / 4690 (5.22%) |
| med | `lake-wall-too-tall` | 0 (none found) | 62 / 1631 (3.8%) |
| med | `rack-giant` | 38 / 1035 (3.67%) | 0 / 982 (0.0%) |
| med | `in-building-partial:bikes` | 256 / 7102 (3.6%) | 0 (none found) |
| med | `tree-crown-facade` | 174 / 4905 (3.55%) | 0 / 4782 (0.0%) |
| med | `on-cycletrack:trees` | 170 / 4905 (3.47%) | 0 (none found) |
| med | `in-building-hidden:bins` | 18 / 539 (3.34%) | 0 (none found) |
| med | `lod2-spire` | 68 / 2114 (3.22%) | 63 / 2097 (3.0%) |
| med | `overlap:glass+stands` | 23 / 763 (3.01%) | 0 (none found) |
| med | `road-road-overlap` | 26 / 931 (2.79%) | 19 / 916 (2.07%) |
| med | `bld-cycletrack` | 64 / 2517 (2.54%) | 0 / 2497 (0.0%) |
| med | `overlap:bins+bins` | 13 / 539 (2.41%) | 0 (none found) |
| med | `bld-carriageway` | 52 / 2517 (2.07%) | 23 / 2497 (0.92%) |
| med | `car-orientation` | 48 / 2694 (1.78%) | 0 / 1067 (0.0%) |
| med | `overlap:stands+stands` | 12 / 740 (1.62%) | 0 (none found) |
| med | `water-surface` | 3 / 229 (1.31%) | 0 / 309 (0.0%) |
| med | `on-cycletrack:stands` | 6 / 740 (0.81%) | 0 (none found) |
| med | `in-water:lamp-poles` | 3 / 467 (0.64%) | 0 (none found) |
| med | `overlap:benches+lamp-poles` | 8 / 1405 (0.57%) | 0 (none found) |
| med | `tree-giant` | 25 / 4905 (0.51%) | 25 / 4905 (0.51%) |
| med | `overlap:benches+bins` | 7 / 1477 (0.47%) | 0 (none found) |
| med | `overlap:benches+bikes` | 31 / 8040 (0.39%) | 0 (none found) |
| med | `in-building-hidden:cars` | 10 / 2694 (0.37%) | 0 (none found) |
| med | `overlap:benches+trees` | 18 / 5843 (0.31%) | 0 (none found) |
| med | `in-building-partial:hoops` | 17 / 6128 (0.28%) | 0 (none found) |
| med | `overlap:bikes+lamp-poles` | 15 / 7569 (0.2%) | 0 (none found) |
| med | `overlap:benches+hoops` | 11 / 7066 (0.16%) | 0 (none found) |
| med | `overlap:bikes+trees` | 14 / 12007 (0.12%) | 0 (none found) |
| med | `overlap:bikes+bollards` | 6 / 7498 (0.08%) | 0 (none found) |
| med | `lakelights-water` | 0 / 143 (0.0%) | 0 / 143 (0.0%) |
| med | `ground-jump-gt25cm` | 0 / 4655 (0.0%) | 117 / 4690 (2.49%) |
| med | `wire-too-low` | 0 / 1239 (0.0%) | 0 / 502 (0.0%) |
| med | `signal-in-building` | 0 / 164 (0.0%) | 0 / 164 (0.0%) |
| med | `busstop-in-building` | 0 / 47 (0.0%) | 0 / 41 (0.0%) |
| low | `tree-generic-genus` | 3709 / 4905 (75.62%) | 3709 / 4905 (75.62%) |
| low | `on-carriageway:cars` | 1751 / 2694 (65.0%) | 1067 / 1067 (100.0%) |
| low | `in-building-hidden:stands` | 317 / 740 (42.84%) | 0 (none found) |
| low | `pavement-cycletrack` | 374 / 983 (38.05%) | 22 / 1026 (2.14%) |
| low | `on-carriageway:bollards` | 141 / 396 (35.61%) | 0 (none found) |
| low | `road-width-cap` | 235 / 931 (25.24%) | 229 / 916 (25.0%) |
| low | `busstop-in-carriageway` | 11 / 47 (23.4%) | 0 / 41 (0.0%) |
| low | `tree-crown-clamped` | 741 / 4905 (15.11%) | 741 / 4905 (15.11%) |
| low | `on-cycletrack:bikes` | 961 / 7102 (13.53%) | 0 (none found) |
| low | `on-cycletrack:lamp-poles` | 52 / 467 (11.13%) | 0 (none found) |
| low | `in-building-hidden:monuments` | 8 / 76 (10.53%) | 0 (none found) |
| low | `on-cycletrack:hoops` | 614 / 6128 (10.02%) | 0 (none found) |
| low | `in-building-hidden:hoops` | 353 / 6128 (5.76%) | 0 (none found) |
| low | `wire-no-span` | 67 / 1306 (5.13%) | 0 / 502 (0.0%) |
| low | `in-building-hidden:bikes` | 358 / 7102 (5.04%) | 0 (none found) |
| low | `in-building-hidden:glass` | 1 / 23 (4.35%) | 0 (none found) |
| low | `mast-height-high` | 16 / 400 (4.0%) | 16 / 1188 (1.35%) |
| low | `surf-surf-sameclass` | 8 / 229 (3.49%) | 0 / 309 (0.0%) |
| low | `in-building-hidden:meters` | 1 / 47 (2.13%) | 0 (none found) |
| low | `wire-too-short` | 24 / 1239 (1.94%) | 0 / 502 (0.0%) |
| low | `pavement-in-bld` | 19 / 983 (1.93%) | 0 / 1026 (0.0%) |
| low | `in-building-hidden:bollards` | 4 / 396 (1.01%) | 0 (none found) |
| low | `wire-too-long` | 11 / 1239 (0.89%) | 0 / 502 (0.0%) |
| low | `water-paths` | 5 / 987 (0.51%) | 5 / 987 (0.51%) |
| low | `surf-under-bld` | 1 / 229 (0.44%) | 0 / 309 (0.0%) |
| low | `overlap:bollards+monuments` | 1 / 472 (0.21%) | 0 (none found) |
| low | `overlap:bins+lamp-poles` | 2 / 1006 (0.2%) | 0 (none found) |
| low | `overlap:bins+glass` | 1 / 562 (0.18%) | 0 (none found) |
| low | `overlap:bollards+cars` | 4 / 3090 (0.13%) | 0 (none found) |
| low | `in-building-hidden:trees` | 6 / 4905 (0.12%) | 0 (none found) |
| low | `in-building-hidden:benches` | 1 / 938 (0.11%) | 0 (none found) |
| low | `overlap:lamp-poles+trees` | 5 / 5372 (0.09%) | 0 (none found) |
| low | `overlap:benches+lakeLights` | 1 / 1081 (0.09%) | 1 / 1003 (0.1%) |
| low | `overlap:bins+stands` | 1 / 1279 (0.08%) | 0 (none found) |
| low | `overlap:bikes+bins` | 5 / 7641 (0.07%) | 0 (none found) |
| low | `overlap:benches+bollards` | 1 / 1334 (0.07%) | 0 (none found) |
| low | `overlap:bikes+glass` | 4 / 7125 (0.06%) | 0 (none found) |
| low | `overlap:trees+trees` | 3 / 4905 (0.06%) | 0 (none found) |
| low | `overlap:bins+cars` | 2 / 3233 (0.06%) | 0 (none found) |
| low | `overlap:bikes+stands` | 4 / 7842 (0.05%) | 0 (none found) |
| low | `overlap:glass+hoops` | 3 / 6151 (0.05%) | 0 (none found) |
| low | `tree-trunk-facade` | 2 / 4905 (0.04%) | 0 / 4782 (0.0%) |
| low | `overlap:cars+glass` | 1 / 2717 (0.04%) | 0 (none found) |
| low | `overlap:cars+meters` | 1 / 2741 (0.04%) | 0 (none found) |
| low | `overlap:hoops+trees` | 3 / 11033 (0.03%) | 0 (none found) |
| low | `overlap:bins+hoops` | 2 / 6667 (0.03%) | 0 (none found) |
| low | `overlap:hoops+stands` | 2 / 6868 (0.03%) | 0 (none found) |
| low | `overlap:cars+lamp-poles` | 1 / 3161 (0.03%) | 0 (none found) |
| low | `overlap:stands+trees` | 1 / 5645 (0.02%) | 0 (none found) |
| low | `overlap:bins+trees` | 1 / 5444 (0.02%) | 0 (none found) |
| low | `overlap:bikes+meters` | 1 / 7149 (0.01%) | 0 (none found) |
| low | `mast-height-low` | 0 / 400 (0.0%) | 0 / 1188 (0.0%) |

## Remaining problems (honest list)

- `ground-jump-gt25cm` 0 -> 117 and `ground-jump-centreline` +62: real terrain steps along roads (Israels Plads, Hammerichsgade, Vandvaerksviadukten viaduct/underpass); roads there are flat polylines on a stepped DTM.
- `road-through-bld` 9, `bld-carriageway` 23, `road-road-overlap` 19: service lanes hugging facades / dual carriageways; carriageway width is one constant per road, so a pinch point cannot narrow it. Sweep #21 shows a house block standing in a street.
- `lake-wall-too-tall` 62 shore vertices (> 2 m quay, e.g. north Sortedams); `car-on-carriageway` is expected (cars are parked on it).
- Cars: only 1067 of 2694 remain; narrow two-way streets cannot show parking because the sim has two lanes there. The sim lanes were not changed.
- 789 wire lamps are now masts; anchors use the facade eave (>= 5.8 m).
- Not touched: `lod2-eave-mismatch`, `lod2-spire`, `tree-generic-genus`, `tree-crown-clamped`, `signal-no-junction` 21, `busstop-far-from-road` 6, `bld-bld`-style LoD2 data.
- Sweep (`sweep-after/`, all 29 images viewed): streets, bridge, lake path read coherently (cars in the parking lane, traffic lane clear, cable lamps anchored). Still visible: lake path slabs with sharp diagonal tone seams and a stray dark triangle (images 13, 14: overlapping path materials the cuts did not reach); flat amber ground-floor slabs and over-scaled bricks (07, 08, 22, 23); street-level cameras of the sweep sit against facades (07, 23); white glowing spire (10); pale band of water and a faint street grid outside the district (aerials 25-26); trees remain faceted blobs. Z-fighting not visible in stills.
- Load cost: building the zone map + placing furniture takes ~0.45 s at start.
