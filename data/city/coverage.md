# Citywide data coverage (Københavns + Frederiksberg Kommune)

Generated 2026-10-26 17:22 UTC by `tools/cph-geodata/build_city.py` (stage `report`). 496 tiles of 500 m in 145 one-km cells (`data/city/tiles.json`).

## Layers

| layer | tiles done | of | features (by list) | bytes |
|---|---:|---:|---|---:|
| buildings | 465 | 496 | buildings 177,723 | 154.6 MB |
| roads | 492 | 496 | cycleTracks 1,941, parks 2,344, points.benches 9,700, points.bikeRacks 13,974, points.lights 1,657, points.signals 1,948, points.trees 396,776, roads 45,978, sidewalks 10,098, water 388 | 112.0 MB |
| terrain | 496 | 496 | buildings 177,723 | 86.7 MB |
| surfaces | 421 | 496 | markings 379,575, surfaces 7,141 | 86.9 MB |
| furniture | 483 | 496 | benches 10,703, bikeRacks 13,954, binStands 38,297, bins 6,298, bollards 8,290, busStops 1,343, glassContainers 639, lakeLights 2,977, lamps 40,104, monuments 545, parkMeters 446, parkingBays 149,096, rescuePosts 124, trees 390,280 | 178.3 MB |
| entrances | 443 | 496 | entrances 99,871 | 45.8 MB |
| groundfloor | 368 | 496 | venues 11,574 | 1.6 MB |
| vegetation | 383 | 496 | canopy 93,149, surfaces 109,607 | 143.5 MB |
| lod2 | 15 | 496 | buildings 2,516 | 0.6 MB |

## Buildings

- GeoDanmark Bygning footprints (Datafordeler GEODKV `bygning_current`) with the centroid inside the DAGI boundary: **156,971**; of them in the tiles: **156,955 (99.99 %)**; missing 16 (target >= 98 %).
  - kommune 0101: 144,018 footprints, 16 missing
  - kommune 0147: 12,953 footprints, 0 missing
- Buildings compiled (parts of multipolygons count separately): 177,723.
- Height source (eave and ridge):
  - DHM DSM p60/p95 over DTM ground (measured): 122,875 (69.1 %)
  - KK `tagrendehoejde_estimat` (observed): 31,470 (17.7 %)
  - default 3.2 m outbuilding (inferred): 22,627 (12.7 %)
  - BBR storeys x 3.0 m (inferred): 751 (0.4 %)
- Footprint sources: KK `bygning` 144,330, KK `bygning_kk` extra 2,130, GeoDanmark Bygning added where KK has none (all of Frederiksberg, plus gaps) 31,282 (22,001 of them without a BBR record).

## Road graph (`data/city/roadgraph.json`)

- 116,963 nodes, 140,725 links, built once from the citywide road layer (OSM centrelines of the 496 tiles).
- All classes (carriageways, cycleways, footways): 574 connected components; the largest holds **97.31 %** of the linked nodes; the other 573 are isolated footpath, service-yard and park networks that OSM does not connect to the street network (3,152 nodes in total).
- Carriageways only (primary, secondary, residential, service): 172 components; the largest holds **97.40 %** of 58,963 nodes; the other 171 components have at most 172 nodes each (private yards, car parks and cul-de-sacs mapped without a junction to the network) and hold 1,534 nodes in total.
- Vehicles and agents can therefore reach 97.4 % of the carriageway nodes from any other; no kommune part (Amager, Vestamager, Frederiksberg, Nordhavn, Valby) is cut off: 12 carriageway components have more than 20 nodes.

## District reproduction (16 tiles of the earlier district build)

- Buildings in the 16 district tiles, inside the old district bbox (+-750 m): reference 2,517, now 2,516 identical ids (99.96 %); 1 reference ids no longer exist in any source (demolished or re-surveyed since the district build); 460 ids are new inside the old bbox: the footprints of the part of the old district that lies in Frederiksberg (the KK `bygning` layer has none there, so the district build had holes) and a few gap-fills.
- Outside the old district bbox the same tiles now hold 2,411 further buildings (the district build only covered +-750 m).
- Of the identical ids: median eave difference 0.00 m; 337 (13.4 %) differ by more than 5 cm, 88 by more than 0.5 m (mean 0.087 m, max 11.2 m; the large ones are footprints of a few m2 beside a tall building). Cause: the DHM WCS resamples differently for every request window (measured: the same 600 m window requested inside two different bboxes differs by 0.14 m on average and by up to 23 m at single building edges); the district build used 800 m windows over the district, this one uses 600 m windows per 1 km cell.
- Photo-measured wall tones (`observed`) were carried over to 2,516 of the identical buildings (same footprint); 0 had a changed footprint and keep none.

## Frederiksberg substitutions

The KK WFS layers are empty in Frederiksberg Kommune; these sources replace them (`src`/`conf` mark every item):

| item | source used | count | note |
|---|---|---:|---|
| surface materials (paving classes) | none (KK dp_belaegninger is KK-only); OSM place=square / pedestrian areas citywide | 0 | Frederiksberg pavements are drawn from the sidewalk polygons with the engine's default Københavnerfortov; roads default asphalt |
| pedestrian crossings (markings) | GC2 vej.fodgaengerfelt | 266 | line buffered to a 3 m strip (width inferred); no other marking register exists (no lane paint, arrows, bays, blue cycle fields) |
| ground-floor venues | OSM shops/amenities citywide (KK bevillinger is KK-only) | 1,028 | no serving-permit layer for Frederiksberg |
| trees (geodata points.trees, furniture trees) | GC2 byrum_ekstern.registrerede_traer + byrum.vejtraer | 28,637 | heights are the register's 5 m class midpoints (inferred) or 10 m when unclassed; crown = 0.5 x height (inferred); KK's 310k auto-detected crowns (heights, crown areas) stop at the border, so Frederiksberg has no crown polygons and fewer garden trees |
| bike racks | GC2 mobilitet.cykelstativer | 2,133 | capacity from antal_pladser; 5 (inferred) when empty |
| benches | GC2 byrum.baenk (43, 2018) + OSM amenity=bench | 442 | positions only |
| traffic signals | GC2 byrum.signalanlaeg (OSM signals were already citywide) | 3 | only signals more than 25 m from an OSM/KK signal |
| pavements (sidewalks) | GC2 stab.fortovsareal (staff schema, provenance unclear) | 5,154 | polygons as published; KK fortovsmatrikel is KK-only |
| street lamps | OSM highway=street_lamp (no Frederiksberg lamp inventory is open) | 158 | mast type, height 6 m, light source and colour temperature are defaults (inferred); no wire-suspended lamps |
| bollards | OSM barrier=bollard (no register) | 88 | material/colour defaults (inferred) |
| bins, glass containers | GC2 byrum.skraldespande, affald.glascontainere (+ OSM waste baskets) | 1,551 | bin stands (ask_standpladser) not available |
| bus stops | Movia Stoppestedsudstyr (regional) + GC2 busstoppesteder_frederiksberg where Movia has none within 15 m | 62 | GC2 stops: shelter/bin/countdown flags from the table, bench/cycle parking unknown |
| parking bays | GC2 mobilitet.parkeringspladser (polygons) | 22,023 | bay kind and orientation inferred from the polygon shape; occupancy by the engine as elsewhere |
| monuments | GC2 byrum_ekstern.monumenter (current versions) | 121 |  |
| benches, bike racks (furniture lists) | GC2 byrum.baenk + OSM; GC2 cykelstativer + 2020 cykelparkering | 2,575 | bench length 1.8 m default; byinventar (KK) has no Frederiksberg equivalent |

## Not done yet / queued

- LoD2 roofs (roofer, cloud job): 0 of 145 cells converted into the tiles; 145 cells wait for roofer output under `data/raw/lod2-out/<cell>/` (then `--stage lod2`); buildings there keep the flat / eave-ridge roofs.
- vegetation compile: 100 of 145 cells compiled (resume with `--stage vegetation`; all 145 NDVI and LiDAR class rasters are in data/raw/veg); the other 45 cells have no vegetation layer yet (stopped on a full disk).

## Sizes on disk

- `data/tiles`: 834.0 MB (496 tiles)
- `data/city`: 20.7 MB
- `data/raw` (not committed): 2.75 GB
- free disk: 3.8 GB

## Timings

- cells stage: 145 cells, 48.6 CPU-minutes (mean 20 s per 1 km cell)
