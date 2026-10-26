import assert from 'node:assert/strict';
import test from 'node:test';
import { groundField, chamfer, LAND } from '../js/ground-field-cph.js';

const BBOX = [-50, -50, 50, 50];
const lake = { lakes: [{ id: 't', ring: [-20, -20, -20, 20, 20, 20, 20, -20] }] }; // 40 x 40 lake in the middle
const park = { ring: [-45, -45, -45, 45, 45, 45, 45, -45] };
const at = (f, x, z) => (Math.floor((z - f.bbox[1]) / f.cell) * f.width + Math.floor((x - f.bbox[0]) / f.cell)) * 4;

test('land distance grows from the lake wall, is 0 on water, and caps at LAND.max', () => {
  const f = groundField(lake, [park], { bbox: BBOX });
  assert.equal(f.data[at(f, 0, 0)], 0);
  const metres = (x, z) => (f.data[at(f, x, z)] / 255) * f.max;
  assert.ok(Math.abs(metres(23.5, 0) - 3.5) < 1.1, `3.5 m beside the wall: ${metres(23.5, 0)}`);
  assert.ok(Math.abs(metres(30.5, 0) - 10.5) < 1.1);
  assert.ok(metres(49.5, 0) > 28 || metres(49.5, 0) <= f.max);
});

test('the park mask covers the park outside water only', () => {
  const f = groundField(lake, [park], { bbox: BBOX });
  assert.equal(f.data[at(f, 30, 0) + 1], 255);
  assert.equal(f.data[at(f, 0, 0) + 1], 0, 'no grass on water');
  assert.equal(f.data[at(f, -49.5, -49.5) + 1], 0, 'outside the park');
});

test('chamfer is exact along axes', () => {
  const src = new Uint8Array(9 * 9);
  src[4 * 9 + 4] = 1;
  const d = chamfer(src, 9, 9);
  assert.equal(d[4 * 9 + 4], 0);
  assert.equal(d[4 * 9 + 7], 3);
  assert.ok(LAND.pathW >= 3 && LAND.pathW <= 5, 'visual-refs 8a: lower path 3-5 m');
});
