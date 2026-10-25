import assert from 'node:assert/strict';
import test from 'node:test';
import { mapObservedEdges, roofSurface, texturedWalls, describeAppearance, wallSource, srgbToLinear, albedoFromLinear, setCalibration, wallRgb } from '../js/appearance.js';
import { createAccumulator, addBuilding, cleanRing } from '../js/building-geometry.js';
import { loadLod2, parseLod2Record, lod2RoofTriangles, roofFragmentMask } from '../js/lod2-geometry.js';

const lin = (c) => c.map(srgbToLinear);
const alb = (c) => c.map((v) => albedoFromLinear(srgbToLinear(v))); // observed wall tones are shown as albedo
const r5 = (a) => a.map((v) => +v.toFixed(5));
// 20 x 10 block (CCW seen from above in x / -z), ground 0, eave 9; a collinear vertex splits the south wall into two raw edges
const RING = [0, 0, 8, 0, 20, 0, 20, -10, 0, -10];
const HOLE = [5, -3, 5, -7, 9, -7, 9, -3]; // CW
const RED = [0.7, 0.2, 0.1];
const BLUE = [0.1, 0.2, 0.7];
const GREEN = [0.1, 0.7, 0.2];
const wall = (ring, edge, tone, extra = {}) => ({ ring, edge, tone, conf: 'observed', views: ['east_2025_x'], sunlit: true, year: 2025, ...extra });
const building = (extra = {}) => ({
  id: 'gdk:9', ring: RING, holes: [HOLE], ground: 0, eave: 9, ridge: 9.2, roof: 'flat', roof_material: 'tagpap', wall_material: 'mursten',
  facade: { floor_h: 3, ground_floor_h: 3.5, window_w: 1.2, bay_w: 4, ground_type: 'residential', tone: [0.5, 0.5, 0.5] },
  observed: {
    walls: [
      wall(0, 0, RED), wall(0, 1, GREEN), // the two collinear south raw edges: 8 m and 12 m, the longer one wins
      wall(0, 2, BLUE), wall(0, 3, [0.2, 0.2, 0.2]), wall(0, 4, [0.9, 0.9, 0.9]),
      wall('hole_0', 0, [0.3, 0.6, 0.3], { conf: 'inferred', fallback: 'building', year: undefined })
    ],
    roof: { tone: [0.3, 0.3, 0.32], conf: 'observed', type_hint: 'tagpap', year: 2025, sunlit: true }
  },
  ...extra
});
const rings = (b) => [cleanRing(b.ring, true), ...(b.holes || []).map((h) => cleanRing(h, false))];

test('edge to tone: raw edges merged by cleanRing map to the longest raw edge, holes keep their own key', () => {
  const b = building();
  const rs = rings(b);
  assert.equal(rs[0].length, 4, 'collinear vertex merged');
  const m = mapObservedEdges(b, rs);
  assert.equal(m.edges.length, 8);
  assert.deepEqual(m.edges[0].tone, alb(GREEN), 'south = longer 12 m raw edge');
  assert.deepEqual(m.edges[1].tone, alb(BLUE));
  assert.deepEqual(m.edges[2].tone, alb([0.2, 0.2, 0.2]));
  assert.deepEqual(m.edges[3].tone, alb([0.9, 0.9, 0.9]));
  // hole edge 0 is the inferred fallback tone, other hole edges have no entry and take the building median
  assert.deepEqual(m.edges[4].tone, alb([0.3, 0.6, 0.3]));
  assert.equal(m.edges[4].wall.conf, 'inferred');
  assert.deepEqual(m.edges[5].tone, m.buildingTone);
});

test('edge to tone survives a reversed ring (raw CW outer ring) without shifting colours to a neighbour', () => {
  const b = building({ holes: [], ring: [0, 0, 0, -10, 20, -10, 20, 0], observed: { walls: [wall(0, 0, RED), wall(0, 1, GREEN), wall(0, 2, BLUE), wall(0, 3, [0.2, 0.2, 0.2])] } });
  const rs = [cleanRing(b.ring, true)];
  const m = mapObservedEdges(b, rs);
  const lineOf = (x0, z0, x1, z1) => [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)].join(',');
  const rawTone = new Map([[lineOf(0, 0, 0, -10), RED], [lineOf(0, -10, 20, -10), GREEN], [lineOf(20, -10, 20, 0), BLUE], [lineOf(20, 0, 0, 0), [0.2, 0.2, 0.2]]]);
  rs[0].forEach((p, i) => {
    const q = rs[0][(i + 1) % rs[0].length];
    assert.deepEqual(m.edges[i].tone, alb(rawTone.get(lineOf(p[0], p[1], q[0], q[1]))), `edge ${i}`);
    assert.equal(m.edges[i].flip, true);
  });
});

test('edge to tone: a hole dropped by cleanRing does not shift the following holes', () => {
  const tiny = [1, -1, 1, -1.02, 1.02, -1.02]; // collapses to nothing
  const b = building({ holes: [tiny, HOLE], observed: { walls: [wall(0, 0, RED), wall(0, 1, GREEN), wall(0, 2, BLUE), wall(0, 3, RED), wall('hole_1', 2, [0.6, 0.6, 0.1])] } });
  const rs = [cleanRing(b.ring, true), ...b.holes.map((h) => cleanRing(h, false)).filter(Boolean)];
  const m = mapObservedEdges(b, rs);
  // HOLE edge 2 runs (9,-7) -> (9,-3): cleaned hole edge 2 sits at flat index 4 + 2
  assert.deepEqual(m.edges[4 + 2].tone, alb([0.6, 0.6, 0.1]));
});

test('addBuilding writes the observed tone per wall vertex, window ratio untouched', () => {
  const b = building();
  const acc = createAccumulator();
  addBuilding(acc, b);
  const tone = acc.wall.facadeTone;
  assert.deepEqual(r5(tone.slice(0, 3)), r5(alb(GREEN)));
  assert.ok(tone[3] > 0.12 && tone[3] < 0.85);
  const off = createAccumulator();
  addBuilding(off, b, { observed: false });
  assert.deepEqual(r5(off.wall.facadeTone.slice(0, 3)), r5(lin([0.5, 0.5, 0.5])));
});

// LoD2: the truncated wall (gable) pieces above the eave carry the tone of their own edge
const names = ['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd', 'r0', 'r1'];
const P = { A: [0, 0, 0], B: [10, 0, 0], C: [10, 0, -6], D: [0, 0, -6], a: [0, 4, 0], b: [10, 4, 0], c: [10, 4, -6], d: [0, 4, -6], r0: [0, 6, -3], r1: [10, 6, -3] };
function pack(tris, kinds, edges, pts = P, order = names) {
  const nV = order.length, nT = tris.length, nE = 4;
  const buf = new ArrayBuffer(18 + 6 * nV + 6 * nT + nT + 2 * nT + 2 * nE + 4);
  const v = new DataView(buf);
  v.setFloat32(0, 5, true); v.setFloat32(4, 0, true); v.setFloat32(8, -3, true);
  v.setUint16(12, nV, true); v.setUint16(14, nT, true); v.setUint16(16, nE, true);
  let o = 18;
  for (const n of order) { v.setInt16(o, Math.round((pts[n][0] - 5) * 100), true); v.setInt16(o + 2, Math.round(pts[n][1] * 100), true); v.setInt16(o + 4, Math.round((pts[n][2] + 3) * 100), true); o += 6; }
  for (const t of tris) for (const n of t) { v.setUint16(o, order.indexOf(n), true); o += 2; }
  for (const k of kinds) { v.setUint8(o++, k); }
  for (const e of edges) { v.setInt16(o, e, true); o += 2; }
  for (let i = 0; i < nE; i++) { v.setInt16(o, 400, true); o += 2; }
  return buf;
}

test('LoD2 truncated walls: gable pieces take the tone of their own edge', () => {
  const ring = [0, 0, 10, 0, 10, -6, 0, -6];
  const b = {
    id: 'gdk:1', ring, ground: 0, eave: 4, ridge: 6, roof: 'flat', roof_material: 'tegl', facade: { tone: [0.5, 0.5, 0.5], floor_h: 3, ground_floor_h: 3 },
    observed: { walls: [wall(0, 0, RED), wall(0, 1, GREEN), wall(0, 2, BLUE), wall(0, 3, [0.9, 0.9, 0.2])] }
  };
  const tris = [[['B', 'C', 'c'], 1, 1], [['B', 'c', 'r1'], 1, 1], [['B', 'r1', 'b'], 1, 1], [['a', 'b', 'r1'], 0, -1], [['a', 'r1', 'r0'], 0, -1]];
  const rec = parseLod2Record(pack(tris.map((t) => t[0]), tris.map((t) => t[1]), tris.map((t) => t[2])));
  const acc = createAccumulator();
  addBuilding(acc, b, { lod2: rec });
  const nv = acc.wall.position.length / 3;
  assert.ok(nv > 16, 'gable piece present');
  const t = acc.wall.facadeTone;
  for (let k = 16; k < nv; k++) assert.deepEqual(r5([t[4 * k], t[4 * k + 1], t[4 * k + 2]]), r5(alb(GREEN)));
});

test('roof surface by type hint, observed tone feeds the roof colour', () => {
  const b = building();
  assert.equal(roofSurface(b).hint, 'tagpap');
  assert.ok(roofSurface(b).rough > 0.9);
  assert.ok(roofSurface({ ...b, observed: { roof: { conf: 'observed', tone: [0.5, 0.5, 0.5], type_hint: 'metal' } } }).metal > 0.3);
  assert.equal(roofSurface({ roof_material: 'tegl' }).hint, 'tile', 'unobserved roofs derive from BBR');
  const acc = createAccumulator();
  addBuilding(acc, b);
  assert.deepEqual(r5(acc.roof.color.slice(0, 3)), r5(lin([0.3, 0.3, 0.32])));
  assert.equal(acc.roof.mat.length / 2, acc.roof.position.length / 3);
});

test('LoD2 fragment filter drops small disconnected pieces and slivers, keeps the main roof', () => {
  const Q = { ...P, f0: [30, 5, 0], f1: [31, 5, 0], f2: [30, 5, 1], s0: [40, 5, 0], s1: [60, 5, 0], s2: [50, 5, 0.1] };
  const all = [...names, 'f0', 'f1', 'f2', 's0', 's1', 's2'];
  const tris = [['a', 'b', 'r1'], ['a', 'r1', 'r0'], ['d', 'r0', 'r1'], ['d', 'r1', 'c'], ['f0', 'f1', 'f2'], ['s0', 's1', 's2']];
  const rec = parseLod2Record(pack(tris, tris.map(() => 0), tris.map(() => -1), Q, all));
  assert.equal(lod2RoofTriangles(rec, { filter: false }).length, 6);
  assert.equal(lod2RoofTriangles(rec).length, 4, 'the 0.5 m2 fragment and the 20 m x 0.1 m sliver are gone');
  const mask = roofFragmentMask(rec);
  assert.equal(mask.pieces, 3);
  assert.equal(mask.dropped, 2);
});

test('fragment filter never removes the only roof piece', () => {
  const rec = parseLod2Record(pack([['a', 'b', 'r1']], [0], [-1]));
  assert.equal(lod2RoofTriangles(rec).length, 1);
});

test('photo walls: usable strips only, hole rings and inferred walls excluded, uv spans the raw edge', () => {
  const b = building();
  b.observed.atlas = {
    file: 'tex/gdk_9.jpg', size: [100, 400],
    walls: [
      { edge: 0, ring: 0, len_m: 8, h_m: 9, filled_frac: 0.2, uv: [0, 0, 0.5, 0.5] },
      { edge: 1, ring: 0, len_m: 12, h_m: 9, filled_frac: 0.2, uv: [0, 0.5, 1, 1] },
      { edge: 2, ring: 0, len_m: 10, h_m: 9, filled_frac: 0.95, uv: [0, 0, 1, 1] }, // mostly inpainted -> tone
      { edge: 0, ring: 'hole_0', len_m: 4, h_m: 9, filled_frac: 0.1, uv: [0, 0, 1, 1] } // inferred wall -> tone
    ]
  };
  const quads = [];
  const added = addBuilding(createAccumulator(), b, { quads });
  const w = texturedWalls(b, quads, added.mapping);
  assert.equal(w.count, 1, 'only the south raw edge 1 (12 m, longest) is photographed');
  const vs = w.uv.filter((_, i) => i % 2 === 1);
  assert.ok(vs.includes(1) && vs.includes(0.5));
  const xs = w.position.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.min(...xs) - 8) < 1e-6 && Math.abs(Math.max(...xs) - 20) < 1e-6);
  assert.ok(Math.abs(w.normal[0]) < 1e-9 && w.normal[1] === 0 && Math.abs(w.normal[2] - 1) < 1e-9, 'south wall faces +z');
  for (let k = 0; k < w.index.length; k += 3) { // winding agrees with the outward normal
    const p = (i) => w.position.slice(3 * w.index[k + i], 3 * w.index[k + i] + 3);
    const [a, c, d] = [p(0), p(1), p(2)];
    const u = c.map((v, j) => v - a[j]);
    const v = d.map((q, j) => q - a[j]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(n[2] > 0, 'front face points out');
  }
});

test('info panel source labels and nearest-wall lookup (holes included)', () => {
  assert.equal(wallSource(wall(0, 0, RED)).text, 'observed 2025, sunlit');
  assert.equal(wallSource(wall(0, 0, RED, { sunlit: false, year: 2023 })).text, 'observed 2023, shadow, white-balanced');
  assert.equal(wallSource(wall(0, 0, RED, { conf: 'observed+prior', sunlit: false })).kind, 'prior');
  assert.match(wallSource({ conf: 'inferred', fallback: 'neighbours' }).text, /inferred from neighbouring buildings/);
  assert.match(wallSource(wall(0, 0, RED, { flags: ['year_disagree'] })).flags[0], /repainted/);
  const d = describeAppearance(building(), 'wall', { x: 19.9, z: -5 });
  assert.equal(d.wall.edge, 'edge 2');
  assert.deepEqual(d.wall.tone, BLUE);
  const inHole = describeAppearance(building(), 'wall', { x: 5.1, z: -5 });
  assert.equal(inHole.wall.kind, 'inferred');
  assert.match(describeAppearance(building(), 'roof', null).roof.text, /observed 2025 sunlit, tagpap/);
});

test('graceful without data/tex: no atlas -> no photo candidates; missing LoD2/tex fetches resolve to null, not throw', async () => {
  const b = building();
  const quads = [];
  const added = addBuilding(createAccumulator(), b, { quads });
  assert.equal(texturedWalls(b, quads, added.mapping), null);
  assert.equal(await loadLod2('./data/none', async () => { throw new Error('offline'); }), null);
});

test('albedo: monotonic, scaled below the knee, never pure white', () => {
  let prev = -1;
  for (let v = 0; v <= 1.0001; v += 0.05) {
    const a = albedoFromLinear(v);
    assert.ok(a >= prev);
    prev = a;
  }
  assert.ok(Math.abs(albedoFromLinear(0.2) - 0.2 * 0.84) < 1e-9);
  assert.ok(albedoFromLinear(1) < 0.7);
});

test('calibrated tone_cal is used when present and ?debug=nocal restores the raw tone', () => {
  const w = { tone: [0.5, 0.5, 0.5], tone_cal: [0.6, 0.5, 0.4] };
  assert.deepEqual(wallRgb(w), [0.6, 0.5, 0.4]);
  setCalibration(false);
  assert.deepEqual(wallRgb(w), [0.5, 0.5, 0.5]);
  setCalibration(true);
  assert.deepEqual(wallRgb({ tone: [0.1, 0.2, 0.3] }), [0.1, 0.2, 0.3]);
});
