---
name: building-case-to-3d
description: Reconstruct a real Danish building as a metric, georeferenced 3D model from its municipal building-case drawings (Filarkiv / byggesag / Weblager PDFs — plans, sections, facades) cross-checked against Skråfoto oblique imagery, BBR, GeoDanmark footprints and DHM LiDAR. Use when the user supplies byggesag/Filarkiv PDFs or a folder of permit drawings for an address and wants a 3D model, digital twin, LoD3 building, facade model or walkable reconstruction of that building. Do not trigger for listing URLs (use listing-to-3d) or for city-scale twins without drawings.
---

# Building case to 3D

Turn one building's archived permit drawings into an actual, georeferenced 3D reconstruction: exterior shell at LoD3 (storeys, setbacks, balconies, window/door openings, roof) and, where plans support it, room-level interiors. Drawings give the geometry. Open Danish data gives the position, the as-built check and the appearance. This is an evidence reconstruction with stated uncertainty, not a measured survey. Explicit user constraints override these defaults.

## Inputs, rights and where files go

- Required: an address (or BFE / BBR building UUID) and the building-case PDFs. Copenhagen, Frederiksberg and several other municipalities gate Filarkiv behind MitID, so the user downloads them. Never try to bypass that login, scrape other people's cases, or guess download URLs.
- Building-case drawings are third-party copyrighted works and may contain personal data (names, CPR, signatures). Keep sources and derived models in a project folder outside Git. The default is `~/.local/share/building-case-3d/<address-slug>/`, never a Conductor workspace path, which gets archived. Do not commit, publish or upload them anywhere without explicit permission.
- Open data needs credentials from a `.env` (this repo's, or `~/conductor/dk-building-data/.env`): `SKRAAFOTO_STAC_TOKEN` (falls back to `GSEARCH_TOKEN`), plus `DATAFORDELER_USERNAME`/`DATAFORDELER_PASSWORD` for BBR and DHM. Strip whitespace and inline comments from env values. Send the Skråfoto token as a `token` HTTP header, never in a URL that can end up in logs or error messages. Never print a token.

## Evidence rules (non-negotiable)

These exist because a first NS37 run produced a model that looked plausible and passed every photo check, but most facade elements were invented.

1. **Every modelled element must cite where it came from.** Drawing evidence is a sheet, page and pixel box (`src: "C8EB:1#px=x0,y0,x1,y1@150dpi"`). Other allowed sources are a Skråfoto view id with the visible feature named, or an explicit user statement.
2. **Anything without a source is `conf: "inferred"`.** It must be listed in the report and switchable off in the viewer. The skill never adds generic bays, balconies or rhythms to "fill in" a facade.
3. **Superseded sheets cannot be a source for geometry.** Use them only to explain history. Among the drawings, the latest approved sheet (`ENDELIG TEGNING`, newest `RETTET`) governs. But even the final drawing is only the approved state: the reconciliation (Phase 2½) decides what stands today.
4. **Ask the user about what they know.** When they know the building (the owner, a resident), ask about entrances, which side is the street, and recent changes before modelling these. Their statements outrank inferences and are cited as such.
5. **Know what Skråfoto can and cannot resolve.** At about 10 cm/px, rectified obliques reliably show the presence, position and rhythm of large elements: balconies, loggias, canopies, roof additions, entrance recesses. They cannot size windows, doors or railings. Use them in Phase 2½ to decide *what exists today*, and use the drawings to decide *dimensions*. Never report window-level detail as "validated" from a photo overlay.
6. **A gate only covers what was traced.** Before trusting a pass, look at the whole elevation next to a model render. Every drawn zone must be classified: glazing, wall, recess or loggia (often drawn hatched or dark), railing, door, panel. Unclassified zones are a failure, not a pass.

## Phase 1 — Inventory every sheet before trusting any

Read [drawing-analysis.md](references/drawing-analysis.md).

1. Render labelled contact sheets of every page of every PDF, and record the scan resolution of each sheet:
   ```text
   uv run <skill-dir>/scripts/pdf_sheets.py inventory --out <project>/sources/sheets <pdfs...>
   ```
2. **Classify pages by looking at them, not by OCR keywords.** A keyword classifier once labelled 70 permit letters as "roof plans". Use the `drawing-archivist` subagent where available. For each drawing, read the title block from a high-resolution crop (`pdf_sheets.py titleblock`): sheet title, tegning nr., scale, date, and every `RETTET`/revision stamp.
3. Write `sheet_register.csv`. Group sheets by drawing number and select the **latest approved revision** of each. Keep a separate list of later permits (alterations, merged flats, roof conversions, courtyard works) that change the as-built state.

**Stop and ask the user for the missing files** if any of these is absent: at least one dimensioned floor plan, at least one section (or another source of storey heights), and elevations covering the street side. Courtyard elevations and a roof plan are strongly preferred; record their absence as uncertainty. Honour an explicit instruction to continue with partial sources and document what it costs.

## Phase 2 — Fetch the open-data context

Read [open-data-and-skraafoto.md](references/open-data-and-skraafoto.md).

- **Footprint.** GeoDanmark *Bygning*, matched to the address via BBR.
- **Building record.** BBR: storeys, year, built and total area, wall and roof material, use code, heritage flags.
- **Ground.** DHM terrain height at the footprint, in DVR90.
- **Roof cross-check.** LiDAR/DSM roof heights; use `twinviz`/roofer LoD2 for the footprint if it is available.
- **Imagery.** Skråfoto for every collection that covers the building (2017–2025), every direction (N/E/S/W oblique plus nadir), with full camera parameters:
  ```text
  uv run <skill-dir>/scripts/skraafoto.py fetch --lon <lon> --lat <lat> --radius 40 --out <project>/sources/skraafoto
  ```
  Keep each view's camera record exactly as delivered by STAC (`pers:*`). These are calibrated photogrammetric cameras, so unlike listing photos they need no pose guessing.

Use the `skraafoto-registrar` subagent for this phase when it can run in parallel with Phase 1.

## Phase 2½ — Reconcile drawings with the building as it stands (before any modelling)

The drawings record what was *approved*, often decades ago; the photos record what *stands*. Reconcile them per facade and per element class before writing `building.json`. Skipping this step on NS37 made the model first invent, then delete, courtyard balconies that were added after 1970.

1. Rectify every facade from each oblique that faces it, for the oldest and newest collections at least:
   ```text
   uv run <skill-dir>/scripts/facade_rectify.py --camera cameras.json#<view> --building building.json \
     --facade <storey>-<side> --z1 <top m> --res 0.04 --out analysis/reconcile/<side>_<view>.png
   ```
   This needs only a provisional envelope: footprint, storeys and facade edges. Put each rectified photo under the matching elevation, cropped to the same metres (see `references/reconciliation.md`).
2. Fill in `analysis/reconciliation.md`: one row per facade and element class (window rhythm, doors and entrances, balconies and loggias, railings, canopies, roof additions, shopfronts, cladding). The columns are:
   - final drawing (sheet, px box);
   - oldest photo;
   - newest photo;
   - later permits;
   - user statement;
   - decision (`as drawn` / `as photographed` / `ask`), with the evidence.
3. **Rules of precedence:**
   - **Presence and position of large elements:** photos win over drawings. This covers balconies, loggias, canopies, roof additions and infill. A change between collections dates the alteration; look for its building case.
   - **Dimensions of unchanged elements:** drawings win. Photos at about 10 cm/px cannot size a window.
   - **Things the user knows:** the user's statement wins.
   - **Unresolved:** an element that is in the photos but not in any drawing is modelled from the rectified photo with `conf: "observed"` and a pixel box in the rectified image. If it still can't be resolved, it is `ask`.
4. **Stop and confirm.** Show the user the side-by-side sheets and the `ask` rows, and record the answers. Only then start Phase 3.

## Phase 3 — Solve the building before modelling it

Write `reconstruction_map.md` and a normalised `building.json` (schema in [model-and-validation.md](references/model-and-validation.md)) before writing any scene code. The map must contain:

- **Metric calibration per sheet.** Use the printed scale bar and at least three independent dimension chains. State whether each chain is centre-line or face-to-face. Record the residual and the resulting metres per pixel.
- **Georeference.** Fit a similarity transform (rotation, translation, uniform scale close to 1) from at least four unchanged building corners on the plan to the GeoDanmark footprint, and report the RMS residual:
  ```text
  uv run <skill-dir>/scripts/georef.py fit --gcps <project>/analysis/gcps.csv --out <project>/analysis/plan_to_25832.json
  ```
  Scale must stay close to 1 after calibration. A large scale correction means a mis-read scale or a wrong corner pairing, not a licence to stretch.
- **Storey table.** Finished-floor levels (koter) and floor-to-floor heights from the sections. Cross-check the total height against the elevations, LiDAR roof height and BBR storey count. Datum: DVR90 via DHM terrain at the entrance, with the offset stated.
- **Envelope per storey.** Walls (thickness from plan), setbacks and terraces, balconies, stair/lift cores, roof form and parapet heights.
- **Facade grid per elevation, traced rather than estimated.** For each final elevation, use `scripts/elevation.py`:
  ```text
  uv run <skill-dir>/scripts/elevation.py grid      --pdf P --page N --roi … --step 20 --out corners.png   # read references
  uv run <skill-dir>/scripts/elevation.py calibrate --pdf P --page N --x PX:U --x PX:U --z PX:0 --z PX:Z --view-bearing B --out cal.json
  uv run <skill-dir>/scripts/elevation.py detect    --pdf P --page N --roi … --out cand.json --overlay cand.png            # glazing panes
  uv run <skill-dir>/scripts/elevation.py detect    --mode railings … --out rail.json --overlay rail.png                 # hatched railings
  uv run <skill-dir>/scripts/elevation.py detect    --mode dark …     --out dark.json --overlay dark.png                 # solid dark recesses (fails on fine stipple; then read one bay on a grid)
  uv run <skill-dir>/scripts/elevation.py to-model  --cal cal.json --candidates cand.json --building building.json --sheet "<key>" --keep … --out openings.json
  ```
  - **x references.** Use the facade's end corners on the drawing, mapped to the model's elevation-u span (`to-model` and `check` compute it from `building.json`). `--view-bearing` is the direction the viewer looks, i.e. the facade's outward normal + 180°.
  - **Scale differences between axes.** If the x/z scale differs by more than 1%, the scan has shrunk on one axis. Calibrate x from the corners and z from the documented storey pitch, and record the decision.
  - **Detector output is a proposal.** Look at every overlay and accept or reject ids yourself. Merge stacked door panels into one door.
  - **Classify the zones a detector skips.** Dark or hatched zones are usually recesses or loggias; striped zones are railings.
  - **Never place an opening on another storey's facade.** If `to-model` reports "unplaced" openings, the model geometry disagrees with the drawing there. Record it as an uncertainty; do not force it.
- **As-built reconciliation.** For every element, note whether later permits or Skråfoto show it changed (added dormers, glazed balconies, new penthouse, demolished annex). The model represents the **current** building. Keep the original design as a separate variant only if the user asks.
- **Uncertainty decisions.** Any conflict between sheets, revisions, BBR and imagery, with the chosen interpretation and the reason.

If materially different interpretations remain (footprint, number of storeys, roof form), ask one focused question before modelling.

## Phase 4 — Build

- Generate geometry from `building.json` only: one source of truth for visuals and validation.
- Deliverables:
  - `building.glb` in local ENU metres with a stated origin;
  - `building.city.json` (CityJSON LoD3 semantics: WallSurface, RoofSurface, GroundSurface, Window, Door);
  - a local three.js viewer.
- Use real openings (cut-outs, not dark rectangles), balcony slabs and railings, terrace setbacks, and the roof as drawn.
- The viewer needs:
  - orbit and inspection controls, plus a storey cut-away;
  - a **Skråfoto comparison mode** that renders the model from each delivered Skråfoto camera with a matching projection and aspect, overlaid on the photo with an opacity slider;
  - a first-person walk only if interior plans were modelled.

## Phase 5 — Validate, then deliver

Follow the validation section of [model-and-validation.md](references/model-and-validation.md). The `twin-validator` subagent should run these checks independently of the agent that built the model:

- **Numeric checks:**
  - footprint IoU vs GeoDanmark;
  - roof and eave heights vs DSM/LiDAR;
  - storey count vs BBR;
  - gross area vs BBR (as a consistency check only);
  - georeference RMS.
- **Elevation gate (mandatory, blocking):** run `elevation.py check` for every final elevation. It draws every model opening and balcony of the facing facades onto the scanned sheet.
  - Blue: traced from the drawing. Green: model element that matches a trace. Red: model element with no drawing evidence.
  - It fails on any `invented`, `missing` or `storey-inconsistent` element.
  - Also compare a full-facade render with the sheet side by side, because the gate cannot see zones nobody traced.
- **Projective checks (envelope only):** render the model's edges into every Skråfoto view with `scripts/overlay.py`, then review the silhouette, eaves and setbacks per facade. Fix the model, not the camera. Do not use these overlays to claim anything about windows, doors or balconies.
- **Interactive checks:** the viewer loads, the comparison mode works for all views, and the cut-away works. Drive these headless where possible. Agent-written three.js code has shipped page-freezing bugs that its own tests missed.

Deliver:
- the project folder;
- the run command;
- `sheet_register.csv` and `reconstruction_map.md`;
- the camera records;
- comparison sheets;
- a validation report that separates numeric, visual and interactive checks and lists the remaining differences.

Do not claim a pixel-aligned or survey-grade result. Do not publish anything.
