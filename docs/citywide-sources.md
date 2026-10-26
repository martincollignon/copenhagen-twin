# Citywide data sources: Københavns Kommune (KK) + Frederiksberg (FRB)

Researched 2026-10-26 for `docs/citywide-plan.md`. "Verified" means I called the URL on that date and got data back; "unverified" means I did not (or could not) get a data response. Counts come from `resultType=hits` or `count(*)` queries.

## Result in one paragraph

Boundary, national sources (GeoDanmark, BBR, DAR, DHM, ortho, Skråfoto, OSM) cover both kommuner. **Every `wfs-kbhkort.kk.dk` layer the compiler reads is KK-only** (a 1 km box in central Frederiksberg returns 0 features for 19 of 24 layers tested; the 5 non-zero ones return 1 to 4 stray features on the border). Frederiksberg runs its own public GC2 SQL API (`gc2ekstern.frederiksberg.dk`) that covers trees, bins, bike racks, parking, signals, bus stops and pavements at lower detail. **Street lights, bollards, byinventar, surface materials and road markings have no Frederiksberg equivalent** and need a fallback.

## Boundary and tiles

| Item | Value |
|---|---|
| Source | DAGI `kommuneinddeling_current`, Datafordeler WFS `https://wfs.datafordeler.dk/DAGI/DAGI_WFS/1.0.0/WFS` (verified; needs the Datafordeler service user; native EPSG:25832) |
| Not usable | DAWA `api.dataforsyningen.dk/kommuner/0101` is gone (HTTP 410). The Dataforsyningen DAGI WFS (`DAGI_10MULTIGEOM_GMLSFP_DAF`) rejects the gsearch token ("User not authorized") and is retired 15 Jan 2027. |
| Area | København 91.7 km², Frederiksberg 8.7 km², union 100.4 km² |
| Harbour water | **DAGI follows the coastline: it excludes the harbour basins and Øresund** (Nyhavn's water lies outside it). It does include lakes (Søerne, Damhussøen, Utterslev Mose). OSM's admin boundary (relation 2192363) reaches further out, to about 103 km². The harbour and sea must come from the coastline/water layer (OSM `natural=coastline`, GeoDanmark `kyst`/`havn`/`soe`) as milestone C4 plans. |
| Output | `data/city/boundary.geojson` (EPSG:25832; features `0101`, `0147`, `union`; simplified 5 m, 80 KB) |
| Tiles | `data/city/tiles.json` from `tools/cph-geodata/city_tiles.py`: **496 tiles** touch the boundary, 464 in one kommune, 32 straddle both. 21 tiles are Frederiksberg only. 489 have land_frac ≥ 0.5; 32 are edge slivers (< 10 % of the tile inside the boundary). The plan's "about 400 tiles / 350 with land" is low by about a quarter. 145 one-km LAZ cells cover the union. |
| land_frac | share of the in-boundary part of the tile that is land minus OSM `natural=water` (lakes, canals). Because DAGI already stops at the coast, almost every tile is "land" (496 of 496 have some); the value mostly flags lake and pond cover. It is not a harbour flag. |

## Compiler inputs

KK = covers all of Københavns Kommune (counts are citywide feature totals). FRB column = what to use instead.

### Buildings (`build.py`, `buildings.py`, `entrances.py`, `tools/lod2`)

| Input | KK citywide? | Frederiksberg equivalent | Status |
|---|---|---|---|
| KK `bygning` (144,330) and `bygning_kk` (144,472): GeoDanmark footprint + BBR attributes + `tagrendehoejde_estimat` | Yes | GeoDanmark Bygning: Datafordeler `https://wfs.datafordeler.dk/GEODKV/GEODKV_WFS/1.0.0/WFS` type `geodkv_v001:bygning_current` (1,319 in a 1 km² FRB box), or the older `.../GeoDanmarkVector/GeoDanmark60_NOHIST_GML3/1.0.0/WFS` type `gdk60:Bygning`. FRB GC2 mirror `baggrundslag.bygning` (15,107, has `fot_id`). BBR attributes: Datafordeler `bbr_v001:bygning_current` WFS or GraphQL. The eave-height estimate has no FRB equivalent; use LoD2 from DHM LAZ. | Verified (GEODKV, gdk60, BBR WFS and GraphQL, GC2). Note `GeoDanmark_60_NOHIST` (the path without `_GML3`) returns 503. |
| DAR entrances (`services.datafordeler.dk/DAR/DAR/1/rest/husnummer`) | National | Same service, `kommunekode=0147` | Reachable (HTTP 400 on my guessed parameters, so auth passed); parameters unverified. The DAR WFS (`wfs.datafordeler.dk/DAR/DAR_WFS/1.0.0/WFS`) lists only `navngivenvej` (verified) |
| DHM Punktsky LAZ (`api.datafordeler.dk/FileDownloads/GetPointCloudFile`, `PUNKTSKY_1km_<N>_<E>.laz`) | National | Same; tiles `6174..6178 × 719..723` | Verified: HTTP 200 for 6176_722, 6175_720, 6178_722 (headers only; the server ignores Range and sends the whole file). Service-user access ends 15 Jan 2027. |

### Roads and traffic (`roads.py`, `streets.py`, `bikedir.py`, `roadgraph.py`)

| Input | KK citywide? | Frederiksberg equivalent | Status |
|---|---|---|---|
| OSM `way[highway]` (Overpass) | n/a | Same query | Verified citywide in one call: 70,838 ways in the city bbox (39,120 KK, 5,943 FRB, rest outside), 40 MB JSON, 41 s |
| KK `Kommunevej` (1,485), `trafikhastigheder` (4,441), `ensrettede_gader` (584), `cykelsti` (1,911) | Yes | Speed: FRB GC2 `vej.hastighedsregulering` (146), `vej.trafikveje` (56), `vej.fartviser` (14); OSM `maxspeed`/`oneway`. Cycle paths: GC2 `mobilitet.cykelstier` (138), `mobilitet.cykelsti_klippet`; OSM cycleway tags. | GC2 verified; thin |
| KK `trafiksignal_oversigt` (457) | Yes | GC2 `byrum.signalanlaeg` (64); OSM signals: 130 nodes + 238 crossings in FRB (1,344 + 2,130 in KK) | Verified |
| KK `vejkant` (76,365; GeoDanmark road edges, used by `streets.py`) | Yes | GeoDanmark Vejkant: GEODKV `geodkv_v001:vejkant_current` (882 in a 1 km² FRB box) or `gdk60:Vejkant` | Verified |
| KK `fortovsmatrikel` (7,127) | Yes | GC2 `stab.fortovsareal` (5,162 pavement polygons; "stab" is the staff schema, so provenance is unclear), `byrum.fortovsarealer` (24) | Verified, low confidence |

### Surfaces (`surfaces.py`)

| Input | KK citywide? | Frederiksberg equivalent | Status |
|---|---|---|---|
| `dp_belaegninger` (6,845; paving materials) | Yes | None found | Gap |
| `afmaerkning_total` (238,480; road markings) | Yes | None found. GC2 `vej.fodgaengerfelt` (267 pedestrian-crossing lines) is the only marking layer. | Gap |
| `blaa_cykelfelt` (329) | Yes | None (no blue cycle crossings published) | Gap |
| OSM `place=square`, `highway=pedestrian` areas | n/a | Same query | Same method as roads; not run citywide |

### Furniture (`furniture.py`)

| Input | KK citywide? | Frederiksberg equivalent | Status |
|---|---|---|---|
| Trees: `trae_basis` (75,075), `automatisk_detekterede_traeer_kk_beta` (342,977), `..._kroner_kk_beta` (380,633) | Yes | GC2 `byrum_ekstern.registrerede_traer` (16,043; 8,613 have genus, 8,494 have height; aerial-survey origin), `byrum.vejtraer` (15,623; only a `fot_id`), `byrum.andre_traeer` (7,449), `byrum.private_traer` (15,515), `byrum.bevaringsvaerdige_traeer` (280). National: GeoDanmark `trae_current` (2,661 in a 1 km² FRB box) and `traegruppe_current`. Canopy and height come from CIR + DHM, which are national. | Verified. No tree-crown polygons for FRB |
| Lamps: Citelum `belysning-master` (20,971) and `belysning-wirer` (18,977) GPKGs on opendata.dk | KK only (only 16 and 40 points fall inside FRB, border strays) | **No open inventory.** OSM `highway=street_lamp`: 158 in FRB vs 1,365 in KK. GC2 `rapport_fra_stedet.gadebelysning` is 9 citizen fault reports. Fallback: procedural lamps along roads. | Gap. A newer KK dataset `belysning-armaturer` exists and was not inspected |
| Benches `baenke_borde_puma` (11,757) | Yes | GC2 `byrum.baenk` (43, 2018 survey). `byrum.mergin_baenke` needs authentication. | Near-gap |
| Bins `affaldskurve_puma` (4,926) | Yes | GC2 `byrum.skraldespande` (1,184); opendata.dk `skraldespande-frb` | Verified |
| Glass containers `ask_glascontainer` (461); bin stands `ask_standpladser_nokey` (38,297) | Yes | GC2 `affald.glascontainere` (178), `affald.punkter` (436) | Verified for glass; stands partial |
| Bollards `pullert` (6,277); byinventar `dp_byinventar_p/l/f` (22,193 / 5,345 / 2,147) | Yes | None found | Gap |
| Monuments `monumenter` (424) | Yes | GC2 `byrum_ekstern.monumenter` (exists; count query ran, not recorded), GeoDanmark `statuesten_current` | Partial |
| Bike racks `cykelstativ` (7,110) | Yes | GC2 `mobilitet.cykelstativer` (848), `mobilitet_ekstern.cykelparkering` (4,524; 2020 counts with capacity) | Verified |
| Parking `parkering_areal` (20,285), `p_pladser` (29,584), `parkomat` (1,602) | Yes | GC2 `mobilitet.parkeringspladser` (5,234 polygons), opendata.dk `parkeringsautomater` (GeoJSON), GeoDanmark `parkering_current` (111 in the test box) | Verified |
| Bus stops: Movia `Stoppestedsudstyr` ArcGIS layer | Regional (12,939 features; 19 in the FRB test box) | Same service, plus GC2 `mobilitet.busstoppesteder_frederiksberg` (175) | Verified |

### Vegetation, water, ground (`vegetation*.py`, `tree_canopy.py`, `lakes.py`, `basins.py`, `terrain.py`, `ortho.py`, `dhm.py`)

| Input | KK citywide? | Frederiksberg equivalent | Status |
|---|---|---|---|
| `parkregister` (361), `park_groent_omr_oversigtskort` (1,453) | Yes | GC2 `komplan25.kp25_groenne_parker_og_anlaeg` (179 planning polygons), OSM `leisure=park|garden`, GeoDanmark `rekreativtomraade_current` | Verified. Park-floor inference needs the polygons; OSM suffices |
| OSM water/parks | n/a | Same | Verified citywide: 2.8 MB, 31 s |
| GeoDanmark `soe_current` (314 in the city bbox), `bassin_current` (152), `rekreativtomraade_current` (19), `begravelsesomraade_current` (26), `skov_current` (346) | Datafordeler GEODKV WFS with the service user: verified and downloaded 2026-10-26 by `tools/cph-geodata/city_water.py --fetch` into `data/raw/city/water/` | national | Verified. `kyst` (coast lines) and `vandloebskant` (stream edges) exist too and are not used: the OSM coastline gives the sea with its orientation |
| Søerne polygons `parkregister.161*` | District feature (KK) | n/a; generic lakes from GeoDanmark `soe_current`, `bassin_current`, `kyst_current`, `havn_current` (1 `soe` in the FRB test box) or OSM | Layer names verified; not downloaded |
| DHM terrain WCS `api.dataforsyningen.dk/dhm_wcs_DAF` | National | Same (token) | Verified (GetCapabilities, 200) |
| Ortho and CIR WMS `api.dataforsyningen.dk/orto_foraar_DAF` | National | Same (token) | Verified (GetMap, 200) |
| Skråfoto STAC (`api.dataforsyningen.dk/skraafoto_api/v1.0`) | National | Same | Verified (6.16 M items) |
| OSM venues for `groundfloor.py` | n/a | Same | Verified citywide: 3.7 MB, 44 s; 7,737 KK and 999 FRB venues |
| KK `bevillinger` (2,390 serving permits) | Yes | None. FRB `mobilitet.metro_udeserveringstilladelse` relates to metro works only. Use OSM `outdoor_seating`. | Gap |

## Access limits

**KK WFS** (`https://wfs-kbhkort.kk.dk/k101/ows`, WFS 2.0.0, GeoJSON, EPSG:25832 bbox):
- Citywide `resultType=hits` works for all 31 layers above; the largest are `automatisk_detekterede_kroner_kk_beta` 380,633, `afmaerkning_total` 238,480, `bygning` 144,330, `vejkant` 76,365.
- `startIndex` paging works deep into a layer (`afmaerkning_total` at 235,000 returned in 0.5 s; 9,000 `trae_basis` features over three pages were all unique). Pages of 3,000 are fine: about 127 requests for the biggest layer and about 530 for all layers. `sortBy=id` returns HTTP 400, so paging relies on server order; dedupe by feature id.
- A 560 m bbox query for `bygning` returned 1.9 MB in 0.35 s, so per-tile bbox fetches with the existing 60 m margin are cheap. Citywide it is simpler to page each layer once into `data/raw/city/`.

**Overpass** (`overpass-api.de`):
- One citywide query per key works with `[bbox:55.58,12.43,55.74,12.74]` (this box also contains Tårnby, Gentofte and other neighbours, so clip by boundary afterwards): roads 40 MB (41 s), water/parks 2.8 MB (31 s), signals/lamps/crossings 1.7 MB (30 s), venues 3.7 MB (44 s). No tiling is needed.
- The public server returned HTTP 502 "at capacity" about half the time; a retry after 20 s worked. `fetch.overpass` needs a retry/backoff loop and a descriptive User-Agent (without one the server returns 406).
- Keep a fallback to `overpass.kumi.systems`; on timeouts split by the 500 m tile grid or by kommune.

**Datafordeler**: the service user works for DAGI, GeoDanmark, BBR and DAR WFS; the GraphQL API key works for BBR GraphQL and for LAZ download.

## Licences

| Source | Licence | Note |
|---|---|---|
| KK open-data layers with a CKAN entry (Citelum lighting, `trae_basis`-family where listed, `skraldespande`) | CC BY 4.0 | |
| KK layers with no stated licence: auto-detected trees, `dp_byinventar_*`, `bygning`, traffic counts, speed zones, `cykelsti`, `parkering_areal`, and most of the WFS-only layers | **Unknown** | `docs/kk-licence-request.md` covers only the district scope; resend with kommune scope |
| Movia `Stoppestedsudstyr` | Unknown | no statement on the service |
| Frederiksberg opendata.dk datasets (`skraldespande-frb`, `parkeringsautomater`, `parkering_frederiksberg`, `elbil-ladestandere`, `offentlige-toiletter-frederiksberg`, `3d-bymodel`, ...) | CC BY 4.0 | |
| Frederiksberg GC2 tables with no opendata.dk entry (`registrerede_traer`, `vejtraer`, `baenk`, `cykelstativer`, `signalanlaeg`, `busstoppesteder`, `fortovsareal`, `kp25_*`) | **Unknown** | publicly queryable, but no licence statement; ask Frederiksberg Kommune (GIS) before publishing |
| DAGI, GeoDanmark, BBR, DAR, DHM, orthophoto, Skråfoto (SDFI / Klimadatastyrelsen) | Free data under SDFI's open-data terms (attribution; CC BY-like) | Datafordeler terms still unread per the plan; service-user access ends 15 Jan 2027 |
| OSM (roads, water, venues, coastline) | ODbL 1.0 | share-alike on derived databases; attribution required |

## Blockers and decisions

1. No open street-light inventory for Frederiksberg: procedural fallback or ask Frederiksberg Kommune / Frederiksberg Forsyning.
2. No surface-material, marking, bollard or byinventar data for Frederiksberg: tone and procedural surfaces only.
3. Fetch code (`fetch.py`) is hard-wired to the KK WFS and a whole-bbox cache. The compiler needs a source switch by kommune (KK WFS / GC2 / GeoDanmark) behind one tile-level interface.
4. Licence follow-ups: KK kommune-scope request, Frederiksberg GC2 terms, Datafordeler terms.
5. The Dataforsyningen gsearch token cannot reach DAGI; use the Datafordeler service user.
