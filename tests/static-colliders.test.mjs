import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStaticColliders, createStaticIndex } from '../js/static-colliders.js';
import { buildingContact, collisionBody } from '../js/collision-shapes.js';
import { createAccumulator, addBuilding } from '../js/building-geometry.js';
import { createTerrain } from '../js/terrain-cph.js';

const square = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

test('building colliders preserve concave arms and do not fill an L-shaped recess', () => {
  const l = { id: 'concave', ring: [0, 0, 8, 0, 8, 2, 2, 2, 2, 8, 0, 8], holes: [], ground: 0, eave: 7, ridge: 8 };
  const [collider] = buildStaticColliders({ buildings: [l] });
  const person = collisionBody('person', 0.48, 0);
  const contact = {};
  assert.equal(collider.triangles.idx.length > 0, true, 'the existing polygon triangulator is retained for the filled footprint');
  assert.equal(buildingContact(collider, 5, 0, 5, person, contact), false, 'the empty corner of the L stays walkable');
  assert.equal(buildingContact(collider, 1, 0, 1, person, contact), true, 'the actual building arm blocks movement');
  const x = 1 + contact.nx * contact.depth, z = 1 + contact.nz * contact.depth;
  assert.equal(buildingContact(collider, x, 0, z, person, {}), false, 'the correction leaves the whole concave footprint clear');
});

test('courtyard holes are walkable and their inner walls push into the courtyard', () => {
  const building = { id: 'courtyard', ring: square(0, 0, 20, 20), holes: [square(7, 7, 13, 13)], ground: 0, eave: 18, ridge: 20 };
  const [collider] = buildStaticColliders({ buildings: [building] });
  const person = collisionBody('person', 0.48, 0);
  const contact = {};
  assert.equal(buildingContact(collider, 10, 0, 10, person, contact), false);
  assert.equal(buildingContact(collider, 6.8, 0, 10, person, contact), true);
  assert.ok(contact.nx > 0.99 && Math.abs(contact.nz) < 1e-8, 'the inner west wall ejects toward the open courtyard');
  assert.equal(buildingContact(collider, 6.8 + contact.nx * contact.depth, 0, 10, person, {}), false);
});

test('a narrow courtyard remains a hole without treating triangulation edges as solid walls', () => {
  const building = { id: 'narrow-courtyard', ring: square(0, 0, 20, 20), holes: [square(9.4, 2, 10.6, 18)], ground: 0, eave: 15, ridge: 17 };
  const [collider] = buildStaticColliders({ buildings: [building] });
  const cyclist = collisionBody('person', 0.25, 0);
  const contact = {};
  assert.equal(buildingContact(collider, 10, 0, 10, cyclist, contact), false, 'a narrow but walkable court stays free');
  const bikeBody = collisionBody('cargobike', 1.4, Math.PI / 2);
  assert.equal(buildingContact(collider, 10, 0, 10, bikeBody, contact), true, 'a wide cargo bike overlaps both real inner walls');
  assert.ok(contact.depth < 20, 'the candidate correction is bounded around the local footprint');
});

test('polygon circle contacts stay radial at corners and exact for rotated footprints', () => {
  const [squareCollider] = buildStaticColliders({ buildings: [{ id: 'box', ring: square(0, 0, 10, 10), ground: 0, eave: 8, ridge: 9 }] });
  const person = collisionBody('person', 0.48, 0);
  const contact = {};
  assert.equal(buildingContact(squareCollider, -0.4, 0, -0.4, person, contact), false);
  assert.equal(buildingContact(squareCollider, -0.2, 0, -0.2, person, contact), true);
  assert.ok(Math.abs(contact.nx - contact.nz) < 1e-7 && contact.nx < 0, 'outside corner correction is radial');
  assert.ok(contact.depth < 0.21, 'outside corner correction stays local');

  // A thin 45 degree building footprint, represented by exact geodata vertices.
  const ring = [[-4, -6], [-6, -4], [4, 6], [6, 4]].flat();
  const [rotatedCollider] = buildStaticColliders({ buildings: [{ id: 'rotated', ring, ground: 0, eave: 9, ridge: 10 }] });
  assert.equal(buildingContact(rotatedCollider, 4.8, 0, -4.8, person, {}), false, 'a clear corner of its broad bounds stays open');
  assert.equal(buildingContact(rotatedCollider, 0, 0, 0, person, {}), true);
  assert.equal(rotatedCollider.minX, -6);
});

test('oriented cars separate at polygon faces and corners, including roof clearances', () => {
  const [collider] = buildStaticColliders({ buildings: [{ id: 'rotated', ring: [-6, -4, 4, 6, 6, 4, -4, -6], ground: 0, eave: 8, ridge: 9 }] });
  const car = collisionBody('car', 1.35, Math.PI / 2, 0, { width: 1.8, length: 4.4 });
  const contact = {};
  assert.equal(buildingContact(collider, 0, 0, 0, car, contact), true);
  assert.ok(contact.depth > 0 && Math.abs(Math.hypot(contact.nx, contact.nz) - 1) < 1e-9);
  assert.equal(buildingContact({ ...collider, minY: 2.5 }, 0, 0, 0, car, {}), false, 'the car passes beneath an overhang');
  assert.equal(buildingContact({ ...collider, maxY: 1.7 }, 0, 2, 0, car, {}), false, 'the car passes above a low roof');
});

test('building underside follows terrain elevations and the extrusion skirt clearance', () => {
  const building = { id: 'raised', ring: square(0, 0, 4, 4), holes: [square(1, 1, 2, 2)], ground: 8, eave: 12, ridge: 12 };
  const [collider] = buildStaticColliders({ buildings: [building] }, {
    groundHeight: { terrainAt: (x, z) => x === 1 && z === 1 ? 7.2 : 8.4 }
  });
  assert.ok(Math.abs(collider.minY - 6.95) < 1e-9, 'the minimum includes the lowest terrain sample and the 0.25 m skirt');
  const person = collisionBody('person', 0.48, 0);
  assert.equal(buildingContact(collider, 3, 5, 3, person, {}), false, 'a walker below the raised building passes through');
  assert.equal(buildingContact(collider, 3, 5.1, 3, person, {}), true, 'vertical overlap with the real skirt remains solid');
});

test('furniture colliders use placed coordinates, solid trunks, thin poles, and accurate parked-car bodies', () => {
  const furniturePlan = {
    trees: [{ x: 1, y: 2, z: 3, height: 20, crown: { base: 7, rx: 12 } }],
    lamps: [{ x: 10, y: 1, z: 4, mount: 'mast', pole: 'tube', poleH: 5 }, { x: 20, y: 0, z: 4, mount: 'wire' }],
    cars: [{ x: 30, y: 0.3, z: 40, yaw: Math.PI / 2, body: 'estate' }],
    bollards: [{ x: 50, y: 0, z: 50 }], benches: [], bins: [], glass: [], meters: [], stands: [], hoops: [], bikes: [], freeBikes: []
  };
  const colliders = buildStaticColliders({}, {
    furniturePlan,
    carSpecs: { estate: { width: 1.9, length: 4.8, height: 1.6 } }
  });
  assert.equal(colliders.length, 4, 'wire mounted luminaires do not invent a street-level pole');
  const tree = colliders.find((item) => item.type === 'tree');
  assert.ok(tree.maxX - tree.minX < 1.1, 'tree crown spread is not used as a solid footprint');
  assert.equal(tree.shape, 'circle');
  assert.equal(tree.minY, 2);
  assert.equal(tree.maxY, 9);
  assert.equal(buildingContact(tree, 1.47, 2, 3.47, collisionBody('person', 0.2, 0), {}), false,
    'diagonal trunk clearance uses a circular cross section');
  assert.equal(buildingContact(tree, 1.25, 2, 3, collisionBody('person', 0.2, 0), {}), true,
    'the tree stem itself remains solid');
  const car = colliders.find((item) => item.type === 'parked-car');
  assert.equal(car.obb.hx, 0.95);
  assert.equal(car.obb.hz, 2.4);
  assert.ok(Math.abs(car.minX - 27.6) < 1e-9 && Math.abs(car.maxX - 32.4) < 1e-9, 'yaw rotates the longer parked-car body across X');
  assert.equal(car.minY, 0.3);
  assert.ok(Math.abs(car.maxY - 1.9) < 1e-9);
});

test('raw furniture documents are not mistaken for the placed rendering plan', () => {
  const rawDoc = {
    trees: [{ x: 1, z: 2, height: 12 }],
    lamps: [{ x: 3, z: 4, mount: 'mast', pole_h: 5 }],
    parkingBays: [{ x: 5, z: 6, yaw: 0 }]
  };
  assert.deepEqual(buildStaticColliders({}, { furniturePlan: rawDoc }), []);
});

test('shelters keep the rendered open entrance, back glass, elevated roof, and high countdown display', () => {
  const colliders = buildStaticColliders({}, {
    furniturePlan: { trees: [], lamps: [], cars: [], shelters: [{ x: 0, y: 0, z: 0, yaw: 0 }], countdowns: [{ x: 8, y: 0, z: 0, yaw: 0 }] }
  });
  const person = collisionBody('person', 0.48, 0);
  const at = (x, y, z) => colliders.filter((c) => buildingContact(c, x, y, z, person, {}));
  assert.deepEqual(at(0, 0, 0.45), [], 'a walker can stand under the roof and enter through the open front');
  assert.ok(at(0, 0, -0.7).some((item) => item.type === 'shelter-glass'), 'the rear glass remains solid');
  assert.deepEqual(at(8, 0, 0.12), [], 'the elevated countdown box does not invent a column to the sidewalk');
  const helicopter = collisionBody('helicopter', 0.4, 0);
  assert.ok(colliders.some((c) => c.type === 'shelter-roof' && buildingContact(c, 0, 2.3, 0, helicopter, {})),
    'an aircraft body that reaches the roof interval still collides');
});

test('bench collision follows its visible long axis', () => {
  const [bench] = buildStaticColliders({}, { furniturePlan: { trees: [], lamps: [], cars: [], benches: [{ x: 0, y: 0, z: 0, yaw: 0, length: 1.8 }] } });
  const person = collisionBody('person', 0.48, 0);
  assert.equal(bench.obb.hx, 0.9);
  assert.equal(bench.obb.hz, 0.28);
  assert.equal(buildingContact(bench, 0.85, 0, 0, person, {}), true);
});

test('static index reuses its output array and queries local candidates in build order', () => {
  const colliders = Array.from({ length: 6000 }, (_, i) => ({
    id: i, minX: i - 0.2, maxX: i + 0.2, minZ: 0, maxZ: 0.4, minY: 0, maxY: 2
  }));
  const index = createStaticIndex(colliders);
  const out = ['stale'];
  const first = index.query(3000, 0, 2, out);
  assert.equal(first, out);
  assert.ok(first.length <= 8, `local query returned ${first.length} records from the 6000-collider city`);
  assert.ok(first.every((item, i) => i === 0 || first[i - 1].id < item.id));
  assert.equal(index.query(5998, 0, 2, out), out);
  assert.ok(out.some((item) => item.id === 5998));
  assert.ok(!out.some((item) => item.id === 3000));
});

test('dedup state and order belong to each static index, even when they share collider objects', () => {
  const left = { id: 'left', minX: 4, maxX: 6, minZ: 4, maxZ: 6, minY: 0, maxY: 2 };
  const right = { id: 'right', minX: 4, maxX: 6, minZ: 4, maxZ: 6, minY: 0, maxY: 2 };
  const first = createStaticIndex([left, right]);
  const second = createStaticIndex([right, left]);
  assert.deepEqual(first.query(5, 5, 1).map((item) => item.id), ['left', 'right']);
  assert.deepEqual(second.query(5, 5, 1).map((item) => item.id), ['right', 'left']);
  assert.deepEqual(first.query(5, 5, 1).map((item) => item.id), ['left', 'right']);
});

test('the real Copenhagen building layer indexes the reported building without scanning the city', () => {
  const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
  const colliders = buildStaticColliders(geo);
  assert.ok(colliders.length > 2000, `real building count was ${colliders.length}`);
  const target = colliders.find((item) => item.id === 'building:gdk:1064712244');
  assert.ok(target, 'the browser repro building has a static collider');
  const { pts, idx } = target.triangles;
  const x = (pts[idx[0] * 2] + pts[idx[1] * 2] + pts[idx[2] * 2]) / 3;
  const z = (pts[idx[0] * 2 + 1] + pts[idx[1] * 2 + 1] + pts[idx[2] * 2 + 1]) / 3;
  const nearby = createStaticIndex(colliders).query(x, z, 8, []);
  assert.ok(nearby.includes(target));
  assert.ok(nearby.length < 32, `local real-city query returned ${nearby.length} of ${colliders.length} buildings`);
  assert.equal(buildingContact(target, x, target.minY, z, collisionBody('person', 0.48, 0), {}), true,
    'the actual repro footprint blocks the person at building height');
});

test('real terrain collider bottoms match the rendered cleaned building wall skirt', () => {
  const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
  const terrain = createTerrain(JSON.parse(readFileSync(new URL('../data/cph-terrain.json', import.meta.url), 'utf8')));
  const building = geo.buildings.find((item) => item.id === 'gdk:1064716175');
  assert.ok(building, 'the fixture retains the surveyed Copenhagen outline that exposed the cleanup difference');

  const [collider] = buildStaticColliders({ buildings: [building] }, { groundHeight: terrain });
  const rendered = createAccumulator();
  addBuilding(rendered, building, { terrain, details: false, observed: false });
  const renderedSkirtMinY = Math.min(...rendered.wall.position.filter((_, i) => i % 3 === 1));

  assert.ok(Math.abs(collider.minY - renderedSkirtMinY) < 1e-9,
    `collider starts at ${collider.minY}; rendered cleaned wall starts at ${renderedSkirtMinY}`);
});
