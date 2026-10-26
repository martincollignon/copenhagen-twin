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

October retained-leaf fractions are chestnut 0.45 (brown), lime 0.65 (gold), plane
0.80 (ochre) and willow 0.88 (green-yellow). Deterministic spray culling removes
indices, reducing submitted triangles. Winter retains wood at near/mid distances;
the far atlas paints the same genus skeleton beneath its seasonal leaf dabs.
Conifers remain evergreen. These are genus-level phenology estimates, not surveys
of individual trees.

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
streams, tree materials use six, litter uses five, and the unchanged crown-shadow
proxy uses eight. No seasonal per-instance attributes are added.

## Verification

- `node --test tests/*.cjs tests/*.mjs`: 285 passing tests, zero failures.
- Ten new tests cover crown evidence, additions, date reuse, seasons, metric
  geometry, winter branches at every LOD, buffer limits, camera budgets and litter.
- Budget sweep: 25 camera locations in each of winter, summer and autumn; no
  trees dropped within 950 m and no draw/triangle budget exceeded.
- `node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/check-tree-shaders.mjs`:
  360 offline WGSL builds pass across all genera, colour/MRT/shadow passes and
  instance capacities of 1 and 6,000. This uses the local cached Three build.
- All 28,690 litter points were checked against mapped hard ground minus buildings,
  lakes and ponds, allowing 8 mm for rounded stored coordinates.
- The required design scan reports two existing `index.html` warnings:
  `overused-font` recommends replacing Inter with a more distinctive face;
  `single-font` recommends a display/body pairing. HTML changes only add the two
  module preloads required by the boot tests. HUD typography was not changed.

Browser screenshots and GPU performance measurements are assigned to the lead
by `SPEC.md` and were not run. The checks above establish geometry/submission
budgets and WGSL generation, not a successful Chrome WebGPU frame. Inspect the
lake avenue at October midday/golden hour and at summer/winter dates, including
LOD transitions and ground contact. Runtime tree-budget details are available at
`__twin.world.furniture.stats.trees`.
