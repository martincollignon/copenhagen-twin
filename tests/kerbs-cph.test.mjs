// Kerbs stand between a carriageway and what is beside it, never inside a carriageway ("kerbs in the middle of the car
// streets"): side streets at a through road's interior vertex, dual carriageways / overlapping roads, tight bends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyStreets } from '../js/layout-cph.js';
import { buildRoadSurfaceArrays } from '../js/road-surfaces-cph.js';
import { slicePts, rightNormals } from '../js/road-width-cph.js';
import { kerbIntrusions, classify } from '../tools/audit/kerbs-lib.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const realGeo = () => {
  const geo = read('../data/cph-geodata.json');
  applyStreets(geo, read('../data/cph-streets.json'));
  return geo;
};
const mk = (id, cls, pts, extra = {}) => ({ id, name: id, class: cls, pts, width: 8, lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'none', ...extra });
const kerbsOf = (geo, opts = {}) => buildRoadSurfaceArrays(geo, { pavement: true, ...opts }).kerb.runs;

test('real district: no kerb sample lies more than 0.3 m inside a carriageway', () => {
  const geo = realGeo();
  const unclipped = kerbIntrusions(geo, kerbsOf(geo, { clipKerbs: false }), { depth: 0.3 });
  assert.ok(unclipped.length > 1000, `the audit sees the old mid-road kerbs (${unclipped.length})`);
  const geo2 = realGeo();
  const hits = kerbIntrusions(geo2, kerbsOf(geo2), { depth: 0.3 });
  const where = hits.slice(0, 5).map((h) => `${classify(h)} ${h.owner.name || h.owner.id} in ${h.into.name || h.into.id} at ${h.x.toFixed(1)},${h.z.toFixed(1)}`);
  assert.equal(hits.length, 0, `kerbs inside carriageways: ${where.join('; ')}`);
});

test('real district: the kerbs along the streets are kept (at most 8% of the length is cut)', () => {
  const len = (runs) => runs.reduce((s, r) => { for (let i = 0; i + 3 < r.pts.length; i += 2) s += Math.hypot(r.pts[i + 2] - r.pts[i], r.pts[i + 3] - r.pts[i + 1]); return s; }, 0);
  const before = len(kerbsOf(realGeo(), { clipKerbs: false }));
  const after = len(kerbsOf(realGeo()));
  assert.ok(after > before * 0.92 && after < before, `${after.toFixed(0)} of ${before.toFixed(0)} m`);
});

test('a side street at an interior vertex of a through road stops its kerbs at the through road edge', () => {
  const geo = { roads: [mk('main', 'secondary', [-120, 0, 0, 0, 120, 0]), mk('side', 'residential', [0, 0, 0, 80])], cycleTracks: [], sidewalks: [], buildings: [] };
  assert.ok(kerbIntrusions(geo, kerbsOf(geo, { clipKerbs: false })).length > 0, 'unclipped: the side street kerbs reach the centreline');
  const runs = kerbsOf(geo);
  assert.equal(kerbIntrusions(geo, runs, { depth: 0.05 }).length, 0);
  // the side street keeps its kerbs away from the junction
  const side = runs.filter((r) => r.road.id === 'side' && r.kind === 'plain');
  assert.equal(side.length, 2);
  for (const r of side) assert.ok(Math.min(r.pts[1], r.pts[r.pts.length - 1]) > 3.8 && Math.max(r.pts[1], r.pts[r.pts.length - 1]) > 79, 'from the main road edge to the end');
});

test('dual carriageways: overlapping halves lose their median kerbs, a real island keeps them', () => {
  const pair = (gap) => ({
    roads: [
      mk('a', 'secondary', [-100, -gap / 2 - 3, 100, -gap / 2 - 3], { oneway: true, lanesBack: 0, cs: { hw: 3 } }),
      mk('b', 'secondary', [100, gap / 2 + 3, -100, gap / 2 + 3], { oneway: true, lanesBack: 0, cs: { hw: 3 } })
    ],
    cycleTracks: [], sidewalks: [], buildings: []
  });
  // a runs east on the north half, b west on the south half: the median is on the right (side +1) of both
  const medianKerbs = (geo) => kerbsOf(geo).filter((r) => r.kind === 'plain' && r.side === 1);
  // 2 m apart: the carriageways overlap by 4 m, no island
  const merged = pair(-4);
  assert.equal(kerbIntrusions(merged, kerbsOf(merged), { depth: 0.05 }).length, 0);
  assert.equal(medianKerbs(merged).length, 0, 'no kerb between overlapping halves');
  // a 1.5 m raised median between them: both median kerbs stand along the whole length
  const island = pair(1.5);
  const m = medianKerbs(island);
  assert.equal(m.length, 2);
  for (const r of m) assert.ok(Math.abs(r.pts[0] - r.pts[r.pts.length - 2]) > 199, 'full length');
});

test('slices and normals: no zero-length piece, no zero normal at a repeated point', () => {
  const q = slicePts([0, 0, 10, 0, 10, 10], 10, 15);
  for (let i = 0; i + 3 < q.length; i += 2) assert.ok(Math.hypot(q[i + 2] - q[i], q[i + 3] - q[i + 1]) > 1e-3);
  const n = rightNormals([0, 0, 0, 0, 10, 0]);
  for (const v of n) assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-9, 'unit normal');
});
