// js/polygon-cph.js
import earcut from './earcut.js';

// Small pure polygon helpers shared by the ground-surface builders (flat [x0, z0, x1, z1, ...] rings, x east, z south).

/**
 * Triangulate a polygon with holes (flat rings, x east, z south) with earcut (ISC, js/earcut.js).
 * Handles either winding (the rings are normalised: outer counter-clockwise, holes clockwise in x/z), drops degenerate
 * holes and returns the merged vertex list plus triangle indices into it.
 * @returns {{ pts: number[], idx: number[] }}
 */
export function triangulatePolygon(ring, holes = []) {
  const signed = (r) => {
    let a = 0;
    for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; a += r[i] * r[j + 1] - r[j] * r[i + 1]; }
    return a;
  };
  const orient = (r, sign) => {
    if (Math.sign(signed(r)) === sign) return Array.from(r);
    const out = [];
    for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]);
    return out;
  };
  // drop a duplicated closing vertex
  const open = (r) => (r.length > 6 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1] ? r.slice(0, -2) : r);
  const outerOpen = open(ring);
  const holesOpen = (holes || []).map(open).filter((h) => h.length >= 6 && Math.abs(signed(h)) >= 1e-9);
  if (outerOpen.length < 6 || Math.abs(signed(outerOpen)) < 1e-9) return { pts: Array.from(outerOpen), idx: [] };
  const want = Math.abs(signed(outerOpen)) / 2 - holesOpen.reduce((a, h) => a + Math.abs(signed(h)) / 2, 0);
  // earcut's hole bridging is a heuristic that can lose area on slivery polygons with many holes; it is exact for one
  // of the winding conventions in practice, so try the input as given, then normalised, then reversed and keep the
  // first whose triangulated area matches the polygon area.
  const rev = (r) => { const out = []; for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]); return out; };
  const variants = [
    (r) => Array.from(r),
    (r, isHole) => orient(r, isHole ? -1 : 1),
    (r, isHole) => orient(r, isHole ? 1 : -1),
    (r) => rev(r)
  ];
  let best = null;
  for (const make of variants) {
    const pts = make(outerOpen, false);
    const holeStarts = [];
    for (const h of holesOpen) { holeStarts.push(pts.length / 2); pts.push(...make(h, true)); }
    const idx = earcut(pts, holeStarts, 2);
    const err = Math.abs(trianglesArea(pts, idx) - want);
    if (!best || err < best.err) best = { pts, idx, err };
    if (err <= 1e-4 * Math.abs(want) + 1e-9) break;
  }
  const { pts, idx } = best;
  // same facing as the old ear clipper: positive cross product (x, z) for every triangle
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
    if ((pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]) - (pts[2 * r] - pts[2 * p]) * (pts[2 * q + 1] - pts[2 * p + 1]) < 0) { idx[i + 1] = r; idx[i + 2] = q; }
  }
  return { pts, idx };
}

/** Triangulated area of the output of triangulatePolygon. */
export function trianglesArea(pts, idx) {
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
    a += Math.abs((pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]) - (pts[2 * r] - pts[2 * p]) * (pts[2 * q + 1] - pts[2 * p + 1])) / 2;
  }
  return a;
}

export function ringArea(ring) {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
  }
  return Math.abs(a) / 2;
}

export function ringPerimeter(ring) {
  let p = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(ring[2 * j] - ring[2 * i], ring[2 * j + 1] - ring[2 * i + 1]);
  }
  return p;
}

export function pointInRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c;
  }
  return c;
}
