import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PHOTO, selectPhotoSet, wallDistance, densityScale } from '../js/facade-lod.js';
import { replayPhotoLoop, tierReversals, tierOscillations } from './helpers/photo-sim.mjs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const budget = readJson('../tools/perf/texture-memory-budget.json');
const geodata = readJson('../data/cph-geodata.json');

function ringCentre(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / n, z / n];
}

// the photo walls as the engine plans them: footprint rings from the ground to the eave (js/appearance.js texturedWalls emits the
// exact wall feet; the rings are a superset)
const candidates = geodata.buildings
  .filter((b) => b.wall_material !== 'glas' && b.ring?.length >= 6 && b.observed?.atlas?.size && b.observed?.atlas?.walls?.length)
  .map((b) => {
    const [cx, cz] = ringCentre(b.ring);
    return { id: b.id, cx, cz, ring: b.ring, holes: b.holes || [], y0: b.ground ?? 0, y1: b.eave ?? (b.ground ?? 0) + 10, walls: { size: b.observed.atlas.size } };
  });

/** Every candidate whose photo the shader can draw from (x, y, z): a photo wall nearer than PHOTO.far and one beyond close0. */
const inBand = (x, y, z) => candidates.filter((c) => { const d = wallDistance(c, x, y, z); return d.near < PHOTO.far && d.far > PHOTO.close0; });

function sampleRoute(y) {
  const samples = [];
  let currentTiers = new Map();
  let density;
  const route = budget.cameraRoute;
  const plan = (x, z) => {
    const p = selectPhotoSet(candidates, x, z, PHOTO, currentTiers, y, density);
    samples.push({ x, z, ...p });
    currentTiers = new Map([...p.qualityById].map(([id, quality]) => [id, quality.tier]));
    density = p.density;
  };
  for (let segment = 0; segment < route.length - 1; segment++) {
    const [x0, z0] = route[segment];
    const [x1, z1] = route[segment + 1];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(length / budget.sampleEveryMetres));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      plan(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    }
  }
  plan(...route.at(-1));
  return samples;
}

test('facade texture budget stays bounded while the camera crosses the city, and the photo band is complete', () => {
  assert.ok(candidates.length > 1000, `expected full city atlas metadata, got ${candidates.length} candidates`);
  assert.equal(PHOTO.maxResidentBytes, budget.maxBytes, 'the committed budget and runtime budget must match');
  assert.equal(PHOTO.budget, budget.maxResidentAtlases, 'the committed count cap and runtime cap must match');

  const samples = sampleRoute(budget.cameraHeight);
  assert.ok(samples.length >= 100, `camera route only produced ${samples.length} samples`);
  let peak = { bytes: 0, x: 0, z: 0, residents: 0 };
  let minDensity = 1;
  let band = 0;
  for (const sample of samples) {
    const sum = [...sample.qualityById.values()].reduce((total, q) => total + q.bytes, 0);
    const at = `(${sample.x.toFixed(1)}, ${sample.z.toFixed(1)})`;
    assert.equal(sample.residentBytes, sum, 'reported bytes must equal selected atlas estimates');
    assert.ok(sample.residentBytes <= budget.maxBytes, `budget exceeded at ${at}: ${sample.residentBytes}`);
    assert.ok(sample.want.length <= budget.maxResidentAtlases, `count exceeded at ${at}`);
    const want = new Set(sample.want);
    const missing = inBand(sample.x, budget.cameraHeight, sample.z).filter((c) => !want.has(c.id));
    assert.deepEqual(missing.map((c) => c.id), [], `photo band incomplete at ${at}`);
    band = Math.max(band, inBand(sample.x, budget.cameraHeight, sample.z).length);
    minDensity = Math.min(minDensity, sample.density);
    if (sample.residentBytes > peak.bytes) peak = { bytes: sample.residentBytes, x: sample.x, z: sample.z, residents: sample.want.length };
  }
  const densitySteps = samples.filter((sample, i) => i > 0 && sample.density !== samples[i - 1].density).length;
  console.log(`route: ${densitySteps} density steps over ${samples.length} samples`);
  console.log(`camera samples=${samples.length}; peak facade reservation=${(peak.bytes / 1024 / 1024).toFixed(1)} MiB at (${peak.x.toFixed(0)}, ${peak.z.toFixed(0)}); resident=${peak.residents}; largest photo band=${band}; lowest density=${minDensity} texels/pixel`);
});

test('from the air no atlas is resident: every wall is beyond the photo fade-out', () => {
  for (const [x, z] of budget.cameraRoute) {
    const plan = selectPhotoSet(candidates, x, z, PHOTO, new Map(), budget.aerialHeight);
    assert.equal(plan.want.length, 0, `atlases resident ${budget.aerialHeight} m above (${x}, ${z})`);
  }
});

test('quality follows the on-screen texel density where the photo shows, with hysteresis', () => {
  const probe = (d) => ({ id: 'probe', cx: d, cz: 0, walls: { size: [600, 400], segs: [d, -5, d, 5] } });
  const tier = (d, current) => selectPhotoSet([probe(d)], 0, 0, PHOTO, new Map(current ? [['probe', current]] : [])).qualityById.get('probe').tier;
  // alone, nothing limits the density: native where a 10 cm texel is still a pixel or more, from the end of the 45-80 m fade-in
  assert.equal(tier(80), 1);
  assert.equal(tier(90), 1);
  // a wall that is only ever seen mid-fade-in (60 m: 39 % opaque) needs fewer
  assert.ok(tier(60) < 1 && tier(60) >= 0.5, `60 m: ${tier(60)}`);
  // past ~94 m a pixel covers more than 10 cm, and the photo fades out over 115-150 m: fewer texels
  const tiers = [100, 115, 130, 145].map((d) => tier(d));
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i] <= tiers[i - 1], `tiers coarsen with distance: ${tiers}`);
  assert.ok(tiers.at(-1) <= 0.25, `nearly faded out at 145 m: ${tiers}`);
  // a wall at 30 m that runs on to 90 m is sized for the walls where its photo is seen, not left out or sized for 30 m only
  assert.equal(densityScale(30, 90, 0.1), densityScale(77, 90, 0.1));
  // hysteresis: the resident tier holds within PHOTO.qualityHoldSteps steps of the planned one
  const planned = tier(130);
  const i = PHOTO.qualitySteps.indexOf(planned);
  assert.equal(tier(130, PHOTO.qualitySteps[i - PHOTO.qualityHoldSteps]), PHOTO.qualitySteps[i - PHOTO.qualityHoldSteps]);
  assert.equal(tier(130, PHOTO.qualitySteps[i + PHOTO.qualityHoldSteps + 1]), planned);
});

test('a byte budget too small for every building at full density lowers the density for all, nearest still first', () => {
  const many = Array.from({ length: 60 }, (_, k) => ({ id: `b${k}`, cx: 50 + k * 1.5, cz: 0, walls: { size: [2000, 1000] } }));
  const roomy = selectPhotoSet(many, 0, 0, { ...PHOTO, maxResidentBytes: Infinity });
  const tight = selectPhotoSet(many, 0, 0, PHOTO);
  assert.equal(tight.want.length, 60, 'all of them resident');
  assert.ok(tight.residentBytes <= PHOTO.maxResidentBytes);
  assert.ok(tight.density < roomy.density, `density ${tight.density} < ${roomy.density}`);
  for (const id of tight.want) assert.ok(tight.qualityById.get(id).tier <= roomy.qualityById.get(id).tier);
});

// --------------------------------------------------------------------------------------------------- churn: the residency loop replayed
// js/facade-lod.js createPhotoBudget driving simulated photo managers (tests/helpers/photo-sim.mjs: loads settle after 120 ms, one GPU
// upload per frame) in the busiest stretches of the route: once the set has converged, a camera that stands still or wobbles like the
// chase cam starts no load at all, and a moving one loads in proportion to the distance it covers, not the time.
const churnPoints = [[570, 585], [-7, -7], [-250, 200], [100, -180]];

function afterConvergence(run, from) {
  const late = run.plans.filter((plan) => plan.t >= from);
  const changed = late.filter((plan, i) => i > 0 && (plan.tiers.size !== late[i - 1].tiers.size || [...plan.tiers].some(([id, tier]) => late[i - 1].tiers.get(id) !== tier)));
  return { starts: run.started.filter((s) => s.t >= from), changed, plans: late.length, densities: new Set(late.map((plan) => plan.density)) };
}

const cameras = {
  // standing still at chase-cam height
  still: { settle: 20, at: (x, z) => () => [x, 3.6, z] },
  // the chase cam behind a car at rest or crawling: a slow +-0.5 m / +-0.3 m wobble
  jitter: { settle: 20, at: (x, z) => (t) => [x + 0.5 * Math.sin(t * 1.9), 3.6 + 0.3 * Math.sin(t * 2.7), z + 0.5 * Math.cos(t * 1.3)] },
  // arriving by air from 800 m away (the residents were loaded for another place and other tiers), then the street from t = 10 s
  arrive: { settle: 35, at: (x, z) => (t) => { const f = Math.min(1, t / 10); return f < 1 ? [x + 600 * (1 - f), 90, z - 500 * (1 - f)] : [x, 3.6, z]; } }
};

for (const [name, { settle, at: camera }] of Object.entries(cameras)) {
  test(`churn: ${name} camera, the set converges and then starts no load`, () => {
    for (const [x, z] of churnPoints) {
      const run = replayPhotoLoop(candidates, camera(x, z), { seconds: settle + 40 });
      const after = afterConvergence(run, settle);
      const at = `${name} at (${x}, ${z})`;
      assert.ok(after.plans > 100, `${at}: ${after.plans} plans after convergence`);
      assert.deepEqual(after.starts, [], `${at}: loads after convergence`);
      assert.deepEqual(after.changed.map((plan) => plan.t), [], `${at}: resident tiers changed after convergence`);
      assert.equal(after.densities.size, 1, `${at}: density changed after convergence: ${[...after.densities]}`);
      assert.deepEqual(tierReversals(run.plans), [], `${at}: tier oscillation`);
      assert.equal(run.counts.evictions, 0, `${at}: wanted atlases evicted to make room`);
      // the whole photo band holds its atlas
      const [cx, cy, cz] = camera(x, z)(settle + 40);
      const resident = new Set(run.plans.at(-1).tiers.keys());
      assert.deepEqual(inBand(cx, cy, cz).filter((c) => !resident.has(c.id)).map((c) => c.id), [], `${at}: photo band incomplete`);
    }
  });
}

/** A camera along `path` ([[x, z], ...]) at `speed` m/s and chase-cam height after `wait` s at its start, pausing `stop` s halfway. */
function drive(path, speed, { wait = 20, stop = 0 } = {}) {
  const legs = [];
  let length = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    legs.push([length, l, path[i], path[i + 1]]);
    length += l;
  }
  const half = length / 2 / speed;
  const travelled = (t) => {
    const s = Math.max(0, t - wait);
    return Math.min(length, speed * (s < half ? s : s < half + stop ? half : s - stop));
  };
  const camera = (t) => {
    const d = travelled(t);
    const [a, l, p, q] = legs.find(([a0, l0]) => d <= a0 + l0) || legs.at(-1);
    const f = l > 0 ? (d - a) / l : 0;
    return [p[0] + (q[0] - p[0]) * f + 0.3 * Math.sin(t * 1.9), 3.6 + 0.2 * Math.sin(t * 2.7), p[1] + (q[1] - p[1]) * f];
  };
  return { camera, length, seconds: wait + length / speed + stop + 10, half: wait + half };
}

test('churn: driving, loads follow the distance covered (not the time), never oscillate, and stop when the car stops', () => {
  const route = budget.cameraRoute.slice(2, 6); // through the densest blocks of the district
  // twice the time over the same distance: a load per hold step crossed, not per plan (both speeds well inside the load throughput)
  const speed = 1.5;
  const slow = drive(route, speed);
  const fast = drive(route, speed * 2);
  const loads = (d) => { const run = replayPhotoLoop(candidates, d.camera, { seconds: d.seconds }); return { run, n: run.started.filter((s) => s.t >= 20).length }; };
  const a = loads(slow);
  const b = loads(fast);
  const replacements = (r) => r.run.started.filter((s) => s.t >= 20 && s.replacement).length;
  console.log(`drive ${slow.length.toFixed(0)} m: ${a.n} loads (${replacements(a)} replacements) at ${speed} m/s, ${b.n} (${replacements(b)}) at ${speed * 2} m/s; single tier reversals ${tierReversals(a.run.plans, 6).length} / ${tierReversals(b.run.plans, 6).length}`);
  assert.ok(a.n <= b.n * 1.5, `${a.n} loads at ${speed} m/s against ${b.n} at ${speed * 2} m/s over the same ${slow.length.toFixed(0)} m`);
  assert.deepEqual(tierOscillations(a.run.plans), [], `tier oscillation driving at ${speed} m/s`);
  assert.deepEqual(tierOscillations(b.run.plans), [], `tier oscillation driving at ${speed * 2} m/s`);
  assert.equal(a.run.counts.evictions + b.run.counts.evictions, 0, 'wanted atlases evicted while driving');
  // a stop halfway: a few seconds to catch up, then nothing until the car moves on
  const paused = drive(route, 6, { stop: 30 });
  const run = replayPhotoLoop(candidates, paused.camera, { seconds: paused.seconds });
  const during = run.started.filter((s) => s.t >= paused.half + 10 && s.t < paused.half + 30);
  assert.deepEqual(during, [], 'loads while the car stands');
});

test('churn: the camera route replayed through the loop shows no tier oscillation', () => {
  const route = budget.cameraRoute;
  const d = drive(route, 10, { wait: 0 });
  const run = replayPhotoLoop(candidates, (t) => { const [x, , z] = d.camera(t); return [x, budget.cameraHeight, z]; }, { seconds: d.seconds, fps: 15 });
  const reversals = tierReversals(run.plans, 6);
  console.log(`route through the loop: ${d.length.toFixed(0)} m, ${run.started.length} loads (${run.started.filter((s) => s.replacement).length} replacements), ${run.counts.densityChanges} density steps, ${reversals.length} single tier reversals`);
  assert.deepEqual(tierOscillations(run.plans), [], 'tier oscillation along the route');
  assert.equal(run.counts.evictions, 0, 'wanted atlases evicted along the route');
});

test('detail overrides: their texture budget is committed, and photo + override textures stay under the combined cap', async () => {
  const { OVERRIDE, readOverrideLayer, createOverrideBudget, admitOverrides } = await import('../js/detail-overrides.js');
  assert.equal(OVERRIDE.maxTextureBytes, budget.overrideMaxBytes, 'the committed override budget and the runtime budget must match');
  assert.equal(OVERRIDE.maxMeshes, budget.overrideMaxMeshes);
  assert.ok(PHOTO.maxResidentBytes + OVERRIDE.maxTextureBytes <= budget.combinedMaxBytes, 'photo + override budgets above the combined cap');
  // Nyhavn, the busiest photo band: every override admitted from the canal, within its budget
  const nyhavn = readOverrideLayer(readJson('./fixtures/overrides-nyhavn.json'));
  const b = createOverrideBudget();
  for (const at of [{ x: 1760, z: 190 }, { x: 1600, z: 140 }, { x: 2100, z: 300 }]) admitOverrides(nyhavn, at, b);
  assert.ok(b.peak <= OVERRIDE.maxTextureBytes);
  assert.equal(b.memory().meshes, nyhavn.entries.size);
});
