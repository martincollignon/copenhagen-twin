const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join, normalize } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// Modules that carry Manhattan data or build Manhattan-only content
const MANHATTAN_ONLY = [
  'js/nyc-geodata.js', 'js/city-config-nyc.js', 'js/city-grid.js', 'js/boroughs.js', 'js/buildings.js',
  'js/landmarks.js', 'js/fire-escapes.js', 'js/street-details.js', 'js/road-network.js', 'js/road-paint.js',
  'js/traffic.js', 'js/pedestrian-system.js', 'js/pedestrian-routes.js', 'js/nyc-map.js', 'js/trees.js',
  'js/world-nyc.js'
];

// Every module reachable from js/main.js in Copenhagen mode: static imports plus dynamic import()s, except the ones
// that are only taken when `?city=nyc` (the world-nyc.js import in main.js and the city-config-nyc.js one in the
// city-config.js dispatcher).
function reachableInCph() {
  const nycOnlyEdges = new Set(['js/world-nyc.js', 'js/city-config-nyc.js']);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = read(file);
    const specifiers = [
      ...[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"](\.[^'"]+)['"]/gm)].map((m) => m[1])
    ];
    for (const specifier of specifiers) {
      const target = normalize(join('js', specifier));
      if (nycOnlyEdges.has(target)) continue;
      visit(target);
    }
  };
  visit('js/main.js');
  return seen;
}

test('Copenhagen mode never reaches the Manhattan modules or geodata', () => {
  const reachable = reachableInCph();
  assert.ok(reachable.has('js/world-cph.js'));
  assert.ok(reachable.has('js/city-config-cph.js'));
  assert.ok(reachable.has('js/controllers.js') && reachable.has('js/cameras.js') && reachable.has('js/lighting.js'));
  for (const file of MANHATTAN_ONLY) assert.ok(!reachable.has(file), `${file} must not load in cph mode`);
});

test('the Manhattan world is imported only behind the nyc branch of main.js', () => {
  const main = read('js/main.js');
  assert.equal([...main.matchAll(/import\(['"]\.\/world-nyc\.js['"]\)/g)].length, 1);
  assert.match(main, /IS_NYC\s*\n?\s*\?[^]*?world-nyc\.js[^]*?:[^]*?world-cph\.js/);
  assert.ok(!/^import .*from '\.\/(city-grid|boroughs|landmarks|buildings|street-details|traffic|road-paint|nyc-map|nyc-geodata)\.js'/m.test(main));
  assert.match(read('js/city-config.js'), /IS_NYC \? await import\('\.\/city-config-nyc\.js'\)/);
});

test('?city selects cph by default and nyc on request', async () => {
  const { resolveCity, CITY } = await import('../js/city.js');
  assert.equal(CITY, 'cph', 'no location (node) falls back to cph');
  assert.equal(resolveCity(''), 'cph');
  assert.equal(resolveCity('?city=nyc'), 'nyc');
  assert.equal(resolveCity('?city=NYC&debug=footprints'), 'nyc');
  assert.equal(resolveCity('?city=cph'), 'cph');
  assert.equal(resolveCity('?city=atlantis'), 'cph');
});

test('the Copenhagen frame matches docs/cph-geodata-schema.md', async () => {
  const { CPH_FRAME, toLocal, toEtrs, ISLAND_BOUNDS, TELEPORT_LOCATIONS } = await import('../js/city-config-cph.js');
  assert.deepEqual([...CPH_FRAME.origin], [723900.0, 6176500.0, 6.84]);
  assert.equal(CPH_FRAME.epsg, 25832);
  assert.deepEqual([...CPH_FRAME.bbox], [-750, -750, 750, 750]);
  assert.match(CPH_FRAME.axes, /x=east, z=south/);
  const p = toLocal(723900 + 100, 6176500 + 40, 6.84 + 3);
  assert.deepEqual([p.x, p.y, p.z], [100, 3, -40], 'north is -z');
  const back = toEtrs(p.x, p.z, p.y);
  assert.ok(Math.abs(back.e - 724000) < 1e-9 && Math.abs(back.n - 6176540) < 1e-9 && Math.abs(back.h - 9.84) < 1e-9);
  assert.deepEqual([ISLAND_BOUNDS.minX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.maxZ], [-750, -750, 750, 750]);
  assert.deepEqual(Object.keys(TELEPORT_LOCATIONS), ['origin']);
});

test('the city-config dispatcher resolves to the Copenhagen config without loading Manhattan data', async () => {
  const config = await import('../js/city-config.js');
  assert.equal(config.ISLAND_BOUNDS.maxX, 750);
  assert.equal(config.blockAt(0, 0), null);
  assert.deepEqual(config.ROADS, []);
  assert.deepEqual(config.NYC_LANDMARKS, []);
  assert.equal(config.streetZ(37), 0);
  assert.match(config.getLocationLabel(10, -20), /^Copenhagen/);
  assert.equal(config.isTypingInField({ target: { tagName: 'INPUT' } }), true);
  assert.equal(config.isTypingInField({ target: { tagName: 'DIV' } }), false);
});

test('geodata is optional: absent data boots the empty plane, present data is exposed', async () => {
  const { CPH_FRAME } = await import('../js/city-config-cph.js');
  const warnings = [];
  const { loadCphGeodata } = loadModule(read('js/world-cph.js'), {
    imports: { 'three/webgpu': {}, './city-config-cph.js': { CPH_FRAME } },
    globals: { console: { warn: (...a) => warnings.push(a), info() {} }, globalThis: {}, document: {} }
  });
  const reply = (ok, body) => async () => ({ ok, json: async () => body });
  assert.equal(await loadCphGeodata('x', reply(false, null)), null, '404');
  assert.equal(await loadCphGeodata('x', async () => { throw new Error('offline'); }), null, 'network failure');
  assert.equal(await loadCphGeodata('x', reply(true, { nope: 1 })), null, 'wrong document');
  const geo = { version: 'cph-geodata/1', frame: { origin: [...CPH_FRAME.origin] }, buildings: [] };
  assert.deepEqual(await loadCphGeodata('x', reply(true, geo)), geo);
  assert.equal(warnings.filter((w) => /frame origin/.test(w[0])).length, 0);
  await loadCphGeodata('x', reply(true, { ...geo, frame: { origin: [1, 2, 3] } }));
  assert.equal(warnings.filter((w) => /frame origin/.test(w[0])).length, 1, 'a mismatched frame is flagged');
});

test('preloads cover only the engine core in index.html', () => {
  const html = read('index.html');
  for (const file of MANHATTAN_ONLY) assert.ok(!html.includes(`href="./${file}"`), `${file} is not preloaded`);
  assert.ok(existsSync(join(root, 'js/world-cph.js')));
});
