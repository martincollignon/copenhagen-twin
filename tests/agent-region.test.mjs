import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLinkIndex, subGraph, createLaneIndex, createAgentRegion, polylineNear } from '../js/agent-region.js';
import { buildRoadNetwork } from '../js/road-network.js';
import { ROOT, TILES } from './helpers/district-tiles.mjs';

// a grid of streets: nodes every 100 m on a 21 x 21 lattice around the origin, links between neighbours
function gridGraph(n = 21, step = 100) {
  const nodes = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.push((i - (n - 1) / 2) * step, (j - (n - 1) / 2) * step);
  const links = [];
  const at = (i, j) => j * n + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i + 1 < n) links.push([at(i, j), at(i + 1, j), 1, 1, 8, 50, 1, 2, 0, 0]);
      if (j + 1 < n) links.push([at(i, j), at(i, j + 1), 1, 1, 8, 50, 1, 2, 0, 0]);
    }
  }
  return { nodes, links, names: ['', 'Gade'], classes: ['primary', 'secondary', 'residential', 'service', 'cycleway', 'footway'] };
}

test('link index and sub-graph: only the links inside the circle, renumbered, nodes shared', () => {
  const g = gridGraph();
  const idx = createLinkIndex(g);
  const near = idx.near(0, 0, 250);
  for (const i of near) {
    const l = g.links[i];
    const mx = (g.nodes[2 * l[0]] + g.nodes[2 * l[1]]) / 2;
    const mz = (g.nodes[2 * l[0] + 1] + g.nodes[2 * l[1] + 1]) / 2;
    assert.ok(Math.hypot(mx, mz) <= 250);
  }
  // everything inside is found: brute force
  const brute = g.links.filter((l) => Math.hypot((g.nodes[2 * l[0]] + g.nodes[2 * l[1]]) / 2, (g.nodes[2 * l[0] + 1] + g.nodes[2 * l[1] + 1]) / 2) <= 250).length;
  assert.equal(near.length, brute);
  const sub = subGraph(g, idx, 0, 0, 250);
  assert.equal(sub.links.length, brute);
  assert.ok(sub.nodes.length / 2 < g.nodes.length / 2);
  for (const l of sub.links) { assert.ok(l[0] < sub.nodes.length / 2 && l[1] < sub.nodes.length / 2); assert.equal(l.length, 10); }
  // a sub-graph drives: the road network builds from it
  const log = console.info; console.info = () => {};
  const net = buildRoadNetwork([], { roadGraph: sub, walkable: () => true, onSidewalk: () => true, blockAt: () => ({ id: 'x', poly: [] }) });
  console.info = log;
  assert.ok(net.edges.length > 10, `${net.edges.length} edges`);
});

test('lane index: finds real tracks within r, ignores lanes without a source', () => {
  const idx = createLaneIndex([{ pts: [0, 0, 100, 0], src: 'kk:1' }, { pts: [0, 50, 100, 50] }]);
  assert.equal(idx.near(50, 1.2, 1.6), true);
  assert.equal(idx.near(50, 3, 1.6), false);
  assert.equal(idx.near(50, 50, 5), false, 'a lane without src does not count');
  assert.equal(idx.near(130, 0, 20), false);
  assert.equal(idx.near(104, 3, 5), true, 'beyond the end, within r of the end point');
});

test('polylineNear: bounding box within r of a point', () => {
  assert.equal(polylineNear([0, 0, 10, 0], 5, 5, 6), true);
  assert.equal(polylineNear([0, 0, 10, 0], 5, 50, 6), false);
  assert.equal(polylineNear(null, 0, 0, 5), false);
});

test('agent region: waits for the tiles, rebuilds past the drift, in stages one per update', () => {
  const g = gridGraph();
  let clock = 0;
  const log = [];
  const held = new Set(['a']);
  const region = createAgentRegion({
    roadGraph: g, radius: 250, drift: 90, minInterval: 1000, now: () => clock,
    tilesAround: (x) => (x < 500 ? ['a'] : ['b']),
    roadsOf: () => ({ roads: [], cycleTracks: [], signals: [] }),
    ready: (id) => held.has(id),
    stages: {
      network: (sub) => { log.push(`network:${sub.links.length}`); return { edges: [1, 2, 3] }; },
      cyclists: () => { log.push('cyclists'); return { lanes: [1] }; },
      apply: (ctx) => log.push(`apply@${ctx.cx}`)
    }
  });
  // first update starts the job; one stage per update
  assert.equal(region.update(0, 0), false);
  assert.equal(region.building, true);
  assert.deepEqual(log, []);
  region.update(0, 0); assert.deepEqual(log.map((l) => l.split(':')[0]), []); // the graph stage runs on the first step...
  for (let i = 0; i < 6; i++) region.update(0, 0);
  assert.deepEqual(log.map((l) => l.split(':')[0]), ['network', 'cyclists', 'apply@0']);
  assert.ok(region.region && region.region.cx === 0);
  assert.equal(region.stats.builds, 1);
  // within the drift: nothing happens
  clock = 5000;
  region.update(60, 0);
  assert.equal(region.building, false);
  // past the drift: a rebuild, but not before the minimum interval
  region.update(100, 0);
  assert.equal(region.building, true);
  for (let i = 0; i < 8; i++) region.update(100, 0);
  assert.equal(region.region.cx, 100);
  assert.equal(region.stats.builds, 2);
  // a jump to tiles that are not in memory yet: it waits, then builds
  clock = 6000;
  region.update(900, 0);
  assert.equal(region.building, false);
  assert.ok(region.stats.waiting >= 1);
  held.add('b');
  for (let i = 0; i < 8; i++) region.update(900, 0);
  assert.equal(region.region.cx, 900);
  assert.equal(region.stats.jumps, 1);
});

test('agent region: buildNow builds every stage at once', () => {
  const g = gridGraph();
  const seen = [];
  const region = createAgentRegion({
    roadGraph: g, tilesAround: () => [], roadsOf: () => ({ roads: [], cycleTracks: [], signals: [] }), ready: () => true,
    stages: { network: () => ({ edges: [] }), cyclists: () => ({ lanes: [] }), apply: (ctx) => seen.push(ctx.cx) }
  });
  region.buildNow(40, -20);
  assert.deepEqual(seen, [40]);
  assert.equal(region.region.cz, -20);
});

// the citywide graph: a region of it is a small graph, and building a network from it takes a few ms, not seconds
const CITY = path.join(ROOT, 'data/city/roadgraph.json');
test('citywide road graph: a 560 m region is a small network built in well under a second', { skip: !fs.existsSync(CITY) && 'no data/city/roadgraph.json' }, () => {
  const g = JSON.parse(fs.readFileSync(CITY, 'utf8'));
  if (g.links.length < 50000) return; // only meaningful for the citywide graph
  const idx = createLinkIndex(g);
  const t0 = performance.now();
  const sub = subGraph(g, idx, 450, 700, 560);
  const t1 = performance.now();
  const log = console.info; console.info = () => {};
  const net = buildRoadNetwork([], { roadGraph: sub, walkable: () => true, onSidewalk: () => true, blockAt: () => ({ id: 'x', poly: [] }) });
  console.info = log;
  const t2 = performance.now();
  assert.ok(sub.links.length < g.links.length / 20, `${sub.links.length} of ${g.links.length}`);
  assert.ok(net.edges.length > 100);
  assert.ok(t1 - t0 < 100 && t2 - t1 < 1500, `subGraph ${(t1 - t0).toFixed(0)} ms, network ${(t2 - t1).toFixed(0)} ms`);
});
