import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanRing, ringArea, triangulate, createAccumulator, addBuilding, hashString } from '../js/building-geometry.js';

const area2d = (points, indices) => {
  let a = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [p, q, r] = [indices[i], indices[i + 1], indices[i + 2]].map((k) => points[k]);
    a += ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
  }
  return a;
};
const toNorth = (ring) => ring.map(([x, z]) => [x, -z]);

test('ringArea is positive for CCW rings seen from above (x east, z south)', () => {
  assert.ok(ringArea([0, 0, 10, 0, 10, -5, 0, -5]) > 0);
  assert.ok(ringArea([0, 0, 0, -5, 10, -5, 10, 0]) < 0);
  assert.equal(ringArea([0, 0, 10, 0, 10, -5, 0, -5]), 50);
});

test('cleanRing orients rings, drops duplicates and collinear vertices', () => {
  const messy = [0, 0, 5, 0, 5.01, 0, 10, 0, 10, -5, 0, -5, 0, 0.01];
  const ccw = cleanRing(messy, true);
  assert.equal(ccw.length, 4);
  assert.ok(ringArea(ccw.flat()) > 0);
  const cw = cleanRing(messy, false);
  assert.ok(ringArea(cw.flat()) < 0);
});

test('triangulation covers a concave ring exactly', () => {
  const outer = toNorth(cleanRing([0, 0, 30, 0, 30, -12, 12, -12, 12, -30, 0, -30], true));
  const { points, indices } = triangulate(outer);
  assert.equal(indices.length / 3, outer.length - 2);
  assert.ok(Math.abs(area2d(points, indices) - (30 * 12 + 12 * 18)) < 1e-6);
});

test('triangulation of a ring with a courtyard hole covers area minus hole', () => {
  const outer = toNorth(cleanRing([0, 0, 40, 0, 40, -30, 0, -30], true));
  const hole = toNorth(cleanRing([10, -10, 10, -20, 30, -20, 30, -10], false));
  const { points, indices } = triangulate(outer, [hole]);
  assert.ok(Math.abs(area2d(points, indices) - (40 * 30 - 20 * 10)) < 1e-6);
});

test('roof triangles face up, hipped roofs only on plain quadrilaterals', () => {
  const base = { id: 'a', ring: [0, 0, 20, 0, 20, -8, 0, -8], holes: [], ground: 0, eave: 12, ridge: 16, facade: { floor_h: 3, ground_floor_h: 3.4, bay_w: 3, window_w: 1.2, ground_type: 'residential' } };
  const hip = createAccumulator();
  addBuilding(hip, { ...base, roof: 'pitched' });
  const ys = hip.roof.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...ys) > 12 + 1.5, 'the hip rises above the eave');
  for (let i = 0; i < hip.roof.normal.length; i += 3) assert.ok(hip.roof.normal[i + 1] > 0.1, 'slopes face upward');
  const flat = createAccumulator();
  addBuilding(flat, { ...base, roof: 'flat' });
  assert.ok(Math.max(...flat.roof.position.filter((_, i) => i % 3 === 1)) < 12.6, 'flat roof stays at the parapet');
  const lShape = createAccumulator();
  addBuilding(lShape, { ...base, ring: [0, 0, 30, 0, 30, -12, 12, -12, 12, -30, 0, -30], roof: 'pitched' });
  assert.ok(Math.max(...lShape.roof.position.filter((_, i) => i % 3 === 1)) < 12.6, 'no skeleton roofs for concave rings');
});

test('walls: one quad per edge, u restarts per wall, ranges cover every index', () => {
  const acc = createAccumulator();
  addBuilding(acc, { id: 'b', ring: [0, 0, 10, 0, 10, -5, 0, -5], holes: [], ground: 0, eave: 9, ridge: 9, roof: 'flat', facade: { floor_h: 3, ground_floor_h: 3, bay_w: 3, window_w: 1, ground_type: 'blank' } });
  assert.equal(acc.wall.index.length / 6, 4);
  const us = [];
  for (let q = 0; q < 4; q++) us.push([acc.wall.facadeUV[q * 8], acc.wall.facadeUV[q * 8 + 2]]);
  assert.deepEqual(us.map(([a]) => a), [0, 0, 0, 0], 'each wall starts at u = 0');
  assert.deepEqual(us.map(([, b]) => Math.round(b)), [10, 5, 10, 5]);
  assert.deepEqual(acc.wallRanges, [{ id: 'b', start: 0, end: 24 }]);
  assert.equal(hashString('x'), hashString('x'));
});
