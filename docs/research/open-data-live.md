# Open live / dynamic data for the Copenhagen twin

Verified 2026-10-25 ~20:40 CET with live requests from this machine. bbox = lon 12.553-12.577, lat 55.677-55.691 (EPSG:25832 E 723150-724650, N 6175750-6177250). "V" = verified live this session; "U" = unverified (reason given). Prior static inventory: `docs/research/valdrada-copenhagen-2026-10-10.md` (Findings 2, 6) in the dk-building-data repo.

## Summary table

| # | Source | Status | Auth | Update | In bbox | Twin use | Effort |
|---|---|---|---|---|---|---|---|
| 1 | DMI metObs (10-min obs) | V | none | 10 min | Botanisk Have 05735 (precip, 12.575/55.687) in bbox; Landbohojskolen 06186 (temp/wind/humidity) ~800 m W; Toldbod 06187 (global radiation) ~2 km E; DMI HQ 06184 (cloud_cover) 3 km N | rain, wet roads, fog, cloud, wind | S |
| 2 | DMI radar composite | V | none | 5 min | national 500 m HDF5 | rain cells overhead | M |
| 3 | DMI forecast EDR (HARMONIE) | V | none | hourly, ~60 h | point query | forecast mode, cloud/rain | S |
| 4 | DMI lightning | V | none | live | national | flash during storms | S |
| 5 | DMI oceanObs (harbour) | V | none | 10 min | Kobenhavns Havn 30336 (12.599/55.704), 30334 (12.600/55.689), 2.5 km E | lake/harbour level, water temp | S |
| 6 | Rejseplanen GTFS static | V | none | weekly-ish (zip dated 2026-10-19) | 42 stops, 37,958 trips, 33 routes | timetable-driven bus/metro/S-tog agents | M |
| 7 | Rejseplanen API 2.0 (HAFAS: Journey Position, departure boards) | U | free accessId | live | - | real vehicle positions | M |
| 8 | Dott scooters/bikes GBFS 2.3 | V | none | 5 min (ttl 300) | 185 vehicles now | parked/riding scooters, battery | S |
| 9 | Donkey Republic GBFS 3.0 | V | none, CC0-1.0 | 60 s | 227 bikes, 182 hubs now | parked bikes at hubs | S |
| 10 | Bycyklen | not found (no GBFS in MobilityData catalogue; search found none) | - | - | - | skip | - |
| 11 | KK trafikmelding (WFS) | V | none | ad hoc | 7 live incidents (demos, road works) | closures/demonstration crowds | S |
| 12 | KK gravetilladelser aktive (WFS) | V | none | daily-ish | 156 permits (114 pavement) | dig sites, fences, diverted cyclists | S |
| 13 | KK raaden over vej events (WFS) | V | none | daily-ish | 1,232 permits: 461 outdoor serving, 348 street vending, 27 events, 26 film shoots | terraces, stalls, events | S |
| 14 | KK trafiktal (WFS) | V static | none | annual counts | 108 sites | calibrate agent demand | S |
| 15 | KK signals overview (WFS) | V static | none | - | 33 junctions | signal locations only, no timing | S |
| 16 | Energi Data Service | V | none | 1 min | national | night-sky "mood", grid CO2 / wind | S |
| 17 | AU/DCE air quality, H.C. Andersens Blvd | V (scraped HTML) | none | hourly | station ~600 m SW of bbox | haze/particles | S |
| 18 | OSM via Overpass | V | none (polite UA) | minutes | 751 elements with opening_hours | shop lights on/off by hours | M |
| 19 | Vejdirektoratet trafikinfo / Mastra | U | login/registration | - | - | state roads only; skip | - |
| 20 | KK badevand | U | - | - | harbour baths S of bbox | - | - |

## Details

### 1. DMI Open Data (keyless since the 2026 migration)
Base `https://opendataapi.dmi.dk`. All V with HTTP 200 and no key. Licence: CC BY 4.0 ("DMI's Open Data are distributed under the Creative Commons License CC BY 4.0"; attribution required; observations are raw, not quality-assured) - https://www.dmi.dk/friedata/dokumentation/terms-of-use. Old `dmigw.govcloud.dk` host no longer resolves; use `opendataapi.dmi.dk`.

- metObs: `/v2/metObs/collections/observation/items?stationId=05735&limit=6&sortorder=observed,DESC`. Without sortorder you get 1988 data first; always sort. Sample: `{"parameterId":"precip_past10min","value":0.0,"observed":"2026-10-25T19:30:00Z","stationId":"05735"}`, created ~90 s after the observation. Stations: `/v2/metObs/collections/station/items?bbox=12.3,55.55,12.8,55.85`. 05735 Botanisk Have: `precip_past1min/10min/1h`, `precip_dur_*`. 06186 Landbohojskolen: temp_dry, humidity, dew point, wind. 06187 Toldbod: `radia_glob`, `sun_last10min_glob`. 06184: `cloud_cover` (latest value returned was from 2024 for the default query; verify per-parameter recency before relying on it - unverified for live cloud, use the HARMONIE cloud fraction instead).
  Use: rain intensity -> rain particles + wet-road roughness/puddle reflection; global radiation -> overcast factor for sun intensity; wind -> tree/flag sway, cyclist lean. Effort S (one poll per 10 min, nearest-station fallback).
- Radar: `/v1/radardata/collections/composite/items?limit=3&datetime=2026-10-25T18:00:00Z/..` gives STAC items `dk.com.202610251925.500_max.h5`, 5-min cadence, download `/v1/radardata/download/<file>` (200 OK, 211 KB, HDF5, no key; bbox 4.38-20.74E / 52.29-59.83N). Use: sample dBZ over the district, advect a rain-cell mask. Effort M (HDF5 decode server-side; needs a tiny proxy -> PNG/JSON).
- Forecast EDR: `/v1/forecastedr/collections` (16 collections incl. `harmonie_dini_sf`, `dkss_*` storm surge). Point query worked: `/v1/forecastedr/collections/harmonie_dini_sf/position?coords=POINT(12.565 55.684)&parameter-name=temperature-2m,rain-precipitation-rate&f=CoverageJSON` -> hourly series (2026-10-24T21Z to 10-28T03Z). Parameters include fraction-of-cloud-cover, low/medium/high-cloud-cover, gust-wind-speed-10m, global-radiation-flux, probability-of-lightning, precipitation-type. Note: one request returned HTTP 429 "Server is busy" - cache and back off. A wrong parameter name (`cloud-cover`) returns 400. Use: "scrub forward" time-of-day/weather mode; cloud layers by cloud-cover fractions. Effort S.
- Lightning: `/v2/lightningdata/collections/observation/items?datetime=2026-10-24T00:00:00Z/..` (strokes with amp, polarity, time). Use: flash + delayed thunder when strokes within ~20 km. Effort S.
- oceanObs: `/v2/oceanObs/collections/observation/items?stationId=30336&sortorder=observed,DESC` -> `sealev_dvr`, `sealev_ln`, `sea_reg`, 10-min. Latest -3 cm DVR90. Stations 30336/30334 `tw` (water temperature). Use: lake/harbour level cue (the Soerne are a controlled lake, not tidal; harbour level only a storm-surge hint). Effort S, low wow.

### 6. Rejseplanen GTFS static (best transit asset)
`https://www.rejseplanen.info/labs/GTFS.zip` - HTTP 200 anonymously, 55,995,224 bytes, Last-Modified 2026-10-19 (Microsoft IIS). No auth needed for this URL (the Labs portal `labs.rejseplan.dk` itself sits behind a Cloudflare challenge, so access terms are unverified; the MobilityData catalogue lists this exact URL with `authentication_type 0`, mdb id 1292, producer attribution "Rejseplanen"). Licence: not stated in feed (`attributions.txt` only names Rejseplanen as producer) -> treat as attribution-required, confirm terms on Labs before shipping.
Content: agency.txt, routes, trips (12 MB), stop_times (240 MB), shapes (113 MB), calendar/calendar_dates, transfers, frequencies.
Computed against the bbox from the downloaded feed: 42 stops (all location_type 0), 37,958 trips touching them, 33 routes. By operator/mode: Metroselskabet metro 19,802 trip-stops (M1, M2), Movia bus 11,961, DSB regional/IC 1,833, S-tog 1,787 (A, B, Bx, C, E, H), Movia Sbus 700 1,772 (150S, 350S), Skanetrafiken 583. Bus lines: 1A, 2A, 5C, 6A, 11, 14, 15E, 33, 68, 71, 184, 185, 150S, 350S.
Use: spawn bus agents on `shapes.txt` polylines at scheduled `stop_times`, dwell at stops, run by wall-clock or sim clock; metro/S-tog as scheduled trains at Norreport/Forum ends (only if those stops fall in the bbox; fits the 42). Gives the correct day/night headway rhythm (5C every ~3-5 min peak, night buses). Effort M (stream-parse stop_times; precompute a bbox JSON of ~38k trips = a few MB).
Caveat: scheduled, not actual positions.

### 7. Rejseplanen API 2.0 / GTFS-RT (unverified)
`https://www.rejseplanen.dk/api/` documents HAFAS endpoints incl. "Journey Position", "Multi Departure Board", "HIM Search" (disruptions). Request without key returns `API_PARAM Missing value for required param accessId` (V: endpoint is live, key required). Key via Rejseplanen Labs (registration, blocked here by Cloudflare). No public GTFS-Realtime endpoint was found (guessed paths on rejseplanen.info/labs all 404; web search found nothing). Treat real vehicle positions as U; plan on the free key. Effort M.

### 8-9. Micromobility GBFS
- Dott: `https://gbfs.api.ridedott.com/public/v2/copenhagen/gbfs.json` (GBFS 2.3, listed in MobilityData systems.csv). `free_bike_status.json`: ttl 300 s, 1,885 vehicles city-wide, 185 inside bbox; fields lat/lon, `current_range_meters`, battery fraction, `is_disabled`, `vehicle_type_id` (dott_bicycle...). Auth none. Licence not stated in feed (U). Use: render parked scooters/bikes where they really are, battery-dependent glow; pickups/drop-offs between polls as ghost trips. Effort S.
- Donkey Republic: `https://stables.donkey.bike/api/public/gbfs/3.0/donkey_copenhagen/gbfs.json` (GBFS 3.0, ttl 60 s, `license_id: CC0-1.0`). station_information 2,667 stations (182 in bbox, capacity per hub), station_status `num_vehicles_available` (4,160 city-wide), vehicle_status 4,411 vehicles (227 in bbox). Use: bike-racks filled to real counts. Effort S.
- Not available / not found: Bycyklen (no GBFS), Lime (404 on guessed URL), Bird (404), Voi (`api.voiapp.io/gbfs/dk` returns 401). Only Dott and Donkey are in the public GBFS catalogue for DK.

### 11-13. Kobenhavns Kommune live WFS (GeoServer, no auth)
Base `https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=k101:<layer>&outputFormat=application/json&bbox=723150,6175750,724650,6177250,urn:ogc:def:crs:EPSG::25832`. (477 layers; this is the same host as the prior inventory.) Licence: the opendata.dk dataset entries for gravetilladelser, taellestationer, trafiksignaler, raaden-over-vej are Creative Commons Attribution 4.0; the live layers `trafikmelding`, `raaden_over_vej_events_anonym_aktuelt`, `trafiktaelling` and `parkeringstaellinger` have no licence field on opendata.dk (U - confirm with bydata@kk.dk).
- `trafikmelding`: 7 features in bbox now: Vejarbejde on Studiestraede (to 2027-10-29), Vesterbrogade (to 2026-11-29), Norre Sogade at Vendersgade, demonstrations (start/end timestamps, LineString route, e.g. 2026-10-24 Trianglen-Blegdamsvej-Norrebrogade). Fields: haendelsestype, severity, trafikalt_restriktion, paavirkede_vognbaner, start/slut. Some records have end < start (data quality). Use: close a lane/street in the sim, place barriers + flashing amber, demo march crowd. Effort S.
- `gravetilladelser_aktiv_aabne`: 156 active digs; fields lokation, projekt_start/slut, tidspunkt_fra/til (e.g. 07:00-19:00), gravetype (Fortov 114, Korebane 14, Cykelsti...), kategori (Fibernet 75, EL 17, Vand 6...), bygherre (HOFOR), entreprenoer. Example hit: Norre Sogade 21-49, 2026-05-15 to 10-30, Vand, Korebane, HOFOR/NCC. Use: construction fences/cones/excavators in work hours, only when sim time within tidspunkt window. Effort S.
- `raaden_over_vej_events_anonym_aktuelt` (1.6 MB for the bbox request): types Udeservering 461, Mobilt gadesalg 348, Midlertidig raaden 205, Gravetilladelser 157, Arrangement 27, Filmoptagelse 26. Event fields: arrangementnavn, aktivitet_start/slut, forventet_deltagerantal. Seen: Blagardsgade loppemarked 2026-10-24, Juleudsmykning Stroeget from 2026-11-12. Use: outdoor serving tables/heaters, flea-market stalls, event crowd density; Christmas lights toggled by date. Effort S-M.
- `trafiktaelling` (108 sites in bbox, counts from 2009-2025, mostly 2013-2025; not live): AADT cars/bikes/pedestrians. Top cycle sites: Dronning Louises Bro 33,000 bikes/day (3,900 cars), Gyldenlovesgade 24,800 bikes / 43,900 cars, Frederiksborggade 18,100 bikes, H.C. Andersens Blvd 16,200 bikes / 47,900 cars, Norre Sogade 12,400 bikes / 27,700 cars. Also `trafiktaelling_fodg` (46 pedestrian sites in bbox, e.g. Farvergade 3,200 AADT) and `taellestationer` (139 sites). Use: per-link demand weights; scale by an hourly profile. Effort S.
- `trafiksignal_oversigt`: 33 signalised junctions with controller type (no timings; no live signal feed found - "gron bolge" timing not published). `taelling_p_pladser`/`ptaelling_straekning`: parking occupancy counts for kl 12/17/22 only (static; no live parking occupancy in KK open data - U for other publishers). `elbil_ladestander_i_drift`: 97 charging posts (static). `cykelstativ`: 552 racks in bbox. No live eco-counter / cykelbarometer feed was found (U).

### 16. Energi Data Service (Energinet)
`https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=2` V 200, no key, 1-min rows: CO2Emission 10.37 g/kWh, SolarPower 86 MW, OffshoreWind 2,795 MW, OnshoreWind 3,809 MW at 20:37 DK. Also `CO2Emis` (5-min, per DK1/DK2), `Elspotprices` (spot price; the default sort returned 2025 data - add `sort=HourUTC DESC`). Licence: Energinet open data (not read this session, U exact wording; they state free use with attribution). Use: night-mode "city mood" - wind share drives a subtle wind-turbine-blink on the horizon, CO2 -> warm/cool tint of street-light ambience; spot price -> window-light density. Effort S, novelty high but diegetic value low.

### 17. Air quality (Aarhus University DCE)
`https://envs2.au.dk/Luftdata/Presentation/table/Copenhagen/HCAB` (station H.C. Andersens Boulevard, ~600 m SW of bbox). No documented API: the page POSTs with an antiforgery token to `/Luftdata/Presentation/table/MainTable/Copenhagen/HCAB` (V: returned hourly NO2 9.9, NOx 14.3, O3 64.6, PM10 12.0, PM2.5 8.1 ug/m3 at 19:00, CO 0.17 mg/m3). Other CPH stations: HCO, HVID, JAGT1 (Jagtvej, ~2 km N: NO2/NOx), Botanisk Have is listed in Aarhus. Licence not stated (U); results "not quality-controlled". Use: haze/particle opacity, a "NO2 meter" HUD. Effort S (scraper brittle). OpenAQ v3 needs an API key (401 V).

### 18. OSM opening hours
Overpass (needs a descriptive User-Agent; a request without one got 406; busy servers returned 502 then succeeded): 751 elements with `opening_hours` in bbox (696 nodes, 29 ways). ODbL. Use: window glow / door open states / people at terraces by sim clock; cafe/restaurant counts. Effort M (parse opening_hours; library `opening_hours.js`). Fetch once, bake into tiles.

### Computed / no feed needed
- Sun/moon position and twilight: compute from lat/lon and clock (SunCalc). Street-light switch-on: no open Citelum/KK schedule found (U); drive from sun elevation (< -2 deg) which is how municipal lights are controlled in practice.
- Seasonal: DMI snow `snow_cover_man` / `snow_depth_man` manual stations (Botanisk Have 30370, Landbohojskolen 30380) exist (V station list) - snow ground texture on winter days.
- School times: KK `skoler` layer gives locations (static); school-day bell times not found as open data. Use fixed 08:00/14:00 bell pulse of kids on sidewalks (U, authored).

### Not found / blocked (honest gaps)
- Movia / national GTFS-RT vehicle positions: no open endpoint found; Rejseplanen API 2.0 key required.
- Vejdirektoratet trafikinfo/DATEX: `api.vejdirektoratet.dk` shows only a login page (U); state roads only, little in the Soerne area anyway.
- Live pedestrian / WiFi footfall, live eco-counter, live parking occupancy, signal timing, noise sensors: none found as open feeds. KK noise is a static model (`vejstoej_2022_*`).
- Badevand live: `kk.dk/badevand` loads but no machine endpoint found; baths are on the harbour south of the bbox.

## Ranking (wow per effort)
1. Rejseplanen GTFS -> timetable bus/metro/S-tog agents on real shapes (M, high wow, real rhythm).
2. DMI metObs + radar -> rain, wet roads, cloud, wind synced to actual weather (S-M).
3. KK gravetilladelser + trafikmelding -> real roadworks/closures/demos with start/end times (S).
4. KK raaden over vej events -> terraces, stalls, festivals, film shoots (S).
5. Dott + Donkey GBFS -> real parked scooters/bikes, live (S).
6. KK trafiktal -> cyclist/car/pedestrian demand weights (S).
7. OSM opening hours -> shop lights/terraces by clock (M).
8. DMI HARMONIE forecast -> scrub the sim into tomorrow's weather (S).
9. DMI lightning -> storm flashes (S).
10. Energi Data Service wind/CO2 + DCE air quality haze (S, ambient).
