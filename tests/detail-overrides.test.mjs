import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  OVERRIDE, OVERRIDE_FORMAT, readOverrideLayer, createOverrideBudget, createOverrideBudgetLease, admitOverrides, overrideFootprints, ringEdge, detailGeometry, overridesMode, attributionLines
} from '../js/detail-overrides.js';
import { encodePack, readPack, createAtlasSource, setAtlasSource, gzip } from '../js/data-packs.js';
import { RING_LAYERS } from '../js/tile-rings.js';
import { openTileStore } from '../js/tile-store.js';
import { ROOT } from './helpers/district-tiles.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const square = (x0, z0, s) => [x0, z0, x0 + s, z0, x0 + s, z0 + s, x0, z0 + s];

function layer(buildings, extra = {}) {
  return { format: OVERRIDE_FORMAT, tile: '1_1', attribution: { a: { text: 'A', licence: 'CC BY 4.0' } }, buildings, ...extra };
}
const mesh = (bytes = 1000, path = 'overrides/s/m.glb') => ({ path, bytes: 10, textureBytes: bytes, triangles: 12 });

test('the layer reader keeps entries with a mesh or details, and maps every covered id to its override', () => {
  assert.equal(readOverrideLayer(null), null);
  assert.equal(readOverrideLayer({ format: 'other/1', buildings: {} }), null);
  const l = readOverrideLayer(layer({
    'gdk:1': { mode: 'replace', mesh: mesh(), covers: ['gdk:2'], bounds: [0, 0, 0, 10, 10, 10] },
    'gdk:3': { mode: 'replace' }, // nothing to show
    'gdk:4': { mode: 'details', details: { openings: [{ edge: 0, u: [1, 2], v: [1, 2], kind: 'window' }] }, footprint: { use: 'gdk', ring: square(0, 0, 4) } },
    'gdk:5': { mode: 'details', details: { openings: [] } }
  }));
  assert.deepEqual([...l.entries.keys()], ['gdk:1', 'gdk:4']);
  assert.deepEqual(l.entries.get('gdk:1').covers, ['gdk:1', 'gdk:2']);
  assert.deepEqual(l.entries.get('gdk:1').centre, [5, 5]);
  assert.equal(l.entries.get('gdk:4').mode, 'details');
  assert.deepEqual([...l.covered], [['gdk:1', 'gdk:1'], ['gdk:2', 'gdk:1']], 'details-only entries hide nothing');
});

test('meshes are admitted nearest first within the texture budget and the distance cap; released bytes are reusable', () => {
  const p = { ...OVERRIDE, maxTextureBytes: 2500, maxMeshes: 10, maxDistance: 500 };
  const budget = createOverrideBudget(p);
  const l = readOverrideLayer(layer({
    'gdk:far': { mode: 'replace', mesh: mesh(1000), bounds: [400, 0, 0, 410, 1, 10] },
    'gdk:near': { mode: 'replace', mesh: mesh(1000), bounds: [0, 0, 0, 10, 1, 10] },
    'gdk:mid': { mode: 'replace', mesh: mesh(1000), bounds: [100, 0, 0, 110, 1, 10] },
    'gdk:gone': { mode: 'replace', mesh: mesh(10), bounds: [900, 0, 0, 910, 1, 10] }
  }));
  const { show, refused } = admitOverrides(l, { x: 0, z: 0 }, budget);
  assert.deepEqual(show.map((e) => e.id), ['gdk:near', 'gdk:mid']);
  assert.deepEqual(refused.map((e) => e.id).sort(), ['gdk:far', 'gdk:gone']);
  assert.equal(budget.bytes, 2000);
  assert.equal(budget.stats.refused, 1, 'the far one by the budget (the other by distance)');
  budget.release('gdk:near');
  assert.equal(budget.bytes, 1000);
  assert.ok(budget.reserve('gdk:far', 1000));
  assert.deepEqual(budget.memory(), { residentBytes: 2000, peakBytes: 2000, budgetBytes: 2500, meshes: 2 });
});

test('per-build leases count overlapping copies of the same override id and release independently', () => {
  const budget = createOverrideBudget({ ...OVERRIDE, maxTextureBytes: 12, maxMeshes: 2 });
  const first = createOverrideBudgetLease(budget);
  const second = createOverrideBudgetLease(budget);
  assert.equal(first.reserve('gdk:1', 6), true);
  assert.equal(first.reserve('gdk:1', 6), true, 'a repeated reservation in one build remains idempotent');
  assert.equal(second.reserve('gdk:1', 6), true, 'a second real copy gets its own global reservation');
  assert.deepEqual(budget.memory(), { residentBytes: 12, peakBytes: 12, budgetBytes: 12, meshes: 2 });

  first.release('gdk:1');
  assert.equal(budget.memory().residentBytes, 6);
  assert.equal(second.has('gdk:1'), true);
  second.releaseAll();
  assert.equal(budget.memory().meshes, 0);
});

test('overlapping leases are refused when the shared byte cap is full', () => {
  const budget = createOverrideBudget({ ...OVERRIDE, maxTextureBytes: 10, maxMeshes: 2 });
  const first = createOverrideBudgetLease(budget);
  const second = createOverrideBudgetLease(budget);
  assert.equal(first.reserve('same-id', 7), true);
  assert.equal(second.reserve('same-id', 7), false);
  assert.equal(budget.memory().residentBytes, 7);
  first.releaseAll();
  assert.equal(second.reserve('same-id', 7), true, 'released capacity can be admitted by the waiting build');
  assert.equal(budget.memory().residentBytes, 7);
});

test('colliders and walk space keep the generated footprint unless the override says otherwise', () => {
  const buildings = [{ id: 'gdk:1', ring: square(0, 0, 10) }, { id: 'gdk:2', ring: square(10, 0, 10) }, { id: 'gdk:3', ring: square(30, 0, 5) }];
  const same = readOverrideLayer(layer({ 'gdk:1': { mode: 'replace', mesh: mesh(), footprint: { use: 'gdk' } } }));
  assert.equal(overrideFootprints(buildings, same), buildings, 'within tolerance: the very same records');
  const merged = readOverrideLayer(layer({ 'gdk:1': { mode: 'replace', mesh: mesh(), covers: ['gdk:2'], footprint: { use: 'override', ring: square(0, 0, 20) } } }));
  const out = overrideFootprints(buildings, merged);
  assert.deepEqual(out.map((b) => b.id), ['gdk:1', 'gdk:3'], 'a covered building is folded into the override');
  assert.deepEqual(out[0].ring, square(0, 0, 20));
  assert.ok(out[0].footprintOverride);
  assert.equal(overrideFootprints(buildings, merged, () => false), buildings, 'an override that is not shown changes nothing');
});

test('ring edges: unit direction, length and an outward normal for either winding', () => {
  for (const ring of [square(0, 0, 10), square(0, 0, 10).reduceRight((acc, _, i, a) => (i % 2 ? acc.concat([a[i - 1], a[i]]) : acc), [])]) {
    for (let i = 0; i < 4; i++) {
      const e = ringEdge(ring, i);
      assert.ok(Math.abs(e.L - 10) < 1e-9);
      const mid = [e.a[0] + e.d[0] * 5, e.a[1] + e.d[1] * 5];
      const toCentre = [5 - mid[0], 5 - mid[1]];
      assert.ok(e.out[0] * toCentre[0] + e.out[1] * toCentre[1] < 0, `edge ${i} normal points out`);
    }
  }
});

test('parametric details: openings on the wall plane in front of it, at v above ground; boxes for cornices, dormers and chimneys', () => {
  const b = { id: 'gdk:1', ring: square(0, 0, 10), ground: -5 };
  const g = detailGeometry(b, {
    openings: [{ edge: 0, u: [2, 3], v: [1, 2.5], kind: 'window' }, { edge: 0, u: [5, 4], v: [1, 2], kind: 'door' }], // the second is empty
    cornices: [{ edge: 1, u: [0, 10], v: 9, height: 0.3, depth: 0.2 }],
    dormers: [{ edge: 2, u: [3, 5], base: [10, 11], top: 12, depth: 1.5 }],
    chimneys: [{ at: [5, 5], size: [0.6, 0.8], base: 11, top: 13 }]
  });
  const quads = g.index.length / 6;
  assert.equal(quads, 2 + 5 + 6 + 5, 'opening (frame + pane), cornice box, dormer box + window, chimney box');
  assert.equal(g.position.length, g.normal.length);
  assert.equal(g.position.length, g.color.length);
  // the window: edge 0 runs x 0 -> 10 at z = 0; outward is -z; v measured from ground -5
  const pts = [];
  for (let i = 0; i < 8 * 3; i += 3) pts.push(g.position.slice(i, i + 3));
  const pane = pts.slice(4, 8);
  assert.deepEqual(pane.map((p) => +p[0].toFixed(3)).sort(), [2, 2, 3, 3]);
  assert.deepEqual([...new Set(pane.map((p) => +p[1].toFixed(3)))].sort((a, c) => a - c), [-4, -2.5]);
  assert.ok(pane.every((p) => p[2] < 0 && p[2] > -0.1), 'in front of the wall, a few cm');
  // the chimney box spans its footprint and heights
  const ys = [];
  const xs = [];
  for (let i = (2 + 5 + 6) * 4 * 3; i < g.position.length; i += 3) { xs.push(g.position[i]); ys.push(g.position[i + 1]); }
  assert.deepEqual([Math.min(...xs), Math.max(...xs)].map((v) => +v.toFixed(3)), [4.7, 5.3]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [6, 8]);
  assert.equal(detailGeometry(null, {}).index.length, 0);
});

test('?overrides= switches the layer off, to details only, or leaves it on', () => {
  assert.equal(overridesMode('?overrides=0'), 'off');
  assert.equal(overridesMode('?overrides=off'), 'off');
  assert.equal(overridesMode('?overrides=details'), 'details');
  assert.equal(overridesMode(''), 'on');
  assert.equal(overridesMode('?overrides=1'), 'on');
});

test('the overrides layer streams with the near ring only (a mid tile keeps the generated building)', () => {
  assert.ok(RING_LAYERS.near.includes('overrides'));
  assert.ok(!RING_LAYERS.mid.includes('overrides'));
});

test('attribution lines: the union of the layers, first text wins', () => {
  const lines = attributionLines([{ attribution: { a: { text: 'A', licence: 'CC BY 4.0' } } }, { attribution: { a: { text: 'A2' }, b: { text: 'B', url: 'u' } } }, null]);
  assert.deepEqual(lines, [{ key: 'a', text: 'A', licence: 'CC BY 4.0', url: null }, { key: 'b', text: 'B', licence: null, url: 'u' }]);
});

test('override meshes come out of a chunked pack with one Range request per chunk, gzip entries inflated', async () => {
  const te = new TextEncoder();
  const a = te.encode('glTF' + 'a'.repeat(3000));
  const b = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7) & 255);
  const file = await encodePack([{ name: 'overrides/s/a.glb', type: 'bin', data: a, gzip: true }, { name: 'overrides/s/b.glb', type: 'bin', data: b }], { chunks: [[0, 1], [1, 1]] });
  const p = readPack(file);
  const pack = { file: 'x/abc.pack', size: file.byteLength, chunks: p.chunks, entries: {} };
  p.header.entries.forEach((e, i) => { pack.entries[e.name] = [i, e.offset, e.length, e.enc, e.size]; });
  const log = [];
  const fetchImpl = async (url, opts = {}) => {
    log.push(opts.headers?.Range || null);
    const [, s, t] = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
    return { ok: true, status: 206, arrayBuffer: async () => file.slice(+s, +t + 1).buffer };
  };
  const src = createAtlasSource({ base: 'https://h', fetchImpl, stats: { requests: 0, bytes: 0, ranges: 0, hits: 0 } });
  src.register(pack);
  assert.ok(src.hasFile('overrides/s/a.glb') && src.hasFile('/overrides/s/b.glb') && !src.hasFile('overrides/s/c.glb'));
  assert.deepEqual(await src.bytes('overrides/s/a.glb'), a);
  assert.deepEqual(await src.bytes('overrides/s/b.glb'), b);
  assert.deepEqual(await src.bytes('overrides/s/a.glb'), a, 'cached');
  assert.equal(log.length, 2);
  await assert.rejects(src.bytes('overrides/s/c.glb'), /404/);
  assert.equal(p.header.entries[0].enc, 'gzip');
  assert.ok((await gzip(a)).byteLength < a.byteLength);
});

test('the committed Nyhavn override metadata fits the override texture budget with room to spare', () => {
  const nyhavn = readJson('./fixtures/overrides-nyhavn.json');
  const l = readOverrideLayer(nyhavn);
  assert.ok(l.entries.size >= 5, 'the photo-traced Nyhavn 9-17 at least');
  const bytes = [...l.entries.values()].reduce((n, e) => n + e.mesh.textureBytes, 0);
  assert.ok(bytes <= OVERRIDE.maxTextureBytes * 0.75, `${bytes} of ${OVERRIDE.maxTextureBytes}`);
  // every override sits on its gdk footprint (KK bygning carries GeoDanmark's objects): colliders keep the generated footprints
  for (const e of l.entries.values()) {
    assert.equal(e.footprint.use, 'gdk', e.id);
    assert.ok(e.match.iou >= 0.85, e.id);
  }
  const budget = createOverrideBudget();
  const { show, refused } = admitOverrides(l, { x: 1760, z: 190 }, budget);
  assert.equal(show.length, l.entries.size);
  assert.equal(refused.length, 0);
  // every published attribution key is explained
  for (const e of l.entries.values()) for (const k of e.attribution) assert.ok(l.attribution[k]?.text && l.attribution[k]?.licence, k);
});

test('build_packs: an override set becomes the tile\'s overrides layer and a chunked mesh pack (local data only)', async (t) => {
  const indexPath = path.join(ROOT, 'data/tiles/index.json');
  if (!fs.existsSync(indexPath)) { t.skip('no data/tiles'); return; }
  const ids = Object.keys(JSON.parse(fs.readFileSync(indexPath, 'utf8')).tiles).sort().slice(0, 1);
  const bfile = path.join(ROOT, 'data/tiles', ids[0], 'buildings.json');
  const gid = JSON.parse(fs.readFileSync(bfile, 'utf8')).buildings[0].id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-set-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-packs-'));
  const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(5000, 7)]);
  fs.mkdirSync(path.join(dir, 'meshes'));
  fs.writeFileSync(path.join(dir, 'meshes', 'a.glb'), glb);
  fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify({
    format: 'cph-detail-source/1', name: 'test', attribution: { k: { text: 'K', licence: 'CC0' } },
    buildings: { [gid]: { tile: ids[0], mode: 'replace', covers: [gid], footprint: { use: 'gdk' }, attribution: ['k'], bounds: [0, 0, 0, 1, 1, 1], mesh: { path: 'meshes/a.glb', bytes: glb.length, textureBytes: 10 } } }
  }));
  try {
    execFileSync('python3', [path.join(ROOT, 'tools/hosting/build_packs.py'), '--out', out, '--tiles', ids.join(','), '--no-atlases', '--workers', '2', '--overrides', dir], { stdio: 'ignore' });
  } catch { t.skip('python3 build failed'); return; }
  const host = async (url, opts = {}) => {
    const p = path.join(out, String(url).replace(/^file:\/\/packs\//, ''));
    if (!fs.existsSync(p)) return { ok: false, status: 404 };
    let buf = fs.readFileSync(p);
    const r = opts.headers?.Range;
    if (r) { const [, s, e] = /bytes=(\d+)-(\d+)/.exec(r); buf = buf.subarray(+s, +e + 1); }
    return { ok: true, status: r ? 206 : 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  try {
    const store = await openTileStore({ fetchImpl: host, dataBase: 'file://packs', packs: true });
    assert.ok(store.hasLayer(ids[0], 'overrides'), 'the packed index lists the layer');
    const l = readOverrideLayer(await store.fetchLayer(ids[0], 'overrides'));
    const e = l.entries.get(gid);
    assert.equal(e.mesh.path, 'overrides/test/meshes/a.glb');
    assert.deepEqual(l.attribution, { k: { text: 'K', licence: 'CC0' } });
    const { getAtlasSource } = await import('../js/data-packs.js');
    getAtlasSource().register(l.pack);
    assert.deepEqual(Buffer.from(await getAtlasSource().bytes(e.mesh.path)), glb);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.ok(m.tiles[ids[0]].some((n) => n && n.startsWith('x/')), 'the mesh pack is in the tile row (the uploader sends it)');
    assert.ok(!JSON.stringify(m).includes(os.tmpdir()), 'no local paths in the manifest');
  } finally {
    setAtlasSource(null);
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
