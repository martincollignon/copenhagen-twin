const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let TELEPORT_LOCATIONS, ISLAND_BOUNDS, swanNavigationModule, lakeDoc;
test.before(async () => {
  ({ TELEPORT_LOCATIONS, ISLAND_BOUNDS } = await import('../js/city-config.js'));
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
  assert.deepEqual(Object.keys(TELEPORT_LOCATIONS).sort(), buttons.sort());
  assert.ok(buttons.length >= 5);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(Number.isFinite(point.heading), `${name} has a heading`);
    assert.ok(point.x > ISLAND_BOUNDS.minX && point.x < ISLAND_BOUNDS.maxX, `${name} inside the district in x`);
    assert.ok(point.z > ISLAND_BOUNDS.minZ && point.z < ISLAND_BOUNDS.maxZ, `${name} inside the district in z`);
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
    controllerManager: {
      teleportActiveTo: (...args) => { calls.push(['teleport', ...args]); return { x: 0, z: 0 }; }
    },
    touchControls: { reset: () => calls.push(['touch']) },
    gamepadControls: { reset: () => calls.push(['gamepad']) },
    cameraSystem: { resetForTeleport: () => calls.push(['camera']) },
    selectCamera: (...args) => calls.push(['selectCamera', ...args]),
    teleportButtons: Object.keys(TELEPORT_LOCATIONS).map((key) => ({
      getAttribute: () => key,
      addEventListener: (_event, handler) => handlers.set(key, handler)
    })),
    closePopovers: () => {}
  };
  vm.runInNewContext(main.slice(start, end), environment);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    calls.length = 0;
    handlers.get(name)();
    assert.deepEqual(calls, [
      ['teleport', point.x, point.z, point.heading], ['touch'], ['gamepad'], ['camera'], ['selectCamera', 'chase', true]
    ]);
  }
});
