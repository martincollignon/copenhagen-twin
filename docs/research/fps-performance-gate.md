# Research Report: Keeping the Copenhagen Twin's frame rate pristine, with a pre-merge performance gate

*Deep research (ultradeep), 2026-10-26. Branch `mc/codex-astra-features-improve`. Local measurements on an Apple M3 Max, headless Chromium 1248, WebGPU via Metal.*

**Implementation update (26 October 2026):** The facade-texture memory slice is now a required `texture-memory-budget` pull-request check. It replays a fixed camera route against atlas metadata and enforces the 48 MiB / 56-atlas cap; the broader frame-time and GPU-timestamp gate described below remains proposed work.

## Executive Summary

The twin does not meet its own target today, and nothing would catch it getting worse. `docs/PLAN.md:94` sets one performance goal: "above 60 fps on an M-series laptop for the district". An uncapped headless run on an M3 Max at 1440×900 and pixel ratio 1 gave these numbers [L1]:

| View | Median frame time | Draw calls per frame | Render passes per frame |
|---|---|---|---|
| Aerial | 24.1–24.7 ms (about 41 fps) | 3,638–3,839 | 23 |
| Street level at Nørre Søgade 37 | 14–15 ms | about 2,300 | 23 |

At street level p95 drifted from 15.6 ms to 33.7 ms across three repeats on the same build.

The guidance from three.js practitioners is a few hundred draw calls on desktop. WebGPURenderer currently costs about 2× more CPU per draw than WebGLRenderer [22][23][24]. The repository has none of the following: CI, a frame-time API, a seeded simulation, or a pinned renderer. `index.html` loads three.js from the moving `@dev` branch on jsDelivr, which re-caches every 12 hours [30]. Frame rate can therefore change with no commit to this repo.

The research converges on a two-tier gate. Every major project that does this seriously works this way, including Chromium Pinpoint [36], Mozilla Perfherder [19], Babylon.js [7] and MapLibre [32].

1. **Deterministic budgets on every PR, on a free hosted runner.** These cover draw calls, triangles, render passes, pipelines created after warmup, GPU memory, and JS heap per fixed camera pose. They are exact numbers, so they can be hard-failed with no statistics. They only become exact once the simulation is seeded, because random traffic currently moves draw calls by ±5% [L1].
2. **Interleaved A/B timing on one dedicated real-GPU machine.** Base and PR builds alternate in the same job. Check p95/p99 frame time and GPU timestamps with a paired test plus a minimum-effect threshold. Babylon.js's published protocol is the template: 2 discarded warmups, 10 alternating rounds, trim 2 high and 2 low, a one-tailed paired t-test at p < 0.05 combined with a ratio threshold, and "inconclusive" when the coefficient of variation is above 10% [7].

Hosted runners cannot gate timing. CodSpeed measured 2.66% CV on GitHub runners, which gives about 45% false positives for a 2% gate [14]. This laptop cannot either: at load average 33, a quarter-resolution run came out *slower* than full resolution [L3].

There are three prerequisites, all small:
- pin three.js
- add a `?bench` mode: seeded RNG, fixed simulation step, and frame stats on `__twin`
- create a pose list

After those, one PR adds the Tier-1 job and a ratcheting `perf-budget.json`. A Mac mini self-hosted runner then carries Tier 2.

---

## 1. Introduction

### Question and scope
The question has two parts. First, how to make frame rate in the Copenhagen twin "pristine", meaning smooth at p95/p99 and not just a good average. Second, how to keep it that way, with automated tests that block regressions before merge.

In scope:
- the three.js WebGPURenderer and TSL stack as used here
- measurement methodology
- CI architecture on GitHub (private repo `martincollignon/cph-twin`)
- runtime guardrails
- the current state of this code base

Out of scope: load-time and network performance, beyond pipeline-compile hitches.

### Method
Four parallel research streams ran:
1. headless WebGPU benchmarking in CI
2. three.js WebGPU performance practice
3. performance-regression statistics and gate design
4. a read-only audit of this repository

Load-bearing claims were spot-checked against primary sources:
- Babylon.js's protocol, read from its README
- Tachometer's archived status, via the GitHub API
- CodSpeed's 2.66% figure, from the page itself
- three r186 `Info`/`Animation` source, which confirmed that `renderer.info.render.drawCalls` resets once per `setAnimationLoop` tick and so counts every pass in a frame

Local measurements were taken with a Playwright probe (`.context/perf-probe/probe.py`, ephemeral). It sets fixed camera poses through `__twin.cameraSystem.debugView`, disables vsync, records rAF deltas for 4 s per pose, and snapshots `renderer.info`.

### Assumptions
- Target hardware is M-series Macs and recent desktop GPUs, at 60 Hz with headroom for 120 Hz.
- The team is small and the repo is private, so self-hosted runners are acceptable from a security standpoint [21].
- The twin stays a no-build static site. Tooling should not force a bundler.

---

## 2. Main Analysis: Findings

### Finding 1: Today the twin misses its target, and the cause is mostly draw-call volume and pass count

The local probe gives the first grounded numbers this project has had [L1]. The aerial pose is about 41 fps on an M3 Max, which misses the PLAN target by about 40%. The street-level pose sits at the 60 fps line with no headroom.

The aerial frame breaks down as follows:
- **3,700 draw calls.** This is around ten times the "several hundred" desktop guidance [22][33].
- **7.8 M triangles.**
- **23 render passes** (`info.render.frameCalls`): two shadow cascades, shadow stand-ins, the planar water reflection, the MRT scene pass, SSR, bloom and its mips, the colour grade.
- **217 pipelines.**

Draw-call volume matters more on WebGPURenderer than many expect. A controlled forum benchmark on r183 rendered 4,000 separate meshes [23]:

| Renderer | CPU per frame | Cold first frame |
|---|---|---|
| WebGLRenderer | 4.5 ms | 32 ms |
| WebGPURenderer | 9.7 ms | 167 ms |

Don McCurdy states plainly that swapping to WebGPURenderer is not expected to improve performance by itself, and that batching and instancing remain essential [24]. The raw WebGPU API is cheaper per draw than WebGL in micro-benchmarks [22]. The three.js abstraction layer (per-object bind groups and render-object bookkeeping) currently gives that advantage back.

The water reflection is the single largest controllable driver. With `?water=simple` the aerial draw calls fell from about 3,700 to 2,011 and passes from 23 to 22 [L3]. The reflection re-renders most of the scene, so it close to doubles draw calls whenever the camera is above the lake surface, which `water-cph.js` allows at nearly every height below 450 m [L2]. The repository's own earlier measurement agrees: Peblinge Sø dropped from 47.7 fps to 27.7 fps with the reflection, under vsync [L2].

`ReflectorNode` exposes `resolutionScale`, `bounces` and `samples` [41], and a layer mask can keep small dynamic objects out of the reflection.

The uncommitted work on this branch adds load the gate would flag:
- **Swan boats:** 7 boats of 13 unmerged meshes each, all `castShadow`, two of them with clearcoat `MeshPhysicalMaterial`. That is about 91 meshes, or up to about 270 draws once two shadow cascades are counted. None of it is instanced or registered with `scene-culling.js` [L2].
- **Irma neon sign:** three permanent `PointLight`s in the clustered-lighting list and 8 new materials [L2].

Neither is wrong as a feature. Both are exactly what a budget gate exists to surface and price.

The GPU-bound vs CPU-bound question is not settled. The first three-repeat run was internally consistent (aerial 24.1/24.5/24.7 ms). The follow-up runs at quarter resolution and with `?debug=nograss` came out *slower* (29.7 ms and 43.8 ms) on a machine with load average 33.75, with other headless Chromes and a `golangci-lint` competing [L3]. That is a measurement-environment finding, covered in Finding 2. Settling the bottleneck needs GPU timestamps on a quiet machine (Finding 5). The draw-call count and the 2× WebGPU CPU overhead [23] point to CPU submission as the leading hypothesis for the aerial view.

### Finding 2: Absolute fps on shared machines is noise; only counters and paired A/B comparisons survive

There are three sources of variance, each with evidence.

**Hosted CI runners.** CodSpeed measured a 2.66% coefficient of variation across 100 runs on GitHub-hosted runners. That makes a 2% regression gate fire falsely about 45% of the time ("about 1 out of 2 runs would be a false positive"). Their dedicated runners reached 0.56% CV [14]. The same runner label lands on different CPUs, an Intel Xeon 8370C in 1 of 10 runs and an AMD EPYC 7763 in the rest, with identical images [15]. Hosted Linux runners have no GPU, so WebGPU runs on SwiftShader or Mesa lavapipe. Chrome itself labels that path "Software only, hardware acceleration unavailable" [1]. Fps there measures CPU rasterisation.

**Developer laptops.** The probe shows this directly. Three back-to-back runs on the same build gave a street-pose p95 of 15.6, 18.6 and 33.7 ms [L1]. With 30+ load from parallel Conductor agents, a quarter-resolution run was slower than a full-resolution one [L3]. A workstation running many agents in parallel cannot host perf gates.

**The twin itself.** Traffic and pedestrian systems call `Math.random` about 30 times, and the simulation advances on clamped wall-clock dt [L2]. The same pose therefore draws a different number of vehicles each run (draw calls 3,638 to 3,839 at the aerial pose [L1]). The `?hooks` flag defines `__twin.frozen`, but nothing reads it [L2].

The counters that *are* stable were constant across every run: pass count (23), pipelines (217), textures (37), geometries (558) [L1].

Mature projects respond in the same two ways:
1. **Gate hard on deterministic counters.** `renderer.info` exposes `render.drawCalls`, `triangles`, `frameCalls`, plus `memory.programs`, `textures`, `geometries` and byte totals [10]. Counts depend only on scene content and camera, not on the GPU. They hold on lavapipe, on a Mac and on a T4 alike. Lighthouse CI budgets and `size-limit` apply the same philosophy to web payloads.
2. **Compare timings only as interleaved pairs on one machine.**
   - Pinpoint: "each iteration runs both arms on the same device, eliminating confounding factors" [36].
   - Tachometer round-robins at least 50 samples per arm and reports a 95% CI on the percent change [13]. Note it was archived in 2025, so copy the method, not the dependency.
   - Go's `benchstat` uses Mann-Whitney U at α = 0.05 with 10–20 runs and warns against rerunning until significant [16].
   - Babylon.js uses the paired t-test protocol from the executive summary, plus a 15% ratio floor so that a statistically real 1% shift does not fail a PR [7].
   - MapLibre's harness warns that "identical code routinely drifts a few percent between runs" [32].

### Finding 3: The tooling to run WebGPU headless exists, but software adapters may not run the full post stack

three.js's own CI is the closest working template [3][4]. It runs:
- on `ubuntu-latest` after `apt-get install mesa-vulkan-drivers xvfb`
- forced onto lavapipe through `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json`
- headed under `xvfb-run`
- with Puppeteer flags `--enable-unsafe-webgpu --enable-features=Vulkan --disable-vulkan-surface --ignore-gpu-blocklist --disable-gpu-watchdog`

The important caveat comes from the same file. three.js excludes many WebGPU examples from CI as "too slow", "black screen" (most WebGPU post-processing: AO, DOF, SSGI, TRAA) or with "timing issues". It also rewrites sources to turn timestamp tracking off [3]. The twin uses MRT, SSR, bloom, cascaded shadows and a planar reflector. **Whether it boots on lavapipe is the first spike to run, and it is not a given.** If it does not, Tier 1 moves to the self-hosted Mac (Finding 5), where counters are equally exact.

Chromium's own SwiftShader WebGPU configuration is `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-dawn-features=allow_unsafe_apis --enable-webgpu-developer-features` [2]. That is a second software path to try if lavapipe fails.

Playwright detail: default `headless: true` launches `chromium-headless-shell`, not new headless Chrome. Babylon.js runs its WebGPU Playwright projects with `channel: "chrome"` and `--js-flags=--expose-gc` [6][7]. The existing `tools/shoot-m2.py` uses the headless shell with `--use-angle=metal`, which did expose `apple / metal-3` here [L1].

Real-GPU options on GitHub:
- **Linux T4 larger runners** ("4 CPUs, 1 GPU (Tesla T4), 28 GB RAM") [8]. One field report found Chromium still falling back to llvmpipe until `sudo modprobe nvidia && sudo modprobe nvidia_uvm`. After that, canvas load fell from about 30 s to under 1 s, at 3–4× the per-minute price [9]. That report is about WebGL, not WebGPU.
- **Hosted macOS runners** are VMs. I found no source confirming that headless Chrome gets a usable Metal WebGPU adapter there. It needs a probe job that logs `adapter.info`.
- **A self-hosted Mac mini** gives fixed silicon, real Metal and no neighbours. GitHub warns against self-hosted runners on *public* repos because fork PRs can run code on them [21]. This repo is private.

### Finding 4: Measure tails, compile hitches and GPU time, not average fps

Average fps hides stutter. GamersNexus shows a CPU with a higher average whose 0.1% low fell to 4 fps [38]. Unity's Performance Testing package standardises warmup (at least 80 ms or 3 frames) before measured frames [37]. For this twin the measured window must also exclude the pipeline-compile phase: `main.js` precompiles about 500 pipelines in about 2.1 s warm or about 4.0 s cold behind the loading screen [L2].

Recommended per-pose metric set:
- p50, p95 and p99 frame time
- percentage of frames over 16.7 ms (and over 8.3 ms for 120 Hz)
- longest frame
- hitch count (frames over 2× median, or over 50 ms)
- **new pipelines during the measured window, which must be zero**
- GPU time per frame

The pipeline check matters because the gate should catch the common regression of a material variant appearing mid-session. Toggling SSR compile-time options such as `blurQuality` or `binaryRefine` triggers exactly that [28]. Forum experience adds that first-frame stutter is often texture and geometry upload rather than shaders. The working fix there was a warm-up render with everything visible and frustum culling off [29], which `main.js:679–697` already does for shadows [L2].

For GPU time, WebGPURenderer accepts `trackTimestamp: true`, and `renderer.resolveTimestampsAsync('render')` fills `info.render.timestamp` [10]. Two caveats:
- Chrome quantises timestamps to 100 µs unless `--enable-webgpu-developer-features` is set [11]. That is fine on the bench machine and unacceptable in production.
- timestamps must be resolved every frame or the query pool overflows [42]

Long Animation Frames (`PerformanceObserver` type `long-animation-frame`, Chrome 123+) flags frames over 50 ms with script attribution. It works both for hitch counting in CI and for field data [12]. Puppeteer/CDP `page.metrics()` gives `ScriptDuration` and `JSHeapUsedSize`. Their deltas over N frames give JS ms/frame, and with `--expose-gc`, leak detection [40].

On vsync: `--disable-gpu-vsync --disable-frame-rate-limit` worked here (frame times below 16.7 ms appeared [L1]), but reports say Chrome does not always honour them. Babylon.js sidesteps the issue by timing a tight loop of 2,500 `render()` calls [7]. For the twin the sturdier primary signal is GPU timestamps plus CPU work time per frame, with rAF deltas as a sanity check.

### Finding 5: Recommended gate architecture for this repo

**Prerequisites (one small PR):**

1. **Pin three.js.** Replace `three.js@dev` with `three@0.186.0` (npm on jsDelivr) for `three.webgpu.js`, `three.tsl.js` and `examples/jsm/` together, or with a commit SHA if a dev-only fix is required. Even better, vendor the files so CI is hermetic. jsDelivr caches branch URLs for 12 h and caches each file independently, so core and addons can come from different commits [30]. `dev` received five "Updated builds" commits between 21 and 25 October alone [31]. Bump on purpose, in a PR the gate measures.
2. **Add a `?bench` mode.**
   - Route `Math.random` in `traffic.js`, `pedestrian-system.js` and `cyclists.js` through a seeded PRNG.
   - Step the simulation with a fixed `dt` for N frames before measuring.
   - Freeze time of day.
   - Wire the dead `__twin.frozen` flag.
   - Expose `__twin.bench = { poses, setPose(name), settle(n), stats() }`. `stats()` returns a frame-time histogram, `renderer.info` and the pipeline count.
   - Use `renderer.info.autoReset` semantics as they are: three resets once per `setAnimationLoop` tick, so counts are already per frame across all 23 passes (verified in r186 `Animation.js:81`).
3. **Create a pose list (`tools/perf/poses.json`)** of 6–8 views:
   - aerial
   - Nørre Søgade 37 at street level
   - Dronning Louises Bro looking over Peblinge Sø (worst case for reflection)
   - Nørrebrogade traffic
   - Blågårds Plads
   - one night pose with headlights and the neon sign
   - one swan-mode pose

**Tier 1, `perf-budget` (every PR, required):**
- One headless run with the `?bench` seed.
- Snapshot counters per pose and compare them with committed `tools/perf/budget.json`.
- Fail on any increase above a small tolerance (exact for passes and pipelines, +2% for draws and triangles).
- Post a delta table as a PR comment.
- When a PR *improves* a number, the job prints the new value and the PR must tighten the budget (a ratchet).
- Budget increases are made by editing `budget.json`, so the trade-off is reviewed in the diff and never by label.

Add checks that are cheap in Node and can be lint-style:
- no material construction outside init paths
- no `new Vector3`/`Matrix4` inside `update(` bodies
- `node --test` keeps the existing behavioural perf tests (`traffic-performance.test.cjs`)

Runner choice: `ubuntu-latest` with lavapipe if the spike shows the twin boots there. Otherwise the self-hosted Mac.

**Tier 2, `perf-timing` (self-hosted Mac mini, label `perf` or always on PRs touching `js/`):**
- Serve base and head builds side by side.
- Run the Babylon protocol per pose [7]: 2 warmup passes, then 10 rounds that alternate order, trimming 2 high and 2 low.
- Flag a regression only when the one-tailed paired t-test gives p < 0.05 *and* the slowdown exceeds the threshold:
  - 5% on GPU-time p95
  - 10% on frame-time p95/p99
  - any new hitch above 50 ms
- Treat CV above 10% as inconclusive and rerun once.
- Collect timestamps with `--enable-webgpu-developer-features` [11], log `adapter.info`, and fail if the adapter isn't the expected Apple GPU.
- An override label `perf-accepted` can be applied by the maintainer with a written reason. It is allowed only for Tier 2.

**Absolute floor (also on the Mac):** p95 below 16.7 ms on every pose. This turns the PLAN.md target into a test. Start it as a warning, because the aerial pose fails today. Make it blocking once the reflection and draw-call work (Finding 6) lands.

**Post-merge (nightly on `main`):**
- Run Tier 2's measurements on `main` alone and push them to `github-action-benchmark` (`customSmallerIsBetter`, gh-pages chart). Lower its 200% default alert threshold to about 110% [20].
- Alternatively, use Bencher with a t-test or IQR threshold [17].
- Add change-point detection for slow drift that per-PR thresholds miss. MongoDB's E-Divisive approach "dramatically dropped our false positive rate" [18]. Perfherder's t-test over 12 points before and after a commit is a simpler variant [19].

**Field data (optional, later):** once per session or per 30 s window, send one event carrying:
- p50/p95/p99 frame time
- hitches per minute
- the WebGPU adapter description
- DPR
- build SHA

detect-gpu covers WebGL only, and its data stopped updating in December 2025 [39]. The adapter string is therefore the better dimension.

### Finding 6: Pristine also means runtime guardrails and a short list of high-value fixes

A gate stops regressions, but it doesn't buy headroom. The research and the audit point to a short, ranked list of changes for this code base:

1. **Planar water reflection.** The largest single cost (about +1,700 draws [L3]).
   - Set `bounces: false`.
   - Lower `resolutionScale` from 0.4 if acceptable.
   - Put grass, people, cyclists, furniture details and swans on a layer the reflection camera skips.
   - Enable it only within a distance band of the lakes, not at every height below 450 m.
2. **Draw-call consolidation.**
   - Merge or `BatchedMesh` the swan boats (91 meshes, which is about 7 draws as one batch per material).
   - Set `Object3D.static = true` on building cells, which skips per-object state checks on WebGPU.
   - Trial a `BundleGroup` for static city geometry. It saves CPU encoding only, does no good if rebuilt every frame, and doesn't combine with occlusion queries [26][27].
   - BatchedMesh does per-object frustum culling, and one batch counts as one draw [25].
   - Remember shadow passes multiply every caster across two cascades, so `castShadow` hygiene pays twice.
3. **Adaptive quality.** `setPixelRatio(1.0)` is hard-coded, and nothing adapts [L2].
   - Add a frame-time monitor in the style of R3F's `PerformanceMonitor` (incline and decline with a flip-flop limit) [33].
   - Degrade in this order: reflection resolution, SSR `resolutionScale`/`quality`, shadow map size, then DPR.
   - On Retina, allow DPR up to 1.5 when there is headroom.
4. **Shadows.** The repo already found that an 8192 atlas cost about 20% fps [L2]. Keep 2 cascades of 3072. For static building shadows, consider `shadow.autoUpdate = false` with a refresh on sun change [22][34].
5. **Frame-loop hygiene.**
   - Remove the remaining per-frame closures (`syncInst` in traffic, `yieldToLine` in pedestrians).
   - Move `savePlayerState()` (synchronous `JSON.stringify` plus `localStorage` every 5 s) to `requestIdleCallback`.
   - These are small, but they show up as p99 spikes.
6. **Instrumentation for humans.** Add the three.js Inspector behind `?inspect`. In r181+ it replaces stats-gl, which broke on WebGPU [35]. It gives developers per-pass GPU timing locally.

---

## 3. Synthesis and Insights

**The gate measures two different things.** Tier 1 measures *what the frame asks the GPU to do*: counts, passes, pipelines. That is fully deterministic and hardware-free. Tier 2 measures *how long it takes*, which needs real hardware and paired statistics. Most failed perf-CI efforts try to get the second number from the first kind of machine. In this twin, nearly every regression worth catching is visible first in Tier 1: a new reflected object, an unmerged model, an extra pass, a pipeline variant. That makes Tier 1 the high-value, low-cost core and Tier 2 the safety net for shader cost and CPU-side logic.

**Determinism is the hidden prerequisite.** Neither tier works while the simulation is random and the renderer floats on `@dev`. Both are cheap to fix, and both are worth fixing for correctness anyway.

**The current budget should be set from today's numbers, then ratcheted down.** If the gate ships with today's values (aerial: about 3,800 draws and 23 passes), it immediately stops further growth. The fixes in Finding 6 then each tighten the file. "Pristine" becomes a monotone ratchet rather than a periodic clean-up sprint.

---

## 4. Limitations and Caveats

- All local timings come from a heavily loaded machine. They show the scale of the problem and the noise, not precise figures. The aerial miss of the 60 fps target was consistent across three repeats. The CPU-bound vs GPU-bound split is **not** established.
- Lavapipe/SwiftShader compatibility with the twin's post stack is unverified, and three.js's CI excludes most WebGPU post examples [3].
- Hosted macOS runner GPU access for headless WebGPU is unverified.
- The WebGPU vs WebGL CPU overhead figure comes from one forum benchmark on r183 [23]. Later releases (r184 3× faster TSL compile, r185 descriptor caching [31]) may have narrowed it.
- CI-noise figures come from vendors (CodSpeed) rather than peer-reviewed studies.

---

## 5. Recommendations (ordered)

1. **This week:**
   - Pin three.js to r186, ideally vendored.
   - Add a `?bench` mode (seeded RNG, fixed dt, frame stats on `__twin`, wired `frozen`).
   - Commit `tools/perf/poses.json`.
2. **Spike (half a day):** boot the twin on `ubuntu-latest` + lavapipe + xvfb with three.js's flags [3][4], and log `adapter.info` and a screenshot. That decides where Tier 1 runs.
3. **Tier 1 PR:** a `tools/perf/run.mjs` or `.py` probe (the `.context/perf-probe/probe.py` used here is a working seed), `tools/perf/budget.json` seeded from current values, a GitHub Actions job as a required check, and a PR comment with the delta table.
4. **Price the open branch work against the budget before merging:** the swan boats (about 91 meshes) and the neon lights. Batch the swans.
5. **Tier 2:** buy or dedicate a Mac mini (M4) as a self-hosted runner, used for nothing else. Implement the Babylon interleaved protocol with GPU timestamps. Make it required on PRs touching `js/`, with a maintainer-only `perf-accepted` override.
6. **Headroom work:** reflection layering and range, swan and static batching, an adaptive-quality controller. Then promote the absolute p95 < 16.7 ms floor from warning to blocking.
7. **Nightly trend** with github-action-benchmark and change-point alerts. Later, optionally, field telemetry by adapter.

---

## Bibliography

[1] Chrome for Developers, "Supercharge Web AI model testing: WebGPU, WebGL, and Headless Chrome." https://developer.chrome.com/blog/supercharge-web-ai-testing
[2] Chromium, `third_party/blink/web_tests/FlagSpecificConfig`. https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/web_tests/FlagSpecificConfig
[3] three.js, `test/e2e/puppeteer.js` (dev). https://github.com/mrdoob/three.js/blob/dev/test/e2e/puppeteer.js
[4] three.js, CI workflow (dev). https://raw.githubusercontent.com/mrdoob/three.js/dev/.github/workflows/ci.yml
[5] three.js, `test/e2e/deterministic-injection.js`. https://raw.githubusercontent.com/mrdoob/three.js/dev/test/e2e/deterministic-injection.js
[6] Playwright, "Browsers." https://playwright.dev/docs/browsers
[7] Babylon.js, performance tests README. https://github.com/BabylonJS/Babylon.js/tree/master/packages/tools/tests/test/performance
[8] GitHub Docs, "Larger runners." https://docs.github.com/en/actions/reference/runners/larger-runners
[9] Dave Snider, "GPU tests in GitHub Actions." https://davesnider.com/posts/gputests
[10] three.js docs, `Info`. https://threejs.org/docs/pages/Info.html
[11] Chrome for Developers, "WebGPU developer features." https://developer.chrome.com/docs/web-platform/webgpu/developer-features
[12] Chrome for Developers, "Long Animation Frames API." https://developer.chrome.com/docs/web-platform/long-animation-frames
[13] Google, Tachometer (archived). https://github.com/google/tachometer
[14] CodSpeed, "Benchmarks in CI without noise." https://codspeed.io/blog/benchmarks-in-ci-without-noise
[15] CodSpeed, "Unrelated benchmark regression." https://codspeed.io/blog/unrelated-benchmark-regression
[16] Go, `benchstat`. https://pkg.go.dev/golang.org/x/perf/cmd/benchstat
[17] Bencher, "Thresholds and alerts." https://bencher.dev/docs/explanation/thresholds/
[18] Daly et al., "Change Point Detection in Software Performance Testing," ICPE 2020. https://arxiv.org/abs/2003.00584
[19] Mozilla, Performance Sheriffing. https://wiki.mozilla.org/TestEngineering/Performance/Sheriffing
[20] benchmark-action, github-action-benchmark. https://github.com/benchmark-action/github-action-benchmark
[21] GitHub Docs, "Security hardening for GitHub Actions." https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
[22] Utsubo, "100 Three.js tips." https://www.utsubo.com/blog/threejs-best-practices-100-tips
[23] three.js forum, "WebGPURenderer 2x slower CPU and 5–10x slower first frame than WebGLRenderer on many-mesh scenes (r183)." https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904
[24] three.js forum, "Understanding about WebGPURenderer." https://discourse.threejs.org/t/understanding-about-webgpurenderer/86635
[25] three.js docs, `BatchedMesh`. https://threejs.org/docs/pages/BatchedMesh.html
[26] three.js docs, `BundleGroup`. https://threejs.org/docs/pages/BundleGroup.html
[27] Brandon Jones, "WebGPU render bundle best practices." https://toji.dev/webgpu-best-practices/render-bundles
[28] three.js docs, `SSRNode`. https://threejs.org/docs/pages/SSRNode.html
[29] three.js forum, "Reduce first render lag — compileAsync is not doing anything." https://discourse.threejs.org/t/reduce-first-render-lag-renderer-compileasync-is-not-doing-anything/86191
[30] jsDelivr, README (caching and versioning). https://github.com/jsdelivr/jsdelivr
[31] three.js, releases. https://github.com/mrdoob/three.js/releases
[32] MapLibre GL JS, benchmark README. https://github.com/maplibre/maplibre-gl-js/blob/main/test/bench/README.md
[33] React Three Fiber, "Scaling performance." https://r3f.docs.pmnd.rs/advanced/scaling-performance
[34] three.js docs, `CSMShadowNode`. https://threejs.org/docs/pages/CSMShadowNode.html
[35] three.js forum, "WebGPU r181 FYI: stats-gl no longer compatible with WebGPU." https://discourse.threejs.org/t/webgpu-r181-fyi-stats-gl-no-longer-compatible-with-webgpu/87944
[36] Chromium, "Perf trybots" (Pinpoint). https://chromium.googlesource.com/chromium/src/+/main/docs/speed/perf_trybots.md
[37] Unity, Performance Testing — Measure.Frames. https://docs.unity3d.com/Packages/com.unity.test-framework.performance@3.0/manual/measure-frames.html
[38] GamersNexus, "Testing methodology explained: 1% lows and delta-T." https://gamersnexus.net/site-news/2513-testing-methodology-explained-1percent-lows-and-delta-t
[39] pmndrs, detect-gpu. https://github.com/pmndrs/detect-gpu
[40] Puppeteer, `Page.metrics()`. https://pptr.dev/api/puppeteer.metrics
[41] three.js, `src/nodes/utils/ReflectorNode.js` (dev). https://github.com/mrdoob/three.js/blob/dev/src/nodes/utils/ReflectorNode.js
[42] three.js forum, "r173 resolve timestamps error message." https://discourse.threejs.org/t/r173-resolve-timestamps-error-message/77370

**Local evidence**

[L1] Probe run 1 (3 repeats, 1440×900, uncapped):

| Pose | p50 | p95 | Draw calls | Triangles | Passes | Pipelines | Boot |
|---|---|---|---|---|---|---|---|
| aerial | 24.1–24.7 ms | 26.5–27.1 ms | 3,638–3,839 | 7.8 M | 23 | 217 | 4.7 s to `__twin.world` (warm cache) |
| street-ns37 | 14.2–15.1 ms | 15.6 / 18.6 / 33.7 ms | 2,183–2,388 | 6.4 M | 23 | 217 | |

Adapter `apple / metal-3`.

[L2] Repository audit: `index.html:14–17`, `js/main.js:38–47, 541–545, 633–649, 651–732`, `js/lighting.js:205–215`, `js/water-cph.js:127, ~250`, `js/swan-boat.js`, `js/irma-neon.js:99–111, 167`, `docs/m4-colours/fps.json`, `docs/m4-water-colour/fps.json`, `docs/PLAN.md:94`.

[L3] Probe run 2 (single repeat, load average 33.75):

| Configuration | Aerial p50 | Street p50 | Aerial draw calls |
|---|---|---|---|
| 720×450 | 29.7 ms | 17.7 ms | |
| `?water=simple` | 19.5 ms | | 2,011 (22 passes) |
| `?debug=nograss` | 43.8 ms | | |

The timings here are unreliable because of host load; the draw and pass counts are reliable.

## Methodology Appendix

- **Retrieval streams:** four parallel agents (WebSearch and WebFetch), about 190 tool calls, 2026-10-26. Sources marked search-only or unverified by the agents were excluded from load-bearing claims, or are flagged in Limitations.
- **Verification:** Babylon.js protocol (README text), Tachometer archive status (GitHub API: `archived: true`), CodSpeed 2.66% (page text), three r186 `Info.reset` call site (`Animation.js:81`, `if (this.info.autoReset === true) this.info.reset()`).
- **Measurement:** Playwright Chromium headless shell, `--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist --disable-frame-rate-limit --disable-gpu-vsync`. Camera via `__twin.cameraSystem.debugView`, 2.5 s settle, 4 s of rAF deltas per pose, then a `renderer.info` snapshot.
