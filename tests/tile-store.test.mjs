import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTileStore, assembleArea, createTileLod2 } from '../js/tile-store.js';
import { decodeGrid, createTerrain } from '../js/terrain-cph.js';
import { CPH_FRAME } from '../js/city-config.js';
import { ROOT, TILES_URL, isDistrict } from './helpers/district-tiles.mjs';

const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const fileFetch = async (url) => {
  const p = path.join(ROOT, String(url).replace(/^\.\//, '').replace(/\/[^/]+\/\.\.\//, '/'));
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

test('no index -> null store (the engine falls back to the monolithic files)', async () => {
  assert.equal(await openTileStore({ fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await openTileStore({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'nope' }) }) }), null);
});

test('assembling restores source order from ord, in any tile order', () => {
  const meta = { geodata: { version: 'cph-geodata/1', points_keys: ['trees'] } };
  const a = { buildings: { tile: 'a', ord: { buildings: [0, 3] }, buildings: [{ id: 'b0' }, { id: 'b3' }] } };
  const b = { buildings: { tile: 'b', ord: { buildings: [1, 2] }, buildings: [{ id: 'b1' }, { id: 'b2' }] }, roads: { ord: { 'points.trees': [0] }, 'points.trees': [{ x: 1, z: 2 }] } };
  const doc = assembleArea({ meta, roadGraph: { nodes: [] } }, [['b', b], ['a', a]]).geo;
  assert.deepEqual(doc.buildings.map((x) => x.id), ['b0', 'b1', 'b2', 'b3']);
  assert.deepEqual(doc.points.trees, [{ x: 1, z: 2 }]);
  assert.deepEqual(doc.roadGraph, { nodes: [] });
});

test('tile LoD2 serves records lazily from the owning tile', async () => {
  const asked = [];
  const lod2 = createTileLod2({ lod2: { version: 'lod2/1' } }, async (tid) => { asked.push(tid); return new ArrayBuffer(4); });
  lod2.addTile('t1', { buildings: { x: { conf: 'measured', offset: 0, length: 99 }, y: { conf: 'rejected' } } });
  assert.equal(await lod2.ready('y'), null);
  assert.equal(asked.length, 0);
  assert.equal(await lod2.ready('x'), null); // record longer than the buffer
  assert.deepEqual(asked, ['t1']);
  assert.equal(lod2.entry('x').conf, 'measured');
});

const haveTiles = isDistrict;
test('the district assembled from data/tiles equals the monolithic files', { skip: !haveTiles && 'run uv run tools/cph-geodata/tile_split.py first' }, async () => {
  const store = await openTileStore({ fetchImpl: fileFetch, baseUrl: TILES_URL });
  assert.ok(store);
  const ids = store.tilesForLocalBbox(CPH_FRAME.bbox, 25);
  assert.equal(ids.length, 16);
  const set = await store.loadArea(CPH_FRAME.bbox);
  const geo = read('data/cph-geodata.json');
  assert.deepEqual(set.geo, geo);
  assert.deepEqual(set.surfaces, read('data/cph-surfaces.json'));
  assert.deepEqual(set.furniture, read('data/cph-furniture.json'));
  assert.deepEqual(set.vegetation, read('data/cph-vegetation.json'));
  assert.deepEqual(set.entrances, read('data/cph-entrances.json'));
  assert.deepEqual(set.venues, read('data/cph-groundfloor.json').venues);
  assert.deepEqual(set.streets, read('data/cph-streets.json'));
  assert.deepEqual(set.lakes, read('data/cph-lakes.json'));
  const t = read('data/cph-terrain.json');
  assert.deepEqual(set.terrain.grid, decodeGrid(t.data, t.width * t.height));
  const { grid, ...rest } = set.terrain;
  const { data, ...trest } = t;
  assert.deepEqual(rest, trest);
  const terrain = createTerrain(set.terrain);
  const ref = createTerrain(t);
  for (const [x, z] of [[0, 0], [-300.5, 411.2], [749, -749], [-770, 770], [123.4, -56.7]]) assert.equal(terrain.heightAt(x, z), ref.heightAt(x, z));
});

test('tile LoD2 records equal the 1 km tile records', { skip: !haveTiles && 'run tile_split.py first' }, async () => {
  const { parseLod2Record } = await import('../js/lod2-geometry.js');
  const store = await openTileStore({ fetchImpl: fileFetch, baseUrl: TILES_URL });
  const set = await store.loadArea(CPH_FRAME.bbox);
  const index = read('data/lod2/index.json');
  let checked = 0;
  for (const [id, e] of Object.entries(index.buildings)) {
    if (e.conf !== 'measured' || e.offset === undefined || checked >= 150) continue;
    const buf = fs.readFileSync(path.join(ROOT, 'data/lod2', index.tiles[e.tile].file));
    const want = parseLod2Record(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), e.offset, e.length);
    const got = await set.lod2.ready(id);
    assert.deepEqual(got, want, id);
    checked++;
  }
  assert.ok(checked > 100);
});
