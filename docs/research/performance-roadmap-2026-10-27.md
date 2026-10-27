# Copenhagen rendering: the next performance steps

Implementation follow-up: the [performance notes](./rendering-optimization.md#follow-up-streaming-stalls-and-implementation-cleanup) record the retained fixes and the shadow-proxy experiment that was removed after measurement. The research below preserves the evidence and recommendations as originally assessed.

Research date: 27 October 2026. Scope: the live-demo FPS complaint, the current local fixes, and practical ways to improve sustained play and streaming responsiveness. Recommendations below are experiments, unless explicitly marked as measured.

## Executive Summary

There is substantial work left before this game has a dependable 60 FPS budget. The strongest next direction is to reduce the geometry and rendering commands submitted for the city, especially in shadows and reflections, while spreading tile activation across frames. Merely lowering screen resolution is unlikely to address all of that work. This conclusion combines the existing local measurements with an audit of the exact Three.js revision used by the game.

The most consequential finding is that the current WebGPU backend still emits individual draws for the distinct geometry ranges inside a `BatchedMesh`. Fewer scene objects therefore do not necessarily mean fewer physical GPU draws. Render bundles can reduce CPU command recording, but require careful handling of changing visibility and streamed resources. [Pinned backend][1]; [render-bundle guidance][4].

Two concrete local issues deserve early experiments. First, the existing static shadow-proxy setup is connected to debug footprints rather than streamed city buildings. Second, grass uploads 627,200 bytes every frame while standing still. A runtime-only probe eliminated those standing uploads by changing the attribute usage hint; changing grass data still uploaded while driving. The probe did **not** establish an FPS improvement.

The next sequence should be: establish per-pass and main-thread measurements; remove unnecessary grass uploads; prototype streamed building shadow proxies; compare spatial geometry merging with render bundles; then address tile-arrival stalls and geometry LOD. Reflection cadence and conservative occlusion are further candidates. Compressed textures can help residency and transfers but introduce transcode work. Experimental bindless rendering and mesh shaders should remain separate research projects. No defensible evidence supports promising a particular final FPS yet, and the user's live 10 FPS has not been reproduced under their exact browser configuration.

## Introduction

The question is what can improve performance beyond the fixes already prepared locally. Those fixes address excessive resident tile coverage, facade shader specialization, redundant rigid vehicle meshes, and road-surface culling. They are not repeated here as new proposals. Their measurements and validation are recorded in [the existing performance report](./rendering-optimization.md).

On the local M3 Max machine, the previous full-city benchmark at 1920×1080, device-pixel ratio 1, and Metal WebGPU improved from approximately 20–27 FPS to 32–38 FPS across five views or routes. The improved version still submitted approximately 1,900–3,000 draws and 5–8 million triangles across its passes. These are the previous turn's measurements, not a fresh demonstration of this research's recommendations. They also are not a measurement of the live demo on the user's unidentified browser. The production changes remain local at the time of this report.

A steady 60 FPS allows about 16.7 milliseconds between frames. The measured local 32–38 FPS corresponds to roughly 26–31 milliseconds. Closing that gap requires a substantial reduction in the limiting work, rather than a collection of changes whose advertised gains come from unrelated scenes. CPU submission, GPU geometry processing, pixel work, resource transfers, and first-use compilation can overlap. Their individual timings cannot simply be added to predict a final frame rate.

The game pins Three.js core, WebGPU, TSL, and addons to commit `6828c9b2559167925fa90c6c84dfc1a657b38d2c`. This matters: current documentation describes some facilities that are absent from that pin, and current upstream fixes may target conditions this scene does not exercise. Each recommendation was checked against local callsites and, where relevant, the pinned implementation. Online material was limited to specifications, official documentation, implementation sources, original research, and developers' accounts of their own implementations.

The research separates sustained cost from arrival stutter. A scene can stand at 36 FPS yet pause when a new tile appears. Conversely, smoothing tile construction can improve driving without changing the settled FPS counter. Both matter to playability, but require different measurements and changes. The proposed experiments therefore include stationary views, moving-camera routes, and tile-boundary transitions.

Browser configuration is another independent variable. Before comparing a future result with the live complaint, record the actual renderer backend, adapter information where exposed, viewport, device-pixel ratio, browser version, and hardware acceleration status. Chrome's troubleshooting documentation describes conditions under which WebGPU is unavailable or uses an unexpected adapter. This is a verification step, not an explanation already established for the user's 10 FPS. [Chrome troubleshooting][26].

## Main Analysis

### Finding 1: measure the limiting work and remove a verified redundant upload

The existing half-resolution diagnostic barely changed FPS in the original city scene. That is useful counterevidence against treating main-view fragment shading as the only bottleneck. It does not prove the entire frame is CPU-bound. Vertex processing, thousands of draw commands, fixed-resolution shadow maps, and resource synchronization can remain expensive when the main viewport shrinks. The next measurement must distinguish those possibilities rather than elevate one coarse diagnostic into a complete diagnosis.

Use the same route and camera states to compare the full renderer with shadows, planar reflection, and SSR bypassed individually. Record wall-frame median, p95 and p99, main-thread work, geometry and texture arrivals, upload bytes, and commands per pass. Keep the initial test matrix small enough to repeat in alternating order. A saved screenshot at each checkpoint should establish that the compared views contain the same city coverage. Development tools can identify long main-thread tasks and correlate application marks with tile activation; command inspection can expose the actual passes and draws. Final timing runs should also run without capture instrumentation. [DevTools performance reference][11]; [WebGPU Inspector][12].

GPU timing needs particular care on this Mac. The pinned Three.js timestamp query pool adds individual pass durations into a frame total. Apple documents overlap between geometry processing for a later pass and fragment processing for an earlier pass on its tile-based GPUs. Consequently, a sum of overlapping intervals need not equal elapsed GPU frame time. Optional browser timestamp queries remain useful for comparisons, but their availability and precision must be checked. Wall-frame behavior and a CPU trace are still needed; a native capture can resolve ambiguity when necessary. [Pinned timestamp implementation][8]; [Apple GPU architecture][9]; [Chrome timestamp queries][10].

One low-risk issue is already verified at the byte level. In `js/grass-cph.js`, `aTuft` contains 627,200 bytes and uses `DynamicDrawUsage`. The game sets `needsUpdate` when the grass field changes. However, the pinned attribute manager also uploads an existing attribute when its usage is dynamic, even if its version is unchanged. This creates standing uploads despite correct application dirty marking. [Pinned attribute manager][7].

A runtime probe wrapped the corresponding WebGPU `queue.writeBuffer` calls and changed only that attribute's usage hint in the browser. With dynamic usage, 170 standing frames produced 170 uploads totaling 106,624,000 bytes, while the attribute version stayed at 13. With static usage, 182 standing frames produced zero uploads, again at version 13. A second dynamic sample restored one upload per frame. During driving with static usage, six version changes produced six uploads totaling 3,763,200 bytes. Thus the existing dirty marking still delivered changed data; the usage hint did not make the buffer immutable.

The timing result is less conclusive. The first dynamic sample ran at 33.9 FPS and the static sample at 36.3 FPS, but the repeated dynamic sample reached 36.8 FPS. This drift prevents claiming a speedup. The justified recommendation is to remove the verified unnecessary traffic, preserve dirty marking, and then repeat alternating timing samples. Count these bytes once per main view in the present scene: grass does not cast shadows and is excluded from the reflected small-object roots. Multiplying the measured traffic by every rendering pass would exaggerate the result.

A fresh upstream change is also worth checking, but conditionally. Three.js PR 35232, merged on 27 October, fixes shadow override-material version churn caused by alpha-test assignment. It also improves source-material tracking for correctness after material swaps, vertex-node changes, and multi-material updates; that is not a separately demonstrated CPU saving for stable materials. Its author's timing improvement belongs to their scene. [Upstream shadow-material fix][13]. In this game, ordinary tree instances and boat labels do not currently cast the relevant alpha-tested shadows, so the reported trigger may be absent. Count alpha-tested shadow casters and override version changes before prioritizing an upgrade. If it is tested, pin all Three.js imports coherently and compare a specific revision; do not turn a moving development branch into an uncontrolled benchmark variable.

This measurement work has a practical decision rule: pursue render-command reuse if main-thread encoding dominates; pursue simpler geometry and fewer passes if GPU geometry dominates; pursue target resolution or shader changes if pixel work dominates; and pursue activation scheduling when the slow frames coincide with new resources. The grass experiment is the first verified reduction in work, not a substitute for that classification.

### Finding 2: reduce physical city draws, or reuse their recording with explicit visibility rules

The game's current building batching is useful, but its name conceals an important implementation detail. `js/building-batches.js` packs walls, roofs, and entrance doors by material and mesh name. It adds each original cell geometry with `batch.addGeometry()` and creates an instance of that geometry. The pinned WebGPU backend then loops through visible batch ranges and issues separate indexed draws. The batch can reduce scene traversal and material-management overhead without collapsing all those distinct ranges into one GPU draw. This is why the physical command stream matters more than the number of `Object3D` instances. [BatchedMesh documentation][2]; [pinned backend][1].

A recent upstream issue proposes merging consecutive draws that share a geometry range. That is a narrower case than this city's different building cells. Its benchmark is not evidence that the same reduction applies here. Likewise, putting more distinct building cells into one larger `BatchedMesh` would not, by itself, remove their individual draws. Mid-distance lite tiles already merge their buildings into a single cell, so recommending that again would repeat existing behavior. [BatchedMesh issue][3].

There are two different engineering approaches worth comparing. The first is true spatial geometry merging: concatenate compatible vertex and index ranges into fewer actual meshes, with transforms baked appropriately. Start with cheap far-city geometry, perhaps a 2×2 tile group, and then evaluate selected opaque building cells. Far ground, buildings, and water currently have separate per-tile meshes in `js/far-lod.js`; they provide a bounded prototype. Merge only compatible material and layer behavior, and keep opaque and transparent paths distinct. The hypothesis is fewer actual commands, not a guaranteed frame-rate increase.

The cost of this approach is coarser visibility. A larger merged mesh may draw more hidden triangles whenever any portion is visible. It can also make tile unloading, near/far handoff, and rebuilding more expensive. Therefore, compare commands saved against triangles added and activation latency, across street, waterfront, and aerial viewpoints. Preserve building IDs and index ranges needed for picking. A single city-wide mesh would sacrifice too much spatial control to be a sensible first experiment.

The second approach is render bundles. These cache GPU command recording so repeated draws require less CPU work; they do not inherently reduce the geometry rendered. The current pin already includes `BundleGroup`, so investigating it does not require a renderer upgrade. The documentation restricts the group to renderable objects rather than lights. A practical first candidate is a stable opaque spatial chunk with fixed geometry and materials. [Render-bundle guidance][4]; [BundleGroup documentation][5].

The difficult part is visibility correctness while driving. In the pinned renderer, a bundle's child render list is cached, and invalidation checks include group version and disposed resources rather than automatically rebuilding every child list after camera movement. [Pinned renderer][6]. A naive wrapper around the whole static city can retain the wrong selected objects or batched visibility. Marking it dirty every frame loses the recording reuse being sought. Prototype conservative chunk-level visibility and explicit invalidation on tile replacement and relevant structural, shader, binding-layout, or resource changes. Ordinary uniform or buffer-content updates need not rerecord commands. [Render-bundle guidance][4]. Record compatible bundles for the main MRT, reflected view, and depth-only shadow passes separately. A stationary camera that looks correct is insufficient evidence for a moving game.

Counters introduce another trap. In that same implementation, draw and triangle statistics are updated when commands are recorded, while bundle replay executes cached commands without repeating those updates. [Pinned renderer][6]. A lower `renderer.info` number can therefore mean fewer commands were newly recorded, not fewer draws were executed. The benchmark must report recorded commands, bundle replays, CPU recording time, and actual pass work separately. Otherwise a change can appear to remove almost every triangle while the GPU still renders the same city.

For a bundle prototype, a useful proposed gate is a repeatable 20% reduction in CPU encoding time for its target workload, with no missing geometry during full turns, tile transitions, or disposal. This is an acceptance target chosen for the experiment, not an expected gain from the literature. If CPU encoding is a small fraction of the frame, even a successful bundle implementation may have little effect on FPS. If geometry dominates, merging or visibility reduction should take precedence.

Texture organization is a later companion problem. Photo facades have per-building texture bindings and transparent overlays over procedural walls. A size-bucketed texture-array bank and a combined facade path might allow broader grouping, but would require material and asset changes. Arrays impose common layer dimensions and allocation choices, which interact poorly with the existing small residency budget if implemented as one enormous allocation. The recent bindless article describes experimental browser functionality, not a deployment-ready assumption for every player's Mac. [Experimental bindless analysis][24].

Similarly, browser mesh shaders remain an open GPUWeb proposal. They are not an available shortcut for replacing this city's renderer. Portable compute and indirect drawing can support a larger future visibility system, but that should follow evidence that simpler spatial merging and command reuse cannot meet the budget. [Browser mesh-shader proposal][25].

### Finding 3: avoid repeatedly rendering full city detail in shadows and reflections

The city is rendered from several viewpoints in a frame. Simplifying those secondary views can remove work without sacrificing the main camera's architectural detail. The existing code already contains useful pieces: one active planar reflector, reduced reflection resolution, small-object exclusions, and suppression of shadow updates during reflection. The question is how much unnecessary work remains after those controls, rather than whether to add them again.

The most concrete gap concerns shadow proxies. `js/scene-culling.js` can construct position-only stand-ins for large static casters, grouped into spatial cells with shared materials. But `js/main.js` calls that setup once, using names from `world.cullingRoots`. Both current world configurations list only `CopenhagenDebugFootprints`. Streamed building holders are outside those roots, and subsequent arrivals also use a separate lifecycle after the one-time setup. Initial tiles are already settled before world construction returns. Furthermore, the generic proxy eligibility thresholds assume large district-spanning meshes; a normal streamed tile need not satisfy them. The machinery's presence in the repository therefore does not establish that streamed buildings benefit from it.

The next prototype should register proxy construction and disposal with tile activation. Start with one representative loaded tile. For opaque, stationary walls and roofs, construct a reduced shadow representation that preserves the silhouette, transforms, face-side behavior, and light-space extent. Keep detailed main-view materials on the visible meshes. Give each proxy appropriate bounds and a lifecycle tied to the owning tile, and exclude the original caster only after its substitute is ready. Measure both cascades separately to establish whether geometry, commands, or material preparation actually decline.

Do not proxy alpha-cutout or displaced objects as solid boxes. Existing material checks already recognize that those paths can change the shadow shape. Imported landmark models, moving boats, and vehicles require their own eligibility decisions. A proxy that saves commands by filling an archway or dropping a roof feature is a visual regression. The acceptance set should include courtyards, bridges, tall roofs, a low sun, and tile unloads. A reduced caster representation may also worsen spatial culling if its chunks are too broad, so draw reduction must be judged alongside submitted triangles.

Caching shadows is another possible experiment, but the viewing camera remains relevant even when every building is stationary. `SunLightShadow` fits two cascades to the view frustum, and the pinned render path updates the shadow matrices for the view camera. [SunLightShadow documentation][14]; [pinned shadow implementation][15]. Freezing updates indefinitely while driving can produce incorrect coverage or stale shadows. A proposed compromise is a lower update cadence with immediate invalidation on significant camera movement, sun changes, and streamed geometry changes. Traffic moves every frame: a whole-atlas cadence test must tolerate bounded actor-shadow latency, or invalidate so often that it saves little. A separate static/dynamic shadow composition would be a larger architectural change.

Planar reflections warrant their own controlled test. Generic city water defaults to scale 0.25, while the Søerne lake reflector is constructed with scale 0.4. The current `?reflect=rN` option does not alter that lake setting. Changing the lake scale from 0.4 to 0.25 reduces its nominal render-target pixel area by about 61%, but leaves geometry submission largely unchanged. The older planar-off diagnostic showed a potentially meaningful difference, although it predates the current fixes and is not a forecast of their combined benefit.

A more submission-oriented reflection experiment is to refresh every other frame, or use a motion threshold with an immediate update after large changes. Water close to the player and moving reflected actors are the visual stress cases. There is also a correctness bug to handle before using an off switch as a benchmark: `buildLakes.setPlanar(false)` stops updates, but the lake material continues sampling the last reflection. Generic water already has an explicit sky blend. A proper lake fallback must blend to sky or select a precompiled fallback material, rather than display a frozen image and call the pass disabled.

Conservative occlusion is another candidate for dense streets. An original city-rendering case study demonstrates CPU depth-based rejection, while the hierarchical-culling literature explains why temporal coherence and avoiding synchronous waits matter. Neither establishes a cull percentage or CPU cost for Copenhagen. Our proposed prototype would use conservative opaque occluders, expanded tested bounds, and fail-open behavior for rapid turns or uncertain results. Start in one street corridor, then compare an open waterfront. Visibility for the main camera cannot automatically be reused for off-screen shadow casters or reflected geometry. [City occlusion case study][17]; [hierarchical culling research][18].

SSR, bloom, and MSAA remain measurable costs, but several generic recommendations are already implemented or inappropriate here. SSR and bloom already use reduced resolution, AO is opt-in, and multisampled color discard is already enabled. SSR consumes depth and contributes on dry metallic surfaces, so disabling it only when it is not raining would alter intended material behavior. Some SSR quality options are compile-time settings; avoid repeatedly recompiling them in a quality controller. Depth-discard advice is also unsafe for this pipeline. Test SSR bypass and MSAA separately only after measuring their pass cost. [SSRNode documentation][16]; [RenderTarget documentation][28].

### Finding 4: budget tile activation globally, then improve geometry and texture residency

The game already has workers and sliced construction. That does not guarantee smooth resource arrival. In `js/buildings-stream.js`, each tile starts an independent `createSlicer(8)` allowance. The world permits two concurrent building jobs. Their allowances are not a shared frame budget, and a large leaf operation can overrun a slice. After construction, a complete holder is added to the scene at once. Geometry packing, first-use GPU allocation, texture transfer, mip creation, and pipeline preparation can therefore converge on the same visible frame despite much of the geometry computation having happened in workers.

Tile replacement has a related problem. `addTile()` first removes the existing tile and then builds its replacement in an unattached holder. On a near-to-mid or mid-to-near transition, that can remove usable content before the new representation is ready. A better handoff retains the old representation until a replacement has completed preparation. The transition must have a bounded overlap budget, because temporarily retaining both representations increases memory use. Cancellation and disposal need to remain correct when the player turns around before the replacement is activated.

The proposed implementation is a shared main-thread deadline for all city activation work, not an independent timer in every builder. Begin experimentally with a 4–6 millisecond allowance for construction and activation combined, and adjust from measured frame slack. This is an engineering starting point, not a browser guarantee. Break geometry packing into work units that can yield. Track the preparation queue separately from the worker queue, and activate a limited number of cells or bytes per frame rather than attach all completed resources simultaneously. A count-based cap alone is insufficient when tiles differ greatly in size.

Instrument stages explicitly: worker result delivery, array conversion, building batch packing, texture residency decisions, first upload, pipeline preparation, holder attachment, and disposal. The previous route still contained an approximately 144 millisecond render-call spike coinciding with a few new geometries and textures, plus a separate world-update spike. Those correlations identify where to investigate, not proof of which browser operation consumed the missing time. DevTools marks and an upload/command capture should distinguish CPU processing from first-use resource work. [DevTools performance reference][11].

The texture scheduler already spaces atlas jobs across animation frames. However, creating a texture, setting `needsUpdate`, and waiting one frame does not establish that the GPU upload or mip generation has completed before its first visible draw. Browser-native image decode, texture copies, and mip handling are distinct operations. The appropriate improvement is an explicit preparation stage supported by the pinned renderer, with upload bytes and first-visible-frame latency measured. [Image-texture upload guidance][27].

Version awareness matters here. Current Three.js documentation exposes `initTexture()`, but that method is absent from the game's exact pin. Do not build a plan around a current documentation method without checking the deployed implementation. `compileAsync()` exists and is used during startup; streamed resources need preparation for their relevant materials and passes too. The WebGPU specification favors asynchronous pipeline creation to avoid pipeline-creation stalls, but that does not make a newly visible collection of resources free. Avoid awaiting queue completion every frame, which would sacrifice useful CPU/GPU overlap. [Current renderer documentation][22]; [pinned renderer][6]; [WebGPU specification][23].

Geometry LOD is the larger medium-term reduction. The current geometry selection primarily follows distance bands, whereas photo quality already uses projected texel density and hysteresis. A screen-space geometry error metric would choose coarse or detailed building representations according to their visible error, including camera height and field of view. Cesium's implementation provides a useful reference for error-driven refinement, multi-view selection, and retaining fallback content while detail loads. The proposal is to adapt that principle to this renderer, not migrate the game to Cesium. [Cesium tile-selection algorithm][19].

For a simplified starting model, projected error in pixels is approximately `errorMetres × viewportHeight / (2 × distance × tan(verticalFov / 2))`. The difficult missing inputs are meaningful geometric-error bounds and prebuilt coarse/fine building variants. Measure silhouette error and preserve prominent rooflines before reducing tessellation indiscriminately. Keep hysteresis around thresholds and bound transitions so camera motion does not trigger repeated rebuilds. Aerial views and street views should be allowed different detail selections when their projected errors differ. This is new geometry work; applying the same rule to photo atlases again would not remove city triangles.

Compressed facade textures are a separate residency experiment. `KTX2Loader` can transcode Basis textures for supported GPU formats, and the Khronos specification defines requirements including alpha handling, color interpretation, and mip levels. That can reduce GPU texture storage and transfer pressure relative to uncompressed residency, but introduces runtime transcoding and a new offline asset path. Test a small representative set containing photographic color, masks, transparency edges, and roof details. Compare actual resident format bytes, transcode latency, upload time, and image quality; update the current RGBA8-based accounting instead of claiming every compressed asset has a fixed universal ratio. [KTX2Loader documentation][20]; [Khronos Basis texture specification][21].

Finally, predictable quality tiers can make these changes useful across machines. A slower-device tier should lower the costs actually found to dominate, such as geometry coverage, shadow detail, or reflection cadence, while keeping the immediate street legible. Repeated frame-budget misses can trigger a gradual step down with a longer recovery window to prevent oscillation. Precompile any alternate material paths. This is a proposed product policy; the present evidence does not justify universal thresholds or claim that a lower resolution slider alone will fix the live complaint.

## Synthesis & Insights

The remaining work falls into three practical budgets. First, recurring main-thread work includes object preparation, command recording, and unnecessary transfers. Grass usage and render bundles target parts of that budget. Second, recurring GPU work includes geometry, visibility, shadow casters, reflections, and pixel shading. Spatial merging can trade fewer commands for more triangles; simplified shadows and occlusion can reduce both. Third, arrival work includes building construction, first-use resources, and representation replacement. Global activation scheduling targets the slowest driving frames even if settled FPS remains similar.

The implication is that optimization should follow a decision tree rather than a feature checklist. If the CPU is late and the GPU has headroom, command reuse is attractive. If geometry dominates, cached commands still render too much city. If the slow frames coincide with arrival, broad changes to post-processing miss the relevant cause. Some proposals overlap: successful shadow proxies could reduce the remaining value of bundles, and a better geometry LOD could reduce the benefit of aggressive occlusion. Their isolated improvements must not be added together as a forecast.

The most useful architectural asset is the existing tile lifecycle. It can become the shared boundary for conservative main-view bounds, shadow proxies, bundle invalidation, resource preparation, and disposal. Reusing that boundary is more tractable than introducing unrelated whole-city caches for each optimization. This is a design inference from the local code, not a claim that one tile granularity is optimal for every pass.

Visual quality need not decline uniformly. A shadow representation can omit facade materials while preserving its silhouette; a far building can retain a recognizable roofline with fewer surfaces; an inactive reflection can blend into an intentional fallback. The objective should be a measured frame budget and reliable movement while preserving the details that identify Copenhagen.

## Counterevidence Register

| Tempting conclusion | Evidence against it | Consequence |
|---|---|---|
| Half resolution barely helped, so all work is on the CPU. | GPU geometry and fixed-resolution passes do not scale with the main viewport. | Obtain CPU and per-pass evidence before choosing bundles over geometry reduction. |
| Batched city objects imply few physical draws. | The pinned backend emits individual draws for distinct visible ranges. [Backend][1] | Inspect executed commands, not only scene-object counts. |
| Bundle replay removed the GPU's triangles. | Pinned statistics update on recording rather than every replay. [Renderer][6] | Separate command recording statistics from executed work. |
| Static buildings permit permanently frozen shadows. | Cascades fit the changing view camera. [SunLightShadow][14] | Invalidate cached shadows for camera and scene changes. |
| Grass usage improved FPS by roughly 7%. | The repeated dynamic run was as fast as the static run. | Claim the verified upload reduction only. |
| A fresh upstream fix guarantees the author's milliseconds here. | The shadow-cache trigger may not occur in the current local scene. [PR 35232][13] | Verify the trigger before investing in an upgrade trial. |
| Compressed textures are a free speed improvement. | They need transcoding, supported formats, and correct mip/color/alpha handling. [KTX2Loader][20]; [Khronos][21] | Measure end-to-end preparation and actual residency. |

## Claims-Evidence Table

| Claim | Basis | Confidence and boundary |
|---|---|---|
| Grass has redundant unchanged-data uploads. | Runtime interception: 627,200 bytes per standing frame; zero with static usage; changed versions still uploaded while driving. | High for bytes; FPS effect not established. |
| Current batching preserves many distinct GPU draws. | Local `batch.addGeometry()` callsites and pinned WebGPU backend. | High for implementation; future draw-reduction benefit unmeasured. |
| Existing proxy setup misses streamed building holders. | Current world root lists, one-time setup call, streamed holder attachment. | High for callsites; proxy performance benefit unmeasured. |
| Arrival scheduling can exceed the intended shared frame allowance. | Independent 8 ms slicers, two active builders, whole-holder activation. | High for mechanism; attribution of individual historical spikes incomplete. |
| Summed pass duration can misrepresent elapsed frame time on Apple GPUs. | Pinned timestamp summation and Apple's overlapping-pass architecture documentation. | High for the limitation; no new native GPU capture in this research. |
| These changes can deliver a steady 60 FPS on every player machine. | No supporting benchmark. | Not established. |

## Limitations & Caveats

The user's exact live-demo browser, adapter selection, thermal conditions, and pixel ratio are unknown. Local Chromium measurements on an M3 Max do not establish their experience, especially if the live deployment still runs the older code. A higher-end local result is not a substitute for a reproducible baseline on the affected configuration.

Only the grass upload behavior received a new runtime treatment in this research. The other proposals are source-backed hypotheses and engineering recommendations. Existing FPS and spike figures come from the preceding optimization work. No fresh native GPU capture establishes the present limiting stage, and renderer call duration is not GPU completion time.

Online case studies describe their authors' applications. None of their FPS gains, cull percentages, or milliseconds is transferred to this game. Current documentation can differ from the deployed pin. Browser experimental features are not assumed to exist on all target machines.

The machine also briefly had approximately 200 MiB of free disk space during research, later rising above 5 GiB without cleanup by this session. That is a separate environmental observation, not an established explanation for the renderer's frame time. No files were deleted to address it.

This research adds documentation and ignored diagnostic artifacts. It does not implement these new production proposals, upgrade the engine, publish the existing local fixes, or change the live demo.

## Recommendations

Use the following sequence. Priority expresses expected value of information and implementation risk, not a quantified FPS forecast. Thresholds are proposed acceptance gates and should be adjusted after a reproducible baseline.

| Order | Concrete experiment | Evidence required to retain it |
|---|---|---|
| 1 | Capture stationary and driving baselines on the affected browser; independently bypass shadows, planar reflections, and SSR with correct fallbacks. | Wall-frame distributions, CPU trace, pass commands, upload bytes, backend/adapter and viewport recorded. |
| 2 | Change grass attribute usage while retaining existing dirty marking. | Zero unchanged standing uploads; changing fields still upload; repeated timing shows no regression. |
| 3 | Attach opaque shadow proxies to one streamed tile's lifecycle. | Correct silhouettes and disposal; reduced shadow commands or GPU geometry time; then repeat on a route. |
| 4 | Compare true far-tile geometry merging with a spatial `BundleGroup` prototype. | Fewer actual commands for merging; meaningful CPU encoding reduction for bundles; correct visibility through full turns and tile changes. |
| 5 | Add shared construction/activation budget and retain old tiles until replacements are ready. | Correlated activation spikes reduced; initially target removal of arrival frames above 100 ms, with bounded overlap memory and no transition holes. |
| 6 | Test lake reflection scale and cadence independently. | Correct sky fallback, no objectionable stale reflections, measured benefit at both Søerne and harbour. |
| 7 | Prototype conservative cell occlusion and precomputed geometry LOD. | Net frame savings after visibility overhead; no missing structures; aerial and waterfront controls remain acceptable. |
| 8 | Trial a representative KTX2 facade set and a measured slower-device tier. | Better actual residency or arrival cost at acceptable visual quality; no transcode-related tail regression. |

Treat the upstream shadow-cache fix as a conditional branch after checking for its trigger. Defer experimental bindless requirements, mesh shaders, and an engine replacement. A useful initial playability gate is a repeatable p95 below 33 ms on the target route, followed by a stricter 16.7 ms budget for a 60 FPS quality tier. Report p99 and pauses separately; an average alone can hide controls that still feel unresponsive.

For each retained change, save baseline and treatment artifacts with the same route, camera states, browser, and resident tile configuration. Alternate run order and distinguish settled from arrival windows. Stop broadening the experiment once the evidence answers its question; move to the next limiting stage rather than repeatedly optimizing a stage that no longer controls the frame.

## Bibliography

All URLs were consulted on 27 October 2026. For living documentation and repositories, 2026 denotes the consulted snapshot unless a publication year is explicitly available. Issue and pull-request status is stated as observed on that date.

[1] Three.js contributors (2026). "WebGPUBackend.js at 6828c9b". [Pinned backend](https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/webgpu/WebGPUBackend.js). Retrieved 27 October 2026.

[2] Three.js contributors (2026). "BatchedMesh". [BatchedMesh documentation](https://threejs.org/docs/pages/BatchedMesh.html). Retrieved 27 October 2026.

[3] Three.js contributors (2026). "WebGPURenderer: Merge consecutive BatchedMesh draws that share a geometry range.". [BatchedMesh issue](https://github.com/mrdoob/three.js/issues/35144). Retrieved 27 October 2026.

[4] Brandon Jones (2024). "WebGPU Render Bundle best practices". [Render-bundle guidance](https://toji.dev/webgpu-best-practices/render-bundles.html). Retrieved 27 October 2026.

[5] Three.js contributors (2026). "BundleGroup". [BundleGroup documentation](https://threejs.org/docs/pages/BundleGroup.html). Retrieved 27 October 2026.

[6] Three.js contributors (2026). "Renderer.js at 6828c9b". [Pinned renderer](https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/common/Renderer.js). Retrieved 27 October 2026.

[7] Three.js contributors (2026). "Attributes.js at 6828c9b". [Pinned attribute manager](https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/common/Attributes.js). Retrieved 27 October 2026.

[8] Three.js contributors (2026). "WebGPUTimestampQueryPool.js at 6828c9b". [Pinned timestamp implementation](https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js). Retrieved 27 October 2026.

[9] Apple (2026). "Tailor your apps for Apple GPUs and tile-based deferred rendering". [Apple GPU architecture](https://developer.apple.com/documentation/metal/tailor-your-apps-for-apple-gpus-and-tile-based-deferred-rendering). Retrieved 27 October 2026.

[10] François Beaufort, Chrome for Developers (2024). "What’s New in WebGPU (Chrome 121)". [Chrome timestamp queries](https://developer.chrome.com/blog/new-in-webgpu-121). Retrieved 27 October 2026.

[11] Chrome for Developers (2026). "Performance features reference". [DevTools performance reference](https://developer.chrome.com/docs/devtools/performance/reference). Retrieved 27 October 2026.

[12] Brendan Duncan (2026). "WebGPU Inspector". [WebGPU Inspector](https://github.com/brendan-duncan/webgpu_inspector). Retrieved 27 October 2026.

[13] Three.js contributors (2026). "Renderer: Track the source material in override passes.". [Upstream shadow-material fix](https://github.com/mrdoob/three.js/pull/35232). Retrieved 27 October 2026.

[14] Three.js contributors (2026). "SunLightShadow". [SunLightShadow documentation](https://threejs.org/docs/pages/SunLightShadow.html). Retrieved 27 October 2026.

[15] Three.js contributors (2026). "SunShadowNode.js at 6828c9b". [Pinned shadow implementation](https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/examples/jsm/lights/SunShadowNode.js). Retrieved 27 October 2026.

[16] Three.js contributors (2026). "SSRNode". [SSRNode documentation](https://threejs.org/docs/pages/SSRNode.html). Retrieved 27 October 2026.

[17] Anderson Mancini (2026). "Occlusion culling on the CPU for an instanced city". [City occlusion case study](https://andersonmancini.dev/blog/threejs-punk-occlusion-culling). Retrieved 27 October 2026.

[18] Jiří Bittner, Michael Wimmer, Harald Piringer and Werner Purgathofer (2004). "Coherent Hierarchical Culling: Hardware Occlusion Queries Made Useful". [Hierarchical culling research](https://www.cg.tuwien.ac.at/research/vr/chcull/). Retrieved 27 October 2026.

[19] Cesium GS (2026). "3D Tiles Selection Algorithm". [Cesium tile-selection algorithm](https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html). Retrieved 27 October 2026.

[20] Three.js contributors (2026). "KTX2Loader". [KTX2Loader documentation](https://threejs.org/docs/pages/KTX2Loader.html). Retrieved 27 October 2026.

[21] Khronos Group (2026). "KHR_texture_basisu". [Khronos Basis texture specification](https://raw.githubusercontent.com/KhronosGroup/glTF/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md). Retrieved 27 October 2026.

[22] Three.js contributors (2026). "Renderer". [Current renderer documentation](https://threejs.org/docs/pages/Renderer.html). Retrieved 27 October 2026.

[23] GPU for the Web Community Group (2026). "WebGPU". [WebGPU specification](https://gpuweb.github.io/gpuweb/). Retrieved 27 October 2026.

[24] Brandon Jones (2026). "Experimenting with Bindless Textures in WebGPU". [Experimental bindless analysis](https://toji.dev/2026/10/06/webgpu-bindless.html). Retrieved 27 October 2026.

[25] GPUWeb contributors (2022). "Mesh Shaders". [Browser mesh-shader proposal](https://github.com/gpuweb/gpuweb/issues/3015). Retrieved 27 October 2026.

[26] Chrome for Developers (2025). "WebGPU troubleshooting tips". [Chrome troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips). Retrieved 27 October 2026.

[27] Brandon Jones (2026). "WebGPU <img>, <canvas>, and <video> Textures". [Image-texture upload guidance](https://toji.dev/webgpu-best-practices/img-textures.html). Retrieved 27 October 2026.

[28] Three.js contributors (2026). "RenderTarget". [RenderTarget documentation](https://threejs.org/docs/pages/RenderTarget.html). Retrieved 27 October 2026.

## Methodology Appendix

Research proceeded in three parallel evidence tracks: renderer submission and engine changes; shadows, reflections, and GPU measurement; and streamed construction, LOD, and textures. A synthesis pass compared those findings with the actual game code and the previous benchmark artifacts. Two read-only critiques checked the draft's renderer claims and pass-specific recommendations. Their corrections clarified bundle invalidation, initial tile timing, the scope of the upstream shadow fix, and the tradeoff between shadow cadence and moving traffic.

Primary implementation and platform documents were given the highest weight for behavior they directly specify. Original research and developers' accounts of their own implementations were used for transferable techniques, not transferable benchmark numbers. As an informal screening scale, exact pinned implementation and official specifications received approximately 95/100 for the particular mechanism inspected, while original application case studies received approximately 80–85/100 for suggesting experiments. These are analyst judgments, not statistical confidence estimates or measurements of an entire source's reliability. A claim about this game required a local callsite or experiment in addition to general online guidance.

Local evidence used in the audit includes [building batching](../../js/building-batches.js), [streamed building activation](../../js/buildings-stream.js), [world setup](../../js/world.js), [main rendering setup](../../js/main.js), [shadow-proxy eligibility](../../js/scene-culling.js), [grass dirty marking](../../js/grass-cph.js), and [far-city meshes](../../js/far-lod.js). The imported Three.js pin was checked against its actual source. Current documentation was treated as current documentation rather than presumed to match that pin.

The new runtime probe used headless Chromium with Metal WebGPU against the current local game, after the city settled. The viewport was 1920×1080 at device-pixel ratio 1, with frame limiting and vsync disabled, explicit WebGPU/Metal launch flags, remote city data, and `heroes=0`. These are diagnostic conditions rather than the user's ordinary browser setup. It intercepted `queue.writeBuffer` calls whose backing data matched the grass attribute, alternated dynamic/static/dynamic usage while standing, and then drove with static usage. Attribute versions, frame intervals, byte counts, and call counts were captured together. No production file was edited for the treatment. These short samples verify upload behavior, but their order and timing drift do not support a causal FPS estimate.

| Probe window | Frames | FPS | Attribute version | Upload calls | Bytes uploaded |
|---|---:|---:|---|---:|---:|
| Dynamic, standing | 170 | 33.90 | 13 → 13 | 170 | 106,624,000 |
| Static, standing | 182 | 36.31 | 13 → 13 | 0 | 0 |
| Dynamic, standing repeat | 185 | 36.84 | 13 → 13 | 185 | 116,032,000 |
| Static, driving | 158 | 31.50 | 13 → 19 | 6 | 3,763,200 |

Temporary probe code and raw JSON are stored in the workspace's ignored `.context/` directory; all conclusions needed to interpret them are preserved above because Conductor workspaces are ephemeral. Earlier full-city benchmark results remain in the existing committed-documentation location referenced in the introduction. This new report itself has not been committed or merged.

Verification includes report-structure validation, bibliography completeness, HTTP accessibility checks, local relative-link resolution, and manual inspection that each recommendation's cited mechanism exists. Accessible URLs alone do not prove a claim: source behavior, version applicability, counterevidence, and benchmark limitations were reviewed separately. The report uses paraphrases rather than extended quotations and keeps the measured results distinct from proposed acceptance criteria.


[1]: https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/webgpu/WebGPUBackend.js
[2]: https://threejs.org/docs/pages/BatchedMesh.html
[3]: https://github.com/mrdoob/three.js/issues/35144
[4]: https://toji.dev/webgpu-best-practices/render-bundles.html
[5]: https://threejs.org/docs/pages/BundleGroup.html
[6]: https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/common/Renderer.js
[7]: https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/common/Attributes.js
[8]: https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js
[9]: https://developer.apple.com/documentation/metal/tailor-your-apps-for-apple-gpus-and-tile-based-deferred-rendering
[10]: https://developer.chrome.com/blog/new-in-webgpu-121
[11]: https://developer.chrome.com/docs/devtools/performance/reference
[12]: https://github.com/brendan-duncan/webgpu_inspector
[13]: https://github.com/mrdoob/three.js/pull/35232
[14]: https://threejs.org/docs/pages/SunLightShadow.html
[15]: https://github.com/mrdoob/three.js/blob/6828c9b2559167925fa90c6c84dfc1a657b38d2c/examples/jsm/lights/SunShadowNode.js
[16]: https://threejs.org/docs/pages/SSRNode.html
[17]: https://andersonmancini.dev/blog/threejs-punk-occlusion-culling
[18]: https://www.cg.tuwien.ac.at/research/vr/chcull/
[19]: https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html
[20]: https://threejs.org/docs/pages/KTX2Loader.html
[21]: https://raw.githubusercontent.com/KhronosGroup/glTF/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md
[22]: https://threejs.org/docs/pages/Renderer.html
[23]: https://gpuweb.github.io/gpuweb/
[24]: https://toji.dev/2026/10/06/webgpu-bindless.html
[25]: https://github.com/gpuweb/gpuweb/issues/3015
[26]: https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
[27]: https://toji.dev/webgpu-best-practices/img-textures.html
[28]: https://threejs.org/docs/pages/RenderTarget.html
