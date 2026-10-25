// js/pavement-cph.js
// Pavement and ground-surface triangles for the Copenhagen twin (pure, no three.js; testable headless).
//
// Every sidewalk polygon (KK fortovsmatrikel) is the "Københavnerfortov" unless KK's surface register
// (data/cph-surfaces.json, dp_belaegninger) says otherwise at that spot, or the polygon is a plaza-sized block, which
// is read as a Rådhusbelægning square (inferred). Triangles carry a kerb-aligned (u, v) surface coordinate
// (createKerbFrame in walk-space-cph.js) so slab rows and sett lines run parallel to the street.

import { triangulatePolygon, pointInRing, ringArea, ringPerimeter } from './polygon-cph.js';
import { createKerbFrame } from './walk-space-cph.js';

export const PAVEMENT_CLASSES = ['kbh_fortov', 'raadhus', 'cobbles', 'setts', 'gravel', 'other'];
const PLAZA_MIN_AREA = 300; // m2
const PLAZA_MIN_THICKNESS = 7; // 2A/P in metres; a pavement strip of width w has about w

/** Material class of a whole sidewalk polygon without register data: Københavnerfortov, or a plaza-sized block. */
export function sidewalkClass(ring) {
  const area = ringArea(ring);
  const per = ringPerimeter(ring) || 1;
  return area >= PLAZA_MIN_AREA && (2 * area) / per > PLAZA_MIN_THICKNESS ? 'raadhus' : 'kbh_fortov';
}

/** Spatial index over the KK surface-register polygons: classAt(x, z) is the register class there, or null. */
export function createSurfaceIndex(surfaces) {
  const CELL = 32;
  const hash = new Map();
  const polys = [];
  for (const s of surfaces || []) {
    if (!s.ring || s.ring.length < 6) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < s.ring.length; i += 2) {
      x0 = Math.min(x0, s.ring[i]);
      x1 = Math.max(x1, s.ring[i]);
      z0 = Math.min(z0, s.ring[i + 1]);
      z1 = Math.max(z1, s.ring[i + 1]);
    }
    const p = { s, x0, x1, z0, z1 };
    polys.push(p);
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = ix * 100003 + iz;
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(p);
      }
    }
  }
  return {
    count: polys.length,
    classAt(x, z) {
      for (const p of hash.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || []) {
        if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pointInRing(p.s.ring, x, z)) return p.s.cls;
      }
      return null;
    }
  };
}

/** Split a triangle (flat [ax, az, bx, bz, cx, cz]) at the midpoint of its longest edge until all edges <= maxEdge(x, z). */
export function subdivide(tri, maxEdge, out, depth = 0) {
  const [ax, az, bx, bz, cx, cz] = tri;
  const e = [Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz)];
  const longest = Math.max(e[0], e[1], e[2]);
  if (depth >= 8 || longest <= maxEdge((ax + bx + cx) / 3, (az + bz + cz) / 3)) {
    out.push(tri);
    return;
  }
  if (longest === e[0]) {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    subdivide([ax, az, mx, mz, cx, cz], maxEdge, out, depth + 1);
    subdivide([mx, mz, bx, bz, cx, cz], maxEdge, out, depth + 1);
  } else if (longest === e[1]) {
    const mx = (bx + cx) / 2;
    const mz = (bz + cz) / 2;
    subdivide([ax, az, bx, bz, mx, mz], maxEdge, out, depth + 1);
    subdivide([ax, az, mx, mz, cx, cz], maxEdge, out, depth + 1);
  } else {
    const mx = (cx + ax) / 2;
    const mz = (cz + az) / 2;
    subdivide([ax, az, bx, bz, mx, mz], maxEdge, out, depth + 1);
    subdivide([mx, mz, bx, bz, cx, cz], maxEdge, out, depth + 1);
  }
}

const STRIP_W = 0.4; // m, the granite sett (chaussésten) strip along the building line
const STRIP_NEAR = 0.35; // m, how close a pavement edge must run to a footprint edge to count as the building line

/** Spatial hash over building footprint edges: nearest(x, z) is the distance to the closest edge. */
export function createBuildingEdgeIndex(buildings, cell = 16) {
  const hash = new Map();
  for (const b of buildings || []) {
    const r = b.ring;
    if (!r || r.length < 6) continue;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const e = [r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]];
      for (let ix = Math.floor((Math.min(e[0], e[2]) - 1) / cell); ix <= Math.floor((Math.max(e[0], e[2]) + 1) / cell); ix++) {
        for (let iz = Math.floor((Math.min(e[1], e[3]) - 1) / cell); iz <= Math.floor((Math.max(e[1], e[3]) + 1) / cell); iz++) {
          const k = ix * 100003 + iz;
          if (!hash.has(k)) hash.set(k, []);
          hash.get(k).push(e);
        }
      }
    }
  }
  return {
    nearest(x, z) {
      let best = Infinity;
      for (const [ax, az, bx, bz] of hash.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []) {
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
      }
      return best;
    }
  };
}

/**
 * Quads (flat 8-number rings) of the sett strip along every pavement edge that runs on a building line: the
 * Københavnerfortov has a row of small granite setts at the facade as well as at the kerb.
 */
export function facadeStrips(sidewalks, edgeIndex, { width = STRIP_W, near = STRIP_NEAR } = {}) {
  const out = [];
  for (const s of sidewalks || []) {
    const r = s.ring;
    if (!r || r.length < 6) continue;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[2 * i];
      const az = r[2 * i + 1];
      const bx = r[2 * j];
      const bz = r[2 * j + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      // the whole edge (not just its midpoint) lies on the footprint edge
      if ([0.1, 0.5, 0.9].some((t) => edgeIndex.nearest(ax + (bx - ax) * t, az + (bz - az) * t) > near)) continue;
      const ux = (bx - ax) / L;
      const uz = (bz - az) / L;
      let nx = -uz;
      let nz = ux;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if (!pointInRing(r, mx + nx * 0.05, mz + nz * 0.05)) { nx = -nx; nz = -nz; } // point into the pavement
      if (!pointInRing(r, mx + nx * 0.05, mz + nz * 0.05)) continue;
      // clip the strip's depth to what the pavement allows (a thin pavement narrower than the strip)
      let w = width;
      while (w > 0.1 && !pointInRing(r, mx + nx * w, mz + nz * w)) w -= 0.1;
      if (w < 0.1) continue;
      out.push([ax, az, bx, bz, bx + nx * w, bz + nz * w, ax + nx * w, az + nz * w]);
    }
  }
  return out;
}

class Bucket {
  constructor() { this.position = []; this.kuv = []; this.seed = []; }
  get vertexCount() { return this.position.length / 3; }
  tri(t, uvs, y, seed) {
    for (let k = 0; k < 3; k++) {
      this.position.push(t[2 * k], y, t[2 * k + 1]);
      this.kuv.push(uvs[k][0], uvs[k][1]);
      this.seed.push(seed);
    }
  }
  arrays() {
    return { position: new Float32Array(this.position), kuv: new Float32Array(this.kuv), seed: new Float32Array(this.seed) };
  }
}

const hash01 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/**
 * Tessellate one ring into kerb-framed triangles and push them into `buckets` (keyed by class).
 * `classOf(x, z)` returns the class for a triangle centroid; `skip(x, z)` drops triangles (e.g. under a cycle track).
 */
export function tessellateFramed(ring, { holes, frame, y, seed, classOf, skip, maxEdge, buckets, keyPrefix = '' }) {
  const out = [];
  const { pts, idx } = triangulatePolygon(ring, holes);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    subdivide([pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1], pts[2 * c], pts[2 * c + 1]], maxEdge, out);
  }
  let kept = 0;
  for (const t of out) {
    const cx = (t[0] + t[2] + t[4]) / 3;
    const cz = (t[1] + t[3] + t[5]) / 3;
    if (skip && skip(cx, cz)) continue;
    const cls = classOf(cx, cz);
    let uvs;
    const near = frame ? frame.nearestSegment(cx, cz) : null;
    if (near) {
      uvs = [0, 1, 2].map((k) => {
        const f = frame.frameInSegment(near.road, near.seg, t[2 * k], t[2 * k + 1]);
        return [f.u, f.v];
      });
    } else {
      uvs = [0, 1, 2].map((k) => [t[2 * k], t[2 * k + 1]]); // no carriageway nearby: world-aligned
    }
    const key = keyPrefix + cls;
    if (!buckets.has(key)) buckets.set(key, new Bucket());
    buckets.get(key).tri(t, uvs, y, seed);
    kept++;
  }
  return kept;
}

/**
 * Pavement + register ground triangles.
 * @param {object} geo cph-geodata (sidewalks)
 * @param {object|null} surfacesDoc cph-surfaces (surfaces)
 * @param {{ roads: Array, y: number, groundY: number, skip?: Function, nearCycle?: Function }} opts
 * @returns {Map<string, Bucket>} keys: '<cls>' (pavement, at y) and 'ground:<cls>' (register polygons, at groundY)
 */
export function buildPavementBuckets(geo, surfacesDoc, { roads, y, groundY, skip, nearCycle, extraPavement = [] }) {
  const frame = createKerbFrame(roads);
  const index = createSurfaceIndex(surfacesDoc?.surfaces);
  const buckets = new Map();
  const maxEdge = (x, z) => (nearCycle && nearCycle(x, z) ? 2.5 : 6);
  let i = 0;
  for (const s of geo.sidewalks || []) {
    if (!s.ring || s.ring.length < 6) continue;
    const fallback = sidewalkClass(s.ring);
    tessellateFramed(s.ring, {
      frame, y, seed: hash01(++i), skip, maxEdge, buckets,
      classOf: (x, z) => {
        const c = index.classAt(x, z);
        return c && c !== 'other' && c !== 'grass' && c !== 'asphalt_road' ? c : fallback;
      }
    });
  }
  // the sett strip along the building line, just above the slabs
  for (const quad of facadeStrips(geo.sidewalks, createBuildingEdgeIndex(geo.buildings))) {
    tessellateFramed(quad, { frame, y: y + 0.003, seed: hash01(++i), skip, maxEdge: () => 6, buckets, classOf: () => 'setts' });
  }
  // raised side-street crossings (junction-mouths-cph.js): pavement slabs bridging the gaps in the KK sidewalk polygons
  for (const q of extraPavement) {
    tessellateFramed(q, { frame, y, seed: hash01(++i), buckets, maxEdge: () => 6, classOf: () => 'kbh_fortov' });
  }
  // register polygons that are not pavements (park paths, squares, gravel); drawn just above the ground plane
  for (const s of surfacesDoc?.surfaces || []) {
    if (!s.ring || s.ring.length < 6 || s.cls === 'grass') continue;
    // holes (lawns inside a path network) are carved out by the triangulation
    tessellateFramed(s.ring, {
      holes: s.holes,
      frame, y: s.src?.[0]?.startsWith('osm') ? groundY - 0.004 : groundY, seed: hash01(++i), buckets, keyPrefix: 'ground:',
      maxEdge: () => 12,
      classOf: () => s.cls
    });
  }
  return buckets;
}
