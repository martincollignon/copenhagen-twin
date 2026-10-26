import test from 'node:test';
import assert from 'node:assert/strict';
import { cyclistAppearance } from '../js/cyclist-appearance.js';

test('Copenhagen rider appearance stays deterministic with a muted helmet minority and rare cargo bikes', () => {
  const riders = Array.from({ length: 1000 }, (_, i) => cyclistAppearance(i));
  const helmets = riders.filter((rider) => rider.helmet).length / riders.length;
  const cargo = riders.filter((rider) => rider.cargo).length / riders.length;
  const darkFrames = riders.filter((rider) => rider.frameColour < 0x707070).length / riders.length;
  assert.ok(helmets >= 0.35 && helmets <= 0.45, `helmet share ${(helmets * 100).toFixed(1)}%`);
  assert.ok(cargo >= 0.03 && cargo <= 0.07, `cargo share ${(cargo * 100).toFixed(1)}%`);
  assert.ok(darkFrames >= 0.55, `dark frame share ${(darkFrames * 100).toFixed(1)}%`);
  assert.deepEqual(riders, Array.from({ length: 1000 }, (_, i) => cyclistAppearance(i)));
});

test('the visible 96-rider fleet retains the target helmet share', () => {
  const riders = Array.from({ length: 96 }, (_, i) => cyclistAppearance(i));
  const share = riders.filter((rider) => rider.helmet).length / riders.length;
  assert.ok(share >= 0.35 && share <= 0.45, `helmet share ${(share * 100).toFixed(1)}%`);
});
