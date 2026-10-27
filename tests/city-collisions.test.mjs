import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityCollisions } from '../js/city-collisions.js';
import { bodyContact, buildingContact } from '../js/collision-shapes.js';
import { createStaticIndex } from '../js/static-colliders.js';

function actor(kind, x, z, options = {}) {
  const mode = options.mode || (kind === 'car' || kind === 'bus' ? 'car' : kind === 'bike' ? 'cyclist' : 'person');
  const spec = options.spec || (kind === 'bus' ? { width: 2.6, length: 12.0, height: 3.1 } : null);
  const radius = options.radius ?? (mode === 'car' ? 1 : mode === 'cyclist' ? 0.52 : 0.32);
  return {
    kind, mode, spec, radius, mass: options.mass ?? (kind === 'bus' ? 6500 : kind === 'car' ? 1300 : kind === 'bike' ? 95 : 72),
    x, y: options.y ?? 0, z, prevX: options.prevX ?? x, prevY: options.prevY ?? options.y ?? 0,
    prevZ: options.prevZ ?? z, heading: options.heading ?? 0, prevHeading: options.heading ?? 0,
    bodyShapeOverrides: options.bodyShapeOverrides,
    vx: options.vx || 0, vz: options.vz || 0,
    move(dx, dz) { this.x += dx; this.z += dz; return this; },
    getVelocity(out) { out.x = this.vx; out.z = this.vz; return out; },
    applyVelocity(dx, dz) { this.vx += dx; this.vz += dz; }
  };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('person, NPC bike, car and bus contacts use shared bodies and resolve real overlap', () => {
  const stage = createCityCollisions();
  const pairs = [
    [actor('player', 0, 0, { mode: 'person', radius: 0.48 }), actor('person', 0, 0)],
    [actor('person', 0, 0), actor('bike', 0, 0)],
    [actor('bike', 0, 0), actor('bike', 0, 0)],
    [actor('car', 0, 0, { spec: { width: 1.9, length: 4.8, height: 1.65 } }), actor('bike', 0, 0)],
    [actor('car', 0, 0), actor('person', 0, 0)],
    [actor('car', 0, 0, { spec: { width: 1.9, length: 4.8, height: 1.65 } }),
      actor('bus', 0, 0, { heading: Math.PI / 2, spec: { width: 2.6, length: 12, height: 3.1 } })],
    [actor('bike', 0, 0, { mode: 'cargobike', bodyShapeOverrides: { hx: 0.38, hz: 1.38, offsetForward: 0.43 } }),
      actor('car', 0, 0)]
  ];
  for (const [a, b] of pairs) {
    const before = distance(a, b);
    const result = stage.resolve([a, b], { dt: 0 });
    assert.ok(result.stats.contacts > 0, `${a.kind}/${b.kind} produced a contact`);
    assert.ok(distance(a, b) > before, `${a.kind}/${b.kind} separated`);
    assert.equal(bodyContact(a, b, {}), false, `${a.kind}/${b.kind} has no remaining body overlap`);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
  }
  const cargo = actor('bike', 0, 0, {
    mode: 'cargobike', bodyShapeOverrides: { hx: 0.38, hz: 1.38, offsetForward: 0.43 }
  });
  const sidePerson = actor('person', 0.55, 1.1);
  const cargoStage = createCityCollisions();
  assert.ok(cargoStage.resolve([cargo, sidePerson], { dt: 0 }).stats.contacts > 0,
    'the cargo frame footprint reaches its side contact');
  assert.equal(bodyContact(cargo, sidePerson, {}), false, 'the cargo frame and person are fully separated');
});

test('vertical separation prevents air contacts on raised ground', () => {
  const stage = createCityCollisions();
  const person = actor('person', 0, 0, { y: 12 });
  const bike = actor('bike', 0, 0, { y: 0 });
  const result = stage.resolve([person, bike], { dt: 0 });
  assert.equal(result.stats.contacts, 0);
  assert.equal(distance(person, bike), 0);
});

test('fast crossing bodies are clipped before they pass through, including a stationary spawned body', () => {
  const stage = createCityCollisions();
  const crossing = actor('person', 3, 0, { prevX: -3, vx: 12 });
  const stationary = actor('bike', 0, 0, { prevX: 0 });
  stationary._wasPlaced = false;
  assert.equal(stationary._wasPlaced, false, 'the stationary body is treated as freshly placed');
  const result = stage.resolve([crossing, stationary], { dt: 0.05 });
  assert.ok(result.stats.contacts > 0);
  assert.ok(crossing.x < stationary.x, 'the moving rider is clipped on its original side');
  assert.ok(distance(crossing, stationary) >= 0.55);
  assert.equal(Number.isFinite(crossing.vx), true);
});

test('zero dt still separates coincident actors without NaNs', () => {
  const stage = createCityCollisions();
  const a = actor('car', 0, 0);
  const b = actor('person', 0, 0);
  const result = stage.resolve([a, b], { dt: 0 });
  assert.ok(result.stats.contacts > 0);
  for (const value of [a.x, a.z, b.x, b.z, a.vx, a.vz, b.vx, b.vz]) assert.ok(Number.isFinite(value));
  assert.ok(distance(a, b) > 0);
});

test('route-local contact offsets retain actor separation on the next simulation sync', () => {
  const stage = createCityCollisions();
  const route = { x: 0, z: 0 };
  const walker = actor('person', 0, 0);
  walker.offsetX = 0; walker.offsetZ = 0;
  walker.move = function move(dx, dz) {
    this.offsetX += dx; this.offsetZ += dz;
    this.x = route.x + this.offsetX; this.z = route.z + this.offsetZ;
    return this;
  };
  const bike = actor('bike', 0, 0);
  stage.resolve([walker, bike], { dt: 0 });
  route.z += 0.05;
  walker.x = route.x + walker.offsetX;
  walker.z = route.z + walker.offsetZ;
  walker.prevX = walker.x; walker.prevZ = walker.z;
  bike.prevX = bike.x; bike.prevZ = bike.z;
  stage.resolve([walker, bike], { dt: 0 });
  assert.ok(distance(walker, bike) > 0.5, 'route sync retained the contact correction');
});

test('a person pinned to a wall transfers blocked displacement to the colliding car', () => {
  const wall = { id: 'wall', type: 'building', minX: 0, maxX: 5, minZ: -10, maxZ: 10, minY: 0, maxY: 10 };
  const stage = createCityCollisions({ staticIndex: createStaticIndex([wall]) });
  const car = actor('car', -1, 0, { spec: { width: 1.8, length: 4.4, height: 1.8 }, mass: 1300 });
  const walker = actor('person', -0.5, 0, { radius: 0.48, mass: 72 });
  const result = stage.resolve([car, walker], { dt: 0 });
  assert.ok(result.stats.contacts > 0);
  assert.ok(result.stats.staticContacts > 0, 'the wall was checked after dynamic contact');
  assert.equal(buildingContact(wall, car.x, car.y, car.z, car, {}), false);
  assert.equal(buildingContact(wall, walker.x, walker.y, walker.z, walker, {}), false);
  assert.equal(bodyContact(car, walker, {}), false, 'the remaining penetration transfers to the car');

  car.prevX = car.x; car.prevZ = car.z;
  walker.prevX = walker.x; walker.prevZ = walker.z;
  stage.resolve([car, walker], { dt: 0 });
  assert.equal(bodyContact(car, walker, {}), false, 'the second step preserves the separation');
});

test('disjoint paths sharing a broadphase cell skip swept narrow-phase samples', () => {
  const stage = createCityCollisions();
  const moving = actor('person', 1, 0, { radius: 0.48, prevX: 0.8 });
  const stationary = actor('bike', 7, 0, { prevX: 7 });
  moving._wasPlaced = true;
  stationary._wasPlaced = true;
  const result = stage.resolve([moving, stationary], { dt: 0.02 });
  assert.ok(result.stats.candidatePairs > 0, 'the actors share a coarse grid cell');
  assert.ok(result.stats.sweepQueries > 0, 'the fast path considers their swept envelopes');
  assert.equal(result.stats.sweepSamples, 0, 'disjoint path envelopes never enter sampled contact');
  assert.equal(result.stats.contacts, 0);
});

test('pair correction rebuilds only after crossing into a new cell with a new neighbor', () => {
  const stage = createCityCollisions();
  const a = actor('player', 7, 0, { mode: 'person', radius: 0.48 });
  const b = actor('person', 7.1, 0, { radius: 0.48 });
  const c = actor('person', 8.48, 0, { radius: 0.48 });
  a._wasPlaced = b._wasPlaced = c._wasPlaced = false;
  const result = stage.resolve([a, b, c], { dt: 0 });
  assert.ok(result.stats.contacts >= 2, 'the original pair and the newly adjacent pair were resolved');
  assert.ok(result.stats.broadphaseBuilds >= 2, 'the correction expanded beyond the cached cell bounds');
  assert.equal(bodyContact(a, b, {}), false);
  assert.equal(bodyContact(b, c, {}), false, 'the newly adjacent pair is fully separated');
});

test('sparse thousand-actor broadphase generates bounded candidate work', () => {
  const stage = createCityCollisions();
  const actors = Array.from({ length: 1000 }, (_, i) => actor('person', (i % 50) * 40, Math.floor(i / 50) * 40));
  const result = stage.resolve(actors, { dt: 0 });
  assert.ok(result.stats.candidatePairs < 20, `candidate count ${result.stats.candidatePairs} stays local`);
  assert.equal(result.stats.contacts, 0);
});
