import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PHOTO, selectPhotoSet, wallDistance, densityScale } from '../js/facade-lod.js';

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
  const route = budget.cameraRoute;
  const plan = (x, z) => {
    const p = selectPhotoSet(candidates, x, z, PHOTO, currentTiers, y);
    samples.push({ x, z, ...p });
    currentTiers = new Map([...p.qualityById].map(([id, quality]) => [id, quality.tier]));
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
