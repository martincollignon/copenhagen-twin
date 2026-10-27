// The citywide collision fixes: fixed-shape actors, resting agents, spawn clearance, walking lines round furniture, the road graph
// without covered service lanes, parked cars clear of buses, bike lanes clear of parking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityCollisions, createCollisionActor } from '../js/city-collisions.js';
import { buildStaticColliders, createStaticIndex, createTiledStaticIndex } from '../js/static-colliders.js';
import { dropCoveredServiceLinks } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { buildCyclistNetwork } from '../js/cyclist-network.js';
import { createRoadIndex } from '../js/placement-cph.js';

const square = (id, x, z, h = 5) => ({ id, ring: [x - h, z - h, x + h, z - h, x + h, z + h, x - h, z + h], ground: 0, eave: 10, roof: 'flat' });
const person = (x, z, extra = {}) => createCollisionActor({
  kind: 'pedestrian', mode: 'person', radius: 0.31, bodyTop: 1.85, mass: 72, x, z, prevX: x, prevZ: z, heading: 0, placed: true,
  move(dx, dz) { this.x += dx; this.z += dz; return this; }, ...extra
});

test('collision actors share one shape and reject fields the stage does not know', () => {
  const a = person(0, 0), b = createCollisionActor({ kind: 'car', mode: 'car', radius: 0.95, spec: { width: 1.9, length: 4.6, height: 1.5 } });
  assert.deepEqual(Object.keys(a), Object.keys(b), 'one field order for every adapter');
  assert.equal(a.placed, true);
  assert.ok(Number.isNaN(a.inverseMass) && Number.isNaN(a.collisionIndex) && Number.isNaN(a.bodyTop) === false);
  assert.throws(() => createCollisionActor({ velocityX: 1 }), /unknown field velocityX/);
});

test('a resting agent proven clear skips its static pass until it moves or the tiles change', () => {
  const index = createTiledStaticIndex();
  index.set('b:A', buildStaticColliders({ buildings: [square('a', 0, 0)] }));
  const stage = createCityCollisions({ staticIndex: index });
  const resting = person(5.5, 0); // 0.19 m from the wall
  stage.resolve([resting], { dt: 1 / 60 });
  assert.equal(stage.stats.restingSkips, 0);
  stage.resolve([resting], { dt: 1 / 60 });
  assert.equal(stage.stats.restingSkips, 1, 'still where it was proven clear');
  assert.equal(stage.stats.staticQueries, 0);
  resting.x = 5.2; // stepped into the wall
  stage.resolve([resting], { dt: 1 / 60 });
  assert.equal(stage.stats.restingSkips, 0);
  assert.ok(resting.x >= 5 + 0.31 - 1e-6, `pushed out of the wall to ${resting.x}`);
  stage.resolve([resting], { dt: 1 / 60 });
  assert.equal(stage.stats.restingSkips, 1);
  index.set('b:B', buildStaticColliders({ buildings: [square('b', 7, 0, 1.5)] })); // a tile streamed in over it
  stage.resolve([resting], { dt: 1 / 60 });
  assert.equal(stage.stats.restingSkips, 0, 'new solids: tested again');
  assert.ok(stage.stats.staticContacts > 0);
});

test('one static query per actor per resolve, reused by its passes and pair corrections', () => {
  const index = createStaticIndex(buildStaticColliders({ buildings: [square('a', 0, 0)] }));
  const stage = createCityCollisions({ staticIndex: index });
  const a = person(5.2, 0), b = person(5.4, 0.1);
  stage.resolve([a, b], { dt: 1 / 60 });
  assert.ok(stage.stats.contacts > 0 && stage.stats.staticContacts > 0);
  assert.equal(stage.stats.staticQueries, 2);
});

test('spawn clearance, walking-line obstruction', () => {
  const plan = { trees: [], lamps: [], cars: [{ x: 0, y: 0, z: 0, yaw: 0, body: 'estate' }], bollards: [{ x: 10, y: 0, z: 0 }],
    benches: [], bins: [], glass: [], meters: [], stands: [], hoops: [], bikes: [] };
  const stage = createCityCollisions({ staticIndex: createStaticIndex(buildStaticColliders(null, { furniturePlan: plan })) });
  const spec = { width: 1.9, length: 4.6, height: 1.5 };
  assert.equal(stage.clearOfStatics(0, 3, { heading: 0, mode: 'car', spec }), false, 'in the parked car');
  assert.equal(stage.clearOfStatics(3, 0, { heading: 0, mode: 'car', spec }), true, 'beside it');
  assert.equal(stage.obstructedLength(10, -5, 10, 5), 1, 'one metre sample blocked by the bollard');
  assert.equal(stage.obstructedLength(11, -5, 11, 5), 0);
});

test('service lanes through a footprint leave the road graph; streets stay', () => {
  const rg = {
    nodes: [0, -20, 0, 20, 10, -20, 10, 20, 30, -20, 30, 20],
    links: [[0, 1, 1, 1, 4, 20, 0, 1], [2, 3, 1, 0, 4, 20, 0, 1], [4, 5, 1, 1, 8, 30, 0, 0]],
    names: [''], classes: ['residential', 'service']
  };
  const inBuilding = (x, z) => Math.abs(x) < 3 && Math.abs(z) < 3 // a gateway building over the first lane
    || (x > 11.2 && x < 16 && Math.abs(z) < 2) // a wall 1.2 m beside the second (one-way: its car sweeps 1.05 m)
    || (Math.abs(x - 30) < 3 && Math.abs(z) < 3); // a building over the residential street
  const out = dropCoveredServiceLinks(rg, inBuilding);
  assert.deepEqual(out.links.map((l) => l[0]), [2, 4]);
  assert.equal(dropCoveredServiceLinks(rg, () => false), rg);
});

test('a walking line that runs through furniture moves sideways to a clear one', () => {
  const edge = { sx: 0, sz: 0, dx: 1, dz: 0, rx: 0, rz: 1, len: 40, half: 4, from: null, to: null };
  const blockedAt = (ax, az, bx, bz) => Math.abs(az - 5.7) < 0.2 ? 6 : 0; // a row of racks along the inner right-hand line
  const routes = createPedestrianRoutes({ walkable: () => true, obstruction: blockedAt }, () => 'block');
  const right = routes.along(edge).filter((t) => t.az > 0).map((t) => +t.az.toFixed(2));
  assert.equal(right.length, 2);
  assert.ok(!right.includes(5.7) && right.includes(6.8), `right-hand lines ${right}`);
  assert.ok(Math.abs(right[1] - right[0]) >= 0.9);
  const plain = createPedestrianRoutes({ walkable: () => true }, () => 'block');
  assert.deepEqual(plain.along(edge).map((t) => +t.az.toFixed(2)).sort((p, q) => p - q), [-6.8, -5.7, 5.7, 6.8], 'no obstruction test: the lines as before');
});

test('parked cars keep clear of buses on bus streets, and contraflow bike lanes ride inside the parking', () => {
  const road = (cls, z) => ({ id: cls, class: cls, name: 'S', pts: [0, z, 100, z], lanesFwd: 1, lanesBack: 1, oneway: false, cs: { hw: 5 } });
  const index = createRoadIndex({ roads: [road('secondary', 0), road('residential', 100)] });
  assert.ok(Math.abs(index.nearest(50, 0.5, 14).mv - (1.5 + 1.32)) < 1e-9, 'a bus street: 1.5 m lane offset + half a bus');
  assert.ok(Math.abs(index.nearest(50, 100.5, 14).mv - (1.5 + 0.95)) < 1e-9, 'a residential street: half a car');
  const oneWay = { id: 'o', class: 'residential', name: 'O', pts: [0, 0, 100, 0], lanesFwd: 1, lanesBack: 0, oneway: true, carDir: 'fwd', cs: { hw: 4 },
    bike: { left: 'back', right: 'fwd', leftKind: null, rightKind: null, carriageway: 'both', contraflow: true, contraKind: 'shared', ban: false } };
  const net = buildCyclistNetwork({ roads: [oneWay], cycleTracks: [] });
  const contra = net.lanes.find((l) => l.kind === 'contra');
  assert.ok(contra, 'a contraflow lane');
  const offset = Math.abs(contra.pts[1]);
  assert.ok(offset < 4 - 1.95 - 0.12 - 0.3, `the contraflow lane rides at ${offset} m, inside the parked cars (from ${4 - 2.07} m)`);
});
