// js/road-surfaces-cph.js
// Copenhagen road surfaces from the compiled geodata (docs/cph-geodata-schema.md): asphalt carriageways, kerbs,
// sidewalk polygons, raised cycle tracks and Danish lane paint (white lines only, no yellow centrelines).
// Frame: x east, z south, y up. `buildRoadSurfaceArrays` is pure (no three.js) so it can be tested headless;
// `buildCphRoadSurfaces` turns the arrays into merged meshes.

import { carriagewayWidth } from './road-width-cph.js';

export const SURFACE_Y = { asphalt: 0.02, paint: 0.035, cycle: 0.09, kerb: 0.12, sidewalk: 0.15 };
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const KERB_W = 0.18;
const CYCLE_W = 2.2;
const LANE_W = 3.0;
const LINE_W = 0.12;

class Layer {
  constructor() { this.pos = []; this.idx = []; }
  quad(a, b, c, d, y) { // four (x, z) corners in order
    const o = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.pos.push(p[0], y, p[1]);
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  get vertexCount() { return this.pos.length / 3; }
  arrays() { return { position: new Float32Array(this.pos), index: new Uint32Array(this.idx) }; }
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

// Strip between lateral offsets o0..o1 (right positive) along the polyline
function ribbon(layer, pts, o0, o1, y) {
  const n = pts.length / 2;
  if (n < 2) return;
  const nr = rightNormals(pts);
  for (let i = 0; i + 1 < n; i++) {
    const p = (k, o) => [pts[2 * k] + nr[k][0] * o, pts[2 * k + 1] + nr[k][1] * o];
    layer.quad(p(i, o0), p(i + 1, o0), p(i + 1, o1), p(i, o1), y);
  }
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

function earClip(ring) {
  const n = ring.length / 2;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
  }
  const order = [...Array(n).keys()];
  if (area < 0) order.reverse();
  const P = (i) => [ring[2 * i], ring[2 * i + 1]];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const tris = [];
  let guard = n * n + 10;
  while (order.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < order.length; k++) {
      const a = order[(k + order.length - 1) % order.length];
      const b = order[k];
      const c = order[(k + 1) % order.length];
      const A = P(a);
      const B = P(b);
      const C = P(c);
      if (cross(A, B, C) <= 1e-9) continue;
      let inside = false;
      for (const q of order) {
        if (q === a || q === b || q === c) continue;
        const Q = P(q);
        if (cross(A, B, Q) >= 0 && cross(B, C, Q) >= 0 && cross(C, A, Q) >= 0) { inside = true; break; }
      }
      if (inside) continue;
      tris.push(a, b, c);
      order.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate ring: drop the remainder
  }
  if (order.length === 3) tris.push(order[0], order[1], order[2]);
  return tris;
}

function fillRing(layer, ring, y) {
  const o = layer.pos.length / 3;
  for (let i = 0; i < ring.length; i += 2) layer.pos.push(ring[i], y, ring[i + 1]);
  for (const t of earClip(ring)) layer.idx.push(o + t);
}

export function buildRoadSurfaceArrays(geo) {
  const asphalt = new Layer();
  const kerb = new Layer();
  const sidewalk = new Layer();
  const cycle = new Layer();
  const paint = new Layer();

  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4) continue;
    const w = carriagewayWidth(r);
    const h = w / 2;
    ribbon(asphalt, r.pts, -h, h, SURFACE_Y.asphalt);
    for (const s of [-1, 1]) ribbon(kerb, r.pts, s * h, s * (h + KERB_W), SURFACE_Y.kerb);
    // cycle track strips beside the carriageway
    const ct = r.cycleTrack;
    for (const [side, key] of [[1, 'right'], [-1, 'left']]) {
      if (ct === key || ct === 'both') {
        const c = h + KERB_W + CYCLE_W / 2;
        ribbon(cycle, r.pts, side * (c - CYCLE_W / 2), side * (c + CYCLE_W / 2), SURFACE_Y.cycle);
      }
    }
    if (r.class === 'service' || w < 4) continue;
    // lane paint, white only
    const fwd = r.lanesFwd || 1;
    const back = r.oneway ? 0 : (r.lanesBack ?? 1);
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

  for (const c of geo.cycleTracks || []) {
    if (!c.pts || c.pts.length < 4) continue;
    const hw = (c.width || CYCLE_W) / 2;
    ribbon(cycle, c.pts, -hw, hw, SURFACE_Y.cycle);
  }
  for (const s of geo.sidewalks || []) if (s.ring && s.ring.length >= 6) fillRing(sidewalk, s.ring, SURFACE_Y.sidewalk);

  return { asphalt, kerb, sidewalk, cycle, paint };
}

const COLORS = { asphalt: 0x3a3c3f, kerb: 0xb4b2ac, sidewalk: 0x9a9892, cycle: 0xa8523f, paint: 0xf2f2ee };

export async function buildCphRoadSurfaces(scene, geo) {
  const THREE = await import('three/webgpu');
  const layers = buildRoadSurfaceArrays(geo);
  const group = new THREE.Group();
  group.name = 'CopenhagenRoadSurfaces';
  for (const [name, layer] of Object.entries(layers)) {
    if (!layer.vertexCount) continue;
    const { position, index } = layer.arrays();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardNodeMaterial({ color: COLORS[name], roughness: name === 'paint' ? 0.7 : 0.92, metalness: 0, side: THREE.DoubleSide });
    if (name === 'paint') { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2; }
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `road-${name}`;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  scene.add(group);
  return { group };
}
