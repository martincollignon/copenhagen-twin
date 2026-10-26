import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createEntranceIndex, placeDoors, createDoorAccumulator, addDoors } from '../js/entrances.js';
import { createContext, classifyWalls, KIND } from '../js/groundfloor.js';
import { cleanRing, createAccumulator, addBuilding } from '../js/building-geometry.js';

// 20 x 10 block, road to the south (z > 0 side is south): street wall z = 10, courtyard wall z = 0
const block = { id: 'gdk:1', ring: [0, 0, 20, 0, 20, 10, 0, 10], holes: [], ground: 0, eave: 12, ridge: 12, storeys: 4, use: 120, facade: { ground_type: 'entrance' } };
const road = { pts: [-30, 16, 50, 16], width: 6, class: 'residential', name: 'Gade' };
const entry = (over) => ({ id: 'h1', bid: 'gdk:1', text: '1A', x: 8, z: 3, sx: 8, sz: 0, d: 3, conf: 'observed', ...over });
const ringsOf = (b) => [cleanRing(b.ring, true)];

test('createEntranceIndex keeps credible snaps and merges husnumre that share an adgangspunkt', () => {
  const idx = createEntranceIndex({ entrances: [entry({}), entry({ id: 'h2', text: '1B', sx: 8.3 }), entry({ id: 'h3', sx: 15, d: 9 })] });
  assert.equal(idx.get('gdk:1').length, 1, 'd > 6 m dropped, 0.3 m apart merged');
  assert.deepEqual(idx.get('gdk:1')[0].texts, ['1A', '1B']);
});

test('placeDoors puts the door on the wall nearest the entrance, at the entrance position along it', () => {
  const doors = placeDoors(block, ringsOf(block), [entry({})]);
  assert.equal(doors.length, 1);
  const [d] = doors;
  assert.ok(Math.abs(d.z) < 1e-9, 'on the z = 0 wall');
  assert.ok(Math.abs(d.x - 8) < 1e-9, 'x kept');
  assert.ok(Math.abs(Math.hypot(d.nx, d.nz) - 1) < 1e-9);
  assert.ok(d.nz < 0, 'faces out of the building (north, -z), not into it');
});

test('a door stays END_MARGIN away from the wall ends and short walls get none', () => {
  const [d] = placeDoors(block, ringsOf(block), [entry({ x: 0.2, z: 1, sx: 0.2, sz: 0 })]);
  assert.ok(d.along >= 0.75 - 1e-9);
  const tiny = { ...block, ring: [0, 0, 1.2, 0, 1.2, 1.2, 0, 1.2] };
  assert.equal(placeDoors(tiny, ringsOf(tiny), [entry({ x: 0.5, z: 0.3 })]).length, 0);
});

test('courtyard holes carry doors on their own walls', () => {
  const ringed = { ...block, ring: [0, 0, 40, 0, 40, 40, 0, 40], holes: [[10, 10, 10, 30, 30, 30, 30, 10]] };
  const rings = [cleanRing(ringed.ring, true), cleanRing(ringed.holes[0], false)];
  const [d] = placeDoors(ringed, rings, [entry({ x: 20, z: 12, sx: 20, sz: 10 })]);
  assert.ok(d.edgeNo >= 4, 'edge of the hole ring');
  assert.ok(Math.abs(d.z - 10) < 1e-9);
});

test('classifyWalls: real entrance data switches the heuristic street door off, a building without data keeps it', () => {
  const buildings = [block];
  const plain = createContext({ roads: [road], buildings });
  const streetWall = (ctx) => classifyWalls(block, ringsOf(block), ctx).filter((w) => w.kind === KIND.entry);
  assert.ok(streetWall(plain).length >= 1);
  assert.ok(streetWall(plain).every((w) => !w.doorless), 'no entrance data: heuristic door stays');
  const real = createContext({ roads: [road], buildings, entrances: createEntranceIndex({ entrances: [entry({})] }) });
  assert.ok(streetWall(real).every((w) => w.doorless), 'entrance data (courtyard wall): street wall has no heuristic door');
});

test('addBuilding builds exactly one door per placed entrance and marks only doorless walls', () => {
  const ground = createContext({ roads: [road], buildings: [block], entrances: createEntranceIndex({ entrances: [entry({}), entry({ id: 'h9', x: 15, sx: 15 })] }) });
  const added = addBuilding(createAccumulator(), block, { ground });
  assert.equal(added.doors.length, 2);
  assert.equal(added.doorInfo.source, 'dar');
  assert.equal(added.doorInfo.count, 2);
  const other = { ...block, id: 'gdk:2' };
  const none = addBuilding(createAccumulator(), other, { ground: createContext({ roads: [road], buildings: [other], entrances: ground.entrances }) });
  assert.equal(none.doors.length, 0);
  assert.equal(none.doorInfo.source, 'heuristic', 'labelled as heuristic (inferred) in the panel');
});

test('addDoors makes closed boxes with outward normals and the door height', () => {
  const [d] = placeDoors(block, ringsOf(block), [entry({})]);
  const acc = createDoorAccumulator();
  assert.equal(addDoors(acc, [d], { ground: 0 }), 1);
  assert.equal(acc.position.length / 3, acc.normal.length / 3);
  assert.equal(acc.position.length / 3, acc.color.length / 3);
  assert.ok(acc.index.every((i) => i < acc.position.length / 3));
  const ys = acc.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...ys) > 2.4 && Math.max(...ys) < 3.0, 'canopy above a ~2.15 m door');
  assert.ok(Math.min(...ys) >= 0);
});

const REAL = fs.existsSync(new URL('../data/cph-entrances.json', import.meta.url)) && fs.existsSync(new URL('../data/cph-geodata.json', import.meta.url));
test('real data: engine door count matches the data and NS37 doors are on courtyard walls only', { skip: !REAL }, () => {
  const geo = JSON.parse(fs.readFileSync(new URL('../data/cph-geodata.json', import.meta.url)));
  const doc = JSON.parse(fs.readFileSync(new URL('../data/cph-entrances.json', import.meta.url)));
  const index = createEntranceIndex(doc);
  const ground = createContext({ roads: geo.roads, buildings: geo.buildings, venues: [], entrances: index });
  let placed = 0;
  let expected = 0;
  for (const b of geo.buildings) {
    if (!b.ring || b.ring.length < 6) continue;
    const entries = index.get(b.id);
    if (!entries) continue;
    const rings = [cleanRing(b.ring, true), ...(b.holes || []).map((h) => cleanRing(h, false)).filter(Boolean)];
    placed += placeDoors(b, rings, entries).length;
    expected += entries.length;
  }
  assert.ok(expected > 1500, `entries in data: ${expected}`);
  assert.ok(placed / expected > 0.95, `placed ${placed} of ${expected}`);
  // NS37: all four stairwell doors on rear (courtyard) walls, the street wall has none
  const ns = geo.buildings.find((b) => b.id === 'gdk:1064715171');
  const rings = [cleanRing(ns.ring, true)];
  const kinds = classifyWalls(ns, rings, ground);
  const doors = placeDoors(ns, rings, index.get(ns.id));
  assert.equal(doors.length, 4);
  assert.ok(doors.every((d) => kinds[d.edgeNo].kind === KIND.rear), 'NS37 entrances are on the courtyard side');
  assert.ok(kinds.filter((w) => w.kind === KIND.entry).every((w) => w.doorless));
});
