import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildLakePromenadeSurfaces } from '../js/lake-promenade-cph.js';
import { applySurfaceCuts, WATER } from '../js/lakes-cph.js';
import { pointInRing } from '../js/polygon-cph.js';
import { buildPavementBuckets } from '../js/pavement-cph.js';

const LAKE = { lakes: [{ id: 'square', ring: [-20, -20, -20, 20, 20, 20, 20, -20] }] };
const inClass = (records, cls, x, z) => records.some((record) => record.cls === cls && pointInRing(record.ring, x, z));

test('runtime lake promenade emits a 4 m gravel band and an outer grass verge', () => {
  const records = buildLakePromenadeSurfaces(LAKE, { bbox: [-100, -100, 100, 100] });
  assert.ok(records.length > 0);
  assert.ok(inClass(records, 'gravel', -22, 0), 'gravel fills the bank beside the west shore');
  assert.ok(inClass(records, 'grass', -25.5, 0), 'grass sits landward of the gravel');
  assert.ok(!inClass(records, 'gravel', -25.5, 0), 'the grass verge starts outside the gravel band');
  for (const record of records) {
    assert.equal(record.space, 'Lake promenade');
    assert.equal(record.conf, 'inferred');
    assert.deepEqual(record.src, ['runtime:lake-promenade']);
  }
});

test('runtime gravel overlaps the synthetic coping edge on a clear bank', () => {
  const records = buildLakePromenadeSurfaces(LAKE, { bbox: [-100, -100, 100, 100] });
  const copingOuterEdge = WATER.wallBatter + WATER.copingW;
  const justLandward = copingOuterEdge - 0.002;
  assert.ok(
    inClass(records, 'gravel', -20 - justLandward, 0),
    `gravel covers the point 2 mm inside the ${copingOuterEdge.toFixed(2)} m coping edge`
  );
});

test('runtime promenade yields to roads, registered surfaces, buildings and bridges', () => {
  const road = { id: 'road', class: 'residential', pts: [-22, -30, -22, 30], width: 2 };
  const blocker = { ring: [-24, -3, -20, -3, -20, 3, -24, 3] };
  const records = buildLakePromenadeSurfaces(LAKE, {
    bbox: [-100, -100, 100, 100],
    roads: [road],
    existingSurfaces: [{ ...blocker, cls: 'asphalt_road' }],
    buildings: [{ ...blocker, id: 'building' }],
    bridges: [{ ...blocker, id: 'bridge' }]
  });
  assert.ok(!inClass(records, 'gravel', -22, 0), 'the generated strip does not cover a road');
  assert.ok(inClass(records, 'gravel', 22, 0), 'the far bank remains available');
});

test('real Søerne shoreline has gravel coverage 2 m landward of a clear bank segment', () => {
  const lakes = JSON.parse(readFileSync(new URL('../data/cph-lakes.json', import.meta.url), 'utf8'));
  const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
  const surfaces = applySurfaceCuts(
    JSON.parse(readFileSync(new URL('../data/cph-surfaces.json', import.meta.url), 'utf8')),
    lakes.surface_cuts
  );
  const records = buildLakePromenadeSurfaces(lakes, {
    existingSurfaces: surfaces.surfaces,
    roads: geo.roads,
    cycleTracks: geo.cycleTracks,
    sidewalks: geo.sidewalks,
    buildings: geo.buildings,
    bridges: lakes.bridges,
    bbox: geo.frame.bbox
  });
  const lake = lakes.lakes.find((item) => item.id === 'lake:0');
  let signedArea = 0;
  for (let i = 0; i < lake.ring.length; i += 2) {
    const j = (i + 2) % lake.ring.length;
    signedArea += lake.ring[i] * lake.ring[j + 1] - lake.ring[j] * lake.ring[i + 1];
  }
  signedArea /= 2;
  let clearBankPoint = null;
  for (let i = 0; i < lake.ring.length / 2 && !clearBankPoint; i++) {
    const j = (i + 1) % (lake.ring.length / 2);
    const ax = lake.ring[2 * i];
    const az = lake.ring[2 * i + 1];
    const dx = lake.ring[2 * j] - ax;
    const dz = lake.ring[2 * j + 1] - az;
    const length = Math.hypot(dx, dz);
    if (length < 10) continue;
    const nx = (-dz / length) * -Math.sign(signedArea);
    const nz = (dx / length) * -Math.sign(signedArea);
    for (let along = 5; along < length; along += 5) {
      const x = ax + (dx * along) / length + nx * 2;
      const z = az + (dz * along) / length + nz * 2;
      if (records.some((item) => item.cls === 'gravel' && item.id.includes(':lake:0:') && pointInRing(item.ring, x, z))) {
        clearBankPoint = [x, z];
        break;
      }
    }
  }
  assert.ok(clearBankPoint, 'the inferred gravel band reaches a clear point 2 m from the measured shoreline');
});

test('pavement renderer creates a ground bucket for runtime grass records', () => {
  const buckets = buildPavementBuckets(
    { roads: [], sidewalks: [], buildings: [] },
    { surfaces: [{ cls: 'grass', ring: [-4, -4, -4, 4, 4, 4, 4, -4], src: ['runtime:lake-promenade'] }] },
    { roads: [], y: 0, groundY: 0 }
  );
  assert.ok(buckets.has('ground:grass'));
  assert.ok(buckets.get('ground:grass').vertexCount > 0);
});
