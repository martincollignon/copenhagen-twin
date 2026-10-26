import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyContact, buildingContact, collisionBody } from '../js/collision-shapes.js';

const box = (x, y, z, mode = 'car', heading = 0) => ({
  x, y, z, ...collisionBody(mode, mode === 'car' ? 1.35 : 0.48, heading)
});

test('collisionBody preserves circle, car, cargo bike, and helicopter footprints', () => {
  const person = collisionBody('person', 0.48, 0);
  assert.equal(person.radius, 0.48);
  assert.equal(person.extX, 0.48);
  assert.equal(person.top, 1.9);
  const car = collisionBody('car', 1.35, Math.PI / 2, 0, { width: 2, length: 5 });
  assert.equal(car.hx, 1);
  assert.equal(car.hz, 2.5);
  assert.ok(Math.abs(car.extX - 2.5) < 1e-10);
  assert.equal(collisionBody('cargobike', 0.65, 0).hz, 1.34);
  const cityBike = collisionBody('cyclist', 0.65, 0);
  assert.equal(cityBike.oriented, true);
  assert.deepEqual([cityBike.hx, cityBike.hz], [0.34, 0.95]);
  assert.equal(collisionBody('cargobike', 1.4, 0).offsetForward, -0.06);
  assert.deepEqual([collisionBody('helicopter', 4.5, 0).bottom, collisionBody('helicopter', 4.5, 0).top], [-0.25, 3.2]);
  assert.equal(collisionBody('car', 1.35, 0, 0, { height: 2.65 }).top, 2.65);
});

test('bodyContact returns the B-to-A normal for circles and uses a stable zero-distance direction', () => {
  const contact = {};
  assert.equal(bodyContact(box(0, 0, 0, 'person'), box(0.7, 0, 0, 'person'), contact), true);
  assert.deepEqual([contact.nx, contact.nz, contact.depth], [-1, 0, 0.26]);
  assert.equal(bodyContact(box(0, 0, 0, 'person'), box(0, 0, 0, 'person'), contact), true);
  assert.deepEqual([contact.nx, contact.nz], [1, 0]);
});

test('bodyContact uses exact oriented box and circle-to-box corner distance', () => {
  const contact = {};
  const sedan = box(0, 0, 0, 'car', Math.PI / 4);
  const pedestrian = box(1.8, 0, 2.1, 'person');
  assert.equal(bodyContact(pedestrian, sedan, contact), false, 'nearby projected bounds do not create a corner collision');
  const closer = box(0.9, 0, 1.6, 'person');
  assert.equal(bodyContact(closer, sedan, contact), true);
  const forward = { ...contact };
  assert.ok(Math.hypot(contact.nx, contact.nz) > 0.999999);
  assert.ok(contact.depth > 0);
  const reverse = {};
  assert.equal(bodyContact(sedan, closer, reverse), true);
  assert.ok(Math.abs(reverse.nx + forward.nx) < 1e-9 && Math.abs(reverse.nz + forward.nz) < 1e-9,
    'swapping argument order reverses the normal');
});

test('bodyContact ignores actors with separated vertical intervals', () => {
  const person = box(0, 0, 0, 'person');
  const helicopter = box(0.2, 4, 0, 'helicopter');
  assert.equal(bodyContact(person, helicopter, {}), false);
  const nearbyGroundBike = box(0.2, 0, 0, 'cyclist');
  const airbornePerson = { ...person, y: 2.2 };
  assert.equal(bodyContact(airbornePerson, nearbyGroundBike, {}), false);
});

test('legacy buildingContact keeps rounded corners and vertical overhang clearances', () => {
  const wall = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 0, maxY: 10 };
  const person = collisionBody('person', 0.48, 0);
  const contact = {};
  assert.equal(buildingContact(wall, -0.4, 0, -0.4, person, contact), false);
  assert.equal(buildingContact(wall, -0.2, 0, -0.2, person, contact), true);
  assert.ok(Math.abs(Math.hypot(contact.nx, contact.nz) - 1) < 1e-10);
  assert.equal(buildingContact({ ...wall, minY: 4 }, 5, 0, 5, person, contact), false);
  assert.equal(buildingContact({ ...wall, maxY: 1.8 }, 5, 0, 5, person, contact), true);
});
