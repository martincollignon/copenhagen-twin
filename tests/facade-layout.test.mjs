import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWindows, measuredEdges, layoutWords, snapToBay, layoutOpenings, LAYOUT_FORMAT } from '../js/facade-layout.js';
import { mapObservedEdges } from '../js/appearance.js';
import { cleanRing } from '../js/building-geometry.js';

const lay = { u0: 0.5, p: 2, n: 4, w: 1.1, cm: 0b1101, g: 4, f: 3, rows: 2, sill: 0.9, head: 2.4, gm: 0b0011, conf: 0.8 };
const building = (layout) => ({
  id: 'gdk:1', ring: [0, 0, 10, 0, 10, -6, 0, -6], holes: [], ground: 0, eave: 12,
  observed: { walls: [{ ring: 0, edge: 0, tone: [0.7, 0.6, 0.5], conf: 'observed' }], atlas: { walls: [{ ring: 0, edge: 0, len_m: 10 }] }, layout }
});
const rings = (b) => [cleanRing(b.ring, true)];

test('applyWindows puts a tile layer on the observed records and ignores other formats', () => {
  const b = { id: 'gdk:1', observed: { walls: [] } };
  const plain = { id: 'gdk:2' };
  applyWindows([b, plain], { format: 'other', buildings: { 'gdk:1': { '0:0': lay } } });
  assert.equal(b.observed.layout, undefined);
  applyWindows([b, plain], { format: LAYOUT_FORMAT, buildings: { 'gdk:1': { '0:0': lay }, 'gdk:2': { '0:0': lay } } });
  assert.deepEqual(b.observed.layout, { '0:0': lay });
  assert.equal(plain.observed, undefined, 'no observed block: nothing to attach to');
});

test('measuredEdges maps a strip onto its cleaned edge, mirrored when the cleaned edge runs the other way', () => {
  const b = building({ '0:0': lay });
  const r = rings(b);
  const m = measuredEdges(b, r, mapObservedEdges(b, r));
  const k = m.findIndex(Boolean);
  assert.ok(k >= 0, 'one measured edge');
  assert.equal(m.filter(Boolean).length, 1);
  const e = m[k];
  const [p0, p1] = [r[0][k], r[0][(k + 1) % r[0].length]];
  const forward = p0[0] < p1[0] || (p0[0] === p1[0] && p0[1] < p1[1]);
  // the raw edge runs from x = 0 to x = 10 along z = 0; the cleaned edge may start at either end
  if (Math.abs(p0[0]) < 1e-9 && Math.abs(p1[0] - 10) < 1e-9) {
    assert.ok(forward);
    assert.equal(e.u0, 0.5); assert.equal(e.cm, 0b1101); assert.equal(e.gm, 0b0011);
  } else {
    assert.ok(Math.abs(e.u0 - (10 - (0.5 + 4 * 2))) < 1e-9, 'mirrored grid start');
    assert.equal(e.cm, 0b1011); assert.equal(e.gm, 0b1100);
  }
  assert.equal(e.p, 2); assert.equal(e.n, 4);
});

test('layoutWords: every word is an integer <= 65535 except the grid start; unmeasured walls get zeros and all bays open', () => {
  assert.deepEqual(layoutWords(null), { top: [0, 0, 0], uv: [0, 0], ground: 65535 });
  const m = { u0: 1.25, p: 2, n: 40, w: 1, cm: 2 ** 40 - 1 - 2 ** 3 - 2 ** 20, gm: 0b101, nGround: 16, g: 4, f: 3, rows: 5, sill: 0.9, head: 3.5 };
  const w = layoutWords(m);
  assert.equal(w.top[0], 1.25);
  for (const v of [w.top[1], w.top[2], w.uv[0], w.uv[1], w.ground]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 65535, String(v));
  const sillQ = w.top[1] % 256, headQ = Math.floor(w.top[1] / 256);
  assert.equal(sillQ, Math.round(0.9 / 3 * 255));
  assert.ok(headQ <= Math.round(0.97 * 255) && headQ > sillQ, 'head clamped below the next storey');
  assert.equal(w.top[2] % 64, 5); assert.equal(Math.floor(w.top[2] / 64), 40);
  assert.equal(w.uv[0], 65535 - 2 ** 3); assert.equal(w.uv[1], 65535 - 2 ** 4);
  assert.equal(w.ground, 0b101);
});

test('snapToBay moves a door to the nearest measured bay centre within reach', () => {
  const m = { u0: 0.5, p: 2, n: 4 };
  assert.deepEqual(snapToBay(m, 3.2), { u: 3.5, bay: 1 });
  assert.equal(snapToBay(m, 12), null);
  assert.equal(snapToBay(null, 1), null);
});

test('layoutOpenings lists the windows the shader draws', () => {
  const o = layoutOpenings({ ...lay, cm: 0b0101 });
  assert.equal(o.length, 4); // 2 columns x 2 rows
  assert.deepEqual(o[0].u.map((x) => +x.toFixed(2)), [0.95, 2.05]);
  assert.deepEqual(o[0].v.map((x) => +x.toFixed(2)), [4.9, 6.4]);
});
