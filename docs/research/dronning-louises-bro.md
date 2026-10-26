# Dronning Louises Bro — reconstruction notes

Researched 26 October 2026. Metres; Copenhagen local x east, z south, y up. This is a visual reconstruction, not a structural survey. `observed` identifies visible/source-described features; `scaled` identifies dimensions derived from the supplied GIS; `inferred` identifies modelling estimates. The historical dimensions below must not replace the twin's existing road geometry.

## Evidence and specifications

The bridge joins Nørrebrogade to Frederiksborggade, separating Peblinge Sø (southwest) and Sortedams Sø (northeast). Dahlerup and Charles Ambt's bridge dates to 1885–87. Both [Danish Wikipedia](https://da.wikipedia.org/wiki/Dronning_Louises_Bro) and [English Wikipedia](https://en.wikipedia.org/wiki/Dronning_Louises_Bro) were consulted for identity and history; neither supplies surveyed arch spans.

The [heritage case report, reproduced by Copenhagen Municipality](https://kk.sites.itera.dk/apps/kk_monuments/pdf/190_db43_1.pdf), is the primary architectural source (FBB case 3102846, listing 1997). It describes a granite causeway pierced by three arches, smooth-dressed stone, eight lamps on the parapets, four end flagpoles, and four rounded descending stone-faced ramps. Lamp shafts are fluted, with city arms at the base and spherical glass in ornamental metal cages. The end plinths carry bronze city-arm reliefs. Ramp edges have iron railings; three historic curved bench rows survive, with green timber and dark cast-iron supports. These are observed features, not inferred from a generic bridge template. The direct Kulturarv endpoint could not be retrieved; the accessible municipal copy is cited instead.

| Element | Specification / confidence |
|---|---|
| Overall length | Approximately 128 m for the supplied bridge strip, projected along its road axis (`scaled`). Extent includes solid approaches; not an independently verified historic length. |
| Width | Approximately 25 m usable historic section; current strip extrema reach about 28.5 m including edge irregularities (`scaled`). Fit masonry to the actual long water-facing edges. |
| Arch count | **3**, tightly grouped centrally (`observed`). Most of the elevation is solid causeway. |
| Clear spans | Initial reconstruction: Approximately **7.3 m each** (`inferred`, roughly ±0.8 m; 7.307 m from the supplied lamp stations). No verified dimensioned drawing found. |
| Arch rise | Target **1.6 m** above springing (`inferred`, roughly ±0.4 m); the shipped terrain fit uses **1.52 m** to preserve crown/ring clearance. Flat fallback reduces it further. |
| Piers / arch ring | **1.3 m** piers, **0.4 m** radial stone ring (`inferred`). Real voussoir joints follow the arch, not the horizontal ashlar grid. |
| Parapet | Solid dressed granite, projecting coping and base moulding; approximately **1.05 m above the bridge pavement datum** (`inferred`). No invented continuous iron fence on top. |
| Lamps | **8 total**, four per side, at the arch-group abutments and pier lines (`observed` count; positions from the Citelum furniture records). Brown shaft and green-patinated cage from 2024 photo. |
| Benches | Green slatted timber, dark arms/legs; along parapets, backs towards water. Deck positions and lengths use the supplied municipal furniture records where available; corner curved rows are approximated. |
| Access | Four rounded ramps to the lakeside paths (`observed`). The model uses quarter-turn ramp curves; endpoint elevations are fitted to terrain. Any short stair connectors are inferred; the building-entrance stair photo is not bridge evidence. |

The [municipal January 2013 evaluation](https://www.kk.dk/sites/default/files/agenda/ff6ba319-bb65-4b50-8e2c-2c6dffedaadb/2b0ae339-e56c-4c04-89fb-1aaa63abe0cf-bilag-1.pdf), pp. 12–15, confirms the 2010–12 project, additional benches, one motor lane each way, 4 m cycle tracks and 5.3 m pavements. The **25 new benches** figure refers to the whole Nørrebrogade project, not this bridge alone. The contemporaneous [Magasinet KBH account](https://www.magasinetkbh.dk/indhold/dronning-louises-bro) additionally reports 3.25 m motor lanes; the supplied street survey corroborates approximately this scale (3.21 m carriageway half-width centrally). Buses use the motor lanes: there is no evidence here for two extra full-length bus lanes.

```text
Nominal post-renovation cross-section, not to scale; widths exclude masonry:
 Peblinge side                                                    Sortedams side
 granite | pavement | cycle | motor/bus | motor/bus | cycle | pavement | granite
 parapet |   5.30   | 4.00  |   3.25    |   3.25    | 4.00  |   5.30   | parapet
         <------------------ 25.10 m nominal ------------------------->
 top +1.05 above pavement
 pavement +0.20 ─────┐                                         ┌───── +0.20
 cycle    +0.12      └──────┐                           ┌──────┘
 asphalt  +0.02            └───────────────────────────┘
                  levels are offsets from terrain deck height
```

```text
Lake-facing elevation, schematic; the three openings occupy only ~24 m:
                               four heritage lamps on EACH side
                                  o      o      o      o
                                  |      |      |      |
 coping  ================================================================
 deck    ________________________________________________________________
 ashlar  ||||||||||||||||||||||||| /---\  /---\  /---\ |||||||||||||||||||||
         |||||| solid approach ||/     \/     \/     \|| solid approach |||
 water   ~~~~~~~~~~~~~~~~~~~~~~~|     ||     ||     |~~~~~~~~~~~~~~~~~~~~~~
                                 7.3    7.3    7.3     inferred clear spans
                                 <---- piers 1.3 ---->  rise 1.52

 Water remains continuous under all three barrel vaults across the deck width.
```

## Visual and historical references

[Leif Jørgensen's 2013 overview](https://commons.wikimedia.org/wiki/File:Dronning_Louises_Bro_01.JPG), stored as `visual-refs/bridge-overview.jpg`, shows the long battered granite approaches, thin horizontal courses, stained waterline, central arches and projecting cornice. The model should preserve this long, low silhouette. The [2024 lamp photograph](https://commons.wikimedia.org/wiki/File:Gadelampe_p%C3%A5_Dronning_Louises_Bro_01.jpg), `visual-refs/bridge-lamp.jpg`, shows the brown fluted shaft, plinth, lateral crossbar, green globe ribs and finial, plus benches against solid stone. Local `bridge-corner.jpg`, `bridge-sotorvet.jpg` and `bridge-cycles.jpg` were also inspected; dates and photo licences remain in [the reference manifest](visual-refs/README.md). The cycling photograph predates the completed renovation.

The [Royal Danish Library's historic illustration index](https://img.kb.dk/iti/iti-topografisk-indeks.html) identifies Dahlerup's plan and construction illustration in *Illustreret Tidende*, 8 March 1885, p. 301; Poul Fischer's construction drawing, 8 August 1886, p. 546; and the completed bridge, 11 September 1887, p. 604. The index is accessible, but its individual scan links did not yield a usable dimensioned drawing in this research. These are archival leads, not support for invented exact spans. The National Museum catalogue also surfaced a public-domain photograph dated 1890–1907 (asset DMR-55513); the asset page did not reliably load, so it is not used to set dimensions.

## Local furniture evidence

`data/cph-furniture.json` contains eight Citelum records explicitly labelled `AMT El-gaslygte, Dr. Louises bro`, with `pole_text: Lygtepæl Dr. Louise` and 2700 K LED sources. Their local x/z coordinates are:

```text
Peblinge-facing row: (88.47,-466.49) (95.78,-461.99) (103.09,-457.42) (110.45,-452.85)
Sortedams-facing:   (102.18,-488.73) (109.59,-484.16) (116.81,-479.70) (124.07,-475.18)
```

The group centre is (106.305, −470.815). Adjacent station distances are approximately 8.5–8.7 m. The photographic relationship between lamps and piers therefore supports a ~7.2 m opening plus ~1.3 m pier, replacing the initial unsurveyed 5.5 m estimate. This constrains horizontal scale but does **not** establish surveyed clear spans. The generic `pole_h: 6` field is not taken as an accurate measurement of the ornate fixture. Municipal bench records also provide deck locations and nominal 1.8 m lengths. Generic furniture at those locations must be replaced, not drawn twice. Provenance/licences remain in the input document and repository README.

## Twin integration contract

- `data/cph-lakes.json` supplies `bridges[].ring` and `open_edges`. Repeated vertices and tiny edges need filtering before deriving an axis or dimensions. The central named road identifies the correct strip; its generated ID alone is not a geographic identity.
- `applyStreets` supplies the actual carriageway and cycle layout before construction. The central road's compiled half-width is 3.21 m, with 3.2 m cycle strips. These differ from nominal published widths; existing road/cycle/pavement meshes remain authoritative and are not duplicated by the bridge.
- `data/cph-terrain.json` supplies a deck of local y = 1.62 m; adjacent lake levels are approximately −1 m. The geometry uses the same terrain and snapped lake level as the lake renderer. The visual fallback without terrain must retain clearance rather than submerge the arches.
- The lakes already contain water beneath the bridge strip, and the ground is already cut there. Preserve both. The bridge hook suppresses only the old flat underside/fascia of the owned strip and replaces it with real open vaults, spandrels, piers and solid approaches.
- `?debug=nobridge` restores the previous flat underside and disables bridge-specific detail. Night factor controls globe emission and local light intensity.

Geometry estimates are centralized in `js/bridge-dlb-geometry.js` so a later survey can replace them without changing the renderer. Validation views and notes live in `docs/look/dlb/`.
