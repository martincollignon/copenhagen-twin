// js/road-width-cph.js
// The carriageway width the Copenhagen twin uses for a road.
//
// With the street layout applied (js/layout-cph.js applyStreets, data/cph-streets.json) a road carries `road.cs`:
// `hw`, the half width between the MEASURED carriageway edges (GeoDanmark Vejkant / the KK pavement polygons), and the
// raised cycle strips beside it with their width and the arc-length ranges where they stand. Roads, kerbs, lane offsets,
// junction boxes, pavement lines, parked cars and pedestrians all read this one cross-section.
//
// Without it (no streets document) the compiler's `width` is a clamped kerb-to-kerb spacing that often includes parking,
// cycle tracks and pavement: 190 one-way roads read 30 m, so the narrower of that and what the lanes need is used, and a
// 1-lane residential street is 6-7 m, not 30.

const EXTRA = { primary: 1.5, secondary: 1.5, residential: 3.6, service: 0.5, cycleway: 0 }; // parking, shoulder
export const LANE_WIDTH = 3.1;

/** @param road { width, lanesFwd, lanesBack, oneway, class } */
export function carriagewayWidth(road) {
  if (road.cs) return road.cs.hw * 2;
  const lanes = Math.max(1, (road.lanesFwd ?? 1) + (road.oneway ? 0 : (road.lanesBack ?? 1)));
  return carriagewayFromLanes(road.width, lanes, road.class);
}

export function carriagewayFromLanes(width, lanes, cls) {
  const need = Math.max(1, lanes) * LANE_WIDTH + (EXTRA[cls] ?? 1);
  const w = width > 0 ? width : need;
  return Math.max(3.0, Math.min(w, need, 20));
}

export const KERB_W = 0.15; // m: granite kerb between carriageway, cycle strip and pavement
export const CYCLE_W = 2.2; // m: the default raised cycle strip

/**
 * The raised cycle strips beside a carriageway: [{ side: +1 right | -1 left, w, ranges: [[s0, s1], ...] | null }]. With the
 * street layout `ranges` are the arc lengths where the strip stands (null = the whole road, the legacy tag).
 */
export function cycleStrips(road) {
  const out = [];
  if (road.cs) {
    if (road.cs.cl) out.push({ side: -1, w: road.cs.cl[0], ranges: road.cs.cl[1] });
    if (road.cs.cr) out.push({ side: 1, w: road.cs.cr[0], ranges: road.cs.cr[1] });
    return out;
  }
  const t = road.cycleTrack;
  if (t === 'left' || t === 'both') out.push({ side: -1, w: CYCLE_W, ranges: null });
  if (t === 'right' || t === 'both') out.push({ side: 1, w: CYCLE_W, ranges: null });
  return out;
}

/** The strip of `road` on `side` at arc length `s`, or null. */
export function cycleStripAt(road, side, s) {
  for (const c of cycleStrips(road)) {
    if (c.side !== side) continue;
    if (!c.ranges || c.ranges.some(([a, b]) => s >= a - 0.01 && s <= b + 0.01)) return c;
  }
  return null;
}

/** Intersection of two sorted lists of [a, b] intervals. */
export function intersectIntervals(A, B) {
  const out = [];
  for (const [a0, a1] of A) {
    for (const [b0, b1] of B) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi - lo > 1e-6) out.push([lo, hi]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** A minus B for sorted lists of [a, b] intervals. */
export function subtractIntervalLists(A, B) {
  let cur = A.map((x) => [...x]);
  for (const [b0, b1] of B) {
    const next = [];
    for (const [a0, a1] of cur) {
      if (b1 <= a0 || b0 >= a1) { next.push([a0, a1]); continue; }
      if (b0 > a0) next.push([a0, b0]);
      if (b1 < a1) next.push([b1, a1]);
    }
    cur = next;
  }
  return cur.filter(([a, b]) => b - a > 1e-6);
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
