// Runtime replacement for missing lake-path polygons in data/cph-surfaces.json.
// The measured lake rings are the water edge; bands are emitted landward as ordinary surface records so the existing
// pavement renderer and spatial filters can consume them without a compiler cache.

import { pointInRing } from './polygon-cph.js';
import { WATER } from './lakes-cph.js';

const CELL = 32;
const ROAD_MARGIN = 0.35;
const DEFAULT_BBOX = [-750, -750, 750, 750];
const ROAD_CLASSES = new Set(['primary', 'secondary', 'residential', 'service']);

const boundsOf = (ring) => {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]);
    maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { minX, minZ, maxX, maxZ };
};

const cellKey = (x, z) => `${x},${z}`;

function indexPolygons(records) {
  const cells = new Map();
  for (const record of records) {
    const ring = record?.ring;
    if (!ring || ring.length < 6) continue;
    const bounds = boundsOf(ring);
    const item = { ring, holes: record.holes || [], bounds };
    for (let x = Math.floor(bounds.minX / CELL); x <= Math.floor(bounds.maxX / CELL); x++) {
      for (let z = Math.floor(bounds.minZ / CELL); z <= Math.floor(bounds.maxZ / CELL); z++) {
        const key = cellKey(x, z);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(item);
      }
    }
  }
  return (bounds) => {
    const out = new Set();
    for (let x = Math.floor(bounds.minX / CELL); x <= Math.floor(bounds.maxX / CELL); x++) {
      for (let z = Math.floor(bounds.minZ / CELL); z <= Math.floor(bounds.maxZ / CELL); z++) {
        for (const item of cells.get(cellKey(x, z)) || []) out.add(item);
      }
    }
    return out;
  };
}

function indexRoads(roads) {
  const cells = new Map();
  for (const road of roads || []) {
    const pts = road.pts;
    if (!pts || pts.length < 4) continue;
    const radius = Math.max(0, Number(road.width) || 0) / 2 + ROAD_MARGIN;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const segment = { ax: pts[i], az: pts[i + 1], bx: pts[i + 2], bz: pts[i + 3], radius };
      const minX = Math.min(segment.ax, segment.bx) - radius;
      const maxX = Math.max(segment.ax, segment.bx) + radius;
      const minZ = Math.min(segment.az, segment.bz) - radius;
      const maxZ = Math.max(segment.az, segment.bz) + radius;
      for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) {
        for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) {
          const key = cellKey(x, z);
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(segment);
        }
      }
    }
  }
  return (bounds) => {
    const out = new Set();
    for (let x = Math.floor(bounds.minX / CELL); x <= Math.floor(bounds.maxX / CELL); x++) {
      for (let z = Math.floor(bounds.minZ / CELL); z <= Math.floor(bounds.maxZ / CELL); z++) {
        for (const segment of cells.get(cellKey(x, z)) || []) out.add(segment);
      }
    }
    return out;
  };
}

const orient = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

function onSegment(ax, az, bx, bz, x, z) {
  return x >= Math.min(ax, bx) - 1e-8 && x <= Math.max(ax, bx) + 1e-8
    && z >= Math.min(az, bz) - 1e-8 && z <= Math.max(az, bz) + 1e-8;
}

function segmentsIntersect(a, b, c, d) {
  const [ax, az] = a;
  const [bx, bz] = b;
  const [cx, cz] = c;
  const [dx, dz] = d;
  const o1 = orient(ax, az, bx, bz, cx, cz);
  const o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az);
  const o4 = orient(cx, cz, dx, dz, bx, bz);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (Math.abs(o1) < 1e-8 && onSegment(ax, az, bx, bz, cx, cz))
    || (Math.abs(o2) < 1e-8 && onSegment(ax, az, bx, bz, dx, dz))
    || (Math.abs(o3) < 1e-8 && onSegment(cx, cz, dx, dz, ax, az))
    || (Math.abs(o4) < 1e-8 && onSegment(cx, cz, dx, dz, bx, bz));
}

function polygonOverlap(a, b) {
  const ba = boundsOf(a);
  const bb = b.bounds;
  if (ba.maxX < bb.minX || ba.minX > bb.maxX || ba.maxZ < bb.minZ || ba.minZ > bb.maxZ) return false;
  for (let i = 0; i < a.length; i += 2) {
    if (pointInRing(b.ring, a[i], a[i + 1]) && !b.holes.some((h) => pointInRing(h, a[i], a[i + 1]))) return true;
  }
  for (let i = 0; i < b.ring.length; i += 2) {
    if (pointInRing(a, b.ring[i], b.ring[i + 1])) return true;
  }
  for (let i = 0; i < a.length; i += 2) {
    const j = (i + 2) % a.length;
    for (let k = 0; k < b.ring.length; k += 2) {
      const l = (k + 2) % b.ring.length;
      if (segmentsIntersect([a[i], a[i + 1]], [a[j], a[j + 1]], [b.ring[k], b.ring[k + 1]], [b.ring[l], b.ring[l + 1]])) return true;
    }
  }
  return false;
}

const pointSegmentDistance = (x, z, s) => {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
};

function nearRoad(ring, roadsNear) {
  for (const road of roadsNear) {
    for (let i = 0; i < ring.length; i += 2) {
      if (pointSegmentDistance(ring[i], ring[i + 1], road) <= road.radius) return true;
    }
    if (pointInRing(ring, road.ax, road.az) || pointInRing(ring, road.bx, road.bz)) return true;
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      if (segmentsIntersect([ring[i], ring[i + 1]], [ring[j], ring[j + 1]], [road.ax, road.az], [road.bx, road.bz])) return true;
    }
  }
  return false;
}

function ringOffsets(ring, signedArea, distance) {
  const n = ring.length / 2;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[2 * j] - ring[2 * i];
    const dz = ring[2 * j + 1] - ring[2 * i + 1];
    const len = Math.hypot(dx, dz) || 1;
    const side = -Math.sign(signedArea || 1);
    edges.push([-dz / len * side, dx / len * side]);
  }
  const offsets = [];
  for (let i = 0; i < n; i++) {
    const before = edges[(i + n - 1) % n];
    const after = edges[i];
    let mx = before[0] + after[0];
    let mz = before[1] + after[1];
    const length = Math.hypot(mx, mz);
    if (length < 1e-6) { mx = after[0]; mz = after[1]; } else { mx /= length; mz /= length; }
    const scale = Math.min(2, 1 / Math.max(mx * after[0] + mz * after[1], 0.5));
    offsets.push([mx * scale * distance, mz * scale * distance]);
  }
  return offsets;
}

const signedAreaOf = (ring) => {
  let area = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    area += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return area / 2;
};

const interpolate = (a, b, t) => a + (b - a) * t;

/**
 * Creates inferred gravel-path and grass-bank surface records from real lake rings.
 * Existing registered ground, sidewalks, roads, buildings and bridge polygons take precedence, so generated strips
 * only fill missing land-side sections. Each record uses the cph-surfaces schema and is safe to append to that document.
 */
export function buildLakePromenadeSurfaces(lakesDoc, {
  existingSurfaces = [], roads = [], cycleTracks = [], sidewalks = [], buildings = [], bridges = [],
  bbox = DEFAULT_BBOX, gravelWidth = 4, grassWidth = 2, step = 2,
  wallOffset = WATER.wallBatter + WATER.copingW - 0.005
} = {}) {
  if (!lakesDoc?.lakes?.length) return [];
  const knownSurfaces = (existingSurfaces || []).filter((surface) => surface.cls !== 'other');
  const polygonQuery = indexPolygons([...knownSurfaces, ...sidewalks, ...buildings, ...bridges]);
  // Footways are the lake walks this inferred gravel band is meant to render; only protect drivable roads here.
  const drivableRoads = (roads || []).filter((road) => ROAD_CLASSES.has(road.class) && !road.drop);
  const roadQuery = indexRoads([...drivableRoads, ...(cycleTracks || [])]);
  const out = [];
  const [x0, z0, x1, z1] = bbox || DEFAULT_BBOX;

  const append = (lake, ringIndex, segmentIndex, cls, material, ring) => {
    const bounds = boundsOf(ring);
    if (bounds.minX < x0 || bounds.maxX > x1 || bounds.minZ < z0 || bounds.maxZ > z1) return;
    if ([...polygonQuery(bounds)].some((blocker) => polygonOverlap(ring, blocker))) return;
    if (nearRoad(ring, roadQuery(bounds))) return;
    out.push({
      cls,
      material,
      space: 'Lake promenade',
      src: ['runtime:lake-promenade'],
      conf: 'inferred',
      id: `runtime:lake-promenade:${lake.id || 'lake'}:${ringIndex}:${segmentIndex}:${cls}`,
      ring
    });
  };

  for (const lake of lakesDoc.lakes) {
    const ring = lake.ring;
    if (!ring || ring.length < 8) continue;
    const signedArea = signedAreaOf(ring);
    // Overlap the coping's outer edge by 5 mm to absorb ring/offset precision, then continue 4 m before the grass verge.
    const pathStartOffsets = ringOffsets(ring, signedArea, wallOffset);
    const pathOffsets = ringOffsets(ring, signedArea, wallOffset + gravelWidth);
    const grassOffsets = ringOffsets(ring, signedArea, wallOffset + gravelWidth + grassWidth);
    for (let i = 0; i < ring.length / 2; i++) {
      const j = (i + 1) % (ring.length / 2);
      const ax = ring[2 * i];
      const az = ring[2 * i + 1];
      const bx = ring[2 * j];
      const bz = ring[2 * j + 1];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 1e-4) continue;
      const count = Math.ceil(length / step);
      for (let k = 0; k < count; k++) {
        const t0 = k / count;
        const t1 = (k + 1) / count;
        const pointAt = (t, offsets) => [
          interpolate(ax + offsets[i][0], bx + offsets[j][0], t),
          interpolate(az + offsets[i][1], bz + offsets[j][1], t)
        ];
        const gravelRing = [
          ...pointAt(t0, pathStartOffsets), ...pointAt(t1, pathStartOffsets), ...pointAt(t1, pathOffsets), ...pointAt(t0, pathOffsets)
        ];
        const grassRing = [
          ...pointAt(t0, pathOffsets), ...pointAt(t1, pathOffsets), ...pointAt(t1, grassOffsets), ...pointAt(t0, grassOffsets)
        ];
        const segmentId = `${i}-${k}`;
        append(lake, 0, segmentId, 'gravel', 'Grus', gravelRing);
        append(lake, 0, segmentId, 'grass', 'Græs', grassRing);
      }
    }
  }
  return out;
}
