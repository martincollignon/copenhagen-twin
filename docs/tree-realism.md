# Tree sizes and autumn on main’s species models

Implemented against the current furniture data and main’s `tree-geometry-cph.js`
models. The old renderer in `.trees-v1.patch` was not ported.

## Regenerated data

`tools/cph-geodata/tree_canopy.py` reads the shared CIR, class-5 rasters and LAZ
files without modifying them. Its derived height cache defaults to
`.context/tree-heights.npz`. Run with `python3 tools/cph-geodata/tree_canopy.py`
in an environment with the dependencies listed in the script, or with `uv run`.

| Result | Value |
|---|---:|
| Original trees | 4,905 |
| Added observed canopy patches | 644 |
| Total trees | 5,549 |
| Existing crown-radius median, before → after | 3.50 → 4.38 m |
| LiDAR footprint-share median | 4.79 m |
| Measured / scaled / unchanged existing crowns | 2,118 / 2,589 / 198 |
| Added trees with measured / inferred height | 528 / 116 |
| Existing unspecified lakeside trees defaulted to chestnut | 422 |
| Chestnut/lime trees with hard-ground litter points | 468 |
| Mapped litter points | 28,690 |

The lake/default and litter counts are one below the earlier patch because this
port also excludes mapped ponds from those classifications. Registered genera
and measured heights remain intact. All non-tree furniture arrays and counts
were compared with this branch’s input and are unchanged. Two consecutive runs
produce byte-identical JSON. The schema additions are in
[cph-geodata-schema.md](cph-geodata-schema.md).

The data tool's inferred chestnut labels are placeholders. Rendering now keeps
main's existing 46% chestnut / 42% lime / 6% plane / 6% maple mix for untyped lake
crowns. Recorded genera and identifiable species names take precedence. This
corrects the uniform chestnut row seen in the lead's first browser captures;
the inferred mix is a modelling assumption, not a species survey.
Across the 730 records explicitly marked lakeside, the resolved population now
includes 353 chestnuts, 207 limes, 64 maples, 20 planes and 42 willows. At 26 October,
their individual chestnut retention targets span 30.9–59.7%, and lime 60.9–79.7%.

## Rendering

Near and mid geometry now fits the specified crown radius and height, including
leaf-card edges. Placement and rendering share independent height/radius bounds;
the old ratio clamp no longer shrinks low, broad measured crowns. Explicit
facade-clearance trimming still applies. The complete summer envelope determines scale, so shedding
leaves does not resize the wood. Main’s branch architecture and leaf atlas remain.

The lighting system’s already-parsed `currentSunDateTime` passes through world
creation to the trees. The season helper uses the existing Copenhagen calendar
validator; there is no second query parser. `?date=YYYY-MM-DD` controls leaves and
lighting together. The default remains 26 October 2026. Seasons are built at load;
reload with a different date to change them.

Each tree has a stable date advance/delay within a 7–12 day range, keyed to its
position. At the default date, chestnuts target 30–60% retained leaves (45% at the
central date), and limes 60–80% (65% centrally). Plane and willow central retention
remains 80% and 88%. Shared meshes remove indices beyond the maximum retention
needed by the date window; each instance alpha-tests the remaining sprays against
its own density. Bare trees retain the wood geometry. Litter and crown-shadow
density follow the same individual season.

Colour progresses through green, yellow-green, gold, rusty brown and dull brown.
The central-date sRGB targets are chestnut (120, 80, 40), lime (200, 170, 60),
plane (170, 140, 70), willow (90, 110, 50) and poplar (113, 132, 49). Willow and
poplar colour later. The leaf atlas stores shading in red and per-blade colour
progression in green, sampled without sRGB decoding. Palette colours are decoded
once before upload, with no red-channel tint multiplier. Leaf transmission is
reduced to preserve dark brown/olive shading. Conifers remain evergreen.

Sprays have shallow folded corners and darker, later-coloured leaf rims, without
extra triangles. Relative to the reviewed result, measured median near-card edges
shrank 30.2% for chestnut, 31.1% for lime and 29.7% for plane; mid-card reductions
are 27.5%, 29.6% and 28.7%. Card counts remain unchanged. Complete summer crown
dimensions still match the mapped radius and height.

The far atlas includes five date variants per genus, selected per instance in the
same draw. Each keeps its branch skeleton and varies leaf colour/density, with
smaller dabs to leave gaps. The atlas is now 640 × 2,880 pixels, approximately
9.4 MiB including mipmaps. These remain phenology estimates, not measurements of
individual trees.

The original LOD distances remain 34 / 200 / 950 m. Each camera rebuild computes
the original trees’ draw/triangle budget from their preserved genera and main’s
full geometry counts. Allocation reserves the distant treeline, then upgrades
nearby trees while staying inside that budget. A tree may use a cheaper LOD when
the cap is reached. Shadow proxies never exceed the original nearby-tree count,
shrink with leaf density, and disappear for bare deciduous trees.

Litter uses at most 1,500 instanced quads within 40 m. It keeps the mapped ground
origin if placement moves a trunk and samples ground height at each leaf patch.
It only draws if both a draw slot and triangles remain; it stays off in summer
and during shader warm-up. There is no guaranteed litter in a view that uses the
full tree budget.

Vertex attributes share one interleaved buffer. Counting `instanceMatrix` as four
streams, tree materials use seven: the packed vertex buffer, four matrix streams,
and two seasonal vec4 instance attributes replacing `instanceColor`. Litter uses
five; the unchanged crown-shadow proxy uses eight.

## Verification

- `node --test tests/*.cjs tests/*.mjs`: 288 passing tests, zero failures.
- Thirteen tree-realism tests cover crown evidence, additions, date reuse,
  individual phenology and colour, seasonal shedding, smaller folded cards,
  metric geometry, winter branches, buffer limits, camera budgets and litter.
  The species tests also protect the mixed inferred lake avenues.
- Budget sweep: 25 camera locations in each of winter, summer and autumn; no
  trees dropped within 950 m and no draw/triangle budget exceeded.
- `node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/check-tree-shaders.mjs`:
  360 offline WGSL builds pass across all genera, colour/MRT/shadow passes and
  instance capacities of 1 and 6,000. Shadow overrides use the source material's
  alpha mask and wind nodes, and assertions check seasonal attributes and alpha
  discard in the generated shaders. This uses the local cached Three build.
- All 28,690 litter points were checked against mapped hard ground minus buildings,
  lakes and ponds, allowing 8 mm for rounded stored coordinates.
- The required design scan reports two existing `index.html` warnings:
  `overused-font` recommends replacing Inter with a more distinctive face;
  `single-font` recommends a display/body pairing. HTML changes only add the two
  module preloads required by the boot tests. HUD typography was not changed.
  The corrective pass changes JavaScript only; its required scan emitted no
  findings (the scanner does not inspect `.js` files).

The lead supplied the initial October browser captures and requested this colour,
density and card-size correction. Updated browser screenshots and GPU performance
measurements remain assigned to the lead by `SPEC.md`. The checks above establish geometry/submission
budgets and WGSL generation, not a successful Chrome WebGPU frame. Inspect the
lake avenue at October midday/golden hour and at summer/winter dates, including
LOD transitions and ground contact. Runtime tree-budget details are available at
`__twin.world.furniture.stats.trees`.
