// js/road-surfaces-cph.js
// Copenhagen road surfaces from the compiled geodata (docs/cph-geodata-schema.md): dark asphalt carriageways, granite
// kerbs (as geometry), raised dark-asphalt cycle tracks one kerb step above the carriageway and one below the pavement,
// white lane paint (no yellow), and the KK road markings (data/cph-surfaces.json: crossings, arrows, bays, blue cycle
// crossings). Pavements are built by pavement-cph.js from the same road list.
// Frame: x east, z south, y up. `buildRoadSurfaceArrays` is pure (no three.js) so it can be tested headless;
// `buildCphRoadSurfaces` turns the arrays into merged meshes.

import { carriagewayWidth } from './road-width-cph.js';
import { triangulatePolygon } from './polygon-cph.js';
import { buildPavementBuckets, createSurfaceIndex } from './pavement-cph.js';
import { createHeightGrid } from './ground-height-cph.js';
import { computeMouthLayouts, subtractIntervals } from './junction-mouths-cph.js';

// Heights (m): carriageway -> (10 cm kerb) -> cycle track -> (8 cm kerb) -> pavement
export const SURFACE_Y = { asphalt: 0.02, paint: 0.035, cycle: 0.12, cyclePaint: 0.128, kerbTop: 0.002, sidewalk: 0.2, ground: 0.014 };
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const KERB_W = 0.15;
const CYCLE_W = 2.2;
const LANE_W = 3.0;
const LINE_W = 0.12;
const JUNCTION_TRIM = 7; // m of cycle track before a junction that is painted blue (the crossing)
const RENDERED_MARKINGS = new Set(['white', 'crossing', 'arrow', 'symbol', 'bay', 'bump', 'bluecycle']);

class Layer {
  constructor() { this.pos = []; this.idx = []; this.uv = []; }
  quad(a, b, c, d, y, uvs) { // four (x, z) corners in order, optional four (u, v) pairs
    const o = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.pos.push(p[0], y, p[1]);
    if (uvs) for (const q of uvs) this.uv.push(q[0], q[1]);
    else for (let i = 0; i < 4; i++) this.uv.push(0, 0);
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  // a sloped quad: four (x, z) corners with a height each, wound so it faces up
  quadY(pts, ys) {
    const o = this.pos.length / 3;
    const cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]);
    for (let k = 0; k < 4; k++) { this.pos.push(pts[k][0], ys[k], pts[k][1]); this.uv.push(0, 0); }
    if (cross >= 0) this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    else this.idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  }
  // a vertical quad over the (x, z) edge a-b between heights y0 and y1
  wall(a, b, y0, y1, u0 = 0, u1 = 0) {
    const o = this.pos.length / 3;
    this.pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
    this.uv.push(u0, 0, u1, 0, u1, 0, u0, 0);
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  get vertexCount() { return this.pos.length / 3; }
  arrays() { return { position: new Float32Array(this.pos), kuv: new Float32Array(this.uv), index: new Uint32Array(this.idx) }; }
}

// Per-vertex unit normals of a polyline (right-hand side positive offset: right of travel with z south is (-dz, dx))
function rightNormals(pts) {
  const n = pts.length / 2;
  const out = new Array(n);
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
    out[i] = [-dz / l, dx / l];
  }
  return out;
}

function polyLength(pts) {
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) s += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  return s;
}

// The part of a polyline between arc lengths s0 and s1
export function slicePts(pts, s0, s1) {
  const out = [];
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const az = pts[i + 1];
    const bx = pts[i + 2];
    const bz = pts[i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L > 1e-9 && s + L > s0 && s < s1) {
      const t0 = Math.max(0, (s0 - s) / L);
      const t1 = Math.min(1, (s1 - s) / L);
      if (!out.length) out.push(ax + (bx - ax) * t0, az + (bz - az) * t0);
      out.push(ax + (bx - ax) * t1, az + (bz - az) * t1);
    }
    s += L;
  }
  return out;
}

// Strip between lateral offsets o0..o1 (right positive) along the polyline; uv = (arc length + u0, offset + vShift)
function ribbon(layer, pts, o0, o1, y, { u0 = 0, vShift = 0 } = {}) {
  const n = pts.length / 2;
  if (n < 2) return;
  const nr = rightNormals(pts);
  let s = u0;
  for (let i = 0; i + 1 < n; i++) {
    const p = (k, o) => [pts[2 * k] + nr[k][0] * o, pts[2 * k + 1] + nr[k][1] * o];
    const L = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    layer.quad(p(i, o0), p(i + 1, o0), p(i + 1, o1), p(i, o1), y, [[s, o0 + vShift], [s + L, o0 + vShift], [s + L, o1 + vShift], [s, o1 + vShift]]);
    s += L;
  }
}

// Vertical face at lateral offset o along the polyline between heights y0 and y1
function wallStrip(layer, pts, o, y0, y1, u0 = 0) {
  const n = pts.length / 2;
  if (n < 2) return;
  const nr = rightNormals(pts);
  let s = u0;
  for (let i = 0; i + 1 < n; i++) {
    const L = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    layer.wall(
      [pts[2 * i] + nr[i][0] * o, pts[2 * i + 1] + nr[i][1] * o],
      [pts[2 * i + 2] + nr[i + 1][0] * o, pts[2 * i + 3] + nr[i + 1][1] * o],
      y0, y1, s, s + L
    );
    s += L;
  }
}

// A granite kerb: top between offsets o0..o1 at yTop, with vertical faces to yLow on the `low` side(s)
function kerbRun(layer, pts, o0, o1, yTop, yLowInner, yLowOuter, u0 = 0) {
  ribbon(layer, pts, o0, o1, yTop, { u0 });
  if (yLowInner != null) wallStrip(layer, pts, o0, yLowInner, yTop, u0);
  if (yLowOuter != null) wallStrip(layer, pts, o1, yLowOuter, yTop, u0);
}

// Dashes of `dash` m every `period` m, at lateral offset o
function dashed(layer, pts, o, w, dash, period, y) {
  const n = pts.length / 2;
  const nr = rightNormals(pts);
  let s = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[2 * i];
    const az = pts[2 * i + 1];
    const L = Math.hypot(pts[2 * i + 2] - ax, pts[2 * i + 3] - az);
    if (L < 1e-6) continue;
    const ux = (pts[2 * i + 2] - ax) / L;
    const uz = (pts[2 * i + 3] - az) / L;
    for (let t = 0; t < L;) {
      const phase = (s + t) % period;
      if (phase < dash) {
        const e = Math.min(L, t + dash - phase);
        const pt = (q, ww) => [ax + ux * q + nr[i][0] * (o + ww), az + uz * q + nr[i][1] * (o + ww)];
        layer.quad(pt(t, -w / 2), pt(e, -w / 2), pt(e, w / 2), pt(t, w / 2), y);
        t = e;
      } else t += period - phase;
    }
    s += L;
  }
}

function fillRing(layer, ring, y, holes) {
  const { pts, idx } = triangulatePolygon(ring, holes);
  const o = layer.pos.length / 3;
  for (let i = 0; i < pts.length; i += 2) {
    layer.pos.push(pts[i], y, pts[i + 1]);
    layer.uv.push(0, 0);
  }
  for (const t of idx) layer.idx.push(o + t);
}

const ringCentroid = (ring) => {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / n, z / n];
};

// Spatial hash over line segments: near(x, z, r) is true when some segment passes within r (its own radius added)
export function createSegmentIndex(cell = 16) {
  const hash = new Map();
  const add = (ax, az, bx, bz, r) => {
    const x0 = Math.floor((Math.min(ax, bx) - r) / cell);
    const x1 = Math.floor((Math.max(ax, bx) + r) / cell);
    const z0 = Math.floor((Math.min(az, bz) - r) / cell);
    const z1 = Math.floor((Math.max(az, bz) + r) / cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = ix * 100003 + iz;
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push([ax, az, bx, bz, r]);
      }
    }
  };
  return {
    addPolyline(pts, r) { for (let i = 0; i + 3 < pts.length; i += 2) add(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], r); },
    near(x, z, extra = 0) {
      for (const [ax, az, bx, bz, r] of hash.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []) {
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= r + extra) return true;
      }
      return false;
    }
  };
}

const cycleSides = (r) => ({ left: r.cycleTrack === 'left' || r.cycleTrack === 'both', right: r.cycleTrack === 'right' || r.cycleTrack === 'both' });

/** Carriageway list for the kerb frame (pavement-cph.js): centreline, half width and cycle-track sides. */
export function vehicularRoads(geo) {
  const out = [];
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    out.push({ pts: r.pts, half: carriagewayWidth(r) / 2, cycle: cycleSides(r) });
  }
  return out;
}

/** Index of the cycle tracks (road-side strips and KK cykelsti lines), for "is this point on a cycle track". */
export function cycleTrackIndex(geo) {
  const idx = createSegmentIndex();
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    const h = carriagewayWidth(r) / 2;
    const cs = cycleSides(r);
    const rn = rightNormals(r.pts);
    for (const [side, on] of [[1, cs.right], [-1, cs.left]]) {
      if (!on) continue;
      const c = h + KERB_W + CYCLE_W / 2;
      const off = [];
      for (let i = 0; i < rn.length; i++) off.push(r.pts[2 * i] + side * c * rn[i][0], r.pts[2 * i + 1] + side * c * rn[i][1]);
      idx.addPolyline(off, CYCLE_W / 2 + KERB_W);
    }
  }
  for (const c of geo.cycleTracks || []) if (c.pts && c.pts.length >= 4) idx.addPolyline(c.pts, (c.width || CYCLE_W) / 2);
  return idx;
}

// Side-street mouth layouts of a geodata set (memoised: the surface arrays, the pavement buckets and the height field
// all read the same layouts). Keyed by the roads array so a test geo is recomputed.
const layoutCache = new WeakMap();
export function mouthLayouts(geo) {
  let l = layoutCache.get(geo.roads);
  if (!l) {
    const sw = createSurfaceIndex((geo.sidewalks || []).map((s) => ({ ring: s.ring, cls: 'sidewalk' })));
    // how deep (m from a0) the pavement beside a mouth runs: probe just outside both edges of the side street
    const depth = (at, hS, a0) => {
      let last = a0;
      for (let a = a0; a <= a0 + 6; a += 0.25) {
        if ([-1, 1].some((sgn) => { const p = at(a, sgn * (hS + 0.5)); return sw.classAt(p[0], p[1]); })) last = a;
      }
      return last - a0 + 0.2;
    };
    l = computeMouthLayouts(geo.roads || [], { depth });
    layoutCache.set(geo.roads, l);
  }
  return l;
}

/**
 * Pavement + register-ground triangles (see pavement-cph.js), with the cycle tracks cut out of the pavement.
 * @returns {Map<string, object>} bucket per material class
 */
export function buildGroundBuckets(geo, surfacesDoc) {
  const cycles = cycleTrackIndex(geo);
  return buildPavementBuckets(geo, surfacesDoc, {
    roads: vehicularRoads(geo),
    y: SURFACE_Y.sidewalk,
    groundY: SURFACE_Y.ground,
    skip: (x, z) => cycles.near(x, z, -0.3),
    nearCycle: (x, z) => cycles.near(x, z, 6),
    extraPavement: [...mouthLayouts(geo).values()].flat().flatMap((m) => m.plateaus)
  });
}

/**
 * Walking height of the surface model above (SURFACE_Y: carriageway, cycle track, pavement, ramps) as a 0.5 m grid.
 * @returns {{ heightAt: (x: number, z: number) => number }}
 */
export function buildGroundHeightField(geo, surfaces = null) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const list of [geo.roads || [], geo.sidewalks || []]) {
    for (const it of list) {
      const a = it.pts || it.ring || [];
      for (let i = 0; i + 1 < a.length; i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); z0 = Math.min(z0, a[i + 1]); z1 = Math.max(z1, a[i + 1]); }
    }
  }
  if (!Number.isFinite(x0)) return { heightAt: () => 0 };
  const grid = createHeightGrid({ bbox: [x0 - 20, z0 - 20, x1 + 20, z1 + 20], cell: 0.5 });
  for (const s of surfaces?.surfaces || []) if (s.ring && s.cls !== 'grass') grid.polygon(s.ring, SURFACE_Y.ground, s.holes || []);
  for (const r of geo.roads || []) if (VEHICULAR.has(r.class) && r.pts?.length >= 4) grid.ribbon(r.pts, -carriagewayWidth(r) / 2, carriagewayWidth(r) / 2, SURFACE_Y.asphalt);
  for (const s of geo.sidewalks || []) grid.polygon(s.ring, SURFACE_Y.sidewalk);
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !(r.pts?.length >= 4)) continue;
    const h = carriagewayWidth(r) / 2;
    const cs = cycleSides(r);
    if (cs.right) grid.ribbon(r.pts, h + KERB_W, h + KERB_W + CYCLE_W, SURFACE_Y.cycle);
    if (cs.left) grid.ribbon(r.pts, -h - KERB_W - CYCLE_W, -h - KERB_W, SURFACE_Y.cycle);
  }
  for (const c of geo.cycleTracks || []) if (c.pts?.length >= 4) grid.ribbon(c.pts, -(c.width || CYCLE_W) / 2, (c.width || CYCLE_W) / 2, SURFACE_Y.cycle);
  for (const list of mouthLayouts(geo).values()) {
    for (const m of list) {
      for (const rp of m.ramps) grid.slope(rp.quad, rp.ys);
      for (const q of m.plateaus) grid.polygon(q, SURFACE_Y.sidewalk);
    }
  }
  return grid;
}

/**
 * @param {object} geo cph-geodata
 * @param {{ surfaces?: object|null, pavement?: boolean }} [opts] surfaces = data/cph-surfaces.json (markings);
 *   pavement = pavements are built elsewhere (omit the flat sidewalk layer)
 */
export function buildRoadSurfaceArrays(geo, { surfaces = null, pavement = false } = {}) {
  const asphalt = new Layer();
  const kerb = new Layer();
  const sidewalk = new Layer();
  const cycle = new Layer();
  const paint = new Layer();
  const blue = new Layer();

  // Real KK markings: which roads already have lane paint, and where blue crossings are
  const marks = (surfaces?.markings || []).filter((m) => RENDERED_MARKINGS.has(m.kind) && m.ring && m.ring.length >= 6);
  const painted = createSegmentIndex();
  const blueAt = [];
  for (const m of marks) {
    const [cx, cz] = ringCentroid(m.ring);
    if (m.kind === 'white' || m.kind === 'crossing') painted.addPolyline([cx, cz, cx, cz], 1);
    if (m.kind === 'bluecycle') blueAt.push([cx, cz]);
  }
  const blueNear = (x, z, r) => blueAt.some((b) => Math.hypot(b[0] - x, b[1] - z) <= r);

  // junctions: road ends shared by three or more carriageways
  const endCount = new Map();
  const endKey = (x, z) => `${Math.round(x * 2)}:${Math.round(z * 2)}`;
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    for (const [x, z] of [[r.pts[0], r.pts[1]], [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]]]) endCount.set(endKey(x, z), (endCount.get(endKey(x, z)) || 0) + 1);
  }
  const isJunction = (x, z) => (endCount.get(endKey(x, z)) || 0) >= 3;
  // widest carriageway meeting at each road end: a side street's kerb stops at the edge of the road it joins
  const endHalf = new Map();
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    for (const [x, z] of [[r.pts[0], r.pts[1]], [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]]]) {
      endHalf.set(endKey(x, z), Math.max(endHalf.get(endKey(x, z)) || 0, carriagewayWidth(r) / 2));
    }
  }

  const pavementY = SURFACE_Y.sidewalk;
  const layouts = mouthLayouts(geo);
  const roadIndex = new Map((geo.roads || []).map((r, i) => [r, i]));
  // pieces of [from, to] along a road that the mouths on `side` leave standing (kind: 'inner' | 'outer')
  const standing = (lay, side, kind, from, to) => subtractIntervals(to - from, lay.filter((m) => m.mouth.side === side && m[kind]).map((m) => [m[kind][0] - from, m[kind][1] - from]))
    .map(([a, b]) => [a + from, b + from]);
  const piecesOf = (pts, list, fn) => { for (const [a, b] of list) { const q = slicePts(pts, a, b); if (q.length >= 4) fn(q, a); } };
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    const w = carriagewayWidth(r);
    const h = w / 2;
    const L = polyLength(r.pts);
    const fwd = r.lanesFwd || 1;
    const back = r.oneway ? 0 : (r.lanesBack ?? 1);
    // lateral shift so that lane centres land on v = 1.5 + 3k (the asphalt shader paints wheel tracks there)
    const vShift = r.oneway && fwd % 2 === 1 ? 1.5 : 0;
    ribbon(asphalt, r.pts, -h, h, SURFACE_Y.asphalt, { vShift });
    const cs = cycleSides(r);
    const ri = roadIndex.get(r);
    const lay = layouts.get(ri) || [];
    const x0 = r.pts[0];
    const z0 = r.pts[1];
    const x1 = r.pts[r.pts.length - 2];
    const z1 = r.pts[r.pts.length - 1];
    const trim0 = isJunction(x0, z0) ? Math.min(JUNCTION_TRIM, L * 0.4) : 0;
    const trim1 = isJunction(x1, z1) ? Math.min(JUNCTION_TRIM, L * 0.4) : 0;
    const mid = trim0 || trim1 ? slicePts(r.pts, trim0, L - trim1) : r.pts;
    // plain kerbs stop at the edge of the road this one joins
    const kt0 = isJunction(x0, z0) ? Math.min((endHalf.get(endKey(x0, z0)) || 0) + 0.3, L * 0.4) : 0;
    const kt1 = isJunction(x1, z1) ? Math.min((endHalf.get(endKey(x1, z1)) || 0) + 0.3, L * 0.4) : 0;
    const kerbPts = kt0 || kt1 ? slicePts(r.pts, kt0, L - kt1) : r.pts;
    for (const [side, on] of [[1, cs.right], [-1, cs.left]]) {
      if (!on) {
        // kerb straight from the carriageway up to the pavement
        const a = side * h;
        piecesOf(r.pts, standing(lay, side, 'inner', kt0, L - kt1), (q, a0) => kerbRun(kerb, q, Math.min(a, a + side * KERB_W), Math.max(a, a + side * KERB_W), pavementY + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.asphalt : null, side > 0 ? null : SURFACE_Y.asphalt, a0));
        continue;
      }
      // road kerb (cycle-track height), the cycle track, the outer kerb (pavement height)
      const o1 = h + KERB_W;
      const o2 = o1 + CYCLE_W;
      const sd = (a, b) => (side > 0 ? [a, b] : [-b, -a]);
      const inner = standing(lay, side, 'inner', trim0, L - trim1);
      const outer = standing(lay, side, 'outer', trim0, L - trim1);
      piecesOf(r.pts, inner, (q, a0) => kerbRun(kerb, q, ...sd(h, o1), SURFACE_Y.cycle + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.asphalt : null, side > 0 ? null : SURFACE_Y.asphalt, a0));
      piecesOf(r.pts, outer, (q, a0) => {
        ribbon(cycle, q, ...sd(o1, o2), SURFACE_Y.cycle, { u0: a0 });
        kerbRun(kerb, q, ...sd(o2, o2 + KERB_W), pavementY + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.cycle : null, side > 0 ? null : SURFACE_Y.cycle, a0);
      });
      // white edge line along the carriageway side of the track
      piecesOf(r.pts, inner, (q) => ribbon(paint, q, ...sd(o1 + 0.12, o1 + 0.12 + 0.1), SURFACE_Y.cyclePaint));
      // blue through the junction crossing, where KK has no blue polygon there
      for (const [ts, te, jx, jz] of [[0, trim0, x0, z0], [L - trim1, L, x1, z1]]) {
        if (te - ts < 1 || blueNear(jx, jz, 25)) continue;
        ribbon(blue, slicePts(r.pts, ts, te), ...sd(h, o2), SURFACE_Y.asphalt + 0.012, { u0: ts });
      }
    }
    if (r.class === 'service' || w < 4) continue;
    // lane paint, white only; skipped where KK's own markings already cover the road
    let covered = 0;
    let samples = 0;
    for (let s = 0; s <= L; s += 12) {
      const q = slicePts(r.pts, Math.max(0, s - 0.01), Math.min(L, s + 0.01));
      if (q.length >= 2) { samples++; if (painted.near(q[0], q[1], h + 2)) covered++; }
    }
    if (samples && covered / samples > 0.4) continue;
    const edge = h - 0.3;
    if (r.class !== 'residential' || w >= 6) {
      for (const s of [-1, 1]) ribbon(paint, r.pts, s * edge - LINE_W / 2, s * edge + LINE_W / 2, SURFACE_Y.paint);
    }
    if (!r.oneway && back > 0) {
      dashed(paint, r.pts, 0, LINE_W, 3, 9, SURFACE_Y.paint);
      for (let k = 1; k < fwd; k++) dashed(paint, r.pts, k * LANE_W, LINE_W, 2, 6, SURFACE_Y.paint);
      for (let k = 1; k < back; k++) dashed(paint, r.pts, -k * LANE_W, LINE_W, 2, 6, SURFACE_Y.paint);
    } else if (r.oneway && fwd > 1) {
      for (let k = 1; k < fwd; k++) dashed(paint, r.pts, (k - fwd / 2) * LANE_W, LINE_W, 2, 6, SURFACE_Y.paint);
    }
  }

  // side-street mouths: kerb returns round the corners of through streets, ramps up to the raised crossings of the
  // small ones (their pavement-level plateaus are pavement-cph.js triangles)
  for (const list of layouts.values()) {
    for (const m of list) {
      for (const arc of m.arcs) {
        // the carriageway side of the arc: toward the junction centre
        const t = [arc[arc.length - 2] - arc[0], arc[arc.length - 1] - arc[1]];
        const toRoad = (-t[1]) * (m.mouth.x - arc[0]) + t[0] * (m.mouth.z - arc[1]);
        if (toRoad > 0) kerbRun(kerb, arc, -KERB_W, 0, pavementY + SURFACE_Y.kerbTop, null, SURFACE_Y.asphalt);
        else kerbRun(kerb, arc, 0, KERB_W, pavementY + SURFACE_Y.kerbTop, SURFACE_Y.asphalt, null);
      }
      for (const rp of m.ramps) {
        const q = [[rp.quad[0], rp.quad[1]], [rp.quad[2], rp.quad[3]], [rp.quad[4], rp.quad[5]], [rp.quad[6], rp.quad[7]]];
        asphalt.quadY(q, rp.ys);
      }
    }
  }

  for (const c of geo.cycleTracks || []) {
    if (!c.pts || c.pts.length < 4) continue;
    const hw = (c.width || CYCLE_W) / 2;
    ribbon(cycle, c.pts, -hw, hw, SURFACE_Y.cycle - 0.002);
  }
  if (!pavement) for (const s of geo.sidewalks || []) if (s.ring && s.ring.length >= 6) fillRing(sidewalk, s.ring, pavementY);

  // KK markings as decals on whichever surface they lie on
  if (marks.length) {
    const cycles = cycleTrackIndex(geo);
    for (const m of marks) {
      const [cx, cz] = ringCentroid(m.ring);
      const onCycle = cycles.near(cx, cz);
      const y = onCycle ? SURFACE_Y.cyclePaint : m.kind === 'bluecycle' ? SURFACE_Y.asphalt + 0.012 : SURFACE_Y.paint;
      fillRing(m.kind === 'bluecycle' ? blue : paint, m.ring, y, m.holes);
    }
  }

  const layers = { asphalt, kerb, cycle, paint };
  if (!pavement) layers.sidewalk = sidewalk;
  if (blue.vertexCount) layers.blue = blue;
  return layers;
}

export async function buildCphRoadSurfaces(scene, geo, { surfaces = null } = {}) {
  const THREE = await import('three/webgpu');
  const { createRoadSurfaceMaterials } = await import('./surface-materials-cph.js');
  const materials = createRoadSurfaceMaterials(THREE);
  const layers = buildRoadSurfaceArrays(geo, { surfaces, pavement: true });
  const group = new THREE.Group();
  group.name = 'CopenhagenRoadSurfaces';
  const stats = { pavementTriangles: 0, markings: surfaces?.markings?.length || 0 };

  const addMesh = (name, position, kuv, index, mat, extra = {}) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('kuv', new THREE.BufferAttribute(kuv, 2));
    if (extra.seed) g.setAttribute('seed', new THREE.BufferAttribute(extra.seed, 1));
    if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  for (const [name, layer] of Object.entries(layers)) {
    if (!layer.vertexCount) continue;
    const { position, kuv, index } = layer.arrays();
    addMesh(`road-${name}`, position, kuv, index, materials[name]);
  }

  // pavements and register ground: one mesh per material class, non-indexed (each triangle has its own frame)
  const buckets = buildGroundBuckets(geo, surfaces);
  for (const [key, bucket] of buckets) {
    if (!bucket.vertexCount) continue;
    const cls = key.replace('ground:', '');
    const mat = materials.ground[cls];
    if (!mat || key === 'ground:other') continue; // classes without a look (tree grates, ...) are not drawn
    const { position, kuv, seed } = bucket.arrays();
    addMesh(`ground-${key}`, position, kuv, null, mat, { seed });
    stats.pavementTriangles += bucket.vertexCount / 3;
  }
  scene.add(group);
  return { group, stats, groundHeight: buildGroundHeightField(geo, surfaces) };
}
