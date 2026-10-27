# LoD2 roof coverage (data/tiles)

177,723 buildings. LoD2 = roofer roof mesh; inferred = roofer had no usable roof (eave-ridge extrusion kept); LoD1 = no roofer record.

| district | buildings | LoD2 | inferred | LoD1 | LoD2 share |
|---|---:|---:|---:|---:|---:|
| Vanløse / Brønshøj | 32,002 | 26,130 | 5,842 | 30 | 81.7 % |
| Valby / Sydhavn | 27,146 | 22,325 | 4,789 | 32 | 82.2 % |
| Christianshavn / Amager | 24,239 | 19,786 | 4,432 | 21 | 81.6 % |
| Vestamager / Ørestad | 23,775 | 18,224 | 5,532 | 19 | 76.7 % |
| Bispebjerg / Nordvest | 23,104 | 18,834 | 4,247 | 23 | 81.5 % |
| Frederiksberg | 12,952 | 10,915 | 2,018 | 19 | 84.3 % |
| Indre By | 9,638 | 8,060 | 1,555 | 23 | 83.6 % |
| Nørrebro | 8,257 | 6,997 | 1,247 | 13 | 84.7 % |
| Østerbro | 8,106 | 6,637 | 1,452 | 17 | 81.9 % |
| Vesterbro | 5,041 | 4,117 | 905 | 19 | 81.7 % |
| Nordhavn | 3,463 | 2,704 | 755 | 4 | 78.1 % |
| **total** | 177,723 | 144,729 | 32,774 | 220 | 81.4 % |

## Why `inferred`

- point cloud unusable: 20,872
- NN % of the footprint has no points: 6,782
- built after the point cloud was scanned: 3,621
- no LoD2.2 geometry: 869
- roofer extrusion mode lod11_fallback: 630

## Cells

- roofer cells synced: 145; without DONE.json (failed): none
- DONE without own buildings (sea / no footprints, nothing to convert): 7 ['6168_721', '6168_722', '6168_723', '6169_723', '6175_729', '6178_728', '6181_727']
