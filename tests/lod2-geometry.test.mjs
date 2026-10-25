import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLod2Record, loadLod2, lod2EdgeTops, lod2WallPieces, clipAbove } from '../js/lod2-geometry.js';
import { createAccumulator, addBuilding, cleanRing } from '../js/building-geometry.js';

// Mirrors tools/lod2/convert.py pack_record: a 10 x 6 m gabled house, ground 5, eave 9, ridge 11 along x.
const RING = [0, 0, 10, 0, 10, -6, 0, -6];
const P = { A: [0, 5, 0], B: [10, 5, 0], C: [10, 5, -6], D: [0, 5, -6], a: [0, 9, 0], b: [10, 9, 0], c: [10, 9, -6], d: [0, 9, -6], r0: [0, 11, -3], r1: [10, 11, -3] };
const names = Object.keys(P);
function packRecord(tris, edges, kinds, tops) {
  const nV = names.length, nT = tris.length, nE = tops.length;
  const size = 18 + 6 * nV + 6 * nT + nT + 2 * nT + 2 * nE;
  const buf = new ArrayBuffer(size + ((4 - (size % 4)) % 4));
  const v = new DataView(buf);
  v.setFloat32(0, 5, true); v.setFloat32(4, 0, true); v.setFloat32(8, -3, true); // origin
  v.setUint16(12, nV, true); v.setUint16(14, nT, true); v.setUint16(16, nE, true);
  let o = 18;
  for (const n of names) { v.setInt16(o, Math.round((P[n][0] - 5) * 100), true); v.setInt16(o + 2, Math.round(P[n][1] * 100), true); v.setInt16(o + 4, Math.round((P[n][2] + 3) * 100), true); o += 6; }
  for (const t of tris) for (const n of t) { v.setUint16(o, names.indexOf(n), true); o += 2; }
  for (const k of kinds) { v.setUint8(o, k); o += 1; }
  for (const e of edges) { v.setInt16(o, e, true); o += 2; }
  for (const t of tops) { v.setInt16(o, t === null ? -32768 : Math.round(t * 100), true); o += 2; }
  return buf;
}
// CCW from outside. Walls: south (edge 0), east gable (1), north (2), west gable (3); two roof planes; one inner wall at x=5.
const TRIS = [
  [['A', 'B', 'b'], 1, 0], [['A', 'b', 'a'], 1, 0],
  [['B', 'C', 'c'], 1, 1], [['B', 'c', 'r1'], 1, 1], [['B', 'r1', 'b'], 1, 1],
  [['C', 'D', 'd'], 1, 2], [['C', 'd', 'c'], 1, 2],
  [['D', 'A', 'a'], 1, 3], [['D', 'a', 'r0'], 1, 3], [['D', 'r0', 'd'], 1, 3],
  [['a', 'b', 'r1'], 0, -1], [['a', 'r1', 'r0'], 0, -1], [['d', 'r0', 'r1'], 0, -1], [['d', 'r1', 'c'], 0, -1]
];
const record = () => parseLod2Record(packRecord(TRIS.map((t) => t[0]), TRIS.map((t) => t[2]), TRIS.map((t) => t[1]), [9, 9, 9, 9]));
const building = (extra = {}) => ({ id: 'gdk:1', ring: RING, ground: 5, eave: 9, ridge: 9.2, roof: 'flat', roof_material: 'tegl', facade: { floor_h: 2.8, ground_floor_h: 3.6, window_w: 1.2, bay_w: 4.7, ground_type: 'residential', tone: [0.7, 0.6, 0.5] }, ...extra });

test('parseLod2Record decodes the packed layout into absolute local metres', () => {
  const r = record();
  assert.equal(r.nV, 10);
  assert.equal(r.nT, TRIS.length);
  assert.deepEqual([...r.top], [9, 9, 9, 9]);
  const k = r.idx[0];
  assert.deepEqual([r.pos[3 * k], r.pos[3 * k + 1], r.pos[3 * k + 2]], P.A);
  assert.deepEqual([...r.edge].slice(0, 5), [0, 0, 1, 1, 1]);
});

test('edge tops map raw edges onto the cleaned ring and fall back to the DSM eave', () => {
  const b = building();
  const rings = [cleanRing(RING, true)];
  const rec = record();
  rec.top[2] = NaN; // an unmatched edge
  const lod = lod2EdgeTops(rec, b, rings, 8.5, 6);
  assert.equal(lod.tops.length, 4);
  const north = lod.cleaned.findIndex((c) => c[1] === -6 && c[3] === -6);
  assert.equal(lod.tops[north], 8.5);
  assert.equal(lod.tops.filter((t) => t === 9).length, 3);
  // tops below ground + 1 m are junk and ignored
  rec.top[0] = 5.2;
  assert.equal(lod2EdgeTops(rec, b, rings, 8.5, 6).tops.filter((t) => t === 8.5).length, 2);
});

test('clipAbove keeps only the part above the plane', () => {
  const tri = [[0, 0, 0], [4, 0, 0], [2, 4, 0]];
  const out = clipAbove(tri, 2);
  const area = out.reduce((s, t) => s + Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2, 0);
  assert.ok(Math.abs(area - 2) < 1e-9, 'the top half of the triangle (base 2, height 2)');
  assert.equal(clipAbove(tri, 5).length, 0);
  assert.equal(clipAbove(tri, -1).length, 1);
});

test('wall pieces: only the gable triangles above the eave survive', () => {
  const b = building();
  const rec = record();
  const lod = lod2EdgeTops(rec, b, [cleanRing(RING, true)], 9, 6);
  const pieces = lod2WallPieces(rec, lod);
  assert.ok(pieces.length >= 2, 'both gable ends contribute');
  for (const { tri, edge } of pieces) {
    assert.ok(edge >= 0);
    for (const q of tri) assert.ok(q[1] >= 9 - 1e-3);
  }
});

test('addBuilding with a LoD2 record: pitched roof on top of walls that end at the roofer eave', () => {
  const acc = createAccumulator();
  const flat = createAccumulator();
  addBuilding(flat, building());
  const added = addBuilding(acc, building(), { lod2: record() });
  assert.equal(added.roofTriangles, 4, 'the four roof triangles replace the flat deck + parapet');
  const ys = acc.roof.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...ys), 11);
  assert.equal(Math.min(...ys), 9);
  for (let i = 1; i < acc.roof.normal.length; i += 3) assert.ok(acc.roof.normal[i] > 0.5, 'roof normals face up');
  // facade quads (4 edges x 2 triangles) end at the eave; gable triangles add more wall above it
  assert.ok(added.wallTriangles >= 8 + 2);
  const wallYs = acc.wall.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...wallYs), 11, 'gable apex is wall');
  assert.ok(acc.roofRanges.at(-1).end > acc.roofRanges.at(-1).start);
  // flat fallback unchanged
  assert.ok(flat.roof.index.length / 3 > 4);
});

test('wall tops follow a roofer eave that differs from the DSM eave', () => {
  const rec = record();
  rec.top.set([7.5, 7.5, 7.5, 7.5]);
  const acc = createAccumulator();
  addBuilding(acc, building(), { lod2: rec });
  // the extruded facade quads (kind: first 8 triangles = 4 quads x 2) top out at 7.5
  const quadTops = [];
  for (let q = 0; q < 4; q++) quadTops.push(acc.wall.position[(4 * q + 2) * 3 + 1]);
  assert.deepEqual(quadTops, [7.5, 7.5, 7.5, 7.5]);
});

test('loadLod2 joins by building id, serves only measured records and degrades to null', async () => {
  const bin = packRecord(TRIS.map((t) => t[0]), TRIS.map((t) => t[2]), TRIS.map((t) => t[1]), [9, 9, 9, 9]);
  const index = { version: 'lod2/1', tiles: { '6176_723': { file: '6176_723.bin' } }, buildings: {
    'gdk:1': { tile: '6176_723', offset: 0, length: bin.byteLength, conf: 'measured', scan_date: '2019-04-07' },
    'gdk:2': { tile: '6176_723', conf: 'inferred', reason: 'built after the point cloud was scanned' } } };
  const fetchImpl = async (url) => (url.endsWith('index.json') ? { ok: true, json: async () => index } : url.endsWith('.bin') ? { ok: true, arrayBuffer: async () => bin } : { ok: false });
  const lod = await loadLod2('x', fetchImpl);
  await lod.prefetch();
  assert.equal((await lod.ready('gdk:1')).nT, TRIS.length);
  assert.equal(await lod.ready('gdk:2'), null);
  assert.equal(await lod.ready('gdk:nope'), null);
  assert.equal(lod.entry('gdk:2').reason.startsWith('built after'), true);
  assert.equal(await loadLod2('x', async () => ({ ok: false })), null);
  assert.equal(await loadLod2('x', async () => { throw new Error('offline'); }), null);
  assert.equal(await loadLod2('x', async () => ({ ok: true, json: async () => ({ version: 'other' }) })), null);
});
