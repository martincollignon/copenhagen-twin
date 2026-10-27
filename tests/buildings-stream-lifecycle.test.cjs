const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const overrideApi = loadModule(fs.readFileSync(path.join(__dirname, '../js/detail-overrides.js'), 'utf8'), { filename: 'detail-overrides.js' });

class Group {
  constructor(name = '') { this.name = name; this.children = []; this.parent = null; }
  add(child) { child.removeFromParent?.(); this.children.push(child); child.parent = this; }
  remove(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parent = null; }
  removeFromParent() { this.parent?.remove(this); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ overrideMode = 'off' } = {}) {
  const calls = [];
  const materialDisposals = [];
  let slicer;
  const buildRealBuildings = (holder, geo, options) => {
    const wait = deferred();
    calls.push({ holder, geo, options, ...wait });
    return wait.promise;
  };
  const createBuildingMaterials = () => Object.fromEntries(['wall', 'roof', 'door'].map((name) => [name, {
    name,
    dispose() { materialDisposals.push(name); }
  }]));
  const imports = {
    'three/webgpu': { Group },
    './buildings-real.js': { buildRealBuildings, createBuildingMaterials, createInfoPanel: () => null },
    './facade-lod.js': { texRequested: () => false, createPhotoBudget: () => null },
    './yield-frame.js': { createSharedSlicer: (budget) => { slicer = async () => {}; slicer.budget = budget; return slicer; } },
    './detail-overrides.js': {
      createOverrideBudget: () => overrideApi.createOverrideBudget({ maxTextureBytes: 20, maxMeshes: 2 }),
      createOverrideBudgetLease: overrideApi.createOverrideBudgetLease,
      overridesMode: () => overrideMode
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../js/buildings-stream.js'), 'utf8');
  const { createBuildingsLayer } = loadModule(source, { imports, globals: { AbortController }, filename: 'buildings-stream.js' });
  const scene = new Group('scene');
  const layer = createBuildingsLayer(scene, { tex: false });
  const ctx = { buildingGeo: { buildings: [] }, geo: { buildings: [], roads: [] }, overrides: { entries: new Map() } };
  const instance = (id, buildings = 1) => {
    const group = new Group(`instance-${id}`);
    return {
      group,
      byId: new Map([[id, { id }]]),
      stats: { buildings, cells: buildings, triangles: buildings * 2, doors: 0, lod2: 0, meshes: 1, heroes: [], overrides: {}, neon: {}, tex: null },
      heroGroups: [], heroStatus: [], overrideGroups: [],
      disposeCount: 0,
      dispose() { this.disposeCount++; group.removeFromParent(); },
      update() {}, setCamera() {}, pick() { return { id, distance: 1 }; }, infoFor: () => ({ id }), overrideIds: () => []
    };
  };
  const start = (ring = 'near') => layer.addTile('tile', ctx, ring);
  return { calls, layer, scene, ctx, instance, start, get slicer() { return slicer; }, materialDisposals };
}

async function buildActive(h, id = 'old', ring = 'near') {
  const pending = h.start(ring);
  const instance = h.instance(id);
  h.calls.at(-1).resolve(instance);
  assert.equal(await pending, true);
  return instance;
}

test('replacement keeps active content queryable until a complete atomic swap', async () => {
  const h = setup();
  const old = await buildActive(h, 'old', 'near');
  const pending = h.start('mid');
  const call = h.calls.at(-1);

  assert.equal(h.layer.ringOf('tile'), 'near');
  assert.equal(h.layer.has('tile'), true);
  assert.equal(h.layer.ids().length, 1);
  assert.equal(h.layer.ids()[0], 'tile');
  assert.equal(h.layer.byId.get('old').id, 'old');
  assert.equal(h.layer.stats.buildings, 1);
  assert.equal(h.layer.pick(0, 0).id, 'old');
  assert.equal(h.layer.group.children.length, 1, 'pending holder is not attached');
  assert.equal(call.options.slice, h.slicer);
  assert.equal(h.slicer.budget, 5);

  const next = h.instance('next', 3);
  call.resolve(next);
  assert.equal(await pending, true);
  assert.equal(h.layer.ringOf('tile'), 'mid');
  assert.equal(h.layer.byId.get('old'), undefined);
  assert.equal(h.layer.byId.get('next').id, 'next');
  assert.equal(h.layer.stats.buildings, 3);
  assert.equal(h.layer.pick(0, 0).id, 'next');
  assert.equal(old.disposeCount, 1);
  assert.equal(h.layer.group.children.length, 1);
});

test('a rejected replacement leaves active content and its ring intact', async () => {
  const h = setup();
  const old = await buildActive(h, 'old', 'near');
  const pending = h.start('mid');
  h.calls.at(-1).reject(new Error('replacement failed'));

  await assert.rejects(pending, /replacement failed/);
  assert.equal(h.layer.has('tile'), true);
  assert.equal(h.layer.ringOf('tile'), 'near');
  assert.equal(h.layer.byId.get('old').id, 'old');
  assert.equal(h.layer.stats.buildings, 1);
  assert.equal(old.disposeCount, 0);
});

test('removal during a build aborts it and disposes its late completion', async () => {
  const h = setup();
  const pending = h.start('near');
  const call = h.calls.at(-1);
  assert.equal(h.layer.removeTile('tile'), true);
  assert.equal(call.options.signal.aborted, true);
  const late = h.instance('late');
  call.resolve(late);

  assert.equal(await pending, false);
  assert.equal(late.disposeCount, 1);
  assert.equal(h.layer.has('tile'), false);
  assert.equal(h.layer.ids().length, 0);
  assert.equal(h.layer.group.children.length, 0);
});

test('superseded build cannot replace newer content when it completes last', async () => {
  const h = setup();
  const old = await buildActive(h, 'old', 'mid');
  const first = h.start('near');
  const firstCall = h.calls.at(-1);
  const second = h.start('mid');
  const secondCall = h.calls.at(-1);
  assert.equal(firstCall.options.signal.aborted, true);

  const next = h.instance('next', 2);
  secondCall.resolve(next);
  assert.equal(await second, true);
  const stale = h.instance('stale');
  firstCall.resolve(stale);
  assert.equal(await first, false);

  assert.equal(h.layer.ringOf('tile'), 'mid');
  assert.equal(h.layer.byId.get('next').id, 'next');
  assert.equal(h.layer.byId.get('stale'), undefined);
  assert.equal(next.disposeCount, 0);
  assert.equal(stale.disposeCount, 1);
  assert.equal(old.disposeCount, 1);
});

test('dispose waits for pending builds before releasing shared materials', async () => {
  const h = setup();
  const pending = h.start('near');
  const call = h.calls.at(-1);
  h.layer.dispose();
  assert.equal(call.options.signal.aborted, true);
  assert.deepEqual(h.materialDisposals, []);

  const late = h.instance('late');
  call.resolve(late);
  assert.equal(await pending, false);
  assert.equal(late.disposeCount, 1);
  assert.deepEqual(h.materialDisposals.sort(), ['door', 'roof', 'wall']);
  assert.equal(h.scene.children.length, 0);
});

test('same building id replacement keeps separate override leases until the active owner is disposed', async () => {
  const h = setup({ overrideMode: 'on' });
  const old = await buildActive(h, 'same-id', 'near');
  const oldLease = h.calls[0].options.overrides.budget;
  assert.equal(oldLease.reserve('same-id', 8), true);

  const pending = h.start('near');
  const replacement = h.calls.at(-1);
  const newLease = replacement.options.overrides.budget;
  assert.notEqual(newLease, oldLease);
  assert.equal(newLease.reserve('same-id', 8), true, 'the shared cap counts both physical copies');
  assert.equal(h.layer.overrideBudget.memory().meshes, 2);

  const next = h.instance('same-id', 2);
  replacement.resolve(next);
  assert.equal(await pending, true);
  assert.equal(old.disposeCount, 1);
  assert.equal(h.layer.byId.get('same-id'), next.byId.get('same-id'));
  assert.equal(h.layer.overrideBudget.memory().meshes, 1, 'the replacement keeps its reservation');

  h.layer.removeTile('tile');
  assert.equal(h.layer.overrideBudget.memory().meshes, 0);
});

test('failed and removed late builds release only their build-local override reservations', async () => {
  const h = setup({ overrideMode: 'on' });
  const active = await buildActive(h, 'active', 'near');
  const failed = h.start('near');
  const failedCall = h.calls.at(-1);
  assert.equal(failedCall.options.overrides.budget.reserve('failed-id', 5), true);
  failedCall.reject(new Error('build failed'));
  await assert.rejects(failed, /build failed/);
  assert.equal(h.layer.overrideBudget.memory().meshes, 0);
  assert.equal(h.layer.byId.get('active').id, 'active');

  const removed = h.start('near');
  const removedCall = h.calls.at(-1);
  assert.equal(removedCall.options.overrides.budget.reserve('late-id', 5), true);
  assert.equal(h.layer.removeTile('tile'), true);
  const late = h.instance('late');
  removedCall.resolve(late);
  assert.equal(await removed, false);
  assert.equal(late.disposeCount, 1);
  assert.equal(h.layer.overrideBudget.memory().meshes, 0);
  assert.equal(active.disposeCount, 1);
});
