import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoBoatNavigation, confineGoBoatMotion, advanceGoBoatSpeed, GOBOAT_MAX_SPEED } from '../js/goboat-navigation.js';
const box = (x0, z0, x1, z1, holes = []) => ({ ring: [x0, z0, x1, z0, x1, z1, x0, z1], holes, level: -6.84 });
const nav = (water, seed = { x: -10, z: 0 }, options = {}) => createGoBoatNavigation({ waterOverride: water, pierRecords: [{ departurePoint: seed }], ...options });

test('GoBoat is unavailable without rendered harbour coverage at its pier', () => {
  assert.equal(nav([]), null);
  assert.equal(nav([box(100, 100, 200, 200)]), null);
  assert.equal(nav([box(-20, -20, 20, 20)], { x: 19, z: 0 }), null);
});
test('touching and overlapping polygons have no internal collision wall', () => {
  for (const right of [0, -2]) {
    const n = nav([box(-20, -20, 0, 20), box(right, -20, 20, 20)]);
    assert(n.isPositionLegal(0, 0));
    const move = confineGoBoatMotion(n, { x: -10, z: 0 }, { x: 20, z: 0 });
    assert.equal(move.x, 10); assert.equal(move.blocked, false);
  }
});
test('disjoint collinear polygons do not connect lakes to the harbour', () => {
  const n = nav([box(-20, -20, 20, 20), box(30, -20, 50, 20)]);
  assert.equal(n.polygons.length, 1);
  assert.equal(n.isPositionLegal(40, 0), false);
});
test('exact hull clearance detects tiny islands between sampled envelope points', () => {
  const n = nav([box(-20, -20, 20, 20, [[0.80, 0.10, 0.90, 0.10, 0.90, 0.20, 0.80, 0.20]])]);
  assert.equal(n.isPositionLegal(0, 0), false);
  assert.equal(n.isPositionLegal(4, 0), true);
});
test('a narrow quay intrusion blocks the full circular hull', () => {
  const water = { ring: [-20, -20, 20, -20, 20, 20, 0.9, 20, 0.9, 0.1, 0.8, 0.1, 0.8, 20, -20, 20] };
  const n = nav([water]);
  assert.equal(n.isPositionLegal(0, 0), false);
});
test('swept motion cannot tunnel across a thin island or dock', () => {
  for (const options of [{}, { obstacleRings: [[-0.1, -20, 0.1, -20, 0.1, 20, -0.1, 20]] }]) {
    const holes = options.obstacleRings ? [] : [[-0.1, -19, 0.1, -19, 0.1, 19, -0.1, 19]];
    const n = nav([box(-30, -30, 30, 30, holes)], { x: -10, z: 0 }, options);
    const move = confineGoBoatMotion(n, { x: -10, z: 0 }, { x: 20, z: 0 });
    assert(move.x < -2.8); assert(move.blocked); assert(n.isPositionLegal(move.x, move.z));
  }
});
test('render collection called lakes can contain navigable harbour at sea level', () => {
  const n = createGoBoatNavigation({ lakeData: { lakes: [box(-20, -20, 20, 20)] }, pierRecords: [{ departurePoint: { x: 0, z: 0 } }] });
  assert(n.isPositionLegal(0, 0)); assert.equal(n.level, -6.84);
});
test('electric throttle caps forward speed, brakes through zero, and limits reverse', () => {
  let speed = 0;
  for (let i = 0; i < 1000; i++) speed = advanceGoBoatSpeed(speed, 1, 0.1);
  assert.equal(speed, GOBOAT_MAX_SPEED);
  const braking = advanceGoBoatSpeed(speed, -1, 0.1);
  assert(braking > 0 && braking < speed);
  for (let i = 0; i < 1000; i++) speed = advanceGoBoatSpeed(speed, -1, 0.1);
  assert.equal(speed, -0.85);
  assert(Math.abs(advanceGoBoatSpeed(speed, 0, 0.1)) < Math.abs(speed));
});
