# Model schema, build and validation

## `building.json`: the single source of truth

Coordinates are metres in a local frame. Use the origin in EPSG:25832 / DVR90 stored in `frame`, with x = east, y = north, z = up. Every element carries `src`, a list of evidence IDs (sheet register keys, Skråfoto view IDs, BBR fields), and `conf`, one of `measured`, `scaled` or `inferred`.

```json
{
  "frame": {"epsg": 25832, "vertical": "DVR90", "origin": [724123.40, 6176021.80, 4.10],
            "plan_to_frame": "analysis/plan_to_25832.json"},
  "building": {"address": "...", "bbr_uuid": "...", "bfe": "...", "year": 1966,
               "variant": "as-built-2025"},
  "storeys": [
    {"id": "K2", "ffl": -6.20, "height": 2.30, "clear": 2.10, "src": ["A19F:43"], "conf": "measured"},
    {"id": "ST", "ffl": 0.00, "height": 3.60, "src": ["A19F:43"], "conf": "measured"},
    {"id": "1",  "ffl": 3.60, "height": 2.80, "src": ["A19F:43"], "conf": "measured"}
  ],
  "volumes": [
    {"id": "main", "storeys": ["ST", "1", "2", "3", "4", "5"],
     "outline": [[0, 0], [47.55, 0], [47.55, 11.2], [0, 11.2]],
     "wall_thickness": 0.26, "src": ["A19F:1"], "conf": "measured"},
    {"id": "setback6", "storeys": ["6"], "outline": [[0, 0], [47.55, 0], [47.55, 9.4], [0, 9.4]], "...": "..."}
  ],
  "roofs": [{"volume": "setback7", "type": "flat", "top": 23.1, "parapet": 0.4, "src": ["A19F:43"], "conf": "measured"}],
  "facades": [
    {"id": "street", "volume": "main", "edge": [0, 1], "normal_bearing_deg": 197,
     "bays": [{"x0": 0.00, "x1": 4.45}],
     "openings": [{"storey": "2", "x": 1.10, "w": 2.40, "sill": 0.90, "h": 1.30,
                   "kind": "window", "src": ["A19F:25"], "conf": "scaled"}],
     "balconies": [{"storey": "2", "x0": 0.26, "x1": 4.19, "depth": 1.25, "rail_h": 1.0}],
     "material": {"drawn": "...", "observed": "...", "src": ["skraafoto:2025:south:..."]}}
  ],
  "interiors": {"modelled": false},
  "changes": [{"what": "flats 2.3+2.4 merged", "year": 1995, "affects_envelope": false, "src": ["..."]}]
}
```

Keep the plan-to-frame transform and its residuals beside the model. The numbers above are illustrative only; derive everything from the actual building.

## Build

- Generate everything from `building.json` with one script: `build.py` (or `.mjs`) → `building.glb` + `building.city.json` + `viewer/`.
- Real openings: subtract opening boxes from wall solids, or build the walls as frames around the openings. Never paint dark rectangles on solid walls.
- Use per-element glTF node names that the CityJSON semantics share (`WallSurface/street/2/opening-07`). Validation output can then point at exactly which element is wrong.
- Materials:
  - Use flat PBR colours sampled from the matching Skråfoto view in shadow-free areas, with brightness noted.
  - Optionally use texture tiles from CC0 libraries.
  - Do not bake Skråfoto pixels into textures unless the user asks. Skråfoto is open data, but baked shadows, cars and scaffolding make a poor texture, and the procedural model should stay clean.
- Viewer requirements:
  - Run locally on a free port, bound to 127.0.0.1.
  - Orbit/inspect controls.
  - Storey cut-away.
  - Per-element info on hover (src/conf).
  - Skråfoto comparison: pick a view, set the camera from `cameras.json`, show the photo crop behind the model at matching aspect and crop, with an opacity slider and an edge-only toggle.

## Validation

### Numeric (write to `validation/metrics.json`)

| Check | How | Expectation |
|---|---|---|
| Georeference RMS | `georef.py fit` residuals | ≤ 0.3 m (explain anything more) |
| Footprint IoU | model eave-level outline vs GeoDanmark *Bygning* | ≥ 0.90. Lower values need the explanation written down: overhangs, balconies counted in the footprint, alterations. |
| Heights | model eave/top per facade vs DSM samples just inside the roof edge | within ±0.3 m |
| Storeys | above-ground storeys vs BBR `byg054` | equal, or the difference explained (attic/basement conventions) |
| Area | sum of storey outlines vs BBR total area | consistency only (±10%). Never distort dimensioned geometry to hit it. |
| Calibration | per-sheet scale-bar vs dimension-chain agreement | ≤ 1% |

### Elevation gate (the core check for facade detail)

For every final elevation, run:

```text
uv run <skill-dir>/scripts/elevation.py check --cal analysis/elev/<sheet>_cal.json --building building.json \
  --traced analysis/elev/<sheet>_traced.json --out validation/elev_<sheet>.png
```

- **It fails on:**
  - `invented`: a model element with no traced drawing element at IoU ≥ 0.4.
  - `missing`: a traced element absent from the model.
  - `storey-inconsistent`: an element whose storey differs from its facade's volume, so it would build at the wrong height.
- **It cannot see zones nobody traced.** Put a full-facade render next to the sheet, and confirm every hatched or dark zone (recess, loggia, dark glazing) and every striped zone (railing) is classified.
- **Make reconciliation decisions explicit.**
  - Elements decided `as photographed` carry `conf: "observed"` with photo/user sources. The gate reports them as `reconciled_photo_sourced` (orange) instead of invented.
  - Traced drawing elements removed by a decision are passed with `--removed <traced ids>` and reported as `reconciled_removed`.
  - Neither category may be empty of evidence. Each must point to a row in `analysis/reconciliation.md`.
- **Report missing as missing.** If the model geometry has no wall where the drawing shows openings, report the disagreement; never move openings to another storey.

### Projective (envelope only)

For every selected Skråfoto view:

```text
uv run <skill-dir>/scripts/overlay.py --camera cameras.json#<view-id> \
  --image sources/skraafoto/<view-id>.jpg --model building.glb --frame building.json \
  --out validation/overlay_<view-id>.png
```

- Review the building silhouette, eave line, setbacks and storey lines per facade. At about 10 cm/px Skråfoto cannot validate windows, doors or railings; that is the elevation gate's job.
- Write a short per-view verdict: aligned, offset (with direction and an estimate in pixels and metres at GSD) or wrong (which element).
- A systematic offset across all views suggests georeference or datum error. Fix the frame, not the cameras.
- A single-facade mismatch means a model or interpretation error. Fix `building.json` and rebuild.

### Interactive

Drive the viewer headless (Playwright or CDP):

- it loads with no console errors;
- every comparison view renders;
- the cut-away steps through all storeys;
- per-element info shows.

Save screenshots in `validation/`. Agent-written three.js code has shipped infinite loops and stale-projection bugs that unit tests missed, so do not skip this.

### Report

`validation/REPORT.md` has three separate sections:

1. what was measured numerically;
2. what was reviewed visually, listing every view;
3. what was exercised interactively.

Then list the remaining differences and the uncertainty decisions. Do not call an approximate overlay "pixel aligned", and do not describe a drawing-based model as a survey.
