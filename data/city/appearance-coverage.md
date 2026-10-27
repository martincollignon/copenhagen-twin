# Citywide appearance coverage

Source: `data/tiles/<id>/appearance.json` (cph-appearance/1) of 465 tiles; kommune by building centroid in `data/city/boundary.geojson` (DAGI).

| kommune | buildings | wall tone observed | roof tone observed | walls observed | photo atlas |
|---|---:|---:|---:|---:|---:|
| Frederiksberg | 12,952 | 12,235 (94.5 %) | 12,817 (99.0 %) | 86,693 / 111,411 (77.8 %) | 6,014 (46.4 %) |
| København | 146,119 | 131,164 (89.8 %) | 144,582 (98.9 %) | 830,695 / 1,213,091 (68.5 %) | 57,855 (39.6 %) |
| outside DAGI boundary | 18,652 | 17,133 (91.9 %) | 18,526 (99.3 %) | 106,085 / 128,243 (82.7 %) | 5,745 (30.8 %) |
| **all** | 177,723 | 160,532 (90.3 %) | 175,925 (99.0 %) | 1,023,473 / 1,452,745 (70.5 %) | 69,614 (39.2 %) |

## Share of building footprint area

| kommune | footprint area | wall tone observed | roof tone observed | photo atlas |
|---|---:|---:|---:|---:|
| Frederiksberg | 2.10 km2 | 99.3 % | 99.8 % | 89.1 % |
| København | 16.47 km2 | 98.2 % | 99.7 % | 84.4 % |
| outside DAGI boundary | 1.74 km2 | 98.8 % | 99.8 % | 71.2 % |
| **all** | 20.31 km2 | 98.4 % | 99.7 % | 83.8 % |

Tiles: 496 in the index, 465 with buildings, 465 with an `appearance.json`; 452 tiles have at least one photo atlas, 449 tiles have wall tones on >= 90 % of their footprint area.

## Gaps: lowest wall-tone coverage by tile (footprint area)

| tile | kommune | buildings | wall tone | roof tone | atlas |
|---|---|---:|---:|---:|---:|
| 1439_12360 | København | 1 | 0.0 % | 100.0 % | 0.0 % |
| 1449_12344 | København | 14 | 31.3 % | 100.0 % | 24.8 % |
| 1456_12361 | København | 7 | 34.9 % | 97.0 % | 33.0 % |
| 1450_12344 | København | 27 | 66.4 % | 94.9 % | 64.7 % |
| 1444_12340 | København | 5 | 76.4 % | 100.0 % | 56.1 % |
| 1458_12346 | København | 11 | 78.8 % | 100.0 % | 44.1 % |
| 1443_12351 | Frederiksberg | 194 | 84.5 % | 99.7 % | 77.2 % |
| 1449_12343 | København | 36 | 85.1 % | 100.0 % | 47.7 % |
| 1440_12360 | outside DAGI boundary | 2 | 85.3 % | 100.0 % | 85.3 % |
| 1457_12350 | København | 6 | 86.0 % | 100.0 % | 81.8 % |
| 1455_12353 | København | 38 | 86.8 % | 100.0 % | 82.9 % |
| 1457_12351 | København | 53 | 88.6 % | 100.0 % | 66.7 % |
| 1440_12358 | København | 1000 | 89.1 % | 99.9 % | 69.9 % |
| 1447_12347 | København | 126 | 89.4 % | 100.0 % | 86.1 % |
| 1439_12358 | København | 988 | 89.7 % | 99.6 % | 57.5 % |

Atlas descriptors (`observed.atlas`) exist for 69,614 buildings with 559,512 photo walls; the engine draws a photo wall only for a building that has one (and whose webp it can fetch). Buildings without a descriptor keep tone facades.

## Atlas quality gate

Atlas run of 136 cells (texel 0.1 m): 67,229 atlases (772 MB webp), 538,183 of 1,001,904 strips kept, 90,925 buildings dropped (every strip failed: tone facade).

| reason (a strip can have several) | strips |
|---|---:|
| under half of the look strip observed after facade_look (occlusion / fill) | 101,271 |
| wall under 4 m (sheds, annexes: mostly roof / ground in the oblique) | 367,970 |
| texture view at more than ~70 degrees to the wall normal | 31,496 |
| texture view coarser than 0.16 m per photo pixel | 5,454 |

## Where the atlases live and how the engine gets them

- Produced by the Cloud Run job `cph-skraafoto` (`tools/cloud/skraafoto/`, mode `atlas`, then `attach`) into `gs://lun-integrations-dev-cph-twin/skraafoto/tex-look/<gdk_id>.webp`; tile layers (`skraafoto/tiles/<tile>/appearance.json`) next to them, `skraafoto/attach.done` once the descriptors are merged.
- `python3 tools/cloud/skraafoto/cloudctl.py sync` copies the tile layers into `data/tiles/<tile>/appearance.json` (refused while attach is older than the atlas run) and up to `--atlas-cap-gb` of inner-city atlases into `data/tex-look/`.
- The engine reads atlases from the data base URL (`js/data-config.js`: `./data` locally, the R2 bucket `cph-twin-data` in the deployment, uploaded by `tools/hosting/upload_r2.py`); a 404 leaves that building on its tone facade.


Tile layers total 336.4 MB; the local `data/tex-look` holds 30 MB of webp atlases.

District validation not available: no cell final.pkl.gz in the work dir (APPEARANCE_WORK), run on the machine that ran the job or after a cloudctl sync of the cells

QA contact sheet: `data/city/appearance-qa.png` (20 random buildings: wall tone swatches (tone_cal), roof tone, atlas thumbnail where present).
