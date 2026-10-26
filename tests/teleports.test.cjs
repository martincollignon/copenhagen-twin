const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let TELEPORT_LOCATIONS, ISLAND_BOUNDS, CITY_TELEPORT_LOCATIONS, swanNavigationModule, lakeDoc;
test.before(async () => {
  ({ TELEPORT_LOCATIONS, ISLAND_BOUNDS } = await import('../js/city-config.js'));
  ({ CITY_TELEPORT_LOCATIONS } = await import('../js/city-teleports.js'));
  swanNavigationModule = await import('../js/swan-navigation.js');
  lakeDoc = JSON.parse(read('data/cph-lakes.json'));
});

// Distance from (x, z) to the nearest roadGraph link carrying `name`
function distanceToStreet(geo, name, x, z) {
  const rg = geo.roadGraph;
  const N = rg.nodes;
  let best = Infinity;
  for (const l of rg.links) {
    if (rg.names[l[6]] !== name) continue;
    const ax = N[2 * l[0]], az = N[2 * l[0] + 1], bx = N[2 * l[1]], bz = N[2 * l[1] + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

test('every teleport button has a Copenhagen destination inside the district', () => {
  const buttons = [...read('index.html').matchAll(/data-teleport="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...Object.keys(TELEPORT_LOCATIONS), ...Object.keys(CITY_TELEPORT_LOCATIONS)].sort(), buttons.sort());
  assert.ok(buttons.length >= 5);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(Number.isFinite(point.heading), `${name} has a heading`);
    assert.ok(point.x > ISLAND_BOUNDS.minX && point.x < ISLAND_BOUNDS.maxX, `${name} inside the district in x`);
    assert.ok(point.z > ISLAND_BOUNDS.minZ && point.z < ISLAND_BOUNDS.maxZ, `${name} inside the district in z`);
  }
});

test('the citywide presets are finite, hidden until a tile covers them, and lie on vehicular links of the citywide road graph', () => {
  const names = ['rhus', 'nyhavn', 'slot', 'brygge', 'vesterbro', 'frbrhus', 'frballe', 'trianglen'];
  assert.deepEqual(Object.keys(CITY_TELEPORT_LOCATIONS), names);
  for (const [key, p] of Object.entries(CITY_TELEPORT_LOCATIONS)) {
    assert.ok([p.x, p.z, p.heading].every(Number.isFinite) && p.name && p.sub, key);
    assert.ok(!(key in TELEPORT_LOCATIONS), `${key} does not shadow a district preset`);
  }
  // the buttons start hidden (main.js shows them where world.tileExists says so)
  const html = read('index.html');
  for (const key of names) assert.match(html, new RegExp(`data-teleport="${key}" type="button" hidden`), `${key} is hidden by default`);
  // on the citywide graph (gitignored: only where the data is built): within 3 m of a vehicular link
  let graph = null;
  try { graph = JSON.parse(read('data/city/roadgraph.json')); } catch { return; }
  if (graph.links.length < 50000) return; // the district's graph does not reach them
  const N = graph.nodes;
  const vehicular = new Set(['primary', 'secondary', 'residential']);
  for (const [key, p] of Object.entries(CITY_TELEPORT_LOCATIONS)) {
    let best = Infinity;
    for (const l of graph.links) {
      if (!vehicular.has(graph.classes[l[7]])) continue;
      const ax = N[2 * l[0]], az = N[2 * l[0] + 1], bx = N[2 * l[1]], bz = N[2 * l[1] + 1];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(ax + dx * t - p.x, az + dz * t - p.z));
    }
    assert.ok(best < 3, `${key} is ${best.toFixed(1)} m from a vehicular link`);
  }
});

test('street teleports land on the street they name', () => {
  const geo = JSON.parse(read('data/cph-geodata.json'));
  const streets = {
    dlb: 'Dronning Louises Bro', peblinge: 'Peblinge Dossering', nbro: 'Nørrebrogade', blaag: 'Blågårds Plads'
  };
  for (const [key, street] of Object.entries(streets)) {
    const p = TELEPORT_LOCATIONS[key];
    assert.ok(distanceToStreet(geo, street, p.x, p.z) < 12, `${key} is within 12 m of ${street}`);
  }
});

test('the swan spawn and six moored boats fit on Peblinge with Sortedams excluded', () => {
  const navigation = swanNavigationModule.createSwanNavigation(lakeDoc);
  const { SWAN_MOORINGS, SWAN_START, SWAN_STATIC_MOORINGS } = swanNavigationModule;
  assert.equal(SWAN_MOORINGS.length, 7);
  assert.equal(SWAN_STATIC_MOORINGS.length, 6);
  assert.ok(navigation.isPositionLegal(SWAN_START.x, SWAN_START.z), 'the player starts on open water at Kaffesalonen');
  for (const [index, point] of SWAN_MOORINGS.entries()) {
    assert.ok(navigation.isPositionLegal(point.x, point.z), `mooring ${index + 1} leaves the pier and wall clearances`);
  }
  assert.equal(navigation.isPositionLegal(100, -520), false, 'the Dronning Louises Bro boundary excludes Sortedams Sø');
});

test('no New York destinations or labels remain in the teleport and camera menus', () => {
  const html = read('index.html');
  const menus = html.slice(html.indexOf('id="teleport-popover"'), html.indexOf('id="camera-popover"') + 3000);
  assert.ok(!/Empire|Times Square|Chrysler|Bryant|Central Park|Manhattan|Taxi/i.test(menus));
  assert.ok(!/NYC|mph/.test(html));
  assert.match(html, /<title>Copenhagen Twin<\/title>/);
  assert.match(html, /km\/h/);
});

test('every scenic camera button maps to a preset and the teleport presets have a camera', () => {
  const ids = [...read('index.html').matchAll(/data-camera="([^"]+)"/g)].map((match) => match[1]);
  const src = read('js/cameras.js');
  for (const id of ids) assert.match(src, new RegExp(`id: '${id}'`), `${id} is a camera preset`);
  for (const key of Object.keys(TELEPORT_LOCATIONS)) assert.ok(ids.includes(key), `${key} has a scenic camera`);
});

test('preset teleports share arrival resets', () => {
  const main = read('js/main.js');
  const start = main.indexOf('  function teleportTo(');
  const end = main.indexOf('  if (hudToggleBtn) {', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  const calls = [];
  const environment = {
    TELEPORT_LOCATIONS,
    CITY_TELEPORT_LOCATIONS,
    world: { tileExists: () => true }, // the tile index covers every city preset
    document: { getElementById: () => ({ hidden: true }) },
    controllerManager: {
      teleportActiveTo: (...args) => { calls.push(['teleport', ...args]); return { x: 0, z: 0 }; }
    },
    touchControls: { reset: () => calls.push(['touch']) },
    gamepadControls: { reset: () => calls.push(['gamepad']) },
    cameraSystem: { resetForTeleport: () => calls.push(['camera']) },
    selectCamera: (...args) => calls.push(['selectCamera', ...args]),
    teleportButtons: [...Object.keys(TELEPORT_LOCATIONS), ...Object.keys(CITY_TELEPORT_LOCATIONS)].map((key) => ({
      getAttribute: () => key,
      hidden: true,
      addEventListener: (_event, handler) => handlers.set(key, handler)
    })),
    closePopovers: () => {}
  };
  vm.runInNewContext(main.slice(start, end), environment);
  for (const [name, point] of Object.entries({ ...TELEPORT_LOCATIONS, ...CITY_TELEPORT_LOCATIONS })) {
    calls.length = 0;
    handlers.get(name)();
    assert.deepEqual(calls, [
      ['teleport', point.x, point.z, point.heading], ['touch'], ['gamepad'], ['camera'], ['selectCamera', 'chase', true]
    ]);
  }
});

test('the citywide preset buttons are only offered where the tile index has a tile', () => {
  const main = read('js/main.js');
  const start = main.indexOf('  function teleportTo(');
  const end = main.indexOf('  if (hudToggleBtn) {', start);
  for (const covered of [false, true]) {
    const buttons = [...Object.keys(TELEPORT_LOCATIONS), ...Object.keys(CITY_TELEPORT_LOCATIONS)].map((key) => ({ key, getAttribute: () => key, hidden: null, addEventListener() {} }));
    const title = { hidden: null };
    vm.runInNewContext(main.slice(start, end), {
      TELEPORT_LOCATIONS, CITY_TELEPORT_LOCATIONS, world: { tileExists: () => covered }, document: { getElementById: () => title },
      controllerManager: {}, touchControls: {}, gamepadControls: {}, cameraSystem: {}, selectCamera() {}, teleportButtons: buttons, closePopovers() {}
    });
    for (const b of buttons) assert.equal(b.hidden, b.key in CITY_TELEPORT_LOCATIONS ? !covered : false, `${b.key} with tiles ${covered}`);
    assert.equal(title.hidden, !covered);
  }
});
