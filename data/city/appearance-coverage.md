# Citywide appearance coverage

Source: `data/tiles/<id>/appearance.json` (cph-appearance/1) of 465 tiles; kommune by building centroid in `data/city/boundary.geojson` (DAGI).

| kommune | buildings | wall tone observed | roof tone observed | walls observed | photo atlas |
|---|---:|---:|---:|---:|---:|
| Frederiksberg | 12,952 | 12,235 (94.5 %) | 12,817 (99.0 %) | 86,693 / 111,411 (77.8 %) | 1 (0.0 %) |
| København | 146,119 | 131,164 (89.8 %) | 144,582 (98.9 %) | 830,695 / 1,213,091 (68.5 %) | 2,384 (1.6 %) |
| outside DAGI boundary | 18,652 | 17,133 (91.9 %) | 18,526 (99.3 %) | 106,085 / 128,243 (82.7 %) | 0 (0.0 %) |
| **all** | 177,723 | 160,532 (90.3 %) | 175,925 (99.0 %) | 1,023,473 / 1,452,745 (70.5 %) | 2,385 (1.3 %) |

## Share of building footprint area

| kommune | footprint area | wall tone observed | roof tone observed | photo atlas (local `data/tex-look`) |
|---|---:|---:|---:|---:|
| Frederiksberg | 2.10 km2 | 99.3 % | 99.8 % | 0.0 % |
| København | 16.47 km2 | 98.2 % | 99.7 % | 3.5 % |
| outside DAGI boundary | 1.74 km2 | 98.8 % | 99.8 % | 0.0 % |
| **all** | 20.31 km2 | 98.4 % | 99.7 % | 2.8 % |

Tiles: 496 in the index, 465 with buildings, 465 with an `appearance.json`; 15 tiles have at least one local atlas, 449 tiles have wall tones on >= 90 % of their footprint area.

## Gaps: lowest wall-tone coverage by tile (footprint area)

| tile | kommune | buildings | wall tone | roof tone | atlas |
|---|---|---:|---:|---:|---:|
| 1439_12360 | København | 1 | 0.0 % | 100.0 % | 0.0 % |
| 1449_12344 | København | 14 | 31.3 % | 100.0 % | 0.0 % |
| 1456_12361 | København | 7 | 34.9 % | 97.0 % | 0.0 % |
| 1450_12344 | København | 27 | 66.4 % | 94.9 % | 0.0 % |
| 1444_12340 | København | 5 | 76.4 % | 100.0 % | 0.0 % |
| 1458_12346 | København | 11 | 78.8 % | 100.0 % | 0.0 % |
| 1443_12351 | Frederiksberg | 194 | 84.5 % | 99.7 % | 0.0 % |
| 1449_12343 | København | 36 | 85.1 % | 100.0 % | 0.0 % |
| 1440_12360 | outside DAGI boundary | 2 | 85.3 % | 100.0 % | 0.0 % |
| 1457_12350 | København | 6 | 86.0 % | 100.0 % | 0.0 % |
| 1455_12353 | København | 38 | 86.8 % | 100.0 % | 0.0 % |
| 1457_12351 | København | 53 | 88.6 % | 100.0 % | 0.0 % |
| 1440_12358 | København | 1000 | 89.1 % | 99.9 % | 0.0 % |
| 1447_12347 | København | 126 | 89.4 % | 100.0 % | 0.0 % |
| 1439_12358 | København | 988 | 89.7 % | 99.6 % | 0.0 % |

Atlas descriptors (`observed.atlas`, written by the `attach` mode) exist for 2,385 buildings; the engine draws a photo wall only for a building that has one, and its webp has to be fetchable. Buildings without a descriptor keep tone facades, whatever sits in the bucket.

## Where the atlases live and how the engine gets them

- Produced by the Cloud Run job `cph-skraafoto` (`tools/cloud/skraafoto/`, mode `atlas`) into `gs://lun-integrations-dev-cph-twin/skraafoto/tex-look/<gdk_id>.webp`; tile layers (`skraafoto/tiles/<tile>/appearance.json`) next to them.
- `python3 tools/cloud/skraafoto/cloudctl.py sync [--atlas-cap-gb 1.5]` copies the tile layers into `data/tiles/<tile>/appearance.json` and the inner-city atlases (nearest to the centre first, up to the cap) into `data/tex-look/`. The rest stay in the bucket if the atlas job produced them (not verified from this session: gcloud auth expired).
- The engine does NOT read the bucket. `js/buildings-real.js` requests `./data/tex-look/<id>.webp` relative to the page; a 404 leaves that building on its tone facade (no retry, no console spam once any atlas has loaded). Serving the remaining atlases needs a static host or CDN for `data/tex-look/` (not set up yet); `data/tiles/` and `data/tex-look/` are git-ignored, so a deployment has to publish them separately.


Tile layers total 261.0 MB; `data/tex-look` holds 30 MB of webp atlases.

District validation not available: no cell final.pkl.gz in the work dir (APPEARANCE_WORK), run on the machine that ran the job or after a cloudctl sync of the cells

QA contact sheet: `data/city/appearance-qa.png` (20 random buildings: wall tone swatches (tone_cal), roof tone, atlas thumbnail where present).
