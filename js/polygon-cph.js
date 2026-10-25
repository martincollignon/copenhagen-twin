// js/polygon-cph.js
// Small pure polygon helpers shared by the ground-surface builders (flat [x0, z0, x1, z1, ...] rings, x east, z south).

export function earClip(ring) {
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
      const cr = cross(A, B, C);
      if (Math.abs(cr) <= 1e-9) { // collinear or a zero-width bridge spike: drop the vertex, no area lost
        order.splice(k, 1);
        clipped = true;
        break;
      }
      if (cr < 0) continue;
      let inside = false;
      for (const q of order) {
        if (q === a || q === b || q === c) continue;
        const Q = P(q);
        // a vertex coincident with a triangle corner (a hole bridge's twin) never blocks the ear
        if ((Q[0] === A[0] && Q[1] === A[1]) || (Q[0] === B[0] && Q[1] === B[1]) || (Q[0] === C[0] && Q[1] === C[1])) continue;
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

const segCross = (ax, az, bx, bz, cx, cz, dx, dz) => {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
};

/**
 * Merge hole rings into the outer ring with zero-width bridges so earClip can triangulate a polygon with holes.
 * Each hole is joined at the closest outer/hole vertex pair whose connecting segment crosses no ring edge.
 */
export function bridgeHoles(outer, holes) {
  let ring = Array.from(outer);
  const signed = (r) => { let a = 0; for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; a += r[i] * r[j + 1] - r[j] * r[i + 1]; } return a; };
  const outerSign = Math.sign(signed(ring)) || 1;
  const rest = holes.filter((h) => h.length >= 6).map((h) => (Math.sign(signed(h)) === outerSign ? holeReverse(h) : Array.from(h)));
  const edges = (rings) => { const e = []; for (const r of rings) for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; e.push([r[i], r[i + 1], r[j], r[j + 1]]); } return e; };
  const all = [ring, ...rest];
  for (const hole of rest.sort((a, b) => Math.max(...b.filter((_, i) => i % 2 === 0)) - Math.max(...a.filter((_, i) => i % 2 === 0)))) {
    const E = edges(all);
    let best = null;
    for (let i = 0; i < ring.length; i += 2) {
      for (let j = 0; j < hole.length; j += 2) {
        const d = Math.hypot(ring[i] - hole[j], ring[i + 1] - hole[j + 1]);
        if (best && d >= best.d) continue;
        let ok = true;
        for (const [ax, az, bx, bz] of E) {
          if (segCross(ring[i], ring[i + 1], hole[j], hole[j + 1], ax, az, bx, bz)) { ok = false; break; }
        }
        if (ok) best = { d, i, j };
      }
    }
    if (!best) continue; // no clean bridge: leave the hole filled rather than corrupt the outline
    const { i, j } = best;
    const h = [];
    for (let k = 0; k <= hole.length / 2; k++) { const q = (j + 2 * k) % hole.length; h.push(hole[q], hole[q + 1]); }
    ring = [...ring.slice(0, i + 2), ...h, ring[i], ring[i + 1], ...ring.slice(i + 2)];
    all[0] = ring;
  }
  return ring;
}

function holeReverse(h) {
  const out = [];
  for (let i = h.length - 2; i >= 0; i -= 2) out.push(h[i], h[i + 1]);
  return out;
}
