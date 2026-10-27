import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAR_GRID, readFarHeader, farHeights, farTileArrays, farGroundArrays, farWaterArrays, FAR_COLORS } from '../js/far-lod-geometry.js';
import { tileBoundsLocal } from '../js/tile-grid.js';
import { ROOT } from './helpers/district-tiles.mjs';

// A tile block in the layout tools/cph-geodata/far_lod.py writes (see its docstring).
function block({ buildings, heights = null, parks = [] }) {
  const n = FAR_GRID + 1;
  const parts = [];
  const head = new DataView(new ArrayBuffer(4));
  head.setUint16(0, buildings.length, true);
  parts.push(new Uint8Array(head.buffer));
  const h = new DataView(new ArrayBuffer(n * n * 2));
  for (let i = 0; i < n * n; i++) h.setInt16(i * 2, Math.round((heights ? heights[i] : 5) * 100), true);
  parts.push(new Uint8Array(h.buffer));
  const bits = new Uint8Array((FAR_GRID * FAR_GRID) / 8);
  for (const c of parks) bits[c >> 3] |= 1 << (c & 7);
  parts.push(bits);
  for (const b of buildings) {
    const rec = [];
    const dv = new DataView(new ArrayBuffer(12));
    dv.setUint8(0, b.outer.length / 2); dv.setUint8(1, (b.holes || []).length);
    dv.setInt16(2, Math.round(b.base * 100), true); dv.setInt16(4, Math.round(b.top * 100), true);
    b.wall.forEach((v, i) => dv.setUint8(6 + i, v)); b.roof.forEach((v, i) => dv.setUint8(9 + i, v));
    rec.push(new Uint8Array(dv.buffer));
    const pts = (flat) => { const p = new DataView(new ArrayBuffer(flat.length * 2)); flat.forEach((v, i) => p.setInt16(i * 2, Math.round(v * 10), true)); return new Uint8Array(p.buffer); };
    rec.push(pts(b.outer));
    for (const hole of b.holes || []) { rec.push(new Uint8Array([hole.length / 2])); rec.push(pts(hole)); }
    parts.push(...rec);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

const square = (x, z, s) => [x, z, x + s, z, x + s, z - s, x, z - s]; // CCW seen from above (z south)

test('far tile: a prism has walls and a roof, all triangles face outwards / up', () => {
  const buf = block({ buildings: [{ outer: square(10, 60, 30), holes: [], base: 4, top: 19, wall: [200, 150, 120], roof: [60, 60, 70] }] });
  const a = farTileArrays(buf, 0, buf.byteLength);
  assert.equal(a.buildings, 1);
  assert.equal(a.position.length / 3, 4 * 4 + 4); // four wall quads and the roof ring
  assert.equal(a.index.length / 3, 8 + 2); // 8 wall triangles, 2 for the roof
  // every triangle's geometric normal agrees with the stored normal (outward walls, up roof)
  for (let t = 0; t < a.index.length; t += 3) {
    const [i, j, k] = [a.index[t], a.index[t + 1], a.index[t + 2]];
    const p = (v) => [a.position[3 * v], a.position[3 * v + 1], a.position[3 * v + 2]];
    const [A, B, C] = [p(i), p(j), p(k)];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const stored = [a.normal[4 * i], a.normal[4 * i + 1], a.normal[4 * i + 2]];
    assert.ok(n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] > 0, `triangle ${t / 3} faces the wrong way`);
  }
  // heights: walls from base to top, the roof at the top
  const ys = [...a.position].filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), 4);
  assert.equal(Math.max(...ys), 19);
  // the roof is the wall's roof tone, the wall its wall tone (shaded a little by direction)
  assert.deepEqual([...a.color.slice(4 * 16, 4 * 16 + 3)], [60, 60, 70]);
});

test('far tile: a courtyard (hole) is not roofed', () => {
  const outer = square(0, 100, 60);
  const hole = [20, 80, 20, 40, 40, 40, 40, 80].slice(); // CW
  const buf = block({ buildings: [{ outer, holes: [hole], base: 0, top: 12, wall: [180, 100, 80], roof: [90, 40, 30] }] });
  const a = farTileArrays(buf, 0, buf.byteLength);
  // roof area = 60 * 60 - 20 * 40
  let area = 0;
  for (let t = 0; t < a.index.length; t += 3) {
    const ids = [a.index[t], a.index[t + 1], a.index[t + 2]];
    if (!ids.every((v) => a.normal[4 * v + 1] === 127)) continue;
    const [A, B, C] = ids.map((v) => [a.position[3 * v], a.position[3 * v + 2]]);
    area += Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
  }
  assert.ok(Math.abs(area - (3600 - 800)) < 1, String(area));
});

test('far ground: heights, water at the sea, parks by the bits', () => {
  const heights = new Float32Array((FAR_GRID + 1) ** 2).fill(3);
  heights[0] = -6.84; // one corner at the sea
  const buf = block({ buildings: [], heights, parks: [5 * FAR_GRID + 5, 5 * FAR_GRID + 6, 6 * FAR_GRID + 5, 6 * FAR_GRID + 6] }); // a 2 x 2 block of park cells around vertex (6, 6)
  const b = tileBoundsLocal('1446_12352');
  const g = farGroundArrays(buf, 0, b, -6.84);
  assert.equal(g.position.length / 3, (FAR_GRID + 1) ** 2);
  assert.equal(g.index.length, FAR_GRID * FAR_GRID * 6);
  assert.ok(Math.abs(g.position[1] + 6.84) < 1e-5);
  assert.deepEqual([...g.color.slice(0, 3)], FAR_COLORS.water);
  assert.deepEqual([...g.color.slice(4 * (FAR_GRID + 1) * 6 + 4 * 6, 4 * (FAR_GRID + 1) * 6 + 4 * 6 + 3)], FAR_COLORS.park); // vertex (6, 6): inside the park block
  assert.deepEqual([...g.color.slice(4 * 10, 4 * 10 + 3)], FAR_COLORS.urban);
  // the grid spans the tile
  assert.equal(g.position[3 * FAR_GRID], b[2] - b[0]);
  assert.equal(g.position[3 * (FAR_GRID + 1) * FAR_GRID + 2], b[3] - b[1]);
  // triangles face up
  for (let t = 0; t < g.index.length; t += 3) {
    const [i, j, k] = [g.index[t], g.index[t + 1], g.index[t + 2]].map((v) => [g.position[3 * v], g.position[3 * v + 2]]);
    assert.ok((j[0] - i[0]) * (k[1] - i[1]) - (j[1] - i[1]) * (k[0] - i[0]) < 0, 'x east, z south: up is a negative cross');
  }
});

test('far water: polygons at their level, triangulated with the right area', () => {
  const w = farWaterArrays([{ ring: [0, 0, 100, 0, 100, 50, 0, 50], level: 1.5 }, { ring: [200, 0, 210, 0, 205, 10], level: -6.84 }], { lift: 0.1 });
  assert.equal(w.position.length / 3, 7);
  assert.ok(Math.abs(w.position[1] - 1.6) < 1e-6);
  assert.ok(Math.abs(w.position[3 * 4 + 1] - (-6.74)) < 1e-6);
  let area = 0;
  for (let t = 0; t < w.index.length; t += 3) {
    const [i, j, k] = [w.index[t], w.index[t + 1], w.index[t + 2]].map((v) => [w.position[3 * v], w.position[3 * v + 2]]);
    const c = (j[0] - i[0]) * (k[1] - i[1]) - (j[1] - i[1]) * (k[0] - i[0]);
    assert.ok(c < 0, 'faces up');
    area += Math.abs(c) / 2;
  }
  assert.ok(Math.abs(area - (5000 + 50)) < 1e-6, String(area));
});

// far_lod.py's own output (the dev far layer next to a tile set, made with: uv run tools/cph-geodata/far_lod.py --tiles <set>/tiles --city <set>/city)
const FAR_DIR = [process.env.CPH_TILES && path.join(ROOT, path.dirname(process.env.CPH_TILES), 'city'), path.join(ROOT, 'data/city')].filter(Boolean).find((d) => d && fs.existsSync(path.join(d, 'far.json')) && fs.existsSync(path.join(d, 'far.bin')));
test('far.bin written by far_lod.py: every tile block decodes to sane geometry', { skip: !FAR_DIR && 'run tools/cph-geodata/far_lod.py first' }, () => {
  const header = JSON.parse(fs.readFileSync(path.join(FAR_DIR, 'far.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(FAR_DIR, 'far.bin'));
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  assert.equal(header.version, 'cph-far/1');
  assert.equal(header.bytes, buf.byteLength);
  let total = 0;
  let expectEnd = 0;
  for (const [id, e] of Object.entries(header.tiles)) {
    assert.equal(e.off, expectEnd, `${id} blocks are contiguous`);
    expectEnd = e.off + e.len;
    assert.equal(readFarHeader(buf, e.off).count, e.n);
    const h = farHeights(buf, e.off);
    assert.ok(h.every((v) => v > -30 && v < 60), `${id} heights`);
    if (e.n) {
      const a = farTileArrays(buf, e.off, e.len);
      assert.equal(a.buildings, e.n);
      assert.ok(a.index.length > 0 && a.index.every((v) => v < a.position.length / 3));
      const b = tileBoundsLocal(id);
      // footprints sit in (or just beside) their tile; tops stay within a skyscraper
      for (let i = 0; i < a.position.length; i += 3) {
        assert.ok(a.position[i] > -150 && a.position[i] < b[2] - b[0] + 150, `${id} x`);
        assert.ok(a.position[i + 1] > -40 && a.position[i + 1] < 200, `${id} y`);
      }
      total += a.triangles;
    }
  }
  assert.equal(expectEnd, buf.byteLength);
  assert.ok(total > 0);
  for (const w of header.water) assert.ok(w.ring.length >= 6 && Number.isFinite(w.level));
});
