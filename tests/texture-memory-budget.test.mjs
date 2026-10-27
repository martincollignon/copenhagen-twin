import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PHOTO, selectPhotoSet } from '../js/facade-lod.js';

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

const candidates = geodata.buildings
  .filter((b) => b.wall_material !== 'glas' && b.ring?.length >= 6 && b.observed?.atlas?.size && b.observed?.atlas?.walls?.length)
  .map((b) => {
    const [cx, cz] = ringCentre(b.ring);
    return { id: b.id, cx, cz, walls: { size: b.observed.atlas.size } };
  });

function sampleRoute() {
  const samples = [];
  let currentTiers = new Map();
  const route = budget.cameraRoute;
  for (let segment = 0; segment < route.length - 1; segment++) {
    const [x0, z0] = route[segment];
    const [x1, z1] = route[segment + 1];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(length / budget.sampleEveryMetres));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const plan = selectPhotoSet(candidates, x, z, PHOTO, currentTiers);
      samples.push({ x, z, ...plan });
      currentTiers = new Map([...plan.qualityById].map(([id, quality]) => [id, quality.tier]));
    }
  }
  const [x, z] = route.at(-1);
  const finalPlan = selectPhotoSet(candidates, x, z, PHOTO, currentTiers);
  samples.push({ x, z, ...finalPlan });
  return samples;
}

test('facade texture budget stays bounded while the camera crosses the city', () => {
  assert.ok(candidates.length > 1000, `expected full city atlas metadata, got ${candidates.length} candidates`);
  assert.equal(PHOTO.maxResidentBytes, budget.maxBytes, 'the committed budget and runtime budget must match');
  assert.equal(PHOTO.budget, budget.maxResidentAtlases, 'the committed count cap and runtime cap must match');

  const samples = sampleRoute();
  assert.ok(samples.length >= 100, `camera route only produced ${samples.length} samples`);
  let peak = { bytes: 0, x: 0, z: 0, residents: 0 };
  for (const sample of samples) {
    const sum = [...sample.qualityById.values()].reduce((total, q) => total + q.bytes, 0);
    assert.equal(sample.residentBytes, sum, 'reported bytes must equal selected atlas estimates');
    assert.ok(sample.residentBytes <= budget.maxBytes, `budget exceeded at (${sample.x.toFixed(1)}, ${sample.z.toFixed(1)}): ${sample.residentBytes}`);
    assert.ok(sample.want.length <= budget.maxResidentAtlases, `count exceeded at (${sample.x.toFixed(1)}, ${sample.z.toFixed(1)})`);
    if (sample.residentBytes > peak.bytes) peak = { bytes: sample.residentBytes, x: sample.x, z: sample.z, residents: sample.want.length };
  }
  console.log(`camera samples=${samples.length}; peak facade reservation=${(peak.bytes / 1024 / 1024).toFixed(1)} MiB at (${peak.x.toFixed(0)}, ${peak.z.toFixed(0)}); resident=${peak.residents}`);
});

test('distance quality steps down and has boundary hysteresis', () => {
  const candidate = { id: 'probe', cx: 0, cz: 0, size: [600, 400] };
  const close = selectPhotoSet([candidate], 0, 0);
  const held = selectPhotoSet([candidate], 75, 0, PHOTO, new Map([['probe', 8192]]));
  const downgraded = selectPhotoSet([candidate], 80, 0, PHOTO, new Map([['probe', 8192]]));
  const far = selectPhotoSet([candidate], 160, 0);
  assert.equal(close.qualityById.get('probe').tier, 8192);
  assert.equal(held.qualityById.get('probe').tier, 8192, 'hold the current tier within the hysteresis band');
  assert.equal(downgraded.qualityById.get('probe').tier, 4096);
  assert.equal(far.qualityById.get('probe').tier, 512);
});
