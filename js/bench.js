// js/bench.js
// `?bench[=seed]` makes the twin measurable (tools/perf/measure.py): Math.random is seeded before any other module
// runs (main.js imports this first), the simulation starts frozen and only advances in fixed 1/60 s steps on request,
// and every frame's wall and CPU time is kept so a fixed camera pose gives the same draw calls and comparable timings.

const param = new URLSearchParams(location.search).get('bench');
const SEED = param === null ? null : (Number.parseInt(param, 10) || 1);

if (SEED !== null) {
  // mulberry32
  let a = SEED >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP = 1 / 60;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const round = (v) => Math.round(v * 100) / 100;

function createBench({ renderer, cameraSystem }) {
  let pendingSteps = 0;
  let onAdvanced = null;
  let recording = null;

  const info = () => {
    const { render, memory } = renderer.info;
    return {
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      passes: render.frameCalls,
      pipelines: memory.programs,
      geometries: memory.geometries,
      textures: memory.textures,
      memoryBytes: memory.total
    };
  };

  return {
    seed: SEED,
    get frozen() { return pendingSteps === 0; },
    // The simulation step for this frame: STEP while advancing, 0 (frozen: no traffic, controllers or audio) otherwise
    step() {
      if (pendingSteps === 0) return 0;
      if (--pendingSteps === 0 && onAdvanced) { onAdvanced(); onAdvanced = null; }
      return STEP;
    },
    record(frameMs, cpuMs) {
      if (recording) { recording.frame.push(frameMs); recording.cpu.push(cpuMs); }
    },
    setPose({ pos, look, fov = 60 }) {
      cameraSystem.debugView = { pos, look, fov };
    },
    advance(frames = 60) {
      pendingSteps += frames;
      return new Promise((resolve) => { onAdvanced = resolve; });
    },
    info,
    // Wall-clock frame times (rAF deltas) and the main thread's own time per frame over `ms`, plus the counters
    measure(ms = 4000) {
      const pipelinesBefore = renderer.info.memory.programs;
      recording = { frame: [], cpu: [] };
      return new Promise((resolve) => setTimeout(() => {
        const frame = recording.frame.slice(1).sort((x, y) => x - y); // the first delta straddles the start
        const cpu = recording.cpu.sort((x, y) => x - y);
        recording = null;
        const median = quantile(frame, 0.5);
        resolve({
          frames: frame.length,
          p50: round(median),
          p95: round(quantile(frame, 0.95)),
          p99: round(quantile(frame, 0.99)),
          max: round(frame[frame.length - 1]),
          over16: round((frame.filter((v) => v > 1000 / 60).length / frame.length) * 100),
          hitches: frame.filter((v) => v > Math.max(2 * median, 50)).length,
          cpuP50: round(quantile(cpu, 0.5)),
          cpuP95: round(quantile(cpu, 0.95)),
          newPipelines: renderer.info.memory.programs - pipelinesBefore,
          ...info()
        });
      }, ms));
    }
  };
}

export { SEED as BENCH_SEED, createBench };
