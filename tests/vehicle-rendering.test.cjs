const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');

function productionFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}
function dummyObject() {
  const dummy = { matrix: {}, updateMatrix() {} };
  for (const key of ['position', 'rotation', 'scale']) dummy[key] = { set(...values) { dummy.matrix[key] = values; } };
  return dummy;
}
function mesh() {
  return { count: 0, writes: [], geometry: { attributes: {
    paintColor: { array: new Float32Array(3) }, carState: { array: new Float32Array(4) }
  } }, setMatrixAt(index, matrix) { this.writes.push({ index, matrix: structuredClone(matrix) }); } };
}

test('two- and three-axle vehicles pack wheel slots without overwriting one another', () => {
  const dummy = dummyObject(), left = mesh(), right = mesh();
  const place = productionFunction('placeWheels', { dummy, groundAt: () => 3 });
  const car = { x: 10, z: 20, wheelSpin: 0.3, steer: 0.15 };
  place(car, 0, 0, 0, 0.37, 0.82, 1.4, left, right);
  place(car, 2, 0, 0, 0.48, 1.24, 7.1, left, right, 0.48, [7.1, 0.2, -6.9]);
  place(car, 5, 0, 0, 0.48, 1.24, 3.6, left, right, 0.48);
  assert.deepEqual(left.writes.map((w) => w.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(right.writes.map((w) => w.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(left.writes.slice(2, 5).map((w) => w.matrix.position[2]), [27.1, 20.2, 13.1]);
  for (const side of [left, right]) {
    assert.equal(side.writes[2].matrix.rotation[1], car.steer);
    assert.equal(side.writes[3].matrix.rotation[1], 0);
    assert.equal(side.writes[4].matrix.rotation[1], 0);
    assert.equal(side.writes[2].matrix.position[1], 3.48);
  }
});

for (const near of [true, false]) {
  test(`taxi sign state resets when a ${near ? 'near' : 'proxy'} body slot is reused by a private car`, () => {
    const meshes = { near: mesh(), far: mesh() }, dirtyState = new Set();
    const spec = { width: 1.88, length: 4.6, wheelRadius: 0.37, wheelX: 0.82, wheelZ: 1.4 };
    const shadow = mesh();
    let wheels = 0;
    const render = productionFunction('renderCar', {
      BODY_SPECS: { crossoverEV: spec }, bodies: { crossoverEV: meshes }, dummy: dummyObject(),
      groundAt: () => 2, hasView: false, focusX: 0, focusZ: 0, CAR_PROXY_DISTANCE: 90,
      camX: 0, camY: 0, camZ: 0, MAX_LIGHT_DIST_SQ: 0, clock: 0,
      dirtyPaint: new Set(), dirtyState, visibleCars: 0, wheelCars: 0,
      carShadowInst: shadow, carWheelLeftInst: {}, carWheelRightInst: {}, placeWheels() { wheels++; }
    });
    const c = { bodyType: 'crossoverEV', taxi: true, paint: [0.25, 0.25, 0.25],
      x: near ? 0 : 120, z: 0, prevX: 0, prevZ: 0, yaw: 0, yawOffset: 0,
      pitch: 0, roll: 0, wheelSpin: 0, blink: -1, blinkPhase: 0, acc: -2, speed: 3 };
    const target = meshes[near ? 'near' : 'far'];
    render(c);
    assert.deepEqual(Array.from(target.geometry.attributes.carState.array), [1, 1, 0, 1]);
    assert.ok(dirtyState.has(target));
    target.count = 0; dirtyState.clear();
    render({ ...c, taxi: false });
    assert.deepEqual(Array.from(target.geometry.attributes.carState.array), [1, 1, 0, 0]);
    assert.ok(dirtyState.has(target), 'changing only the sign flag uploads state');
    assert.equal(wheels, near ? 2 : 0);
    assert.deepEqual(shadow.writes[0].matrix.scale, [spec.width + 0.3, 1, spec.length + 0.5]);
  });
}
