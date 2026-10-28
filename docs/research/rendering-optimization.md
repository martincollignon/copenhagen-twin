# Rendering measurements, 26 October 2026

The changes retain the city geometry, facade LOD policy, materials, reflection settings, antialiasing, and 3072-pixel shadow cascades. They reduce rendering overhead in two places:

- Static building cells share three material batches. Each cell still has its own frustum and streaming visibility, and picking ranges retain their building and roof-detail identity. Source geometry is released after packing, before GPU upload.
- WebGPU sun cascades allocate their original depth texture without the unused colour texture. Removing the 6144 × 3072 RGBA8 attachment saves 72 MiB. WebGL retains the upstream sun-light implementation.

The renderer is pinned to Three.js build `6828c9b2559167925fa90c6c84dfc1a657b38d2c`, matching the WebGPU build previously served by the moving `@dev` URL.

## Comparison

Two interleaved baseline/candidate pairs ran in headless Chromium on the same M3 Max at 1440 × 900, pixel ratio 1, with vsync disabled. Both snapshots used the same renderer commit and city assets. Texture residency was allowed to settle before each window. Concurrent GoBoat edits were excluded from both snapshots.

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Lake-view texture allocation estimate, including MSAA backing | 373.75 MiB | 301.78 MiB |
| Lake-view median frame time, paired runs | 15.6 / 16.4 ms | 13.3 / 14.7 ms |
| Lake-view p95 frame time, paired runs | 33.4 / 33.9 ms | 14.9 / 16.6 ms |
| Aerial median frame time, paired runs | 16.4 / 20.9 ms | 15.6 / 20.3 ms |
| Street median frame time, paired runs | 14.2 / 15.3 ms | 12.9 / 15.6 ms |

Texture estimates were calculated from live WebGPU texture descriptors, dimensions, formats, mip counts and sample counts. They are allocation estimates, not measurements of physical GPU memory. Three's own `renderer.info.memory.texturesSize` omits separate multisampled colour backing textures in this build.

Timing remains sensitive to other work on this machine. The lake-view improvement repeated; aerial and street results do not establish reliable 60 FPS across the scene. These two pairs are diagnostic measurements, not a statistical performance guarantee.

## Verification

- All 354 Node tests passed on the isolated candidate snapshot.
- All 108 building-picking probes matched the baseline in each comparison pair, including surface classification.
- Both candidate comparison runs completed without JavaScript or GPU validation errors. The WebGL fallback also booted and rendered without console errors.
- `uv run --with playwright python tools/shoot-m2.py --perf` completed its four views and 14-point live memory route. Peak facade reservation was 50,329,968 bytes against the unchanged 50,331,648-byte budget, with the facade manager enabled throughout.
- `--perf` now fails on captured page/rendering errors and disabled facade loading. Its error classifier rejected the captured invalid-pipeline experiment, including errors that did not appear as JavaScript page exceptions.

The required `texture-memory-budget` check also runs the building-batch picking/visibility, sun-depth preservation, lighting and module-loading tests. Real GPU timing remains a local measurement.

## Full-city frame budget, 27 October 2026

The live demo's main loop, facade-photo material and streaming defaults matched commit `a58e9d3` when checked. The district-only benchmark hid much of the full city's cost: the default starting camera kept about 99 detailed tiles resident and submitted about 2,800 draws per frame. Lowering resolution alone did not fix that CPU workload.

This pass changes four things:

- Road and pavement meshes compute bounds and use frustum culling, including in reflections. Previously every resident road tile was submitted regardless of the camera direction.
- The mid ring ends at 1.25 km instead of 2.5 km. The full 750 m near ring remains, and the existing far layer supplies the skyline out to 9 km. Detailed distant roofs become simpler silhouettes sooner; `?stream=750&streammid=2500` restores the previous radius.
- Rigid sibling parts of the cargo bike, its helmet and the GoBoats share meshes. Pedals and steering linkage stay independently animated; transparent parts, custom shader nodes and incompatible render states are excluded.
- Facade-photo luminance, brick and floor-layout values are uniforms. Embedding them as constants generated different WGSL for each arriving building and caused long synchronous rendering stalls while driving. Three representative buildings generated three distinct programs before this change and one identical program after it. Masked and raw photos retain their separate variants.

### Measurements

Headless Chromium with the WebGPU backend on an M3 Max MacBook Pro (36 GB), 1920×1080, pixel ratio 1, vsync disabled. Both runs used the same packed city data, golden-hour preset, cameras and 8-second measurement windows after settling tiles and photo loads. The candidate ran first, followed by the committed baseline through the same local server. Other applications and random traffic affect absolute timing; these are diagnostic measurements, not a frame-rate guarantee for every browser or location.

| View | Live-code baseline FPS | Candidate FPS | Baseline p95 ms | Candidate p95 ms | Baseline / candidate draws |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starting street | 27.1 | 35.7 | 51.8 | 34.5 | 2,788 / 1,987 |
| Cargo bike | 26.5 | 37.7 | 51.4 | 29.8 | 2,907 / 2,037 |
| Lake | 23.0 | 34.2 | 47.8 | 32.5 | 3,461 / 2,584 |
| Aerial | 21.4 | 32.1 | 67.3 | 38.3 | 3,797 / 2,993 |
| Driving | 20.4 | 33.8 | 73.7 | 45.9 | 2,700 / 1,886 |

The starting-camera resident set fell from 14 near + 85 mid tiles to 14 near + 18 mid tiles. Three's reported buffer/texture allocation estimate fell by roughly 250–300 MiB across the fixed views. This excludes some backing allocations and is not physical GPU memory usage.

An isolated 15-second driving comparison before/after the facade-uniform change improved from 25.8 to 36.5 FPS and p95 from 52.4 to 30.8 ms. Before the uniform change, the slow-frame probe recorded rendering stalls up to 898 ms; that dedicated candidate run recorded no CPU frames above 60 ms. The final mixed-camera drive still recorded a 144 ms frame after new geometry/textures arrived, so this does not eliminate all streaming hitches.

### Verification and reproduction

The full-city harness fails below 30 FPS or on rendering/streaming errors, and refuses a silent fallback to the smaller district. The committed baseline failed all five scenarios; the candidate passed all five. Screenshots and full measurements are saved under the specified `.context/` output directory.

```sh
uv run --with playwright python tools/perf/frame-budget.py --baseline-ref a58e9d3 --scenes spawn,cargo,lake,aerial,drive --seconds 8 --out .context/fps/before
uv run --with playwright python tools/perf/frame-budget.py --scenes spawn,cargo,lake,aerial,drive --seconds 8 --out .context/fps/after
node --test tests/*.cjs tests/*.mjs
```

Node checks passed; 17 tests requiring untracked city/tile data were skipped. Required CI now includes the default residency budget, rigid-model batch checks and facade program parameterization. The cached-Three shader matrix also passed canvas, planar-reflection, main MRT, partial MRT and shadow-override configurations. It verifies identical generated photo WGSL across different building parameters in each applicable pass.

The required design scan on `index.html` reported the existing Inter-font and single-font warnings. Its suggested fix is a more distinctive display face paired with a body face; typography was outside this performance pass.

### Follow-up: streaming stalls and implementation cleanup

A fast camera-route trace isolated a 428 ms rendering stall: approximately 352 ms came from preparing 42 shader states, mostly photo overlays. The renderer now shares a 4 ms admission budget for cold photo draws across passes. Warm photos render normally; deferred overlays keep the procedural building visible underneath. Main-view and reflection readiness are tracked separately, and startup warm-up remains unrestricted. One shader build can exceed the budget; this spreads batches of first-use work rather than promising a hard frame-time limit. `?debug=nophotobudget` provides an A/B control; `?hooks` exposes the counters as `__twin.shaderBudget`.

Grass now uploads only when its field changes. Concurrent building jobs share a cooperative 5 ms slice and yield during batch packing. Tile replacements retain the active buildings until the replacement is ready; cancellation releases partial work, and separate override-budget leases account for overlapping builds.

The streamed shadow-proxy experiment reduced draw counts without a consistent FPS improvement, so its implementation, flags, and dedicated mock tests were removed. The earlier static shadow-culling system is unchanged. Temporary profiling jobs were stopped and 33.5 MiB of session scratch files were cleared; benchmark JSON was retained. These changes are local and do not establish a new steady-FPS guarantee.

Final validation: 538 Node tests passed, 17 requiring local data were skipped, and none failed. A full-city streaming browser check completed a fast camera lap without console or streamer errors, verified tile unloading, and observed 868 deferred cold photo draws. Its longest sampled frame was 216 ms, so substantial non-photo streaming stalls still remain.

### Follow-up: static tree instances and furniture uploads

A route profile attributed 4.3 seconds of 5.7 seconds spent updating the world to street furniture. Every three metres of travel, the system rewrote thousands of unchanged tree transforms and seasonal values and uploaded whole allocated buffers. Trees now keep dense instance slots while they remain in the same genus/LOD batch. Removal compacts surviving records; additions write new slots. Tree selection, detail distances, shadows and submission budgets are unchanged. Other furniture uploads only its occupied prefix. Tree uploads cover modified slots and retain any pending ranges from frames when a batch did not render.

Two instrumented runs per version used Chromium/Metal on the same M3 Max at 1280×800, pixel ratio 1, vsync disabled, full-city data, near/mid radii 750/1250 m and a 180 m/s route through `(0,0) → (1000,-400) → (-1000,-400) → (0,0)`. The baseline is the cleaned-up version immediately before this change, including the earlier photo-draw budget.

| Measurement | Before | After |
| --- | ---: | ---: |
| Furniture upload per rebuild | 7.13–7.15 MB | 0.47–0.49 MB |
| Mean furniture update time per world update | 6.41–7.06 ms | 5.77–5.82 ms |
| Median route frame | 39.6–45.3 ms | 35.5–36.6 ms |
| Route average FPS | 19.5–23.0 | 22.9–23.7 |

The approximately 93% upload reduction is consistent. FPS ranges overlap, and the new runs still contained 265–341 ms frames; these measurements do not establish a sustained FPS gain or resolve all streaming stalls. A selector rewrite without a clear isolated benefit was removed. At the return camera, both versions selected the same 6,029 trees, 20 tree draws and 70,408 tree triangles. The browser also checked every cached transform and seasonal attribute against its selected tree record after traversal.

Startup checks also caught an intermittent pipeline-layout failure and, in an instrumented baseline boot, malformed WGSL referencing an undeclared sampler. The app previously overlapped 16 `compileAsync()` calls on one renderer. These calls now run sequentially to avoid sharing active renderer/shader-builder state; Three.js still submits GPU pipeline work in parallel within a call. Three instrumented fresh boots passed after this change. Paired boot-and-night checks took approximately 1–3 seconds longer; this is a startup tradeoff, not a steady-frame optimization. The original failures were intermittent, so clean repeats do not establish that every upstream shader issue is resolved.

`tools/shoot-stream.py` now accepts `--port 8000` for the public R2 CORS policy and `--time midnight` for a night traversal. Its performance observers disconnect between laps so later laps do not count earlier observers again. A night soak can be replayed with:

```sh
uv run --with playwright python tools/shoot-stream.py \
  --out .context/furniture-night --port 8000 --time midnight \
  --stream 750 --mid 1250 --city --loops 2 --speed 180 \
  --path='0,0;1000,-400;-1000,-400;0,0' \
  --query 'heroes=0&data=https://pub-d3c994d177d048d5b64ecfc3df496b48.r2.dev'
```

Final validation: 542 Node tests passed, 17 requiring local data were skipped, and none failed. The boot/cache tests passed again after serializing startup compilation. The final two-lap night soak reported no console or streamer errors, unloaded 53 tiles, and held heap growth between laps to 0.1% (815.7 → 816.4 MB). With the harness's default vsync, those night laps averaged 17.0 and 17.7 FPS and still contained 250–283 ms frames. This is a correctness and memory check, not a matched day/night FPS comparison; further frame-time work remains.
