import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CAR_DENSITY, REF_H, TREE_STYLES, blockDensity, buildFurniturePlan, busStopParts, composeYaw, composeYawPitch, crownOf, hash2,
  indexItems, lightClass, lightColor, mapLamps, mapTrees, parkedCars, planCounts, rackItems, wireSpan
} from '../js/street-furniture-data.js';

// a ground with a 0.2 m pavement for x > 10 and the carriageway at 0.02 m elsewhere
const ground = { heightAt: (x) => (x > 10 ? 0.2 : 0.02) };

test('trees: real height and crown radius scale the reference tree, placed on the ground', () => {
  const [t] = mapTrees([{ x: 20, z: 5, height: 18, crown_radius: 4.5, genus: 'lime' }], ground);
  assert.equal(t.y, 0.2);
  assert.ok(Math.abs(t.sy - 18 / REF_H) < 1e-9);
  assert.ok(Math.abs(t.sxz * TREE_STYLES.lime.width * REF_H - 4.5) < 1e-9, 'reference crown radius times sxz is the real radius');
  const c = crownOf(18, 4.5, TREE_STYLES.lime);
  assert.ok(c.base > 4 && c.base + 2 * c.ry <= 18, 'the crown sits between the clear trunk and the top');
});

test('trees: unknown genera fall back to the generic style and extreme values are clamped', () => {
  const [a, b] = mapTrees([{ x: 0, z: 0, height: 120, crown_radius: 90, genus: 'dragonwood' }, { x: 1, z: 1, height: 0, crown_radius: 0, genus: 'oak' }], null);
  assert.equal(a.genus, 'generic');
  assert.ok(a.height <= 40 && a.crownR <= a.height * 0.75);
  assert.ok(b.height >= 2.5 && b.crownR >= 0.9);
  for (const g of ['lime', 'chestnut', 'elm', 'maple', 'cherry', 'plane', 'oak']) assert.ok(TREE_STYLES[g], `style for ${g}`);
});

test('lamps: colour temperature maps from sodium amber to white LED, classes are stable', () => {
  const sodium = lightColor(2000);
  const led = lightColor(4000);
  assert.ok(sodium[0] > sodium[1] && sodium[1] > sodium[2] && sodium[2] < 0.2, 'sodium is amber');
  assert.ok(led[2] > sodium[2] && led[1] > sodium[1], 'LED is whiter');
  assert.deepEqual([2000, 3000, 4000].map(lightClass), ['sodium', 'warm', 'neutral']);
});

test('lamps: a wire lamp hangs below its catenary between two facade anchors, on the ground it sits over', () => {
  const span = [0, 0, 20, 0];
  const w = wireSpan(span, { x: 10, z: 0 }, 0.02);
  assert.equal(w.pts.length, 11 * 3);
  assert.ok(Math.abs(w.t - 0.5) < 1e-9);
  const mid = w.pts[15 * 1 + 1]; // y of vertex 5
  const anchorA = w.pts[1];
  assert.ok(mid < anchorA, 'the wire sags between the anchors');
  assert.ok(w.lampY < w.wireY && w.wireY - w.lampY < 1, 'the luminaire hangs just under the wire');
  assert.ok(w.lampY > 4, 'above head height of buses');
  const [l] = mapLamps([{ x: 9, z: 1, mount: 'wire', light: 'led', led: true, cct: 3000, watt: 80, span }], ground);
  assert.ok(l.wire && Math.abs(l.z) < 1e-9, 'the lamp is snapped onto the wire line');
});

test('lamps: masts stand on the ground with the pole height as the head height', () => {
  const [m] = mapLamps([{ x: 30, z: 3, yaw: 1, mount: 'mast', pole: 'kbh', pole_h: 9, light: 'led', cct: 4000, watt: 70 }], ground);
  assert.ok(Math.abs(m.lampY - (0.2 + 9)) < 1e-9);
  assert.equal(m.wire, null);
});

test('parked cars: density stays in 70-85 percent, deterministic, and on the bays', () => {
  const bays = [];
  for (let i = 0; i < 4000; i++) bays.push({ x: (i % 80) * 5.5, z: Math.floor(i / 80) * 7, yaw: 0.3, kind: 'par', src: [`kk:p_pladser:${Math.floor(i / 8)}`] });
  const a = parkedCars(bays, ground, 7);
  const b = parkedCars(bays, ground, 7);
  assert.deepEqual(a.map((c) => [c.x, c.z, c.yaw, c.body]), b.map((c) => [c.x, c.z, c.yaw, c.body]), 'same seed, same cars');
  const share = a.length / bays.length;
  assert.ok(share > CAR_DENSITY[0] - 0.05 && share < CAR_DENSITY[1] + 0.05, `occupancy ${share.toFixed(3)}`);
  assert.notEqual(parkedCars(bays, ground, 8).length, a.length, 'another seed shuffles the occupancy');
  for (const c of a.slice(0, 200)) assert.equal(c.y, c.x > 10 ? 0.2 : 0.02, 'cars stand at the ground height');
  const d = blockDensity(12.3, 45.6, 1);
  assert.ok(d >= CAR_DENSITY[0] && d <= CAR_DENSITY[1]);
});

test('parked cars: parallel cars flip per kerb line, perpendicular cars keep their nose to the kerb', () => {
  const row = Array.from({ length: 40 }, (_, i) => ({ x: i * 5.4, z: 0, yaw: 1.2, kind: 'par', src: ['kk:p_pladser:A'] }));
  const cars = parkedCars(row, null, 3);
  const flips = cars.map((c) => Math.cos(c.yaw - 1.2) < 0);
  const majority = flips.filter(Boolean).length > flips.length / 2;
  assert.ok(flips.filter((f) => f === majority).length / flips.length > 0.75, 'one direction along a line, a few exceptions');
  const perp = parkedCars(Array.from({ length: 40 }, (_, i) => ({ x: i * 2.5, z: 0, yaw: 2, kind: 'perp', src: ['x'] })), null, 3);
  assert.ok(perp.every((c) => Math.abs(c.yaw - 2) < 0.05));
});

test('bike racks: bikes stand in the slots of their row, hoops every second slot', () => {
  const { hoops, bikes } = rackItems([{ x: 5, z: 5, yaw: Math.PI / 2, capacity: 10 }], ground, 1);
  assert.equal(hoops.length, 5);
  assert.ok(bikes.length <= 10);
  for (const b of bikes) assert.ok(Math.abs(b.z - 5) < 1e-6 && Math.abs(b.x - 5) <= 2.3, 'along x for a yaw of pi/2');
  const huge = rackItems([{ x: 0, z: 0, yaw: 0, capacity: 500 }], null, 1);
  assert.ok(huge.hoops.length <= 24, 'the slot count is capped');
});

test('bus stops: shelter, bench and bin only where Movia registered them', () => {
  const parts = busStopParts([
    { x: 0, z: 0, yaw: 0, tangent: [1, 0], shelter: true, bench: true, bin: true, countdown: true, name: 'A' },
    { x: 50, z: 0, yaw: 0, tangent: [1, 0], shelter: false, bench: true, bin: false, countdown: false, name: 'B' },
    { x: 100, z: 0, yaw: 0, tangent: [1, 0], shelter: false, bench: false, bin: false, countdown: false, name: 'C' }
  ], null);
  assert.equal(parts.flags.length, 3);
  assert.equal(parts.shelters.length, 1);
  assert.equal(parts.benches.length, 1, 'a stop without a shelter gets a free-standing bench');
  assert.equal(parts.bins.length, 1);
  assert.equal(parts.countdowns.length, 1);
});

test('matrices: yaw rotates model +z to (sin yaw, cos yaw); pitch tilts it along the wire', () => {
  const m = new Float32Array(16);
  composeYaw(m, 0, 1, 2, 3, Math.PI / 2, 1, 1, 2);
  const z = [m[8], m[9], m[10]];
  assert.ok(Math.abs(z[0] - 2) < 1e-6 && Math.abs(z[2]) < 1e-6, 'model +z (scaled 2) points east');
  assert.deepEqual([m[12], m[13], m[14]], [1, 2, 3]);
  composeYawPitch(m, 0, 0, 0, 0, 0, -Math.atan2(1, 4));
  const len = Math.hypot(m[8], m[9], m[10]);
  assert.ok(Math.abs(len - 1) < 1e-6 && m[9] > 0, 'a negative pitch climbs');
  assert.ok(Math.abs(m[9] / m[10] - 0.25) < 1e-6, 'rise over run is 1:4');
});

test('quadtree index returns the items within a radius', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ cx: -700 + (i % 25) * 56, cz: -700 + Math.floor(i / 25) * 70 }));
  const qt = indexItems(items);
  const near = qt.queryRange(0, 0, 120);
  const brute = items.filter((it) => Math.hypot(it.cx, it.cz) <= 120);
  assert.equal(near.length, brute.length);
});

const FURNITURE = new URL('../data/cph-furniture.json', import.meta.url);
test('the compiled data maps to a plan with the expected categories and provenance', { skip: !existsSync(FURNITURE) }, () => {
  const doc = JSON.parse(readFileSync(FURNITURE, 'utf8'));
  assert.ok(doc.version.startsWith('cph-furniture/'));
  const plan = buildFurniturePlan(doc, ground, { seed: 1 });
  const counts = planCounts(plan);
  assert.equal(counts.trees, doc.trees.length);
  assert.equal(counts.lamps, doc.lamps.length);
  assert.equal(counts.rescue, doc.rescuePosts.length);
  assert.ok(counts.cars / doc.parkingBays.length >= 0.65 && counts.cars / doc.parkingBays.length <= 0.9);
  assert.ok(counts.shelters <= doc.busStops.length && counts.flags === doc.busStops.length);
  for (const key of ['trees', 'lamps', 'parkingBays', 'bollards', 'bins', 'benches', 'bikeRacks', 'busStops', 'monuments', 'rescuePosts', 'parkMeters']) {
    for (const f of doc[key].slice(0, 400)) {
      assert.ok(Array.isArray(f.src) && f.src.length, `${key} has src`);
      assert.ok(['measured', 'observed', 'scaled', 'inferred'].includes(f.conf), `${key} has conf`);
      assert.ok(f.licence, `${key} has licence`);
    }
  }
  const wire = doc.lamps.filter((l) => l.mount === 'wire');
  const mast = doc.lamps.filter((l) => l.mount === 'mast');
  assert.equal(mast.length, 400, 'Citelum mast-mounted lamps in the district');
  assert.equal(wire.length, 1306, 'Citelum wire-suspended lamps in the district');
  assert.ok(wire.filter((l) => l.span).length / wire.length > 0.9, 'most wire lamps have a span');
  for (const t of plan.trees) assert.ok(t.y === 0.02 || t.y === 0.2);
  assert.ok(hash2(1, 2, 3) >= 0 && hash2(1, 2, 3) < 1);
});
