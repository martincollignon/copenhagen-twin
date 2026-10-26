import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildRoadNetwork } from '../js/road-network.js';
import { buildCyclistNetwork, createCyclists } from '../js/cyclist-network.js';
import { alongRoad, bikeCarriageway, carDirection, hasContraflow, stripDirection } from '../js/bike-direction.js';
import { applyStreets } from '../js/layout-cph.js';
import { bikeCheck, buildRoadIndex, edgeCheck, laneRule } from '../tools/audit/oneway-check.mjs';

// ---- the bike-direction helpers ------------------------------------------------------------------------------------------
test('strip direction defaults follow right-hand traffic and the data overrides it', () => {
  const twoWay = { class: 'secondary', pts: [0, 0, 50, 0] };
  assert.equal(stripDirection(twoWay, 1), 'fwd');
  assert.equal(stripDirection(twoWay, -1), 'back');
  const oneWay = { class: 'residential', oneway: true, pts: [0, 0, 50, 0] };
  assert.equal(carDirection(oneWay), 'fwd');
  assert.equal(stripDirection(oneWay, 1), 'fwd');
  assert.equal(stripDirection(oneWay, -1), 'fwd', 'the left track of a one-way street runs with the cars');
  assert.equal(stripDirection({ ...oneWay, bike: { left: 'back', right: 'fwd' } }, -1), 'back');
  assert.equal(stripDirection({ ...twoWay, bike: { left: 'both' } }, -1), 'both');
  assert.equal(bikeCarriageway(oneWay), 'fwd');
  assert.equal(bikeCarriageway({ ...oneWay, bike: { carriageway: 'both', contraflow: true } }), 'both');
  assert.ok(hasContraflow({ ...oneWay, carDir: 'fwd', bike: { contraflow: true } }));
  assert.ok(!hasContraflow({ ...twoWay, bike: { contraflow: true } }), 'a two-way street has nothing to be against');
});

// ---- the directional cyclist graph on a synthetic district ------------------------------------------------------------------
const R = (id, props) => ({ id, name: id, class: 'residential', width: 7, lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'none', ...props });
function laneFacts(geo) {
  const net = buildCyclistNetwork(geo, []);
  // for every lane: the way it runs relative to its road (geometric), its kind and side
  return net.lanes.map((l) => {
    const road = geo.roads.find((r) => r.id === l.road);
    return { kind: l.kind, side: l.side, along: l.along, run: road ? alongRoad(road.pts, l.pts).along : null, lane: l };
  });
}

test('a two-way street with a track each side: right track with the pts, left track against them', () => {
  const geo = { roads: [R('a', { class: 'secondary', pts: [0, 0, 200, 0], cycleTrack: 'both', carDir: 'both', bike: { left: 'back', right: 'fwd', carriageway: 'both' } })] };
  const facts = laneFacts(geo).filter((f) => f.kind === 'track');
  assert.equal(facts.length, 2);
  const right = facts.find((f) => f.side === 1);
  const left = facts.find((f) => f.side === -1);
  assert.equal(right.run, 1, 'the right-hand track runs east with the street (pts run east)');
  assert.equal(left.run, -1, 'the left-hand track runs west');
  assert.ok(right.lane.pts[1] > 0 && left.lane.pts[1] < 0, 'right of an eastbound street is south (z+)');
});

test('a one-way street: both tracks run with the cars; a left contraflow track runs against them', () => {
  const withCars = { roads: [R('o', { pts: [0, 0, 200, 0], oneway: true, cycleTrack: 'both', carDir: 'fwd', bike: { left: 'fwd', right: 'fwd', carriageway: 'fwd' } })] };
  assert.deepEqual(laneFacts(withCars).map((f) => f.run), [1, 1]);
  const contra = { roads: [R('o', { pts: [0, 0, 200, 0], oneway: true, cycleTrack: 'left', carDir: 'fwd', bike: { left: 'back', right: 'none', carriageway: 'both', contraflow: true, contraKind: 'lane' } })] };
  const facts = laneFacts(contra);
  assert.deepEqual(facts.map((f) => [f.kind, f.run]), [['track', -1], ['shared', 1]], 'the contraflow lane carries them against, the street itself with the cars');
});

test('contraflow with no lane or track: a lane against the cars on the left, one with them on the right', () => {
  const geo = { roads: [R('c', { pts: [0, 0, 200, 0], oneway: true, carDir: 'fwd', bike: { left: 'none', right: 'none', carriageway: 'both', contraflow: true, contraKind: 'shared' } })] };
  const facts = laneFacts(geo);
  assert.deepEqual(facts.map((f) => [f.kind, f.run, f.side]).sort(), [['contra', -1, -1], ['shared', 1, 1]]);
  for (const f of facts) assert.equal(laneRule(f.lane, geo.roads[0]), null);
  const z = facts.find((f) => f.kind === 'contra').lane.pts.filter((_, i) => i % 2).reduce((a, b) => a + b, 0);
  assert.ok(z < 0, 'on the left edge (north of an eastbound street)');
});

test('a street without contraflow or tracks has no bicycle lane; one that bans bicycles gets none', () => {
  const none = { roads: [R('n', { pts: [0, 0, 200, 0], oneway: true, carDir: 'fwd', bike: { left: 'none', right: 'none', carriageway: 'fwd', contraflow: false } })] };
  assert.equal(laneFacts(none).length, 0);
  const banned = { roads: [R('b', { pts: [0, 0, 200, 0], oneway: true, carDir: 'fwd', bike: { left: 'none', right: 'none', carriageway: 'none', ban: true, contraflow: true, contraKind: 'shared' } })] };
  assert.equal(laneFacts(banned).length, 0, 'no contraflow lane on a street that bans bicycles');
});

test('a two-way track gets one lane per direction on its own side; a one-way cycleway one lane', () => {
  const geo = {
    roads: [
      R('t', { class: 'secondary', pts: [0, 0, 200, 0], cycleTrack: 'right', carDir: 'both', bike: { left: 'none', right: 'both', carriageway: 'both' } }),
      R('p', { class: 'cycleway', pts: [0, 60, 150, 60], carDir: 'none', bike: { left: 'none', right: 'none', carriageway: 'fwd' } }),
      R('q', { class: 'cycleway', pts: [0, 90, 150, 90], carDir: 'none', bike: { left: 'none', right: 'none', carriageway: 'both' } })
    ]
  };
  const facts = laneFacts(geo);
  assert.deepEqual(facts.filter((f) => f.lane.road === 't').map((f) => f.run).sort(), [-1, 1]);
  assert.deepEqual(facts.filter((f) => f.lane.road === 'p').map((f) => f.run), [1]);
  assert.deepEqual(facts.filter((f) => f.lane.road === 'q').map((f) => f.run).sort(), [-1, 1]);
});

test('turns at a junction respect the directions: a rider cannot leave a one-way lane backwards', () => {
  // a T junction: a street running east with a right track, a street coming in from the north with a right track
  const geo = {
    roads: [
      R('e', { class: 'secondary', pts: [0, 0, 100, 0], cycleTrack: 'right', carDir: 'both', bike: { left: 'none', right: 'fwd', carriageway: 'both' } }),
      R('s', { class: 'secondary', pts: [100, -100, 100, 0], cycleTrack: 'right', carDir: 'both', bike: { left: 'none', right: 'fwd', carriageway: 'both' } })
    ]
  };
  const net = buildCyclistNetwork(geo, []);
  for (const l of net.lanes) for (const m of l.next) {
    assert.ok(m.from === l.to, 'a lane only continues from where it ends');
    assert.ok(!(m.to === l.from && l.next.length > 1), 'no U-turn onto the lane that just came in');
  }
});

// ---- the real district ---------------------------------------------------------------------------------------------------------
const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
applyStreets(geo, JSON.parse(readFileSync(new URL('../data/cph-streets.json', import.meta.url), 'utf8')));
const idx = buildRoadIndex(geo);
const log = console.info;

test('the compiled roads carry car and bicycle direction, consistent with the one-way flag', () => {
  const veh = geo.roads.filter((r) => ['primary', 'secondary', 'residential', 'service'].includes(r.class));
  assert.ok(veh.every((r) => r.carDir === (r.oneway ? 'fwd' : 'both') && r.bike));
  assert.ok(veh.filter((r) => r.bike.contraflow).every((r) => r.carDir === 'fwd' && r.bike.carriageway === 'both'), 'contraflow only on one-way streets');
  assert.ok(veh.filter((r) => r.bike.ban).every((r) => r.bike.carriageway === 'none'));
  const contraWays = new Set(veh.filter((r) => r.bike.contraflow).map((r) => r.id.split('#')[0]));
  assert.ok(contraWays.size >= 60, `${contraWays.size} contraflow ways found`);
  assert.ok(veh.some((r) => r.bike.contraKind === 'lane') && veh.some((r) => r.bike.contraKind === 'shared'));
  assert.ok(geo.roads.filter((r) => r.class === 'cycleway' && r.bike.carriageway === 'both').length >= 25, 'two-way cycleways');
  assert.ok(geo.roads.filter((r) => r.class === 'cycleway' && r.bike.carriageway === 'fwd').length >= 60, 'one-way cycleways');
});

test('no car edge runs against a one-way road', () => {
  console.info = () => {};
  const net = buildRoadNetwork(geo.points.signals, { roadGraph: geo.roadGraph });
  console.info = log;
  let judged = 0;
  for (const e of net.edges) {
    const c = edgeCheck(idx, e);
    judged += c.judged;
    assert.ok(!c.violation, `edge at ${c.at?.x}, ${c.at?.z}: ${c.against} of ${c.judged} samples against a one-way road`);
  }
  assert.ok(judged > 3000, `${judged} samples judged`);
});

test('10 simulated minutes of cyclists: no rider against a track, against the cars without contraflow, or on a banned road', () => {
  const net = buildCyclistNetwork(geo, []);
  assert.ok(net.lanes.some((l) => l.kind === 'contra') && net.lanes.some((l) => l.kind === 'shared'));
  for (const l of net.lanes) {
    const road = geo.roads.find((r) => r.id === l.road);
    assert.equal(laneRule(l, road), null, `lane ${l.id} (${l.kind}, ${l.road})`);
  }
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sim = createCyclists(net, { count: 96, random });
  const END = 12;
  let judged = 0;
  let contra = 0;
  for (let i = 0, t = 0; i < 6000; i++) { // 600 s at 0.1 s
    t += 0.1;
    sim.update(0.1, t, null);
    for (const c of sim.riders) {
      if (!c.placed) continue;
      if (c.lane.kind === 'contra') contra++;
      if (c.lane.along === 0 || c.s < END || c.lane.len - c.s < END) continue;
      const r = bikeCheck(idx, c.x, c.z, c.dx, c.dz);
      if (r.status === 'unmatched') continue;
      judged++;
      assert.equal(r.status, 'ok', `${r.why} at ${c.x.toFixed(1)}, ${c.z.toFixed(1)} t=${t.toFixed(1)}`);
    }
  }
  assert.ok(judged > 100000, `${judged} rider-steps judged`);
  assert.ok(contra > 0, 'riders do use the contraflow lanes');
});
