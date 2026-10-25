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
