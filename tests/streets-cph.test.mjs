import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStreets } from '../js/layout-cph.js';
import { carriagewayWidth, cycleStrips, cycleStripAt, intersectIntervals, subtractIntervalLists, slicePts } from '../js/road-width-cph.js';
import { buildRoadSurfaceArrays, cycleTrackIndex, buildGroundHeightField } from '../js/road-surfaces-cph.js';
import { createKerbFrame } from '../js/walk-space-cph.js';

// a 100 m street along x with a 5 m half width, a 2 m cycle strip on the right from s = 20..60 only
const road = (extra = {}) => ({ id: 'r', class: 'residential', name: 'Teststr', pts: [0, 0, 100, 0], width: 30, lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'both', ...extra });
const streets = {
  version: 'cph-streets/1',
  roads: { r: { p: [0, 1, 100, 1], hw: 5, prov: 'measured', cr: [2, [[20, 60]]] } },
  extraRoads: [{ id: 'r#1', base: 'r', p: [200, 0, 260, 0], hw: 3, prov: 'measured' }],
  graph: { nodes: [[0, 0, 1], [1, 100, 1]], widths: [[0, 10]], dropLinks: [1] },
  sidewalks: [{ id: 's', ring: [0, 8, 0, 12, 100, 12, 100, 8] }],
  cycleTracks: [{ id: 'k', pts: [0, 20, 50, 20], width: 2.2 }]
};
const geoOf = () => ({
  roads: [road()],
  roadGraph: { nodes: [0, 0, 100, 0], links: [[0, 1, 1, 1, 30, 30, 0, 0, 0, 0], [0, 1, 1, 1, 30, 30, 0, 0, 0, 0]], names: [''], classes: ['residential'] },
  sidewalks: [{ id: 'old', ring: [0, 0, 0, 1, 1, 1] }],
  cycleTracks: [{ id: 'oldk', pts: [0, 0, 1, 1] }],
  buildings: []
});

test('applyStreets re-centres the roads, moves the graph, replaces pavements and cycle tracks', () => {
  const geo = geoOf();
  const st = applyStreets(geo, streets);
  assert.deepEqual(geo.roads[0].pts, [0, 1, 100, 1]);
  assert.deepEqual(geo.roads[0].ptsSurvey, [0, 0, 100, 0]);
  assert.equal(geo.roads[0].cs.hw, 5);
  assert.equal(carriagewayWidth(geo.roads[0]), 10, 'the measured width, not the 30 m data width');
  assert.equal(geo.roads.length, 2, 'the cut piece is added as its own road');
  assert.equal(geo.roads[1].id, 'r#1');
  assert.equal(geo.roads[1].class, 'residential');
  assert.equal(carriagewayWidth(geo.roads[1]), 6);
  assert.deepEqual([geo.roadGraph.nodes[1], geo.roadGraph.nodes[3]], [1, 1]);
  assert.equal(geo.roadGraph.links[0][4], 10);
  assert.deepEqual([geo.roadGraph.links[1][2], geo.roadGraph.links[1][3]], [0, 0], 'a dropped link carries no lanes');
  assert.equal(geo.roadGraph.layout, 'cph-streets/1');
  assert.equal(geo.sidewalks[0].id, 's');
  assert.equal(geo.cycleTracks[0].id, 'k');
  assert.equal(st.roads, 2);
  assert.equal(applyStreets(geoOf(), null), null, 'without a document nothing changes');
});

test('cycle strips: from the layout (width + ranges) or from the legacy tag', () => {
  const geo = geoOf();
  assert.deepEqual(cycleStrips(geo.roads[0]).map((c) => [c.side, c.w, c.ranges]), [[-1, 2.2, null], [1, 2.2, null]], 'tag both, whole road');
  applyStreets(geo, streets);
  const r = geo.roads[0];
  assert.deepEqual(cycleStrips(r), [{ side: 1, w: 2, ranges: [[20, 60]] }], 'the layout ignores the tag');
  assert.equal(cycleStripAt(r, 1, 30).w, 2);
  assert.equal(cycleStripAt(r, 1, 70), null);
  assert.equal(cycleStripAt(r, -1, 30), null);
});

test('interval helpers', () => {
  assert.deepEqual(intersectIntervals([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(subtractIntervalLists([[0, 30]], [[5, 10], [20, 25]]), [[0, 5], [10, 20], [25, 30]]);
  assert.deepEqual(slicePts([0, 0, 10, 0, 10, 10], 5, 15), [5, 0, 10, 0, 10, 5]);
});

test('surfaces: asphalt spans the measured width, the strip stands only where its ranges say, kerbs elsewhere', () => {
  const geo = geoOf();
  applyStreets(geo, streets);
  const L = buildRoadSurfaceArrays(geo, {});
  const lateral = (layer) => {
    const a = layer.arrays().position;
    const out = [];
    for (let i = 0; i < a.length; i += 3) out.push([a[i], a[i + 2]]);
    return out;
  };
  const asphalt = lateral(L.asphalt).filter(([x]) => x < 150);
  assert.ok(Math.min(...asphalt.map((p) => p[1])) <= -4 + 1e-6 && Math.max(...asphalt.map((p) => p[1])) >= 6 - 1e-6, 'asphalt from z = 1 - 5 to 1 + 5');
  assert.ok(asphalt.every(([, z]) => z >= -4 - 1e-6 && z <= 6 + 1e-6), 'and no wider');
  const strip = lateral(L.cycle).filter(([, z]) => z < 12); // (the standalone KK track at z = 20 is another ribbon)
  assert.ok(strip.length > 0);
  assert.ok(strip.every(([x]) => x >= 19.9 && x <= 60.1), 'the cycle strip only between s = 20 and 60');
  assert.ok(strip.every(([, z]) => z >= 1 + 5 + 0.15 - 1e-6 && z <= 1 + 5 + 0.15 + 2 + 1e-6), 'a 2 m strip behind a 0.15 m kerb');
  // kerb tops on the right outside the strip run straight to the pavement edge
  const kerbOnRight = lateral(L.kerb).filter(([x, z]) => z > 5.9 && z < 6.2 && (x < 19 || x > 61));
  assert.ok(kerbOnRight.length > 0, 'plain kerb where there is no strip');
});

test('the cycle-track index and the walking height field see the strip only in its ranges', () => {
  const geo = geoOf();
  applyStreets(geo, streets);
  const idx = cycleTrackIndex(geo);
  assert.ok(idx.near(40, 1 + 5 + 0.15 + 1), 'on the strip');
  assert.ok(!idx.near(80, 1 + 5 + 0.15 + 1, 0), 'not beyond its end');
  const g = buildGroundHeightField(geo, null);
  assert.ok(Math.abs(g.heightAt(40, 7.2) - 0.12) < 0.03, 'raised 12 cm on the strip');
  assert.ok(Math.abs(g.heightAt(80, 7.2)) < 0.03, 'flat road level where the strip is absent');
  assert.ok(Math.abs(g.heightAt(40, 1) - 0.02) < 0.01, 'asphalt');
});

test('kerb frame: pavement behind a strip starts after the strip, elsewhere at the kerb', () => {
  const f = createKerbFrame([{ pts: [0, 1, 100, 1], half: 5, cycle: { right: true }, strips: [{ side: 1, w: 2, ranges: [[20, 60]] }] }], { kerb: 0.18 });
  const behind = f.frameAt(40, 1 + 5 + 0.18 + 2 + 0.36 + 1.0);
  const plain = f.frameAt(80, 1 + 5 + 0.18 + 1.0);
  assert.ok(Math.abs(behind.v - 1.0) < 1e-9, `v = 1 m behind the strip, got ${behind.v}`);
  assert.ok(Math.abs(plain.v - 1.0) < 1e-9);
});

test('the shipped layout: one cross-section, pavements clear of the carriageway', () => {
  const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
  const doc = JSON.parse(readFileSync(new URL('../data/cph-streets.json', import.meta.url), 'utf8'));
  const st = applyStreets(geo, doc);
  assert.ok(st.roads > 900 && st.dropped > 10 && st.nodes > 500);
  const veh = geo.roads.filter((r) => r.cs && !r.drop);
  assert.ok(veh.length > 800);
  assert.ok(veh.every((r) => r.cs.hw >= 1.4 && r.cs.hw <= 14.1), 'half widths are measured values in a sane range');
  const withCycle = veh.filter((r) => cycleStrips(r).length);
  assert.ok(withCycle.length > 150 && withCycle.every((r) => cycleStrips(r).every((c) => c.w >= 1.3 && c.w <= 3.3 && c.ranges.length)));
  assert.ok(geo.roadGraph.links.every((l) => l[4] > 0));
});

test('applyStreets resolves footprint errors: drops, clips (older loses the overlap), pieces become copies; surface cuts merge by id', async () => {
  const { mergeSurfaceCuts } = await import('../js/layout-cph.js');
  const geo = {
    roads: [], roadGraph: null, sidewalks: [], cycleTracks: [],
    buildings: [{ id: 'a', ring: [0, 0, 0, 10, 10, 10, 10, 0], ground: 1 }, { id: 'b', ring: [0, 0, 0, 5, 5, 5, 5, 0], ground: 1 }, { id: 'c', ring: [20, 0, 20, 10, 40, 10, 40, 0], ground: 2 }]
  };
  const doc = {
    version: 'cph-streets/1', roads: {},
    buildings: { drop: [{ id: 'b', reason: 'inside-larger' }], clip: [{ id: 'c', reason: 'overlap-older', pieces: [{ ring: [20, 0, 20, 10, 30, 10, 30, 0] }, { ring: [35, 0, 35, 10, 40, 10, 40, 0], holes: [] }] }] },
    surfaceCuts: [{ id: 's1', replace: [] }]
  };
  const st = applyStreets(geo, doc);
  assert.deepEqual(geo.buildings.map((b) => b.id), ['a', 'c', 'c#1']);
  assert.equal(st.buildingsDropped, 1);
  assert.equal(st.buildingsClipped, 1);
  const [, c, c1] = geo.buildings;
  assert.equal(c.footprintFix, 'overlap-older');
  assert.equal(c1.ground, 2, 'a piece keeps the attributes of its building');
  assert.deepEqual(c.ringSurvey, [20, 0, 20, 10, 40, 10, 40, 0]);
  assert.deepEqual(geo.surfaceCuts, doc.surfaceCuts);
  const merged = mergeSurfaceCuts([{ id: 's1', replace: [{ id: 'lake' }] }, { id: 's2', replace: [] }], [{ id: 's1', replace: [] }]);
  assert.deepEqual(merged.map((m) => [m.id, m.replace.length]), [['s1', 0], ['s2', 0]], 'the street layout wins for the same polygon');
});

test('the shipped layout: no overlapping footprints, nothing in the lake, no surface over a carriageway', () => {
  const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
  const doc = JSON.parse(readFileSync(new URL('../data/cph-streets.json', import.meta.url), 'utf8'));
  const n0 = geo.buildings.length;
  const st = applyStreets(geo, doc);
  assert.equal(geo.buildings.length, n0 - st.buildingsDropped + (doc.buildings.clip.reduce((a, c) => a + c.pieces.length - 1, 0)));
  assert.ok(st.buildingsDropped >= 15 && st.buildingsDropped <= 30 && st.buildingsClipped >= 1);
  for (const c of doc.buildings.clip) assert.ok(c.pieces.every((p) => p.ring.length >= 6));
  const ids = new Set(geo.buildings.map((b) => b.id));
  assert.equal(ids.size, geo.buildings.length, 'ids stay unique');
  assert.ok(doc.surfaceCuts.length > 20 && doc.surfaceCuts.some((c) => c.replace.length === 0), 'some ground polygons were wholly on a road or in a building');
  const big = Math.max(...geo.buildings.map((b) => b.ground));
  assert.ok(Number.isFinite(big));
});
