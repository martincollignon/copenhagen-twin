const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const facade = loadModule(fs.readFileSync(path.join(__dirname, '../js/facade-lod.js'), 'utf8'), { filename: 'facade-lod.js' });
const { createPhotoDrawBudget, createPhotoRenderCallback } = facade;

function photoMesh() {
  return { userData: { photoOverlay: true }, geometry: {}, material: { version: 0 } };
}

test('a cold overshooting draw defers later cold photos, while warm draws remain admitted', () => {
  let time = 0;
  const budget = createPhotoDrawBudget({ now: () => time, budgetMs: 4 });
  const first = photoMesh();
  const second = photoMesh();
  let draws = 0;
  const drawSlowly = () => { draws++; time += 6; };
  const main = { camera: {}, target: {}, mrt: {} };

  budget.beginFrame();
  budget.render(first, main, drawSlowly);
  budget.render(second, main, drawSlowly);
  budget.render(first, main, drawSlowly);

  assert.equal(draws, 2, 'the first cold draw and a warm draw execute');
  assert.deepEqual(JSON.parse(JSON.stringify(budget.snapshot())), {
    deferred: 1,
    admitted: 1,
    lastFrame: { deferred: 1, admitted: 1, coldCpuMs: 6 },
    budgetMs: 4,
    unlimited: false
  });

  budget.beginFrame();
  budget.render(second, main, drawSlowly);
  assert.equal(draws, 3, 'the next frame resumes cold admission');
  assert.equal(budget.snapshot().lastFrame.deferred, 0);
});

test('readiness is separate for reflection passes and invalidates on material version or geometry changes', () => {
  let time = 0;
  const budget = createPhotoDrawBudget({ now: () => time, budgetMs: 1 });
  const mesh = photoMesh();
  const camera = {};
  const main = { camera, target: {}, mrt: {} };
  const reflection = { camera: {}, target: {}, mrt: {} };
  const draw = () => { time += 2; };

  budget.beginFrame({ unlimited: true });
  budget.render(mesh, main, draw);
  budget.beginFrame();
  budget.render(mesh, reflection, draw);
  budget.render(mesh, main, draw);
  assert.equal(budget.snapshot().lastFrame.admitted, 1, 'reflection is cold; the main pass stays warm past the budget');

  mesh.material.version++;
  budget.beginFrame({ unlimited: true });
  budget.render(mesh, main, draw);
  const oldGeometry = mesh.geometry;
  mesh.geometry = {};
  budget.beginFrame({ unlimited: true });
  budget.render(mesh, main, draw);
  assert.notEqual(mesh.geometry, oldGeometry);
  assert.equal(budget.snapshot().admitted, 4);
});

test('boot warm-up and the A/B unlimited mode admit every cold photo draw', () => {
  let time = 0;
  const budget = createPhotoDrawBudget({ now: () => time, budgetMs: 4 });
  const objects = [photoMesh(), photoMesh(), photoMesh()];
  budget.beginFrame({ unlimited: true }); // first warm-up frame behind the loading overlay
  for (const object of objects) budget.render(object, { camera: {}, target: {}, mrt: {} }, () => { time += 9; });
  assert.equal(budget.snapshot().deferred, 0);
  assert.equal(budget.snapshot().lastFrame.admitted, 3);

  budget.beginFrame({ unlimited: true }); // debug=nophotobudget
  budget.render(photoMesh(), { camera: {}, target: {}, mrt: {} }, () => { time += 9; });
  budget.render(photoMesh(), { camera: {}, target: {}, mrt: {} }, () => { time += 9; });
  assert.equal(budget.snapshot().lastFrame.admitted, 2);
  assert.equal(budget.snapshot().deferred, 0);
});

test('render wrapper preserves all callback arguments and delegates with the renderer as this', () => {
  const target = {};
  const mrt = {};
  const renderer = {
    getRenderTarget() { return target; },
    getMRT() { return mrt; },
    renderObject() { throw new Error('fallback should not be used'); }
  };
  const budget = createPhotoDrawBudget({ now: () => 0 });
  const received = [];
  function previous(...args) {
    assert.equal(this, renderer);
    received.push(args);
    return 'rendered';
  }
  const callback = createPhotoRenderCallback(renderer, budget, previous);
  const object = photoMesh();
  const args = [object, {}, {}, {}, {}, {}, {}, {}];
  budget.beginFrame({ unlimited: true });

  assert.equal(callback(...args), 'rendered');
  assert.equal(received[0].length, args.length);
  args.forEach((arg, i) => assert.equal(received[0][i], arg));

  const reflectionArgs = [object, args[1], {}, ...args.slice(3)];
  callback(...reflectionArgs);
  assert.equal(received.length, 2, 'a distinct camera pass draws independently');

  const ordinary = { userData: {} };
  callback(ordinary, ...args.slice(1));
  assert.equal(received.length, 3, 'non-photo objects delegate directly');
});

test('a failed draw remains cold and can retry on a later frame', () => {
  let time = 0;
  const budget = createPhotoDrawBudget({ now: () => time });
  const mesh = photoMesh();
  const context = { camera: {}, target: {}, mrt: {} };
  budget.beginFrame();
  assert.throws(() => budget.render(mesh, context, () => {
    time += 6;
    throw new Error('shader failed');
  }), /shader failed/);

  budget.beginFrame();
  budget.render(photoMesh(), context, () => { time += 6; });
  let retried = false;
  budget.render(mesh, context, () => { retried = true; });
  assert.equal(retried, false, 'a failed shader did not become a warm draw');
  budget.beginFrame();
  budget.render(mesh, context, () => { retried = true; });
  assert.equal(retried, true);
});

