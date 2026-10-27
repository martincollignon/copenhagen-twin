// tests/helpers/photo-sim.mjs
// A headless replay of the photo-facade residency loop: js/facade-lod.js createPhotoBudget driving photo managers that behave like
// js/buildings-real.js createTexManager (in-flight loads that settle after a latency, at most one GPU upload per frame, stale loads
// aborted by prune or discarded when they settle, replacements keep the old atlas until the new one is in). No three.js, no images.

import { readFileSync } from 'node:fs';
import * as lod from '../../js/facade-lod.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

function ringCentre(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / n, z / n];
}

let districtCache = null;
/** The district's photo candidates (data/cph-geodata.json), as tests/texture-memory-budget.test.mjs builds them. */
export function districtCandidates() {
  if (districtCache) return districtCache;
  const geodata = readJson('../../data/cph-geodata.json');
  districtCache = geodata.buildings
    .filter((b) => b.wall_material !== 'glas' && b.ring?.length >= 6 && b.observed?.atlas?.size && b.observed?.atlas?.walls?.length)
    .map((b) => {
      const [cx, cz] = ringCentre(b.ring);
      return { id: b.id, cx, cz, ring: b.ring, holes: b.holes || [], y0: b.ground ?? 0, y1: b.eave ?? (b.ground ?? 0) + 10, walls: { size: b.observed.atlas.size } };
    });
  return districtCache;
}

/** A photo manager (createTexManager's contract) over `candidates`, with simulated loads. */
function simManager(candidates, sim) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const state = {
    enabled: true, disposed: false, probed: false, probing: false, resident: new Map(), loading: new Map(), failed: new Set(),
    failedTiers: new Map(), desiredQuality: new Map()
  };
  const m = {
    state, candidates, loader: true,
    has: (id) => byId.has(id),
    prune(wantSet, qualityById) {
      state.desiredQuality = qualityById;
      for (const [id, job] of state.loading) {
        const q = qualityById.get(id);
        if (!q || q.width !== job.width || q.height !== job.height) job.aborted = true;
      }
      for (const id of [...state.resident.keys()]) if (!wantSet.has(id)) m.evict(id);
      for (const [id, r] of state.resident) {
        const q = qualityById.get(id);
        if (q && r.width === q.width && r.height === q.height) r.tier = q.tier;
      }
    },
    evict(id) { state.resident.delete(id); },
    start(id, q) {
      const job = { tier: q.tier, width: q.width, height: q.height, bytes: q.bytes, replacement: state.resident.has(id), aborted: false, ready: sim.now + sim.latency };
      state.loading.set(id, job);
      sim.started.push({ t: sim.now, id, tier: q.tier, replacement: job.replacement });
    },
    /** Settles what is due: an aborted request goes at once, a decoded one waits for the frame's single upload slot. */
    tick() {
      for (const [id, job] of state.loading) {
        if (job.aborted) {
          state.loading.delete(id);
          sim.counts.aborted++;
          state.probing = false;
          continue;
        }
        if (job.ready > sim.now || sim.uploadUsed) continue;
        sim.counts.decodes++;
        state.loading.delete(id);
        state.probing = false;
        const q = state.desiredQuality.get(id);
        if (!q || q.width !== job.width || q.height !== job.height) { sim.counts.discarded++; continue; }
        sim.uploadUsed = true;
        sim.counts.uploads++;
        state.resident.set(id, { tier: job.tier, width: job.width, height: job.height, bytes: job.bytes });
      }
    }
  };
  return m;
}

/**
 * Runs the residency loop over `candidates` (split into managers by a `cell` metre grid, like the streamed tiles) while `camera(t)`
 * ([x, y, z] for t in seconds) moves, for `seconds` at `fps`. Returns the budget, the per-plan record ({ t, density, tiers: Map }),
 * the load starts and the counters (decodes, uploads, aborted, discarded) plus the budget's own stats.
 */
export function replayPhotoLoop(candidates, camera, { seconds = 60, fps = 30, latency = 0.12, cell = 250, p = lod.PHOTO, module = lod, logSize = 0, blurSteps = p.qualityHoldSteps } = {}) {
  const sim = { now: 0, latency, uploadUsed: false, started: [], counts: { decodes: 0, uploads: 0, aborted: 0, discarded: 0 } };
  const cells = new Map();
  for (const c of candidates) {
    const key = `${Math.floor(c.cx / cell)}_${Math.floor(c.cz / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(c);
  }
  const managers = [...cells.values()].map((list) => simManager(list, sim));
  const budget = module.createPhotoBudget({ p });
  if (budget.stats) budget.stats.logSize = logSize;
  for (const m of managers) budget.add(m);
  const plans = [];
  const frames = Math.round(seconds * fps);
  for (let f = 0; f <= frames; f++) {
    sim.now = f / fps;
    sim.uploadUsed = false;
    for (const m of managers) m.tick();
    const [x, y, z] = camera(sim.now);
    if (budget.update(x, z, sim.now * 1000, y)) {
      const tiers = new Map();
      const density = budget.memory().density;
      for (const m of managers) for (const [id, r] of m.state.resident) tiers.set(id, r.tier);
      // how far the residents are from the tiers this plan asks for: wanted without an atlas, and coarser than asked by more than the hold
      const asked = budget.lastPlan?.qualityById;
      let missing = 0;
      let blurred = 0;
      if (asked) {
        for (const [id, q] of asked) {
          const tier = tiers.get(id);
          if (tier === undefined) missing++;
          else if (p.qualitySteps.indexOf(tier) - p.qualitySteps.indexOf(q.tier) > blurSteps) blurred++;
        }
      }
      plans.push({ t: sim.now, density, tiers, x, y, z, wanted: asked?.size ?? 0, missing, blurred });
    }
  }
  const { log, logSize: _size, ...stats } = budget.stats || {};
  return { budget, plans, started: sim.started, counts: { ...stats, ...sim.counts }, log: log || [], managers };
}

/**
 * Tier oscillation in a sequence of plans: a building whose resident tier goes back to the tier it had before its previous change
 * (A -> B -> A) within `window` plans. Returns [{ id, t, tiers: [A, B] }].
 */
export function tierReversals(plans, window = 20) {
  const last = new Map(); // id -> { tier, before (the tier before the last change), index (of the last change) }
  const out = [];
  plans.forEach((plan, index) => {
    for (const [id, tier] of plan.tiers) {
      const prev = last.get(id);
      if (!prev) { last.set(id, { tier, before: undefined, index }); continue; }
      if (tier === prev.tier) continue;
      if (tier === prev.before && index - prev.index <= window) out.push({ id, t: plan.t, tiers: [tier, prev.tier] });
      last.set(id, { tier, before: prev.tier, index });
    }
  });
  return out;
}

/**
 * Tier oscillation proper: a building whose resident tier flips back and forth (A -> B -> A -> B) within `window` plans. A single
 * reversal (tierReversals) can be real, e.g. a building passed at its closest point while the density steps down; a repeated one is a loop.
 */
export function tierOscillations(plans, window = 20) {
  const seen = new Map(); // id -> [{ tier, index }] of its last changes
  const out = [];
  plans.forEach((plan, index) => {
    for (const [id, tier] of plan.tiers) {
      const h = seen.get(id) || [];
      if (h.length && h.at(-1).tier === tier) continue;
      h.push({ tier, index });
      if (h.length > 4) h.shift();
      seen.set(id, h);
      if (h.length === 4 && h[0].tier === h[2].tier && h[1].tier === h[3].tier && index - h[0].index <= window) out.push({ id, t: plan.t, tiers: [h[0].tier, h[1].tier] });
    }
  });
  return out;
}
