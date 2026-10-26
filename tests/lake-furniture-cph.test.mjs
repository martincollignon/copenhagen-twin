import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { alignLakeFurniture, towardWater, yawToward } from '../js/lake-furniture-cph.js';
import { groundField, lakeDistanceFrom } from '../js/ground-field-cph.js';
import { buildFurniturePlan } from '../js/street-furniture-data.js';

const lake = { lakes: [{ id: 't', ring: [-40, -40, -40, 40, 0, 40, 0, -40] }] }; // water for x < 0
const dist = lakeDistanceFrom(groundField(lake, [], { bbox: [-100, -100, 100, 100] }));

test('the direction to the water points downhill of the land distance', () => {
  const w = towardWater(dist, 6, 0);
  assert.ok(w[0] < -0.95 && Math.abs(w[1]) < 0.2, JSON.stringify(w));
  assert.equal(towardWater(dist, 60, 0), null, 'far from the water');
});

test('benches and rescue posts face the water, lake lights face the path', () => {
  const plan = { benches: [{ x: 5, z: 0, yaw: 0 }, { x: 80, z: 0, yaw: 0.3 }], rescue: [{ x: 4, z: 10, yaw: 1 }], lakeLights: [{ x: 3, z: -10, yaw: 0 }] };
  const c = alignLakeFurniture(plan, dist);
  assert.deepEqual(c, { benches: 1, rescue: 1, lakeLights: 1 });
  const front = (y) => [Math.sin(y), Math.cos(y)];
  assert.ok(front(plan.benches[0].yaw)[0] < -0.9, 'bench front towards -x (the water)');
  assert.equal(plan.benches[1].yaw, 0.3, 'a bench far from the lake keeps its yaw');
  assert.ok(front(plan.lakeLights[0].yaw)[0] > 0.9, 'light head over the path');
  assert.ok(Math.abs(yawToward(0, 1)) < 1e-9);
});

test('real data: most benches within 9 m of the Soerne face the water after alignment', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const fur = read('../data/cph-furniture.json');
  const d = lakeDistanceFrom(groundField(read('../data/cph-lakes.json'), []));
  const plan = buildFurniturePlan(fur, null);
  const c = alignLakeFurniture(plan, d);
  assert.ok(c.benches > 30 && c.lakeLights > 100, JSON.stringify(c));
  for (const b of plan.benches.filter((x) => x.alignedToWater).slice(0, 50)) {
    const w = towardWater(d, b.x, b.z);
    assert.ok(Math.sin(b.yaw) * w[0] + Math.cos(b.yaw) * w[1] > 0.99);
  }
});
