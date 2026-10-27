const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

let legacyNow = 0;
const source = fs.readFileSync(path.join(__dirname, '../js/yield-frame.js'), 'utf8');
const { createSlicer, createSharedSlicer } = loadModule(source, {
  globals: { performance: { now: () => legacyNow } },
  filename: 'yield-frame.js'
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('shared slicer joins concurrent frame waits and starts one shared budget', async () => {
  let now = 0;
  let waits = 0;
  const frames = [];
  const slice = createSharedSlicer(5, {
    now: () => now,
    wait: () => {
      waits++;
      const frame = deferred();
      frames.push(frame);
      return frame.promise;
    }
  });

  now = 6;
  const first = slice();
  const second = slice();
  await Promise.resolve();
  assert.equal(waits, 1);
  now = 16;
  frames[0].resolve();
  await Promise.all([first, second]);
  assert.equal(waits, 1);

  now = 22;
  const third = slice();
  await Promise.resolve();
  assert.equal(waits, 2, 'a later checkpoint sees the elapsed shared budget');
  now = 30;
  frames[1].resolve();
  await third;
});

test('existing createSlicer keeps its one-wait API', async () => {
  let waits = 0;
  const slice = createSlicer(8, async () => { waits++; });
  legacyNow = 20;
  await slice();
  assert.equal(waits, 1);
});
