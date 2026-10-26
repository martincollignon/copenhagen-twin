// js/junction-mouths-cph.js
// Side-street mouths on the Copenhagen carriageways (pure, headless-testable).
//
// A mouth is a side road S that leaves a through road M at a vertex in the middle of M (OSM splits ways at nodes, but
// the continuing main road keeps one way). Along M, on the side S opens to, the kerb / cycle track / pavement must be
// interrupted across S's carriageway. Frame: x east, z south; side +1 is the right of travel along M.

import { carriagewayWidth, cycleStripAt, cycleStrips } from './road-width-cph.js';

export const VEHICULAR_CLASSES = new Set(['primary', 'secondary', 'residential', 'service']);
const KEY = (x, z) => `${Math.round(x * 2)}:${Math.round(z * 2)}`;
const MIN_SIN = 0.3; // arms closer to M's tangent than ~17 degrees are continuations, not side streets
export const CORNER_RADIUS = 4; // m, kerb return around the corner of a through side street
const MAJOR = new Set(['primary', 'secondary']);

/**
 * @param {Array<{class:string, pts:number[]}>} roads geo.roads
 * @returns {Map<number, Array<{side:number, s:number, half:number, sin:number, cls:string, raised:boolean, road:number, dir:number[], x:number, z:number}>>}
 *   mouths per road index (index into `roads`)
 */
export function findMouths(roads) {
  const nodes = new Map(); // key -> [{road, vi, interior}]
  const cum = [];
  roads.forEach((r, ri) => {
    if (!VEHICULAR_CLASSES.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) return;
    const c = [0];
    for (let i = 0; i + 3 < r.pts.length; i += 2) c.push(c[c.length - 1] + Math.hypot(r.pts[i + 2] - r.pts[i], r.pts[i + 3] - r.pts[i + 1]));
    cum[ri] = c;
    const n = r.pts.length / 2;
    for (let vi = 0; vi < n; vi++) {
      const k = KEY(r.pts[2 * vi], r.pts[2 * vi + 1]);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push({ road: ri, vi, interior: vi > 0 && vi < n - 1 });
    }
  });
  const dirTo = (r, vi, step) => {
    const j = vi + step;
    const dx = r.pts[2 * j] - r.pts[2 * vi];
    const dz = r.pts[2 * j + 1] - r.pts[2 * vi + 1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const out = new Map();
  for (const members of nodes.values()) {
    if (members.length < 2) continue;
    for (const m of members) {
      if (!m.interior) continue;
      const M = roads[m.road];
      const t0 = dirTo(M, m.vi, -1);
      const t1 = dirTo(M, m.vi, 1);
      const tx = t0[0] * -1 + t1[0];
      const tz = t0[1] * -1 + t1[1];
      const tl = Math.hypot(tx, tz) || 1;
      const tan = [tx / tl, tz / tl];
      const right = [-tan[1], tan[0]];
      for (const o of members) {
        if (o.road === m.road) continue;
        const S = roads[o.road];
        const n = S.pts.length / 2;
        const arms = [];
        if (o.vi < n - 1) arms.push(dirTo(S, o.vi, 1));
        if (o.vi > 0) arms.push(dirTo(S, o.vi, -1));
        for (const d of arms) {
          const sin = d[0] * right[0] + d[1] * right[1]; // component across M; >0 opens to the right
          if (Math.abs(sin) < MIN_SIN) continue;
          const half = carriagewayWidth(S) / 2;
          const list = out.get(m.road) || [];
          list.push({
            side: sin > 0 ? 1 : -1, s: cum[m.road][m.vi], half, sin: Math.abs(sin), cls: S.class, raised: !MAJOR.has(S.class),
            road: o.road, dir: d, x: M.pts[2 * m.vi], z: M.pts[2 * m.vi + 1], tan, right
          });
          out.set(m.road, list);
        }
      }
    }
  }
  return out;
}

/** Remove [a, b] intervals from [0, L]; returns the remaining [s0, s1] pieces longer than 0.3 m. */
export function subtractIntervals(L, cuts) {
  const sorted = cuts.filter(([a, b]) => b > 0 && a < L).sort((p, q) => p[0] - q[0]);
  const out = [];
  let at = 0;
  for (const [a, b] of sorted) {
    if (a > at) out.push([at, Math.min(a, L)]);
    at = Math.max(at, b);
  }
  if (at < L) out.push([at, L]);
  return out.filter(([a, b]) => b - a > 0.3);
}

// Heights (m) shared with road-surfaces-cph.js SURFACE_Y; kept literal here so this module stays dependency-free
const Y = { asphalt: 0.022, cycle: 0.12, pavement: 0.2 };
const KERB_W = 0.15;
const CYCLE_W = 2.2;
const BEVEL = 0.7; // m, length of the ramp up to the pavement
const DROP = 0.9; // m, length of the ramp back down to the side street
const DEFAULT_DEPTH = 2.0; // m, pavement depth the raised crossing spans when no sidewalk polygon says otherwise
const TAU = CORNER_RADIUS;

/**
 * Surface layout of one mouth on its through road M.
 * @param mouth entry of findMouths
 * @param {{ half: number, cycle: boolean, depth?: (at, hS, a0) => number }} m M's half carriageway width, whether M has a
 *   cycle track on the mouth's side, and optionally how deep the pavement beside the mouth is (metres from a0)
 * @returns {{ raised: boolean, inner: number[], outer: number[]|null, arcs: number[][], ramps: Array<{quad:number[], ys:number[]}>,
 *   plateaus: number[][], bands: object }}
 *   inner = arc-length interval (on M) where the carriageway-side kerb (and cycle-track edge line) is cut; outer =
 *   interval where the cycle track and the pavement-edge kerb are cut too (null: they continue); arcs = kerb return
 *   polylines (flat x, z); ramps = sloped quads with a height per corner; plateaus = pavement-level quads (flat rings)
 */
export function mouthLayout(mouth, { half: hM, cycle, cycleW = CYCLE_W, depth }) {
  const u = [mouth.right[0] * mouth.side, mouth.right[1] * mouth.side];
  const d = mouth.dir;
  const nS = [-d[1], d[0]];
  const du = d[0] * u[0] + d[1] * u[1];
  const nu = nS[0] * u[0] + nS[1] * u[1];
  const at = (a, w) => {
    const t = (a - nu * w) / du;
    return [mouth.x + d[0] * t + nS[0] * w, mouth.z + d[1] * t + nS[1] * w];
  };
  const sOf = (p) => mouth.s + (p[0] - mouth.x) * mouth.tan[0] + (p[1] - mouth.z) * mouth.tan[1];
  const hS = mouth.half;
  const span = (a) => {
    const s0 = sOf(at(a, -hS));
    const s1 = sOf(at(a, hS));
    return [Math.min(s0, s1), Math.max(s0, s1)];
  };
  const o1 = hM + KERB_W;
  const o2 = o1 + cycleW;
  const outerEdge = cycle ? o2 + KERB_W : hM + KERB_W; // M's band ends here (pavement starts)
  const quad = (a0, a1) => [...at(a0, -hS), ...at(a0, hS), ...at(a1, hS), ...at(a1, -hS)];
  const res = { raised: mouth.raised, inner: null, outer: null, arcs: [], ramps: [], plateaus: [], mouth };
  if (mouth.raised) {
    const [i0, i1] = span(hM);
    res.inner = [i0 - 0.05, i1 + 0.05];
    const a0 = cycle ? outerEdge : hM + BEVEL;
    if (cycle) res.ramps.push({ quad: quad(hM, o1), ys: [Y.asphalt, Y.asphalt, Y.cycle, Y.cycle] });
    else res.ramps.push({ quad: quad(hM, a0), ys: [Y.asphalt, Y.asphalt, Y.pavement, Y.pavement] });
    const P = Math.min(5, Math.max(DEFAULT_DEPTH, depth ? depth(at, hS, outerEdge) : DEFAULT_DEPTH));
    res.plateaus.push(quad(a0, outerEdge + P));
    res.ramps.push({ quad: quad(outerEdge + P, outerEdge + P + DROP), ys: [Y.pavement, Y.pavement, Y.asphalt, Y.asphalt] });
    return res;
  }
  // a through side street: the kerb returns around both corners, the cycle track and pavement edge stop
  const aKerb = cycle ? o2 + KERB_W / 2 : hM + KERB_W / 2;
  const centre = (span(aKerb)[0] + span(aKerb)[1]) / 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (const w of [-hS, hS]) {
    const C = at(aKerb, w);
    const sc = sOf(C);
    const eps = sc < centre ? -1 : 1;
    lo = Math.min(lo, sc + eps * TAU);
    hi = Math.max(hi, sc + eps * TAU);
    const P0 = [C[0] + mouth.tan[0] * eps * TAU, C[1] + mouth.tan[1] * eps * TAU];
    const P2 = [C[0] + d[0] * TAU, C[1] + d[1] * TAU];
    const arc = [];
    for (let k = 0; k <= 8; k++) {
      const q = k / 8;
      arc.push((1 - q) * (1 - q) * P0[0] + 2 * q * (1 - q) * C[0] + q * q * P2[0], (1 - q) * (1 - q) * P0[1] + 2 * q * (1 - q) * C[1] + q * q * P2[1]);
    }
    res.arcs.push(arc);
  }
  res.inner = [lo, hi];
  res.outer = [lo, hi];
  return res;
}

/** Layouts of every mouth: Map road index -> array of layouts. */
export function computeMouthLayouts(roads, { depth } = {}) {
  const all = findMouths(roads);
  const out = new Map();
  for (const [ri, list] of all) {
    const M = roads[ri];
    const half = carriagewayWidth(M) / 2;
    const arr = list.map((mouth) => {
      // the cycle strip M has on the mouth's side at the mouth (the layout's strips, or the legacy tag)
      const strip = M.cs ? cycleStripAt(M, mouth.side, mouth.s) : cycleStrips(M).find((c) => c.side === mouth.side) || null;
      return mouthLayout(mouth, { half, cycle: !!strip, cycleW: strip ? strip.w : CYCLE_W, depth });
    });
    out.set(ri, arr);
  }
  return out;
}
