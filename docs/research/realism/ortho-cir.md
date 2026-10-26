# Orthophoto + colour-infrared (CIR) spike

Status: a data spike from 2026-10-26. I ran the prototype `tools/cph-geodata/ortho.py` (`fetch`, then `analyse`). The raw imagery is in `data/raw/ortho/`, which is git-ignored and about 570 MB including the WMS tile cache. The numbers are in `data/raw/ortho/ortho_stats.json` and the previews are in `docs/research/realism/ortho/`. I changed nothing in `js/` or `data/*.json`.

Related work in progress (untracked, another session): `tools/cph-geodata/vegetation_cir.py` and `vegetation.py` already fetch the same CIR layer at 0.5 m and use NDVI with the DHM classes for lawn and planting (`data/cph-vegetation.json`). This spike covers what that work does not: tree crowns against the twin's trees, courtyards, green roofs, lake colour and roof colour.

## 1. Services and licence

| What | Endpoint | Layers | Notes |
|---|---|---|---|
| **GeoDanmark spring orthophoto (used)** | `https://api.dataforsyningen.dk/orto_foraar_DAF` (WMS 1.1.1/1.3.0) | `orto_foraar` (newest), `orto_foraar_10`, `orto_foraar_12_5`, `orto_foraar_cir`, `orto_foraar_10_cir`, `orto_foraar_12_5_cir`. By year: `geodanmark_<YYYY>_10cm[_cir]` and `geodanmark_<YYYY>_12_5cm[_cir]` for 2017-2025, plus `geodanmark_2015/2016_12_5cm[_cir]`, `hrks_2015_10cm[_cir]` and older 2012-2014 regional 10 cm layers without CIR. Capture footprints and times: `fotoindex_<YYYY>` (style `Optagetidspunkt`). | CRS EPSG:25832 (also 25833, 4326, 3857, …). GetCapabilities works without a token. GetMap needs the Dataforsyningen token (Secret Manager `gsearch-token`, sent as a `token` header; `tools/adc-secret.sh gsearch-token`). GetFeatureInfo on `fotoindex_*` currently fails with a server NullPointerException, so I read the dates from the rendered `fotoindex_2025` labels instead. |
| CIR channel layout | same service | `*_cir` | The abstract says "kanalerne NirRG": R = NIR, G = red, B = green. I checked this: the CIR G channel matches the RGB R channel pixel for pixel (`cir_shift_err = 0.0`), so RGB + CIR gives a co-registered **4-band R, G, B, NIR** stack. NDVI = (CIR.R − CIR.G) / (CIR.R + CIR.G). |
| Native resolution | | | 10 cm for Copenhagen in 2025 (`geodanmark_2025_10cm`); `12_5cm` is the national product. The newest image is **2025-04-27, 11:57–12:24 CEST**, three flight strips across the district (`fotoindex_2025`). |
| WMTS variants | `orto_foraar_wmts_DAF`, `orto_foraar_webm_DAF` | | These exist (they return 400 to a WMS-style request). WMTS is not needed; WMS GetMap at 1000 px tiles worked, about 4 min for everything below. |
| Datafordeler mirror | `https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS` | | Needs a Datafordeler user (403 without one). Same data. |
| **MiljøGIS** (miljoegis.mim.dk) | Spatial Suite front-end. `wms?servicename=…` has no public ortho service name I could find. | | MiljøGIS shows two kinds of orthophoto background. (a) **"GeoDanmark ortofoto (DAF)"** is this same Dataforsyningen service, so it adds nothing. (b) **DDO®land** (COWI/Hexagon), which includes summer and leaf-on years, but the Danmarks Miljøportal terms limit it to the ministry, regions and municipalities for case work, plus private personal use: *"Anden kommerciel anvendelse er ikke tilladt"*. **Do not use DDO in the twin.** |
| Summer / leaf-on orthophoto | none open | | I found no `orto_sommer*` service on Dataforsyningen (404 for every name variant I tried). Open Danish orthophotos are **spring only**. Leaf-on imagery would mean DDO (licence-blocked) or Skråfoto nadir views (already used; the 2023/2025 flights are also spring). |

**Licence for GeoDanmark orthophoto:** free data under Klimadatastyrelsen's *Vilkår for brug af frie geografiske data* (the SDFI version of Nov 2022). Commercial and non-commercial use is allowed, with attribution placed reasonably for the medium. Suggested attribution: "Indeholder data fra Klimadatastyrelsen, GeoDanmark ortofoto forår 2025". The capabilities document has no `AccessConstraints`; check the current Klimadatastyrelsen wording before shipping. Sources: [SDFI terms PDF (Nov 2022)](https://www.SDFE.dk/Media/638052180760639799/Vilkår%20for%20brug%20af%20frie%20geografiske%20data,%20opdateret%20november%202022.pdf), [Miljøportal DDO rights](https://support.miljoeportal.dk/hc/da/articles/13877948639005-Danmarks-Arealinformation-Rettighederne-til-brug-af-baggrundskort-og-ortofotos).

## 2. What was downloaded

| Window | EPSG:25832 bbox | Pixel | Layers |
|---|---|---|---|
| `test`: Dronning Louises Bro, Peblinge Sø shore, Blågårds Plads (600 × 400 m) | 723460, 6176780 – 724060, 6177180 | 10 cm (6000 × 4000) | `geodanmark_2025_10cm` + `_cir` |
| `district`: playable bbox (1500 × 1500 m) | 723150, 6175750 – 724650, 6177250 | 25 cm (6000 × 6000) | `geodanmark_2025_12_5cm` + `_cir`, server-resampled |

The files are `data/raw/ortho/{test,district}_{rgb,cir}_2025.tif` (GeoTIFF, deflate) and the per-tile PNG cache is in `data/raw/ortho/tiles/`. `.gitignore` covers `data/raw/`.

## 3. Findings (numbers are from `ortho_stats.json`)

Method: NDVI is smoothed over 0.3 m. The vegetation threshold is Otsu over non-water, non-shadow pixels (0.043 for the district, 0.049 for the test window, close to the 0.04 that `vegetation.py` uses). **Canopy** = vegetated and within 0.5 m of a DHM class-5 (high vegetation) cell. **Low vegetation** = vegetated and not canopy.

### 3.1 Phenology caveat (most important)

The photo date is **27 April**, so many trees are in bud and not in leaf. A 2.5 m disc round each twin tree counts as "leafed" when at least 50 % of it is canopy:

| genus | n | leafed | genus | n | leafed |
|---|---|---|---|---|---|
| poplar | 48 | 98 % | cherry | 148 | 53 % |
| willow | 43 | 95 % | maple | 60 | 50 % |
| oak | 40 | 80 % | plane | 49 | 29 % |
| chestnut | 171 | 77 % | ash | 19 | 21 % |
| generic (auto-detected) | 3709 | 75 % | robinia | 68 | 18 % |
| lime | 271 | 74 % | elm | 74 | 11 % |

Blågårds Plads is the clearest case. Its ring of trees is bare, so the NDVI crown mask misses it (`05_zoom_blaagaard_courtyards.png`), while the lakeside trees are fully green. **Ortho NDVI cannot size crowns for late-leafing species.** For crown size, the DHM class-5 footprint is the leaf-independent source; NDVI should only confirm that a crown is there and give the green extent on the photo date.

### 3.2 Trees: twin vs real crowns (district, 4905 twin trees)

- The twin already has two tree sources: `kk:trae_basis` (1795, municipal) and **`kk:automatisk_detekterede_traeer` (3110)**. The second set covers the courtyards. So "invisible courtyard trees" are mostly in the twin already (`04_masks_kktrees_test.png`: most courtyard crowns have a yellow KK circle).
- **Positions match.** 3520 of 4905 trees (72 %) have a green crown within 2.5 m of the trunk. Most of the other 1385 are late-leafing genera (above), not misplaced trees.
- **Crown radii are too small and only weakly correlated** (leafed trees, nearest-tree share of canopy capped at 9 m):
  - Twin `crown_radius` median: 3.5 m. Ortho canopy: 4.4 m. LiDAR class-5 footprint: 5.0 m.
  - Ortho/KK ratio: 1.10 overall, 1.13 for auto-detected and 1.03 for trae_basis. LiDAR/KK ratio: 1.25.
  - 1313 leafed trees have a real crown more than 30 % larger than the twin's; 479 are more than 30 % smaller.
  - Per-tree correlation with the KK radius: r = 0.31 for ortho and 0.33 for LiDAR. Either the KK radii are coarse (trae_basis radii are inferred from species/age), or nearest-tree partitioning is noisy in dense groups. Probably both.
- **Missing trees**: canopy blobs (≥ 12 m², NDVI and LiDAR class 5) more than 9 m from any twin tree:
  - District: 672 blobs, 26,600 m² (about 9 % of the 30.3 ha canopy). 454 of them (18,100 m²) are off-street, in courtyards, the churchyard edge and backlots; 218 (8,500 m²) are on the street.
  - Test window: 80 blobs, 3,600 m², shown in magenta in `04_masks_kktrees_test.png`.
  - At about 25 m² per crown this is roughly **1000 trees**, and it is a lower bound, because bare late-leafers are not counted.

### 3.3 Ground cover vs `cph-surfaces.json` / `cph-vegetation.json` (district)

| twin class | m² | veg frac | of which canopy | NDVI median |
|---|---|---|---|---|
| gravel | 48,900 | 0.69 | 0.56 | 0.16 |
| cobbles | 100,400 | 0.09 | 0.08 | −0.07 |
| setts | 8,100 | 0.04 | 0.03 | −0.08 |
| asphalt_road (KK belægning) | 9,800 | 0.33 | 0.30 | −0.02 |
| KK sidewalks | 93,600 | 0.04 | 0.04 | −0.09 |
| KK parks | 258,900 | 0.71 | 0.56 | 0.14 |
| veg:lawn (vegetation.py) | 47,700 | 0.93 | 0.12 | 0.22 |
| veg:planting | 17,400 | 0.91 | 0.19 | 0.20 |
| veg:parkfloor | 145,500 | 0.85 | 0.82 | 0.18 |

- I found no grass or paving mislabels in the KK classes. Wherever paved classes show vegetation it is almost all **canopy over the paving** (the gravel lake paths under the trees), not grass on the ground. The ortho supports the gravel class along the lakes.
- vegetation.py's lawn polygons are 93 % vegetated in the ortho, 81 % of it low (lawn). That output is consistent with this stage.
- **Courtyards** (not street + 4 m, not park, not building, not water): 45.3 ha in the district. Of that, 9.3 ha is canopy (21 %) and 2.7 ha is low vegetation or lawn. Most courtyard ground is paved or shaded. From the helicopter this is the largest area the street-derived data cannot texture.

### 3.4 Lake colour (district, lakes eroded 6 m, NDVI < 0.05, glints removed; about 2 % excluded)

| lake | sRGB median | sRGB white-balanced* | linear (WB) |
|---|---|---|---|
| Peblinge Sø | 65, 77, 75 | 68, 78, 71 | 0.058, 0.077, 0.063 |
| Sankt Jørgens Sø | 66, 76, 75 | 69, 77, 71 | 0.060, 0.075, 0.063 |
| Sortedams Sø | 58, 66, 67 | 61, 67, 63 | 0.046, 0.056, 0.050 |
| twin `DEEP` (js/water-cph.js) | ≈ 25, 56, 56 | | 0.010, 0.040, 0.040 |
| twin `SHALLOW` | ≈ 60, 82, 69 | | 0.045, 0.085, 0.060 |

\*White balance: the ortho has a blue cast. Sunlit KK pavements, which should be near neutral, read sRGB 148/152/164, so I applied gains of 1.045/1.018/0.943.

Real Søerne water seen from straight above (Fresnel ≈ 2 %, so this is mostly body colour) is a **desaturated grey-green**: G/R ≈ 1.3, B/R ≈ 1.1. The twin's DEEP is 4× darker in red and strongly cyan (G/R = B/R = 4). Sortedams is about 20 % darker than the other two. `08_lake_colour_swatches.png` shows them side by side. This is a one-constant calibration with a large visual effect, because the lakes are the biggest single surface in most views. It is not applied here, since `js/` was out of scope.

### 3.5 Roofs

- Over 1321 buildings fully inside the district window (footprint eroded 1.5 m), the ortho roof median is sRGB 151/156/168 and the twin's Skråfoto-nadir `observed.roof.tone` median is 149/147/148.
- Mean absolute difference per channel is 16/18/24. Luminance correlation is r = 0.65.
- The bias is the same for every BBR material: ortho minus twin is about +3/+8/+20. That is the ortho's blue cast, not a twin error. After white balance the two agree to about 10–15 sRGB levels.
- **Ortho adds little for roof colour.** The Skråfoto pipeline is newer, is calibrated, and is sampled on the eave plane. The ortho is not a true ortho, so tall roofs lean several metres off their footprints.
- **Green roofs are the exception and a clear win.** 10 roofs ≥ 20 m² are more than 50 % NDVI-green with no LiDAR high vegetation over them (4,300 m²). For 9 of these the twin has `green_frac` < 0.2. They include the sedum roofs of the Nørreport station pavilions (`07_green_roof_candidates.png`: olive in RGB, saturated red in CIR). The Skråfoto colour heuristic misses sedum because it is olive-brown in the visible bands. NIR separates it cleanly.

## 4. Proposal: a `tools/cph-geodata/ortho.py` stage

The prototype is already at that path (uv inline deps, `fetch` and `analyse` subcommands, token from env or `adc-secret.sh gsearch-token`, never printed). It writes only into `data/raw/ortho/` and `docs/research/realism/ortho/`. To turn it into a stage, rank the work by visual value as follows:

1. **Lake body colour → `data/cph-lakes.json` `lakes[].colour`** (high value, trivial).
   - Fields: `{"srgb": [68,78,71], "linear": [0.058,0.077,0.063], "wb_gain": [...], "px": n, "src": ["geodanmark:orto_foraar:2025-04-27"], "conf": "observed"}` for each lake. Peblinge and Sortedams need splitting, because `lake:0` currently spans both basins and the split is at Dronning Louises Bro.
   - The engine would then derive `DEEP` and `SHALLOW` from it instead of hard-coding them (`js/water-cph.js`), subtracting about 0.01 linear for sky reflection at nadir.
2. **Green roofs → `buildings[].observed.roof`** (high from the air).
   - Add `green_frac_nir` and set `type_hint: "green"` when it exceeds 0.5. Use `conf_fields: {"type_hint": "observed"}` and append `"geodanmark:orto_foraar_cir:2025"` to `src`.
   - Rule: NDVI > threshold + 0.05, no DHM class-5 returns, footprint eroded 1.5 m, area ≥ 20 m².
   - Belongs in `appearance.py` as a post-pass, or `ortho.py` can write a sidecar that appearance merges.
3. **Missing trees → `cph-furniture.json` `trees[]`** (medium–high, courtyards and backlots from the helicopter, plus about 200 on streets).
   - One tree per canopy blob, or a watershed split per blob. Use the 12 m² minimum and > 9 m from existing trees.
   - Fields as the existing trees: `x, z, crown_radius, height`. Height = DSM p95 − DTM from `dhm.py` when a token is available.
   - Tagging: `src: ["geodanmark:orto_foraar_cir:2025", "dhm:punktsky:class5"]`, `conf: "observed"`, `conf_fields: {"genus": "inferred", "height": "measured", "crown_radius": "measured"}`, `licence: "Klimadatastyrelsen frie data"`.
4. **Crown radius correction for existing trees** (medium). Use the DHM class-5 footprint for size and NDVI only as a check. Ortho is confounded by leaf-out, and both sources correlate weakly with KK per tree.
   - Suggested rule: when the LiDAR share differs from KK by more than 30 % and the tree is isolated (no other tree within 1.5 × r), write `crown_radius` with `conf_fields.crown_radius: "measured"` and `src += ["dhm:punktsky:class5"]`.
   - Otherwise only rescale globally: the KK radius is about 1.1–1.25 × too small.
5. **Per-tree leaf state** (`trees[].leaf_apr ∈ [0,1]`, `conf: "observed"`) (low–medium). This is real phenology: elm, robinia, ash and plane are bare and willow and poplar are green. A spring or season mode could show bare crowns for those genera on the right date. It also flags trees whose genus label looks wrong.
6. **Courtyard ground albedo texture** (medium visually, but with caveats). Drape the 25 cm ortho (white-balanced) over the courtyard ground as an albedo map, about 45 ha in the district (≈ 7.2 Mpx at 25 cm, about 8–10 MB as KTX2/JPEG tiles). Caveats:
   - noon shadows are baked in (sun about 49° high, from the south);
   - cars, people and the lean of tall buildings are baked in.
   - It works only where the camera stays high. Use it as a far-LOD or helicopter layer and keep the procedural ground up close.
7. **NDVI raster for vegetation.py**. `vegetation_cir.py` currently fetches its own 0.5 m CIR. Make `ortho.py fetch` the single cache and derive `data/raw/veg/ndvi.tif` from `district_cir_2025.tif` (25 cm → 1 m mean) so the imagery is downloaded once.
8. Roof colour from the ortho: **not recommended**, beyond using it as a QA cross-check for the Skråfoto appearance (`appearance_qa.py`).

Attribution to add to the outputs' `attribution`: "Indeholder data fra Klimadatastyrelsen (GeoDanmark ortofoto forår 2025)".

## 5. Previews (`docs/research/realism/ortho/`, each < 400 KB)

- `01_rgb_test_10cm.png`, `02_cir_test_10cm.png`, `03_ndvi_test.png`: the test window. Blågårds Plads is left of centre and Dronning Louises Bro is at the top right.
- `04_masks_kktrees_test.png`: dark green = canopy, light green = low vegetation or lawn, magenta = canopy with no twin tree within 9 m, yellow = twin trees at their `crown_radius`.
- `05_zoom_blaagaard_courtyards.png`: RGB next to the masks. It shows the bare Blågårds Plads ring and the courtyard crowns.
- `06_district_canopy_vs_kktrees.png`: district canopy and low vegetation, with twin trees as dots.
- `07_green_roof_candidates.png`: the top 6 green-roof candidates (RGB | CIR) with footprints.
- `08_lake_colour_swatches.png`: ortho lake colour, raw and white-balanced, against the twin's DEEP and SHALLOW.
