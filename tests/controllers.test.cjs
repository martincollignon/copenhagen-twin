const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
let swanNavigationModule;
let goBoatNavigationModule;
let cphLakes;
let collisionShapesModule;
let staticCollidersModule;

test.before(async () => {
  [swanNavigationModule, collisionShapesModule, staticCollidersModule] = await Promise.all([
    import('../js/swan-navigation.js'), import('../js/collision-shapes.js'), import('../js/static-colliders.js')
  ]);
  goBoatNavigationModule = await import('../js/goboat-navigation.js');
  cphLakes = JSON.parse(readFileSync(join(__dirname, '../data/cph-lakes.json'), 'utf8'));
});

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(overrides = {}, moduleImports = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    TELEPORT_LOCATIONS: { ns37: { z: 0 } },
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    ...overrides
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './actor-models.js': {},
      './swan-boat.js': { createSwanBoat: () => ({ group: {}, pedals: {}, paddleWheel: {} }) },
      './swan-navigation.js': swanNavigationModule,
      './goboat.js': { createGoBoat: () => ({ group: {} }) },
      './goboat-piers.js': { createGoBoatPiers: () => null, normalizeGoBoatPierRecords: records => records, GOBOAT_PIER_RECORDS: [] },
      './goboat-navigation.js': goBoatNavigationModule,
      './lakes-cph.js': { WATER: { surfaceY: -0.8 } },
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './collision-shapes.js': collisionShapesModule,
      './static-colliders.js': staticCollidersModule,
      ...moduleImports
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either Shift key keeps boost active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'ShiftLeft');
  key('keydown', 'ShiftRight');
  key('keyup', 'ShiftLeft');
  assert.equal(controller.keys.boost, true);
  key('keyup', 'ShiftRight');
  assert.equal(controller.keys.boost, false);
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('boost', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.boost, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'ShiftLeft');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist' || mode === 'Cargobike') Object.assign(entity, {
    standAmount: 0, bikeFrame: {},
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Helicopter') Object.assign(entity, {
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  });
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Helicopter') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  if (mode === 'Cyclist' || mode === 'Cargobike') controller.updateCyclist(0.1, entity, mode.toLowerCase());
  else controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Cargobike', 'Helicopter']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      const turn = mode === 'Car' ? 'steerAngle' : 'heading';
      assert.ok(Math.abs(partial[turn] - full[turn] * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Helicopter') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

test('pedal speed has inertia, coasts down, and stays within 6 km/h in both directions', () => {
  const { advanceSwanSpeed, SWAN_MAX_SPEED } = swanNavigationModule;
  let speed = 0;
  for (let i = 0; i < 1200; i++) speed = advanceSwanSpeed(speed, 1, 0.1);
  assert.ok(Math.abs(speed - SWAN_MAX_SPEED) < 1e-12);
  const coastStart = speed;
  for (let i = 0; i < 60; i++) speed = advanceSwanSpeed(speed, 0, 0.1);
  assert.ok(speed > 0 && speed < coastStart, 'releasing the pedals preserves momentum while slowing');
  for (let i = 0; i < 1200; i++) speed = advanceSwanSpeed(speed, -1, 0.1);
  assert.ok(speed < 0 && Math.abs(speed) <= SWAN_MAX_SPEED, 'reverse pedal input can never exceed the cap');
});

test('the swan controller substeps motion and remains on Peblinge water at the bridge boundary', () => {
  const nav = swanNavigationModule.createSwanNavigation(cphLakes);
  const { controller } = keyboardHarness();
  const boat = {
    position: { x: swanNavigationModule.SWAN_START.x, y: -0.72, z: swanNavigationModule.SWAN_START.z },
    heading: swanNavigationModule.SWAN_HEADING,
    speed: 0, vx: 0, vz: 0, pedalPhase: 0,
    pedals: { rotation: { x: 0 } }, paddleWheel: { rotation: { x: 0 } },
    mesh: { rotation: { x: 0, y: 0, z: 0 } }
  };
  controller.entities = { swanboat: boat };
  controller.swanNavigation = nav;
  controller.swanWaterLevel = -0.72;
  controller.keys.forward = true;

  for (let i = 0; i < 500; i++) controller.updateSwanBoat(0.1, i * 0.1);

  assert.ok(nav.isPositionLegal(boat.position.x, boat.position.z), 'the boat center retains its full hull clearance');
  assert.ok(Math.abs(boat.speed) <= swanNavigationModule.SWAN_MAX_SPEED);
  assert.equal(boat.position.y, -0.72, 'the measured lake surface is the boat origin height');
  assert.ok(boat.pedalPhase > 0 && boat.paddleWheel.rotation.x > 0, 'pedals and stern wheel animate with travel');

  const bridgeCrossing = swanNavigationModule.confineSwanMotion(nav, swanNavigationModule.SWAN_START, { x: 120, z: -220 });
  assert.ok(nav.isPositionLegal(bridgeCrossing.x, bridgeCrossing.z), 'a long frame cannot tunnel through Dronning Louises Bro');
});

test('confinement slides along an outer wall and stops at a hole with hull clearance', () => {
  const nav = swanNavigationModule.createSwanNavigation({
    lakes: [{ id: 'lake:0', ring: [0, 0, 100, 0, 100, 100, 0, 100], holes: [[40, 40, 60, 40, 60, 60, 40, 60]] }],
    bridges: []
  }, { pierRing: [], clearance: 2 });

  const wallSlide = swanNavigationModule.confineSwanMotion(nav, { x: 94, z: 20 }, { x: 20, z: 40 });
  assert.ok(nav.isPositionLegal(wallSlide.x, wallSlide.z));
  assert.ok(wallSlide.x < 98 && wallSlide.x > 97.8, 'the hull stays two metres off the east wall');
  assert.ok(wallSlide.z > 59, 'the blocked eastward part is removed while the tangent motion continues');

  const holeApproach = swanNavigationModule.confineSwanMotion(nav, { x: 30, z: 50 }, { x: 50, z: 0 });
  assert.ok(nav.isPositionLegal(holeApproach.x, holeApproach.z));
  assert.ok(holeApproach.x < 38 && holeApproach.x > 36, 'the boat stops before the hole with its full clearance');
});

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], cargobike: [6.2, 2.35], helicopter: [11.4, 3.3], swanboat: [5.8, 2.15] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'helicopter' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, carState: { value: { x: 0 } }, wheelSpin: 1,
    wheels: [{ isFront: true, steerPivot: { rotation: { y: 0.4 } }, tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7, standAmount: 0, bikeFrame: {},
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } },
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(),
    pedals: [], paddleWheel: { rotation: { x: 0 } },
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  if (mode === 'swanboat') Object.assign(ent, { vx: 0, vz: 0, pedalPhase: 0, pedals: { rotation: { x: 0 } } });
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

test('entering swanboat starts at the pier, while saved arrivals are confined to the lake', () => {
  const nav = swanNavigationModule.createSwanNavigation(cphLakes);
  const { controller, ent } = teleportHarness('car');
  const boat = teleportHarness('swanboat').ent;
  controller.entities.swanboat = boat;
  controller.swanNavigation = nav;
  controller.swanWaterLevel = -0.72;
  controller.getGroundHeight = (_x, _z, mode) => mode === 'swanboat' ? -0.72 : 0;

  controller.setMode('swanboat');
  assert.deepEqual([boat.position.x, boat.position.z], [swanNavigationModule.SWAN_START.x, swanNavigationModule.SWAN_START.z]);
  assert.equal(boat.position.y, -0.72);
  assert.equal(boat.speed, 0);
  assert.ok(nav.isPositionLegal(boat.position.x, boat.position.z));

  boat.position.x += 5;
  const arrival = controller.teleportActiveTo(swanNavigationModule.SWAN_START.x, swanNavigationModule.SWAN_START.z, swanNavigationModule.SWAN_HEADING);
  assert.deepEqual({ ...arrival }, { x: swanNavigationModule.SWAN_START.x, z: swanNavigationModule.SWAN_START.z });
  assert.ok(nav.isPositionLegal(arrival.x, arrival.z), 'restored swanboat positions must be on the lake');

  for (const [x, z] of [[-23.5, -464.4], [100, -520]]) {
    const recovered = controller.teleportActiveTo(x, z, swanNavigationModule.SWAN_HEADING);
    assert.ok(nav.isPositionLegal(recovered.x, recovered.z), `invalid water destination ${x}, ${z} resolves to a legal boat position`);
  }

  const savedArrival = [boat.position.x, boat.position.z];
  controller.setMode('car');
  controller.setMode('swanboat', { preserveSwanPosition: true });
  assert.deepEqual([boat.position.x, boat.position.z], savedArrival, 'restoring a saved boat does not move it back to the pier');

  const person = teleportHarness('person').ent;
  person.position.x = 0;
  person.position.y = 0.22;
  person.position.z = 0;
  controller.entities.person = person;
  controller.setMode('person');
  assert.equal(person.position.y, 0.22);
  assert.notDeepEqual([person.position.x, person.position.z], [boat.position.x, boat.position.z], 'the walking mode retains its dry position');
  controller.setMode('swanboat');
  assert.deepEqual([boat.position.x, boat.position.z], [swanNavigationModule.SWAN_START.x, swanNavigationModule.SWAN_START.z], 'ordinary re-entry returns the boat to its pier');
});

test('swanboat teleport fails closed until lake navigation data is ready', () => {
  const { controller, ent } = teleportHarness('swanboat');
  const before = [ent.position.x, ent.position.y, ent.position.z];
  const arrival = controller.teleportActiveTo(swanNavigationModule.SWAN_START.x, swanNavigationModule.SWAN_START.z);
  assert.deepEqual({ ...arrival }, { x: before[0], z: before[2] });
  assert.deepEqual([ent.position.x, ent.position.y, ent.position.z], before);
});

for (const mode of ['person', 'car', 'cyclist', 'cargobike', 'helicopter']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
    } else if (mode === 'cyclist' || mode === 'cargobike') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 120, 'keep the helicopter altitude when already above the minimum');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    if (mode === 'cyclist' || mode === 'cargobike') controller.updateCyclist(0.1, ent, mode);
    else controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'helicopter' ? 120 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6, `resolved X was ${ent.position.x}, ${ent.position.z}`);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('swept player, car, bicycle, cargo bike, and helicopter motion cannot tunnel through a thin pole', () => {
  const pole = {
    type: 'lamp', shape: 'circle', radius: 0.06,
    minX: -0.06, maxX: 0.06, minZ: -0.06, maxZ: 0.06, minY: 0, maxY: 4,
    obb: { cx: 0, cz: 0, hx: 0.06, hz: 0.06, cs: 1, sn: 0 }
  };
  const starts = { person: -4, car: -5, cyclist: -4, cargobike: -4, helicopter: -10 };
  const radii = { person: 0.48, car: 1.35, cyclist: 0.65, cargobike: 1.4, helicopter: 4.5 };
  for (const mode of Object.keys(starts)) {
    const { controller, ent } = teleportHarness(mode, [{ ...pole }]);
    ent.heading = Math.PI / 2;
    ent.position.x = 8;
    ent.position.y = mode === 'helicopter' ? 0 : 0;
    ent.position.z = 0;
    controller.resolveHorizontalCollision(ent.position, radii[mode], mode === 'car' ? ent : null, ent,
      { x: starts[mode], z: 0 });
    assert.ok(ent.position.x < 0, `${mode} stopped on the approach side at ${ent.position.x}`);
    assert.ok(Math.abs(ent.position.z) < 1e-6);
    assert.equal(controller._lastHorizontalCollisionResolved, true);
  }
});

test('each actual horizontal movement update supplies its previous position to the sweep', () => {
  const wall = { minX: 0, maxX: 0.08, minZ: -20, maxZ: 20, minY: 0, maxY: 30 };
  for (const mode of ['person', 'car', 'cyclist', 'cargobike', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...wall }]);
    const start = mode === 'helicopter' ? -10 : mode === 'car' ? -4 : -3;
    Object.assign(ent.position, { x: start, y: mode === 'helicopter' ? 0.25 : 0, z: 0 });
    ent.heading = Math.PI / 2;
    ent.speed = 0;
    if (mode === 'car') ent.vx = ent.vz = 0;
    if (mode === 'helicopter') ent.verticalSpeed = 0;
    controller.keys.forward = 1;
    if (mode === 'person') controller.updatePerson(1);
    else if (mode === 'car') controller.updateCar(1);
    else if (mode === 'cyclist' || mode === 'cargobike') controller.updateCyclist(1, ent, mode);
    else controller.updateHelicopter(1, 0);
    assert.ok(ent.position.x < 0, `${mode} update stopped before the wall at x=${ent.position.x}`);
    assert.equal(controller._lastHorizontalCollisionResolved, true);
  }
});

test('swept movement keeps tangent motion when glancing along a wall', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 0.2, minZ: -10, maxZ: 10, minY: 0, maxY: 30 }]);
  Object.assign(ent.position, { x: 1, y: 0, z: 4 });
  controller.resolveHorizontalCollision(ent.position, 0.48, null, ent, { x: -1, z: -1 });
  assert.ok(ent.position.x <= -0.48 + 1e-6 && ent.position.x > -0.51, `wall clearance is ${ent.position.x}`);
  assert.ok(ent.position.z > 3.9, `the blocked inward component was removed while z reached ${ent.position.z}`);
});

test('deep overlapping boxes resolve to a clear point after repeated bounded corrections', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: -10, maxZ: 10, minY: 0, maxY: 30 },
    { minX: -10, maxX: 0.1, minZ: -10, maxZ: 10, minY: 0, maxY: 30 }
  ];
  const { controller, ent } = teleportHarness('person', colliders);
  Object.assign(ent.position, { x: 0, y: 0, z: 0 });
  controller.resolveHorizontalCollision(ent.position, 0.48, null, ent);
  const body = collisionShapesModule.collisionBody('person', 0.48, 0);
  assert.ok(colliders.every((c) => !collisionShapesModule.buildingContact(c, ent.position.x, ent.position.y, ent.position.z, body, {})),
    `unresolved overlap at ${ent.position.x}, ${ent.position.z}`);
  assert.equal(controller._lastHorizontalCollisionResolved, true);
});

test('swept car impacts still trigger the existing vehicle response', () => {
  const pole = {
    type: 'bollard', shape: 'circle', radius: 0.12,
    minX: -0.12, maxX: 0.12, minZ: -0.12, maxZ: 0.12, minY: 0, maxY: 1,
    obb: { cx: 0, cz: 0, hx: 0.12, hz: 0.12, cs: 1, sn: 0 }
  };
  const { controller, ent } = teleportHarness('car', [pole]);
  ent.heading = Math.PI / 2;
  ent.speed = 12;
  Object.assign(ent.position, { x: 5, y: 0, z: 0 });
  controller.resolveHorizontalCollision(ent.position, 1.35, ent, ent, { x: -5, z: 0 });
  assert.ok(ent.position.x < 0 && ent.position.x > -2.6);
  assert.ok(ent.speed < 0, 'a head-on impact still rebounds the car');
  assert.ok(ent.lastCollisionSpark, 'the existing impact spark response remains connected');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = mode === 'helicopter' ? 0.25 : 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['helicopter', 3.2]]) {
    const y = mode === 'helicopter' ? 0.25 : 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = mode === 'helicopter' ? 10.35 : 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('helicopter skids cannot pass through a roof below the body origin', () => {
  const { controller, ent } = teleportHarness('helicopter', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 10.2, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 4.5);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 10.2) }, { x: 5, z: 5 });
});

test('ground arrivals share movement shoreline limits while helicopters may remain above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 8.5, z: -470 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const heli = teleportHarness('helicopter', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 50 }]);
  heli.ent.position.y = 10;
  assert.deepEqual({ ...heli.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(heli.ent.position.y, 92);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('successive mode teleports keep parked players out of the arrival and default chase view', () => {
  const { controller, ent: car } = teleportHarness('car');
  const person = teleportHarness('person').ent;
  const cyclist = teleportHarness('cyclist').ent;
  controller.entities = { car, person, cyclist };
  person.position.x = 300;
  cyclist.position.x = 200;
  const heading = Math.PI / 2; // The first radial candidate is +X: its rear camera would sit on the parked car.
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, heading) }, { x: 0, z: 0 });
  const arrivals = [car];
  const radii = { car: 2.4, person: 0.48, cyclist: 1.0 };
  for (const mode of ['person', 'cyclist']) {
    controller.activeMode = mode;
    const ent = controller.entities[mode];
    const actual = controller.teleportActiveTo(0, 0, heading);
    assert.notDeepEqual({ ...actual }, { x: 0, z: 0 });
    for (const parked of arrivals) {
      const dx = parked.position.x - actual.x, dz = parked.position.z - actual.z;
      const cameraBack = Math.cos(0.09) * ent.chaseDistance;
      const along = Math.max(0, Math.min(cameraBack, -dx));
      assert.ok(Math.hypot(dx, dz) > radii[parked.type] + radii[mode], 'player bodies must not overlap');
      assert.ok(Math.hypot(dx + along, dz) > radii[parked.type] + 0.5, 'the complete default chase corridor must be clear');
    }
    assert.deepEqual([car.position.x, car.position.z], [0, 0], 'switching modes leaves the parked car in place');
    arrivals.push(ent);
  }
});

test('player clearance respects altitude and permits a ground arrival under an airborne helicopter', () => {
  const { controller, ent } = teleportHarness('person');
  const helicopter = teleportHarness('helicopter').ent;
  helicopter.position.x = helicopter.position.z = 0;
  helicopter.position.y = 120;
  controller.entities.helicopter = helicopter;
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(ent.position.y, 0.22);
  helicopter.position.y = 1;
  assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 }, 'a helicopter parked at street level must be avoided');
});

for (const mode of ['cyclist', 'cargobike']) {
  test(`${mode} reaches 25 km/h normally and 30 km/h sprinting, standing only during acceleration`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    controller.resolveHorizontalCollision = () => {};
    ent.speed = 0;
    const step = (frames) => {
      for (let i = 0; i < frames; i++) controller.updateCyclist(1 / 60, ent, mode);
    };
    key('keydown', 'KeyW');
    step(20);
    assert.ok(ent.speed > 0 && ent.speed * 3.6 < 25);
    assert.ok(ent.bikeFrame.upright > 0.5, 'rider rises while gaining speed');
    step(240);
    assert.ok(Math.abs(ent.speed * 3.6 - 25) < 1e-8);
    assert.ok(ent.bikeFrame.upright < 0.01, 'rider settles onto the saddle at steady speed');
    key('keydown', 'ShiftLeft');
    step(180);
    assert.ok(Math.abs(ent.speed * 3.6 - 30) < 1e-8);
    key('keyup', 'KeyW');
    key('keyup', 'ShiftLeft');
    step(120);
    assert.ok(ent.speed * 3.6 < 30, 'released pedals allow the bike to slow');
    assert.ok(ent.bikeFrame.upright < 0.01, 'coasting does not stand the rider up');
  });
}

function swanRiderHarness() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  }
  class Group {
    constructor() { this.children = []; this.position = new Vector3(); this.visible = true; }
    add(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  }
  class PersonCrowd {
    constructor(capacity) { this.capacity = capacity; this.meshes = [{ visible: true, count: 0 }]; this.rigs = []; }
    begin() { this.rigs = []; }
    add(rig) { assert.ok(this.rigs.length < this.capacity); this.rigs.push(rig); }
    end() { this.meshes[0].count = this.rigs.length; }
  }
  class PersonRig {
    constructor(appearance) { this.appearance = appearance; this.calls = []; }
    ride(anchor, phase, frame) { this.calls.push({ anchor, phase, frame }); }
  }
  const { controller } = keyboardHarness({}, {
    'three/webgpu': { Group, Vector3 },
    './pedestrians.js': { PersonCrowd, PersonRig },
    './swan-boat.js': { createSwanBoat: () => ({ group: new Group(), pedals: new Group(), paddleWheel: new Group() }) }
  });
  controller.scene = new Group();
  const boat = controller.createSwanBoatEntity();
  const walker = { mesh: new Group(), crowd: new PersonCrowd(1), rig: new PersonRig({ seed: 4.2 }) };
  walker.crowd.add(walker.rig); walker.crowd.end();
  controller.entities = { swanboat: boat, person: walker, car: {} };
  controller.activeMode = 'person';
  controller.teleportActiveTo = () => {};
  return { controller, boat, walker };
}

test('swan entity owns two existing person rigs at separate boat-relative seat anchors', () => {
  const { controller, boat } = swanRiderHarness();
  assert.equal(boat.riders.length, 2);
  assert.equal(boat.riderCrowd.capacity, 2);
  assert.deepEqual(Array.from(boat.riders, rider => rider.anchor.position.x), [-0.29, 0.29]);
  for (const rider of boat.riders) assert.equal(rider.anchor.parent, boat.mesh);
  assert.equal(boat.riders[0].rig.appearance.seed, 4.2, 'player keeps the walking avatar appearance');
  assert.notEqual(boat.riders[1].rig.appearance.seed, boat.riders[0].rig.appearance.seed);
  for (const mesh of boat.riderCrowd.meshes) {
    assert.equal(mesh.parent, controller.scene, 'world-space skinned meshes must not inherit the boat transform twice');
    assert.equal(mesh.visible, false, 'parked playable boat starts empty');
    assert.equal(mesh.count, 0);
  }
});

test('boarding, exiting and reboarding show exactly two swan riders and restore one walker', () => {
  const { controller, boat, walker } = swanRiderHarness();
  const originalRigs = Array.from(boat.riders, rider => rider.rig);
  for (let repeat = 0; repeat < 3; repeat++) {
    controller.setMode('swanboat');
    controller.poseSwanRiders();
    assert.equal(boat.riderCrowd.meshes[0].visible, true);
    assert.equal(boat.riderCrowd.meshes[0].count, 2);
    assert.equal(walker.crowd.meshes[0].visible, false);
    assert.equal(walker.mesh.visible, false, 'walking contact shadow is hidden with the walker');
    controller.setMode(repeat === 1 ? 'car' : 'person');
    assert.equal(boat.riderCrowd.meshes[0].visible, false, 'exit hides riders before the next frame');
    assert.equal(boat.riderCrowd.meshes[0].count, 0, 'exit clears the GPU instance count');
    controller.poseSwanRiders();
    assert.equal(boat.riderCrowd.meshes[0].count, 0);
    assert.equal(walker.crowd.meshes[0].visible, true);
    assert.equal(walker.mesh.visible, true);
    assert.equal(walker.crowd.meshes[0].count, 1);
    assert.deepEqual(Array.from(boat.riders, rider => rider.rig), originalRigs, 'reboarding reuses both rigs');
  }
});

test('seated riders follow the signed pedal phase and keep their knees raised above a low seat', () => {
  const { controller, boat } = swanRiderHarness();
  controller.setMode('swanboat');
  for (const phase of [0, 1.3, -0.7]) {
    boat.pedalPhase = phase;
    controller.poseSwanRiders();
    for (const rider of boat.riders) {
      const call = rider.rig.calls.at(-1);
      assert.equal(call.anchor, rider.anchor);
      assert.equal(call.phase, phase);
      assert.equal(call.frame, boat.riderFrame);
      assert.ok(call.frame.kneeLift > 0);
      assert.ok(call.frame.seat.y < 0.3);
      assert.ok(call.frame.bracket.z > call.frame.seat.z);
    }
  }
  controller.setMode('person');
  controller.poseSwanRiders();
  for (const rider of boat.riders) assert.equal(rider.rig.calls.length, 3, 'inactive riders are not posed');
});

function goBoatHarness() {
  const { controller } = keyboardHarness();
  const vector = (x = 0, y = 0, z = 0) => ({ x, y, z, set(x, y, z) { Object.assign(this, { x, y, z }); return this; }, copy(v) { return this.set(v.x, v.y, v.z); } });
  const mesh = () => ({ position: vector(), rotation: { x: 0, y: 0, z: 0 }, visible: true });
  const pier = { departurePoint: { x: 0, z: 0, heading: 0 }, boardingPoint: { x: 0, z: 5, heading: 0 }, deckHeight: -5.96 };
  const boat = { type: 'goboat', position: vector(0, -6.84, 0), mesh: mesh(), heading: 0, speed: 0, vx: 0, vz: 0 };
  const person = { type: 'person', position: vector(0, -5.96, 5), mesh: mesh(), crowd: { meshes: [] }, rig: { reset() {} } };
  controller.entities = { goboat: boat, person };
  controller.activeMode = 'person';
  controller.goBoatPiers = { records: [pier] };
  controller.goBoatNavigation = goBoatNavigationModule.createGoBoatNavigation({ waterOverride: [{ ring: [-30, -30, 30, -30, 30, 30, -30, 30], level: -6.84 }], pierRecords: [pier] });
  return { controller, boat, person, pier };
}

test('GoBoat mode is refused when harbour is missing without moving another entity', () => {
  const { controller, person } = goBoatHarness();
  controller.goBoatNavigation = null;
  assert.equal(controller.setMode('goboat'), false);
  assert.equal(controller.activeMode, 'person');
  assert.deepEqual([person.position.x, person.position.z], [0, 5]);
});
test('GoBoat boards at the pier, returns walker to deck and preserves position on reboarding', () => {
  const { controller, boat, person, pier } = goBoatHarness();
  assert.equal(controller.getGoBoatInteraction().action, 'board');
  assert.equal(controller.interactGoBoat(), true);
  assert.equal(controller.activeMode, 'goboat');
  assert.equal(person.mesh.visible, false);
  boat.position.x = 1;
  assert.equal(controller.interactGoBoat(), true);
  assert.equal(controller.activeMode, 'person');
  assert.equal(person.position.y, pier.deckHeight);
  assert.equal(person.mesh.visible, true);
  assert.equal(controller.interactGoBoat(), true);
  assert.equal(boat.position.x, 1);
});
test('GoBoat cannot disembark while moving or away from the pier; Walk mode returns safely', () => {
  const { controller, boat, person } = goBoatHarness();
  controller.setMode('goboat');
  boat.speed = 1;
  assert.equal(controller.interactGoBoat(), false);
  boat.speed = 0; boat.vx = 1;
  assert.equal(controller.interactGoBoat(), false, 'remaining drift also prevents disembarking');
  boat.vx = 0; boat.position.x = 20;
  assert.equal(controller.interactGoBoat(), false);
  controller.setMode('person');
  assert.deepEqual([person.position.x, person.position.z], [0, 5]);
});
test('GoBoat update honours water clearance and clears momentum at collision', () => {
  const { controller, boat } = goBoatHarness();
  controller.setMode('goboat'); controller.keys.forward = true;
  for (let i = 0; i < 1000; i++) controller.updateGoBoat(0.1, i * 0.1);
  assert(controller.goBoatNavigation.isPositionLegal(boat.position.x, boat.position.z));
  assert(boat.position.z < 27.2);
  assert.equal(boat.position.y, -6.84);
});


test('saved-state mode restoration does not overwrite the saved walking position with a pier return', () => {
  const { controller, person } = goBoatHarness();
  controller.setMode('goboat');
  person.position.set(80, 2, 70);
  controller.setMode('person', { restoreState: true });
  assert.deepEqual([person.position.x, person.position.y, person.position.z], [80, 2, 70]);
});
