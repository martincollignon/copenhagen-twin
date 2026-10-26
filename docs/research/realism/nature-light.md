# Søerne realism: nature, water, sky, light and atmosphere

**Area:** Søerne (Peblinge, Sortedams, Sankt Jørgens Sø) and inner Nørrebro, at 55.68° N, 12.56° E. **Research and URL checks:** 26 October 2026. **Purpose:** concrete targets for making the twin's water, trees, sky and light read as Copenhagen in late October, plus ranked changes against the current code. Companion to [../visual-refs.md](../visual-refs.md), which covers furniture, lamps, the lake-edge blockout (§8a) and tree families (§9); this document does not repeat those.

## Reading the evidence

The tags follow [visual-refs.md](../visual-refs.md):

- **Published:** stated in a cited municipal, scientific or manufacturer source.
- **Observed:** visible in a linked, dated photograph (the licensed copies are in [refs/nature/](refs/nature/ATTRIBUTION.md)), or in the twin's own screenshots and code. Photo colour samples are camera-processed sRGB means of a pixel region; they are good relative targets, not radiometric measurements.
- **Computed:** derived here from a standard method (solar-position equations as used by the [NOAA solar calculator](https://gml.noaa.gov/grad/solcalc/), Koschmieder visibility). Accurate to the method, not measured.
- **Estimate:** an editable starting value.
- **Unresolved:** not established.

## 0. What the twin does today (Observed, code and `docs/qa/sweep-after/contact-*.png`)

Sampled from `contact-3.png`, tiles 13–15:

- **Water:** sRGB about (111, 169, 193) near the camera, rising to (200, 224, 235) at the horizon. The real lake water is far darker and greyer (§1.1).
- **Lake path:** cool light grey, about (183, 188, 192). The real path is warm beige gravel, about (195–200, 170–183, 146–164).
- **Sun direction, the most consequential finding.** `TIME_PRESETS` in `js/lighting.js` puts the sun in the **north-north-west** in every day preset (the frame is x = east, z = south):
  - "Golden Hour · 17:45": elevation 35.6°, azimuth 327°.
  - "Sunny Midday · 13:30": 55.1°, 324°.
  - "Blue Hour · 19:15": +21.2°, 326°.

  At 55.68° N the sun never stands at 35° in the NNW. At 13:30 it is in the south, and during blue hour it is 4–8° *below* the horizon (§3). All shadows therefore point the wrong way, south-facing façades (Nørre Søgade faces the lake to the south-east) are back-lit, and the "golden" preset has no low-sun character.
- **Wetness:** `cityUniforms.uRoadWetness` is set per preset (`lighting.js:302`) but nothing reads it (`grep uRoadWetness js/` finds only its declaration in `tsl-materials.js:77`). Wet roads are not rendered.
- **Trees:** trees 32–200 m from the camera (`TREE_NEAR`/`TREE_MID` in `js/street-furniture-cph.js`) are drawn as `buildMidCrown()`, an `IcosahedronGeometry(1, 1)` blob. That is the faceted look in the sweep shots. Card crowns appear only within 32 m.
- **Tree species:** 3,709 of the 4,905 trees in `data/cph-furniture.json` (76%) have no species and fall back to `TREE_STYLES.generic`.
- **Post-processing:** ACES Filmic tone mapping, with saturation 1.06–1.08 plus a vibrance boost in `js/post-processing.js`. There is no ambient occlusion, no temporal anti-aliasing (MSAA only) and SSR at half resolution. The water gets no SSR, because its metalness is 0; it uses a planar `reflector()` at a 0.4 resolution scale.

## 1. Søerne water

### 1.1 Colour, clarity and turbidity

- **Depth and area [Published].** KK's 2012 monitoring note gives:

  | Basin | Area (ha) | Mean depth (m) | Max depth (m) |
  |---|---|---|---|
  | Skt. Jørgens Syd | 6.6 | 4.2 | 5 |
  | Skt. Jørgens Nord | 6.1 | 4.2 | 4.5 |
  | Peblinge | 10.4 | 2 | 2.5 |
  | Sortedams Syd | 9.2 | 2 | 2.2 |
  | Sortedams Nord | 14.4 | 2 | 2.5 |

  The lakes are "fixed by banks of stone setting and bulwark". [De Indre Søers miljøtilstand 2012, Fiskeøkologisk Laboratorium for KK, Table 1](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1307_B5JXv7v6IK.pdf). Total protected area is about 50 ha, and the walking loop is 6.35 km ([lex.dk, Søerne](https://lex.dk/S%C3%B8erne)).
- **Secchi depth [Published].**
  - Peblinge Sø had a Secchi depth above 2.0 m in summer 2011 and 2012, and the bottom was visible at every inspection.
  - Sortedams Syd: above 2.0 m and above 1.9 m.
  - Sortedams Nord: above 2.0 m in 2011, then 1.5 m in 2012, dropping to about 1 m in late July with chlorophyll-a at 20.2 µg/l.
  - Skt. Jørgens Nord: 2.1 m in 2010, rising to 3.4 m in 2012 (chlorophyll-a 43.5 to 6.0 µg/l).

  Same report, §§2–5. Before the 2002–06 restoration (carp removal of 29.1 t; 50,000 and 70,000 pike fry), visibility was about 0.5 m ([lex.dk](https://lex.dk/S%C3%B8erne)).
- **So the Peblinge/Sortedams water is clear to the bottom, and the bottom is a weed carpet [Published].** In 2012, submerged plants covered 90% of Peblinge Sø (9.4 ha), led by Canadian waterweed (*vandpest*, *Elodea*), with 38% filamentous algae cover. Sortedams Syd had 75% cover (35% filamentous algae) and Sortedams Nord 64%. Same report, Tables 4, 7 and 9.
- **Weed cutting [Published].** Weed is cut every year in Peblinge and Sortedams to keep an open surface for dinghies and pedal boats (*vandcykler*), and it was suspended in Sortedams in 2024. KK notes the extra weed "can break the lake's glassy surface", and torn-off weed drifts along the shore. Skt. Jørgens is not cut (4–5 m deep; cutting reaches only about 1.5 m). [KK note on reduced weed cutting, 22 Oct 2024](https://www.kk.dk/sites/default/files/2024-10/22.10.24%20-%20Orienteringsnotat%20om%20gr%C3%B8desk%C3%A6ring%20i%20Sortedams%20S%C3%B8%20i%202024.pdf).
- **Observed colour targets** (sRGB means, `refs/nature/`):

  | Where | sRGB | Source |
  |---|---|---|
  | Near edge, bed visible through the water (Peblinge, Sept, hazy) | (55, 63, 58) / (63, 76, 78) | `lake-edge-water-colour.jpg`, `lake-edge-path-overview.jpg` |
  | 20–100 m out, reflecting a hazy sky | (128–148, 140–158, 156–172) | same |
  | Clear November sky, low sun, ripples | (103, 141, 173) | `peblinge-nw-november-low-sun.jpg` |
  | Windy April day, deep blue | (64, 97, 134) | `soerne-fountain-swan.jpg` |
  | Heavy overcast | (54, 57, 63) | `peblinge-overcast-winter-railing.jpg` (processed, mood only) |

  The rule these samples show: **the water body is a dark olive/brown-green transmission seen near your feet, and further out the lake is almost purely a reflection of the sky.** The water is never tropical cyan. In late summer and autumn, add yellow-green weed and algae mats ([`peblinge-swan-pedal-boat.jpg`](refs/nature/peblinge-swan-pedal-boat.jpg), [`sortedams-sunset-october.jpg`](refs/nature/sortedams-sunset-october.jpg)) [Observed].
- **Physics [Estimate, standard].** Water reflects F0 ≈ 0.02 head-on. A standing eye at 1.7 m looking 30 m out meets the water at about 3°, where Fresnel reflectance is about 0.6. Beyond about 15 m the colour is therefore dominated by the reflected sky and shore, which is why the sky's colour and saturation decide the lake's colour.

### 1.2 Reflections and ripples

- **[Observed]** The surface ranges from glassy on calm mornings and evenings (`edge-sitting-swans-willow.jpg`, `sortedams-sunset-october.jpg`: crisp façade and tree reflections) to a short wind chop on fresh days (`lake-edge-path-overview.jpg`, `soerne-fountain-swan.jpg`), where reflections break into vertical streaks.
- **[Estimate]** Chop wavelength is 0.2–1.5 m, with crests of 2–5 cm on the 2.5 m-deep, roughly 200 m-wide basins. There is no long swell. The current `WAVES` table in `js/water-cph.js` (λ up to 9 m, amplitude 2.2 cm) is plausible for a windy day. A calm preset should scale amplitudes by about 0.2 so the planar reflection stays sharp.
- **[Observed]** Wind slicks are common: calm bands sheltered by the tree rows next to rippled open water.

### 1.3 Water level, edge and freeboard

- **Construction [Published].** The vertical granite revetments of Peblinge and Sortedams sit below grass slopes and date from 1928–29. They were renovated in the 1990s, and the Skt. Jørgens edges were closed for renovation in 2024–25 ([lex.dk](https://lex.dk/S%C3%B8erne)). Skt. Jørgens has sloped sides ([Wikipedia, The Lakes](https://en.wikipedia.org/wiki/The_Lakes,_Copenhagen); [da.wikipedia, Peblinge Sø](https://da.wikipedia.org/wiki/Peblinge_S%C3%B8)).
- **Behind the stone [Published].** The facing is granite setting on a concrete wall, which has four concrete generations (about 1910–2000). At Østerbrogade the edge stands on timber posts that are normally under water. Faults include fallen granite stones, eroded joints and frost damage, and ice loosened stones at Kampmannsgade in winter 2020–21. [KK status note on the stone edges, 8 Aug 2024, with the 2021 budget note and concrete report](https://kk.dk/sites/default/files/agenda/af8eddb2-1392-49c9-a6a5-8449c9058094/4a0c80d7-1515-4653-b79e-d81f8ea6a304-bilag-2_1.pdf).
- **Water level [Published].** The level varies. In a dry year it fell 32 cm, and the bed was exposed along the edges (undated TV 2 Kosmopol report: "lowest in 26 years", the previous low being 1992, so probably 2018) ([TV 2 Kosmopol](https://www.tv2kosmopol.dk/kobenhavn/soerne-har-naet-laveste-vandstand-i-26-ar-og-de-stinker)).
- **Edge form [Observed].**
  - The face is battered (inclined), not plumb, in `lake-edge-water-colour.jpg` and `sortedams-people-edge.jpg`.
  - Coping is a pale weathered concrete/granite band about 0.3 m wide.
  - The wall face is warm grey-beige, sRGB about (169, 146, 120), with a dark wet/algal band at the waterline.
  - Freeboard from path to water is about 0.3–0.6 m on normal days.
  - There is a stepped seating edge where people sit with their feet near the water (`edge-sitting-swans-willow.jpg`).
  - Railings are local only (`peblinge-overcast-winter-railing.jpg`), consistent with visual-refs §8a.
- **Current twin [Observed, code].** `WATER.surfaceY = -0.8` m below ground, with a plumb wall and a dark granite ashlar (`createLakeWallMaterial`, stone sRGB about 0.15–0.34 linear). **[Estimate]** Set freeboard to 0.45 m (range 0.3–0.6), batter the face about 15–25° from vertical, and use a warmer, lighter stone.

### 1.4 Promenade surfaces

- **[Observed]** The lower lake paths are compacted fine gravel (*stenmel*/*grus*): sunlit sRGB about (195–200, 170–183, 146–164), and darker and browner when wet or backlit, about (79, 63, 50). The surface has pale fines, scattered 5–15 mm grit and weed tufts along the edge.
- **[Observed]** A grass verge or bank separates the lower path from the upper path or road. On the Nørrebro side there are two parallel paths with a grass strip and the chestnut row between them (`lake-path-autumn-golden.jpg`).
- **[Observed, data]** The twin's `gravel` class shader (`surface-materials-cph.js`, `srgb(150,138,118)`–`(176,165,146)`) is already about right. The lake promenade, however, has no polygon in `data/cph-surfaces.json`: a point-in-polygon test at the lake-path camera positions of shots 13–15 finds none, or only unclassified ones. The promenade therefore renders as the default ground or pavement.
- **[Published, analogue]** Stenmel is added to gravel paths to bind the surface. Grass encroaches from the sides ([Naturstyrelsen path-maintenance note 2025](https://naturstyrelsen.dk/media/a1whhtdr/notat-stivedligehold_2025.pdf), not Copenhagen-specific).

### 1.5 Birds, boats, fountain, people

- **Birds [Published].** Wintering waterfowl include tufted duck (troldand), wigeon (pibeand), pochard (taffeland) and mute swan (knopsvane). Moorhen and great crested grebe breed, and a cormorant colony lives on Fugleøen (about 400 m², 1917) in Sortedams Sø ([lex.dk](https://lex.dk/S%C3%B8erne); [da.wikipedia, Sortedams Sø](https://da.wikipedia.org/wiki/Sortedams_S%C3%B8)).
- **Birds [Observed].**
  - About 15 mute swans grouped near the Peblinge café pontoon (November).
  - Dozens of coot-sized black birds spread over Sortedams at an October sunset.
  - Over 100 mallards plus swans and gulls in a winter ice hole.
  - Swans with grey cygnets in July.
  - Gulls on the coping.

  **[Estimate]** For a late-October scene, instance 20–40 dark birds (coot/tufted duck, 0.35–0.45 m) per basin in loose rafts and 5–15 mute swans (1.4–1.6 m, white with an orange bill), concentrated near people at the bridges and the café. Add slow drift and V-shaped wakes.
- **Pedal boats [Published + Observed].** KK names pedal boats (*vandcykler*) and optimist dinghies as the reason weed is cut in Peblinge Sø (note above). White and black swan-shaped pedalos are Observed in June 2019 and September 2023. **[Estimate]** Season April–September; moored or absent in late October. Exact rental operator and season: **Unresolved**.
- **Fountain [Observed].** A floating fan-jet fountain, about 8–10 m spray height, with a rainbow, was seen on 2021-04-03 (`soerne-fountain-swan.jpg`). Which basin, its position and its operating season: **Unresolved** (no municipal source found). **[Estimate]** Model it as a switchable spring/summer feature.
- **Café pontoon [Published].** Kaffesalonen, Peblinge Dossering 6, has a wooden deck on the lake ([VisitCopenhagen](https://www.visitcopenhagen.com/copenhagen/planning/kaffesalonen-gdk412437)). The glazed pavilion on its pontoon is Observed in `peblinge-november-facades-swans.jpg`.
- **People [Observed].** Joggers, prams, strollers and cyclists walking bikes crowd the gravel path. People sit on the coping or steps with their legs over the water, and the benches face the lake.

### 1.6 Ice and winter

- **[Published]** KK requires 16–18 cm of ice before walking on the lakes. A cold spell typically measured 6–8 cm ([TV 2 Kosmopol](https://www.tv2kosmopol.dk/kobenhavn/frost-sa-tyk-er-isen-nu)).
- **[Published]** National normals (1991–2020) give 6.9 snow-cover days in January and 7.4 in February ([DMI, Danmarks klima 2023, monthly tables](https://dmi.dk/fileadmin/Rapporter/2024/DMIRap24-01.pdf)).
- **[Observed]** In cold spells, a matte white, snow-dusted ice sheet covers the lake, with an open hole where birds keep the water free near the bridge or café (`sortedams-winter-ice-hole.jpg`).

## 2. Trees

### 2.1 Species and sizes

- **[Published]** Horse chestnut rows were planted on most sides of the lakes in the 1930s and are replaced as needed. Willows line the east side of Vester Søgade ([lex.dk](https://lex.dk/S%C3%B8erne)).
- **[Observed, data]** Among the 1,196 trees in the twin's data with a species, the most common (counts from `data/cph-furniture.json`, KK `trae_basis`) are:

  | Species | Count |
  |---|---|
  | *Aesculus hippocastanum* | 155 |
  | *Prunus avium* 'Plena' | 128 |
  | *Tilia* × *europaea* (plus 78 'Pallida', 53 *T. platyphyllos* 'Ørebro', 15 *Tilia* sp., 11 *T.* × *euchlora*) | 100 |
  | *Crataegus* | 55 |
  | *Platanus* × *acerifolia* | 47 |
  | *Populus nigra* 'Italica' | 45 |
  | *Salix* sp. | 39 |
  | *Ulmus* 'Lobel' and 'New Horizon' | 65 |
  | *Robinia* | 59 |
  | *Metasequoia* | 16 |

- **[Published] Sizes:**
  - Horse chestnut: 15–24 m tall, 12–15 m spread ([UF/IFAS ST061](https://ask.ifas.ufl.edu/publication/ST061); RHS: ultimate height over 12 m, broad crown, [RHS](https://www.rhs.org.uk/plants/585/wd/details)).
  - *Tilia* × *europaea* 'Pallida': 20–30 (35) m tall, 10–15 m wide, golden autumn colour, leaves drop relatively early ([Van den Berk](https://www.vdberk.co.uk/trees/tilia-europaea-pallida/)).
- **[Observed]** The lakeside chestnuts are about 15–20 m with crowns meeting over the inner path (`lake-path-autumn-golden.jpg`, `peblinge-swan-pedal-boat.jpg`). The data's inferred heights have a median of 8 m (`conf_fields.height: inferred`), so lakeside rows are probably too short. **[Estimate]** Clamp mature lakeside *Aesculus* to H 16–20 m and crown radius 6–8 m when the height is inferred.

### 2.2 Seasonal colour (late October is the target)

**[Published]** Horse-chestnut leaf miner (*Cameraria ohridella*) has been in Denmark since 2002. Heavy attacks brown the leaves and cause early leaf fall ([lex.dk, hestekastanje](https://lex.dk/hestekastanje); [Wikipedia](https://en.wikipedia.org/wiki/Horse-chestnut_leaf_miner)). Copenhagen chestnuts are often brown-edged from August.

| Month | *Aesculus* (lake rows) | *Tilia* | *Platanus* | *Salix* | Source |
|---|---|---|---|---|---|
| Jun–Jul | deep green, crowns closed | mid green | mid green | yellow-green | Observed (`peblinge-swan-pedal-boat.jpg`) |
| Sep | green with brown mines | green | green | green | Observed (`lake-edge-path-overview.jpg`: crowns starting to tan) |
| early–mid Oct | orange-brown/rust, thinning; crown mean about sRGB (52, 38, 26) back-lit | yellow-green to yellow | green-ochre | green-yellow | Observed (11 Oct 2014; 18 Oct 2024) |
| late Oct (scene date) | 40–70% leaves gone, brown; litter on the gravel | gold, 20–50% fallen | ochre-brown, holding | yellow-green, holding | Estimate, bracketed by the Oct and Nov photos |
| mid Nov | bare; a few yellow leaves on limes | mostly bare | brown leaves hang on | thinning | Observed (`peblinge-nw-november-low-sun.jpg`, 15 Nov 2025; `peblinge-november-facades-swans.jpg`, 19 Nov 2016) |
| Dec–Mar | bare, dark wet bark; fine twig mass reads grey-purple at distance | bare | bare, mottled bark | bare, yellow-orange twigs | Observed (`sortedams-winter-ice-hole.jpg`, `peblinge-overcast-winter-railing.jpg`) |

**[Estimate] Bark:**

- *Aesculus*: dark grey-brown, scaly plates, sRGB about (75, 65, 58); near-black when wet.
- *Tilia*: grey with fine ridges, about (95, 90, 82). Burrs and sprouts at the base of 'Pallida' (noted by Van den Berk).
- *Platanus*: camouflage patches of olive-grey, cream and tan. The current `TREE_STYLES.plane` bark (0.56, 0.52, 0.42) is right as a mean.

### 2.3 Real-time tree techniques for three.js WebGPU

- **Leaf-card clusters with alpha test.** These are the current `buildNearTree` approach. Add a **spherical crown normal**: blend each card's normal towards `normalize(pos − crownCentre)` (60–80%) so the crown shades as a volume. Also add **two-sided transmission**, a back-lit leaf glow of about 0.3 × albedo (the dominant cue in `lake-path-autumn-golden.jpg`). [GPU Gems 3, ch. 16: Crysis vegetation shading](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis); [ch. 4: SpeedTree rendering](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-4-next-generation-speedtree-rendering).
- **ez-tree** (Dan Greenheck, MIT) is a procedural three.js tree generator with branch levels, leaf billboards, bark textures and presets including deciduous and bare trees. It is suited to baking 3–4 variants per genus (in leaf and bare) into the near LOD. [GitHub](https://github.com/dgreenheck/ez-tree) · [live editor](https://www.eztree.dev/).
- **Octahedral impostors** replace the faceted mid-LOD blob: a baked atlas of about 8×8 views per tree variant, blended by view direction, at a cost of 2 triangles per tree. [Ryan Brucks, Octahedral Impostors](https://shaderbits.com/blog/octahedral-impostors); three.js implementation [agargaro/octahedral-impostor](https://github.com/agargaro/octahedral-impostor).
- **InstancedMesh2** (agargaro) adds per-instance frustum culling, LOD and BVH to three.js instancing, as an alternative to the hand-rolled LOD in `street-furniture-cph.js`. [agargaro/instanced-mesh](https://github.com/agargaro/instanced-mesh).
- three.js instancing examples: [webgpu_instance_mesh](https://threejs.org/examples/webgpu_instance_mesh.html); alpha-tested shadows: [webgpu_shadowmap_opacity](https://threejs.org/examples/#webgpu_shadowmap_opacity).
- [SpeedTree](https://www.speedtree.com/) is the commercial reference: wind hierarchy, LOD blending, seasonal colour variation. It is not needed here, but its ideas carry over: per-tree hue jitter and branch-level colour patches rather than per-tree flat tints.

## 3. Sky and light at 55.68° N

### 3.1 Sun geometry [Computed, solar-position equations, Copenhagen 55.684° N 12.564° E, 2026]

| Date | Solar noon | Max elev. | Sunrise | Sunset | Civil dusk ends | Blue hour (sun −4° → −8°) | Golden hour starts (sun 6°) |
|---|---|---|---|---|---|---|---|
| 20 Mar | 12:18 | 34.3° | 06:13 | 18:24 | 19:01 | 18:46–19:15 | 17:35 |
| 21 Jun (CEST) | 13:12 | 57.8° | 04:26 | 21:58 | 22:59 | 22:34–23:31 (no astronomical night) | 20:55 |
| 23 Sep (CEST) | 13:02 | 34.1° | 06:57 | 19:07 | 19:44 | 19:29–19:58 | 18:18 |
| **26 Oct (CET)** | **11:53** | **21.8°** | **07:03** | **16:44** | **17:23** | **17:08–17:37** | **15:50** |
| 21 Dec | 12:08 | 10.9° | 08:38 | 15:39 | 16:26 | 16:08–16:43 | 14:21 |

Elevation and azimuth on **26 Oct** at sample times:

| Time | Elevation | Azimuth |
|---|---|---|
| 10:00 | 17.8° | 151° |
| 13:30 | 18.8° | 205° |
| 16:00 | 4.7° | 239° |
| 17:45 | −9.2° (night) | 261° |

On 21 Jun at 17:45 the sun is at 31.3°, azimuth 266°. Day length is 7 h 01 min at the winter solstice and 17 h 32 min at the summer solstice ([WeatherSpark, Copenhagen](https://weatherspark.com/y/74001/Average-Weather-in-Copenhagen-Denmark-Year-Round)). Even at noon in late October the sun is only about 22° high, so the scene is a **low-sun scene all day**: long shadows (2.5× object height at noon), and lake-facing façades on Nørre Søgade and Peblinge Dossering raked by light.

**[Estimate] Frame correction.** The twin's frame is ETRS89 / UTM 32N (`frame.epsg 25832`), whose grid north differs from true north by about +2.9° here (convergence ≈ Δλ · sin φ = 3.56° · sin 55.68°). Grid azimuth = true azimuth − 2.9°; verify with `pyproj` in `tools/` before relying on it. The world direction is `(sin A, tan e, −cos A)` normalised, in x = east, y = up, z = south.

### 3.2 Cloud, sun and rain statistics

- **[Published] Overcast frequency.** The sky is overcast or mostly cloudy 43% of the time in July (the clearest month), **58% in October** and 70% in December. Wet days (≥ 1 mm): **9.6 in October**, 9.6 in December, 5.6 in April. The daily chance of precipitation peaks at about 33% around 30 October ([WeatherSpark](https://weatherspark.com/y/74001/Average-Weather-in-Copenhagen-Denmark-Year-Round)).
- **[Published] Sunshine, national normals 1991–2020:**

  | Month | Sunshine (h) | Precipitation (mm) |
  |---|---|---|
  | January | 52.0 | 65.3 |
  | June | 227.3 | 64.3 |
  | July | 227.8 | – |
  | **October** | **99.1** | **83.2** |
  | November | 53.8 | – |
  | December | 42.9 | – |

  Annual total 1,669 h ([DMI, Danmarks klima 2023](https://dmi.dk/fileadmin/Rapporter/2024/DMIRap24-01.pdf)). **[Computed]** October sunshine is about 31% of possible daylight hours. The honest default for a late-October Copenhagen twin is **bright overcast or broken cloud**, with clear-sky golden light as a variant.

### 3.3 Haze, aerial perspective and light colour

- **[Computed]** Koschmieder: extinction β = 3.912 / V. Typical clean-air visibility V of 20–40 km gives β = 1.0–2.0 × 10⁻⁴ m⁻¹. Across Peblinge Sø (about 250 m), transmission is 95–98%. Over the 1–1.5 km lake vistas it is 74–90%, so a visible veil of 10–26% horizon colour.
- **[Observed]** `lake-edge-water-colour.jpg` shows a September haze in which the far shore drops to low contrast at about 1 km.
- **[Observed, code]** `createAerialFogNode` uses `1 − exp(−τ²)`, a squared exponent. With `fogDensity 0.00024` that gives 5.6% fog at 1 km and 40% at 3 km. Near-field haze is too weak and the far field closes too abruptly.
- **[Estimate] Light colour.**
  - Overcast daylight: about 6,500–7,500 K, near-neutral to slightly cool.
  - Clear-sky shade fill: about 9,000–12,000 K (blue).
  - Low sun (5–10° elevation): about 3,000–4,000 K. Sun at 20° (October noon): about 4,500–5,000 K.
- **[Observed]** Low sun on yellow and red brick, from the November 2025 photo:
  - Sunlit façade mean: sRGB (130, 95, 65), strongly orange.
  - Sky: about (182, 219, 245) at the top, pale and desaturated near the horizon (181, 196, 215).
  - Nordic skies are **pale**, not saturated cyan, because of the long air mass at low sun.

## 4. Weather and surfaces

- **Wet asphalt and puddles [Published, technique].** Wetting darkens porous albedo (about ×0.5–0.7 for asphalt and gravel) and lowers roughness. Puddles behave as standing water: roughness about 0.02, albedo of water, with the reflection from SSR or the environment. [Lagarde, *Water drop 3b: physically based wet surfaces*](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/).
- **Rain frequency [Published].** About 9.6 wet days in October (§3.2). **[Estimate]** "Wet ground, not raining" holds on roughly a third of late-October hours, so a damp state (wetness 0.3–0.5) is a better default than bone dry.
- **Autumn leaves on paths [Observed].** Chestnut leaves lie on the gravel and grass under the rows in October (`lake-path-autumn-golden.jpg`, `sortedams-sunset-october.jpg`). **[Estimate]** Use instanced leaf decals with 20–60% cover under *Aesculus* crowns on 26 Oct, darker and flatter when wet; on the road, only in gutters.
- **Rain particles.** See the three.js example [webgpu_compute_particles_rain](https://threejs.org/examples/webgpu_compute_particles_rain.html).

## 5. Rendering techniques available in three.js r17x+ WebGPU/TSL

All the examples below resolve as of 26 Oct 2026. Node sources are in [examples/jsm/tsl/display](https://github.com/mrdoob/three.js/tree/dev/examples/jsm/tsl/display); the repo imports `three/addons/` from `three.js@dev`.

| Technique | three.js node/API | Example | Note for this twin |
|---|---|---|---|
| GTAO (ambient occlusion) | `ao()` in [GTAONode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/GTAONode.js) | [webgpu_postprocessing_ao](https://threejs.org/examples/webgpu_postprocessing_ao.html) | Needs depth plus `normalView` (already in the MRT in `main.js`). Ground-truth AO paper: [Jimenez et al. 2016](https://iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf). The biggest single lift for street canyons and tree bases. |
| SSGI | [SSGINode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/SSGINode.js) | [webgpu_postprocessing_ssgi](https://threejs.org/examples/webgpu_postprocessing_ssgi.html) | Costlier than GTAO; colour bleed from brick. A later step. |
| SSR | [SSRNode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/SSRNode.js) | [webgpu_postprocessing_ssr](https://threejs.org/examples/webgpu_postprocessing_ssr.html), [ssr_denoise](https://threejs.org/examples/webgpu_postprocessing_ssr_denoise.html) | Already used. The current mask uses metalness only, so wet roads need a wetness-driven mask. |
| Planar reflection | `reflector()` | [webgpu_reflection](https://threejs.org/examples/webgpu_reflection.html), [reflection_roughness](https://threejs.org/examples/webgpu_reflection_roughness.html) | Already used for the lakes at 0.4 scale. Blur by ripple slope. |
| TRAA (temporal AA) | [TRAANode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/TRAANode.js) | [webgpu_postprocessing_traa](https://threejs.org/examples/webgpu_postprocessing_traa.html) | Stabilises alpha-tested leaf cards and thin masts far better than MSAA. Also [TAAU](https://threejs.org/examples/webgpu_upscaling_taau.html). |
| Bloom | `bloom()` in [BloomNode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/BloomNode.js) | [webgpu_postprocessing_bloom](https://threejs.org/examples/webgpu_postprocessing_bloom.html) | Already used. |
| Tone mapping | `AgXToneMapping`, `NeutralToneMapping` ([constants](https://threejs.org/docs/#api/en/constants/Renderer)) | [webgpu_tonemapping](https://threejs.org/examples/webgpu_tonemapping.html) | AgX desaturates bright highlights gracefully (sky and water glints), where ACES pushes cyan and orange. [AgX reference](https://github.com/sobotka/AgX). |
| 3D LUT grading | [Lut3DNode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/Lut3DNode.js) | [webgpu_postprocessing_3dlut](https://threejs.org/examples/webgpu_postprocessing_3dlut.html) | One LUT per weather/time "look", matched to the reference photos. |
| Height fog / scattering fog | `fog()`, `rangeFogFactor`, custom `fogNode` | [webgpu_fog_height](https://threejs.org/examples/webgpu_fog_height.html), [webgpu_custom_fog_scattering](https://threejs.org/examples/webgpu_custom_fog_scattering.html) | The twin already has a sky-matched `fogNode`; fix its falloff (§3.3). |
| Physical sky | `SkyMesh` (Preetham, plus the procedural cloud layer in r18x) | [webgpu_sky](https://threejs.org/examples/webgpu_sky.html) · [SkyMesh.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/SkyMesh.js) | Already used. Preetham is weak at low sun and twilight. Hillaire's LUT model ([EGSR 2020 paper](https://sebh.github.io/publications/egsr2020.pdf), [reference code](https://github.com/sebh/UnrealEngineSkyAtmosphere)) and Bruneton's ([precomputed atmospheric scattering](https://ebruneton.github.io/precomputed_atmospheric_scattering/)) handle a 0–20° sun and blue hour properly. A three.js Bruneton port with aerial perspective exists: [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial). |
| Volumetric clouds and light | — | [webgpu_volume_cloud](https://threejs.org/examples/webgpu_volume_cloud.html), [webgpu_volume_lighting](https://threejs.org/examples/webgpu_volume_lighting.html), [webgpu_postprocessing_godrays](https://threejs.org/examples/webgpu_postprocessing_godrays.html) | God rays through chestnut crowns at low sun: high wow factor at moderate cost. |
| Cascaded shadows | `CSMShadowNode` | [webgpu_shadowmap_csm](https://threejs.org/examples/webgpu_shadowmap_csm.html) | The twin uses a 2-cascade `SunLight`. Low October sun needs longer cascades because shadows are 2.5–10× object height. |
| Contact and screen-space shadows | [SSSNode.js](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/SSSNode.js) | [webgpu_postprocessing_sss](https://threejs.org/examples/webgpu_postprocessing_sss.html), [webgpu_shadow_contact](https://threejs.org/examples/webgpu_shadow_contact.html) | Grounds benches, bins, bollards, birds and people where the cascades are too coarse. |
| Water | `WaterMesh` | [webgpu_water](https://threejs.org/examples/webgpu_water.html), [webgpu_backdrop_water](https://threejs.org/examples/webgpu_backdrop_water.html) | `webgpu_backdrop_water` shows depth-based transmission; that is the cue missing from the lakes. |

## 6. Top changes for the twin (ranked)

Impact is on perceived realism in the lake and street sweep shots. Effort: S < 1 day, M 1–3 days, L > 3 days.

1. **Put the sun where it is.** Impact: very high. Effort: S.
   - In `js/lighting.js`, replace the hard-coded `TIME_PRESETS[*].sunDir` with `sunDirection(date, lat = 55.684, lon = 12.564)` (NOAA equations, about 30 lines; the values to check against are in the §3.1 table). Convert with grid azimuth = true − 2.9°.
   - Default to **26 Oct 2026** and add a date control. Re-time the presets: golden 15:50–16:30 (sun 6° → 1°, az 233–243°); midday 12:00 (21.8°, az 180°); blue hour 17:08–17:37 (sun below the horizon: `sunIntensity` → 0 and sky-only lighting).
   - `SkyMesh.sunPosition` and `uSkySunDir` follow automatically through `applyPreset`. The shadow cascades need `shadow.camera.far` > 300 m for 4–5° sun.
2. **Lake water: dark, clear, weedy, reflecting a pale sky.** Impact: very high. Effort: M.
   - In `createWaterMaterial` (`js/water-cph.js`), add depth transmission. Use `shore` as a depth proxy (bed at 2–2.5 m): `body = mix(bedColour, DEEP, 1 − exp(−depth / 1.2 m))`, with `bedColour` ≈ linear (0.035, 0.045, 0.030) (Elodea, sRGB 55/63/58) and a low-frequency weed-patch noise.
   - Weight it by `(1 − fresnel)`. Currently `colorNode` is lit as an opaque diffuse surface; it should be emissive or unlit transmission so a bright sun does not grey it.
   - Multiply the reflection by 0.85–0.9, and desaturate the sky it sees: lower `turbidity`/`rayleigh` saturation, or grade in step 4. Target the §1.1 sRGB table.
   - Add an autumn/summer floating-weed mask (yellow-green, roughness 0.6), strongest within 5–15 m of the edges.
3. **Lake edge and promenade.** Impact: high. Effort: M.
   - In `js/lakes-cph.js`, set `WATER.surfaceY = -0.45` (Estimate, range 0.3–0.6) and batter the wall: offset the top edge landward about 0.15 m in `wallAlong` for `faceSign`.
   - In `createLakeWallMaterial`, warm and lighten the stone (sRGB about (150–175, 135–150, 115–125)), add a 0.3 m pale coping, and keep the wet/algal band 0–0.25 m above the water.
   - In `tools/cph-geodata/lakes.py` or `surfaces.py`, emit a `gravel` promenade band (3–5 m) along each Peblinge and Sortedams ring, plus a `grass` bank between the lower path and the road. The existing `gravel` shader in `js/surface-materials-cph.js` already has the right colour. This removes the white edge in shots 13–15.
4. **Tone mapping and grading for Nordic light.** Impact: high. Effort: S.
   - In `createPostProcessing` (`js/post-processing.js`), switch `ACESFilmicToneMapping` to `AgXToneMapping` (or `NeutralToneMapping`).
   - Set `LOOKS.*.saturation` to 0.92–1.0 and drop the `vibrance` term to ≤ 0.04.
   - Later, add per-look `Lut3DNode` LUTs fitted to `refs/nature/` photos (overcast, low sun, blue hour).
5. **Trees: kill the icosahedron blobs and go autumn.** Impact: high. Effort: M–L.
   - (a) Raise `TREE_NEAR` to about 70–90 m and give the near cards spherical normals plus back-light transmission (`buildNearTree` in `js/street-furniture-geometry.js`).
   - (b) Replace `buildMidCrown()` with octahedral impostors baked from the near trees (or ez-tree variants), per genus, in-leaf and bare.
   - (c) Add a `uSeason` or day-of-year uniform driving per-genus leaf colour, crown density (alpha-test threshold) and leaf litter from the §2.2 table. For 26 Oct: *Aesculus* brown (sRGB about (110, 70, 35)) at 40–70% density; *Tilia* gold (about (190, 160, 60)); *Platanus* ochre.
   - (d) Default the 3,709 unspecified trees lining the lake rings to `chestnut` (lex.dk), and clamp inferred lakeside heights to 16–20 m (`mapTrees` in `js/street-furniture-data.js`).
6. **Sky and clouds for October.** Impact: high. Effort: S–M.
   - Add an **overcast/broken** preset as the default for October (58% of the time): `cloudCoverage` 0.7–0.85, `cloudDensity` 0.6. Sun intensity × 0.3–0.5 when covered, `hemiIntensity` up, envmap re-baked (`bakeEnvironmentMap`).
   - Clear-sky presets should keep the zenith pale (§3.3 colours).
   - Medium term: replace Preetham with a Hillaire/Bruneton LUT sky (takram port) for correct 0–20° sun and blue hour.
7. **Aerial perspective falloff.** Impact: medium. Effort: S.
   - In `createAerialFogNode` (`js/lighting.js`), use `1 − exp(−τ)` instead of `1 − exp(−τ²)`, with `fogDensity` = β ≈ 1.0–2.0 × 10⁻⁴ (clear) and 3–6 × 10⁻⁴ (hazy or overcast). This gives a 10–26% veil at 1–1.5 km (§3.3).
8. **GTAO plus TRAA.** Impact: medium–high. Effort: M.
   - In `js/main.js`, insert `ao(scenePassDepth, scenePassNormal, camera)` and multiply it into the indirect light only (or into `scenePassColor` before `createPostProcessing`, at about 0.6 strength).
   - Swap MSAA for `traa()` once the leaf cards are denser. Measure fps with `tools/shoot-m2.py`.
9. **Make wetness real.** Impact: medium. Effort: S–M.
   - Consume `cityUniforms.uRoadWetness`, currently dead, in the asphalt and gravel functions in `js/surface-materials-cph.js` and the road materials: albedo × (1 − 0.4w), roughness → mix(r, 0.15, w), plus a noise puddle mask (roughness 0.02, `metalRough` set so SSR picks it up).
   - Default w = 0.3 for October daytime.
10. **Lake life.** Impact: medium (it reads as "Søerne" instantly). Effort: M.
    - Add instanced swans (white, 1.5 m) and coots/ducks (dark, 0.4 m) with drift and simple wakes, clustered near bridges and the café. The density is in §1.5.
    - Add swan pedalos (Apr–Sep only), the fountain (spring/summer toggle) and seated people on the coping (reusing the pedestrian system's seated pose, if available).
11. **Leaf litter and winter state.** Impact: medium. Effort: M.
    - Leaf decals under chestnut and lime crowns, driven by the season uniform.
    - A winter variant: bare impostors, an ice sheet on the lakes (matte, roughness 0.5, a snow-dust noise) with bird holes, and snow on the path and coping.
12. **Low-sun extras.** Impact: medium. Effort: M.
    - God rays through crowns at golden hour ([webgpu_postprocessing_godrays](https://threejs.org/examples/webgpu_postprocessing_godrays.html)).
    - Screen-space contact shadows ([SSSNode](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/SSSNode.js)) for small furniture.
    - Longer CSM cascades for 2.5–10× shadow lengths.

Still to resolve before committing geometry: the surveyed water level and wall batter per basin (KK engineering drawings); the fountain's basin and season; the current species of the 3,709 unspecified trees (KK `trae_basis` fields or a request to KK); and the current swan-pedalo operator.

## Sources checked (URLs resolved on 26 Oct 2026)

KK: [Indre Søers miljøtilstand 2012](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1307_B5JXv7v6IK.pdf) · [weed-cutting note 2024](https://www.kk.dk/sites/default/files/2024-10/22.10.24%20-%20Orienteringsnotat%20om%20gr%C3%B8desk%C3%A6ring%20i%20Sortedams%20S%C3%B8%20i%202024.pdf) · [stone-edge status 2024](https://kk.dk/sites/default/files/agenda/af8eddb2-1392-49c9-a6a5-8449c9058094/4a0c80d7-1515-4653-b79e-d81f8ea6a304-bilag-2_1.pdf).

Encyclopaedias: [lex.dk Søerne](https://lex.dk/S%C3%B8erne) · [lex.dk hestekastanje](https://lex.dk/hestekastanje) · [Wikipedia The Lakes](https://en.wikipedia.org/wiki/The_Lakes,_Copenhagen) · [Wikipedia Sortedam Lake](https://en.wikipedia.org/wiki/Sortedam_Lake) · [da.wikipedia Sortedams Sø](https://da.wikipedia.org/wiki/Sortedams_S%C3%B8) · [da.wikipedia Peblinge Sø](https://da.wikipedia.org/wiki/Peblinge_S%C3%B8).

Climate and sun: [DMI Danmarks klima 2023](https://dmi.dk/fileadmin/Rapporter/2024/DMIRap24-01.pdf) · [WeatherSpark Copenhagen](https://weatherspark.com/y/74001/Average-Weather-in-Copenhagen-Denmark-Year-Round) · [NOAA solar calculator](https://gml.noaa.gov/grad/solcalc/).

News: [TV 2 Kosmopol, ice](https://www.tv2kosmopol.dk/kobenhavn/frost-sa-tyk-er-isen-nu) · [TV 2 Kosmopol, low water](https://www.tv2kosmopol.dk/kobenhavn/soerne-har-naet-laveste-vandstand-i-26-ar-og-de-stinker).

Places: [VisitCopenhagen, Kaffesalonen](https://www.visitcopenhagen.com/copenhagen/planning/kaffesalonen-gdk412437) · [VisitCopenhagen, the Lakes](https://www.visitcopenhagen.com/copenhagen/planning/the-copenhagen-lakes-gdk412235).

Trees: [RHS Aesculus](https://www.rhs.org.uk/plants/585/wd/details) · [UF/IFAS ST061](https://ask.ifas.ufl.edu/publication/ST061) · [Van den Berk Tilia 'Pallida'](https://www.vdberk.co.uk/trees/tilia-europaea-pallida/) · [Wikipedia leaf miner](https://en.wikipedia.org/wiki/Horse-chestnut_leaf_miner) · [Naturstyrelsen path note](https://naturstyrelsen.dk/media/a1whhtdr/notat-stivedligehold_2025.pdf).

Rendering: the three.js examples and nodes linked in §5 · [GTAO paper](https://iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf) · [Hillaire 2020](https://sebh.github.io/publications/egsr2020.pdf) · [Bruneton](https://ebruneton.github.io/precomputed_atmospheric_scattering/) · [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) · [Lagarde wet surfaces](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/) · [GPU Gems 3 ch. 4](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-4-next-generation-speedtree-rendering) and [ch. 16](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis) · [ez-tree](https://github.com/dgreenheck/ez-tree) · [octahedral impostors](https://shaderbits.com/blog/octahedral-impostors) · [agargaro/octahedral-impostor](https://github.com/agargaro/octahedral-impostor) · [agargaro/instanced-mesh](https://github.com/agargaro/instanced-mesh) · [AgX](https://github.com/sobotka/AgX).
