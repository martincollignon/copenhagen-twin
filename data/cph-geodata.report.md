# cph-geodata provenance report

Generated: 2026-10-25T19:10:13+00:00  
Schema: `cph-geodata/1`, origin [723900.0, 6176500.0, 6.84], bbox [-750.0, -750.0, 750.0, 750.0]

## Counts per layer

| layer | count |
|---|---|
| buildings | 2517 |
| roads | 1918 |
| cycleTracks | 116 |
| sidewalks | 983 |
| water | 7 |
| parks | 54 |
| heroes | 1 |
| roadGraph nodes | 3982 |
| roadGraph links | 4743 |
| points.signals | 164 |
| points.trees | 4905 |
| points.bikeRacks | 1037 |
| points.benches | 817 |
| points.lights | 99 |

## Footprint coverage

2506 of 2506 reference GeoDanmark buildings (by `fot_id`, KK `bygning_kk` layer) in the bbox are in the output: **100.00%** (target >= 98%). Missing examples: none.

Caveat: the footprints themselves come from KK's open copy of GeoDanmark `Bygning` (`k101:bygning`), so this compares two KK layers keyed by GeoDanmark id, not the Datafordeler WFS directly.

## Building heights and attributes

- Buildings with a DSM-measured height: **1905 / 2517 (75.7%)**
- Buildings with any height source: 2517 / 2517
  - dsm:p60-p95: 1905
  - kk:bygning:tagrendehoejde_estimat: 481
  - default:outbuilding-height: 105
  - default:storeys*3.0: 26
- With BBR UUID link: 1682 / 2517
- Storeys inferred (no BBR value): 1154
- Ground measured (DTM): 1905; otherwise ground = 0 (flat-district assumption, conf inferred)
- Facade presets: outbuilding=1146, karre-1900=679, pre-1870=378, funk-brick-1945=154, commercial-box=62, slab-1960s=50, modern-2000=46, other=2
- Roof kind: pitched=1296, unknown=1086, flat=135
- Heroes: ['gdk:1064715171']

## Road graph connectivity

3982 nodes (dedup tolerance 0.5 m).

| subgraph | links | components | largest | top 5 sizes (nodes) |
|---|---|---|---|---|
| all links | 4743 | 46 | 95.6% of nodes | [3806, 22, 11, 11, 8] |
| vehicular (secondary/residential/service) | 2061 | 19 | 97.0% of nodes | [1813, 11, 5, 5, 4] |
| vehicular + cycleway | 2325 | 20 | 96.3% of nodes | [1974, 14, 11, 8, 5] |
| cycleway only | 264 | 20 | 47.5% of nodes | [131, 33, 18, 14, 11] |

Vehicular graph: 18 non-main components = 15 touching the bbox edge (clipping slivers) + 3 interior (private courtyard lanes / OSM service stubs).


Roads by class: footway=894, service=395, secondary=281, residential=255, cycleway=93

Road field provenance: lanesBack:inferred=1534, lanesFwd:inferred=1534, oneway:observed=81, speedKmh:inferred=1290, speedKmh:observed=628, width:inferred=1533, width:observed=18, width:scaled=367

Road notes: {'oneway_kk_only': 42}

## Failed / empty layers

None.

## Conventions

- Rings: counter-clockwise in the (x, -z) map plane, no closing duplicate; holes are also CCW (literal schema reading).
- `ground` = 0 without a DTM; `eave`/`ridge` are `ground + height`.
- Facade: all `inferred`, preset in `src` (`default:preset:*`).
