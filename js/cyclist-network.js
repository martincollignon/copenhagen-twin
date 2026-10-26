// js/cyclist-network.js
// Copenhagen's bicycle lanes as a directed lane graph, and the cyclists that ride it. No three.js: the same code runs
// in the viewer (js/cyclists.js draws it) and headless in tests/cyclists.test.mjs.
//
// Lanes come from data/cph-geodata.json:
//  - roads with cycleTrack left/right/both: a raised track beside the carriageway (the strip road-surfaces-cph.js
//    draws), ridden on the right-hand side of the direction of travel: a "right" track carries the road's drawn
//    direction, a "left" one the opposite, "both" two lanes;
//  - cycleTracks (KK cykelsti centrelines): ridden the way their side of the nearest road dictates, both ways when no
//    road is near;
//  - roads of class cycleway: paths, both ways.
// v1 keeps cyclists on those lanes: shared carriageway lanes (cycleTrack none) are used only to bridge gaps between
// otherwise separate parts of the network, and there is no mixing with turning cars (right hooks, left-turn merges).
// Cyclists follow each other with the Intelligent Driver Model (as traffic.js's cars do) with bicycle parameters,
// stop at red at signalised junctions and use the early green of signal-plan.js.

import { bikePhase } from './signal-plan.js';
import { carriagewayWidth, cycleStrips, slicePts } from './road-width-cph.js';
import { bikeBanned, bikeCarriageway, hasContraflow, stripCoverage, stripDirection } from './bike-direction.js';

export const CYCLE_STRIP = { kerb: 0.18, width: 2.2 };
export const BIKE_DRIVER = { a: 1.0, b: 2.0, T: 1.0, s0: 1.5 };
const SNAP = 5; // lane ends within this many metres share a junction
const SIGNAL_REACH = 24; // a lane ending this near a signalised junction obeys its bike lights
const STOP_BEFORE = 1.5; // metres short of the junction centre the stop line stands
const HALF = 0.9; // half the length of a bicycle with rider

// ---- geometry -----------------------------------------------------------------------------------------------------
function rightNormals(pts) {
  const n = pts.length / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    let dx = 0;
    let dz = 0;
    for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
      if (a < 0 || b >= n) continue;
      const sx = pts[2 * b] - pts[2 * a];
      const sz = pts[2 * b + 1] - pts[2 * a + 1];
      const l = Math.hypot(sx, sz) || 1;
      dx += sx / l;
      dz += sz / l;
    }
    const l = Math.hypot(dx, dz) || 1;
    out.push([-dz / l, dx / l]);
  }
  return out;
}

function offsetLine(pts, offset) {
  const nr = rightNormals(pts);
  const out = [];
  for (let i = 0; i < pts.length / 2; i++) out.push(pts[2 * i] + nr[i][0] * offset, pts[2 * i + 1] + nr[i][1] * offset);
  return out;
}

function reversed(pts) {
  const out = [];
  for (let i = pts.length / 2 - 1; i >= 0; i--) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

function dedupe(pts) {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    if (Math.hypot(pts[i] - out[out.length - 2], pts[i + 1] - out[out.length - 1]) > 0.05) out.push(pts[i], pts[i + 1]);
  }
  return out;
}

// the nearest road (a vehicular geo.roads polyline) to (x, z) within `reach`: its travel direction there, and which side of it
function nearestRoadSide(roads, grid, x, z, reach) {
  let best = null;
  let bd = reach;
  for (const r of grid.near(x, z)) {
    const p = r.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i];
      const dz = p[i + 3] - p[i + 1];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
      const d = Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z);
      if (d < bd) {
        bd = d;
        const l = Math.sqrt(l2);
        best = { road: r, dx: dx / l, dz: dz / l, side: (x - p[i]) * -dz / l + (z - p[i + 1]) * dx / l }; // + : right of the road
      }
    }
  }
  return best;
}

function roadGrid(roads) {
  const cell = 64;
  const cells = new Map();
  for (const r of roads) {
    const seen = new Set();
    for (let i = 0; i < r.pts.length; i += 2) {
      const k = `${Math.floor(r.pts[i] / cell)}:${Math.floor(r.pts[i + 1] / cell)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(r);
    }
  }
  return {
    near(x, z) {
      const out = new Set();
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const r of cells.get(`${cx + i}:${cz + j}`) || []) out.add(r);
      return out;
    }
  };
}

// ---- the lane graph -------------------------------------------------------------------------------------------------
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);

/**
 * @param geo   data/cph-geodata.json
 * @param signalNodes junction nodes of the road network with a signal: { x, z, sigOffset, arms: [{ ux, uz, group }] }
 */
export function buildCyclistNetwork(geo, signalNodes = []) {
  const roads = (geo.roads || []).filter((r) => r.pts && r.pts.length >= 4);
  const vehicular = roads.filter((r) => VEHICULAR.has(r.class));
  const grid = roadGrid(vehicular);
  const raw = []; // { pts, kind, name, width, src }

  // 1. tracks beside carriageways: the strips of the street layout (measured width, where they stand) or the OSM tag. Each
  //    is ridden in its own direction (bike-direction.js): a right-hand track with the cars of its side, a two-way track
  //    both ways, one lane per direction. `along` is +1 for a lane that runs with the road's pts, -1 against them.
  const lane = (pts, kind, r, side, along, width) => raw.push({ pts, kind, name: r.name, width, src: r.id, side, along });
  const both = (pts, off, w, kind, r, side) => { // two lanes on a two-way track: each on its own right-hand half
    lane(offsetLine(pts, off + w / 4), kind, r, side, 1, w);
    lane(reversed(offsetLine(pts, off - w / 4)), kind, r, side, -1, w);
  };
  for (const r of vehicular) {
    if (r.drop) continue;
    const hw = carriagewayWidth(r) / 2;
    const strips = cycleStrips(r);
    for (const sp of strips) {
      const c = hw + CYCLE_STRIP.kerb + sp.w / 2;
      const dir = stripDirection(r, sp.side);
      const pieces = sp.ranges ? sp.ranges.map(([a, b]) => slicePts(r.pts, a, b)).filter((q) => q.length >= 4) : [r.pts];
      for (const q of pieces) {
        const off = sp.side * c;
        if (dir === 'both') both(q, off, sp.w, 'track', r, sp.side);
        else if (dir === 'fwd') lane(offsetLine(q, off), 'track', r, sp.side, 1, sp.w);
        else lane(reversed(offsetLine(q, off)), 'track', r, sp.side, -1, sp.w);
      }
    }
    // a one-way street with contraflow for bicycles but no track carrying it: the lane (or shared stretch) at the left
    // edge of the carriageway runs against the cars; the right edge carries the bicycles with them, so that the two
    // directions join up with the tracks round the corner
    if (hasContraflow(r) && !bikeBanned(r)) {
      const cov = stripCoverage(r, strips);
      const edge = Math.max(0.8, hw - 0.85);
      if (!cov.back) lane(reversed(offsetLine(r.pts, -edge)), 'contra', r, -1, -1, 1.5);
      if (!cov.fwd) lane(offsetLine(r.pts, edge), 'shared', r, 1, 1, 1.5);
    }
  }
  // 2. KK cycle tracks: ridden the way their side of the nearest road dictates
  for (const t of geo.cycleTracks || []) {
    if (!t.pts || t.pts.length < 4) continue;
    const mx = t.pts[t.pts.length / 2 & ~1];
    const mz = t.pts[(t.pts.length / 2 & ~1) + 1];
    const road = nearestRoadSide(vehicular, grid, mx, mz, 16);
    const w = t.width || 2.5;
    const dir = t.pts.length / 2 > 1 ? [t.pts[t.pts.length - 2] - t.pts[0], t.pts[t.pts.length - 1] - t.pts[1]] : [1, 0];
    if (road && Math.abs(road.side) > 1.5 && Math.abs(dir[0] * road.dx + dir[1] * road.dz) > 0.5 * Math.hypot(dir[0], dir[1])) {
      const along = dir[0] * road.dx + dir[1] * road.dz > 0; // the polyline runs with the road's pts
      const sd = stripDirection(road.road, road.side > 0 ? 1 : -1);
      const ride = (withPts) => raw.push({ pts: withPts === along ? t.pts.slice() : reversed(t.pts), kind: 'track', name: t.name, width: w, src: t.id, road: road.road.id, side: road.side > 0 ? 1 : -1, along: withPts ? 1 : -1 });
      if (sd === 'both') {
        raw.push({ pts: offsetLine(t.pts, w / 4), kind: 'track', name: t.name, width: w, src: t.id, road: road.road.id, side: road.side > 0 ? 1 : -1, along: 0 });
        raw.push({ pts: reversed(offsetLine(t.pts, -w / 4)), kind: 'track', name: t.name, width: w, src: t.id, road: road.road.id, side: road.side > 0 ? 1 : -1, along: 0 });
      } else ride(sd === 'fwd');
    } else {
      raw.push({ pts: offsetLine(t.pts, w / 4), kind: 'track', name: t.name, width: w, src: t.id, along: 0 });
      raw.push({ pts: reversed(offsetLine(t.pts, -w / 4)), kind: 'track', name: t.name, width: w, src: t.id, along: 0 });
    }
  }
  // 3. cycleways: the way's own direction (a one-way path is ridden one way), else both
  for (const r of roads) {
    if (r.class !== 'cycleway') continue;
    const w = r.width || 2.2;
    const d = bikeCarriageway(r);
    if (d === 'none') continue;
    if (d === 'fwd') raw.push({ pts: offsetLine(r.pts, 0), kind: 'path', name: r.name, width: w, src: r.id, along: 1 });
    else if (d === 'back') raw.push({ pts: reversed(r.pts), kind: 'path', name: r.name, width: w, src: r.id, along: -1 });
    else {
      raw.push({ pts: offsetLine(r.pts, w / 4), kind: 'path', name: r.name, width: w, src: r.id, along: 1 });
      raw.push({ pts: reversed(offsetLine(r.pts, -w / 4)), kind: 'path', name: r.name, width: w, src: r.id, along: -1 });
    }
  }

  // 4. junction nodes: lane ends within SNAP of one another
  const nodes = [];
  const cell = SNAP * 2;
  const nodeCells = new Map();
  const key = (x, z) => `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
  function nodeAt(x, z, create = true) {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = null;
    let bd = SNAP;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const n of nodeCells.get(`${cx + i}:${cz + j}`) || []) {
          const d = Math.hypot(n.x - x, n.z - z);
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    if (best || !create) return best;
    const n = { id: nodes.length, x, z, out: [], in: [], count: 1, sx: x, sz: z, signal: null };
    nodes.push(n);
    const k = key(x, z);
    if (!nodeCells.has(k)) nodeCells.set(k, []);
    nodeCells.get(k).push(n);
    return n;
  }
  const lanes = [];
  for (const r of raw) {
    const pts = densify(dedupe(r.pts), 4);
    if (pts.length < 4) continue;
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (len < 3) continue;
    const a = nodeAt(pts[0], pts[1]);
    const b = nodeAt(pts[pts.length - 2], pts[pts.length - 1]);
    if (a === b && len < 12) continue;
    const lane = { id: lanes.length, pts, kind: r.kind, name: r.name, width: r.width, src: r.src, road: r.road ?? r.src, side: r.side ?? 0, along: r.along ?? 0, from: a, to: b };
    a.out.push(lane);
    b.in.push(lane);
    lanes.push(lane);
  }
  // Free ends (a track that stops short of the one it meets: a T junction, or a corner where two ways' offsets don't
  // meet) attach to the nearest lane within ATTACH metres, splitting it there
  const ATTACH = 9;
  const lenOf = (pts) => {
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return len;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const n of nodes) {
      const ends = n.in.concat(n.out);
      if (!ends.length) continue;
      const onward = n.out.filter((m) => !n.in.some((l) => l.from === m.to && l.to === m.from));
      const arriving = n.in.filter((l) => !n.out.some((m) => m.to === l.from && m.from === l.to));
      if (onward.length && arriving.length) continue; // already joins something
      if (n.in.length + n.out.length > 2 && onward.length + arriving.length === 0) continue;
      let best = null;
      let bd = ATTACH;
      for (const m of lanes) {
        if (m.from === n || m.to === n) continue;
        for (let i = 0; i + 3 < m.pts.length; i += 2) {
          const dx = m.pts[i + 2] - m.pts[i];
          const dz = m.pts[i + 3] - m.pts[i + 1];
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((n.x - m.pts[i]) * dx + (n.z - m.pts[i + 1]) * dz) / l2));
          const d = Math.hypot(m.pts[i] + dx * t - n.x, m.pts[i + 1] + dz * t - n.z);
          if (d < bd) {
            bd = d;
            best = { m, i, t, x: m.pts[i] + dx * t, z: m.pts[i + 1] + dz * t };
          }
        }
      }
      if (!best) continue;
      const { m } = best;
      const before = [...m.pts.slice(0, best.i + 2), best.x, best.z];
      const after = [best.x, best.z, ...m.pts.slice(best.i + 2)];
      let target;
      if (lenOf(before) < 2.5 || Math.hypot(best.x - m.pts[0], best.z - m.pts[1]) < 2.5) target = m.from;
      else if (lenOf(after) < 2.5 || Math.hypot(best.x - m.pts[m.pts.length - 2], best.z - m.pts[m.pts.length - 1]) < 2.5) target = m.to;
      else {
        target = { id: nodes.length, x: best.x, z: best.z, out: [], in: [], signal: null };
        nodes.push(target);
        const tail = { ...m, id: lanes.length, pts: after, from: target };
        m.pts = before;
        m.to.in.splice(m.to.in.indexOf(m), 1, tail);
        m.to = target;
        target.in.push(m);
        target.out.push(tail);
        lanes.push(tail);
      }
      // n becomes target
      for (const l of n.in) {
        l.to = target;
        target.in.push(l);
      }
      for (const l of n.out) {
        l.from = target;
        target.out.push(l);
      }
      n.in = [];
      n.out = [];
    }
  }
  // a junction stands at the mean of the lane ends that meet there (so two lanes of one street that were joined at its end,
  // a contraflow lane on the left and a lane with the cars on the right, meet on its centreline)
  for (const n of nodes) {
    const ends = [...n.in.map((l) => [l.pts.length - 2, l]), ...n.out.map((l) => [0, l])];
    if (ends.length < 2) continue;
    let x = 0;
    let z = 0;
    for (const [i, l] of ends) {
      x += l.pts[i];
      z += l.pts[i + 1];
    }
    n.x = x / ends.length;
    n.z = z / ends.length;
  }
  // lane ends sit exactly on their junction, so lanes join without a step; the shift fades out over PIN_BLEND metres so
  // that the lane keeps its side of the street (a lane of two points would otherwise swing across the whole street)
  for (const l of lanes) {
    pinEnds(l);
    l.cum = [0];
    for (let i = 2; i < l.pts.length; i += 2) l.cum.push(l.cum[l.cum.length - 1] + Math.hypot(l.pts[i] - l.pts[i - 2], l.pts[i + 1] - l.pts[i - 1]));
    l.len = l.cum[l.cum.length - 1];
    l.occ = [];
    const n = l.pts.length;
    const d0 = Math.hypot(l.pts[2] - l.pts[0], l.pts[3] - l.pts[1]) || 1;
    const d1 = Math.hypot(l.pts[n - 2] - l.pts[n - 4], l.pts[n - 1] - l.pts[n - 3]) || 1;
    l.startDir = [(l.pts[2] - l.pts[0]) / d0, (l.pts[3] - l.pts[1]) / d0];
    l.endDir = [(l.pts[n - 2] - l.pts[n - 4]) / d1, (l.pts[n - 1] - l.pts[n - 3]) / d1];
  }

  // lanes that ended up (nearly) nothing once their ends were pinned to the junctions
  for (let i = lanes.length - 1; i >= 0; i--) {
    const l = lanes[i];
    if (l.len >= 3 && !(l.from === l.to && l.len < 12) && !returnsOnItself(l)) continue;
    l.from.out.splice(l.from.out.indexOf(l), 1);
    l.to.in.splice(l.to.in.indexOf(l), 1);
    lanes.splice(i, 1);
  }
  lanes.forEach((l, i) => (l.id = i));

  // 5. which lane may continue on to which: not back where it came from, not round a hairpin
  for (const l of lanes) {
    l.next = l.to.out.filter((m) => m !== l && !(m.to === l.from && m.len === l.len && l.to.out.length > 1)
      && m.startDir[0] * l.endDir[0] + m.startDir[1] * l.endDir[1] > -0.5);
    if (!l.next.length) { // a dead end: turn round onto the lane back, if there is one
      const back = l.to.out.filter((m) => m.to === l.from);
      l.next = back.length ? back : [];
    }
    l.uturn = l.next.length === 1 && l.next[0].to === l.from;
  }

  // 6. signals: a lane arriving at a signalised junction obeys the bike lights of the road arm it runs along
  for (const l of lanes) {
    let best = null;
    let bd = SIGNAL_REACH;
    for (const s of signalNodes) {
      const d = Math.hypot(s.x - l.to.x, s.z - l.to.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) continue;
    // the arm best aligned with the lane's travel (cyclists ride with the traffic of their road)
    let arm = null;
    let ad = 0.5;
    for (const a of best.arms || []) {
      const d = Math.abs(a.ux * l.endDir[0] + a.uz * l.endDir[1]);
      if (d > ad) {
        ad = d;
        arm = a;
      }
    }
    if (!arm) continue;
    l.signal = { offset: best.sigOffset, group: arm.group ?? 0, node: best };
    l.stopS = Math.max(0, l.len - STOP_BEFORE);
  }

  const stats = {
    lanes: lanes.length,
    nodes: nodes.length,
    lengthKm: lanes.reduce((s, l) => s + l.len, 0) / 1000,
    signalLanes: lanes.filter((l) => l.signal).length,
    deadEnds: lanes.filter((l) => !l.next.length).length
  };
  return { lanes, nodes, stats };
}

const PIN_BLEND = 12;
// Moves the lane's first and last vertex onto its junctions and drags the vertices within PIN_BLEND metres of them along,
// the shift fading out linearly with the distance
function pinEnds(l) {
  const p = l.pts;
  const n = p.length / 2;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
  const len = cum[n - 1];
  const d0 = [l.from.x - p[0], l.from.z - p[1]];
  const d1 = [l.to.x - p[2 * n - 2], l.to.z - p[2 * n - 1]];
  for (let i = 0; i < n; i++) {
    const w0 = Math.max(0, 1 - cum[i] / PIN_BLEND);
    const w1 = Math.max(0, 1 - (len - cum[i]) / PIN_BLEND);
    p[2 * i] += d0[0] * w0 + d1[0] * w1;
    p[2 * i + 1] += d0[1] * w0 + d1[1] * w1;
  }
  p[0] = l.from.x;
  p[1] = l.from.z;
  p[2 * n - 2] = l.to.x;
  p[2 * n - 1] = l.to.z;
}

// Inserts points so that no segment is longer than `step`
function densify(pts, step) {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2];
    const dz = pts[i + 1] - pts[i - 1];
    const k = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
    for (let j = 1; j <= k; j++) out.push(pts[i - 2] + (dx * j) / k, pts[i - 1] + (dz * j) / k);
  }
  return out;
}

// A lane whose ends were pinned to one junction and that never gets away from it (a stub folded back on itself): not a way
function returnsOnItself(l) {
  if (l.from !== l.to) return false;
  let far = 0;
  for (let i = 0; i < l.pts.length; i += 2) far = Math.max(far, Math.hypot(l.pts[i] - l.pts[0], l.pts[i + 1] - l.pts[1]));
  return far < 0.3 * l.len;
}

// position and unit direction at arc length s along a lane
export function lanePoint(lane, s, out = { x: 0, z: 0, dx: 0, dz: 1 }) {
  const cum = lane.cum;
  const p = lane.pts;
  s = Math.max(0, Math.min(lane.len, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const L = cum[hi] - cum[lo] || 1;
  const t = (s - cum[lo]) / L;
  out.x = p[2 * lo] + (p[2 * hi] - p[2 * lo]) * t;
  out.z = p[2 * lo + 1] + (p[2 * hi + 1] - p[2 * lo + 1]) * t;
  out.dx = (p[2 * hi] - p[2 * lo]) / L;
  out.dz = (p[2 * hi + 1] - p[2 * lo + 1]) / L;
  return out;
}

// ---- cyclists -----------------------------------------------------------------------------------------------------
export function createCyclists(network, { count = 60, random = Math.random } = {}) {
  let lanes = network.lanes;
  let usable = lanes.filter((l) => l.len > 12);
  let totalLen = usable.reduce((s, l) => s + l.len, 0);
  const riders = [];
  let clock = 0;

  for (let i = 0; i < count; i++) {
    riders.push({
      id: i, lane: null, s: 0, speed: 0, acc: 0, v0: 5.0 + random() * 1.1, // 18-22 km/h
      next: null, wait: 0, stoppedFor: 0, x: 0, z: 0, dx: 0, dz: 1, prevX: 0, prevZ: 0, yaw: 0, lean: 0,
      pedal: random() * 6.28, gap: Infinity, leaderSpeed: 0, half: HALF, placed: false, stuck: false
    });
  }

  /** Swaps the lane graph (streamed city: the region around the camera): every rider is placed afresh on it. */
  function setNetwork(next) {
    lanes = next.lanes;
    usable = lanes.filter((l) => l.len > 12);
    totalLen = usable.reduce((s, l) => s + l.len, 0);
    for (const c of riders) { c.placed = false; c.lane = null; c.next = null; c.stuck = false; }
  }

  function pickLane() {
    if (!usable.length) return null;
    let r = random() * totalLen;
    for (const l of usable) {
      r -= l.len;
      if (r <= 0) return l;
    }
    return usable[usable.length - 1];
  }

  function laneClear(l, s, gap) {
    for (const o of l.occ) if (Math.abs(o.s - s) < gap) return false;
    return true;
  }

  function place(c, lane, s) {
    c.lane = lane;
    c.s = s;
    c.speed = Math.min(c.v0 * 0.5, 3);
    c.next = chooseNext(c);
    c.wait = 0;
    c.placed = true;
    sync(c);
    c.prevX = c.x;
    c.prevZ = c.z;
    c.yaw = Math.atan2(c.dx, c.dz);
  }

  const pt = { x: 0, z: 0, dx: 0, dz: 1 };
  function sync(c) {
    lanePoint(c.lane, c.s, pt);
    c.x = pt.x;
    c.z = pt.z;
    c.dx = pt.dx;
    c.dz = pt.dz;
  }

  function chooseNext(c) {
    const options = c.lane.next;
    if (!options.length) return null;
    let total = 0;
    const w = options.map((m) => {
      const straight = m.startDir[0] * c.lane.endDir[0] + m.startDir[1] * c.lane.endDir[1];
      const v = (straight > 0.8 ? 4 : straight > 0.2 ? 1.5 : 0.5) * (m.kind === 'track' ? 1.3 : 1);
      total += v;
      return v;
    });
    let r = random() * total;
    for (let i = 0; i < options.length; i++) {
      r -= w[i];
      if (r <= 0) return options[i];
    }
    return options[options.length - 1];
  }

  const brake = (c, gap, speed, s0 = BIKE_DRIVER.s0, T = BIKE_DRIVER.T) => {
    const { a, b } = BIKE_DRIVER;
    const desired = s0 + Math.max(0, c.speed * T + (c.speed * (c.speed - speed)) / (2 * Math.sqrt(a * b)));
    return -a * (desired / Math.max(gap, 0.1)) ** 2;
  };

  // the nearest rider ahead of c on its lane, and past the lane's end on the next one
  function leaderGap(c) {
    let gap = Infinity;
    let speed = 0;
    for (const o of c.lane.occ) {
      if (o.c === c || o.s <= c.s) continue;
      const g = o.s - c.s - HALF * 2;
      if (g < gap) {
        gap = g;
        speed = o.c.speed;
      }
    }
    if (gap === Infinity && c.next) {
      const room = c.lane.len - c.s;
      for (const o of c.next.occ) {
        const g = room + o.s - HALF * 2;
        if (g < gap) {
          gap = g;
          speed = o.c.speed;
        }
      }
    }
    return { gap, speed };
  }

  function step(c, dt) {
    const lane = c.lane;
    let acc = 1.0 * (1 - (c.speed / c.v0) ** 4);
    let worst = 0;
    const { gap, speed } = leaderGap(c);
    c.gap = gap;
    if (gap < 60) worst = brake(c, gap, speed);
    // the stop line
    const sig = lane.signal;
    if (sig && bikePhase(sig.offset, sig.group, clock) === 'red') {
      const d = lane.stopS - c.s;
      if (d > -0.5 && d < 60) worst = Math.min(worst, brake(c, Math.max(d, 0.1), 0, 0.5, 0));
    }
    // the next lane's start has no room
    if (c.next && lane.len - c.s < 8 && !laneClear(c.next, 0, HALF * 2 + 0.5)) worst = Math.min(worst, brake(c, Math.max(lane.len - c.s, 0.1), 0, 0.5, 0));
    acc = Math.max(-6, Math.min(1.0, acc + worst));
    const v1 = Math.max(0, c.speed + acc * dt);
    let ds = (c.speed + v1) * 0.5 * dt;
    if (ds > gap - 0.3) ds = Math.max(0, gap - 0.3);
    c.acc = acc;
    c.speed = ds / dt < v1 ? ds / dt : v1;
    c.wait = c.speed < 0.2 ? c.wait + dt : 0;
    c.s += ds;
    // blocked at the end of the lane for a while: take another way on, if one has room
    if (c.next && c.wait > 6 && lane.len - c.s < 3) {
      const open = lane.next.filter((m) => laneClear(m, 0, HALF * 2 + 0.5));
      if (open.length && !open.includes(c.next)) c.next = open[Math.floor(random() * open.length)];
    }
    if (c.s >= lane.len - 0.5 && !c.next) {
      c.placed = false; // a lane that leads nowhere (the district's edge): its rider has arrived, and starts again elsewhere
    } else if (c.s >= lane.len) {
      if (laneClear(c.next, c.s - lane.len, HALF * 2)) {
        c.s -= lane.len;
        c.lane = c.next;
        c.next = chooseNext(c);
      } else {
        c.s = lane.len;
        c.speed = 0;
      }
    }
    c.pedal += c.speed * dt * 2.4;
  }

  /** @param focus {x, z} keep riders within `radius` of it (respawning those that fall behind), or null for anywhere */
  function update(dt, elapsed, focus = null, radius = 450) {
    clock = elapsed;
    for (const l of lanes) l.occ.length = 0;
    for (const c of riders) if (c.placed) l_occ(c);
    for (const c of riders) {
      if (c.placed && focus && Math.hypot(c.x - focus.x, c.z - focus.z) > radius) c.placed = false;
    }
    let budget = 6;
    for (const c of riders) {
      if (c.placed || budget <= 0) continue;
      budget--;
      for (let attempt = 0; attempt < 10; attempt++) {
        const lane = pickLane();
        if (!lane) break;
        const s = random() * lane.len;
        lanePoint(lane, s, pt);
        if (focus && Math.hypot(pt.x - focus.x, pt.z - focus.z) > radius * 0.9) continue;
        if (!laneClear(lane, s, 6)) continue;
        place(c, lane, s);
        l_occ(c);
        break;
      }
    }
    for (const c of riders) {
      if (!c.placed) continue;
      c.prevX = c.x;
      c.prevZ = c.z;
      step(c, dt);
      sync(c);
      const yaw = Math.atan2(c.dx, c.dz);
      let d = yaw - c.yaw;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      c.lean += (Math.max(-0.35, Math.min(0.35, -d / Math.max(dt, 1e-3) * c.speed * 0.02)) - c.lean) * Math.min(1, dt * 6);
      c.yaw = yaw;
      c.stuck = c.wait > 150; // longer than two signal cycles
    }
  }
  function l_occ(c) {
    c.lane.occ.push({ c, s: c.s });
  }

  return { riders, update, setNetwork, get clock() { return clock; } };
}
