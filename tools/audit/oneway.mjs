// Traffic-direction audit of the Copenhagen twin (cars and bicycles) and the headless 10-minute cyclist simulation.
//   node tools/audit/oneway.mjs [--minutes 10] [--out tools/audit/out/oneway.json] [--engine DIR]
// --engine DIR builds the networks with another checkout's js/ (e.g. the pre-change engine) against the same data and the same checks.
// Cars: the road network's edges are judged against the one-way roads (static), and `tools/shoot-m2.py --oneway` runs the live
// traffic with these same checks (carCheck). Cyclists: the lane graph is judged lane by lane, then 96 riders ride `--minutes`
// simulated minutes and every rider-step is judged by bikeCheck (position + heading against the road data only).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRoadIndex, bikeCheck, edgeCheck, laneRule } from './oneway-check.mjs';
import { alongRoad, bikeBanned, carDirection, hasContraflow, stripDirection } from '../../js/bike-direction.js';
import { applyStreets } from '../../js/layout-cph.js';
import { cycleStrips } from '../../js/road-width-cph.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const minutes = Number(arg('minutes', 10));
const out = resolve(root, arg('out', 'tools/audit/out/oneway.json'));
const engine = resolve(arg('engine', resolve(root, 'js')));
const { buildCyclistNetwork, createCyclists } = await import(pathToFileURL(resolve(engine, 'cyclist-network.js')));
const { buildRoadNetwork } = await import(pathToFileURL(resolve(engine, 'road-network.js')));

const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const geo = read('data/cph-geodata.json');
applyStreets(geo, read('data/cph-streets.json'));
const idx = buildRoadIndex(geo);
const VEH = new Set(['primary', 'secondary', 'residential', 'service']);
const vehicular = geo.roads.filter((r) => VEH.has(r.class) && r.pts?.length >= 4 && !r.drop);
const len = (p) => { let s = 0; for (let i = 0; i + 3 < p.length; i += 2) s += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]); return s; };
const END_BLEND = 12; // m of a lane next to its junction: its geometry is pulled to the junction centre there
const wayOf = (id) => id.split('#')[0];
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const report = { engine, geo: { roads: geo.roads.length } };

// ---- what the data says ---------------------------------------------------------------------------------------------------
const contra = vehicular.filter((r) => hasContraflow(r));
const byKind = {};
for (const r of contra) (byKind[r.bike.contraKind] ||= new Set()).add(wayOf(r.id));
const twoWayStrips = new Set();
for (const r of vehicular) for (const sp of cycleStrips(r)) if (stripDirection(r, sp.side) === 'both') twoWayStrips.add(wayOf(r.id));
const cycleways = geo.roads.filter((r) => r.class === 'cycleway' && r.pts?.length >= 4);
report.data = {
  oneWayCarRoads: new Set(vehicular.filter((r) => carDirection(r) === 'fwd').map((r) => wayOf(r.id))).size,
  contraflowStreets: new Set(contra.map((r) => wayOf(r.id))).size,
  contraflowKm: +(contra.reduce((s, r) => s + len(r.pts), 0) / 1000).toFixed(2),
  contraflowByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.size])),
  twoWayCarriagewayTracks: twoWayStrips.size,
  twoWayCyclewayWays: new Set(cycleways.filter((r) => r.bike?.carriageway === 'both').map((r) => wayOf(r.id))).size,
  oneWayCyclewayWays: new Set(cycleways.filter((r) => r.bike?.carriageway === 'fwd').map((r) => wayOf(r.id))).size,
  bicycleBannedRoads: new Set(vehicular.filter((r) => bikeBanned(r)).map((r) => wayOf(r.id))).size,
  sidepathSides: new Set(vehicular.filter((r) => r.bike?.sidepath).map((r) => wayOf(r.id))).size,
  roadStats: geo.meta?.road_stats || null
};

// ---- cars: the road network's edges against the one-way roads --------------------------------------------------------------
{
  const signals = (geo.points?.signals || []);
  const net = buildRoadNetwork(signals, { roadGraph: geo.roadGraph });
  let against = 0;
  let judged = 0;
  const examples = [];
  for (const e of net.edges) {
    const c = edgeCheck(idx, e);
    judged += c.judged;
    if (c.violation) { against++; if (examples.length < 12) examples.push({ ...c.at, samples: c.judged, against: c.against, chain: e.chain?.id }); }
  }
  // One-way streets no car can both reach and leave. `live` = the edge is in the largest strongly connected part of the network
  // (road-network.js drops the rest). For each non-live edge on a one-way road: a SINK can be entered but not left, a SOURCE can be
  // left but not entered, an ISLAND neither. Those at the district boundary (within 60 m of the +-750 m frame) are the street
  // continuing out of the district, not an error.
  const outs = new Map();
  for (const e of net.edges) (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e);
  const nxt = (e) => (outs.get(e.to) || []).filter((f) => f.to !== e.from && e.dx * f.dx + e.dz * f.dz >= -0.5);
  const prv = new Map();
  for (const e of net.edges) for (const f of nxt(e)) (prv.get(f) || prv.set(f, []).get(f)).push(e);
  const reach = (start, fn) => { const seen = new Set(); const st = [start]; while (st.length) for (const f of fn(st.pop())) if (!seen.has(f)) { seen.add(f); st.push(f); } return seen; };
  const dead = { sink: 0, source: 0, island: 0 };
  const deadEdge = { sink: 0, source: 0, island: 0 };
  const interior = [];
  for (const e of net.edges) {
    if (e.live) continue;
    const mx = e.x0 + e.dx * e.span / 2;
    const mz = e.z0 + e.dz * e.span / 2;
    let one = null;
    let bd = 9;
    for (const rec of idx.near(mx, mz)) {
      if (!rec.veh) continue;
      const p = rec.r.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const sx = p[i + 2] - p[i];
        const sz = p[i + 3] - p[i + 1];
        const t = Math.max(0, Math.min(1, ((mx - p[i]) * sx + (mz - p[i + 1]) * sz) / (sx * sx + sz * sz || 1)));
        const d = Math.hypot(p[i] + sx * t - mx, p[i + 1] + sz * t - mz);
        if (d < bd) { bd = d; one = rec; }
      }
    }
    if (!one || one.car !== 'fwd') continue;
    const enters = [...reach(e, (x) => prv.get(x) || [])].some((x) => x.live);
    const exits = [...reach(e, nxt)].some((x) => x.live);
    const kind = enters && !exits ? 'sink' : !enters && exits ? 'source' : 'island';
    if (Math.max(Math.abs(mx), Math.abs(mz)) > 690) deadEdge[kind]++;
    else { dead[kind]++; if (interior.length < 20) interior.push({ kind, road: one.r.name || one.r.id, x: +mx.toFixed(0), z: +mz.toFixed(0) }); }
  }
  report.cars = {
    edges: net.edges.length, samplesJudged: judged, edgesAgainstOneWay: against, examples,
    oneWayEdgesNotInTheMainNetwork: { interior: dead, atDistrictBoundary: deadEdge, interiorSample: interior }
  };
}

// ---- cyclists: the lane graph, lane by lane ---------------------------------------------------------------------------------
const net = buildCyclistNetwork(geo, []);
// the lane graph's own junctions: a rider within 8 m of one is turning, not riding along a road
{
  const g = new Map();
  for (const n of net.nodes) if (n.in.length + n.out.length) { const k = `${Math.floor(n.x / 16)}:${Math.floor(n.z / 16)}`; (g.get(k) || g.set(k, []).get(k)).push(n); }
  const base = idx.atJunction;
  idx.atJunction = (x, z) => base(x, z) || [-1, 0, 1].some((a) => [-1, 0, 1].some((b) => (g.get(`${Math.floor(x / 16) + a}:${Math.floor(z / 16) + b}`) || []).some((n) => Math.hypot(n.x - x, n.z - z) < 8)));
}
const roadById = new Map(geo.roads.map((r) => [r.id, r]));
{
  const bad = [];
  const kinds = {};
  let judged = 0;
  for (const l of net.lanes) {
    kinds[l.kind] = (kinds[l.kind] || 0) + 1;
    const r = roadById.get(l.road ?? l.src);
    if (!r || !VEH.has(r.class) && r.class !== 'cycleway') continue;
    // every lane is judged with the independent probe: ride its length and ask bikeCheck at each metre
    let hit = null;
    for (let s = END_BLEND; s < l.len - END_BLEND && !hit; s += 4) { // the ends are blended into the junctions
      const i = l.cum.findIndex((c) => c >= s);
      if (i < 1) continue;
      const t = (s - l.cum[i - 1]) / ((l.cum[i] - l.cum[i - 1]) || 1);
      const x = l.pts[2 * i - 2] + (l.pts[2 * i] - l.pts[2 * i - 2]) * t;
      const z = l.pts[2 * i - 1] + (l.pts[2 * i + 1] - l.pts[2 * i - 1]) * t;
      const dx = l.pts[2 * i] - l.pts[2 * i - 2];
      const dz = l.pts[2 * i + 1] - l.pts[2 * i - 1];
      const d = Math.hypot(dx, dz) || 1;
      const c = bikeCheck(idx, x, z, dx / d, dz / d);
      judged++;
      if (c.status === 'violation') hit = { lane: l.id, kind: l.kind, why: c.why, x: +x.toFixed(1), z: +z.toFixed(1) };
    }
    if (hit) bad.push(hit);
    const rule = l.road === undefined ? null : laneRule(l, r);
    if (rule) bad.push({ lane: l.id, kind: l.kind, why: rule, road: l.road });
    if (l.along && (l.kind === 'track' || l.kind === 'contra' || l.kind === 'shared') && r.pts) { // construction: the lane runs the way it says
      const a = alongRoad(r.pts, l.pts);
      if (a.along !== l.along && a.dist < 8 && l.len > 25) bad.push({ lane: l.id, kind: l.kind, why: `built ${l.along > 0 ? 'with' : 'against'} the pts but runs the other way`, road: l.road });
    }
    if ((l.kind === 'contra' || l.kind === 'shared') && bikeBanned(r)) bad.push({ lane: l.id, kind: l.kind, why: 'on a road that bans bicycles', road: l.road });
  }
  // dead ends / sinks: lanes with no way on (the rider has arrived), apart from those ending at the district edge
  const edge = 735;
  const sinks = net.lanes.filter((l) => !l.next.length && Math.abs(l.to.x) < edge && Math.abs(l.to.z) < edge);
  // strong connectivity: the largest set of lanes a rider can ride round (Kosaraju), and how many contraflow lanes are in it
  const order = [];
  const seen = new Set();
  for (const root of net.lanes) {
    if (seen.has(root)) continue;
    seen.add(root);
    const st = [[root, 0]];
    while (st.length) {
      const top = st[st.length - 1];
      const [l, i] = top;
      if (i < l.next.length) { top[1]++; const m = l.next[i]; if (!seen.has(m)) { seen.add(m); st.push([m, 0]); } } else { order.push(l); st.pop(); }
    }
  }
  const pred = new Map(net.lanes.map((l) => [l, []]));
  for (const l of net.lanes) for (const m of l.next) pred.get(m).push(l);
  let main = new Set();
  const done = new Set();
  for (const root of order.reverse()) {
    if (done.has(root)) continue;
    const comp = new Set([root]);
    done.add(root);
    const st = [root];
    while (st.length) for (const m of pred.get(st.pop())) if (!done.has(m)) { done.add(m); comp.add(m); st.push(m); }
    if (comp.size > main.size) main = comp;
  }
  const contraLanes = net.lanes.filter((l) => l.kind === 'contra');
  const sharedLanes = net.lanes.filter((l) => l.kind === 'shared');
  report.cyclists = {
    lanes: net.lanes.length, kinds, lengthKm: +net.stats.lengthKm.toFixed(1), judgedSamples: judged,
    illegalLanes: bad.length, illegalSample: bad.slice(0, 15),
    deadEndLanes: sinks.length, deadEndByKind: sinks.reduce((o, l) => (o[l.kind] = (o[l.kind] || 0) + 1, o), {}),
    mainComponentLanes: main.size, contraLanes: contraLanes.length, contraLanesInMainComponent: contraLanes.filter((l) => main.has(l)).length, sharedLanesInMainComponent: sharedLanes.filter((l) => main.has(l)).length, sharedLanes: sharedLanes.length,
    contraLanesWithAnExit: contraLanes.filter((l) => l.next.length).length
  };
}

// ---- the 10-minute headless simulation ----------------------------------------------------------------------------------------
{
  const random = mulberry(20260);
  const sim = createCyclists(net, { count: 96, random });
  const dt = 0.1;
  const steps = Math.round(minutes * 60 / dt);
  const tally = { riderSteps: 0, ok: 0, unmatched: 0, violations: 0, contraSteps: 0 };
  const events = new Map();
  const examples = [];
  const laneUse = {};
  const ruleCache = new Map();
  for (let k = 0; k < steps; k++) {
    sim.update(dt, k * dt, null);
    for (const c of sim.riders) {
      if (!c.placed) continue;
      tally.riderSteps++;
      laneUse[c.lane.kind] = (laneUse[c.lane.kind] || 0) + 1;
      let lr = ruleCache.get(c.lane.id);
      if (lr === undefined) { lr = c.lane.road === undefined ? null : laneRule(c.lane, roadById.get(c.lane.road)); ruleCache.set(c.lane.id, lr); }
      const ch = lr ? { status: 'violation', why: lr } : c.lane.along === 0 || c.s < END_BLEND || c.lane.len - c.s < END_BLEND ? { status: 'unmatched' } : bikeCheck(idx, c.x, c.z, c.dx, c.dz);
      if (ch.status === 'ok') tally.ok++;
      else if (ch.status === 'unmatched') tally.unmatched++;
      else {
        tally.violations++;
        const key = `${c.id}:${c.lane.id}`;
        if (!events.has(key)) {
          events.set(key, 1);
          if (examples.length < 15) examples.push({ t: +(k * dt).toFixed(1), lane: c.lane.id, kind: c.lane.kind, why: ch.why, x: +c.x.toFixed(1), z: +c.z.toFixed(1) });
        }
      }
    }
  }
  report.sim = { minutes, dt, riders: sim.riders.length, ...tally, violationEvents: events.size, laneUse, examples };
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
