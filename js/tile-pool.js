// js/tile-pool.js
// A small pool of Web Workers running the CPU halves of the tile layers (js/tile-worker.js: buildings, roads, furniture). `run(kind, job)` resolves
// with the result (typed arrays arrive as transferables: no copy back). When Workers are unavailable, fail to start or die, `run`
// resolves null and the caller computes the job itself (buildRealBuildings does, a few buildings at a time between frame waits), so the
// twin works without them (tests, old browsers).

export function createTilePool({ size = null, url = new URL('./tile-worker.js', import.meta.url), WorkerCtor = globalThis.Worker } = {}) {
  const n = size ?? Math.max(1, Math.min(2, ((globalThis.navigator?.hardwareConcurrency) || 4) - 2));
  const workers = [];
  const queue = [];
  const stats = { jobs: 0, inline: 0, busyMs: 0, maxMs: 0, workers: 0, failed: 0, byKind: {} };
  let broken = !WorkerCtor;

  function spawn() {
    if (broken) return null;
    try {
      const w = { worker: new WorkerCtor(url, { type: 'module' }), job: null, started: 0 };
      w.worker.onmessage = (event) => {
        const { id, result, error } = event.data;
        const job = w.job;
        w.job = null;
        if (job && job.id === id) {
          const ms = performance.now() - w.started;
          stats.busyMs += ms;
          stats.maxMs = Math.max(stats.maxMs, ms);
          if (error) { stats.failed++; console.warn('[cph] building worker:', error); job.resolve(null); } else job.resolve(result);
        }
        pump();
      };
      w.worker.onerror = (event) => {
        console.warn('[cph] building worker failed, computing on the main thread:', event.message || event);
        broken = true;
        stats.failed++;
        const job = w.job;
        w.job = null;
        job?.resolve(null);
        for (const q of queue.splice(0)) q.resolve(null);
        for (const o of workers.splice(0)) o.worker.terminate();
      };
      workers.push(w);
      stats.workers = workers.length;
      return w;
    } catch (error) {
      console.warn('[cph] no building workers:', error?.message || error);
      broken = true;
      return null;
    }
  }

  let nextId = 1;
  function pump() {
    while (queue.length) {
      let w = workers.find((x) => !x.job);
      if (!w && workers.length < n) w = spawn();
      if (!w) return;
      const job = queue.shift();
      w.job = job;
      w.started = performance.now();
      try {
        w.worker.postMessage({ id: job.id, kind: job.kind, job: job.payload });
      } catch (error) {
        w.job = null;
        stats.failed++;
        console.warn('[cph] building job not sent:', error?.message || error);
        job.resolve(null);
      }
    }
  }

  return {
    stats,
    get available() { return !broken; },
    /** @returns {Promise<object|null>} the result, or null when the caller has to compute it */
    run(kind, payload) {
      stats.jobs++;
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      if (broken) { stats.inline++; return Promise.resolve(null); }
      return new Promise((resolve) => {
        queue.push({ id: nextId++, kind, payload, resolve });
        pump();
      });
    },
    dispose() {
      for (const w of workers.splice(0)) w.worker.terminate();
      broken = true;
    }
  };
}
