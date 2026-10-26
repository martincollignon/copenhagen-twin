# Buildings and facades: what makes Søerne / inner Nørrebro recognisable

**Scope:** street and lake fronts in the twin's 1.5 × 1.5 km district. That covers:

- Nørrebro brokvarter perimeter blocks, 1850–1915 (Ravnsborggade, Blågårdsgade, Elmegade, Sankt Hans Torv);
- the lake-front blocks on Peblinge and Sortedam Dossering, Nørre Søgade and Søtorvet;
- the 1970s–80s renewal blocks around Blågårds Plads;
- newer infill.

**Research and URL checks:** 26 October 2026.

**Purpose:** a modelling guide with numbers for `js/tsl-materials.js`, `js/building-geometry.js`, `js/buildings-real.js`, `js/appearance.js` and `tools/cph-geodata/presets.py`. It is not a building survey.

## How to read the evidence

The tags follow [visual-refs.md](../visual-refs.md):

- **Published:** stated in a cited municipal, heritage-agency or technical document. Conversions to metres are shown.
- **Observed:** visible in a dated photograph, either in [refs/buildings/](refs/buildings/ATTRIBUTION.md) or in the earlier [visual-refs pack](../visual-refs/README.md). A photo shows appearance on its date; it does not give dimensions.
- **Estimate:** an editable modelling start value, not a measurement.
- **Code:** what the twin does today, read from the source on this branch.

The old Danish unit in the sources is the **alen** (Sjælland), which equals 0.6277 m, and 1 alen = 2 fod ([da.wikipedia, Alen](https://da.wikipedia.org/wiki/Alen)).

---

## 1. Massing, storeys and floor heights

### 1870s rules

**Published:** these rules come from SLKS's *Etagekonstruktioner 1850–1890* ([SLKS 1.4](https://slks.dk/fileadmin/user_upload/kulturarv/publikationer/emneopdelt/bygninger/Bygningsbevaring/1.4%20Etagehuskonstruktioner%201850-1890.pdf), PDF pp. 1, 4).

- About 100,000 dwellings were built in the bro- and voldkvarterer before WWI. They were "overwhelmingly in 5- and 6-storey buildings (including basement)".
- The typical mid-1870s street house was:
  - at most **25 alen (15.7 m)** from terrain to the top of the roof beams, and the street facade could go **1 alen (0.63 m)** higher by dispensation;
  - built with habitable rooms at least **4 alen (2.51 m)** clear, a basement standing at least **2 alen (1.26 m)** above terrain, and floor structures up to **½ alen (0.31 m)** thick;
  - topped by a saddle roof at most **45°**, or the *københavnertag* (a cut-off saddle, mansard-like);
  - about **15 alen (9.4 m)** deep.

**Estimate, derived from those rules:**

- Floor-to-floor height is about **2.8–2.9 m** at the legal minimum.
- A raised basement of about 1.3 m plus five storeys of 2.85 m comes to 15.5 m, which fits the 25-alen cap. That is the classic "ground floor on a half-basement" section.
- Better-class buildings ran 3.0–3.3 m, with a taller *beletage*.

### Storeys in the district

**Published:**

- **Lake front:** the buildings stand **4½ to 5½ storeys**. The corner buildings at Nørrebrogade form a gateway "adorned with towers and spires" ([KK Bydelsatlas Nørrebro](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1330_EysnkhaOIn.pdf), PDF p.18).
- **Elmegade/Ahornsgade (1884–89):** five storeys, "mostly rendered in light colours", with horizontal bands, frontispieces and corner towers (same atlas, PDF p.22).
- **Ravnsborggade:** "a uniform five-storey perimeter development". The block was largely complete by 1890. The richest detailing faces Nørrebrogade, Fælledvej and Sortedam Dossering, and the inner streets are plainer ([KK kulturmiljø 1.14 Ravnsborggadekvarteret](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).

### Renewal and infill

**Published:**

- The 1970s–80s *saneringer* replaced Den Sorte Firkant with non-profit housing "generally built 1–2 storeys lower than the demolished buildings".
- They left "holes in the street picture and exposed gables" ([Bydelsatlas](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1330_EysnkhaOIn.pdf), PDF p.10).
- Part of the Blågårds Plads frame was built in the late-1970s renewal, when Blågårdsgade became a pedestrian street (atlas, PDF p.34).

**Estimate:** floor-to-floor height by era.

| Era | Floor-to-floor height |
|---|---|
| Renewal blocks | 2.7–2.9 m |
| Post-2000 infill | 3.0–3.2 m, often with a recessed glazed top floor |

**Observed:** in [renewal-infill-baggesensgade.jpg](refs/buildings/renewal-infill-baggesensgade.jpg) the renewal-era infill is grey render with projecting glazed bays and cantilevered steel balconies. It stands next to a yellow-brick block.

### What the twin does today

**Code:**

- `presets.py:facade_for` sets `floor_h` to the eave height divided by the BBR storey count, clamped to 2.6–3.6 m.
- The `karre-1900` preset gives a **3.6 m ground floor that defaults to a shopfront**.

The street level of a typical residential brokvarter front is not a 3.6 m shop. It is:

1. a plinth with half-basement windows or a kælderbutik, about 0–1.3 m above the pavement;
2. then the *stueetage*, with its sills about 2.0–2.3 m above the pavement.

This is visible in [norrebro-karre-elmegade.jpg](refs/buildings/norrebro-karre-elmegade.jpg), where the dark plinth carries the low windows and the stueetage windows sit above it.

**Estimate:** keep full shopfronts for the shopping streets (Nørrebrogade, Blågårdsgade, Ravnsborggade, Elmegade corners). Everywhere else, use a "raised-basement" ground type.

## 2. Windows

### Types

**Published**, from [SLKS 5.4 Datering af vinduer 1700–1950](https://slks.dk/fileadmin/user_upload/SLKS/Omraader/Kulturarv/Bygningsfredning/Gode_raad_om_vedligeholdelse/5.4_Datering_af_vinduer_1700-1950.pdf), PDF pp. 4, 9:

- **Classicist korspost windows:** the transom sits at the **upper third point**, so the upper lights are shorter.
- **Later 1800s:** windows often get a curved head (*buet overkarm*). Glazing bars are progressively left out, so korspost windows become **dannebrogsvinduer / flagvinduer** (a single cross, or a T with an undivided lower part).
- **Funkis (from about 1930):** steel windows with two or more equal undivided sashes.
- **From 1915:** small panes come back under Bedre Byggeskik and national romanticism.

### Frame colour

**Published (SLKS 5.4, PDF p.9):**

> "Under Bedre Byggeskik [from 1915] the white window colour gains ground. Before that, windows in Denmark were brown, green, red, grey and yellow on the outside."

*Kend dit etagehus* adds two points ([Grundejernes Investeringsfond](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF pp. 10, 18, 22):

- For the håndværker-historicist house (1860–1890), the windows were side-hung with **2 or 3 fag** (bays) and a simple **dannebrog division without small bars**, and the period "usually sought a contrast-rich facade" through the colours of windows, doors and surrounds.
- For early national romanticism (1890–1910), windows were "most often white", with black and clear yellow, red and green on overhangs.

**Observed:** frame colour is mixed in our photos, not uniformly white.

- **White:** the blue and red houses on Elmegade, Sortedam Dossering/Ravnsborg Tværgade, the Sankt Hans Torv corner and the Blågårdsgade corner.
- **Near-black or dark green:** the beige house on Elmegade and Blågårdsgade 17.

Blågårdsgade 17 also shows **outward-opening side-hung casements** standing open ([windows-facade-blaagaardsgade-17.jpg](refs/buildings/windows-facade-blaagaardsgade-17.jpg)).

### Glass

**Published:**

- KK asks that sprossed windows keep single outer glass in putty (*kitfals*). Guidance is to match the original colours and to use linseed-oil paint ([KK retningslinjer for bevaringsværdige bygninger](https://www.kk.dk/borger/bolig-og-byggeri/byggetilladelse/byggetilladelse-trin-for-trin/retningslinjer-for-bevaringsvaerdige-bygninger)).
- Old cylinder glass is "quite 'lively'", wavy and uneven in thickness ([SLKS 5.4](https://slks.dk/fileadmin/user_upload/SLKS/Omraader/Kulturarv/Bygningsfredning/Gode_raad_om_vedligeholdelse/5.4_Datering_af_vinduer_1700-1950.pdf), PDF p.4).
- This is why reflections in old Copenhagen panes break up pane by pane rather than mirroring cleanly.

### Reveal depth and wall thickness

**Published (SLKS 1.4, PDF p.4):** the solid brick piers between windows are:

| Location | Thickness | In metres |
|---|---|---|
| Top storey | 1½ stone | about 0.35 m |
| Lower storey pairs | 2 to 2½ stone | about 0.47–0.59 m |
| Basement | 3 stone | about 0.71 m |
| Breasts under the windows | 1 stone | about 0.23 m, carried on arches between the piers |

The street facade is "rhythmically composed with roughly equal piers and equal large windows". Courtyard facades are irregular.

**Estimate:**

| Element | Start value |
|---|---|
| Window frame | in the outer rebate |
| Visible reveal, facade face to glass | **0.10–0.18 m** |
| Stucco window surrounds | project **0.03–0.08 m** |
| Sill | projects 0.04–0.08 m; zinc-flashed on brick fronts, a stucco profile on rendered fronts |
| Visible frame (*karm*) | **0.07–0.09 m** |
| Mullion / transom | **0.08–0.11 m** |

These are much heavier than the 1–2 cm lines the shader draws today.

### Proportions and window-to-wall ratio

**Estimate, from the photos and the presets:**

| Building type | Opening (W × H) | Bay pitch | Window-to-wall ratio |
|---|---|---|---|
| Karré upper floors | 1.1–1.25 m × 1.8–2.1 m (about 1:1.7) | 2.4–3.0 m | 25–35 % of street fronts |
| Renewal | 1.2–1.8 m wide, lower | — | about 25 % |
| Modern infill | storey-height glazing | — | 40–60 % |

The `karre-1900` preset (window 1.15 m on a 2.9 m bay) is in range. `windowRatioY: 0.55` in `buildings-real.js:324` gives about 1.6 m on a 2.9 m floor, which is a little short; 0.62–0.68 fits the photos better.

### What the twin does today

**Code:** `createPreWarBuildingMaterial` draws New York sashes:

- a meeting rail at **0.52** of the window height and a half-strength mullion at 0.5 (`tsl-materials.js:808`, `:1057`);
- 12 % of upper windows get **window air-conditioners** (`hasAC`, `:791`), which none of our Copenhagen photos show;
- the frame colour is wall colour × 0.46, so it is never white;
- the reveal is a painted lintel/jamb shadow on a flat plane (`:874–875`).

## 3. Plinth, basement shops, gateways and doors

### Plinth (sokkel)

**Published** ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF pp. 10, 16–18, 22, and the [KK stilblade](https://www.kk.dk/sites/default/files/2026-08/stilblade-for-bevaringsvrdige-bygninger-_1480.pdf), PDF p.4):

- **Håndværker-historicism (1860–1890):** "a marked heavy sokkel". It is brick, or cement-reinforced render imitating rough or smooth ashlar, with framed windows and doors, a facade band and an eaves cornice. The ground floor is often called a "markant stueetage".
- **Classicist plinths:** rendered, "often in an ashlar pattern".
- **National romanticism:** fieldstone or granite plinths, with granite lintels and bands.

**Observed:**

| Photo | Plinth |
|---|---|
| Elmegade | dark-grey render |
| Blågårdsgade corner | grey rusticated ground floor with round arches |
| Jægersborggade | weathered beige render |
| Vesterbro door | grey granite plinth and step |

**Estimate:**

- Plinth band 0.5–1.4 m high, set **0.03–0.08 m** proud of the wall, about 2–3 stops darker than the wall above. Granite is grey with pink speckle.
- On rusticated *stueetager*, the whole ground floor has horizontal rustication grooves every 0.30–0.45 m.

### Kælderbutikker and kælderhals

**Published:**

- The Ravnsborggade kulturmiljø lists "the continued use of the ground floors for public-facing services, including retail along Nørrebrogade and parts of Ravnsborggade and Sortedam Dossering" as a value to keep ([kulturmiljø 1.14](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).
- The Irma chain "was started in a basement in Ravnsborggade" ([kulturmiljø 1.14](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).
- KK's 2024 sign rules give basement shops their own clause ([Skilteretningslinjer 2024](https://www.kk.dk/sites/default/files/2026-07/skilteretningslinjer-2024-_2887.pdf), PDF p.21).

**Estimate:** no municipal dimension for the stair well (*kælderhals*) was found.

- Its depth follows from the raised-basement rule: about 0.9–1.3 m below the pavement, so 5–8 steps.
- It projects 1.0–1.4 m from the facade and is 1.2–1.6 m wide.
- It is guarded by a black-painted steel railing 0.9–1.0 m high on the pavement side, with a gate or chain.

**Observed:** shops reached by short stone steps **up** with black wrought-iron handrails and bracket signs ([shopfront-steps-jaegersborggade.jpg](refs/buildings/shopfront-steps-jaegersborggade.jpg)). No freely licensed photo of a downward kælderhals in the district was found.

### Gateways (porte) and passages

**Published:**

- Around Sankt Hans Torv, side houses are reached "via porte".
- Ravnsborggade has internal passages, Fælledvejs Passage and Sankt Hans Gades Passage, and "up to three courtyards" ([atlas](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1330_EysnkhaOIn.pdf), PDF p.20; [kulturmiljø 1.14](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).

**Estimate:**

- Carriage gate 2.5–3.2 m wide and 3.0–3.8 m high, usually round- or segment-arched, with a dark timber or iron double gate.
- At most one per street building on a plot with back houses.

### Stair doors (opgang)

**Published:** håndværker-historicist entrance doors were "panelled timber-frame doors, possibly with rosettes, imaginary timber columns or coloured-glass panels". National-romantic doors were lacquered natural wood or painted, in brick or granite portals ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF pp. 18, 22).

**Observed:** [opgang-door-sigerstedgade.jpg](refs/buildings/opgang-door-sigerstedgade.jpg) (Vesterbro, as a stand-in) shows:

- a red double timber door with glazed upper panels;
- a white arched fanlight with the house number in a stucco wreath;
- a granite step.

Elmegade has a dark double door in an arched opening in the plinth.

**Estimate:** door opening 1.2–1.5 m wide, 2.6–3.0 m high including the fanlight, with one granite step of 0.15–0.20 m.

**Code:** one door per residential front (`facadeCell` `door`, `tsl-materials.js:489`). It has a painted panel door and a transom, but no plinth, no step, no number and no gateway.

## 4. Cornices, bands, ornament, render and brick

### Cornices and bands

**Published:** historicist fronts follow the Renaissance facade scheme:

- a heavy sokkel;
- framed windows and doors;
- a facade band and an eaves cornice (*taggesims*), made in brick or cement render, "in contrast to the wall and with relief effect".

In classicism "only the eaves cornice, marking the transition between roof and facade, was pronounced" ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF pp. 10, 16). Historicism (1860–1920) has "a pronounced plinth and symmetrically placed windows" with "contrast-rich colours" ([KK stilblade](https://www.kk.dk/sites/default/files/2026-08/stilblade-for-bevaringsvrdige-bygninger-_1480.pdf)).

**Observed:**

- Elmegade has string courses at every floor, a Greek-key frieze over the plinth and pediments over the first-floor windows.
- Blågårdsgade 17 has a dentilled main cornice, hood arches and sill panels.
- Nørre Søgade 25 has a strongly projecting cornice ([visual-refs §11](../visual-refs.md)).

**Estimate:**

| Element | Projection | Height |
|---|---|---|
| Main cornice | 0.35–0.70 m | 0.6–1.0 m tall, a 3–4-step profile with a soffit shadow and a zinc-capped top |
| String courses | 0.05–0.15 m | 0.15–0.35 m |
| Window pediments and hoods | 0.08–0.20 m | — |

### Render or exposed brick

**Published:**

- Historicism brought back **exposed brick**, often combined with rendered lower facades in imitation ashlar and cement-cast ornament. These "style-imitating brick facades appear first on Nørrebro and Vesterbro" ([SLKS 1.3 Byhusenes arkitekturhistorie](https://slks.dk/fileadmin/user_upload/kulturarv/publikationer/emneopdelt/bygninger/Bygningsbevaring/1.3%20Byhusenes%20arkitekturhistorie%201480-1930.pdf), PDF p.12).
- The 1870s model house in SLKS 1.4 is "blank wall of yellow or flamed bricks, with scraped joint".
- Courtyard facades were "sober, often in yellow brick without ornament".
- Street facades were "most often smooth red or yellow machine bricks" ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF p.18).

**Published, brick size:** the Danish standard brick is **228 × 108 × 54 mm**, laid on a 12 mm joint ([da.wikipedia, Mursten](https://da.wikipedia.org/wiki/Mursten)). That gives a **course of 66 mm** and a **length module of 240 mm**.

**Code:** the shader's brick is **0.56 × 0.24 m** (`tsl-materials.js:840`, `:1020`), about 2.3× too long and 3.6× too tall. That is why the walls read as "brick-tiled boxes" with giant blocks in [contact-1.png](../../qa/sweep-after/contact-1.png).

The same running bond is applied to every street wall, including rendered ones. BBR's `mursten` (1,172 buildings) does not tell exposed brick from rendered brick.

**Estimate:**

- Classify each wall as *blank brick* or *render* from its observed tone. Saturated red or yellow-brown walls are brick; pale or pastel walls are render.
- Rendered walls get smooth stucco, with ashlar scoring only on the plinth and the stueetage.

### Colours

**Published:** KK gives no official facade palette. Where the original colour cannot be found, KK says to match the building's style and its neighbours ([KK retningslinjer](https://www.kk.dk/borger/bolig-og-byggeri/byggetilladelse/byggetilladelse-trin-for-trin/retningslinjer-for-bevaringsvaerdige-bygninger)). Classicist render was "whitewash or light earth colours" ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF p.10).

**Observed:** colours in the photos include:

- beige, pale blue, salmon, cream and white render;
- yellow brick with white stucco bands (Sortedam/Ravnsborg Tværgade);
- red brick with white quoins and surrounds (Blågårdsgade corner);
- white-painted brick (Blågårdsgade 17).

The calibrated observed tones in `appearance.js` remain the right source per wall.

### Weathering

**Estimate:**

- dark drip streaks under sills and below cornice ends;
- a 0.2–0.4 m splash and grime band at the plinth foot;
- algae greening on north-facing plinths and courtyard walls;
- mortar slightly lighter than brick on yellow brick and darker on red.

The shader's soot streaks (fading to 180 m) are fine, but they should key to sills and cornices rather than to noise.

## 5. Roofs

### Forms and materials

**Published:**

- **Håndværker-historicism:** the **45° saddle roof was covered with slate, red tile or cement tile**. Dormers came either light, or heavy with brick or timber-frame fronts ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF pp. 16–18).
- **Classicism:**
  - dormer cheeks (*flunker*) and roofs were **zinc-clad**;
  - mansard dormers mostly had curved roofs;
  - **chimneys sat symmetrically on the ridge**;
  - the roof was natural slate, or tile in "a red, blue-damped or black glazed version" (PDF p.10).
- **Stefansgade/Jagtvej:** "five storeys with slate-clad københavnertage" ([atlas](https://kk.sites.itera.dk/apps/kk_pub2/pdf/1330_EysnkhaOIn.pdf), PDF p.21).
- **National romanticism:** tile or slate with brick or granite brackets, large overhangs with exposed rafters, and dragon-head gutter brackets ([Kend dit etagehus](https://gi.dk/media/x44dpjhj/kend-dit-etagehus.pdf), PDF p.10).
- **KK guidance:**
  - zinc gutters and downpipes;
  - dormers and roof lights in an even rhythm;
  - keep original chimneys, towers and spires ([KK retningslinjer](https://www.kk.dk/borger/bolig-og-byggeri/byggetilladelse/byggetilladelse-trin-for-trin/retningslinjer-for-bevaringsvaerdige-bygninger)).

**Observed:**

- Dark slate or zinc mansards with rows of dormers dominate Nørrebro and the lake fronts ([soerne-lakefront-sortedam-irma-block.jpg](refs/buildings/soerne-lakefront-sortedam-irma-block.jpg), [windows-facade-blaagaardsgade-17.jpg](refs/buildings/windows-facade-blaagaardsgade-17.jpg)).
- Blågårdsgade 17 has about one dormer per window bay below; Elmegade has about one per 1–2 bays.
- [roofscape-tiles-dormers-chimneys.jpg](refs/buildings/roofscape-tiles-dormers-chimneys.jpg) shows black glazed tile with box dormers beside orange-red pantiles, small cast-iron roof lights and pale brick chimney stacks at the ridge or party walls.
- On Elmegade, grey zinc downpipes run down the plot boundaries.

**Estimate:**

| Element | Start value |
|---|---|
| Dormer | 1.2–1.6 m wide, 1.4–1.8 m tall; zinc cheeks; front 0.3–0.6 m behind the eave line |
| Chimney stack | 0.5 × 0.8–1.2 m, rising 0.6–1.2 m above the ridge; 2–4 per street building, at the ridge and on party walls |
| Half-round gutter | Ø 0.15 m |
| Downpipe | Ø 0.10 m, at each plot boundary and every 10–15 m |
| Eave overhang | 0–0.15 m on historicist blocks (the cornice carries the gutter); 0.4–0.8 m on national-romantic and some renewal blocks |

### Roof colour in the twin

**Code:**

- **LoD2 roofs:** roofer gives 2,114 of 2,516 buildings an LoD2.2 roof (84 %), 1,753 of them slanted ([data/lod2/report.md](../../../data/lod2/report.md)). These roofs are plain vertex colour, with no tiles, dormers, chimneys or gutters (`buildings-real.js:326`).
- **Default colours:** `ROOF_COLOURS` sets `fibercement herunder asbest` (478 buildings) to sRGB 0.46 grey (`building-geometry.js:21`).
- **Observed roof tones:** their median luminance is about 0.56 sRGB.

**Observed:** the aerial sweep ([contact-5.png](../../qa/sweep-after/contact-5.png)) shows roofs reading almost white, while real slate, eternit and black glazed tile are dark.

**Estimate:** slate or fibre-cement at sRGB 0.22–0.32 blue-grey, and red tile at about (0.55, 0.25, 0.17). Check whether the Skråfoto roof tones are biased by sky specular on oblique views before trusting them for roofs.

## 6. Balconies, bay windows and corner features

### Balconies

**Published:**

- Ravnsborggade's karrés are "vulnerable to balconies, especially towards the street" ([kulturmiljø 1.14](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).
- KK's balcony guide prefers slender railings coloured to match the windows or the cornice band, for example "Ravnsborg Tværgade: black balconies matching the colour of windows and cornice band" ([KK stilblade](https://www.kk.dk/sites/default/files/2026-08/stilblade-for-bevaringsvrdige-bygninger-_1480.pdf), PDF p.8).

So **street fronts are mostly balcony-free**, while courtyard sides carry added steel balconies.

**Observed:**

- a curved iron French balcony on the first floor at Sankt Hans Torv;
- cantilevered steel balconies on the renewal infill on Baggesensgade.

**Estimate:**

- Street fronts: 0–10 % of bays get a balcony, mostly at corners.
- Courtyard walls (holes and rear kinds): 30–60 % of bays carry 1.2–1.6 m deep steel balconies with black or galvanised railings 1.0–1.1 m high.

### Bay windows (karnapper)

**Published:** karnapper belong to palæstil, national romanticism and the "extravagant" håndværker variants ([KK stilblade](https://www.kk.dk/sites/default/files/2026-08/stilblade-for-bevaringsvrdige-bygninger-_1480.pdf)). Blågårdsgade 29 (1908, Johannes Strøm Tejsen) has canted bay windows ([en.wikipedia, Blågårdsgade](https://en.wikipedia.org/wiki/Bl%C3%A5g%C3%A5rdsgade)).

**Observed:** a stacked bay on the chamfered corner of Sortedam Dossering and Ravnsborg Tværgade ([soerne-corner-sortedam-ravnsborg-tvaergade.jpg](refs/buildings/soerne-corner-sortedam-ravnsborg-tvaergade.jpg)).

**Estimate:** bays project 0.5–0.9 m, are 2.4–3.6 m wide, run from the first floor to the eave, and are topped by a zinc roof or a balcony.

### Corner towers and spires

**Published:** at Dronning Louises Bro / Nørrebrogade the corner buildings "form a gate and are adorned with towers and spires" (atlas, PDF p.18).

**Observed:**

- the twin balustraded round corner towers at Sankt Hans Torv ([corner-tower-sankt-hans-torv.jpg](refs/buildings/corner-tower-sankt-hans-torv.jpg));
- the cupola on the white corner building at Sortedam Dossering;
- the turret finial on the Blågårdsgade corner.

Chamfered corners (*afskårne hjørner*) are common. On Egegade/Birkegade the corner building is raised to six storeys (atlas, PDF p.22).

## 7. Lit windows at night

**Published:**

- Danes often skip curtains, and covered windows "much more likely" have venetian or roller blinds ([The Local DK, 2024](https://www.thelocal.dk/20240815/the-things-you-wont-see-in-denmark-that-are-common-elsewhere)).
- Advent candles burn "in the windows of many shops and homes" in December ([Aarhus University, Christmas decorating the Danish way](https://international.au.dk/currently/news/preview/artikel/christmas-decorating-the-danish-way)).
- On 4 May almost half of Danes put candles in their windows ([Royal Danish Library, Candlelight in the windows](https://kb.dk/en/inspiration/liberation/candlelight-windows)).

**Observed:** at dusk on the lake front, roughly half the windows are lit, all in warm yellow, with very few cool or blue windows ([night-lakefront-irma-neon.jpg](refs/buildings/night-lakefront-irma-neon.jpg)).

**Estimate:**

- Light colour: 2,400–2,900 K.
- Lighting: a low pendant over the dining table at window-head height (the PH-type multi-shade pendant is the archetype). Uncovered windows with visible ceilings and back walls are typical; curtains appear on at most 10–15 % of windows.
- Sills: plants and candlesticks.
- **December:** 30–50 % of lit windows show a paper or plastic star or an electric candlestick. This share is unverified, so keep it seasonal and configurable.

**Code:** `evaluateApartmentInterior` already does interior mapping, but with New York choices:

- drapes average 29 % coverage (`tsl-materials.js:327`);
- a flush ceiling lamp;
- a cool or warm mix set by `warmth`;
- the lit share is `litProbability 0.36 × 0.62` (`:785`), about 22 %.

## 8. Graphics: signs, numbers, shop signage and graffiti

### Street-name signs

**Published:** KK policy is RAL 5011 for street-name signs, white letters on dark blue (see [visual-refs §10a](../visual-refs.md)).

**Observed:** on the Blågårdsgade corner, a plate sits on **each face, just round the corner**, at about first-floor-sill height ([corner-plinth-signs-blaagaardsgade.jpg](refs/buildings/corner-plinth-signs-blaagaardsgade.jpg)).

**Estimate:**

- Mounting height 3.0–3.8 m to the plate centre.
- Plate 0.7–1.1 × 0.18–0.25 m.
- The house-number range is printed under the name on some plates (visible on the Blågårdsgade plate).

### House numbers

**Observed:** in the fanlight or in a stucco cartouche above the opgang door.

**Estimate:** 0.12–0.20 m digits, or a white enamel plate of about 0.2 × 0.15 m beside the door.

### Shop signage

**Published:** the 2024 KK sign rules ([Skilteretningslinjer 2024](https://www.kk.dk/sites/default/files/2026-07/skilteretningslinjer-2024-_2887.pdf), PDF pp. 20–21) say:

- signs stay within the shop's own frontage;
- signs are not run across **gateways, opgange or plot lines**;
- **individual letters and neon are preferred**;
- signs on piers must not cover the pier's full width;
- **one hanging sign per shop** (two on a corner);
- as a rule **no signs above the shop storey**;
- shop windows "must not be covered with foil";
- basement shops may sign elsewhere on the facade.

**Observed:** painted signboards on wrought-iron brackets (Jægersborggade).

**Published landmark:** the **neon signs on Sortedam Dossering 1–9A** are a listed preservation value of the Ravnsborggade kulturmiljø. They have marked "the entrance to Nørrebro" since the 1930s ([kulturmiljø 1.14](https://kp24.kk.dk/sites/default/files/2024-06/1.14%20Ravnsborggadekvarteret.pdf)).

**Observed:** nemlig.com, "datomærker for friskhed", IRMA, KAFFE, a clock, the Irma girl and the hen with ØKO ÆG, reflected in Sortedams Sø ([night-lakefront-irma-neon.jpg](refs/buildings/night-lakefront-irma-neon.jpg); daytime frames in [soerne-lakefront-sortedam-irma-block.jpg](refs/buildings/soerne-lakefront-sortedam-irma-block.jpg)).

This block is inside the twin's bbox, at the Nørrebro end of Dronning Louises Bro.

### Graffiti and posters

**Published:** KK cleans graffiti on municipal property and aims to remove offensive graffiti within **4 hours on weekdays**. It cannot require private owners to clean ([KK answer, 30 June 2026](https://www.kk.dk/sites/default/files/2026-07/30.06.26%20-%20svar%20til%20Joanne%20Bywater%20%28I%29%20om%20ressourcer%20til%20straksafrensning%20af%20anst%C3%B8delig%20graffiti.pdf)).

**Observed:** a band of tags along the Sortedam lake wall in the daytime lake-front photo.

**Estimate:**

- Tags and posters sit on ground floors, plinths, gateways and utility boxes, 0–2.5 m above the pavement.
- They are denser on side streets, gable ends and the lake wall, and sparse on maintained shop fronts.

## 9. Cheap facade depth in real-time renderers

| Technique | Source | What it buys | Fit here |
|---|---|---|---|
| **Interior mapping:** ray–box rooms behind the glass, with no geometry | van Dongen, "Interior Mapping", CGI 2008 ([project page](http://interiormapping.oogst3d.net/); [Game Developer write-up](https://www.gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry), which also argues *Marvel's Spider-Man* uses it; [Automaton explainer](https://automaton-media.com/en/news/20231201-23558/)) | Parallax-correct rooms at one ray–box per pixel | **Already in** (`evaluateApartmentInterior`, ported from three.js [`SkyscraperGenerator.js`](https://app.unpkg.com/three@0.186.1/files/examples/jsm/generators/city/SkyscraperGenerator.js) / [`webgpu_generator_city`](https://threejs.org/examples/webgpu_generator_city.html)). Retune its content (§7). |
| **Analytic reveal parallax:** intersect the view ray with the glass plane set back by the reveal depth; if the hit falls outside the opening, shade the reveal face (jamb, head or sill) with its own normal; cast the sun shadow from the head and jamb by the same test | Same idea as parallax occlusion mapping, but analytic for a box, so there is no stepping ([Tatarchuk, Dynamic POM with Approximate Soft Shadows, I3D 2006](https://faculty.digipen.edu/~gherron/references/References/SurfaceDetail/Tatarchuk-POM-SI3D06.pdf); [SIGGRAPH 2006 course notes](https://www.advances.realtimerendering.com/s2006/Tatarchuk-POM.pdf)) | Real-looking 0.1–0.2 m window depth with moving reveal shadows, for about 10 ALU per pixel | **Highest value per cost.** The interior ray is already in `facadeCell` space. |
| **Full POM for relief** (rustication, brick) | Tatarchuk 2006 | Self-occluding relief | Too costly for brick at street distance; bump (`bumpNormal`) is enough. |
| **Extruded silhouette geometry:** cornices, plinths, string courses, dormers, chimneys | Split-grammar facade decomposition ([Müller et al., Procedural Modeling of Buildings, SIGGRAPH 2006](https://paperswelove.org/papers/procedural-modeling-of-buildings-d7ac8760/)) | Silhouette and contact shadow that no shader can fake | Add in `building-geometry.js` per wall edge; the cost is small next to the LoD2 roofs. |
| **Per-window random lighting schedule** | *Cities: Skylines After Dark*: the `_i` illumination map, with a random 128–255 band setting the probability and intensity of lit windows and 192 as neutral ([Colossal Order dev diary 2, 2015, archived](https://web.archive.org/web/20201108094220/https://forum.paradoxplaza.com/forum/threads/cities-skylines-after-dark-dev-diary-2-whats-new-with-modding.878916/)) | Lit share that varies with time of day and building | Use a per-cell hash against a time-of-day curve instead of a fixed `litProbability`. |
| **Glass reflection:** Fresnel plus per-pane normal jitter | Already in the shader (`fresnel`, `tsl-materials.js:951`). Old cylinder glass is "levende" (SLKS 5.4). | Broken reflections that read as old glass | Add a ±1–2° normal tilt per pane for pre-1915 windows only. |

**Not found:** an official technical source for how Microsoft Flight Simulator's default buildings or Epic's City Sample do their window interiors. Only marketplace and forum material turned up, so neither is cited.

---

## Top changes for the twin

The changes are ranked by visual impact per unit of effort. "Impact" is judged at walking and cycling eye level in the sweep views (01–23). All values marked Estimate above stay `conf: inferred`.

**1. Fix the brick scale and stop bricking rendered walls.**
- **Impact:** very high, because every wall changes. **Effort:** S.
- In `createPreWarBuildingMaterial` (`tsl-materials.js:840` and `:1020`), set `brickL` to 0.24 and `brickH` to 0.066.
- Add a per-wall `render` flag: either a fifth `facadeTone` channel, or pack it into `facadeBldg.z` beside `inferred`. Derive the flag in `appearance.py` or `building-geometry.js` from observed tone saturation.
- Rendered walls get smooth stucco, with ashlar scoring every 0.35–0.45 m only below the first-floor sill.
- Keep the existing mortar and dome fade-out, which gets more important at the smaller scale.

**2. Danish windows instead of New York sashes.**
- **Impact:** very high. **Effort:** S–M.
- In `createPreWarBuildingMaterial`, delete `hasAC` (`:791`) and its colour, normal and emissive uses.
- Move the meeting rail from 0.52 to about **0.66–0.70** of the window height (transom) and make the mullion full strength. Add a per-building `winType` (korspost, T/flag, two-sash, or funkis with no bars) from the year band.
- Widen the frame lines to 0.07–0.10 m in world units, not in UV.
- Frame colour is a per-building pick, white (about 65 %) or dark green/black/brown (about 35 %), instead of `masonryTint × 0.46`.
- Raise `windowRatioY` from 0.55 to 0.64 in `buildings-real.js:324`.

**3. Analytic window-reveal parallax with sun shadow.**
- **Impact:** high; this removes the "flat window rectangles". **Effort:** M.
- In the shared facade block, offset `winUV` by the view ray to a glass plane 0.14 m behind the wall: `uv' = uv + (dir.xy / dir.z) × d / openingSize`.
- Pixels whose `uv'` falls outside [0, 1] shade the reveal: wall tint, with a normal set to the jamb or head direction.
- Test the sun direction (`cityUniforms.uSkySunDir`) the same way to darken the glass and reveal inside the head and jamb shadow.
- Replace the painted `lintelShadow` and `jambShadow` (`:874–875`).
- Feed the same offset into `evaluateApartmentInterior`; it already has `setback = 0.12` at `:218`.

**4. Geometric cornice, plinth and gutter band at every street wall.**
- **Impact:** high, for silhouette and the skyline seen from the lakes. **Effort:** M.
- In `addBuilding` (`building-geometry.js:207`), after each outer-ring edge quad, extrude:
  - a 3-step cornice profile (projection 0.45 m, height 0.8 m) just under `top`;
  - a 0.05 m plinth skin from `bottom` to `ground` + 1.1 m.
- Mitre at ring corners. Skip hole (courtyard) edges, or use a 0.15 m cornice there.
- Emit these as wall triangles with the edge's `facadeUV` frame and a new `WALL_KIND` (trim) so the shader colours them `cTrim` or darker plinth grey.
- This also fixes wallAttr walls having no coping today (`coping` is only set in boxLocal mode, `tsl-materials.js:493–499`).

**5. Roof colour, dormers and chimneys on the LoD2 roofs.**
- **Impact:** high from above and along the lakes. **Effort:** M.
- Darken `ROOF_COLOURS` for slate, fibre-cement and tagpap to sRGB about 0.25 blue-grey. Clamp observed roof tones for slanted roofs in `roofColourFor`.
- Add a TSL roof material with tile or slate courses (0.2–0.35 m) and per-tile tone jitter.
- Instance dormers along street-facing slanted LoD2 planes at the facade's `bay_w` rhythm (one per 1–2 bays). Instance brick chimneys (0.5 × 1.0 × 1.0 m) at ridge ends and party walls.
- Add zinc half-round gutters at the eave and downpipes at plot ends (cylinders, instanced).

**6. Raised-basement ground floor, kælderhalse and gateways.**
- **Impact:** medium–high at eye level. **Effort:** M.
- In `presets.py`, add a `ground_type: "raised"` for residential `karre-1900` and `pre-1870` fronts:
  - plinth 1.1 m with low basement windows;
  - stueetage sill at 2.1 m;
  - keep `shop` only where BBR or CVR shows commercial units.
- In the shader, `isGroundFloor` (`:484`) gains a third state.
- Gateways: one arched 2.8 × 3.4 m dark opening per front whose plot has rear buildings (a hole or neighbour footprint in GeoDanmark).
- Kælderhalse: small instanced well and railing meshes in front of about 1 in 4 shop-street fronts, placed from the cycle-track or pavement band so they never block the walk-space.

**7. Danish night interiors and seasons.**
- **Impact:** medium–high at night. **Effort:** S–M.
- In `evaluateApartmentInterior`:
  - cut drape coverage from 0.29 to about 0.08 and add roller-blind tops instead;
  - fix the light at 2,400–2,900 K;
  - add a low pendant cone over a table at about 1.0 m below the ceiling.
- Lit share follows a time-of-day curve: about 0.5 at 17–22 h and about 0.1 after 01 h, driven from `lighting.js` presets next to `interiorGlow`.
- Add a `season` uniform. In December, set a star or candlestick on 30–50 % of lit sills; on 4 May, candles.

**8. Sortedam Dossering neon block.**
- **Impact:** medium overall, very high for recognisability from Dronning Louises Bro. **Effort:** S–M.
- Model the roof-mounted steel frames as a hero prop with emissive letter and outline textures: nemlig.com, IRMA, KAFFE, the clock, the Irma girl, the hen, ØKO ÆG.
- The existing bloom limiter in `post-processing.js` already keeps neon colours, and the lake reflection will pick it up.

**9. Corner signs, house numbers, shop signage and graffiti decals.**
- **Impact:** medium. **Effort:** M.
- **Street-name signs:**
  - place one blue RAL 5011 plate on each face of every street-corner building edge pair (from `roadGraph.names`), 3.4 m high, 0.25 m in from the corner;
  - reuse the furniture instancing in `street-furniture-cph.js`.
- **House numbers:** in the shader door fanlight.
- **Shop signs:** fascia letters within the shop bay, one bracket sign per shop and no foil, per KK 2024.
- **Graffiti:** a decal atlas on plinths, lot-line walls and the lake wall, below 2.5 m.

**10. Corner towers, bays and courtyard balconies.**
- **Impact:** medium, local. **Effort:** M–L.
- **Towers:** hand-place hero corner-tower caps at Dronning Louises Bro / Nørrebrogade, Sankt Hans Torv and Sortedam / Ravnsborg Tværgade, using LoD2 for height.
- **Bays:** parametric 0.7 m canted bays from a small per-building list, for example Blågårdsgade 29.
- **Courtyard balconies:** generic steel balconies on courtyard (hole) walls only, 30–60 % of bays.

## Reference images

[refs/buildings/ATTRIBUTION.md](refs/buildings/ATTRIBUTION.md) holds 12 Wikimedia Commons thumbnails (CC BY / CC BY-SA, 1280 px), each checked by eye:

- Elmegade karré;
- the Sortedam lake front by day and by night (the neon block);
- the Sortedam/Ravnsborg Tværgade corner;
- the Sankt Hans Torv corner tower;
- the Blågårdsgade corner (plinth and street signs);
- Blågårdsgade 17 windows;
- Jægersborggade shop steps;
- an opgang door (Vesterbro stand-in);
- a roofscape (location not confirmed as Nørrebro);
- Baggesensgade renewal infill;
- a white timber window close-up (not Nørrebro).

**Gaps:** no free photo was found of the Blågården estate itself, a downward kælderhals, or a carriage gateway in the district.

**URL check:** every external URL above was fetched on 26 October 2026 and returned HTTP 200 with real content. Two notes:

- The Paradox forum page is behind a bot wall, so the Web Archive copy is cited.
- An ArtStation page on *Spider-Man 2*'s window shader and the ACM DOI page returned 403 and were left out.
