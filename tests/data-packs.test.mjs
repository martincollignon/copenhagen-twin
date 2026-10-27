import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  encodePack, readPack, entryJson, entryBytes, parsePackHeader, createPackClient, createAtlasSource, createPackSource, normalizePath,
  fetchManifest, getAtlasSource, setAtlasSource, packStats, MANIFEST_FORMAT
} from '../js/data-packs.js';
import { openTileStore } from '../js/tile-store.js';
import { ROOT } from './helpers/district-tiles.mjs';

const te = new TextEncoder();
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255);
const jsonBytes = (o) => te.encode(JSON.stringify(o));

/** fetch over an in-memory host: { [url]: Uint8Array | object (JSON) }. Range honoured unless `range: false`. Logs every request. */
function memoryHost(files, { range = true, corruptOnce = new Set() } = {}) {
  const log = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = opts.headers?.Range;
    log.push({ url: String(url), range: r || null, cache: opts.cache });
    let body = files[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => { throw new Error('404'); }, arrayBuffer: async () => new ArrayBuffer(0) };
    if (!(body instanceof Uint8Array)) body = jsonBytes(body);
    if (corruptOnce.has(url) && opts.cache !== 'reload') body = body.slice(0, 20);
    let status = 200;
    if (r && range) {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(r);
      body = body.slice(+a, +b + 1);
      status = 206;
    }
    return { ok: true, status, json: async () => JSON.parse(new TextDecoder().decode(body)), arrayBuffer: async () => body.slice().buffer };
  };
  return { fetchImpl, log };
}

test('pack round trip: gzip json and binary entries, stored entries, header bounds', async () => {
  const doc = { buildings: [{ id: 'b1', ring: [1, 2, 3, 4] }], ord: { buildings: [7] } };
  const bin = bytes(5000);
  const raw = bytes(300, 3);
  const pack = await encodePack([
    { name: 'buildings', type: 'json', data: jsonBytes(doc), gzip: true },
    { name: 'lod2.bin', type: 'bin', data: bin, gzip: true },
    { name: 'tex-look/x.webp', type: 'webp', data: raw }
  ]);
  const p = readPack(pack);
  assert.deepEqual([...p.entries.keys()], ['buildings', 'lod2.bin', 'tex-look/x.webp']);
  assert.equal(p.entries.get('buildings').enc, 'gzip');
  assert.equal(p.entries.get('tex-look/x.webp').enc, 'identity');
  assert.deepEqual(await entryJson(p, 'buildings'), doc);
  assert.deepEqual(await entryBytes(p, 'lod2.bin'), bin);
  assert.deepEqual(await entryBytes(p, 'tex-look/x.webp'), raw);
  assert.equal(await entryBytes(p, 'nope'), null);
  // corrupt: bad magic, truncated header, entry beyond the end
  assert.throws(() => readPack(new Uint8Array(40)), /corrupt/);
  assert.throws(() => readPack(pack.slice(0, 30)), /corrupt/);
  assert.throws(() => readPack(pack.slice(0, pack.byteLength - 1)), /corrupt/);
  assert.ok(parsePackHeader(pack.slice(0, 2000)).entries.size === 3, 'the header alone parses');
});

test('the Python builder writes packs the client reads (same container)', async (t) => {
  let out;
  try {
    out = execFileSync('python3', ['-c', `
import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools/hosting'))})
from build_packs import encode_pack
body, header = encode_pack([('a', 'json', json.dumps({'x': [1, 2, 3]}).encode(), True), ('b.webp', 'webp', bytes(range(200)), False), ('c.webp', 'webp', bytes(50), False)], [(1, 2)])
sys.stdout.buffer.write(body)`]);
  } catch { t.skip('python3 not available'); return; }
  const p = readPack(new Uint8Array(out));
  assert.deepEqual(await entryJson(p, 'a'), { x: [1, 2, 3] });
  assert.deepEqual(await entryBytes(p, 'b.webp'), Uint8Array.from({ length: 200 }, (_, i) => i));
  const b = p.entries.get('b.webp');
  assert.deepEqual(p.chunks, [[b.offset, 250]], 'a chunk spans its entries');
});

async function atlasFixture() {
  const atlases = Array.from({ length: 6 }, (_, i) => ({ stem: `gdk_${i}`, data: bytes(1000 + i * 100, i + 1) }));
  const file = await encodePack(atlases.map((a) => ({ name: `tex-look/${a.stem}.webp`, type: 'webp', data: a.data })), { chunks: [[0, 2], [2, 3], [5, 1]] });
  const p = readPack(file);
  const index = { file: 'a/abc.pack', size: file.byteLength, chunks: p.chunks, atlases: {} };
  [0, 0, 1, 1, 1, 2].forEach((c, i) => { const e = p.entries.get(`tex-look/gdk_${i}.webp`); index.atlases[`gdk_${i}`] = [c, e.offset, e.length]; });
  return { atlases, file, index };
}

const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

test('atlas Range assembly: one request per chunk, the rest of the chunk and tier changes come from the cache', async () => {
  const { atlases, file, index } = await atlasFixture();
  const host = memoryHost({ 'https://h/a/abc.pack': file });
  const stats = { requests: 0, bytes: 0, ranges: 0, wholeFiles: 0, hits: 0 };
  const src = createAtlasSource({ base: 'https://h/', fetchImpl: host.fetchImpl, stats });
  src.register(index);
  assert.ok(src.has('tex-look/gdk_3.webp'));
  const got = await Promise.all(atlases.map((a) => src.blob(`tex-look/${a.stem}.webp`)));
  for (let i = 0; i < atlases.length; i++) assert.deepEqual(await blobBytes(got[i]), atlases[i].data);
  assert.equal(host.log.length, 3, 'three chunks, three requests (concurrent asks share one)');
  assert.ok(host.log.every((r) => r.range));
  const [c0] = index.chunks;
  assert.equal(host.log[0].range, `bytes=${c0[0]}-${c0[0] + c0[1] - 1}`);
  assert.deepEqual(await blobBytes(await src.blob('tex-look/gdk_1.webp')), atlases[1].data);
  assert.equal(host.log.length, 3, 'cached chunk');
  await assert.rejects(src.blob('tex-look/gdk_99.webp'), (e) => e.status === 404);
  await assert.rejects(src.blob('tex/gdk_1.jpg'.replace('gdk_1', 'gdk_x')), (e) => e.status === 404);
  assert.equal(host.log.length, 3, 'a miss makes no request');
});

test('a host that ignores Range (200) switches the atlas source to whole files', async () => {
  const { atlases, file, index } = await atlasFixture();
  const host = memoryHost({ 'https://h/a/abc.pack': file }, { range: false });
  const src = createAtlasSource({ base: 'https://h', fetchImpl: host.fetchImpl, stats: {} });
  src.register(index);
  assert.deepEqual(await blobBytes(await src.blob('tex-look/gdk_0.webp')), atlases[0].data);
  assert.equal(src.rangeOk, false);
  for (const a of atlases) assert.deepEqual(await blobBytes(await src.blob(`tex-look/${a.stem}.webp`)), a.data);
  assert.equal(host.log.length, 1, 'the whole file came with the first answer');
});

test('a truncated range answer is a corrupt atlas, not a wrong image', async () => {
  const { file, index } = await atlasFixture();
  const fetchImpl = async () => ({ ok: true, status: 206, arrayBuffer: async () => file.slice(0, 10).buffer });
  const src = createAtlasSource({ base: 'https://h', fetchImpl, stats: {} });
  src.register(index);
  await assert.rejects(src.blob('tex-look/gdk_0.webp'), /corrupt/);
});

test('pack client: shared request, refcounted abort, LRU by bytes, corrupt pack refetched past the cache once', async () => {
  const p1 = await encodePack([{ name: 'x', type: 'json', data: jsonBytes({ a: 1 }), gzip: true }]);
  const p2 = await encodePack([{ name: 'y', type: 'bin', data: bytes(4000), gzip: false }]);
  const host = memoryHost({ 'https://h/t/1.pack': p1, 'https://h/t/2.pack': p2 }, { corruptOnce: new Set(['https://h/t/1.pack']) });
  const stats = { requests: 0, bytes: 0, packs: 0, hits: 0, refetches: 0, retries: 0, errors: 0 };
  const client = createPackClient({ base: 'https://h', fetchImpl: host.fetchImpl, cacheBytes: 4000, stats });
  const [a, b] = await Promise.all([client.json('t/1.pack', 'x'), client.json('t/1.pack', 'x')]);
  assert.deepEqual(a, { a: 1 });
  assert.deepEqual(b, { a: 1 });
  assert.equal(stats.retries, 1);
  assert.deepEqual(host.log.map((r) => r.cache), ['default', 'reload'], 'one shared request, retried once with cache: reload');
  await client.bytes('t/2.pack', 'y'); // 4000 + the first pack > 4500: the first is evicted
  await client.json('t/1.pack', 'x');
  assert.equal(stats.refetches, 1);

  // abort: one of two callers leaving keeps the request, both leaving aborts it
  let aborted = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (url, opts) => { opts.signal?.addEventListener('abort', () => aborted++); await gate; return host.fetchImpl(url, opts); };
  const c2 = createPackClient({ base: 'https://h', fetchImpl: slow, stats: {} });
  const k1 = new AbortController();
  const k2 = new AbortController();
  const w1 = c2.json('t/1.pack', 'x', k1.signal);
  const w2 = c2.json('t/1.pack', 'x', k2.signal);
  k1.abort();
  await assert.rejects(w1, (e) => e.name === 'AbortError');
  assert.equal(aborted, 0);
  k2.abort();
  await assert.rejects(w2, (e) => e.name === 'AbortError');
  assert.equal(aborted, 1);
  assert.equal(c2.inflight('t/1.pack'), false);
  release();
});

/** A small packed data base: two tiles (core + detail), a city pack, an atlas pack; plus the same data unpacked under /raw/tiles. */
async function packedBase({ fallback = false } = {}) {
  const index = { version: 'cph-tiles/1', tiles: {
    '1_1': { local: [0, 0, 500, 500], layers: { buildings: 10, roads: 10, furniture: 10, 'lod2.bin': 10, lod2: 10, appearance: 10 } },
    '1_2': { local: [0, 500, 500, 1000], layers: { buildings: 10 } } }, city: { meta: '../city/meta.json', roadgraph: '../city/roadgraph.json' } };
  const meta = { geodata: { version: 'cph-geodata/1' } };
  const layers = {
    '1_1': { buildings: { buildings: [{ id: 'gdk:1' }] }, roads: { roads: [1] }, furniture: { trees: [1, 2] }, lod2: { buildings: {} }, appearance: { buildings: { 'gdk:1': { atlas: {} } } } },
    '1_2': { buildings: { buildings: [{ id: 'gdk:2' }] } }
  };
  const bin = bytes(64, 9);
  const { file: atlasFile, index: atlasIndex } = await atlasFixture();
  const files = {};
  const put = (name, data) => { files[`https://h/${name}`] = data; return name; };
  const city = put('c/city.pack', await encodePack([
    { name: 'tiles/index.json', type: 'json', data: jsonBytes(index), gzip: true },
    { name: 'city/meta.json', type: 'json', data: jsonBytes(meta), gzip: true },
    { name: 'city/roadgraph.json', type: 'json', data: jsonBytes({ nodes: [] }), gzip: true },
    { name: 'city/post.json', type: 'json', data: jsonBytes({ version: 'cph-post/1' }), gzip: true }
  ]));
  put('a/abc.pack', atlasFile);
  const core11 = put('t/11.pack', await encodePack([
    ...['buildings', 'roads', 'lod2', 'appearance'].map((n) => ({ name: `1_1/${n}`, type: 'json', data: jsonBytes(layers['1_1'][n]), gzip: true })),
    { name: '1_1/lod2.bin', type: 'bin', data: bin, gzip: true },
    { name: '1_1/atlas.index', type: 'json', data: jsonBytes(atlasIndex), gzip: true }
  ]));
  const detail11 = put('d/11.pack', await encodePack([{ name: '1_1/furniture', type: 'json', data: jsonBytes(layers['1_1'].furniture), gzip: true }]));
  const core12 = put('t/12.pack', await encodePack([{ name: '1_2/buildings', type: 'json', data: jsonBytes(layers['1_2'].buildings), gzip: true }]));
  const manifest = {
    format: MANIFEST_FORMAT, groups: [{ name: 'core', layers: ['buildings', 'roads', 'lod2', 'appearance', 'lod2.bin'] }, { name: 'detail', layers: ['furniture'] }],
    files: { 'tiles/index.json': city, 'city/meta.json': city, 'city/roadgraph.json': city, 'city/post.json': city },
    tiles: { '1_1': [core11, detail11, 'a/abc.pack'], '1_2': [core12] }, ...(fallback ? { fallback: 'raw/tiles' } : {})
  };
  files['https://h/manifest.json'] = manifest;
  for (const [tid, ls] of Object.entries(layers)) for (const [n, d] of Object.entries(ls)) files[`https://h/raw/tiles/${tid}/${n}.json`] = d;
  files['https://h/raw/tiles/1_1/lod2.bin'] = bin;
  return { files, layers, bin, manifest };
}

test('a packed tile store serves the same layers, one request per pack, and registers the tile atlases', async () => {
  const { files, layers, bin } = await packedBase();
  const host = memoryHost(files);
  setAtlasSource(null);
  const store = await openTileStore({ fetchImpl: host.fetchImpl, dataBase: 'https://h', packs: true });
  assert.ok(store);
  assert.equal(store.source, 'packs');
  assert.deepEqual(store.ids, ['1_1', '1_2']);
  const city = await store.loadCity();
  assert.deepEqual(city.roadGraph, { nodes: [] });
  for (const n of ['buildings', 'roads', 'furniture', 'appearance']) assert.deepEqual(await store.fetchLayer('1_1', n), layers['1_1'][n]);
  assert.deepEqual(new Uint8Array(await store.fetchBin('1_1')), bin);
  assert.equal(store.requestKey('1_1', 'buildings'), store.requestKey('1_1', 'roads'), 'core layers share a request');
  assert.notEqual(store.requestKey('1_1', 'buildings'), store.requestKey('1_1', 'furniture'));
  const urls = host.log.map((r) => r.url.replace('https://h/', ''));
  assert.deepEqual(urls.sort(), ['c/city.pack', 'd/11.pack', 'manifest.json', 't/11.pack']);
  assert.equal(host.log.find((r) => r.url.endsWith('manifest.json')).cache, 'no-cache');
  assert.ok(getAtlasSource()?.has('tex-look/gdk_2.webp'), 'atlas index of the core pack registered');
  setAtlasSource(null);
});

test('no manifest: the store reads the unpacked layout; a missing or corrupt tile pack falls back to the unpacked files when the manifest says so', async () => {
  const { files, layers } = await packedBase({ fallback: true });
  // no manifest -> unpacked index under the tile dir
  const unpacked = memoryHost({ 'https://u/tiles/index.json': { version: 'cph-tiles/1', tiles: { '1_1': { layers: { buildings: 1 } } }, city: { meta: '../city/meta.json' } } });
  const s0 = await openTileStore({ fetchImpl: unpacked.fetchImpl, dataBase: 'https://u', baseUrl: null, packs: true });
  assert.equal(s0?.source, 'files', 'manifest absent: the unpacked index under <base>/tiles');
  assert.deepEqual(unpacked.log.map((r) => r.url).slice(0, 2), ['https://u/manifest.json', 'https://u/tiles/index.json']);
  assert.equal(await fetchManifest('https://u', unpacked.fetchImpl), null);
  assert.equal(await fetchManifest('https://x', memoryHost({ 'https://x/manifest.json': { format: 'other' } }).fetchImpl), null, 'a foreign manifest is ignored');

  delete files['https://h/t/12.pack']; // missing
  files['https://h/d/11.pack'] = files['https://h/d/11.pack'].slice(0, 25); // corrupt, also on reload
  const host = memoryHost(files);
  setAtlasSource(null);
  const store = await openTileStore({ fetchImpl: host.fetchImpl, dataBase: 'https://h', packs: true });
  assert.deepEqual(await store.fetchLayer('1_2', 'buildings'), layers['1_2'].buildings);
  assert.deepEqual(await store.fetchLayer('1_1', 'furniture'), layers['1_1'].furniture);
  assert.ok(host.log.some((r) => r.url.endsWith('raw/tiles/1_2/buildings.json')));
  assert.equal(host.log.filter((r) => r.url.endsWith('d/11.pack')).length, 2, 'corrupt pack: refetched once past the cache, then the fallback');

  // without a fallback the error goes up (the streamer retries the layer later)
  const plain = await packedBase();
  delete plain.files['https://h/t/12.pack'];
  const s2 = await openTileStore({ fetchImpl: memoryHost(plain.files).fetchImpl, dataBase: 'https://h', packs: true });
  await assert.rejects(s2.fetchLayer('1_2', 'buildings'), (e) => e.status === 404);
  setAtlasSource(null);
});

test('paths are normalised the way the unpacked store builds them', () => {
  assert.equal(normalizePath('tiles/../city/meta.json'), 'city/meta.json');
  assert.equal(normalizePath('tiles/./1_1/buildings.json'), 'tiles/1_1/buildings.json');
  const src = createPackSource({ files: { 'city/post.json': 'c/x.pack' }, tiles: { '1_1': ['t/a.pack', 'd/b.pack'] }, groups: [{ layers: ['buildings', 'lod2.bin'] }, { layers: ['furniture'] }] }, { base: 'https://h', fetchImpl: async () => ({ ok: false }) });
  assert.deepEqual(src.locate('../city/post.json'), { file: 'c/x.pack', name: 'city/post.json' });
  assert.equal(src.locate('1_1/lod2.bin').file, 't/a.pack');
  assert.equal(src.locate('1_1/furniture.json').file, 'd/b.pack');
  assert.equal(src.locate('1_1/unknown.json'), null);
  assert.equal(src.locate('9_9/buildings.json'), null);
});

test('real tiles: the Python packs hold byte-identical layers (local data only)', async (t) => {
  const index = path.join(ROOT, 'data/tiles/index.json');
  if (!fs.existsSync(index)) { t.skip('no data/tiles'); return; }
  const ids = Object.keys(JSON.parse(fs.readFileSync(index, 'utf8')).tiles).sort().slice(0, 2);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  try {
    execFileSync('python3', [path.join(ROOT, 'tools/hosting/build_packs.py'), '--out', out, '--tiles', ids.join(','), '--no-atlases', '--workers', '2'], { stdio: 'ignore' });
  } catch { t.skip('python3 build failed'); return; }
  const host = async (url, opts = {}) => {
    const p = path.join(out, String(url).replace(/^file:\/\/packs\//, ''));
    if (!fs.existsSync(p)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const store = await openTileStore({ fetchImpl: host, dataBase: 'file://packs', packs: true });
  for (const id of ids) {
    for (const n of Object.keys(store.index.tiles[id].layers)) {
      const file = path.join(ROOT, 'data/tiles', id, n.endsWith('.bin') ? n : `${n}.json`);
      if (n.endsWith('.bin')) assert.deepEqual(Buffer.from(await store.fetchBin(id)), fs.readFileSync(file));
      else assert.deepEqual(await store.fetchLayer(id, n), JSON.parse(fs.readFileSync(file, 'utf8')), `${id}/${n}`);
    }
  }
  fs.rmSync(out, { recursive: true, force: true });
  setAtlasSource(null);
  assert.ok(packStats.requests >= 0);
});
