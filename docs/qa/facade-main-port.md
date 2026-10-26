# Danish facade details on main's photo walls

Implemented in place on 26 October 2026. Main's photo facades, calibrated wall tones, material/era classification, venue-based ground floors, photo residency and crossfade remain the base. No commits, resets or branch operations were performed.

## Changes

- `js/facade-style.js`: deterministic building-wide window paint (65% white, otherwise dark green/black/brown), 7–10 cm frames, 10–18 cm reveals and period divisions. Main's material/era code remains intact.
- `js/tsl-materials.js`: Copenhagen AC paths are excluded from colour, normal and emission output. Historic windows use a transom at 68% of opening height and full-strength mullions; T-windows, subdivided lights and later plain casements follow the period choice. Analytic view rays hit glass or masonry reveals, with reveal normals and sun-direction shadows. Colour, roughness and emission share the same glazing mask. Main's Fresnel sky reflection remains.
- `js/facade-photo-material.js`: photographed frames and openings retain their image. Two existing mask lookups now follow view/sun directions with a 14 cm metric setback instead of fixed top/left texel offsets. Existing PBR glass reflections, de-lit albedo mapping and LOD opacity remain. Photo windows receive warm emission without invented window bars.
- Interior occupancy follows the existing `uInteriorGlow` presets: 12% midday, 50% golden hour/twilight, 10% midnight. Bulbs use approximate 2400–2900 K colours; procedural drapes are sparse. `night-lights-cph.js` controls street-lamp photometry, so it and the global lighting system were left unchanged. The photo atlas has no per-window IDs: photo occupancy is coherent per storey, while procedural occupancy is per room. These populations are not guaranteed to align during the existing photo crossfade.
- `js/building-details.js`, `js/building-geometry.js`, `js/buildings-real.js`: capped cornice, plinth and gutter solids, plus pre-1940 chimneys on shared measured LoD2 ridge edges. Trim follows main's historic/mid era policy, with no details on sheds, blank outbuildings, modern or glazed buildings. Main's street classification selects up to four long public outer edges; party and courtyard walls receive no new trim. Plinths have gaps at main's inferred entrance bays and stop below shop glazing. Photo doorway locations remain inferred because the atlas does not supply doorway IDs.
- All details append directly to the existing roof buffers/material and picking ranges, introducing no new meshes or draw calls. Picking identifies their style as inferred. A packed flag suppresses the painted cornice only where an actual cornice was emitted. The new window attribute carries that flag alongside the division type, keeping Copenhagen walls within eight vertex buffers.
- Roof correction is limited to genuinely pitched slate/fibre-cement/tagpap surfaces, with observed hue preserved and sRGB luminance capped at 0.26. Fibre-cement fallback colours are darker. Flat observed decks, tile colours, metals and main's roughness/metalness remain intact; source observations are not changed.
- `index.html` preloads the new geometry module. The patch's geometry/style tests were adapted to main's buffers and classification APIs. New command-line tools audit the dataset and generate the facade shaders without a browser.

## Verification

- `node --test tests/*.cjs tests/*.mjs`: **269 passed, 0 failed** — all 253 existing tests plus 16 additions. Existing test files were not changed.
- `node tools/check-facade-shaders.mjs /tmp/dlb-three`: seven configurations generate WGSL successfully with locally cached Three.js **187dev**: Copenhagen masonry, legacy box/world masonry, curtain walls, masked photo walls, JPEG fallback and batched roofs. The harness also checks the Copenhagen vertex-attribute limit. This checks node-graph generation, not GPU execution or the current CDN build.
- `node tools/audit-facade-details.mjs`: all 2,517 source buildings, including 2,114 LoD2 records, audited with main's roads and ground-floor venues. All 6,531 new solids pass closure, directed edge incidence, nondegeneracy, normal/winding and positive-volume checks.

| Detail | Added triangles |
| --- | ---: |
| Cornice | 22,452 |
| Plinth | 31,064 |
| Gutter | 22,524 |
| Chimney | 9,636 |
| **Total geometry** | **85,676** |

Counting every added triangle in the main colour pass, both sun shadow cascades and the lake reflection gives **342,704 rendered triangles**, or **5.71%** of SPEC.md's 6.0M baseline, below the **8% / 480,000** allowance. `water-cph.js` disables shadow-map updates in the reflection pass. This is a conservative geometry estimate, including source buildings normally replaced by heroes; actual visible triangles, draw calls and FPS were not measured.

## Deliberately not ported

- The old branch's brick module, render classifier, wall albedo changes, shop classification and replacement roof material: main already implements these and takes precedence. Existing look/appearance tests cover those contracts.
- Procedural frame paint/divisions on photographic walls: those would fight the source image. Photo glass is controlled only by its existing alpha/window and dark-pane masks.
- The old independent road-edge selector, separate detail stream/merge machinery and year-only cornice rule: replaced by main's ground-floor/era logic and direct roof batching.
- The old blanket roof recolouring and tile/slate shader courses: keep main's roof surface model and apply only the requested dark pitched-roof correction.
- Dormers, seasonal decorations, signage, new lamps and other research proposals outside the six SPEC.md objectives.

The supplied photographs, street captures and old aerial roof capture were reviewed. No headless browser was run, as required by SPEC.md. Rendered checks still need to assess reveal appearance, inferred trim/door alignment, photo/procedural transitions, roof darkness and night occupancy.

## Design scan

The required scan of `index.html` reports two pre-existing typography findings:

- **overused-font — Inter:** scanner suggests a more distinctive primary face.
- **single-font — Inter only:** scanner suggests distinct display and body faces for hierarchy.

These were left unchanged because the HTML edit only adds a module preload. The scan wrapper has no rules for the edited plain JavaScript files.
