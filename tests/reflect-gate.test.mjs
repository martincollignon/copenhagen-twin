import assert from 'node:assert/strict';
import test from 'node:test';
import { sidePlanes, boxVisible, pointVisible } from '../js/reflect-gate.js';

// a camera at the origin looking down -z (identity view), 90 degrees vertical and horizontal field of view
const PROJ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0];
const VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('water in front is visible, water behind or far to the side is not', () => {
  const p = sidePlanes(PROJ, VIEW);
  assert.ok(pointVisible(p, 0, 0, -50));
  assert.ok(pointVisible(p, 40, 0, -50), 'inside the 45 degree half angle');
  assert.ok(!pointVisible(p, 80, 0, -50), 'outside to the right');
  assert.ok(!pointVisible(p, -80, 0, -50));
  assert.ok(!pointVisible(p, 0, 0, 50), 'behind the camera');
  assert.ok(!pointVisible(p, 0, 80, -50) && !pointVisible(p, 0, -80, -50));
});

test('a box counts when any part of it is inside, a margin grows the frustum', () => {
  const p = sidePlanes(PROJ, VIEW);
  assert.ok(boxVisible(p, [30, -2, -60], [90, 0, -40]), 'straddles the right plane');
  assert.ok(!boxVisible(p, [80, -2, -60], [120, 0, -40]));
  assert.ok(boxVisible(p, [60, -2, -60], [120, 0, -40], 20), 'a margin of 20 m');
});
