// Independent traffic-direction checks for the Copenhagen twin: judge where a car or a bicycle IS (position + heading) against the
// compiled road data (data/cph-geodata.json roads: carDir, bike, pts), without reading how the engine built its lanes. Shared by
// tools/audit/oneway.mjs (node sim of the cyclists, static network checks) and tools/shoot-m2.py --oneway (cars in the browser).
import { carriagewayWidth } from '../../js/road-width-cph.js';
import { bikeCarriageway, carDirection, hasContraflow, stripDirection } from '../../js/bike-direction.js';

const VEH = new Set(['primary', 'secondary', 'residential', 'service']);
const CELL = 32;

export function buildRoadIndex(geo) {
  const cells = new Map();
  const roads = [];
  for (const r of geo.roads || []) {
    if (!r.pts || r.pts.length < 4 || r.drop) continue;
    const isVeh = VEH.has(r.class);
    if (!isVeh && r.class !== 'cycleway') continue;
    const rec = { r, veh: isVeh, hw: isVeh ? carriagewayWidth(r) / 2 : (r.width || 2.2) / 2, car: carDirection(r), bike: bikeCarriageway(r) };
    roads.push(rec);
    const seen = new Set();
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const x0 = Math.floor((Math.min(r.pts[i], r.pts[i + 2]) - 12) / CELL);
      const x1 = Math.floor((Math.max(r.pts[i], r.pts[i + 2]) + 12) / CELL);
      const z0 = Math.floor((Math.min(r.pts[i + 1], r.pts[i + 3]) - 12) / CELL);
      const z1 = Math.floor((Math.max(r.pts[i + 1], r.pts[i + 3]) + 12) / CELL);
      for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) {
        const k = a * 100003 + b;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(rec);
      }
    }
  }
  // junctions (a road graph node where three or more vehicular links meet): next to one a vehicle may be turning or on the
  // crossing road, so the checks leave it alone
  const rg = geo.roadGraph;
  const junctions = [];
  if (rg) {
    const deg = new Map();
    for (const l of rg.links) {
      if (!VEH.has(rg.classes[l[7]]) || l[0] === l[1]) continue;
      deg.set(l[0], (deg.get(l[0]) || 0) + 1);
      deg.set(l[1], (deg.get(l[1]) || 0) + 1);
    }
    for (const [n, d] of deg) if (d >= 3) junctions.push([rg.nodes[2 * n], rg.nodes[2 * n + 1]]);
  }
  const jcells = new Map();
  for (const j of junctions) {
    const k = Math.floor(j[0] / CELL) * 100003 + Math.floor(j[1] / CELL);
    if (!jcells.has(k)) jcells.set(k, []);
    jcells.get(k).push(j);
  }
  const atJunction = (x, z, r = JUNCTION_R) => {
    const k = Math.ceil(r / CELL);
    for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) {
      for (const j of jcells.get((Math.floor(x / CELL) + a) * 100003 + Math.floor(z / CELL) + b) || []) if (Math.hypot(j[0] - x, j[1] - z) < r) return true;
    }
    return false;
  };
  return { roads, atJunction, near: (x, z) => cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || [] };
}
const JUNCTION_R = 12;
const CAR_JUNCTION_R = 25;

// nearest segment of `rec` to (x, z): { d, cos (heading vs segment), off (+ right of the pts direction) }
function probe(rec, x, z, dx, dz) {
  const p = rec.r.pts;
  let best = null;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const sx = p[i + 2] - p[i];
    const sz = p[i + 3] - p[i + 1];
    const l2 = sx * sx + sz * sz || 1;
    const raw = ((x - p[i]) * sx + (z - p[i + 1]) * sz) / l2;
    const t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(p[i] + sx * t - x, p[i + 1] + sz * t - z);
    if (!best || d < best.d) {
      const l = Math.sqrt(l2);
      // past either end of the road the point is in the junction, not beside the road
      const beyond = (i === 0 && raw < 0) || (i + 4 >= p.length && raw > 1);
      best = { d, cos: (dx * sx + dz * sz) / l, off: ((x - p[i]) * -sz + (z - p[i + 1]) * sx) / l, beyond };
    }
  }
  if (best && best.beyond) best.d = Infinity;
  return best;
}

/** A car at (x, z) heading (dx, dz): 'ok' | 'against' (every road it could be on is one-way the other way) | 'unmatched' */
export function carCheck(idx, x, z, dx, dz) {
  if (idx.atJunction(x, z, CAR_JUNCTION_R)) return { status: 'unmatched' }; // junctions that road-network.js collapses span up to ~25 m
  let any = false;
  for (const rec of idx.near(x, z)) {
    if (!rec.veh) continue;
    const q = probe(rec, x, z, dx, dz);
    if (q.d > rec.hw + 2.5 || Math.abs(q.cos) < 0.8) continue;
    any = true;
    if (rec.car === 'both' || q.cos > 0) return { status: 'ok' };
  }
  return { status: any ? 'against' : 'unmatched' };
}

const STRIP_REACH = 4.2; // m beyond the carriageway edge: kerb + a 3.5 m track

const allows = (d, sg) => d === 'both' || (d === 'fwd' && sg > 0) || (d === 'back' && sg < 0);

/**
 * A bicycle at (x, z) heading (dx, dz), judged on DIRECTION only (lane blending near junctions moves a rider a metre or two
 * off its road, so which strip it is on is not decided here): { status: 'ok' | 'violation' | 'unmatched', why }.
 * A bicycle beside a road is fine when the road's carriageway, its left track or its right track takes it that way; it is a
 * violation when none does (against a one-way street without contraflow, against a one-way cycleway, on a carriageway that
 * bans bicycles and has no track either).
 */
export function bikeCheck(idx, x, z, dx, dz) {
  if (idx.atJunction(x, z)) return { status: 'unmatched' };
  const near = idx.near(x, z);
  let why = null;
  let road = null;
  for (const rec of near) { // on a cycleway: its own direction counts
    if (rec.veh) continue;
    const q = probe(rec, x, z, dx, dz);
    if (q.d > Math.max(1.6, rec.hw + 0.6) || Math.abs(q.cos) < 0.8) continue;
    if (allows(rec.bike, q.cos > 0 ? 1 : -1)) return { status: 'ok' };
    why = `cycleway ${rec.r.id} ridden against its direction`;
    road = rec.r.id;
  }
  for (const rec of near) {
    if (!rec.veh) continue;
    const q = probe(rec, x, z, dx, dz);
    if (Math.abs(q.cos) < 0.8 || q.d > rec.hw + STRIP_REACH) continue;
    const sg = q.cos > 0 ? 1 : -1;
    if (allows(rec.bike, sg) || allows(stripDirection(rec.r, 1), sg) || allows(stripDirection(rec.r, -1), sg)) return { status: 'ok' };
    why = `against the traffic on ${rec.r.id} (${rec.bike === 'none' ? 'bicycles banned' : 'one-way, no contraflow'})`;
    road = rec.r.id;
  }
  return why ? { status: 'violation', why, road } : { status: 'unmatched' };
}

/**
 * The rule a lane of the cyclist network must obey, from the road data alone: null when legal, else why not.
 * lane = { kind, road, side, along } (cyclist-network.js); `road` is the geo.roads record it was built from.
 */
export function laneRule(lane, road) {
  if (!road) return lane.along === 0 ? null : 'lane has no road';
  const banned = !!road.bike?.ban;
  if (lane.kind === 'contra') {
    if (!hasContraflow(road)) return 'contraflow lane on a street without contraflow';
    if (banned) return 'contraflow lane on a street that bans bicycles';
    return lane.along === -1 ? null : 'contraflow lane that runs with the cars';
  }
  if (lane.kind === 'shared') {
    if (banned || bikeCarriageway(road) === 'none') return 'shared lane on a street that bans bicycles';
    if (!hasContraflow(road)) return 'shared lane on a street without contraflow';
    return lane.along === 1 ? null : 'shared lane that runs against the cars';
  }
  if (lane.kind === 'path') return road.class === 'cycleway' ? (lane.along === 0 || allows(bikeCarriageway(road), lane.along) ? null : 'path ridden against its direction') : null;
  if (lane.along === 0 || !lane.side) return null; // a free-standing KK track with no road beside it: two-way
  const d = stripDirection(road, lane.side);
  return allows(d, lane.along) ? null : `${lane.side > 0 ? 'right' : 'left'} track (${d}) ridden ${lane.along > 0 ? 'with' : 'against'} the road's pts`;
}

/**
 * A road-network edge (road-network.js: x0, z0, dx, dz, rx, rz, span, lanes) against the one-way roads, judged where its lanes
 * run and away from the junctions at both ends (15 m: slip roads collapsed into a junction lie there). An edge is against a
 * one-way road when most of the samples that match a road are. -> { judged, against, at, violation }
 */
export function edgeCheck(idx, e) {
  const margin = Math.min(15, e.span / 3);
  let judged = 0;
  let against = 0;
  let at = null;
  for (const lane of e.lanes) {
    for (let t = margin; t <= e.span - margin; t += 4) {
      const x = e.x0 + e.dx * t + e.rx * lane;
      const z = e.z0 + e.dz * t + e.rz * lane;
      const c = carCheck(idx, x, z, e.dx, e.dz);
      if (c.status === 'unmatched') continue;
      judged++;
      if (c.status === 'against') { against++; at ||= { x: +x.toFixed(1), z: +z.toFixed(1) }; }
    }
  }
  return { judged, against, at, violation: judged >= 2 && against / judged > 0.5 };
}
