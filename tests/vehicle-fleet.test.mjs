import assert from 'node:assert/strict';
import test from 'node:test';
import { BODY_MIX, PARKED_BODY_MIX, CAR_BODY_TYPES, CAR_PALETTE, CAR_PLATE, fleetRandom, sampleBody, samplePaint, fleetVehicle, plateRegistration } from '../js/vehicle-fleet.js';
import { parkedCars } from '../js/street-furniture-data.js';

for (const parked of [false, true]) {
  test(`${parked ? 'parked' : 'moving'} fleet stays within five percentage points over 2000 deterministic draws`, () => {
    const weights = parked ? PARKED_BODY_MIX : BODY_MIX;
    assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-12);
    const counts = Object.fromEntries(Object.keys(weights).map((body) => [body, 0]));
    for (let i = 0; i < 2000; i++) counts[sampleBody(fleetRandom(i), parked)]++;
    for (const [body, weight] of Object.entries(weights)) assert.ok(Math.abs(counts[body] / 2000 - weight) <= 0.05, `${body}: ${counts[body] / 2000}`);
    assert.equal(counts.sedan, undefined);
    assert.equal(counts.suv, undefined);
    if (parked) assert.equal(counts.taxi, undefined);
  });
}

test('shared paint weights match the requested palette and deterministic sampling', () => {
  const expected = { grey: 0.26, white: 0.25, black: 0.22, silver: 0.10, blue: 0.10, red: 0.04, other: 0.03 };
  assert.deepEqual(Object.fromEntries(CAR_PALETTE.map((entry) => [entry.name, entry.weight])), expected);
  const counts = Object.fromEntries(Object.keys(expected).map((name) => [name, 0]));
  for (let i = 0; i < 2000; i++) {
    const hex = samplePaint(fleetRandom(i, 1));
    const entry = CAR_PALETTE.find((entry) => entry.colors.includes(hex));
    assert.ok(entry);
    counts[entry.name]++;
  }
  for (const [name, weight] of Object.entries(expected)) assert.ok(Math.abs(counts[name] / 2000 - weight) <= 0.05, name);
});

test('taxis reuse both eligible bodies and vans are white', () => {
  const bodies = new Set();
  let taxis = 0, vans = 0;
  for (let i = 0; i < 2000; i++) {
    const choice = fleetVehicle(fleetRandom(i), fleetRandom(i, 1), fleetRandom(i, 2));
    assert.ok(CAR_BODY_TYPES.includes(choice.body));
    if (choice.taxi) { bodies.add(choice.body); taxis++; }
    if (choice.body === 'van') { vans++; assert.equal(choice.paint, CAR_PALETTE[1].colors[0]); }
  }
  assert.deepEqual(bodies, new Set(['estate', 'crossoverEV']));
  assert.ok(taxis > 30 && vans > 100);
});

test('parked placement uses the shared fleet without taxi signs', () => {
  const bays = Array.from({ length: 3000 }, (_, i) => ({ x: i * 6, z: (i % 7) * 8, yaw: 0, kind: 'par', src: ['row'] }));
  const cars = parkedCars(bays, { heightAt: () => 0.2 }, 7);
  assert.deepEqual(cars, parkedCars(bays, { heightAt: () => 0.2 }, 7));
  const counts = Object.fromEntries(CAR_BODY_TYPES.map((body) => [body, 0]));
  for (const c of cars) {
    assert.equal(c.y, 0.2);
    assert.ok(!c.taxi);
    assert.ok(CAR_BODY_TYPES.includes(c.body));
    assert.ok(c.paint.every((channel) => channel >= 0 && channel <= 1));
    counts[c.body]++;
  }
  for (const [body, weight] of Object.entries(PARKED_BODY_MIX)) assert.ok(Math.abs(counts[body] / cars.length - weight) < 0.05, body);
});

test('Danish plate dimensions and deterministic fictional registrations', () => {
  assert.equal(CAR_PLATE.width, 0.52);
  assert.equal(CAR_PLATE.height, 0.11);
  assert.equal(CAR_PLATE.textureWidth / CAR_PLATE.rowHeight, CAR_PLATE.width / CAR_PLATE.height);
  const labels = Array.from({ length: CAR_PLATE.variants }, (_, i) => plateRegistration(i));
  assert.equal(new Set(labels).size, labels.length);
  for (const label of labels) assert.match(label, /^[A-Z]{2} \d{2} \d{3}$/);
  assert.deepEqual(labels, Array.from({ length: CAR_PLATE.variants }, (_, i) => plateRegistration(i)));
});
