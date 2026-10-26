// js/road-surfaces-cph.js
// Copenhagen road surfaces from the compiled geodata (docs/cph-geodata-schema.md): dark asphalt carriageways, granite
// kerbs (as geometry), raised dark-asphalt cycle tracks one kerb step above the carriageway and one below the pavement,
// white lane paint, and the KK road markings (data/cph-surfaces.json: crossings, arrows, bays, blue cycle crossings,
// red bus lanes and yellow kerb lines). Pavements are built by pavement-cph.js from the same road list.
// Frame: x east, z south, y up. `buildRoadSurfaceArrays` is pure (no three.js) so it can be tested headless;
// `buildCphRoadSurfaces` turns the arrays into merged meshes.

import { carriagewayWidth, movingHalfWidth, cycleStrips, intersectIntervals, subtractIntervalLists, slicePts, rightNormals, KERB_W, CYCLE_W } from './road-width-cph.js';
import { triangulatePolygon, pointInRing } from './polygon-cph.js';
import { buildPavementBuckets, createSurfaceIndex } from './pavement-cph.js';
import { createHeightGrid, composeHeightField } from './ground-height-cph.js';
import { densifyPts, drapePositions } from './terrain-cph.js';
import { computeMouthLayouts, subtractIntervals } from './junction-mouths-cph.js';
import { hasContraflow, bikeBanned, stripCoverage, stripDirection } from './bike-direction.js';

// Heights (m): carriageway -> (10 cm kerb) -> cycle track -> (8 cm kerb) -> pavement
export const SURFACE_Y = { asphalt: 0.02, paint: 0.035, cycle: 0.12, cyclePaint: 0.128, kerbTop: 0.002, sidewalk: 0.2, ground: 0.014 };
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const LANE_W = 3.0;
export const ROAD_PAINT = Object.freeze({ lineWidth: 0.1, parkingEdgeWidth: 0.3, cycleLaneWidth: 0.3, dashLength: 2.5, dashPeriod: 7.5 });
const LINE_W = ROAD_PAINT.lineWidth;
const JUNCTION_TRIM = 7; // m of cycle track before a junction that is painted blue (the crossing)
const DRAPE_STEP = 6; // m: ribbons are split to this length when they follow terrain
const RENDERED_MARKINGS = new Set(['white', 'crossing', 'arrow', 'symbol', 'bay', 'bump', 'bluecycle', 'red', 'yellow']);

class Layer {
  // `terrain`: the ground model the layer is draped on (js/terrain-cph.js); y values given to the builders are offsets above it
  constructor(terrain = null) { this.pos = []; this.idx = []; this.uv = []; this.terrain = terrain && !terrain.flat ? terrain : null; }
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
  arrays() { return { position: drapePositions(new Float32Array(this.pos), this.terrain), kuv: new Float32Array(this.uv), index: new Uint32Array(this.idx) }; }
}

function polyLength(pts) {
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) s += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  return s;
}

export { slicePts };

// Strip between lateral offsets o0..o1 (right positive) along the polyline; uv = (arc length + u0, offset + vShift)
function ribbon(layer, pts, o0, o1, y, { u0 = 0, vShift = 0 } = {}) {
  if (layer.terrain) pts = densifyPts(pts, DRAPE_STEP); // long quads would cut across the terrain
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
  if (layer.terrain) pts = densifyPts(pts, DRAPE_STEP);
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

const KERB_CLIP_STEP = 0.25; // m between the samples that test a kerb line against the carriageways
const KERB_CLIP_DEPTH = 0.05; // m: a kerb whose centre line is deeper than this inside a carriageway is not drawn there
const KERB_MIN_PIECE = 0.3; // m: shorter kerb pieces left between two carriageways are dropped

/**
 * The arc-length pieces [[s0, s1], ...] of the kerb line at lateral offset o along pts that do not lie inside a
 * carriageway (`depthAt` of createCarriagewayIndex). Offsets are interpolated per segment exactly as `ribbon` draws them.
 */
export function kerbPiecesOutside(pts, o, depthAt, step = KERB_CLIP_STEP) {
  const nr = rightNormals(pts);
  const buried = [];
  const vs = [0]; // arc length at each vertex
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const k = i / 2;
    const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    vs.push(vs[vs.length - 1] + L);
    if (L < 1e-9) continue;
    const ax = pts[i] + nr[k][0] * o;
    const az = pts[i + 1] + nr[k][1] * o;
    const bx = pts[i + 2] + nr[k + 1][0] * o;
    const bz = pts[i + 3] + nr[k + 1][1] * o;
    const n = Math.max(1, Math.ceil(Math.max(L, Math.hypot(bx - ax, bz - az)) / step)); // the offset line is longer round a bend
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      if (depthAt(ax + (bx - ax) * t, az + (bz - az) * t) <= KERB_CLIP_DEPTH) continue;
      const at = s + L * t;
      // a short segment whose offset swings far (a sharp bend, a stub at a road end) is cut whole
      const half = Math.max(L / n / 2, step / 2);
      const last = buried[buried.length - 1];
      if (last && at - half <= last[1] + 1e-9) last[1] = Math.max(last[1], at + half);
      else buried.push([at - half, at + half]);
    }
    s += L;
  }
  // a cut that ends just short of a vertex would leave a stub whose far end takes that vertex's (bend) normal: cut to the vertex
  const snap = (a, dir) => {
    for (const v of vs) if (v > 0 && v < s && (v - a) * dir > 0 && Math.abs(v - a) < step) return v;
    return a;
  };
  return subtractIntervalLists([[0, s]], buried)
    .map(([a, b]) => [a > 0 ? snap(a, 1) : a, b < s ? snap(b, -1) : b])
    .filter(([a, b]) => b - a >= KERB_MIN_PIECE);
}

// A granite kerb: top between offsets o0..o1 at yTop, with vertical faces to yLow on the `low` side(s). A kerb stands
// between a carriageway and what is beside it, so where its line runs inside a carriageway (its own on the inside of a
// tight bend, another road's at a junction, a side-street mouth, a dual carriageway or an overlapping road) it is cut:
// `layer.clip` is the carriageway index.
function kerbRun(layer, pts, o0, o1, yTop, yLowInner, yLowOuter, u0 = 0, tag = null, pass = 0) {
  if (layer.clip && pass < 8) {
    const L = polyLength(pts);
    const pieces = kerbPiecesOutside(pts, (o0 + o1) / 2, layer.clip.depthAt);
    if (!(pieces.length === 1 && pieces[0][0] <= 1e-6 && pieces[0][1] >= L - 1e-6)) {
      // a sliced piece gets its own end normals (slicePts + rightNormals), so it is tested again as drawn
      for (const [a, b] of pieces) {
        const q = slicePts(pts, a, b);
        if (q.length >= 4) kerbRun(layer, q, o0, o1, yTop, yLowInner, yLowOuter, u0 + a, tag, pass + 1);
      }
      return;
    }
  }
  if (layer.runs) layer.runs.push({ pts, o0, o1, ...tag }); // the kerb lines as drawn, for audits and tests
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


/**
 * The asphalt carriageways as the engine draws them (the same per-vertex quads as `ribbon(asphalt, r.pts, -h, h)`), for
 * "how deep inside a carriageway is this point". depthAt(x, z) = the largest distance to the side edges (the kerb lines)
 * of any carriageway quad that contains the point, 0 when it is on no carriageway.
 */
export function createCarriagewayIndex(roads, cell = 16) {
  const hash = new Map();
  for (const r of roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    const h = carriagewayWidth(r) / 2;
    const nr = rightNormals(r.pts);
    for (let i = 0; i + 1 < r.pts.length / 2; i++) {
      const p = (k, o) => [r.pts[2 * k] + nr[k][0] * o, r.pts[2 * k + 1] + nr[k][1] * o];
      const q = [p(i, -h), p(i + 1, -h), p(i + 1, h), p(i, h)];
      const xs = q.map((c) => c[0]);
      const zs = q.map((c) => c[1]);
      const item = { q, road: r };
      for (let ix = Math.floor(Math.min(...xs) / cell); ix <= Math.floor(Math.max(...xs) / cell); ix++) {
        for (let iz = Math.floor(Math.min(...zs) / cell); iz <= Math.floor(Math.max(...zs) / cell); iz++) {
          const k = ix * 100003 + iz;
          if (!hash.has(k)) hash.set(k, []);
          hash.get(k).push(item);
        }
      }
    }
  }
  const segDist = (x, z, a, b) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
  };
  const inside = (q, x, z) => {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      if ((q[i][1] > z) !== (q[j][1] > z) && x < ((q[j][0] - q[i][0]) * (z - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) c = !c;
    }
    return c;
  };
  /** @returns {{ depth: number, road: object|null }} */
  const at = (x, z) => {
    let best = { depth: 0, road: null };
    for (const it of hash.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []) {
      if (!inside(it.q, x, z)) continue;
      const d = Math.min(segDist(x, z, it.q[0], it.q[1]), segDist(x, z, it.q[3], it.q[2]));
      if (d > best.depth) best = { depth: d, road: it.road };
    }
    return best;
  };
  return { at, depthAt: (x, z) => at(x, z).depth };
}

// ---- contraflow cycle lanes: a solid white line 1.5 m in from the left kerb of a one-way street and a bicycle pictogram
// every SYMBOL_EVERY m, upright for a rider coming towards the cars --------------------------------------------------------
const CONTRA_LANE_W = 1.5;
const SYMBOL_EVERY = 16;

// a thick line a-b (world x, z) as one quad
function thickLine(layer, a, b, w, y) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2);
  const nz = (dx / l) * (w / 2);
  layer.quad([a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz], [a[0] + nx, a[1] + nz], y);
}

function busText(layer, cx, cz, ux, uz, y, scale = 1) {
  // BUS reads across the lane; the glyph height runs along traffic. Stretch the
  // strokes to fill a realistic ~2 m x 2 m road marking.
  const vx = -uz;
  const vz = ux;
  const P = (u, v) => [cx + vx * (u - 0.68) * 1.5 * scale + ux * (v - 0.26) * 4 * scale,
    cz + vz * (u - 0.68) * 1.5 * scale + uz * (v - 0.26) * 4 * scale];
  const W = 0.075 * scale;
  const stroke = (a, b) => thickLine(layer, P(...a), P(...b), W, y);
  const B = [[0, 0, 0, 0.52], [0, 0.52, 0.25, 0.52], [0.25, 0.52, 0.34, 0.44], [0.34, 0.44, 0.34, 0.32], [0.34, 0.32, 0.25, 0.26], [0.25, 0.26, 0, 0.26], [0.25, 0.26, 0.36, 0.19], [0.36, 0.19, 0.36, 0.08], [0.36, 0.08, 0.25, 0], [0.25, 0, 0, 0]];
  const U = [[0, 0.52, 0, 0.1], [0, 0.1, 0.09, 0], [0.09, 0, 0.27, 0], [0.27, 0, 0.36, 0.1], [0.36, 0.1, 0.36, 0.52]];
  const S = [[0.36, 0.52, 0.1, 0.52], [0.1, 0.52, 0, 0.43], [0, 0.43, 0, 0.34], [0, 0.34, 0.36, 0.18], [0.36, 0.18, 0.36, 0.09], [0.36, 0.09, 0.26, 0], [0.26, 0, 0, 0]];
  for (const [x, glyph] of [[0, B], [0.5, U], [1.0, S]]) for (const [ax, az, bx, bz] of glyph) stroke([ax + x, az], [bx + x, bz]);
}

function fitsMarking(ring, holes, cx, cz, ux, uz, acrossHalf, alongHalf) {
  const vx = -uz;
  const vz = ux;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const across = (i / 4 - 1) * acrossHalf;
    const along = (j / 4 - 1) * alongHalf;
    const x = cx + vx * across + ux * along;
    const z = cz + vz * across + uz * along;
    if (!pointInRing(ring, x, z) || holes?.some((hole) => pointInRing(hole, x, z))) return false;
  }
  return true;
}

function fittingScale(ring, holes, cx, cz, ux, uz, halfWidthAtOne, halfDepthAtOne, requested = 0.9) {
  for (let scale = requested; scale >= 0.4; scale -= 0.05) {
    if (fitsMarking(ring, holes, cx, cz, ux, uz, halfWidthAtOne * scale, halfDepthAtOne * scale)) return scale;
  }
  return 0;
}

function nearestRoadPose(geo, x, z) {
  let best = null;
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i]; const az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax; const dz = r.pts[i + 3] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * t; const pz = az + dz * t;
      const distance = Math.hypot(px - x, pz - z);
      if (distance < (best?.distance ?? Infinity)) {
        const length = Math.sqrt(l2);
        const ux = dx / length; const uz = dz / length;
        const side = (x - px) * -uz + (z - pz) * ux;
        best = { road: r, ux, uz, side, distance };
      }
    }
  }
  return best;
}

function longestAxis(ring) {
  let best = [1, 0];
  let longest = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const dx = ring[j] - ring[i];
    const dz = ring[j + 1] - ring[i + 1];
    const l = Math.hypot(dx, dz);
    if (l > longest) { longest = l; best = [dx / l, dz / l]; }
  }
  return best;
}

/** A bicycle pictogram in side view laid on the road at (cx, cz); (ux, uz) is the way the rider travels. */
export function bikeSymbol(layer, cx, cz, ux, uz, y, scale = 1) {
  const vx = -uz; // "up" of the pictogram: to the rider's right
  const vz = ux;
  const P = (u, v) => [cx + (ux * u + vx * v) * scale, cz + (uz * u + vz * v) * scale];
  const W = 0.055 * scale;
  const ring = (u0) => {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + 1) / n) * Math.PI * 2;
      thickLine(layer, P(u0 + Math.cos(t0) * 0.21, Math.sin(t0) * 0.21), P(u0 + Math.cos(t1) * 0.21, Math.sin(t1) * 0.21), W, y);
    }
  };
  ring(-0.42);
  ring(0.42);
  const rear = [-0.42, 0];
  const bb = [-0.04, 0];
  const seat = [-0.2, 0.36];
  const head = [0.24, 0.38];
  const front = [0.42, 0];
  for (const [a, b] of [[rear, bb], [rear, seat], [seat, bb], [seat, head], [bb, head], [head, front], [head, [0.18, 0.5]], [[-0.26, 0.4], [-0.12, 0.4]]]) thickLine(layer, P(...a), P(...b), W, y);
}

const cycleSides = (r) => {
  const c = cycleStrips(r);
  return { left: c.some((x) => x.side < 0), right: c.some((x) => x.side > 0) };
};

/** The pieces of the cycle strips of a road: [{ pts (the slice of the centreline), side, w }]. */
function stripPieces(r) {
  const out = [];
  for (const c of cycleStrips(r)) {
    if (!c.ranges) { out.push({ pts: r.pts, side: c.side, w: c.w }); continue; }
    for (const [a, b] of c.ranges) {
      const q = slicePts(r.pts, a, b);
      if (q.length >= 4) out.push({ pts: q, side: c.side, w: c.w });
    }
  }
  return out;
}

/** Carriageway list for the kerb frame (pavement-cph.js): centreline, half width and cycle strips. */
export function vehicularRoads(geo) {
  const out = [];
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    const strips = cycleStrips(r);
    out.push({ pts: r.pts, half: carriagewayWidth(r) / 2, cycle: cycleSides(r), strips });
  }
  return out;
}

/** Index of the cycle tracks (road-side strips and KK cykelsti lines), for "is this point on a cycle track". */
export function cycleTrackIndex(geo) {
  const idx = createSegmentIndex();
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    const h = carriagewayWidth(r) / 2;
    for (const piece of stripPieces(r)) {
      const rn = rightNormals(piece.pts);
      const c = h + KERB_W + piece.w / 2;
      const off = [];
      for (let i = 0; i < rn.length; i++) off.push(piece.pts[2 * i] + piece.side * c * rn[i][0], piece.pts[2 * i + 1] + piece.side * c * rn[i][1]);
      idx.addPolyline(off, piece.w / 2 + KERB_W);
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
export function buildGroundBuckets(geo, surfacesDoc, terrain = null) {
  const cycles = cycleTrackIndex(geo);
  return buildPavementBuckets(geo, surfacesDoc, {
    roads: vehicularRoads(geo),
    y: SURFACE_Y.sidewalk,
    groundY: SURFACE_Y.ground,
    skip: (x, z) => cycles.near(x, z, -0.3),
    nearCycle: (x, z) => cycles.near(x, z, 6),
    extraPavement: [...mouthLayouts(geo).values()].flat().flatMap((m) => m.plateaus),
    terrain
  });
}

/**
 * Walking height of the surface model above (SURFACE_Y: carriageway, cycle track, pavement, ramps) as a 0.5 m grid.
 * @returns {{ heightAt: (x: number, z: number) => number }}
 */
export function buildGroundHeightField(geo, surfaces = null, terrain = null) {
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
  if (!Number.isFinite(x0)) return composeHeightField(terrain, { heightAt: () => 0 });
  const grid = createHeightGrid({ bbox: [x0 - 20, z0 - 20, x1 + 20, z1 + 20], cell: 0.5 });
  for (const s of surfaces?.surfaces || []) if (s.ring && s.cls !== 'grass') grid.polygon(s.ring, SURFACE_Y.ground, s.holes || []);
  for (const r of geo.roads || []) if (VEHICULAR.has(r.class) && r.pts?.length >= 4 && !r.drop) grid.ribbon(r.pts, -carriagewayWidth(r) / 2, carriagewayWidth(r) / 2, SURFACE_Y.asphalt);
  for (const s of geo.sidewalks || []) grid.polygon(s.ring, SURFACE_Y.sidewalk);
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !(r.pts?.length >= 4) || r.drop) continue;
    const h = carriagewayWidth(r) / 2;
    for (const piece of stripPieces(r)) {
      if (piece.side > 0) grid.ribbon(piece.pts, h + KERB_W, h + KERB_W + piece.w, SURFACE_Y.cycle);
      else grid.ribbon(piece.pts, -h - KERB_W - piece.w, -h - KERB_W, SURFACE_Y.cycle);
    }
  }
  for (const c of geo.cycleTracks || []) if (c.pts?.length >= 4) grid.ribbon(c.pts, -(c.width || CYCLE_W) / 2, (c.width || CYCLE_W) / 2, SURFACE_Y.cycle);
  for (const list of mouthLayouts(geo).values()) {
    for (const m of list) {
      for (const rp of m.ramps) grid.slope(rp.quad, rp.ys);
      for (const q of m.plateaus) grid.polygon(q, SURFACE_Y.sidewalk);
    }
  }
  return composeHeightField(terrain, grid);
}

/**
 * @param {object} geo cph-geodata
 * @param {{ surfaces?: object|null, pavement?: boolean, terrain?: object|null }} [opts] surfaces = data/cph-surfaces.json (markings);
 *   pavement = pavements are built elsewhere (omit the flat sidewalk layer); terrain = js/terrain-cph.js (layers are draped on it);
 *   clipKerbs = false keeps the kerb lines that run inside carriageways (for before/after audits only)
 */
export function buildRoadSurfaceArrays(geo, { surfaces = null, pavement = false, terrain = null, clipKerbs = true } = {}) {
  const asphalt = new Layer(terrain);
  const kerb = new Layer(terrain);
  kerb.runs = [];
  kerb.clip = clipKerbs ? createCarriagewayIndex(geo.roads) : null;
  const sidewalk = new Layer(terrain);
  const cycle = new Layer(terrain);
  const paint = new Layer(terrain);
  const blue = new Layer(terrain);
  const red = new Layer(terrain);
  const yellow = new Layer(terrain);

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
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    for (const [x, z] of [[r.pts[0], r.pts[1]], [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]]]) endCount.set(endKey(x, z), (endCount.get(endKey(x, z)) || 0) + 1);
  }
  const isJunction = (x, z) => (endCount.get(endKey(x, z)) || 0) >= 3;
  // widest carriageway meeting at each road end: a side street's kerb stops at the edge of the road it joins
  const endHalf = new Map();
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
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
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    const w = carriagewayWidth(r);
    const h = w / 2;
    const L = polyLength(r.pts);
    const fwd = r.lanesFwd || 1;
    const back = r.oneway ? 0 : (r.lanesBack ?? 1);
    // lateral shift so that lane centres land on v = 1.5 + 3k (the asphalt shader paints wheel tracks there)
    const vShift = r.oneway && fwd % 2 === 1 ? 1.5 : 0;
    ribbon(asphalt, r.pts, -h, h, SURFACE_Y.asphalt, { vShift });
    const strips = cycleStrips(r);
    const ri = roadIndex.get(r);
    const lay = layouts.get(ri) || [];
    const x0 = r.pts[0];
    const z0 = r.pts[1];
    const x1 = r.pts[r.pts.length - 2];
    const z1 = r.pts[r.pts.length - 1];
    const trim0 = isJunction(x0, z0) ? Math.min(JUNCTION_TRIM, L * 0.4) : 0;
    const trim1 = isJunction(x1, z1) ? Math.min(JUNCTION_TRIM, L * 0.4) : 0;
    // plain kerbs stop at the edge of the road this one joins
    const kt0 = isJunction(x0, z0) ? Math.min((endHalf.get(endKey(x0, z0)) || 0) + 0.3, L * 0.4) : 0;
    const kt1 = isJunction(x1, z1) ? Math.min((endHalf.get(endKey(x1, z1)) || 0) + 0.3, L * 0.4) : 0;
    for (const side of [1, -1]) {
      const sp = strips.find((c) => c.side === side) || null;
      const ranges = sp ? (sp.ranges || [[0, L]]) : [];
      // kerb straight from the carriageway up to the pavement: everywhere there is no cycle strip (and, beside a strip,
      // not in the junction ends, where the blue crossing runs)
      const a = side * h;
      const plain = subtractIntervalLists(standing(lay, side, 'inner', kt0, L - kt1), sp ? [...ranges, [0, trim0], [L - trim1, L]] : []);
      piecesOf(r.pts, plain, (q, a0) => kerbRun(kerb, q, Math.min(a, a + side * KERB_W), Math.max(a, a + side * KERB_W), pavementY + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.asphalt : null, side > 0 ? null : SURFACE_Y.asphalt, a0, { road: r, side, kind: 'plain' }));
      if (!sp) continue;
      // road kerb (cycle-track height), the cycle track, the outer kerb (pavement height)
      const o1 = h + KERB_W;
      const o2 = o1 + sp.w;
      const sd = (p, q) => (side > 0 ? [p, q] : [-q, -p]);
      const inner = intersectIntervals(standing(lay, side, 'inner', trim0, L - trim1), ranges);
      const outer = intersectIntervals(standing(lay, side, 'outer', trim0, L - trim1), ranges);
      piecesOf(r.pts, inner, (q, a0) => kerbRun(kerb, q, ...sd(h, o1), SURFACE_Y.cycle + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.asphalt : null, side > 0 ? null : SURFACE_Y.asphalt, a0, { road: r, side, kind: 'inner' }));
      piecesOf(r.pts, outer, (q, a0) => {
        ribbon(cycle, q, ...sd(o1, o2), SURFACE_Y.cycle, { u0: a0 });
        kerbRun(kerb, q, ...sd(o2, o2 + KERB_W), pavementY + SURFACE_Y.kerbTop, side > 0 ? SURFACE_Y.cycle : null, side > 0 ? null : SURFACE_Y.cycle, a0, { road: r, side, kind: 'outer' });
      });
      // The raised cycle track keeps a narrow edge line; painted lanes below use a broad separator.
      piecesOf(r.pts, inner, (q) => ribbon(paint, q, ...sd(o1 + 0.12, o1 + 0.12 + LINE_W), SURFACE_Y.cyclePaint));
      // blue through the junction crossing, where KK has no blue polygon there
      for (const [ts, te, jx, jz] of [[0, trim0, x0, z0], [L - trim1, L, x1, z1]]) {
        if (te - ts < 1 || blueNear(jx, jz, 25) || !ranges.length) continue;
        ribbon(blue, slicePts(r.pts, ts, te), ...sd(h, o2), SURFACE_Y.asphalt + 0.012, { u0: ts });
        const q = slicePts(r.pts, (ts + te) / 2 - 0.6, (ts + te) / 2 + 0.6);
        if (q.length >= 4) {
          const dx = q[q.length - 2] - q[0];
          const dz = q[q.length - 1] - q[1];
          const len = Math.hypot(dx, dz) || 1;
          const mx = (q[0] + q[q.length - 2]) / 2;
          const mz = (q[1] + q[q.length - 1]) / 2;
          const off = side * (h + o2) / 2;
          const nr = [-dz / len, dx / len];
          const riding = stripDirection(r, side) === 'back' ? -1 : 1;
          bikeSymbol(paint, mx + nr[0] * off, mz + nr[1] * off, (dx / len) * riding, (dz / len) * riding, SURFACE_Y.paint, 0.82);
        }
      }
    }
    // a contraflow cycle lane on a one-way street: solid line and pictograms at the left edge, the rider coming towards us
    if (hasContraflow(r) && !bikeBanned(r) && (r.bike.contraKind === 'lane' || r.bike.contraKind === 'track') && !stripCoverage(r, strips).back && L > 14) {
      const lineV = -(h - CONTRA_LANE_W);
      const body = slicePts(r.pts, 4, L - 4);
      ribbon(paint, body, lineV - ROAD_PAINT.cycleLaneWidth / 2, lineV + ROAD_PAINT.cycleLaneWidth / 2, SURFACE_Y.paint);
      const nSym = Math.max(1, Math.floor((L - 8) / SYMBOL_EVERY));
      for (let k = 0; k < nSym; k++) {
        const sAt = 4 + ((L - 8) * (k + 0.5)) / nSym;
        const q = slicePts(r.pts, sAt - 0.6, sAt + 0.6);
        if (q.length < 4) continue;
        const tx = q[q.length - 2] - q[0];
        const tz = q[q.length - 1] - q[1];
        const tl = Math.hypot(tx, tz) || 1;
        const mx = (q[0] + q[q.length - 2]) / 2;
        const mz = (q[1] + q[q.length - 1]) / 2;
        const off = -(h - CONTRA_LANE_W / 2);
        bikeSymbol(paint, mx + (-tz / tl) * off, mz + (tx / tl) * off, -tx / tl, -tz / tl, SURFACE_Y.paint);
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
    // Where the carriageway leaves a parking strip beside moving traffic, mark that inner parking boundary clearly.
    const moving = movingHalfWidth(r);
    if (h - moving >= 1.9) for (const s of [-1, 1]) {
      ribbon(paint, r.pts, s * moving - ROAD_PAINT.parkingEdgeWidth / 2, s * moving + ROAD_PAINT.parkingEdgeWidth / 2, SURFACE_Y.paint);
    }
    if (!r.oneway && back > 0) {
      dashed(paint, r.pts, 0, LINE_W, ROAD_PAINT.dashLength, ROAD_PAINT.dashPeriod, SURFACE_Y.paint);
      for (let k = 1; k < fwd; k++) dashed(paint, r.pts, k * LANE_W, LINE_W, ROAD_PAINT.dashLength, ROAD_PAINT.dashPeriod, SURFACE_Y.paint);
      for (let k = 1; k < back; k++) dashed(paint, r.pts, -k * LANE_W, LINE_W, ROAD_PAINT.dashLength, ROAD_PAINT.dashPeriod, SURFACE_Y.paint);
    } else if (r.oneway && fwd > 1) {
      for (let k = 1; k < fwd; k++) dashed(paint, r.pts, (k - fwd / 2) * LANE_W, LINE_W, ROAD_PAINT.dashLength, ROAD_PAINT.dashPeriod, SURFACE_Y.paint);
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
        if (toRoad > 0) kerbRun(kerb, arc, -KERB_W, 0, pavementY + SURFACE_Y.kerbTop, null, SURFACE_Y.asphalt, 0, { road: geo.roads[m.mouth.road], kind: 'arc', through: m.mouth });
        else kerbRun(kerb, arc, 0, KERB_W, pavementY + SURFACE_Y.kerbTop, SURFACE_Y.asphalt, null, 0, { road: geo.roads[m.mouth.road], kind: 'arc', through: m.mouth });
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
      const target = m.kind === 'bluecycle' ? blue : m.kind === 'red' ? red : m.kind === 'yellow' ? yellow : paint;
      fillRing(target, m.ring, y, m.holes);
      if (m.kind === 'bluecycle') {
        const axis = longestAxis(m.ring);
        const near = nearestRoadPose(geo, cx, cz);
        let ux = axis[0]; let uz = axis[1];
        if (near && near.distance < 30) {
          const sign = stripDirection(near.road, near.side) === 'back' ? -1 : 1;
          ux = near.ux * sign; uz = near.uz * sign;
        }
        const scale = fittingScale(m.ring, m.holes, cx, cz, ux, uz, 0.55, 0.67, 0.88);
        if (scale) bikeSymbol(paint, cx, cz, ux, uz, y + 0.003, scale);
      } else if (m.kind === 'red') {
        const [ux, uz] = longestAxis(m.ring);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < m.ring.length; i += 2) {
          const d = (m.ring[i] - cx) * ux + (m.ring[i + 1] - cz) * uz;
          lo = Math.min(lo, d); hi = Math.max(hi, d);
        }
        const count = Math.max(1, Math.floor((hi - lo) / 18));
        for (let k = 0; k < count; k++) {
          const d = count === 1 ? 0 : lo + (hi - lo) * (k + 0.5) / count;
          const tx = cx + ux * d;
          const tz = cz + uz * d;
          const scale = fittingScale(m.ring, m.holes, tx, tz, ux, uz, 0.68 * 1.5, 0.26 * 4, 0.9);
          if (scale) busText(paint, tx, tz, ux, uz, y + 0.003, scale);
        }
      }
    }
  }

  const layers = { asphalt, kerb, cycle, paint };
  if (!pavement) layers.sidewalk = sidewalk;
  if (blue.vertexCount) layers.blue = blue;
  if (red.vertexCount) layers.red = red;
  if (yellow.vertexCount) layers.yellow = yellow;
  return layers;
}

export async function buildCphRoadSurfaces(scene, geo, { surfaces = null, terrain = null } = {}) {
  const THREE = await import('three/webgpu');
  const { createRoadSurfaceMaterials } = await import('./surface-materials-cph.js');
  const materials = createRoadSurfaceMaterials(THREE);
  const layers = buildRoadSurfaceArrays(geo, { surfaces, pavement: true, terrain });
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
  const buckets = buildGroundBuckets(geo, surfaces, terrain);
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
  return { group, stats, groundHeight: buildGroundHeightField(geo, surfaces, terrain), terrain };
}
