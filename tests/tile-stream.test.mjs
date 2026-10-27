import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTileStreamer } from '../js/tile-streamer.js';
import { streamConfig } from '../js/tile-rings.js';
import { tileOfLocal, tileBoundsLocal } from '../js/tile-grid.js';
import { createStreamTerrain, createTerrain, buildTerrainMeshArrays, cutTouchesRegion } from '../js/terrain-cph.js';
import { createTiledHeightField, createHeightGrid } from '../js/ground-height-cph.js';
import { createTiledLawnMask, createLawnMask } from '../js/grass-layout-cph.js';
import { createWalkSpace } from '../js/walk-space-cph.js';
import { setCityBounds, getCityBounds, getDataBbox, ISLAND_BOUNDS } from '../js/city-config.js';
import { ownList, isOwned } from '../js/tile-own.js';
import { openTileStore } from '../js/tile-store.js';
import { createCityGeo, createTileData, ownerOfFlat } from '../js/tile-data.js';
import { applyStreets, applyTerrainGround, mergeSurfaceCuts } from '../js/layout-cph.js';
import { applySurfaceCuts } from '../js/lakes-cph.js';
import { buildRoadSurfaceArrays, buildGroundBuckets } from '../js/road-surfaces-cph.js';
import { ROOT, TILES, TILES_URL, isDistrict } from './helpers/district-tiles.mjs';

const haveTiles = isDistrict;
const fileFetch = async (url) => {
  const p = path.join(ROOT, String(url).replace(/^\.\//, '').replace(/\/[^/]+\/\.\.\//, '/'));
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

// ------------------------------------------------------------------------------------------------ the streamer

const centre = tileOfLocal(0, 0);
const [ie, in_] = centre.split('_').map(Number);
const ids = [];
for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) ids.push(`${ie + a}_${in_ + b}`);
const LAYERS = ['buildings', 'terrain', 'lod2', 'surfaces', 'vegetation', 'furniture', 'entrances', 'groundfloor'];

/** A store whose requests are controlled by the test, a data store that only remembers layers, and recording layer modules. */
function harness({ near = 300, mid = 1000, maxConcurrent = 3, maxBuilds = 1, slowAdd = null } = {}) {
  const requests = []; // { id, name, resolve, reject, signal, aborted }
  const store = {
    index: { tiles: Object.fromEntries(ids.map((id) => [id, { layers: Object.fromEntries(LAYERS.map((l) => [l, 100])) }])) },
    ids,
    hasLayer: () => true,
    layerBytes: () => 100,
    fetchLayer(id, name, signal) {
      return new Promise((resolve, reject) => {
        const r = { id, name, resolve: () => resolve({ tile: id, name }), reject, signal, aborted: false };
        signal.addEventListener('abort', () => { r.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        requests.push(r);
      });
    }
  };
  const layersHeld = new Map();
  const data = {
    has: (id, name) => !!layersHeld.get(id)?.has(name),
    setLayer(id, name, payload) { if (!layersHeld.has(id)) layersHeld.set(id, new Map()); layersHeld.get(id).set(name, payload); },
    dropLayer(id, name) { layersHeld.get(id)?.delete(name); if (!layersHeld.get(id)?.size) layersHeld.delete(id); },
    layersOf: (id) => [...(layersHeld.get(id)?.keys() || [])],
    held: () => [...layersHeld.keys()],
    tileContext: (id, ring) => ({ id, ring, bounds: tileBoundsLocal(id) })
  };
  const log = [];
  const resident = { buildings: new Map(), furniture: new Map() };
  const mkLayer = (name, rings, fidelity = false) => ({
    name, rings, fidelity,
    async add(ctx, ring) { log.push(`+${name}:${ctx.id}:${ring}`); if (slowAdd) await slowAdd(name, ctx.id); resident[name]?.set(ctx.id, ring); },
    remove(id) { log.push(`-${name}:${id}`); resident[name]?.delete(id); }
  });
  const layers = [mkLayer('buildings', ['near', 'mid'], true), mkLayer('furniture', ['near'])];
  const streamer = createTileStreamer({ store, data, layers, cfg: streamConfig({ near, mid, maxConcurrent, maxBuilds }), interval: 0, yieldFrame: () => Promise.resolve(), onError: (e) => { throw e; } });
  const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  /** Answers every pending request (in arrival order) until none is left, letting builds run in between. */
  const drain = async () => {
    for (let guard = 0; guard < 400; guard++) {
      const open = requests.filter((r) => !r.aborted && !r.done);
      if (!open.length) { await flush(5); if (!requests.some((r) => !r.aborted && !r.done)) return; continue; }
      for (const r of open) { r.done = true; r.resolve(); }
      await flush(5);
    }
    throw new Error('drain did not settle');
  };
  return { streamer, requests, log, resident, data, drain, flush, layersHeld, layers };
}

test('streamer: loads the camera tile first, respects the concurrency cap, builds near then mid', async () => {
  const h = harness({ maxConcurrent: 3 });
  h.streamer.update(0, 0, 0);
  assert.equal(h.requests.length, 3); // the cap
  // the first requests belong to the tiles at the camera: the one it stands on and its neighbours
  assert.ok(h.requests.every((r) => r.id.split('_').every((v, i) => Math.abs(Number(v) - [ie, in_][i]) <= 1)), h.requests.map((r) => r.id).join());
  await h.drain();
  const snap = h.streamer.snapshot();
  assert.ok(snap.resident.near >= 1 && snap.resident.mid >= 1, JSON.stringify(snap.resident));
  assert.equal(h.resident.buildings.get(centre), 'near');
  assert.equal(h.resident.furniture.get(centre), 'near');
  // a mid tile has buildings but no furniture
  const midId = [...h.resident.buildings].find(([, r]) => r === 'mid')[0];
  assert.ok(!h.resident.furniture.has(midId));
  // near tiles were built before mid tiles
  const firstMid = h.log.findIndex((l) => l.endsWith(':mid'));
  const lastNear = h.log.map((l, i) => (l.startsWith('+buildings') && l.endsWith(':near') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastNear < firstMid + 40);
  assert.ok(h.streamer.stats.loads > 0 && h.streamer.stats.builds > 0);
});

test('streamer: maxBuilds tiles build at once, never more, and every tile is built once', async () => {
  let inFlight = 0;
  let peak = 0;
  const slowAdd = async (name) => {
    if (name !== 'buildings') return;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  };
  const one = harness({ maxBuilds: 1, slowAdd });
  one.streamer.update(0, 0, 0);
  await one.drain();
  assert.equal(peak, 1);
  const builtOne = one.streamer.stats.builds;
  peak = 0;
  const two = harness({ maxBuilds: 2, slowAdd });
  two.streamer.update(0, 0, 0);
  await two.drain();
  assert.equal(peak, 2, 'two tiles overlap');
  assert.equal(two.streamer.stats.builds, builtOne);
  assert.equal(two.streamer.stats.errors, 0);
  // no tile is built twice (a tile in flight is not started again)
  const adds = two.log.filter((l) => l.startsWith('+buildings')).map((l) => l.split(':')[1]);
  assert.equal(new Set(adds).size, adds.length);
});

test('streamer: moving away unloads, aborts requests nobody wants, releases data', async () => {
  const h = harness({ near: 300, mid: 700, maxConcurrent: 6 });
  h.streamer.update(0, 0, 0);
  await h.drain();
  const before = h.streamer.snapshot();
  assert.ok(before.resident.total > 2);
  // start loading around a far camera, then change our mind before the answers come
  h.streamer.update(1500, 1500, 1);
  await h.flush();
  const pending = h.requests.filter((r) => !r.done && !r.aborted);
  assert.ok(pending.length > 0);
  h.streamer.update(-1500, -1500, 2);
  await h.flush();
  for (const r of pending) assert.ok(r.aborted, `${r.id}/${r.name} should have been aborted`);
  assert.ok(h.streamer.stats.aborts >= pending.length);
  await h.drain();
  // the old surroundings are gone from the layers and from memory
  assert.ok(!h.resident.buildings.has(centre));
  assert.ok(!h.data.held().includes(centre));
  assert.ok(h.streamer.stats.unloads >= before.resident.total);
  assert.equal(h.streamer.stats.errors, 0);
});

test('streamer: hysteresis keeps a tile at the ring edge, a ring change rebuilds at the new fidelity', async () => {
  const h = harness({ near: 300, mid: 900, maxConcurrent: 8 });
  const edge = (id) => tileBoundsLocal(id);
  h.streamer.update(0, 0, 0);
  await h.drain();
  // find a mid tile and walk towards it until it is near
  const midId = [...h.resident.buildings].find(([, r]) => r === 'mid')[0];
  const b = edge(midId);
  const target = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  h.streamer.update(target[0], target[1], 1);
  await h.drain();
  assert.equal(h.resident.buildings.get(midId), 'near');
  assert.ok(h.streamer.stats.rebuilds >= 1);
  assert.ok(h.resident.furniture.has(midId));
  // step back by less than the hysteresis: it stays near (no unload / rebuild churn for that tile)
  const mark = h.log.length;
  h.streamer.update(target[0] + 330, target[1], 2);
  await h.drain();
  assert.equal(h.resident.buildings.get(midId), 'near');
  assert.ok(!h.log.slice(mark).some((l) => l.endsWith(`:${midId}`) || l.endsWith(`:${midId}:near`) || l.endsWith(`:${midId}:mid`)), h.log.slice(mark).join());
});

test('streamer: a tile that leaves while it is being built is undone when its build ends', async () => {
  const h = harness({ near: 300, mid: 700, maxConcurrent: 8 });
  let open;
  const gate = new Promise((r) => { open = r; });
  h.layers[0].add = async function slow(ctx, ring) { h.log.push(`+buildings:${ctx.id}:${ring}`); h.resident.buildings.set(ctx.id, ring); await gate; };
  h.streamer.update(0, 0, 0);
  for (let i = 0; i < 40 && !h.log.some((l) => l.startsWith('+buildings')); i++) {
    for (const r of h.requests.filter((q) => !q.done && !q.aborted)) { r.done = true; r.resolve(); }
    await h.flush(3);
  }
  const started = h.log.find((l) => l.startsWith('+buildings')).split(':')[1];
  assert.equal(h.streamer.snapshot().building, 1);
  h.streamer.update(3000, 3000, 1); // the camera leaves: the tile in the builder is no longer wanted
  open();
  await h.flush(30);
  assert.ok(!h.resident.buildings.has(started));
  assert.ok(h.log.includes(`-buildings:${started}`));
  assert.equal(h.streamer.isBuilt(started), false);
});

// ---------------------------------------------------------------------------------------- terrain, height, masks

const b64 = (values) => {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(Math.round(v * 100), i * 2));
  return buf.toString('base64');
};
const field = (x, z) => 0.01 * x + 0.02 * z + 1;
function chunkPayload(id) {
  const [x0, z0] = tileBoundsLocal(id);
  const w = 250;
  const vals = [];
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) vals.push(field(x0 + (i + 0.5) * 2, z0 + (j + 0.5) * 2));
  return { tile: id, chunk: { x0, z0, w, h: w, cell: 2, data: b64(vals) }, buildings: { [`b-${id}`]: 3 } };
}
const header = { version: 'cph-terrain/1', bbox: [-770, -770, 770, 770], cell: 2, width: 770, height: 770, lakes: [{ id: 'L', level: -0.8 }], ponds: [], bridges: [{ id: 'B', deck: 0.3 }] };

test('stream terrain: heights across tile edges equal the continuous field, missing tiles read the datum', () => {
  const t = createStreamTerrain(header);
  const a = tileOfLocal(-100, -100); // x -400..100
  const b = tileOfLocal(150, -100); // x 100..600
  t.addTile(chunkPayload(a));
  t.addTile(chunkPayload(b));
  assert.equal(t.chunkCount, 2);
  assert.equal(t.doc.buildings[`b-${a}`], 3);
  for (const [x, z] of [[99.2, -100.3], [100.4, -99.1], [50.5, -50.5], [300, -300], [100, -250.7]]) {
    assert.ok(Math.abs(t.heightAt(x, z) - field(x, z)) < 0.02, `${x},${z}: ${t.heightAt(x, z)} vs ${field(x, z)}`);
  }
  assert.equal(t.heightAt(-600, 400), 0); // no chunk there
  assert.equal(t.lakeLevel('L'), -0.8);
  assert.equal(t.deckHeight('B'), 0.3);
  assert.ok(t.removeTile(b, [`b-${b}`]));
  assert.equal(t.heightAt(300, -300), 0);
  assert.equal(t.doc.buildings[`b-${b}`], undefined);
  // a pinned chunk survives removeTile
  t.addTile(chunkPayload(b), { pin: true });
  assert.equal(t.removeTile(b), false);
  assert.ok(Math.abs(t.heightAt(300, -300) - field(300, -300)) < 0.02);
});

test('terrain mesh regions tile the grid: no cell twice, none missing, no crack between regions', () => {
  const terrain = createTerrain({ version: 'cph-terrain/1', width: 4, height: 4, cell: 100, bbox: [-200, -200, 200, 200], grid: new Float32Array(16).fill(2) });
  const cut = { cell: 10, half: 40, skip: [], pieces: [] };
  const whole = buildTerrainMeshArrays(terrain, { cut, frame: [] });
  const left = buildTerrainMeshArrays(terrain, { cut, frame: [], region: [-40, -40, 0, 40] });
  const right = buildTerrainMeshArrays(terrain, { cut, frame: [], region: [0, -40, 40, 40] });
  assert.equal(left.stats.cells + right.stats.cells, whole.stats.cells);
  assert.equal(left.index.length + right.index.length, whole.index.length);
  // a coarse region covers the same area with a quarter of the triangles
  const coarse = buildTerrainMeshArrays(terrain, { cut, frame: [], region: [-40, -40, 40, 40], step: 2 });
  assert.equal(coarse.index.length * 4, whole.index.length);
  assert.equal(cutTouchesRegion({ cell: 10, half: 40, skip: [1], pieces: [] }, [-40, -40, 0, 40]), true);
  assert.equal(cutTouchesRegion({ cell: 10, half: 40, skip: [1], pieces: [] }, [30, 30, 40, 40]), false);
});

test('tiled height field reads the grid of the tile a point lies in', () => {
  const terrain = createStreamTerrain(header);
  const a = tileOfLocal(-100, -100);
  terrain.addTile(chunkPayload(a));
  const f = createTiledHeightField(terrain, tileOfLocal);
  const g = createHeightGrid({ bbox: [-420, -520, 120, 20], cell: 0.5 });
  g.polygon([-50, -50, 50, -50, 50, 0, -50, 0], 0.2);
  f.addTile(a, g);
  assert.ok(Math.abs(f.offsetAt(0, -20) - 0.2) < 1e-3);
  assert.ok(Math.abs(f.heightAt(0, -20) - (field(0, -20) + 0.2)) < 0.03);
  assert.equal(f.offsetAt(300, 300), 0);
  assert.equal(f.tileCount, 1);
  f.removeTile(a);
  assert.equal(f.offsetAt(0, -20), 0);
});

test('tiled lawn mask answers per tile; a removed tile has no lawn', () => {
  const m = createTiledLawnMask(tileOfLocal);
  const a = tileOfLocal(0, -10);
  const b = tileBoundsLocal(a);
  const lawn = [{ ring: [0, -20, 20, -20, 20, -1, 0, -1] }];
  m.addTile(a, lawn, b);
  assert.equal(m.has(10, -10), true);
  assert.equal(m.has(40, -40), false);
  assert.equal(m.has(5000, 5000), false);
  assert.equal(createLawnMask(lawn, b).has(10, -10), true);
  m.removeTile(a);
  assert.equal(m.has(10, -10), false);
});

test('walk space: footprints of a tile come and go', () => {
  const walk = createWalkSpace({ buildings: [] }, null);
  const box = { ring: [0, 0, 10, 0, 10, 10, 0, 10] };
  assert.equal(walk.inBuilding(5, 5), false);
  walk.addBuildings('t1', [box]);
  assert.equal(walk.inBuilding(5, 5), true);
  assert.equal(walk.walkable(4, 6, 4, 6), false);
  walk.removeBuildings('t1');
  assert.equal(walk.inBuilding(5, 5), false);
  assert.equal(walk.walkable(4, 6, 4, 6), true);
});

test('city bounds: the clamp follows the tile index, the data frame is kept apart', () => {
  const before = [...getCityBounds()];
  const frame = [...getDataBbox()];
  try {
    setCityBounds([-1500, -2000, 1500, 1000], { frame: [-1400, -1900, 1400, 900] });
    assert.deepEqual([ISLAND_BOUNDS.minX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.maxZ], [-1500, -2000, 1500, 1000]);
    assert.deepEqual(getDataBbox(), [-1400, -1900, 1400, 900]);
    assert.throws(() => setCityBounds([0, 0, 0, 10]));
  } finally {
    setCityBounds(before, { frame });
  }
  assert.deepEqual(getCityBounds(), before);
});

test('ownership helpers: a build emits only what the tile owns', () => {
  const a = { id: 'a' }; const b = { id: 'b' };
  const doc = { roads: [a, b], own: { roads: new Set([a]) } };
  assert.deepEqual(ownList(doc, 'roads'), [a]);
  assert.deepEqual(ownList({ roads: [a, b] }, 'roads'), [a, b]);
  assert.equal(isOwned(doc, 'roads', b), false);
  assert.equal(isOwned(doc, 'sidewalks', b), true);
  assert.equal(ownerOfFlat([0, 0, 10, 10]), tileOfLocal(5, 5));
});

// --------------------------------------------------------------------------------------- the real district

test('district: streamed terrain equals the monolithic grid; per-tile road surfaces add up to the district build', { skip: !haveTiles && 'run tile_split.py first' }, async () => {
  const store = await openTileStore({ fetchImpl: fileFetch, baseUrl: TILES_URL });
  const city = { ...(await store.loadCity()) };
  city.streets ||= await store.loadStreets(); // tiled index: the whole layout, for the comparison with the monolithic build
  const tiles = store.ids;
  const roadPayloads = await Promise.all(tiles.map(async (id) => [id, await store.fetchLayer(id, 'roads')]));
  const { geo, roadsByTile } = createCityGeo(city.meta, city.roadGraph, roadPayloads, city.streets);
  // every road, pavement and cycle track is owned by exactly one tile
  for (const key of ['roads', 'sidewalks', 'cycleTracks']) {
    const seen = new Set();
    for (const t of roadsByTile.values()) for (const it of t[key]) { assert.ok(!seen.has(it)); seen.add(it); }
    assert.equal(seen.size, geo[key].length, key);
  }
  const terrain = createStreamTerrain(city.meta.terrain);
  const data = createTileData({ index: store.index, meta: city.meta, streets: city.streets, lakes: city.lakes, geo, roadsByTile, terrain });
  for (const id of tiles) for (const layer of ['buildings', 'terrain', 'surfaces', 'vegetation']) data.setLayer(id, layer, await store.fetchLayer(id, layer));

  const mono = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cph-terrain.json'), 'utf8'));
  const ref = createTerrain(mono);
  for (let i = 0; i < 400; i++) {
    const x = ((i * 7919) % 1700) - 850;
    const z = ((i * 104729) % 1700) - 850;
    assert.equal(terrain.heightAt(x, z), ref.heightAt(x, z), `${x},${z}`);
  }

  const area = await store.loadArea([-750, -750, 750, 750]);
  const district = area.geo;
  applyStreets(district, area.streets);
  applyTerrainGround(district, createTerrain(area.terrain));
  const surfaces = applySurfaceCuts({ ...area.surfaces, surfaces: [...area.surfaces.surfaces, ...area.vegetation.surfaces] }, mergeSurfaceCuts(city.lakes?.surface_cuts, district.surfaceCuts));
  const whole = buildRoadSurfaceArrays(district, { surfaces, pavement: true, terrain: createTerrain(area.terrain) });
  const wholeBuckets = buildGroundBuckets(district, surfaces, createTerrain(area.terrain));
  const sum = {};
  const bsum = {};
  for (const id of tiles) {
    const ctx = data.tileContext(id, 'near');
    for (const [k, l] of Object.entries(buildRoadSurfaceArrays(ctx.geo, { surfaces: ctx.surfaces, pavement: true, terrain }))) sum[k] = (sum[k] || 0) + l.vertexCount;
    for (const [k, b] of buildGroundBuckets(ctx.geo, ctx.surfaces, terrain)) bsum[k] = (bsum[k] || 0) + b.vertexCount;
  }
  for (const [k, l] of Object.entries(whole)) assert.equal(sum[k] || 0, l.vertexCount, `layer ${k}`);
  for (const [k, b] of wholeBuckets) assert.equal(bsum[k] || 0, b.vertexCount, `bucket ${k}`);
  // the buildings of all tiles are the district's buildings (after the footprint fixes)
  assert.equal(tiles.reduce((n, id) => n + data.buildings(id).length, 0), district.buildings.length);
});
