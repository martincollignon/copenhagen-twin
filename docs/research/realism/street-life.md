# Street life and street-level objects: Søerne and inner Nørrebro

**Research and URL checks:** 26 October 2026. **Scope:** vehicles, bicycles, people, and the street-level objects and road paint that [visual-refs.md](../visual-refs.md) does not cover. Lamps, benches, bollards, standard bins, bike racks, bus shelters and Movia poles, P-automater, signal-head optics, cycle-track kerb heights and the bridge are already covered there and are only cross-referenced here. **Purpose:** to say what a camera at street level should see in 2025–26, with numbers that can go straight into `js/`.

Tags follow visual-refs.md:

- **Published**: the figure or rule appears in the cited document.
- **Observed**: visible in a linked, dated photograph. It shows how something looked on that date. It does not establish a statistic or the present state.
- **Estimate**: an editable starting value, not a measurement.
- **Unresolved**: the research did not settle it.

Every cited URL was fetched on 26 October 2026 and returned real HTML or PDF content (status 200). Some pages blocked scripted requests with a 403; those were replaced by sources that loaded. The 14 reference photos are in [refs/street/](refs/street/ATTRIBUTION.md), and the photo names in brackets below (for example `[ravnsborggade-parked-2017]`) refer to that folder.

## What the twin shows now (Observed in `docs/qa/sweep-after/contact-1.png` and `docs/m4-furniture/*.png`)

- **Cars.** Every car is a three-box sedan with a chrome window strip (`chrome: true` in `BODY_SPECS.sedan`) or a boxy SUV with roof rails. Traffic is a hard 50/50 split (`const isSUV = i % 2 === 0` in `js/traffic.js`). The silhouettes read as American 1990s cars. The rear plate is 0.31 × 0.12 m (`plateRear`, half-extents `vec2(0.155, 0.06)` in `createLoftedCarMaterial`), close to a US plate, and has no EU band.
- **Buses.** There is one rigid 11.56 m bus (`BUS_SPEC.zFront = 5.78`). Its livery is yellow with a red band and a white ribbon, which no Copenhagen bus carries.
- **Cyclists.** Every rider wears a glossy white helmet (`b.helmet.visible = show` in `js/cyclists.js`, white emissive material). The bikes are diamond-frame sports bikes.
- **Parked bikes.** Bikes appear only in KK rack rows, filled 35–85 % (`rackItems` in `js/street-furniture-data.js`). There are no free-standing bikes along façades.
- **Road and signage.** Painted lines are 0.12 m wide. Lane dashes are 2 m on a 6 m period. The `red` (bus lane) and `yellow` marking kinds in `data/cph-surfaces.json` are generated but not rendered (`RENDERED_MARKINGS` in `js/road-surfaces-cph.js`). The scene has no traffic signs other than signal heads.
- **Glass recycling.** It is drawn as three domed bins in green, white and brown (`buildGlassContainers`).

## 1. Cars

### 1a. Fleet composition

- **Published, Copenhagen ownership.** In 2025 Copenhageners owned **139,200 private cars**, including leased cars. Of these, **17,200 were battery-electric and 5,700 plug-in hybrids** (16 % together). By early 2026 the city had **27,600 EVs and 5,900 PHEVs**, about 20 % and 4 % of the fleet. Ownership was **250 cars per 1,000 adults citywide** and **191 in Nørrebro**, the lowest of the ten districts ([KK Mobility Report 2026, pp. 3, 10–12](https://byudvikling.kk.dk/sites/default/files/2026-07/Mobility%20Report%202026.pdf)).
- **Published, national new-car market 2025.**
  - Battery-electric cars were **68.2 %** of new registrations, and **541,000 EVs** were on the road at the turn of the year ([Danmarks Statistik, 13 Jan 2026](https://www.dst.dk/nyt/51749)). The later release gives **69.1 %** ([DST, 2 Mar 2026](https://www.dst.dk/nyt/51537)).
  - The best sellers were **Skoda Elroq (10,623), VW ID.4 (8,572) and Tesla Model Y (7,672)** ([Nordisk Bil](https://www.nordiskbil.com/here-are-denmarks-best-selling-cars-of-2025/)).
  - Mobilsiden adds **Skoda Enyaq 4th, VW ID.3 5th and ID. Buzz 7th**, and notes that apart from the VW T-Roc and Cupra Formentor the top places are all EVs ([Mobilsiden](https://mobilsiden.dk/?p=254127)).
  - The VW Group took about **40 %** of the market. VW was the top brand (29,041), ahead of Skoda (19,172), Mercedes, Audi and BMW ([FDM](https://fdm.dk/nyheder/nyt-om-trafik-og-biler/2025-bilsalg-bilkoeberne-flokkes-om-et-stort-bilfirma); [VW Danmark](https://www.mynewsdesk.com/dk/volkswagen-danmark/pressreleases/volkswagen-topper-bilmarkedet-i-danmark-i-2025-3423596)).
- **What this means for the street.** The parked fleet is older than new sales. About 75–80 % of private cars in the city still run on petrol or diesel (including plug-in hybrids), and those are mostly 2010s European hatchbacks, estates and small crossovers (Golf, Octavia estate, Yaris, Polo and similar). New and moving traffic is increasingly made up of compact electric crossovers.
  - **Observed:** [ravnsborggade-parked-2017], [norre-sogade-autumn-2015] and [bus-yellow-electric-dlb-2023] show small dark and silver European hatchbacks, MPVs and white vans. There are no long sedans and no large SUVs.
- **Estimate, mix for the twin (2026).**

  | Body type | Share | Typical models |
  |---|---|---|
  | Compact crossover or SUV (mostly EV) | 35 % | Elroq, ID.4, Enyaq, Model Y |
  | Hatchback | 30 % | ID.3, Golf, Yaris, Polo |
  | Estate or saloon | 12 % | Octavia, Passat, Model 3 |
  | Small van or MPV | 8 % | ID. Buzz, Caddy |
  | Commercial van | 15 % | Transporter or Sprinter size |

  Lorry and van counts fell over ten years (vans −24 % in the centre, per the Mobility Report), but vans remain very visible at the kerb because of deliveries. Calibrate the van share against a traffic count if one is available.

### 1b. Dimensions to model (Estimate)

The ranges below are rounded from commonly published manufacturer figures. They are modelling envelopes and do not quote a source.

| Body | L × W (excl. mirrors) × H, m | Wheelbase, m | Notes |
|---|---|---|---|
| Compact EV crossover (Elroq / ID.4 / Enyaq / Model Y) | 4.49–4.75 × 1.84–1.92 × 1.61–1.66 | 2.77–2.89 | Short bonnet, almost no grille, full-width light bars front and rear, black wheel-arch cladding, 19–21" wheels |
| Hatchback (ID.3 / Golf / Yaris) | 3.94–4.29 × 1.75–1.81 × 1.45–1.56 | 2.55–2.77 | Two-box, steep hatch, no boot deck |
| Estate (Octavia) | 4.69 × 1.83 × 1.47 | 2.69 | Long roof to the tail |
| ID. Buzz / small MPV | 4.71 × 1.99 × 1.93 | 2.99 | Two-tone, flat front |
| Delivery van (Sprinter / eSprinter size) | 5.9–6.0 × 2.02 × 2.6–2.8 | 3.67 | Mostly white, sometimes liveried |

The current `BODY_SPECS.sedan` (4.5 m long, about 1.86 m wide, roof at 1.455 m) is close in size to the compact class. Its proportions are what look wrong: the three-box deck at `deck: -1.68`, the chrome strip, and the separate grille and intake. `BODY_SPECS.suv` (4.6 × 1.93 × 1.76 m, with rails and cladding) is about 10 cm too tall for an Elroq or ID.4, and it has roof rails and an upright boxy tail.

### 1c. Colours

- **Published.** In Europe the most popular car colours are **grey 26 %, white 25 % and black 22 %** (Axalta 2025 report, via [MyChesCo](https://www.mychesco.com/a/news/regional/white-gray-black-still-rule-as-car-color-choices-shift-only-at-the-edges/)).
- **Unresolved.** I found no current Denmark-specific colour statistic. FDM figures date from 2014–2018.
- **Estimate, weights for the twin.**

  | Colour | Weight |
  |---|---|
  | Grey (two tones, including matte "nardo" grey) | 26 % |
  | White | 24 % |
  | Black | 22 % |
  | Silver | 8 % |
  | Dark blue | 9 % |
  | Red | 4 % |
  | Green, beige and other | 7 % |

  The current `sedanPalette` and `suvPalette` (`js/traffic.js`) and `CAR_PAINTS` (`js/street-furniture-data.js`) give burgundy and forest green a fifth of the fleet. That is too much.

### 1d. Licence plates

- **Published, secondary source.** Danish plates read "two letters and five digits" (AB 12 345). They are black on white with a red border. Commercial vans have **yellow** plates. The EU band has been optional since July 2009. The standard long plate is listed at **520 × 110 mm** ([Wikipedia](https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Denmark)). Some vendor sheets give 504 × 120 mm. **The exact size is Unresolved:** the governing order is BEK 663/2025, which I could not fetch (HTTP 429). An aspect ratio of about 4.3–4.7 : 1 is safe either way.
- **Observed.**
  - [plate-private-2025]: white plate with a thin red inner border line, a blue EU band with "DK", black condensed DIN-style characters, and dealer surrounds.
  - [plate-commercial-yellow]: the same layout on yellow.
  - [dlb-cycle-counter-2011]: a yellow plate on a delivery lorry.
- **For the twin.** The rear plate should have half-extents of about **0.26 × 0.055 m**, not the current 0.155 × 0.06. Add a front plate texture as well. Rebuild the atlas rows at roughly 4.7 : 1 with a blue band on the left, and add a yellow variant for vans. Use made-up registrations and keep the current approach of not reproducing real ones.

### 1e. Taxis, police, refuse trucks, delivery vans

- **Taxi, Published.** Under [BEK 1628/2017 §5](https://www.retsinformation.dk/eli/lta/2017/1628/pdf), the roof lamp shows a **green illuminated face to the front** with the word **"Taxi" in white or yellow**, letters at least **50 mm** high, and an illuminated area of at least **185 cm²**. Any light shown to the rear must be red. The lamp is lit only when the taxi is for hire and must be off while the meter runs. An optional **"Fri"** sign behind the windscreen shows green light forward.
- **Taxi fleet.** The large Copenhagen companies (Dantaxi, 4x35) were around 50–55 % electric in 2025 and aimed for 100 % ([TV 2 Kosmopol](https://www.tv2kosmopol.dk/metropolen/slut-med-benzin-og-dieseltaxaer-indenfor-et-par-aar)). **Estimate:** model taxis as dark or black compact EVs, estates and Model Y–type cars with the green roof lamp, at about 2–3 % of moving cars. The specific models are Unresolved.
- **Police, Published.** Since 2013 Danish police use **reflective yellow and blue** markings ([FDM 2013](https://fdm.dk/arkiv/2013-01-nemmere-faa-oeje-paa-politibilen)). A VW ID.4 GTX was trialled as an electric patrol car in 2023 ([FDM 2023](https://fdm.dk/nyheder/nyt-om-trafik-og-biler/2023-01-politiet-saetter-stroem-til-patruljebilen)).
- **Police, Observed.** [police-van-2016] shows a blue Mercedes Sprinter with "POLITI", a chequered band and a blue roof light, on a Copenhagen street. Use it as one rare vehicle in the mix, not as a fleet statistic.
- **Refuse trucks.** **Published:** Amager Ressourcecenter (ARC) runs Scania electric refuse trucks in Copenhagen; they are almost silent and swap the diesel sound for none ([Vattenfall](https://group.vattenfall.com/uk/newsroom/News/2023/silent-revolution-as-copenhagens-rubbish-trucks-go-electric)). **Estimate:** a 10–11 m, 3-axle Scania L-series low-entry cab, with paint to be photo-matched before use.
- **Delivery vans.** **Published:** PostNord Denmark leased 25 Mercedes **eSprinters** for parcel routes including Copenhagen ([Mercedes-Benz Danmark](https://www.mynewsdesk.com/dk/mercedes-benz-danmark/pressreleases/postnord-sender-25-nye-elektriske-pakkebiler-paa-vejene-op-til-jul-3055796)), and Post Danmark's red and yellow livery gave way to PostNord blue from 2016 ([CPH Post](https://cphpost.dk/2016-07-21/news/post-danmark-changing-traditional-colours)). **Observed:** in [ravnsborggade-parked-2017], white vans with operator graphics are parked half on the kerb. White is the default van colour.

## 2. Buses (Movia)

- **Published, livery.**
  - Movia buses are **yellow**. A-buses carry **red corners at the front right and rear left** ([Wikipedia, A-bus](https://en.wikipedia.org/wiki/A-bus_(Copenhagen))). S-buses carry a **blue corner** on the otherwise yellow bus ([lex.dk, S-bus](https://lex.dk/S-bus)).
  - Line **5C** went electric at the **end of March 2026**. Its new **18.75 m articulated** buses are **all yellow**, and the line keeps a light-blue destination display. They have 39 seats and are approved for 106 passengers. The operator is GoCollective ([TV 2 Kosmopol, 6 May 2026](https://www.tv2kosmopol.dk/spoerg-os/cool-at-linje-5c-er-blevet-elektrisk-men-hvorfor-er-der-faerre-pladser-a79a2)).
  - Most A-bus lines use **13.7 m** buses. Line **6A** (Buddinge–Nørreport) is an A-bus line (Wikipedia, as above).
  - Movia met its electric-bus target early; most city buses are now battery-electric.
- **Observed.**
  - [bus-yellow-electric-dlb-2023]: a 12 m-class electric bus on Dronning Louises Bro in June 2023. Yellow body, black glazing band to the roof, red front-right corner, amber LED destination sign, and a light-grey roof pod.
  - [bus-5c-articulated-2025]: the old 5C on 21 May 2025. A light-blue (turquoise) articulated bus.
  - [bus-lane-norrebrogade-2019]: a yellow 3-axle 13.7 m-class bus in a **red-asphalt bus lane** with "BUS" lettering on Nørrebrogade.
- **For the twin.** Set the scene date (see visual-refs). For 2026 or later, the 5C on Nørrebrogade and over the bridge is a yellow 18.75 m articulated bus. Replace the red band and white ribbon (`createLoftedBusMaterial`, `livery = mix(...)` near line 1451 of `js/actor-models.js`) with:
  - a plain yellow body;
  - a black band from the window line to the roof;
  - a red corner patch at the front right and rear left for A-lines, or blue for S-lines.

  Add an articulated variant: two bodies joined by a bellows, with `BUS_SPEC` halves of about 11.5 + 7.2 m and three axles. Keep the 12 m rigid body for other lines.

## 3. Bicycles and cyclists

### 3a. Numbers

- **Published, from the [KK Mobility Report 2026](https://byudvikling.kk.dk/sites/default/files/2026-07/Mobility%20Report%202026.pdf), pp. 3–10.**
  - Modal split of all journeys in 2025: **28 % bicycle**, 26 % motor vehicle, 25 % walking, 21 % public transport.
  - **43 %** of trips to work or education were cycled (46 % in 2024). For Copenhageners' own commute the figure is **47 %**.
  - Copenhageners own **754,200 bicycles**, more than one per resident. Of these, **43,400 are cargo bikes** (5.8 %) and **41,900 are e-bikes**.
  - About **10,700 shared bikes** are on the street.
- **Published, scooters.** The city has about **10,000–11,000** rental bikes across 4 operators, and **3,200 Lime e-scooters**. Scooters may only be parked in about 400 designated areas and are banned in a zone that includes parts of Nørrebro ([KK scooter permits](https://www.kk.dk/erhverv/butik-gadesalg-og-restaurant/loebehjulsudlejning); [KK note, Dec 2025](https://borgerrep.kk.dk/sites/default/files/2025-12/9.%20Udlejningscykler%20og%20-l%C3%B8behjul.pdf)). Sights to model:
  - **Published:** one breakdown of the shared-bike fleet gives **Voi 4,000, Lime 4,000, Donkey Republic 3,000, Dott 2,700 and Bolt 1,300** ([TV 2 Kosmopol](https://www.tv2kosmopol.dk/koebenhavn/antallet-af-lejecykler-fordoblet-pa-tre-ar-parti-vil-have-aendret-lovgivningen-eae8c)).
  - **Estimate:** model these as operator-coloured e-bikes (orange Donkey, green Lime, coral Voi, teal Dott) and Lime scooters, standing in small clusters rather than scattered singly. Photo-match the colours before use.
  - **Unresolved:** I found no current status for Bycyklen, the white tablet e-bikes.
- **Published, helmets.** **47 %** of Copenhagen cyclists say they wear a helmet on all or nearly all rides, against 59 % nationally. Copenhagen has one of the lowest shares in Denmark ([TV 2 Kosmopol / Rådet for Sikker Trafik](https://www.tv2kosmopol.dk/koebenhavn/kobenhavnerne-er-darligst-til-at-bruge-cykelhjelm-c37e2)). This is self-reported; helmet use seen in commuter traffic is probably lower.
- **Published, Dronning Louises Bro.**
  - The bridge is "the world's busiest bicycle street". Its widened sunny side got **more benches than planned** because so many people gather there, and **the railing and pavement are hangouts when the sun hits the lakes** ([VisitCopenhagen](https://www.visitcopenhagen.com/copenhagen/planning/dronning-louises-bro-gdk699876)).
  - Secondary sources put the daily count at 40,000–48,000 cyclists, but no primary count was retrieved, so this is **Unresolved**.
- **Published, green wave.** On Nørrebrogade, signals are coordinated for cyclists at **20 km/h** inbound in the morning and outbound in the afternoon ([Centre for Public Impact](https://www.centreforpublicimpact.org/case-study/green-waves-bicycles-copenhagen)). Green LED "wave" studs set in the track are reported only by secondary sources and are **Unresolved**, so do not model them without a photo.

### 3b. What the bikes and riders look like

- **Observed, posture and clothing.**
  - [dlb-cyclists-2012], [bus-yellow-electric-dlb-2023] and [cargo-bike-norrebrogade-2013] show **upright riders** with straight backs and hands high on swept-back bars. Most wear **everyday clothes**: dark jackets, jeans, scarves, backpacks or pannier bags. Few wear helmets, and those helmets are dark or muted rather than white.
  - Bikes are **city bikes**: step-through and diamond frames, mudguards, chain guards, front baskets or black plastic crates, rear racks with bags, and kickstands.
  - [cargo-bike-norrebrogade-2013] shows a three-wheel Christiania-type box bike with a plywood box, black canopy and child on board. For its dimensions see visual-refs §5 (Christiania Classic Medium is 2.08 × 0.87 × 1.17 m).
- **Observed, parked bikes.** [ravnsborggade-parked-2017], [norrebrogade-corner-bikes-2019] and [norre-sogade-autumn-2015] show **continuous rows of parked bikes**: in racks, and on kickstands leaning on façades and kerbs along most of a block face. There are wicker and steel baskets, child seats, and a predominantly **black and dark** frame palette with some pastel blue, mint and cream, plus white and orange rental bikes. **Estimate:** on Nørrebro shopping streets, 1 bike per 0.6–1.0 m of façade for 40–70 % of the block length. On Nørre Søgade's residential side, small clusters of 2–6 at doorways.
- **Estimate, rider mix for the twin.**

  | Group | Share of riders |
  |---|---|
  | Upright city bike, everyday clothes | 70 % |
  | Cargo bike | 5–6 % (matches the 5.8 % fleet share); most are two-wheel long-johns (Bullitt, Larry vs Harry type), the rest three-wheel Christiania-type |
  | E-bike or shared bike | 8 % |
  | Road or sport bike in sportswear | 8 % |
  | Child seat on the rear rack | 5 % |

  **Helmets:** 35–45 % of riders, in dark or muted colours. **Rain:** from October to March, 15–30 % of riders in rain jackets or ponchos on wet days. **Speed:** a mean of about 15–16 km/h, with the green-wave platoon at 20 km/h.

## 4. Pedestrians and people at rest

- **Observed, clothing.**
  - [dlb-cyclists-2012] (summer 2012, overcast, per the file description) and [ravnsborggade-parked-2017] (March): almost everyone wears **black, navy, charcoal or dark olive** outerwear, with occasional beige or camel trench coats, pale denim and white trainers.
  - [bus-yellow-electric-dlb-2023] (June): white T-shirts, light shirts, shorts and sunglasses.

  Fashion-week coverage is not representative of ordinary street dress and is not used here.
- **Estimate, seasonal outerwear palette.**

  | Season | Palette |
  |---|---|
  | Autumn and winter | black and charcoal 45 %, navy 15 %, beige and camel 12 %, olive or brown 10 %, grey 10 %, one muted colour (rust, bottle green, burgundy) 8 % |
  | Summer | white and off-white tops 35 %, light blue denim, black 20 %, pastels and stripes |

  Add props at about these rates: tote bag or backpack 40 %, pram 3–5 % (Nørrebro has many young families), dog on a lead 3 %, umbrella only in rain, phone in hand 20 %.

  The current `COAT_COLORS` and `COAT_COLORS_F` in `js/pedestrians.js` lean warm and saturated (rust 0x7d3f22, plum 0x8c5a7a, red 0x7a2630). `SKIN_COLORS` has four of five entries in medium-to-dark tones. Rebalance both toward the observed street mix, keeping the city's diversity.
- **People at rest, Published (VisitCopenhagen, above) and Observed.**
  - On sunny afternoons and summer evenings, groups sit on the bridge benches, **on the stone railing and the pavement kerb of Dronning Louises Bro**, and along the lake banks facing west into the sun.
  - **Observed** in [bus-yellow-electric-dlb-2023]: pedestrians massed on the north pavement and a person seated on a bridge bench.
  - **Estimate:** on summer weekend evenings, 40–150 seated people on and around the bridge. They sit in groups of 2–6, with bikes parked against the parapet and drinks, and face the low sun over Peblinge Sø.

  This needs seated poses (bench, ledge with legs dangling, cross-legged on the pavement), which the rig does not yet have.

## 5. Street furniture not covered in visual-refs

- **Café furniture and signs, Published** ([KK outdoor-serving rules](https://www.kk.dk/erhverv/butik-gadesalg-og-restaurant/udeservering/retningslinjer-og-vilkaar-for-udeservering)):

  | Item | Rule |
  |---|---|
  | Tables and chairs | Must be easy to move |
  | Parasols | Movable by one person; edge at least **2.3 m** above the pavement; struck after midnight and outside opening hours |
  | Screening | Only planters, toward the carriageway or between two serving areas; no plexiglass, queue barriers or tarpaulins; no enclosure |
  | Planters | At most **100 × 40 × 120 cm** including plants |
  | Pedestrian route | A free walking line of at least **80 cm** (two slab rows where the pavement has them); at least 50 cm from tactile guide lines |
  | Sandwich boards | At most **60 or 80 cm wide × 150 cm high**, against the façade or inside the serving area |
  | Open flame | No candles, no outdoor cooking |

  Awnings must be at least **2.8 m** above the pavement and **1.5 m** back from the kerb or cycle track ([KK signs and awnings](https://www.kk.dk/erhverv/butik-gadesalg-og-restaurant/reklamer-skilte-og-markiser-paa-bygninger)).

  **Observed** in [blagardsgade-cafe-2014]: pine beer-garden benches and tables on the pedestrian street, a chalk sandwich board, potted plants, and parked bikes immediately alongside.
- **Glass igloos, Observed.** [glass-igloo-2014] shows a single **dark slate-grey ribbed polyethylene igloo**, about 1.5 m in diameter and 1.1 m high, with round inlets on the top cap, a recycling decal, stickers and graffiti, standing on the pavement at a corner (Estimate dimensions). This replaces the green, white and brown trio in `buildGlassContainers`. For the newer C.F. Møller sorting points, see visual-refs §2.
- **Underground containers, Published** ([KK guide, rev. 2023](https://www.kk.dk/sites/default/files/2026-07/NEDGRAVEDE%20BEHOLDERE.pdf)).
  - Inner containers hold at least 3 m³. Recommended volumes are 5 m³ for residual waste, paper, plastic and metal, 4 m³ for glass and 3 m³ for food waste.
  - Lifting requires 12 m of free height and a 1.5 m safety zone. Inlets must be at least 2.5 m from the carriageway.
  - KK is building **750 public sorting points**.
  - **Estimate:** above ground, each container is a 1.0–1.2 m high inlet column on a flush deck plate of about 1.8 × 1.8 m.
- **Cycle counter, Observed.**
  - [dlb-cycle-counter-2011] (1 July 2011) shows a **free-standing dark-grey column, about 2.6 m tall**, on Dronning Louises Bro's pavement edge facing inbound cyclists. It has a red LED clock and temperature, a large red LED "you are number N today" counter, a blue LED year total, an "I ♥ CPH" bicycle logo and the city arms, and is covered in stickers.
  - The same design was photographed at Søtorvet in 2010 (Commons, *Cykeltæller på Søtorvet 01*, public domain, not downloaded).
  - **Unresolved:** whether it still stands in 2026.
- **Electrical and telecom cabinets, Estimate.** Grey-green or grey steel cabinets, about 0.8–1.2 × 0.3–0.4 × 1.0–1.4 m, at pavement backs and corners, heavily stickered and postered. The operator and RAL colour are unresolved, so photo-match before modelling them as anything other than generic cabinets.
- **Manhole covers and gratings, Unresolved.** No licensed local photo was found of a HOFOR or Københavns Kommune cover. The Commons "Copenhagen manhole cover" results are Tivoli and decorative covers, not standard street covers. Use generic circular cast-iron covers (Ø0.6–0.7 m, Estimate) and slot gratings at the kerb line until surveyed.
- **Street-name signs.** See visual-refs §10a. [norrebrogade-corner-bikes-2019] also shows a blue enamel corner plate on the façade.

## 6. Traffic signs (none in the twin yet)

**Published**, from [BEK 425/2023](https://www.retsinformation.dk/eli/lta/2023/425/pdf) (sign catalogue) and [BEK 426/2023](https://www.retsinformation.dk/eli/lta/2023/426/pdf) (use and placement).

**Signs relevant to the area:**

| Sign | Meaning | Appearance |
|---|---|---|
| D 21 | Cykelsti (cycle track) | Blue disc, white bicycle |
| UD 21,1 | Two-way cycle traffic | Supplementary panel |
| D 22 | Gangsti (footpath) | Blue disc |
| E 19 | Ensrettet færdsel (one-way) | Blue rectangle, white arrow |
| C 19 | Indkørsel forbudt (no entry) | Red disc, white bar |
| C 55 | Speed limit | Red ring, black number; "40" is Observed at both ends of Dronning Louises Bro in [dlb-cyclists-2012] and [bus-yellow-electric-dlb-2023] |
| E 47 | Cykelgade | |
| E 33 | Parking | See visual-refs §7 |

**Placement rules (BEK 426):**

- Sign backs are **grey** (§22).
- Signs over a footway need at least **2.2 m** clearance to the bottom edge; over a cycle track, at least **2.3 m** (§26, stk. 3).
- Warning signs, give-way signs and some prohibition signs are not mounted below **1.5 m** (§26, stk. 5).
- The sign or post edge is at least **0.5 m** from the carriageway edge (§27); for direction signs, at least 0.3 m from a cycle path (§285).

**Observed:** [bus-lane-norrebrogade-2019] shows a "no cycling" type C sign on a slim grey pole with a supplementary panel at a crossing.

## 7. Road surface and paint

**Published**, from [BEK 426/2023, Bilag 5](https://www.retsinformation.dk/eli/lta/2023/426/pdf) (pp. 87–88). Use Type C, built-up area at 60 km/h or less. Tolerance is −5/+10 %.

| Marking | Code | Stripe : gap (m) | Width (m) |
|---|---|---|---|
| Lane line / centre line | Q 41.1 | 2.5 : 5 | 0.10 |
| Junction guide line | Q 41.2 | 0.5 : 1 to 1.25 : 2.5 | 0.10 |
| Warning line (centre) | Q 42.2 | 2.5 : 1.25 | 0.10 |
| Barrier line | Q 44 | solid | 0.10 |
| Narrow edge line | Q 46.2 | solid | 0.10 |
| **Wide edge line** (§188 stk. 3 requires it between ordinary lanes and special lanes: parking, bus, turn and cycle lanes) | Q 46.1 | solid | **0.30** |
| Wide dashed edge line | Q 47 | 2 : 2, 1 : 1 or 0.5 : 0.5 | 0.30 |
| Edge line on a cycle track | Q 50 | solid | 0.10 |
| Stop line | S 13 | | 0.30 or 0.50 |
| Pedestrian crossing | S 17 | bars 0.5, gaps 0.5 | bar length 2.5 (minimum), 3 (normal), 4 (free-standing) |
| **Cycle crossing in a junction** | S 21 | 0.5 : 0.5 | 0.30; may be blue instead, carried through the junction, always with the V 21 bike symbol (§199) |
| Parking bay | T 33 | | 0.10 |
| Yellow no-stopping line | T 61 | solid | 0.10 |
| Yellow no-parking line | T 62 | 0.5 : 0.5 | 0.10 |

**Code comparison** (`js/road-surfaces-cph.js`):

- `LINE_W = 0.12` should be **0.10**.
- Lane dashes `dashed(..., 2, 6)` should be **2.5 on a 7.5 period**.
- The centre `dashed(..., 3, 9)` should also be **2.5 / 7.5**. The 5 : 2.5 warning line may be used only on the approach to junctions.
- The track edge line (`o1 + 0.12 … +0.1`) matches Q 50.
- The blue junction ribbon matches S 21, but it is missing the V 21 bike symbol and the 0.3 m dashed borders.

**Observed:**

- [bus-lane-norrebrogade-2019]: the Nørrebrogade bus lane is **red-brown asphalt** with large white "BUS" lettering. The `red` marking kind already exists in the surfaces data but is not drawn.
- [norrebrogade-corner-bikes-2019]: a **yellow T 61 line** runs along the kerb face at the Nørrebrogade corner. The `yellow` kind exists but is not drawn.
- Asphalt across the photos is a mid grey with visible patch seams and dark tar-sealed cracks, not the near-black of fresh asphalt. The current base of sRGB (60, 62, 66) is plausible. Patch rates of 10 % (`patchRate: 0.1`) on roads are on the low side for Nørrebrogade's utility trenches (Estimate 15–20 %, with long thin trench patches running parallel to the kerb rather than square repairs).

**Cycle track profile.** See visual-refs §10c (KK draft: road-to-track step 80–120 mm, track-to-footway step 60–80 mm). The twin's `SURFACE_Y` gives a 100 mm step from road to track and 80 mm from track to footway, which is consistent.

**Tactile paving, Unresolved.** KK uses tactile guide lines and warning fields at crossings and bus stops (the outdoor-serving rules refer to *ledelinjer*). Exact dimensions were not established, so photo-match them.

## Top changes for the twin (ranked by visual impact per unit of effort)

1. **Modern European car bodies** (impact very high, effort M–L). Replace the 1990s sedan and SUV with three `BODY_SPECS` entries: `crossoverEV` (4.6 × 1.88 × 1.63 m, short bonnet, closed grille, light bars, cladding, no chrome), `hatch` (4.2 × 1.79 × 1.5 m, two-box with no `deck`) and `van` (5.9 × 2.0 × 2.65 m). Optionally add `estate`.
   - Pick body types by the §1a weights in the `NUM_CARS` loop of `js/traffic.js`, replacing `isSUV = i % 2 === 0`. Do the same in `parkedCars()` in `js/street-furniture-data.js`, replacing `body: j(5) < 0.42 ? 'suv' : 'sedan'`.
   - Set `chrome: false` everywhere and replace the separate `grille` and `intake` masks with an EV light bar in `createLoftedCarMaterial`.
   - Each body is one instanced mesh, so it costs one more draw-call pair (near and far).
2. **Car paint weights** (high, S). Grey, white and black about 72 %, then silver, blue and a few red. Edit `sedanPalette`/`suvPalette` in `js/traffic.js` and `CAR_PAINTS` in `js/street-furniture-data.js`. Drop forest green and burgundy to 1 entry in 20.
3. **Cyclists look Danish** (high, S–M).
   - In `js/cyclists.js`, show a helmet on about 40 % of riders (`hash(i) < 0.4`) in dark or muted colours, and drop the white emissive material.
   - Pose riders upright.
   - Give `buildBike` in `js/cyclists.js` and the `controllers.js` frame a step-through variant with a basket or crate and mudguards.
   - Add about 5 % cargo bikes (a two-wheel long-john and a Christiania-type trike).
4. **Dense parked bikes** (high, M).
   - Raise rack fill in `rackItems()` to 0.7–1.0 on Nørrebro shopping streets.
   - Add free-standing kickstand bikes along façades from the building and pavement frame, at 1 per 0.6–1.0 m on 40–70 % of the block face.
   - Add step-through, basket, crate and child-seat variants to `buildBike()` in `js/street-furniture-geometry.js`.
   - Make `BIKE_COLOURS` (`js/street-furniture-cph.js`) mostly black and dark, with some pastel and orange or white rental bikes.
5. **Danish plates** (medium-high, S). In `createLoftedCarMaterial`, make the rear and front plate masks 0.52 × 0.11 m (half-extents 0.26 × 0.055) and texture the front plate too. Redraw the `carPlateTexture()` rows at about 4.7 : 1 with a blue EU/DK band, a thin red border and a condensed font, plus a yellow variant for vans (by body type).
6. **Movia buses** (medium-high, M). In `createLoftedBusMaterial`, use a yellow body, a black window-to-roof band and red A-bus corners (blue for S), and remove the red band and white ribbon. Add an 18.75 m articulated variant for 5C on Nørrebrogade and Dronning Louises Bro. Alternatively, make the bus colour depend on scene date: turquoise before April 2026.
7. **Road paint to Danish dimensions** (medium, S). In `js/road-surfaces-cph.js`:
   - `LINE_W = 0.10`;
   - `dashed(..., 2.5, 7.5)` for both lane and centre lines;
   - 0.30 m solid lines for parking and painted cycle lanes;
   - add the V 21 bike symbol to the blue junction ribbon (`bikeSymbol` already exists);
   - render the `red` bus-lane fill with "BUS" text and the `yellow` kerb lines (add them to `RENDERED_MARKINGS`).
8. **Traffic signs** (medium, M). Add one instanced sign family to the street-furniture modules: grey pole, grey back, face from a small atlas (D 21, E 19, C 19, C 55 "40", E 33). Mount at least 2.2 m to the bottom edge over a footway and 2.3 m over a cycle track, and at least 0.5 m from the carriageway. Place them from OSM `traffic_sign`, the cycle-track starts and the one-way data already used by `bike-direction.js`.
9. **Pedestrian palette and props** (medium, M). Rebalance `COAT_COLORS`, `COAT_COLORS_F` and `SKIN_COLORS` in `js/pedestrians.js` to the §4 seasonal mix. Add tote and backpack meshes, prams (3–5 %) and dogs (3 %).
10. **People on Dronning Louises Bro** (medium, M–L). Add seated and ledge poses and a time-of-day and season-driven population on the bridge benches, parapet and lake banks: 40–150 people on summer evenings, very few in winter.
11. **Glass igloo** (low-medium, S). Replace the trio in `buildGlassContainers()` with a single dark slate ribbed igloo (Ø about 1.5 m, H about 1.1 m) with a top cap, inlets and a sticker texture.
12. **Café spill-out on Blågårdsgade and Ravnsborggade** (low-medium, M). Add an instanced set of beer benches, bistro tables and chairs, parasols (edge 2.3 m), planters (at most 1.0 × 0.4 × 1.2 m) and sandwich boards (0.6–0.8 × 1.5 m) within a façade strip that keeps 0.8 m free. Place them from OSM `amenity=cafe|bar|restaurant` frontages.
13. **Rare vehicles** (low, M). Taxis with a green "TAXI" roof lamp (2–3 %, lamp lit only when free), white delivery vans with yellow plates, a PostNord-blue eSprinter, an ARC electric refuse truck in the morning, and an occasional police vehicle with yellow and blue reflective markings.
14. **Bridge cycle counter** (low, S). A single 2.6 m dark column with emissive red and blue LED digits, using the daily count from the cyclist simulation. Place it at the bridge pavement edge as in the 2011 photo, but confirm it still exists first.

## Remaining survey work

- The exact Danish plate size under BEK 663/2025.
- Current Movia lines and vehicles serving Nørre Søgade (the 350S photo dates from 2019, before rerouting).
- Present-day bike-counter location.
- Bus-lane extents.
- Café frontages.
- Cabinet and manhole products.
- A dated summer evening photo series from the bridge to calibrate seated crowd density.
- A local traffic count to fix the van share.
