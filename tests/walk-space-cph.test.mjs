import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWalkSpace } from '../js/walk-space-cph.js';

const lakes = JSON.parse(readFileSync(new URL('../data/cph-lakes.json', import.meta.url), 'utf8'));
const ringCentre = (ring) => {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / (ring.length / 2), z / (ring.length / 2)];
};

test('pedestrians keep off the open water of the lakes but may cross a bridge deck', () => {
  const walk = createWalkSpace({ buildings: [] }, lakes);
  // Peblinge Soe, off Kaffesalonen's pier, is water
  assert.equal(walk.inWater(0, -440), true);
  assert.equal(walk.walkable(-0.5, 0.5, -440.5, -439.5), false);
  // Dronning Louises Bro's deck lies inside the lake outline and stays walkable
  const [bx, bz] = ringCentre(lakes.bridges[0].ring);
  assert.equal(walk.inWater(bx, bz), false);
  assert.equal(walk.walkable(bx - 0.4, bx + 0.4, bz - 0.4, bz + 0.4), true);
  // without a lake document only buildings block
  assert.equal(createWalkSpace({ buildings: [] }).walkable(-0.5, 0.5, -440.5, -439.5), true);
});
