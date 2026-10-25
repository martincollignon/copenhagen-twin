# Reading Danish building-case drawings

## What a building case contains

A Filarkiv/byggesag export is a set of scanned PDFs, typically 40–70 pages each. Drawing sheets are mixed with permits (*byggetilladelse*), correspondence, handwritten case-journal pages, *bygningsattest* and inspection records. Expect:

- **Several copies and revisions of the same drawing.** The same tegning nr. can appear in several PDFs at different revisions, sometimes marked `RETTET d. <date>`.
- **Engineering and installations sheets** (*kloak*, *ventilation*, *varme*, *dræn*, *konstruktion*). These are useful for basements and shafts and irrelevant to the envelope.
- **Neighbour context drawn in.** Gables of neighbouring buildings (*gavl af nabohus*) and *matr.* boundaries.
- **Later cases** that change the building: *altaninddækning*, *tagboliger*, *sammenlægning af lejligheder*, *facadeændring*.

Scans are usually 300 ppi JPEG inside the PDF. Check with `pdfimages -list` or `pdf_sheets.py inventory`, which reports ppi. At 1:100, 300 ppi is about 8.5 mm of building per pixel. Treat ±2 px (about ±2 cm) as the reading floor, not the accuracy of the drawing itself.

## Vocabulary

| Danish | Meaning |
|---|---|
| Plan af 2. sal / Stueplan / Kælderplan / Tagplan | 2nd-floor / ground-floor / basement / roof plan |
| st. (stueetage), 1. sal … 7. sal, tagetage | ground floor, upper storeys, attic storey |
| Tværsnit / Længdesnit / Snit A-A | cross section / long section / section A-A |
| Facade mod (Nørre Søgade) / Facade mod gård / Gavl | street elevation / courtyard elevation / gable |
| Situationsplan / Beliggenhedsplan | site plan |
| Mål 1:100 / 1:50 / 1:20 | scale |
| kote, O.T. (over terræn), N.N./DNN/DVR90 | level; height above ground; vertical datum |
| Tegn. nr. / Sag / Rettet d. | drawing number / job number / revised on |
| Altan, terrasse, karnap, kvist, brandkam, elevatortårn | balcony, terrace, bay window, dormer, fire wall, lift tower |
| murværk, beton, letbeton, puds, skifer, tagpap, tegl | brick masonry, concrete, lightweight concrete, render, slate, roofing felt, tile |

## Building the sheet register

Use one row per *drawing*, with every page where it appears:

```text
drawing_key, sheet_title, drawing_no, job_no, scale, date, revisions, pages[file:page], selected_page, storeys_covered, notes
```

Rules:

- Select the latest *approved* revision. The approval stamp (e.g. *Godkendt af Stadsingeniørens Direktorat / Bygningsinspektoratet*) and the dated `RETTET` stamps decide which that is, not page order.
- In Copenhagen cases of the 1960s–70s the authoritative copy carries Stadsbygmesterens **"ENDELIG TEGNING"** stamp. It can be years later than the first approval (NS37: 1963 → 16.1.1970). A crossed-out approval stamp marks a rejected sheet; exclude it.
- When two revisions disagree, check both against Skråfoto before choosing. The building may have been built to the earlier one.
- Typical-floor plans often cover a range ("2. sal – 5. sal"). Record that range explicitly instead of assuming every storey is identical.
- A permit text without drawings still counts as evidence: it may describe an alteration with no drawing in the set.

## Calibration

1. Read the scale bar: pick two ticks far apart and measure their pixel distance at full resolution.
2. Read at least three independent dimension chains (overall length, a bay, a wall-to-wall span) and compare each with its scaled pixel length.
   - Danish chains are in cm.
   - Decide whether each figure runs to centre-lines or to faces. Wall thickness figures (e.g. 23, 26, 35) sit between bay figures.
3. Accept the sheet if scale-bar and chain calibrations agree within about 1%. Otherwise suspect paper shrinkage or skew.
   - For shrinkage, fit separate x and y scales.
   - For skew, fit an affine transform.
   - Record which one you used.
4. Never calibrate from the printed nominal scale alone. Photocopies and scans are rarely exactly 1:100.

## Georeferencing a plan

- Ground-control points: outer corners of the building and of stable neighbours' gables that also appear in the GeoDanmark footprint. Use at least four, spread around the footprint.
- Fit a similarity transform to EPSG:25832.
- Expected residual: about 0.1–0.3 m RMS. If a single corner has a residual above 0.5 m, it has probably been altered or mismatched; drop it and say so.
- Register every other plan to the first registered plan via shared cores (stairs, lifts, columns), not independently to the footprint.
- GeoDanmark *Bygning* is the roof outline at eave level as seen from the air. It may include balconies or overhangs that the ground-floor plan does not, so match the storey whose outline the footprint actually represents.

## Storey table

Take the section's dimension figures: floor-to-floor heights, clear heights (e.g. `280`, `210` in a door opening) and the eave or top height (`20,5 M O.T.`).

| Column | Notes |
|---|---|
| storey | |
| finished floor level (relative) | |
| floor-to-floor | |
| clear height | |
| slab thickness | when drawn |
| source page | |

Convert levels to DVR90 through the DHM terrain height at the main entrance. Floors drawn as "O.T." are relative to terrain at the facade. Note the terrain slope along the facade.

Sum the floor-to-floor heights and compare with the elevation's total height and the LiDAR roof height. A difference above about 0.3 m needs an explanation (parapets, roof build-up, terrain datum) before modelling.

## Facade grid

For each elevation:

- Bay axes, from the plan dimension chains: they must agree with the plan.
- Per storey: sill and head heights, opening widths, balcony slab and railing heights, and terrace setbacks.
- Materials and colours as drawn, with hatching and any notes.

Elevations are drawn as orthographic projections of the plane at the facade line, so receding setbacks appear at their true height but their depth is hidden; recover the depth from the section or plan.

Cross-check bay count, storey count and balcony pattern against the Skråfoto oblique facing that facade before trusting it.

## Lessons from Nørre Søgade 37 (1963–66, the first test case)

- 8 PDFs held about 300 pages, of which about 60 were drawings. The best set was spread across three PDFs.
- The typical plan (2.–5. sal) had a full chain: 445 cm bays and 26 cm walls. The section gave a 3.60 m ground floor, 2.80 m upper floors, two parking basements with 2.10 m clear height, and stepped terraces on the 6th and 7th floors following the daylight angle.
- A keyword classifier over the PDF text layer mislabelled most pages. Classify visually. The visual pass found 298 pages: 173 journal/correspondence, 65 plans (including drainage-marked copies), 16 elevations, 1 section.
- No 7th-floor or roof plan existed. The top setback storey and the lift tower had to come from the section plus the elevations, which is enough for the envelope but not for that storey's interior.
- **Entrances got this wrong twice.** The model first drew doors as glazing identical to windows, so no entrance could be seen. Then it took shop doors from the 1963 ground plan, but the final 1970 street elevation shows a continuous shopfront, and the owner confirmed there is no street access. All entrances are on the courtyard. The final courtyard elevation (60B) shows flush, recessed doors, not the projecting *luftsluse* vestibules of the 1963 plan, which a later pass also invented. Rules:
  - Take the position and existence of doors from the latest approved elevation, not from an earlier plan.
  - Model doors as opaque leaves that read differently from glazing.
  - Make the two sides visibly different where the building is.
  - Ask the user where the entrances are when they know the building.
- Final street and courtyard elevations were in a different PDF (C8EB) from the earlier 1963/66 copies (A19F). Always search all PDFs for every drawing number.
- Later cases (a 1983 courtyard/parking permit and a 1995 merger of flats) changed the as-built state without new envelope drawings. Check permit texts too.

- **The first facades were invented, and every photo check still passed.**
  - The street and courtyard facades had generic bay grids: balconies on the courtyard (60B shows none), projecting vestibules (60B shows flush recessed doors), and a row of roof-floor windows that no sheet shows.
  - Skråfoto overlays could not see any of this.
  - Tracing 59 and 60B with `elevation.py` replaced 255 model elements. 183 of the 195 street elements had no drawing evidence.
- **One scan was off scale on one axis only.** The courtyard elevation 60B was 2.1% off horizontally and correct vertically (floor pitch reads exactly 2.80 m). x was calibrated from the face corners and z from the floor pitch.
- **Detection gaps on NS37.** The pane detector finds light glazing. Hatched railings needed the texture mode (high recall only at the 85th percentile; lower thresholds pick up columns). Dark hatched loggias were not detected at all and need explicit classification.
