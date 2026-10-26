import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildRoadNetwork } from '../js/road-network.js';
import { buildCyclistNetwork, createCyclists, lanePoint } from '../js/cyclist-network.js';
import { bikePhase, vehiclePhase, walkPhase, signalOffset, CYCLE, GREEN, BIKE_LEAD } from '../js/signal-plan.js';

const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
const log = console.info;
console.info = () => {};
const network = buildRoadNetwork(geo.points.signals, { cph: true, roadGraph: geo.roadGraph });
console.info = log;

test('the road network builds from the roadGraph with at least 95% of vehicular links usable', () => {
  const s = network.stats;
  assert.equal(s.vehicularLinks, 2061);
  assert.ok(s.usableShare >= 0.95, `usable share ${s.usableShare}`);
  assert.ok(network.edges.length > 1500);
  for (const e of network.edges) {
    assert.ok(Number.isFinite(e.len) && e.len > 4, 'edges have a length');
    assert.ok(e.lanes.length >= 1 && e.lanes.length <= 4);
    assert.ok(e.half <= 14, `half width ${e.half}`);
    assert.ok(e.inArm && e.outArm && e.inSide >= 0, 'sides and arms are set');
  }
});

test('one-way roads carry one direction and every move leads to a lane that exists', () => {
  const ids = new Set(network.edges);
  for (const e of network.edges) {
    for (const m of e.moves) {
      assert.ok(ids.has(m.to), 'moves lead to kept edges');
      m.out.forEach((j) => assert.ok(j < m.to.lanes.length));
    }
  }
  const oneWay = network.edges.filter((e) => !e.from.in.some((f) => f.from === e.to));
  assert.ok(oneWay.length > 100, 'one-way edges have no reverse edge');
});

test('register signals are matched to junctions with three or more roads', () => {
  const signalled = network.nodes.filter((n) => n.signal);
  assert.ok(signalled.length >= 40, `${signalled.length} signalised junctions`);
  for (const n of signalled) assert.ok(n.arms.filter((a) => a.lead === a).length >= 3);
});

test('signal plans: cars and cross traffic never both green, bikes get an early green, pedestrians walk on the parallel green', () => {
  for (let t = 0; t < CYCLE; t += 0.5) {
    const a = vehiclePhase(7, 0, t);
    const b = vehiclePhase(7, 1, t);
    assert.ok(!(a !== 'red' && b !== 'red'), `both slots open at ${t}`);
    if (walkPhase(7, 0, t)) assert.equal(a, 'red', 'pedestrians cross group 0 only while it is red');
  }
  // the bike light turns green BIKE_LEAD seconds before the car light
  const start = (g) => { for (let t = 0; t < CYCLE; t += 0.25) if (vehiclePhase(0, g, t) === 'green' && vehiclePhase(0, g, t - 0.25) === 'red') return t; };
  const t0 = start(1);
  assert.equal(bikePhase(0, 1, t0 - BIKE_LEAD + 0.25), 'green');
  assert.equal(bikePhase(0, 1, t0 - BIKE_LEAD - 1), 'red');
  assert.equal(bikePhase(0, 1, t0 + GREEN + 1), 'red');
  assert.ok(signalOffset(1, 2) !== signalOffset(3, 4));
});

test('cyclists ride only on cycle lanes (tracks, paths, contraflow lanes), follow the lane geometry and nobody is stuck after 10 minutes', () => {
  const signals = network.nodes.filter((n) => n.signal).map((n) => ({ x: n.x, z: n.z, sigOffset: signalOffset(n.x, n.z), arms: n.arms }));
  const bikes = buildCyclistNetwork(geo, signals);
  assert.ok(bikes.stats.lengthKm > 50, 'a city-scale cycle network');
  assert.ok(bikes.lanes.every((l) => ['track', 'path', 'contra', 'shared'].includes(l.kind)));
  for (const name of ['Nørre Søgade', 'Dronning Louises Bro', 'Nørrebrogade']) {
    assert.ok(bikes.lanes.some((l) => l.name === name), `${name} has cycle lanes`);
  }
  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sim = createCyclists(bikes, { count: 80, random });
  const p = { x: 0, z: 0 };
  let ridden = 0;
  let maxWait = 0;
  let redStops = 0;
  for (let i = 0, t = 0; i < 20 * 600; i++) {
    t += 0.05;
    sim.update(0.05, t, null);
    if (i % 20) continue;
    for (const c of sim.riders) {
      if (!c.placed) continue;
      ridden++;
      assert.ok(['track', 'path', 'contra', 'shared'].includes(c.lane.kind));
      lanePoint(c.lane, c.s, p);
      assert.ok(Math.hypot(p.x - c.x, p.z - c.z) < 0.01, 'on the lane polyline');
      assert.ok(c.speed <= c.v0 + 0.5, `speed ${c.speed}`);
      maxWait = Math.max(maxWait, c.wait);
      if (c.wait > 5 && c.lane.signal) redStops++;
    }
  }
  assert.ok(ridden > 80 * 25, 'riders keep riding');
  assert.ok(maxWait < 150, `longest wait ${maxWait} s`);
  assert.ok(redStops > 0, 'cyclists stop at red lights');
});
