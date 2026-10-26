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
{"id": "…", "name": "…", "class": "residential", "pts": [...], "width": 9.0, "lanesFwd": 1, "lanesBack": 1, "oneway": false, "speedKmh": 40, "cycleTrack": "both|left|right|none",
 "carDir": "fwd|both|none", "bike": {"left": "none", "right": "fwd", "leftKind": null, "rightKind": "track", "carriageway": "both", "contraflow": false, "contraKind": null, "sidepath": null, "ban": false},
 "src": [...], "conf": "…", "conf_fields": {"lanesFwd": "inferred", "bike": "inferred"}}
```

#### Traffic direction (`carDir`, `bike`; additive, `tools/cph-geodata/bikedir.py`)

`pts` always run **with** the traffic: the compiler re-orients `oneway=-1` ways (and swaps their left/right and fwd/back), so `carDir` is `fwd` (one-way, cars follow `pts`), `both`, or `none` (paths). `back` is never emitted. Everything under `bike` is in that frame; sides are left/right of the `pts` direction (z south: right of an eastbound road is south).

- `bike.left` / `bike.right`: the direction a cycle lane or track on that side is ridden in: `fwd` (with `pts`), `back`, `both` (a two-way track, `cycleway:<side>:oneway=no`), `none` (no lane/track). Matches `cycleTrack` (`left`/`right`/`both` = which sides are not `none`). `leftKind` / `rightKind`: `track` | `lane` | `shared` (sharrows) | `sidepath` (the track is mapped as its own `highway=cycleway` way, `cycleway:<side>=separate`) | `null`.
- **Convention** when a side has no direction tag (Copenhagen is right-hand traffic): on a two-way street the right-hand track runs `fwd`, the left-hand one `back`; on a one-way street both sides run with the cars (`fwd`) unless tagged (`cycleway:left:oneway=-1`, `cycleway=opposite_lane|opposite_track`). A track known only from KK `cykelsti` gets the convention, flagged `conf_fields.bike = "inferred"`.
- `bike.carriageway`: who may ride the street itself, `fwd` | `back` | `both` | `none`: with the cars on a one-way street, both ways where there is contraflow (`oneway:bicycle=no`, `cycleway=opposite*`, an opposite lane/track, or KK `cykling_mod_ensretning = 1`), `none` where `bicycle=no` / `use_sidepath` / `dismount` bans bicycles. On `class: "cycleway"` roads it is the path's own direction (`oneway=yes|-1` -> `fwd`, else `both`).
- `bike.contraflow` (only on one-way streets) with `contraKind` `lane` | `track` | `shared` (no infrastructure, bicycles share the street); `bike.ban`; `bike.sidepath` (`left|right|both` when the street's bicycle traffic is on separately mapped cycleways).
- Sources: `src` gains `osm:bicycle-direction` and `kk:ensrettede_gader:cykling_mod_ensretning`; `conf_fields.contraflow = "observed"`. KK is the municipal record: it grants contraflow on a one-way street unless OSM says `oneway:bicycle=yes` (reported as `contraflow_kk_conflict` in `meta.road_stats`); KK one-way streets that OSM does not mark one-way (`oneway_kk_only`) stay two-way, since KK gives no direction.
- `meta.road_stats` carries the counts (`ways_contraflow`, `ways_contraflow_lane|track|shared`, `ways_two_way_track`, `ways_cycleway_two_way|oneway`, `ways_bike_ban`, `ways_sidepath_side`, `contraflow_kk_agree|granted|conflict`).

Regenerate only the roads (the rest of the file is kept as it is): `uv run tools/cph-geodata/build.py --patch-roads --out data/cph-geodata.json` (cached raw layers under `data/raw/`). Tag-parsing tests: `python3 tools/cph-geodata/test_bikedir.py`.

## Appearance (M4, `tools/cph-geodata/appearance.py`)

> v2 (`appearance/2`) adds fields and one `conf` value, documented in "Appearance v2 additions" at the end of this section. v1 consumers keep working: every v1 field is unchanged in name and meaning.

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

### Appearance v2 additions (`appearance/2`)

Sources are now BOTH Skråfoto collections (2025 and 2023, each with its own flight time, so each view has its own sun position). All new fields are additive.

Per wall entry (`observed.walls[]`, only on observed walls):

- `conf`: now `observed` | `observed+prior` | `inferred`. `observed+prior` = a shadow-sourced, low-saturation wall of a BBR `wall_material: "mursten"` building whose hue was pulled toward brick (keeps its luminance). Sunlit (confident) observations are never changed, and the prior is skipped for buildings that have a confident non-brick wall (saturated other hue or light plaster). When applied, `prior: "brick"` and `tone_observed` (the colour before the prior) are present.
- `sunlit` (bool): the chosen view(s) saw the wall in sun with usable incidence. `shadow_corrected` is now exactly `not sunlit`.
- `year`: collection year of the best chosen view (2025 or 2023); `views` ids carry the year (`east_2023_84_40_...`).
- `wb_cast`: `[r,g,b]` skylight chroma cast (luminance-normalised) that was divided out for shadow-sourced walls, else `null`. For these walls `tone` = photographed tone / cast, then a per-view measured shadow-to-lit luminance gain and a chroma scale; `tone_raw` stays the colour as photographed.
- `flags`: optional list; `year_disagree` = the sunlit 2023 and 2025 colours (or a white-balanced 2025 shadow tone and a sunlit 2023 tone) differ strongly, the wall was probably repainted; the 2025 colour is kept.
- 2023 tones are radiometrically matched to 2025 (a per-channel linear gain, about 1.5x, estimated from walls sunlit in both) before fusion.

Roof (`observed.roof`):

- `pitched` (bool) and `ridge_rise_m`: DSM ridge (95th percentile in the footprint) minus the modelled eave; `pitched` when > 1.5 m.
- `sampled_on`: `dsm_surface` for pitched roofs (footprint samples lifted onto the DSM, projected into any view incl. oblique, per-pixel sun incidence from DSM normals) or `eave_plane` (v1 behaviour, nadir preferred). `px` for pitched roofs is an estimate (samples x 225).
- `sunlit`, `year`, optional `flags` as for walls. `solar_frac` is now measured on lit pixels only.

Atlas wall entries gain `sunlit`, `year` and `wb_applied` (the strip got the same per-channel gain that maps the photographed wall median to the white-balanced `tone`). Textures use the best, sunlit if any, view of each wall.

Top-level `appearance`: `version: "appearance/2"`, `views_by_year`.

### Calibrated wall tones (`appearance-cal/1`)

`tools/cph-geodata/appearance_calibrate.py` adds, per `observed.walls[]` entry: `tone_cal` (sRGB 0-1, calibrated colour), `cal`
(`own | neighbours | global | building | none`: how a shadow-sourced wall was matched to sunlit light) and `cal_brick: true` when the brick
rule turned a pinkish BBR `mursten` wall into red-brown or yellow brick. `appearance.calibration` holds the run summary. See `data/appearance.calibration.md`.

### `data/cph-lakes.json` (`cph-lakes/1`)

Derived by `tools/cph-geodata/lakes.py` from `water` plus the parkregister "Soerne" polygons (`parkregister.161*`), which are the open
water of Sortedams/Peblinge/Sankt Joergens Soe: `lakes` (disjoint outlines, bridge strips included), `bridges` (strips closed over a
bridge deck, with `open_edges` onto the water), `ponds` (< 1500 m2) and `surface_cuts` (ground-surface polygons cut by the lakes).
The engine sinks the water 0.8 m below the ground, builds granite walls and cuts the ground plane (`js/lakes-cph.js`, `js/water-cph.js`).

## Street furniture (M4, `tools/cph-geodata/furniture.py` -> `data/cph-furniture.json`)

A separate file (`version: "cph-furniture/1"`, same frame); `data/cph-geodata.json` is untouched. Every feature has `src`, `conf` and `licence` (`CC-BY-4.0`, `unstated` for datasets without a licence statement, `ODbL` for water-edge derived items). `yaw` is the direction an object faces (model +z -> `(sin yaw, cos yaw)` in x, z).

Arrays: `trees` (`height`, `crown_radius`, `genus` family, `species`, `age`), `lamps` (Citelum mast and wire-suspended: `mount`, `pole` kbh/tube/park, `pole_h`, `light` led/sodium/metalhalide/fluorescent, `cct`, `watt`, wire `span` [x0, z0, x1, z1] from the 2018 `belysning-ledninger` lines or, `span_conf: inferred`, facade to facade across the street), `parkingBays` (`kind` par/ang/perp from `p_pladser` kerb lines and `parkering_areal` polygons), `parkMeters`, `bins`, `glassContainers`, `binStands`, `bollards` (`material`, `colour`), `benches`, `bikeRacks` (`capacity`), `busStops` (Movia equipment flags), `monuments`, `rescuePosts`, `lakeLights` (inferred CitySwan-style path lights, 15 m repeat). The engine (`js/street-furniture-cph.js`, pure mapping in `js/street-furniture-data.js`) places them at the ground height and fills the bays with parked cars at 70-85 % occupancy (seeded).

## Ground-floor venues (`data/cph-groundfloor.json`, `cph-groundfloor/1`, `tools/cph-geodata/groundfloor.py`)

`venues[]`: `{x, z, kind, name, src, conf}` in the local frame; `kind` is `food | grocery | shop | service | craft | hotel | office`. Sources: OSM
Overpass (`shop=*`, food/drink and service `amenity`, `craft`, public offices, hotels; ODbL) and the KK `bevillinger` layer (serveringsbevillinger,
with `koncept` and `night`). `js/groundfloor.js` assigns each wall a ground-floor kind (`shop` where a venue stands in or in front of a
street-facing wall, `entry` for a residential street front with a door, `rear` for courtyard walls, `lotLine` for party walls that abut a
neighbouring footprint, `blank` for outbuildings) and the facade shader reads it as `facadeBldg.y`. BBR trade use (3xx) without venue data gives an
inferred shop. The file is optional: without it only BBR trade use makes shopfronts.

## Building entrances (`data/cph-entrances.json`, `cph-entrances/1`, `tools/cph-geodata/entrances.py`)

DAR (Datafordeler) `husnummer.adgangspunkt` is the entrance point of an address; `vejpunkt` the road access point. The compiler lists the
husnumre of every street (`vejmidte`) found next to a twin building, keeps the gaeldende ones (status 3) and links each to a building by
`geoDanmarkBygning` (== the `gdk:<id>` of the geodata), else `adgangTilBygning` (== `bbr_id`), else the footprint containing the point
(BBR `opgang` records add stairwell-only husnumre). Raw responses are cached in `data/raw/dar/`.

`entrances[]`: `id` (husnummer UUID), `bid` (twin building id), `bbr`, `text` (37A), `street`, `x, z` (the adgangspunkt), `sx, sz` (snapped to the
nearest wall of the building: `ring` 0 outline, 1.. courtyard holes; `edge` index in the raw ring, `t` and `along` position on it, `wall_len`),
`d` (snap distance, m), `inside` (point lies inside the footprint), `link` (`geoDanmarkBygning|bbr|footprint|nearest`), `opgang` (also a BBR
stairwell), `acc` (DAR position accuracy class), `road` (vejpunkt), `src`, `conf`: `measured` d <= 1.5 m, `observed` <= 3 m, else `inferred`.
DAR places most adgangspunkter 2-5 m *inside* the footprint (typically at the stairwell), so `d` measures that offset, not an error; the wall is
the nearest one and the position along it is the point's own. `stairwells` is the BBR gaeldende opgang count per bygning id.

The engine (`js/entrances.js`) builds a door (opaque leaf, frame, step, small canopy) on the nearest wall at each entry with `d <= 6 m`
(husnumre within 0.9 m share one door). A building with at least one such door has its heuristic shader street door switched off
(`facadeBldg.y = kind + 0.25`); a building without entrance data keeps the heuristic door and the info panel labels it `heuristic / inferred`.
`?debug=nodoors` loads without the file (before/after shots).

## Photo facade look atlases (`data/tex-look/*.webp`, `tools/cph-geodata/facade_look.py`)

Derived from `data/tex/` (gitignored like it): RGBA WebP, same layout as the JPEG atlas (`observed.atlas.walls[].px/uv` are unchanged). RGB is the
de-lit, shadow-divided, sharpened strip normalised to the calibrated `tone_cal`; alpha is lossless: 0 unobserved texel (nearest-texel smear or flat
median fill from `appearance.py`, detected by lack of texture; strips with more than half unobserved are dropped), about 128 observed wall, up to 255
inside a detected window blob. `?tex=0` turns photo walls off, `?debug=notex` too.
