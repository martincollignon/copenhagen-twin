import test from 'node:test';
import assert from 'node:assert/strict';
import { createLawnMask, createGrassField, fillTile, PER_TILE, TILE, SPAN, FADE_RADIUS } from '../js/grass-layout-cph.js';

const lawn = [{ ring: [0, 0, 40, 0, 40, 40, 0, 40], holes: [[10, 10, 20, 10, 20, 20, 10, 20]] }];

test('lawn mask covers the polygon minus its holes', () => {
  const m = createLawnMask(lawn);
  assert.ok(m.has(5, 5));
  assert.ok(!m.has(15, 15), 'hole');
  assert.ok(!m.has(50, 5), 'outside');
});

test('tiles fill only on lawn, with a stable layout per tile', () => {
  const m = createLawnMask(lawn);
  const a = new Float32Array(PER_TILE * 4);
  const b = new Float32Array(PER_TILE * 4);
  const inside = fillTile(1, 1, m, null, a, 0); // x 8..16, z 8..16 straddles the hole
  fillTile(1, 1, m, null, b, 0);
  assert.deepEqual(a, b);
  assert.ok(inside > 0 && inside < PER_TILE, `partial coverage (${inside})`);
  for (let i = 0; i < PER_TILE; i++) {
    const x = a[4 * i];
    const z = a[4 * i + 2];
    assert.equal(a[4 * i + 3] >= 0, m.has(x, z), 'a tuft is live exactly where there is lawn');
    assert.ok(x >= TILE && x < 2 * TILE && z >= TILE && z < 2 * TILE, 'inside its tile');
  }
  assert.equal(fillTile(30, 30, m, null, a, 0), 0, 'no lawn, no tufts');
});

test('the torus refills only the tiles that entered range', () => {
  const field = createGrassField({ mask: createLawnMask(lawn), terrain: { flat: false, heightAt: () => 2 } });
  assert.equal(field.update(20, 20, 1000), SPAN * SPAN);
  assert.equal(field.update(21, 21, 1000), 0, 'same tile: nothing to do');
  const before = field.tufts;
  assert.ok(before > 0);
  assert.equal(field.update(20 + TILE, 20, 1000), SPAN, 'one column of tiles');
  assert.equal(field.update(20, 20, 3), 3, 'the budget caps the work per call');
  assert.ok(FADE_RADIUS < (SPAN * TILE) / 2);
  const live = [];
  for (let i = 0; i < field.count; i++) if (field.data[4 * i + 3] >= 0) live.push(field.data[4 * i + 1]);
  assert.ok(live.length > 0 && live.every((y) => Math.abs(y - 2.016) < 1e-6), 'tufts stand on the terrain');
});
