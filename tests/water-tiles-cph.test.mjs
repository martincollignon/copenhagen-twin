import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTileWaterArrays, fillRingsWindow, shoreWindow, groundWindow, windowOrigin, ringsInWindow, POND_LIFT } from '../js/water-tiles-cph.js';
import { fillRings, groundField } from '../js/ground-field-cph.js';
import { buildTileGroundArrays } from '../js/terrain-cph.js';
import { farWaterArrays } from '../js/far-lod-geometry.js';
import { openTileStore } from '../js/tile-store.js';
import { createTileData } from '../js/tile-data.js';
import { RING_LAYERS } from '../js/tile-rings.js';
import { WATER } from '../js/lakes-cph.js';

// a 100 x 100 m lake, counter-clockwise from above (negative shoelace in x / z), with a 20 x 20 m island
const LAKE = [0, 0, 0, 100, 100, 100, 100, 0];
const ISLAND = [40, 40, 60, 40, 60, 60, 40, 60];
const area = (pos, idx) => {
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
    a += Math.abs((pos[3 * q] - pos[3 * p]) * (pos[3 * r + 2] - pos[3 * p + 2]) - (pos[3 * r] - pos[3 * p]) * (pos[3 * q + 2] - pos[3 * p + 2])) / 2;
  }
  return a;
};

test('a tile water layer becomes a flat surface at its level, a pond sits 2 cm above its level', () => {
  const a = buildTileWaterArrays({
    bodies: [
      { id: 'w:1', level: -2.5, polys: [{ ring: LAKE, holes: [ISLAND] }] },
      { id: 'w:2', level: 3, pond: 1, polys: [{ ring: [200, 0, 200, 10, 210, 10, 210, 0] }] }
    ]
  });
  const P = a.surface.position;
  assert.ok(Math.abs(area(P, a.surface.index) - (10000 - 400 + 100)) < 1e-6, 'lake minus island plus the pond');
  const ys = new Set();
  for (let i = 1; i < P.length; i += 3) ys.add(P[i]);
  assert.deepEqual([...ys].sort((x, y) => x - y), [-2.5, 3 + POND_LIFT]);
  assert.equal(a.walls.index.length, 0, 'no walls without shore runs');
});

test('quay runs get a wall facing the water and a coping, bank runs a battered grass slope', () => {
  const quay = { s: 'q', pts: [0, 0, 50, 0, 100, 0], top: [1.2, 1.3, 1.4] }; // water on the left of travel: +z
  const bank = { s: 'b', pts: [100, 0, 100, 50], top: [0.5, 0.5] };
  const a = buildTileWaterArrays({ bodies: [{ id: 'w:1', level: -1, polys: [{ ring: LAKE }], walls: [quay, bank] }] });
  const { position, normal, kind, index } = a.walls;
  assert.ok(index.length > 0 && index.length % 3 === 0);
  const kinds = new Set(kind);
  assert.ok(kinds.has(0) && kinds.has(1) && kinds.has(3), 'wall, coping and bank');
  // quay wall: vertical faces at z = 0 facing +z; foot WATER.bedY below the water line, head at the given top
  let wall = 0;
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== 0) continue;
    wall++;
    assert.ok(Math.abs(normal[3 * i + 2] - 1) < 1e-9 && Math.abs(position[3 * i + 2]) < 1e-9);
    assert.ok(position[3 * i + 1] === -1 + (WATER.bedY - WATER.surfaceY) || [1.2, 1.3, 1.4].some((t) => Math.abs(position[3 * i + 1] - t) < 1e-9));
  }
  assert.equal(wall, 8, 'two segments, four vertices each');
  // the bank leans back into the water: its foot is inward of the outline (x < 100)
  let foot = false;
  for (let i = 0; i < kind.length; i++) if (kind[i] === 3 && position[3 * i + 1] < 0 && position[3 * i] < 99) foot = true;
  assert.ok(foot);
});

test('the window fill is the district fill on a window', () => {
  const rings = [LAKE, ISLAND, [150, 150, 150, 190, 190, 190, 190, 150]];
  const x0 = -20; const z0 = -10; const cell = 2; const n = 120;
  const a = fillRingsWindow(rings, { x0, z0, cell, n });
  const b = fillRings(rings, { bbox: [x0, z0, x0 + n * cell, z0 + n * cell], cell, w: n, h: n });
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.equal(diff, 0);
  assert.equal(a[(5 + 2) * n + 10 + 5], 1, 'inside the lake (x = 5, z = 5 would be cell 12, 7)');
});

test('shore distance grows from the wall, is zero on land and caps at WATER.shoreMax', () => {
  const f = shoreWindow([LAKE], { x0: -100, z0: -100, cell: 2, n: 128 });
  const at = (x, z) => f.data[Math.floor((z - f.z0) / f.cell) * f.width + Math.floor((x - f.x0) / f.cell)];
  const metres = (x, z) => (at(x, z) / 255) * f.max;
  assert.equal(at(-30, 50), 0, 'land');
  assert.ok(Math.abs(metres(5, 50) - 5) < 2.2, `5 m from the wall: ${metres(5, 50)}`);
  assert.ok(metres(50, 50) >= WATER.shoreMax - 0.1, 'far from any wall');
});

test('the ground window: lake path distance, park mask, no grass on water', () => {
  const W = { x0: -100, z0: -100, cell: 2, n: 128 };
  const g = groundWindow({ lakeRings: [LAKE], greenRings: [[110, 0, 110, 100, 190, 100, 190, 0]], waterRings: [[200, 200, 200, 240, 240, 240, 240, 200]] }, W);
  const at = (x, z) => (Math.floor((z - W.z0) / W.cell) * W.n + Math.floor((x - W.x0) / W.cell)) * 4;
  assert.equal(g.data[at(50, 50)], 0, 'water');
  const metres = (x, z) => (g.data[at(x, z)] / 255) * g.max;
  assert.ok(Math.abs(metres(113, 50) - 13) < 2.5);
  assert.equal(g.data[at(150, 50) + 1], 255, 'park');
  assert.equal(g.data[at(-50, 50) + 1], 0, 'not park');
  const noLake = groundWindow({ greenRings: [] }, W);
  assert.equal(noLake.data[0], 255, 'no lakes: far from any');
});

test('windows snap their origin so the texels do not swim, rings are picked by window', () => {
  assert.deepEqual(windowOrigin(1000, -500, 1536, 64), [256, -1280]);
  const pieces = [[{ l: 0, p: [{ ring: [0, 0, 0, 10, 10, 10, 10, 0] }] }], [{ l: 0, p: [{ ring: [5000, 0, 5000, 10, 5010, 10, 5010, 0], holes: [[5002, 2, 5002, 4, 5004, 4]] }] }]];
  assert.equal(ringsInWindow(pieces, -50, -50, 200).length, 1);
  assert.equal(ringsInWindow(pieces, 4900, -50, 200).length, 2, 'the ring and its hole');
});

test('far water polygons keep their holes', () => {
  const w = farWaterArrays([{ ring: [0, 0, 100, 0, 100, 100, 0, 100], holes: [[40, 40, 60, 40, 60, 60, 40, 60]], level: 1 }], { lift: 0 });
  const a = (() => { let s = 0; const P = w.position; const I = w.index; for (let i = 0; i < I.length; i += 3) { const [p, q, r] = [I[i], I[i + 1], I[i + 2]]; s += Math.abs((P[3 * q] - P[3 * p]) * (P[3 * r + 2] - P[3 * p + 2]) - (P[3 * r] - P[3 * p]) * (P[3 * q + 2] - P[3 * p + 2])) / 2; } return s; })();
  assert.ok(Math.abs(a - (10000 - 400)) < 1e-6);
});

test('the ground mesh leaves out the cells a tile cut takes out and adds their remainders', () => {
  const terrain = { heightAt: () => 0, doc: {}, flat: false };
  const region = [-750, -750, -710, -710]; // lattice cells i, j = 0 .. 9 (4 m cells anchored at -750)
  const full = buildTileGroundArrays(terrain, { region, tileCut: null, uvSize: 8000 });
  assert.equal(full.stats.cells, 100);
  const piece = [0, 0, 0, 2, 2, 2, 2, 0].map((v, k) => v + (k % 2 ? -750 + 5 * 4 : -750 + 5 * 4)); // 2 x 2 m corner of cell (5, 5)
  const cut = buildTileGroundArrays(terrain, { region, tileCut: { cell: 4, half: 750, keyed: true, skip: [[0, 0, 3], [9, 9, 1]], pieces: [[5, 5, piece]] }, uvSize: 8000 });
  assert.equal(cut.stats.cells, 100 - 4 - 1, 'three cells of row 0, one of row 9, and the piece cell');
  const tri = cut.index.length / 3;
  assert.equal(tri, 2 * (100 - 5) + 2, 'two triangles a cell plus the piece (a square)');
  // a tile outside the old 750 m area is cut the same way
  const i0 = Math.ceil((2000 + 750) / 4 - 0.5); // the first lattice cell whose centre lies in x >= 2000
  const far = buildTileGroundArrays(terrain, { region: [2000, 2000, 2040, 2040], tileCut: { cell: 4, half: 750, keyed: true, skip: [[i0, i0, 2]], pieces: [] }, uvSize: 8000 });
  assert.equal(far.stats.cells, 98);
});

test('the store reads the water layer and the city header from the post manifest', async () => {
  const idx = { version: 'cph-tiles/1', tiles: { '1446_12352': { local: [0, 0, 500, 500], layers: { 'terrain.json': 10 } }, '1447_12352': { local: [500, 0, 1000, 500], layers: { 'terrain.json': 10 } } }, city: { meta: '../city/meta.json', roadgraph: '../city/roadgraph.json' } };
  const files = {
    '/t/index.json': idx,
    '/t/../city/post.json': { version: 'cph-post/1', water: { header: 'water.json', tiles: { '1446_12352': 321 } } },
    '/t/../city/meta.json': { geodata: {} }, '/t/../city/roadgraph.json': { nodes: [] },
    '/t/../city/water.json': { version: 'cph-water/1', sea: -6.84, far: {} },
    '/t/1446_12352/water.json': { tile: '1446_12352', bodies: [{ id: 'w:1' }] }
  };
  const fetchImpl = async (url) => {
    const f = files[url.replace('/t/city', '/t/../city')] || files[url];
    return f ? { ok: true, status: 200, json: async () => f } : { ok: false, status: 404 };
  };
  const store = await openTileStore({ baseUrl: '/t', fetchImpl });
  assert.ok(store.hasLayer('1446_12352', 'water'));
  assert.ok(!store.hasLayer('1447_12352', 'water'), 'a tile without water has none');
  assert.equal(store.layerBytes('1446_12352', 'water'), 321);
  assert.deepEqual(await store.fetchLayer('1446_12352', 'water'), files['/t/1446_12352/water.json']);
  const city = await store.loadCity();
  assert.equal(city.water.sea, -6.84);
  assert.ok(RING_LAYERS.near.includes('water') && RING_LAYERS.mid.includes('water'));
});

test('the tile context carries the water layer and its surface cuts trim the register', () => {
  const terrain = { addTile() {}, removeTile() {}, heightAt: () => 0, flat: true };
  const T = '1446_12352';
  const index = { tiles: { [T]: { layers: {} } } };
  const data = createTileData({ index, meta: { surfaces: {} }, geo: { buildings: [], roads: [], roadGraph: { nodes: [], links: [] } }, terrain });
  data.setLayer(T, 'surfaces', { surfaces: [{ id: 's1', ring: [0, 0, 0, 10, 10, 10, 10, 0] }], markings: [] });
  data.setLayer(T, 'water', { tile: T, bodies: [], surfaceCuts: [{ id: 's1', replace: [{ id: 's1', ring: [0, 0, 0, 10, 5, 10, 5, 0] }] }] });
  const ctx = data.tileContext(T, 'near');
  assert.equal(ctx.water.tile, T);
  const s = data.surfaces(T).surfaces;
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].ring, [0, 0, 0, 10, 5, 10, 5, 0]);
});
