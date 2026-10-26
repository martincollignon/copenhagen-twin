// js/zones-cph.js
// The shared spatial constraint map of the Copenhagen twin (pure, headless-testable). Everything that is placed in the street
// (parked cars, trees, lamps, benches, racks, bus shelters ...) asks THIS map where it may stand, so no layer needs its own
// idea of "road", "pavement" or "building". It is rasterised once from the same geometry the surfaces are built from
// (js/road-surfaces-cph.js ribbons, cycle strips, the cleaned pavements, building footprints, lakes), 0.5 m per cell, one
// bit per kind; the audit (tools/audit) checks the result against exact polygons. Frame: x east, z south.

import { carriagewayWidth, cycleStrips, rightNormals, slicePts, movingHalfWidth, KERB_W } from './road-width-cph.js';
import { mouthLayouts } from './road-surfaces-cph.js';
import { densifyPts } from './terrain-cph.js';

export const Z = Object.freeze({
  BUILDING: 1, // inside a footprint
  WATER: 2, // open water (lakes minus bridge decks, ponds)
  ROAD: 4, // carriageway asphalt (moving lanes + the parking lane)
  MOVING: 8, // the strip the simulated traffic sweeps (movingHalfWidth)
  CYCLE: 16, // raised cycle strip incl. its kerbs
  PAVEMENT: 32, // KK pavement polygons
  PLAZA: 64 // paved squares / register ground that is not grass
});
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const PAVED = new Set(['kbh_fortov', 'raadhus', 'cobbles', 'setts', 'gravel', 'asphalt_road']);

/**
 * @param {{ geo: object, lakes?: object|null, surfaces?: object|null, bbox?: number[], cell?: number }} src geo = geodata with the
 *   street layout applied (js/layout-cph.js)
 */
export function createZoneMap({ geo, lakes = null, surfaces = null, bbox = [-770, -770, 770, 770], cell = 0.5 }) {
  const [x0, z0, x1, z1] = bbox;
  const w = Math.ceil((x1 - x0) / cell);
  const h = Math.ceil((z1 - z0) / cell);
  const data = new Uint8Array(w * h);

  // scanline even-odd fill of flat rings (the first is the outer ring, the rest holes) into `bit`
  function fill(rings, bit) {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < minZ) minZ = r[i]; if (r[i] > maxZ) maxZ = r[i]; }
    const j0 = Math.max(0, Math.floor((minZ - z0) / cell - 0.5));
    const j1 = Math.min(h - 1, Math.ceil((maxZ - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const zc = z0 + (j + 0.5) * cell;
      const xs = [];
      for (const r of rings) {
        for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
          const zi = r[i + 1];
          const zk = r[k + 1];
          if ((zi > zc) !== (zk > zc)) xs.push(r[i] + ((zc - zi) / (zk - zi)) * (r[k] - r[i]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - x0) / cell - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[q + 1] - x0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) data[j * w + i] |= bit;
      }
    }
  }
  // a strip between lateral offsets o0..o1 (right positive) along a polyline, with the surfaces' averaged vertex normals
  function ribbon(pts, o0, o1, bit) {
    pts = densifyPts(pts, 6); // the surfaces drape their ribbons on the terrain in 6 m pieces (js/road-surfaces-cph.js): same corners
    const n = pts.length / 2;
    if (n < 2) return;
    const nr = rightNormals(pts);
    for (let i = 0; i + 1 < n; i++) {
      const P = (k, o) => [pts[2 * k] + nr[k][0] * o, pts[2 * k + 1] + nr[k][1] * o];
      const a = P(i, o0);
      const b = P(i + 1, o0);
      const c = P(i + 1, o1);
      const d = P(i, o1);
      fill([[a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]], bit);
    }
  }

  for (const b of geo.buildings || []) if (b.ring?.length >= 6) fill([b.ring, ...(b.holes || []).filter((x) => x.length >= 6)], Z.BUILDING);
  for (const s of geo.sidewalks || []) if (s.ring?.length >= 6) fill([s.ring, ...(s.holes || []).filter((x) => x.length >= 6)], Z.PAVEMENT);
  for (const s of surfaces?.surfaces || []) if (s.ring?.length >= 6 && s.cls !== 'grass' && PAVED.has(s.cls)) fill([s.ring, ...(s.holes || []).filter((x) => x.length >= 6)], Z.PLAZA);
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    const hw = carriagewayWidth(r) / 2;
    ribbon(r.pts, -hw, hw, Z.ROAD);
    const mv = movingHalfWidth(r);
    ribbon(r.pts, -mv, mv, Z.MOVING);
    for (const sp of cycleStrips(r)) {
      const pieces = sp.ranges ? sp.ranges.map(([a, b]) => slicePts(r.pts, a, b)).filter((q) => q.length >= 4) : [r.pts];
      for (const q of pieces) {
        if (sp.side > 0) ribbon(q, hw, hw + 2 * KERB_W + sp.w, Z.CYCLE);
        else ribbon(q, -(hw + 2 * KERB_W + sp.w), -hw, Z.CYCLE);
      }
    }
  }
  // side-street mouths: the sloped asphalt ramps of raised crossings are carriageway, their plateaus pavement
  for (const list of mouthLayouts(geo).values()) {
    for (const m of list) {
      for (const rp of m.ramps) fill([rp.quad], Z.ROAD);
      for (const q of m.plateaus) fill([q], Z.PAVEMENT);
    }
  }
  for (const c of geo.cycleTracks || []) {
    if (c.pts?.length >= 4) ribbon(c.pts, -(c.width || 2.2) / 2, (c.width || 2.2) / 2, Z.CYCLE);
  }
  // open water: lakes (islands are land) and ponds; the bridge decks are not water (a bridge strip is carved out of the lake)
  if (lakes) {
    for (const l of lakes.lakes || []) fill([l.ring, ...(l.holes || []).filter((x) => x.length >= 6)], Z.WATER);
    for (const p of lakes.ponds || []) fill([p.ring], Z.WATER);
    for (const b of lakes.bridges || []) clearBit(b.ring, Z.WATER); // the deck carries the road / pavement, it is not water
  }
  // clear `bit` inside a ring: fill the ring with the scratch bit 128, then drop `bit` where it is set
  function clearBit(ring, bit) {
    fill([ring], 128);
    for (let k = 0; k < data.length; k++) {
      if (data[k] & 128) data[k] &= ~(bit | 128);
    }
  }

  const idx = (x, z) => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  const flagsAt = (x, z) => { const k = idx(x, z); return k < 0 ? 0 : data[k]; };

  /**
   * Coverage of an oriented footprint (width w across, depth d along local z, optional offset along z; yaw as the furniture:
   * local +z -> (sin yaw, cos yaw)) per zone: fractions 0..1 over a regular sample grid.
   */
  function cover(x, z, yaw, wd, dp, offZ = 0, step = 0.25) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const nx = Math.max(1, Math.round(wd / step));
    const nz = Math.max(1, Math.round(dp / step));
    const out = { n: 0, building: 0, water: 0, road: 0, moving: 0, cycle: 0, pavement: 0, plaza: 0, solid: 0 };
    for (let a = 0; a < nx; a++) {
      const lx = ((a + 0.5) / nx - 0.5) * wd;
      for (let b = 0; b < nz; b++) {
        const lz = ((b + 0.5) / nz - 0.5) * dp + offZ;
        const f = flagsAt(x + lx * c + lz * s, z - lx * s + lz * c);
        out.n++;
        if (f & Z.BUILDING) out.building++;
        if (f & Z.WATER) out.water++;
        if (f & Z.ROAD) out.road++;
        if (f & Z.MOVING) out.moving++;
        if (f & Z.CYCLE) out.cycle++;
        if (f & Z.PAVEMENT) out.pavement++;
        if (f & Z.PLAZA) out.plaza++;
        if (f & (Z.BUILDING | Z.WATER | Z.ROAD | Z.CYCLE)) out.solid++;
      }
    }
    for (const k of ['building', 'water', 'road', 'moving', 'cycle', 'pavement', 'plaza', 'solid']) out[k] /= out.n;
    return out;
  }

  /** True when the footprint stands on walkable ground only: no building, water, carriageway or cycle strip (`tol` = allowed fraction). */
  const walkable = (x, z, yaw, wd, dp, offZ = 0, tol = 0) => cover(x, z, yaw, wd, dp, offZ).solid <= tol;

  /**
   * The nearest spot to (x, z) within `maxR` metres (rings of 0.25 m, 16 directions, nearest first) where `test(x, z)` holds,
   * or null. The start point is tried first.
   */
  function nearest(x, z, test, maxR = 3, step = 0.25) {
    if (test(x, z)) return { x, z, d: 0 };
    for (let r = step; r <= maxR + 1e-9; r += step) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.4));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r * 1.7; // staggered so the search is not axis-biased
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (test(px, pz)) return { x: px, z: pz, d: r };
      }
    }
    return null;
  }

  return { bbox, cell, width: w, height: h, data, flagsAt, cover, walkable, nearest, Z };
}
