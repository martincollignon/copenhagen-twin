# `data/cph-geodata.json`: contract between the compiler (M1) and the engine (M2/M3/M4)

## Frame and units

- **Units:** metres.
- **CRS:** source EPSG:25832, vertical DVR90.
- **Local frame:** `x = E - origin[0]` (east), `z = -(N - origin[1])` (south positive, three.js-friendly), `y` up = DVR90 − origin[2].
- **Origin:** `[723900.0, 6176500.0, 6.84]`, near Nørre Søgade 37.
- **District bbox (local):** x ∈ [−750, 750], z ∈ [−750, 750].
- **Format:** polygons and polylines are flat `[x0, z0, x1, z1, …]` arrays, rounded to 0.01 m. Rings are counter-clockwise when seen from above (in x/−z), with no closing duplicate.

## Provenance

Every object carries:

- `src`: an array of strings, e.g. `"geodanmark:bygning:1064715171"`, `"bbr:byg054"`, `"osm:way/123"`, `"kk:trafiksignaler"`, `"dsm:median"`, `"default:preset:karre-1900"`;
- `conf`: one of `measured | observed | scaled | inferred`.

Field-level overrides go in `conf_fields: {field: conf}`. Nothing may be invented without `conf: "inferred"`.

## Top-level keys

```json
{
  "version": "cph-geodata/1",
  "generated": "ISO time",
  "frame": {"epsg": 25832, "vertical": "DVR90", "origin": [723900.0, 6176500.0, 6.84], "axes": "x=east, z=south, y=up", "bbox": [-750, -750, 750, 750]},
  "attribution": ["Indeholder data fra Klimadatastyrelsen …", "© OpenStreetMap contributors (ODbL)", "…"],
  "buildings": [Building],
  "roads": [Road],
  "roadGraph": {"nodes": [x0, z0, x1, z1, …], "links": [[a, b, lanesFwd, lanesBack, width, speedKmh, nameIdx, classIdx, signalA, signalB]], "names": ["NØRRE SØGADE", …], "classes": ["primary", "secondary", "residential", "service", "cycleway", "footway"]},
  "cycleTracks": [{"id": "…", "pts": [...], "width": 2.2, "side": "left|right|both|separate", "src": [...], "conf": "…"}],
  "sidewalks": [{"id": "…", "ring": [...], "src": [...], "conf": "…"}],
  "water": [{"id": "…", "name": "Peblinge Sø", "ring": [...], "level": 0.0, "src": [...], "conf": "…"}],
  "parks": [{"id": "…", "name": "…", "ring": [...], "src": [...], "conf": "…"}],
  "points": {
    "signals":   [{"x": 0, "z": 0, "kind": "junction", "src": [...], "conf": "…"}],
    "trees":     [{"x": 0, "z": 0, "height": 12, "crown": 6, "species": "Tilia", "src": [...], "conf": "…"}],
    "bikeRacks": [{"x": 0, "z": 0, "capacity": 10, "src": [...], "conf": "…"}],
    "benches":   [{"x": 0, "z": 0, "src": [...], "conf": "…"}],
    "lights":    [{"x": 0, "z": 0, "src": [...], "conf": "…"}]
  },
  "heroes": [{"building_id": "…", "glb": "relative or absolute path", "frame": "path to building.json", "src": ["building-case-to-3d"], "conf": "measured"}]
}
```

### Building

```json
{
  "id": "gdk:1064715171", "bbr_id": "77aeb690-…",
  "ring": [...], "holes": [[...]],
  "ground": 0.0, "eave": 26.0, "ridge": 26.2, "roof": "flat|pitched|mansard|unknown",
  "storeys": 8, "use": 140, "year": 1969, "wall_material": "mursten", "roof_material": "tagpap",
  "facade": {"floor_h": 2.8, "ground_floor_h": 3.6, "window_w": 1.2, "bay_w": 4.7, "ground_type": "shop|residential|blank|entrance", "tone": [0.78, 0.72, 0.64]},
  "src": [...], "conf": "…", "conf_fields": {"facade": "inferred", "eave": "measured"}
}
```

`ground` is the terrain height at the footprint in local y. `eave` and `ridge` are relative to local y (absolute in the local frame, not heights above ground).

### Road

```json
{"id": "…", "name": "…", "class": "residential", "pts": [...], "width": 9.0, "lanesFwd": 1, "lanesBack": 1, "oneway": false, "speedKmh": 40, "cycleTrack": "both|left|right|none", "src": [...], "conf": "…", "conf_fields": {"lanesFwd": "inferred"}}
```

## Appearance (M4, `tools/cph-geodata/appearance.py`)

Additive: `buildings[].observed` and a top-level `appearance` provenance object. Nothing above changes. Colours are sRGB 0-1, derived from the 2025 Skråfoto views (per-channel median in linear RGB, normalised to a reference sun incidence). Occlusion truth is a DHM DSM ray march from each sampled wall/roof point to the camera centre; the mesh z-buffer only decides which face a pixel belongs to.

```json
"observed": {
  "walls": [{
    "edge": 3, "ring": 0,
    "tone": [0.78, 0.71, 0.58], "tone_raw": [0.70, 0.64, 0.52],
    "conf": "observed",
    "views": ["east_2025_84_40_4_0049_00002380"],
    "angle_deg": 31.0, "px": 5400, "shadow_frac": 0.1, "agree": 2, "shadow_corrected": false
  }, {
    "edge": 4, "ring": "hole_0", "tone": [0.7, 0.66, 0.6], "conf": "inferred",
    "views": [], "angle_deg": null, "px": 0, "shadow_frac": null, "fallback": "building"
  }],
  "roof": {"tone": [0.3, 0.3, 0.32], "conf": "observed", "views": ["nadir_..."], "px": 9000,
           "shadow_frac": 0.0, "angle_deg": 4.0, "type_hint": "tagpap", "solar_frac": 0.0, "green_frac": 0.0},
  "atlas": {"file": "tex/gdk_1064715171.jpg", "size": [w, h],
            "walls": [{"edge": 3, "ring": 0, "len_m": 14.2, "h_m": 26.0, "texel_m": 0.1, "filled_frac": 0.2,
                       "uv": [u0, v0, u1, v1], "px": [x, y, w, h]}]}
}
```

- One `walls` entry per ring edge (`edge` = index into the ring; `ring` = `0` for the outer ring or `"hole_<k>"` for `holes[k]`), so the engine can index by `(ring, edge)`.
- `conf: "observed"` walls were seen by at least one view with enough unoccluded pixels (bottom 2.5 m excluded when the upper part has at least 25 samples). `tone` is the colour under reference lighting (shaded walls are brightened by at most 1.65x, flagged by `shadow_corrected`); `tone_raw` is the colour as photographed. `shadow_frac` is the share of sampled pixels in cast or self shadow, so the engine may choose tone (flat colour) over texture on heavily shaded walls: shadows stay baked into textures.
- `conf: "inferred"` walls were never seen. `fallback` says where the colour came from: `building` (median of the same building's observed walls), `neighbours` (median of nearby buildings) or `preset` (the `facade.tone` default).
- `views` are the chosen Skråfoto item ids (prefix `skraafotos2025_` and suffix `_100mm` removed); `agree` counts all views within 0.09 sRGB of the fused tone.
- `roof.type_hint` is one of `tagpap | slate | tile | metal | fibre-cement | copper | green | solar | other` (colour heuristics, nadir views). Roofs are modelled flat at `eave`; pitched roofs are sampled through that plane.
- `atlas` exists only with `--textures`: one JPEG per building under `data/tex/` (gitignored, referenced relative to `data/`), rectified wall strips at about 10 cm/px stacked vertically. `uv` is `[u0, v0, u1, v1]` in 0-1 (v down), `px` the same rectangle in pixels. Occluded or vegetated texels were filled from the nearest valid texel (within 0.6 m) or the wall median; `filled_frac` records how much.
- `appearance` (top level): `{version: "appearance/1", method, views, scale}`.
