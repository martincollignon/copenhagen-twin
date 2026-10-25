# Copenhagen twin: open static datasets beyond current ingest

Verified 2026-10-25 by live requests. Bbox: lon 12.553-12.577, lat 55.677-55.691 (about 1.5 x 1.5 km around E=723900 N=6176500).
Counts are features intersecting the bbox (WFS `resultType=hits`, then sampled). Prior inventory: `kolkata-v4/docs/research/valdrada-copenhagen-2026-10-10.md` (Finding 2).

## How the KK queries were done

Base: `https://wfs-kbhkort.kk.dk/k101/ows` (GeoServer, 485 layers in GetCapabilities; HTTP 200, no auth).
Pattern: `?service=WFS&version=2.0.0&request=GetFeature&typeNames=k101:<layer>&outputFormat=application/json&srsName=EPSG:25832&bbox=55.677,12.553,55.691,12.577,urn:ogc:def:crs:EPSG::4326`
(`resultType=hits` for counts). Licences come from the opendata.dk CKAN API (`https://admin.opendata.dk/api/3/action/package_show?id=<pkg>`).
"Licence not stated" = CKAN `license_id` is null for that package. Treat as unconfirmed, ask bydata@kk.dk before redistribution.
Attribution for CC BY 4.0: credit "Københavns Kommune" plus dataset name.

## A. Street scene (highest value)

| # | Dataset | Publisher / endpoint | Access | Licence | In bbox | Key attributes | Twin use | Effort |
|---|---|---|---|---|---|---|---|---|
| 1 | **Street lighting, mast-mounted** (Belysning, master) | Citelum/KK. CKAN `belysning-master`, GPKG `.../resource/51c8134b-bda6-4c8e-91a0-f31c015fc41b/download/mastophaengt_armatur.gpkg` (downloaded, 6.7 MB, EPSG:25832) | download | CC BY 4.0 | **400** (of 20,971 citywide) | `maste_data` (e.g. "Københavnermast 9,0m", "Rørmast 4,0m"), `armatur_data`, `lyskilde_data` (LED vs HNa vs metal halide), `watt`, `installations_dato`, `lampearms_data` | Real lamp positions with pole model, arm and lamp type. Colour temperature per lamp (sodium warm vs LED cool) gives an authentic night look. Current ingest has only 99 lights. | S |
| 2 | **Street lighting, wire-suspended** (Belysning, wirer) | CKAN `belysning-wirer`, GPKG `.../087ffb4d-.../wireophaenge_armatur.gpkg` | download | CC BY 4.0 | **1,306** | `armatur_data` (BGS441 80 LED, AMT CGS 441), `watt` 66/86/170 | Copenhagen's cable-hung lamps across streets. Each point is a lamp on a catenary. Probably the largest single night-look upgrade. Wire geometry is in `belysning-ledninger` (not downloaded). | S |
| 3 | Street lighting, other fixtures | CKAN `belysning-armaturer`, GPKG `.../0d2a1ddf-.../andet_armatur.gpkg` | download | CC BY 4.0 | **196** | custom fixtures (110 are the Israels Plads edge lights), arcade fixtures, platform lights | Special lighting. | S |
| 4 | **Road markings** `afmaerkning_total` | KK WFS `k101:afmaerkning_total` | WFS | CC BY 4.0 | **13,187** polygons | `type`: Hvidafmærkning 8,883; Gul 1,120; Parkering 1,066; Symboler 916; Pile 678; Fodgængerfelt 300; Servicemarkering 88; Vejbump 51; Cykel rampe 49; Blå cykelfelt 35 | Decal layer on the road: zebra crossings, blue cycle crossings, arrows, parking bays, bumps. Also drives a sim lane model. Already named in the prior doc but not yet ingested. | M |
| 5 | **Traffic signs** `skilte_total` | KK WFS `k101:skilte_total` | WFS | CC BY 4.0 (CKAN pkg `trafikskilte`) | **3,041** (2,383 status "Opstillet", 645 "Permanent nedtaget" - filter these out) | `hovedtavle_1` Danish sign code (C61, E33, E70 ...), `undertavle_*`, plain-text meaning, `placering`, `foto_id` | Sign plates by code on poles. Sign texture atlas. | M |
| 6 | **Bollards** `pullert` | KK WFS `k101:pullert` | WFS | CC BY 4.0 | **461** | type (Varmgalvaniseret 325, Granit 130), colour (Grøn 212, Ubehandlet 178, Grå 65), mounting | Instanced bollards with the right material and colour. | S |
| 7 | **Kerb / road-edge lines** `vejkant` (GeoDanmark) | KK WFS `k101:vejkant` | WFS | Licence not stated on layer; source is GeoDanmark (CC BY 4.0) | **2,310** | `vejtype`: Kørevej 1,229; Cykelsti langs vej 390; Sti 356; Hovedsti 290 | Kerb geometry and road-versus-cycle-path separation. Gives crisp sidewalk edges. | M |
| 8 | Refuges / traffic islands `helle`; manholes `broend` (4,722 wells) and drain grates `rist` (5,010) | KK WFS `k101:helle`, `broend`, `rist` (GeoDanmark) | WFS | not stated (GeoDanmark source) | 171 / 4,722 / 5,010 | points/lines with `fot_id`; `broendtype`, `ristetype` mostly null | Instanced manhole covers and drain grates as ground detail. | S |
| 9 | Pole/mast objects `mast` (GeoDanmark) | KK WFS `k101:mast` | WFS | not stated | 967 | geometry only, no type | Poles including non-lighting masts. Use to cross-check lamp positions. | S |
| 10 | **Bus stops, equipment** | Movia ArcGIS `https://geoservices.moviatrafik.dk/arcgis/rest/services/Registrering2/PublicReadOnly/MapServer/0` (HTTP 200 over https) | REST query | licence not stated | **48** | `Windbreaker` (shelter; 20 of 48), `ComFinancedWindbreaker`, `Bench` (26), `TrashCan` (40), `CycleParking` (7), `StandType`, `StandColour`, `CountdownType` (22 with real-time sign), `BicyclePath`, `Refuge`, `Buslines` | Per-stop furniture: shelter yes/no, bench, bin, countdown display. | S |
| 11 | Advertising street furniture (AFA) `afa_byudstyr` | KK WFS `k101:afa_byudstyr` | WFS | CC BY 4.0 | **63** | `familie`: Læskærm 25, Mupi 18, Digital City 10, Freeposter 8, Toilet 2; `reklameflader` | Bus shelters, mupi billboards, digital displays and the Toilet kiosks with ad panels. Place glowing ad panels at night. | S |
| 12 | **City furniture** (Byinventar) `dp_byinventar_p/_l/_f` | KK WFS | WFS | licence not stated on the dataset | p 1,115 / l 586 / f 199 | p: Borner/pullerter 273, Monumenter 78, Sten 50, Vinterskilte 47, Pæle 33, Redningsposte 17; l: Cykelstativer 572 lines; f: Bænkflade 123 | Rescue posts (life-ring posts), stones, winter signs, bench footprints. Overlaps benches/racks already ingested; the net-new classes are rescue posts, stones and posts. | S |
| 13 | Waste bins `affaldskurve_puma` | KK WFS | WFS | CC BY 4.0 (pkg `affaldskurve`) | 602 | bin type | Litter bins (OSM has 281 `waste_basket`). | S |
| 14 | Glass/bottle containers `ask_glascontainer`, bin stand places `ask_standpladser_nokey` | KK WFS | WFS | CC BY 4.0 (glass) | 31 / 1,251 | stand number, fraction | Recycling stations; stand places mark where wheelie bins sit on the street. | S |
| 15 | Parking: `p_pladser` (kerb lines) + `parkering_areal` (polygons) + `parkomat` | KK WFS | WFS | CC BY 4.0 (`parkeringspladser`, `parkomater`) | 1,151 / 782 / 211 | `antal_pladser`, `p_ordning` (Blå betalingszone etc.), `p_type`, `vejside`; occupancy counts at 12/17/22h in `taelling_p_pladser` (3,611 segments, 2016-era) | Parked-car bays with density per hour (parked cars are the cheapest way to make a street look lived-in) and pay-station kiosks. | M |
| 16 | EV chargers `elbil_ladestander_i_drift` | KK WFS | WFS | CC BY 4.0 | 113 (+44 planned) | location | Small charger props, glowing. | S |
| 17 | Crossings: OSM `highway=crossing` 292, `traffic_signals` 162 | Overpass | API | ODbL | see counts | tags incl. `crossing=zebra/traffic_signals` | Cross-check with #4. | S |
| 18 | Drinking posts and fountains `widget_dp_springvand` / `dp_vandinstallationer_p` | KK WFS | WFS | CC BY 4.0 (`drikkevandsposter-og-springvand`) | 32 (15 springvand, 12 drikkepost, 2 water play) | name, status | Animated fountains (e.g. Israels Plads), drinking posts. | S |
| 19 | Playgrounds: `legeplads` 10, `dp_lege_aktivitetselementer_p` 107 (94 play items) | KK WFS | WFS | CC BY 4.0 (`legepladser1`) | see left | element type | Play equipment props and rubber surfaces. | M |
| 20 | Pedestrian zone / sidewalk responsibility `gang_aktivomr` and `fortovsmatrikel` | KK WFS | WFS | CC BY 4.0 for `ansvarsomrader-for-saltning-pa-gangareal`; `fortovsmatrikel` not stated | 462 / 1,923 | `arealtype` "Fortov" | Sidewalk polygons that the prior doc said were missing (this is the nearest KK proxy). | M |
| 21 | Outdoor seating / pop-up permits (Råden over vej) `erhv_raaden_over_vej_events_aabne` | KK WFS | WFS | CC BY 4.0 (`raden-over-vej-*`) | 20,148 events (kategori Udeservering 737; Marked 534; Skilte-Vareudstilling 491; Stilladser ~470; Container 419; Film 881) | polygon, `kategori`, `projekt_start/slut`, `lokation` | Café terraces, market stalls, sandwich boards, scaffolds, container skips as time-scoped props. Dataset includes archive; filter by date. | M |
| 22 | Pedestrian counts `trafiktaelling_fodg` (66), `ptaelling_straekning` (150), bike counts `cykeltaellinger_2017` (3,118 points = parked bike counts), `trafiktaelling` (147) | KK WFS | WFS | mostly CC BY 4.0 (`trafiktal` not stated) | see left | e.g. Frederiksborggade 36,100 pedestrians/day (2023) | Calibrate pedestrian/cyclist agent density per street. | M |

## B. Appearance of buildings

| # | Dataset | Endpoint | Access | Licence | In bbox | Key attributes | Twin use | Effort |
|---|---|---|---|---|---|---|---|---|
| 23 | **SAVE and fredede bygninger** `fredede_bygninger_save` | KK WFS `k101:fredede_bygninger_save` | WFS | CC BY 4.0 (`fredede-og-bevaringsvaerdige-bygninger-save`) | **2,355** | `bevaringsvaerdi` 1-9 (1: 389, 3: 718, 4: 514, -1 unrated: 392), `fredet` (420 listed), `opfoerelse_aar`, `ombyg_aar`, `bygnings_id_bbr`, `byens_sjaelenavn` | Style tier: heritage-listed facades get the richer procedural treatment. Join key is BBR UUID. | S |
| 24 | KK building layer (BBR joined) `bygning` | KK WFS `k101:bygning` | WFS | not stated on layer; BBR/GeoDanmark are CC BY 4.0 | 3,701 | `ydervaeggensmateriale`, `tagdaekningsmateriale`, `supp*`, `opfoerelselsaar`, `antaletager`, `antalerhvervsenheder`, `samleterhvervsareal`, `arealtilerhvervstue`, `kvarternavn`, `tagrendehoejde_estimat` | Mostly already ingested. Net-new fields worth pulling: commercial area/units and ground-floor commercial area (`arealtilerhvervstue`) to decide if the ground floor is a shopfront. | S |
| 25 | **Rooftop solar potential** `solcellepotentiale` | KK WFS `k101:solcellepotentiale` | WFS | not stated on layer (related `soldata-3d-kobenhavn` is CC BY 4.0) | **2,171** | `fot_id`, `bbruuid`, `arealbyg`, `area1000/900/800` (m2 by irradiance class), `klasse_40/100/200`, `mwh_pot` | Roof irradiance classes: paint warmer/darker roof patches, optional solar-panel decals on high-potential roofs. This is potential, not installed panels. | S |
| 26 | **Green roofs** `groenne_tage` | KK WFS | WFS | CC BY 4.0 | 39 | `bbruuid`, `supp_tag_konst` (8 "Levende tage"), roof material, year | Sedum roof texture on 39 roofs. | S |
| 27 | Graffiti-cleaning facade lines `graffiti_facadelinier` | KK WFS | WFS | licence not stated | 76 | `kategori`, `beliggenhed`, `anti_graffiti` | Facade segments in the graffiti programme; weak signal for graffiti decals. | S |
| 28 | Cultural-heritage guidelines `kulturarv_bevaringsvaerdige_bygninger_kp24` (1,122 pts), `kulturarv_kulturmiljoer_kp24` (16), `kulturarv_bybevaring_kp24` (13) | KK WFS | WFS | licence not stated (Kommuneplan) | see left | `vaerdi`, `opfoer_aar`, `bbr_nr` | Conservation areas for per-district style presets. | S |
| 29 | Address points `adgangsadresser_punkter` / `dar_adgangsadresser` | KK WFS | WFS | CC BY 4.0 (`kobenhavn-adresser`) | 3,689 | street, number | House-number plates on facades. (DAWA is gone: `api.dataforsyningen.dk/adgangsadresser` returns HTTP 410.) | S |
| 30 | **BBR enheder (units per floor) and tekniske anlæg** | Datafordeler BBR REST `https://services.datafordeler.dk/BBR/BBRPublic/1/rest/enhed` returns HTTP 403 without credentials; the dk-building-data repo already has a BBR fetcher | token/credentials | CC BY 4.0 (BBR terms) | not counted | unit use per floor, area, technical installations (solar 1230) | Ground-floor use (shop/office/home) per address. UNVERIFIED: not queried here (no credentials used). | M |
| 31 | OSM building tags | Overpass `https://overpass-api.de/api/interpreter` (HTTP 200) | API | ODbL | `building:colour` 89, `building:material` 72, `roof:shape` 106, `roof:colour` 35, `addr:housenumber` 3,511 | colour as name or hex (e.g. `#baa182`, brick/plaster) | Sparse colour hints to override presets on 89 buildings. | S |
| 32 | **Ground-floor businesses** (OSM) | Overpass | API | ODbL | 632 shops (618 named, 301 with opening_hours, 86 brand), 546 food/drink (329 with hours, 151 with outdoor_seating tag) | `shop`, `amenity`, `cuisine`, `name`, `opening_hours` | Shopfront signs and opening/closing lights per hour; outdoor seating where tagged. Top shop types: clothes 109, hairdresser 49, jewelry 27, bicycle 26, bakery 23. | M |
| 33 | **Licensed venues** `bevillinger` (serveringsbevillinger) | KK WFS | WFS | licence not stated | **476** | `koncept` (Spiserestaurant 154, Bar 76, Café 69, Café og bar 38, Diskotek 14, Hotel 11 ...), `nattilladelse`, name | Which ground floors are bars/clubs and whether open at night; nightlife glow. Authoritative complement to OSM. | S |
| 34 | CVR (business register) | Virk CVR distribution requires registration. UNVERIFIED: not queried | token | open (Virk) | n/a | branchekode per address | Fallback for shop types where OSM is empty. | M |

## C. Vegetation and ground

| # | Dataset | Endpoint | Access | Licence | In bbox | Key attributes | Twin use | Effort |
|---|---|---|---|---|---|---|---|---|
| 35 | **Auto-detected trees (height, crown area)** `automatisk_detekterede_traeer_kk_beta` + crowns `..._kroner_kk_beta` | KK WFS | WFS | licence not stated (beta) | 4,268 points / 5,552 crowns | `traehoejde` (e.g. 6.3 m), `kroneareal` (e.g. 31 m2) | Real height and crown size per tree; fixes the 12% crown fill-rate in Træ basis. Includes private trees. | S |
| 36 | **Tree species and age** `trae_basis` (kategori gadetræ 776, parktræ 978, privat træ 104) | KK WFS | WFS | licence not stated (`gadetraeer` pkg is CC BY 4.0) | 1,870 | `traeart`, `slaegtsnavn` (Lind 371, Hestekastanie 222, Elm 76, Tjørn 75, Løn 70, Kirsebær 61, Robinie 55, Eg 55, Platan 51), `planteaar` (66% filled), `kronediameter`, `stammeomfang`, `spiselige_frugter`, `ikonisk_trae` | Species to mesh and seasonal colour (lime vs horse-chestnut vs cherry blossom), age to size. Already ingested as points, so check whether species is carried through. | S |
| 37 | Iconic trees `ikoniske_traer_vedtaget`, protected `fredede_traer` (73), heritage `bevaringsvaerdige_traer` (380) | KK WFS | WFS | CC BY 4.0 | 416 / 73 / 380 | photo URL, species, planting year (the Søgade ring was planted 1900) | Hero trees along the lakes. | S |
| 38 | **Vegetation cover 2024** `vegetationsdaekke_2024` and **tree canopy 2024** `traekronedaekke_2024` | KK WFS (polygons) + raster zips `https://kbhkort.kk.dk/media/vegetation_traeer/vegdaekke_2024_0_13.zip` | WFS/download | licence not stated | 14,118 / 23,440 polygons (canopy has `areal`) | binary NDVI mask from summer orthophoto | Lawn/green ground mask from summer imagery (the spring orthophoto is leaf-off). | S |
| 39 | **Park maintenance plan layers** | KK WFS `dp_graes` 391 (Fælledgræs 110, Brugsplæne 84, Rabatgræs 55 ...), `dp_haek` 60 (hedges), `dp_blomster_f` 102 + `dp_blomster_p` 108 (Staudebede 47, Sæsonblomster 17, climbers 40), `dp_bevoksninger` 196 (shrubs), `dp_pur_formkl_buske` 8, `dp_graes`... | WFS | licence not stated (driftsplan) | see left | element/subtype per polygon | Lawn types (meadow vs mown), hedge lines, flower beds, shrubs as distinct materials and instances. | M |
| 40 | **Surface materials** `dp_belaegninger` | KK WFS | WFS | licence not stated | 227 | `under_element`: Natursten og -fliser 63, Grus 59, Træhulsrist 52, Asfalt 27, Betonsten 16 | Ground material (cobbles, gravel, tree grates) on parks and plazas. Park/plaza only; roads are not covered. | S |
| 41 | Courtyard and city gardens `gaardhaver`, `storbyhaver` | KK WFS | WFS | CC BY 4.0 (`gardhaver`) | 86 / 1 | polygon | Courtyard garden polygons. | S |
| 42 | Cemetery graves `kirkegd_gravsteder` (Assistens) | KK WFS | WFS | licence not stated | 340 | section, row, plot number | Grave plots with grid layout. Assistens is the big green block. | S |
| 43 | **Spring orthophoto, CIR** | `https://api.dataforsyningen.dk/orto_foraar_DAF` (GetCapabilities HTTP 200: layers `orto_foraar`, `orto_foraar_10`, `orto_foraar_12_5`, `orto_foraar_cir` ...); GetMap returns HTTP 403 without a token | WMS/WMTS, token (free Dataforsyningen account) | SDFI free geodata terms (CC BY 4.0-equivalent, attribution "Indeholder data fra Styrelsen for Dataforsyning og Infrastruktur") | n/a | RGB and near-infrared | Ground texture (roads, plazas) and NDVI. Use as ground, not roofs. Token not used here, so imagery itself is UNVERIFIED beyond capabilities. | M |
| 44 | DHM terrain/surface 0.4 m | `https://api.dataforsyningen.dk/dhm_DAF` (HTTP 200) | WCS, token | SDFI free geodata terms | n/a | DTM/DSM | Already used by the repo (dhm). Not net-new. | - |

## D. Water, harbour, lakes

| # | Dataset | Endpoint | Access | Licence | In bbox | Twin use | Effort |
|---|---|---|---|---|---|---|---|
| 45 | Lakes/streams `dp_soeer_vandloeb_f` (8 lake polygons: 5 public, 3 private), `dp_soeer_vandloeb_l`, `vand_oversigtskort` (11) | KK WFS | WFS | CC BY 4.0 (`soer-og-vandlob`) | see left | Better lake outlines than OSM; public/private flag. | S |
| 46 | Bridges `bro_1` (4 lines), `bro` (0), `dp_bygvaerker_f` Broer og platforme (12), Trapper (50), walls `dp_bygvaerker_l` (Hegn 81, Terrænmur 91, Mur 18, Rækværker 6, Låger 17) | KK WFS | WFS | licence not stated | see left | Bridge deck geometry (Dronning Louises Bro), stairs down to lake edges, lake-side walls and railings. | M |
| 47 | Quay edge ownership `ejerforhold_kajkant`, `kbh_kysttyper`, `havn`, `havneringen` | KK WFS | WFS | CC BY 4.0 (`kajkant-ejerforhold`, `kysttyper`) | 2 / 3 / 2 / - | Mostly outside the bbox. Low value for Søerne. | - |
| 48 | Life rings (OSM `emergency=life_ring`) 18, fire hydrants 60, defibrillators 41, CCTV 39 | Overpass | API | ODbL | counts at left | Life rings along the lakes, hydrants (the prior doc said no open hydrant data; OSM has 60 here). | S |

## E. Culture, art, history

| # | Dataset | Endpoint | Access | Licence | In bbox | Twin use | Effort |
|---|---|---|---|---|---|---|---|
| 49 | **Monuments and sculptures** `monumenter` (+ `dp_byinventar_p` "Monumenter og skulpturer" 78) | KK WFS | WFS | CC BY 4.0 | **78** | named works (H.C. Ørsted, Tycho Brahe, Nilen, Tiberen, Huset der regner, Vandkunst, Snublesten 4). Attribute is a point, name and a registry id. | Landmark statues and fountains as hero props; names for labels. | M (modelling) |
| 50 | OSM artwork | Overpass | API | ODbL | 82 `tourism=artwork` (statue, sculpture, bust, mural) | Cross-reference for #49 and murals. | S |
| 51 | Historic maps: **Høje målebordsblade 1842-1899**, **Lave målebordsblade 1901-1971** | `https://api.dataforsyningen.dk/service?REQUEST=GetCapabilities&SERVICE=WMS&servicename=topo20_hoeje_maalebordsblade_DAF&token=<token>` and `..._lave_maalebordsblade_DAF` (GetCapabilities HTTP 200) | WMS, token | SDFI free geodata terms | n/a | Time-slider overlay, lake and rampart history. GetMap not run (needs token), so imagery is UNVERIFIED. | M |
| 52 | Old aerial photos | `historiskekort.dataforsyningen.dk` (about 100,000 older aerial photos, 1930-1957 per search result) | web app; service endpoint not identified | SDFI terms, UNVERIFIED | n/a | 1950s ground texture for a "then and now" mode. No orthophoto service for 1954 found (`orto_1954_DAF` returns HTTP 400). | L |
| 53 | Stadsarkivet locations `k101:arkiver` | KK WFS (CKAN lists it) | WFS | CC BY 4.0 (with terms PDF) | not counted | Archive points only, not photos. Skip. | - |
| 54 | KK 2013 3D city model | CKAN `kobenhavn-3d-bymodel` DGN/DWG/DXF zips | download | licence not stated | whole city | Superseded by DSM-based heights. Skip. | - |

## F. Sound, air, heat, flood (static layers for sim and overlays)

| # | Dataset | Endpoint | Access | Licence | In bbox | Key attributes | Twin use | Effort |
|---|---|---|---|---|---|---|---|---|
| 55 | **Road noise 2022** `vejstoej_2022_cnossos` / `_nord2000` | KK WFS | WFS | **CC0 1.0** | 226 isophone polygons (169 Lden, 57 Lnight; isov 55/60/65/70/75 dB) | dB bands | Noise heat overlay; drive ambient audio level per street from the dB band. | S |
| 56 | Noise at dwellings `vejstoej_boliger_2022` | KK WFS | WFS | CC0 1.0 (same CKAN pkg) | 16,916 points (one per floor) | `lden`, `lnight`, `etage`, `antalpersoner`, `opfoert` | Per-floor facade noise. Per-floor window-level audio. | S |
| 57 | **Copenhagen Air View** street-level NO2/UFP/BC | KK `k101:cav_25may2021` (also `https://kbhkort.kk.dk/media/airview/CAV_25May2021.geojson`) | WFS/download | CC BY 4.0 | 850 road segments | `Mixed_NO2` (e.g. 15 ug/m3), `Mixed_UFP`, `Mixed_BC` | Air-quality heat overlay, haze density per street. Measured 2018-2020. | S |
| 58 | Air quality forecast API | `https://holger.envs.au.dk/api/forecast_hour` etc. | API | licence not stated | 103 street points citywide | forecast, not static | Live, not static. Mention only. | - |
| 59 | **Surface temperature** `overfladetemp_gns_seneste_tre_aar` (2,162 polygons) and `urban_heat_and_cold_islands_last_three_years` (82) | KK WFS | WFS | licence not stated | see left | `overfladetemp` e.g. 28.1 C | Thermal-camera view; heat island layer. | S |
| 60 | **Cloudburst flood scenarios** `oversvm_scen_ladeg` (114,252 polygons), `_norre` (37,709), `_ioster` (793) | KK WFS | WFS | CC BY 4.0 (`oversvommelsesscenarier-for-vandoplande`) | big grids | `grid_code` depth in m (e.g. 0.105), `scenario` | Animated flood water in streets for a rain scenario; depth-driven. Heavy: 150k polygons, simplify. | M |
| 61 | Storm-surge 100-year `hmax285`/`hmax263` (66 / 30) | KK WFS | WFS | licence not stated | see left | `gridcode` | Surge scenario at the lakes/harbour. | S |
| 62 | Basin and cloudburst projects `skp_*` | KK WFS | WFS | CC BY 4.0 | few | Planned works. | - |

## Excluded or blocked

- Mapillary (CC BY-SA 4.0 share-alike), Google 3D tiles (policy forbids derivation): not used.
- Rejseplanen GTFS: `https://www.rejseplanen.dk/gtfs/GTFS.zip` answers HTTP 302 (redirect, not followed); no entrances in GTFS anyway. OSM has 9 `railway=subway_entrance` in the bbox. UNVERIFIED beyond that.
- Soldata 3D zip (CC BY 4.0) is a 7.3 GB JSON (2016). The WFS layer #25 is far lighter.
- Wire geometry `belysning-ledninger` (zip) and FBB national register: not fetched. UNVERIFIED. SAVE (#23) already carries `fredet` flags.

## Notes and caveats

- Counts are intersecting the bbox, so edge features are counted.
- Several KK layers have no stated licence in CKAN (tree basis, vegetation, byinventar, bygning). Confirm with bydata@kk.dk before shipping them in a public build.
- OSM data is ODbL (attribution, share-alike on the database).
