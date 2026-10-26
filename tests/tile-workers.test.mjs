import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTilePool } from '../js/tile-pool.js';
import { buildingSteps, computeBuildings, transferablesOf } from '../js/building-compute.js';
import { makeRoadJob, computeRoadSurfaces } from '../js/road-compute.js';
import { makeFurnitureJob, computeFurniturePlacement } from '../js/furniture-compute.js';
import { buildRoadSurfaceArrays, buildGroundBuckets, buildGroundHeightGrid, computeSurfaceMeshes } from '../js/road-surfaces-cph.js';
import { createAccumulator, addBuilding, groundLow } from '../js/building-geometry.js';
import { createContext as createGroundContext } from '../js/groundfloor.js';
import { createEntranceIndex } from '../js/entrances.js';
import { openTileStore } from '../js/tile-store.js';
import { createBaseGeo, createTileData, createCityGeo } from '../js/tile-data.js';
import { createStreamTerrain, createChunkSampler, faceNormals, vertexNormals } from '../js/terrain-cph.js';
import { createZoneMap } from '../js/zones-cph.js';
import { placeFurniture } from '../js/placement-cph.js';
import { createHeroCache } from '../js/hero-cache.js';
import { createPhotoBudget, selectPhotoSet, PHOTO } from '../js/facade-lod.js';
import { ROOT, TILES_URL, isDistrict } from './helpers/district-tiles.mjs';

// ------------------------------------------------------------------------------------------------ the pool

const tick = () => new Promise((r) => setTimeout(r, 0));

test('tile pool: jobs run on the worker, in order, one per worker; stats per kind', async () => {
  const sent = [];
  class FakeWorker {
    constructor() { this.onmessage = null; FakeWorker.all.push(this); }
    postMessage(msg) { sent.push(msg); setTimeout(() => this.onmessage({ data: { id: msg.id, result: { echo: msg.job, kind: msg.kind } } }), 1); }
    terminate() { this.dead = true; }
  }
  FakeWorker.all = [];
  const pool = createTilePool({ size: 1, WorkerCtor: FakeWorker, url: 'x' });
  const [a, b] = await Promise.all([pool.run('roads', { n: 1 }), pool.run('buildings', { n: 2 })]);
  assert.deepEqual(a, { echo: { n: 1 }, kind: 'roads' });
  assert.deepEqual(b, { echo: { n: 2 }, kind: 'buildings' });
  assert.equal(FakeWorker.all.length, 1);
  assert.deepEqual(sent.map((m) => m.kind), ['roads', 'buildings']);
  assert.equal(pool.stats.kinds.roads.n, 1);
  assert.equal(pool.stats.byKind.buildings, 1);
  pool.dispose();
  assert.ok(FakeWorker.all[0].dead);
});

test('tile pool: no Worker, a worker that fails or throws: run resolves null and the caller computes inline', async () => {
  const none = createTilePool({ WorkerCtor: undefined });
  assert.equal(none.available, false);
  assert.equal(await none.run('roads', {}), null);
  class Failing {
    postMessage() { setTimeout(() => this.onerror({ message: 'boom' }), 1); }
    terminate() {}
  }
  const log = console.warn; console.warn = () => {};
  const f = createTilePool({ size: 1, WorkerCtor: Failing, url: 'x' });
  assert.equal(await f.run('roads', {}), null);
  assert.equal(f.available, false);
  assert.equal(await f.run('roads', {}), null, 'after a failure everything runs inline');
  class Throwing {
    postMessage(m) { setTimeout(() => this.onmessage({ data: { id: m.id, error: 'bad job' } }), 1); }
    terminate() {}
  }
  const t = createTilePool({ size: 1, WorkerCtor: Throwing, url: 'x' });
  assert.equal(await t.run('buildings', {}), null);
  console.warn = log;
  assert.equal(t.stats.failed, 1);
});

// ---------------------------------------------------------------------------------------------- the caches

test('hero cache: one load for any number of clones, a failure is remembered for the retry interval', async () => {
  let loads = 0;
  let clock = 0;
  const cache = createHeroCache(async () => { loads++; return { userData: {}, clone() { return { cloned: true, from: this }; } }; }, { now: () => clock });
  const hero = { building_id: 'gdk:1' };
  const [a, b] = await Promise.all([cache.get(hero), cache.get(hero)]);
  const c = await cache.get(hero);
  assert.equal(loads, 1);
  assert.ok(a.cloned && b.cloned && c.cloned && a !== b);
  assert.equal(a.from, b.from, 'the clones come from one template');
  assert.equal(a.from.userData.cached, true);
  assert.equal(cache.stats.hits, 2);

  let attempts = 0;
  const failing = createHeroCache(async () => { attempts++; throw new Error('404'); }, { retryMs: 1000, now: () => clock });
  await assert.rejects(() => failing.get(hero), /404/);
  await tick();
  await assert.rejects(() => failing.get(hero), /404/);
  assert.equal(attempts, 1, 'not asked again within the interval');
  clock = 2000;
  await assert.rejects(() => failing.get(hero), /404/);
  assert.equal(attempts, 2, 'asked again after it');
});

test('photo budget: the budget is shared by the tiles, nearest first', () => {
  const mk = (ids) => {
    const state = { enabled: true, resident: new Map(), loading: new Set() };
    const calls = [];
    return { state, loader: true, candidates: ids.map((id) => ({ id, cx: +id.split(':')[1], cz: 0 })), has: (id) => ids.includes(id), applyPlan: (want, inRange) => calls.push({ want, inRange }), calls };
  };
  const A = mk(Array.from({ length: 40 }, (_, i) => `a:${i}`)); // 0..39 m
  const B = mk(Array.from({ length: 40 }, (_, i) => `b:${i + 40}`)); // 40..79 m
  const budget = createPhotoBudget({ interval: 0 });
  budget.add(A); budget.add(B);
  assert.equal(budget.update(0, 0, 1), true);
  const wantA = A.calls[0].want.length;
  const wantB = B.calls[0].want.length;
  assert.equal(wantA + wantB, PHOTO.budget, 'one budget for both tiles, not one each');
  assert.equal(wantA, 40);
  assert.equal(wantB, PHOTO.budget - 40);
  // the nearest of B first
  assert.deepEqual(B.calls[0].want.slice(0, 2), ['b:40', 'b:41']);
  budget.remove(B);
  budget.update(0, 0, 2);
  assert.equal(B.calls.length, 1, 'a removed manager is no longer planned');
  // totals the managers check their room against
  A.state.resident.set('x', 1); A.state.loading.add('y');
  assert.equal(budget.held(), 2);
  assert.equal(budget.loading(), 1);
});

// ------------------------------------------------------------------------------------------ the compute halves

const fileFetch = async (url) => {
  const p = path.join(ROOT, String(url).replace(/^\.\//, '').replace(/\/[^/]+\/\.\.\//, '/'));
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

async function district() {
  const store = await openTileStore({ fetchImpl: fileFetch, baseUrl: TILES_URL });
  const city = await store.loadCity();
  const { geo } = createBaseGeo(city.meta, city.roadGraph, city.streetsGraph);
  const terrain = createStreamTerrain(city.meta.terrain);
  const data = createTileData({ index: store.index, meta: city.meta, streets: city.streets, lakes: city.lakes, geo, terrain });
  const names = ['buildings', 'terrain', 'surfaces', 'vegetation', 'furniture', 'entrances', 'groundfloor', 'roads', 'streets'];
  for (const id of store.ids) for (const n of names) data.setLayer(id, n, await store.fetchLayer(id, n));
  return { store, city, data, terrain, geo };
}

test('roadsOf from the tile layers equals the district assembled and laid out at once', { skip: !isDistrict && 'run tile_split.py + tile_streets.py first' }, async () => {
  const { store, city, data, geo } = await district();
  const legacy = city.streets || await store.loadStreets();
  const roadPayloads = await Promise.all(store.ids.map(async (id) => [id, await store.fetchLayer(id, 'roads')]));
  // the same payload objects are laid out once by either path: load fresh copies for the reference
  const fresh = JSON.parse(JSON.stringify(roadPayloads));
  const whole = createCityGeo(city.meta, city.roadGraph, fresh, legacy);
  // an item belongs to one tile either way (the reference buckets by the centre of the laid-out road, the tiles by the tile that holds the
  // road in its layer: a road at a tile edge may change hands), so compare the union over the tiles
  const mineAll = { roads: new Map(), sidewalks: [], cycleTracks: [] };
  const refAll = { roads: new Map(), sidewalks: [], cycleTracks: [] };
  for (const id of store.ids) {
    const mine = data.roadsOf(id);
    const ref = whole.roadsByTile.get(id) || { roads: [], sidewalks: [], cycleTracks: [] };
    for (const r of mine.roads) { assert.ok(!mineAll.roads.has(r.id), `${r.id} once`); mineAll.roads.set(r.id, r); }
    for (const r of ref.roads) refAll.roads.set(r.id, r);
    mineAll.sidewalks.push(...mine.sidewalks.map((x) => x.id));
    refAll.sidewalks.push(...ref.sidewalks.map((x) => x.id));
    mineAll.cycleTracks.push(...mine.cycleTracks.map((x) => x.id));
    refAll.cycleTracks.push(...ref.cycleTracks.map((x) => x.id));
  }
  assert.equal(mineAll.roads.size, refAll.roads.size, 'roads');
  for (const [rid, r] of refAll.roads) {
    assert.ok(mineAll.roads.has(rid), `${rid} is somewhere`);
    assert.deepEqual(mineAll.roads.get(rid).pts, r.pts, `${rid} laid out`);
    assert.deepEqual(mineAll.roads.get(rid).cs, r.cs, `${rid} cross-section`);
  }
  assert.deepEqual(mineAll.sidewalks.sort(), refAll.sidewalks.sort(), 'pavements');
  assert.deepEqual(mineAll.cycleTracks.sort(), refAll.cycleTracks.sort(), 'cycle tracks');
  assert.ok([...store.ids].some((id) => data.roadsOf(id).signals.length > 0), 'the tiles bring their signals');
});

test('building compute: a job survives the trip to a worker; lite and full agree on the geometry that is shared', { skip: !isDistrict && 'run tile_split.py first' }, async () => {
  const { store, data, terrain } = await district();
  const id = store.ids.find((t) => data.buildings(t).length > 100);
  const ctx = data.tileContext(id, 'near');
  const own = ctx.ownBuildings;
  const slim = (b) => ({ id: b.id, ring: b.ring, holes: b.holes });
  const lows = new Map(own.map((b) => [b.id, groundLow(b, terrain)]).filter((e) => e[1] !== null));
  const job = {
    buildings: own, heroIds: [], observed: true, doors: true, lite: false, wantQuads: false, calibration: true,
    context: { buildings: ctx.geo.buildings.map(slim), roads: ctx.geo.roads.map((r) => ({ pts: r.pts, width: r.width, class: r.class, name: r.name })) },
    venues: ctx.venues, entrances: ctx.entrances, lod2: new Map(), lows
  };
  const direct = computeBuildings(job);
  const cloned = computeBuildings(structuredClone(job)); // what a worker receives
  assert.equal(cloned.stats.triangles, direct.stats.triangles);
  assert.equal(cloned.leaves.length, direct.leaves.length);
  assert.deepEqual(cloned.leaves[0].wallRanges, direct.leaves[0].wallRanges);
  assert.ok(direct.stats.triangles > 1000 && direct.stats.doors > 0);

  // the same buildings through addBuilding directly (the district build before the split), with the terrain itself
  const ground = createGroundContext({ roads: ctx.geo.roads, buildings: ctx.geo.buildings, venues: ctx.venues, entrances: ctx.entrances ? createEntranceIndex(ctx.entrances) : null });
  const acc = createAccumulator();
  let tri = 0;
  for (const b of own) { const a = addBuilding(acc, b, { ground, terrain }); if (a) tri += a.wallTriangles + a.roofTriangles; }
  assert.equal(direct.stats.triangles, tri, 'a worker-side build makes the same triangles as the build with the terrain');

  // the tone-only mid ring: same footprints, one colour per building, no facade frame, far fewer vertices of detail
  const lite = computeBuildings({ ...job, lite: true, doors: false, context: null, venues: [], entrances: null });
  const wall = lite.leaves.find((l) => l.wall).wall;
  assert.ok(wall.color && !wall.facadeUV, 'a colour per vertex, no facade frame');
  assert.equal(wall.color.length, wall.position.length);
  assert.ok(lite.stats.triangles < direct.stats.triangles * 0.8, `${lite.stats.triangles} lite vs ${direct.stats.triangles} full triangles: no parapets, no details`);
  assert.equal(lite.leaves.length, 1, 'a tone-only tile is one cell: one wall and one roof mesh');
  assert.equal(lite.doorInfo.length, 0);
  assert.equal(lite.stats.doors, 0);
  // a lite building has one tone: every wall vertex of one range carries the same colour
  const leaf = lite.leaves.find((l) => l.wall);
  const r = leaf.wallRanges[0];
  const firstVertex = leaf.wall.index[r.start];
  for (let t = r.start; t < r.end; t++) {
    const v = leaf.wall.index[t];
    assert.deepEqual([...leaf.wall.color.slice(3 * v, 3 * v + 3)], [...leaf.wall.color.slice(3 * firstVertex, 3 * firstVertex + 3)]);
  }
  // the arrays are transferable as they are
  const buffers = transferablesOf(direct);
  assert.ok(buffers.length > 10 && buffers.every((b) => b instanceof ArrayBuffer));
  // the generator can be sliced: it yields between buildings and ends with the same result
  const steps = buildingSteps(job);
  let n = 0;
  let r2;
  for (;;) { const s = steps.next(); if (s.done) { r2 = s.value; break; } n++; }
  assert.ok(n > own.length / 10, `${n} steps`);
  assert.equal(r2.stats.triangles, direct.stats.triangles);
});

test('road compute: the worker build (terrain chunks, owned indices, structured clone) makes the surfaces of the direct build', { skip: !isDistrict && 'run tile_split.py first' }, async () => {
  const { store, data, terrain } = await district();
  const id = store.ids.find((t) => data.roadsOf(t).roads.length > 40);
  const ctx = data.tileContext(id, 'near');
  const job = structuredClone(makeRoadJob(ctx, { near: true, terrain }));
  const got = computeRoadSurfaces(job);
  const want = computeSurfaceMeshes(ctx.geo, ctx.surfaces, terrain);
  assert.equal(got.meshes.length, want.length);
  for (let i = 0; i < want.length; i++) {
    assert.equal(got.meshes[i].name, want[i].name);
    assert.equal(got.meshes[i].position.length, want[i].position.length, want[i].name);
    // terrain draped from the chunks of the 3 x 3 tiles equals the draping on the whole terrain
    for (let k = 1; k < want[i].position.length; k += 3 * 97) assert.ok(Math.abs(got.meshes[i].position[k] - want[i].position[k]) < 1e-4, `${want[i].name} y`);
    assert.equal(got.meshes[i].normal.length, want[i].position.length);
  }
  // the layers are those of buildRoadSurfaceArrays
  const layers = buildRoadSurfaceArrays(ctx.geo, { surfaces: ctx.surfaces, pavement: true, terrain });
  for (const [name, layer] of Object.entries(layers)) if (layer.vertexCount) assert.equal(got.meshes.find((m) => m.name === `road-${name}`).position.length / 3, layer.vertexCount, name);
  const buckets = buildGroundBuckets(ctx.geo, ctx.surfaces, terrain);
  for (const [key, b] of buckets) if (b.vertexCount && key !== 'ground:other') assert.equal(got.meshes.find((m) => m.name === `ground-${key}`).position.length / 3, b.vertexCount, key);
  // the 0.5 m ground-height grid
  const m = 20;
  const grid = buildGroundHeightGrid(ctx.geo, ctx.surfaces, [ctx.bounds[0] - m, ctx.bounds[1] - m, ctx.bounds[2] + m, ctx.bounds[3] + m]);
  assert.deepEqual([...got.heightGrid.data.slice(0, 20000)], [...grid.data.slice(0, 20000)]);
  assert.deepEqual(got.heightGrid.bbox, grid.bbox);
  // the normals are the geometry's
  const ground = got.meshes.find((x) => x.ground);
  if (ground) assert.deepEqual([...ground.normal.slice(0, 9)], [...faceNormals(ground.position).slice(0, 9)]);
  const roadMesh = got.meshes.find((x) => x.index);
  assert.deepEqual([...roadMesh.normal.slice(0, 9)], [...vertexNormals(roadMesh.position, roadMesh.index).slice(0, 9)]);
  assert.ok(transferablesOf(got).length >= got.meshes.length * 3);
  // the mid ring: carriageways, kerbs and cycle tracks only, no height grid
  const mid = computeRoadSurfaces(structuredClone(makeRoadJob(data.tileContext(id, 'mid'), { near: false, terrain })));
  assert.ok(mid.meshes.length > 0 && mid.meshes.every((x) => ['road-asphalt', 'road-kerb', 'road-cycle'].includes(x.name)), mid.meshes.map((x) => x.name).join());
  assert.equal(mid.heightGrid, null);
});

test('furniture compute: placing in a worker equals placing against the zone map on the main thread', { skip: !isDistrict && 'run tile_split.py first' }, async () => {
  const { store, data, city } = await district();
  const id = store.ids.find((t) => (data.tileContext(t, 'near').furniture?.lamps?.length || 0) > 20);
  const ctx = data.tileContext(id, 'near');
  const doc = ctx.furniture;
  const M = 30;
  const water = city.lakes;
  const placed = computeFurniturePlacement(structuredClone(makeFurnitureJob(ctx, { doc, water, margin: M })));
  const zones = createZoneMap({ geo: ctx.geo, lakes: water, surfaces: ctx.surfaces, bbox: [ctx.bounds[0] - M, ctx.bounds[1] - M, ctx.bounds[2] + M, ctx.bounds[3] + M] });
  const ref = placeFurniture(doc, { zones, geo: ctx.geo });
  assert.equal(placed.doc.lamps.length, ref.doc.lamps.length);
  assert.equal(placed.doc.trees.length, ref.doc.trees.length);
  assert.deepEqual(placed.doc.lamps.slice(0, 5).map((l) => [l.x, l.z]), ref.doc.lamps.slice(0, 5).map((l) => [l.x, l.z]));
  assert.deepEqual(placed.report.counts, ref.report.counts);
});

test('chunk sampler: heights from loose chunks equal the stream terrain', { skip: !isDistrict && 'run tile_split.py first' }, async () => {
  const { store, terrain, city } = await district();
  const sampler = createChunkSampler(city.meta.terrain);
  for (const id of store.ids) { const c = terrain.chunkOf(id); if (c) sampler.set(id, c); }
  for (let i = 0; i < 200; i++) {
    const x = ((i * 7919) % 1500) - 750;
    const z = ((i * 104729) % 1500) - 750;
    assert.equal(sampler.heightAt(x, z), terrain.heightAt(x, z));
  }
});

test('street layout: the per-tile layers and the whole-city document give every tile the same roads, pavements and cycle tracks', { skip: !isDistrict && 'run tile_split.py + tile_streets.py first' }, async () => {
  const { store, city, data } = await district();
  const legacy = city.streets || await store.loadStreets();
  assert.ok(legacy, 'the whole street layout is there');
  const { geo } = createBaseGeo(city.meta, city.roadGraph, null);
  const terrain = createStreamTerrain(city.meta.terrain);
  const other = createTileData({ index: store.index, meta: city.meta, streets: legacy, lakes: city.lakes, geo, terrain });
  for (const id of store.ids) for (const n of ['buildings', 'terrain', 'surfaces', 'vegetation', 'roads']) other.setLayer(id, n, await store.fetchLayer(id, n)); // no `streets` layer
  for (const id of store.ids) {
    const a = data.roadsOf(id);
    const b = other.roadsOf(id);
    assert.deepEqual(a.roads.map((r) => r.id).sort(), b.roads.map((r) => r.id).sort(), `${id} roads`);
    assert.deepEqual(a.sidewalks.map((r) => r.id).sort(), b.sidewalks.map((r) => r.id).sort(), `${id} pavements`);
    assert.deepEqual(a.cycleTracks.map((r) => r.id).sort(), b.cycleTracks.map((r) => r.id).sort(), `${id} cycle tracks`);
    assert.equal(data.buildings(id).length, other.buildings(id).length, `${id} buildings after the footprint fixes`);
  }
});
