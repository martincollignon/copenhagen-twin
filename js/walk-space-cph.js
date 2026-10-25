// js/walk-space-cph.js
// Where pedestrians may walk in the Copenhagen twin: anywhere in the district that is not inside a building
// footprint. (Sidewalk polygons and the cycle tracks beside the carriageway are laid out by road-surfaces-cph.js; the
// pedestrian routes follow the road network at a fixed distance from its edges, and this keeps them out of the houses.)

const CELL = 32;

export function createWalkSpace(geo) {
  const hash = new Map();
  const polys = [];
  for (const b of geo.buildings || []) {
    const ring = b.ring;
    if (!ring || ring.length < 6) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minZ = Math.min(minZ, ring[i + 1]);
      maxZ = Math.max(maxZ, ring[i + 1]);
    }
    const poly = { ring, minX, maxX, minZ, maxZ };
    polys.push(poly);
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(poly);
      }
    }
  }

  function inside(ring, x, z) {
    let c = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i];
      const zi = ring[i + 1];
      const xj = ring[j];
      const zj = ring[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  }

  const inBuilding = (x, z) => {
    for (const p of hash.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
      if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && inside(p.ring, x, z)) return true;
    }
    return false;
  };

  const block = { id: 'copenhagen', poly: [] };
  return {
    inBuilding,
    walkable: (minX, maxX, minZ, maxZ) => !inBuilding(minX, minZ) && !inBuilding(maxX, maxZ) && !inBuilding(minX, maxZ)
      && !inBuilding(maxX, minZ) && !inBuilding((minX + maxX) / 2, (minZ + maxZ) / 2),
    onSidewalk: () => true,
    blockAt: () => block
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Kerb frames: a per-point (u, v) surface coordinate that runs along the street, so pavement slab rows and sett lines
// are parallel to the kerb. u is metres along the nearest carriageway centreline (cumulative arc length), v is metres
// outward from the pavement's inner edge (the kerb, or the outer kerb of a raised cycle track when there is one).
//
// The frame of a point is taken from one road segment: `frameInSegment` projects onto that segment's infinite line, so
// all vertices of one triangle can share a segment and interpolate to an exactly straight, parallel pattern.

const FRAME_CELL = 32;

/**
 * Build the kerb-frame index over the carriageways.
 * @param {Array<{pts:number[], half:number, cycle?:{left?:boolean,right?:boolean}}>} roads
 * @param {{ kerb?: number, cycleInner?: number }} [opts] kerb = kerb stone width; cycleInner = full width a cycle
 *   track takes between the carriageway kerb and the pavement (cycle track + both kerbs)
 */
export function createKerbFrame(roads, { kerb = 0.18, cycleInner = 2.2 + 0.36 } = {}) {
  const list = [];
  const hash = new Map();
  const add = (x0, z0, x1, z1, ref) => {
    for (let ix = Math.floor(Math.min(x0, x1) / FRAME_CELL); ix <= Math.floor(Math.max(x0, x1) / FRAME_CELL); ix++) {
      for (let iz = Math.floor(Math.min(z0, z1) / FRAME_CELL); iz <= Math.floor(Math.max(z0, z1) / FRAME_CELL); iz++) {
        const k = ix * 100003 + iz;
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(ref);
      }
    }
  };
  for (const r of roads) {
    const pts = r.pts;
    if (!pts || pts.length < 4) continue;
    const cum = [0];
    for (let i = 0; i + 3 < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]));
    const rec = { pts, half: r.half, cum, cycle: { left: !!r.cycle?.left, right: !!r.cycle?.right } };
    const ri = list.push(rec) - 1;
    for (let i = 0; i + 3 < pts.length; i += 2) add(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], [ri, i / 2]);
  }

  /** Frame of (x, z) taken from segment `seg` of road `ri` (line projection, not clamped to the segment). */
  function frameInSegment(ri, seg, x, z) {
    const rec = list[ri];
    const p = rec.pts;
    const ax = p[2 * seg];
    const az = p[2 * seg + 1];
    const dx = p[2 * seg + 2] - ax;
    const dz = p[2 * seg + 3] - az;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const s = (x - ax) * ux + (z - az) * uz;
    const lat = (x - ax) * -uz + (z - az) * ux; // right of travel positive (matches road-surfaces ribbons)
    const side = lat >= 0 ? 'right' : 'left';
    const inner = rec.cycle[side] ? kerb + cycleInner : kerb;
    return { u: rec.cum[seg] + s, v: Math.abs(lat) - rec.half - inner, side, road: ri, seg, dirX: ux, dirZ: uz };
  }

  /** Nearest carriageway segment to (x, z): { road, seg, edge } with edge the distance to the carriageway edge. */
  function nearestSegment(x, z, maxRings = 3) {
    const cx = Math.floor(x / FRAME_CELL);
    const cz = Math.floor(z / FRAME_CELL);
    let best = null;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iz = cz - ring; iz <= cz + ring; iz++) {
          if (ring && Math.abs(ix - cx) !== ring && Math.abs(iz - cz) !== ring) continue;
          for (const [ri, seg] of hash.get(ix * 100003 + iz) || []) {
            const rec = list[ri];
            const p = rec.pts;
            const ax = p[2 * seg];
            const az = p[2 * seg + 1];
            const dx = p[2 * seg + 2] - ax;
            const dz = p[2 * seg + 3] - az;
            const l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const edge = Math.hypot(ax + dx * t - x, az + dz * t - z) - rec.half;
            if (!best || edge < best.edge) best = { road: ri, seg, edge };
          }
        }
      }
      if (best && best.edge <= ring * FRAME_CELL) break; // nothing in a farther ring can be closer
    }
    return best;
  }

  return {
    roads: list,
    nearestSegment,
    frameInSegment,
    /** Frame of a point from its own nearest segment, or null when no carriageway is within ~100 m. */
    frameAt(x, z) {
      const n = nearestSegment(x, z);
      return n ? { ...frameInSegment(n.road, n.seg, x, z), edge: n.edge } : null;
    }
  };
}
