const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

test('three.js is pinned to one immutable ref (a build commit or a release), not a moving branch', () => {
  const { imports } = JSON.parse(read('index.html').match(/<script type="importmap">([^]*?)<\/script>/)[1]);
  const refs = new Set();
  for (const [name, url] of Object.entries(imports)) {
    if (!name.startsWith('three')) continue;
    const ref = url.match(/three\.js@([^/]+)\//)?.[1] ?? url.match(/\/npm\/three@([^/]+)\//)?.[1];
    assert.ok(ref, `${name} comes from jsDelivr gh/mrdoob/three.js@<ref> or npm/three@<version>`);
    assert.match(ref, /^([0-9a-f]{40}|\d+\.\d+\.\d+)$/, `${name} is pinned (full commit SHA or exact version), got @${ref}`);
    refs.add(ref);
  }
  assert.equal(refs.size, 1, 'core build and addons come from the same three.js commit');
});

test('bench.js is the first module main.js evaluates, so ?bench seeds Math.random before anything uses it', () => {
  const firstImport = read('js/main.js').match(/^import [^;]+ from '([^']+)';/m)[1];
  assert.equal(firstImport, './bench.js');
  assert.doesNotMatch(read('js/bench.js'), /^import /m, 'bench.js has no imports of its own');
});

test('perf poses are complete', () => {
  const { poses } = JSON.parse(read('tools/perf/poses.json'));
  assert.ok(Object.keys(poses).length >= 5);
  for (const [name, pose] of Object.entries(poses)) {
    for (const key of ['pos', 'look']) {
      assert.ok(Array.isArray(pose[key]) && pose[key].length === 3 && pose[key].every(Number.isFinite), `${name}.${key}`);
    }
    assert.ok(['golden', 'midday', 'twilight', 'midnight'].includes(pose.time), `${name}.time`);
  }
});
