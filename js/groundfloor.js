// js/groundfloor.js
// Pure ground-floor classification. Per wall of a building (cleaned ring order, as building-geometry.js walks them):
//   shop      street-facing wall with a venue (OSM shop/amenity, KK bevilling: data/cph-groundfloor.json) or, as a labelled
//             inference, a BBR trade/retail building
//   entry     street-facing residential ground floor: windows on a plinth plus an entrance door
//   rear      courtyard / back wall: plain, windows, no door
//   lotLine   party wall: most of the wall abuts another building's footprint (blank)
// Outbuildings the facade preset marks `blank` stay windowless. The kinds are the WALL_KINDS the facade shader reads.

const KIND = { shop: 0, entry: 1, rear: 2, lotLine: 3, blank: 4 };
const CELL = 24;
const STREET_REACH = 14; // m from the wall to the kerb-side road edge for a wall to count as street-facing
const VENUE_OUT = 7; // m in front of the wall a venue may stand (kiosk, terrace)
const VENUE_IN = 14; // m behind the wall (the shop floor)
const PARTY_FRAC = 0.6;
const PARTY_GAP = 0.45;
const MIN_WALL = 1.2;
const ROAD_SKIP = new Set(['service', 'track']);
const SHOP_USE = (use) => use >= 300 && use < 330; // BBR byg021: 3xx = office/trade/storage

const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function addTo(map, k, v) {
  const a = map.get(k);
  if (a) a.push(v); else map.set(k, [v]);
}

function* cellsOfSegment(x0, z0, x1, z1, pad) {
  const ax = Math.floor((Math.min(x0, x1) - pad) / CELL), bx = Math.floor((Math.max(x0, x1) + pad) / CELL);
  const az = Math.floor((Math.min(z0, z1) - pad) / CELL), bz = Math.floor((Math.max(z0, z1) + pad) / CELL);
  for (let i = ax; i <= bx; i++) for (let j = az; j <= bz; j++) yield `${i},${j}`;
}

function closestOnSegment(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return [x0 + dx * t, z0 + dz * t];
}

/**
 * Spatial context: `roads` [{ pts, width, class }] (flat x, z), `buildings` (geodata, any ring), `venues` [{ x, z, kind }].
 */
function createContext({ roads = [], buildings = [], venues = [] } = {}) {
  const roadSegs = new Map();
  for (const r of roads) {
    if (ROAD_SKIP.has(r.class) || (r.class === 'footway' && !r.name) || !r.pts || r.pts.length < 4) continue; // unnamed footways are courtyard paths
    const half = (r.width || 6) / 2;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const seg = { x0: r.pts[i], z0: r.pts[i + 1], x1: r.pts[i + 2], z1: r.pts[i + 3], half };
      for (const k of cellsOfSegment(seg.x0, seg.z0, seg.x1, seg.z1, STREET_REACH + half)) addTo(roadSegs, k, seg);
    }
  }
  const edges = new Map(); // every building ring edge, for party-wall tests
  for (const b of buildings) {
    for (const ring of [b.ring, ...(b.holes || [])]) {
      if (!ring) continue;
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const e = { id: b.id, x0: ring[2 * i], z0: ring[2 * i + 1], x1: ring[2 * j], z1: ring[2 * j + 1] };
        for (const k of cellsOfSegment(e.x0, e.z0, e.x1, e.z1, 1)) addTo(edges, k, e);
      }
    }
  }
  const venueGrid = new Map();
  for (const v of venues) addTo(venueGrid, key(v.x, v.z), v);
  return { roadSegs, edges, venueGrid };
}

/** True when a road lies in front of the wall (midpoint m, outward normal n) within STREET_REACH of its kerb. */
function facesStreet(ctx, mx, mz, nx, nz) {
  const seen = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const s of ctx.roadSegs.get(`${Math.floor(mx / CELL) + dx},${Math.floor(mz / CELL) + dz}`) || []) {
      if (seen.has(s)) continue;
      seen.add(s);
      const [cx, cz] = closestOnSegment(mx, mz, s.x0, s.z0, s.x1, s.z1);
      const vx = cx - mx, vz = cz - mz;
      const d = Math.hypot(vx, vz);
      if (d - s.half > STREET_REACH) continue;
      if (d < 0.3 || (vx * nx + vz * nz) / d >= 0.5) return true;
    }
  }
  return false;
}

/** Fraction of the wall p0 -> p1 (belonging to building `id`) that runs along another building's footprint edge. */
function partyFraction(ctx, id, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(4, Math.round(len / 0.5));
  const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
  let hit = 0;
  for (let k = 0; k < n; k++) {
    const px = x0 + (x1 - x0) * ((k + 0.5) / n), pz = z0 + (z1 - z0) * ((k + 0.5) / n);
    let touched = false;
    for (const e of ctx.edges.get(key(px, pz)) || []) {
      if (e.id === id) continue;
      const el = Math.hypot(e.x1 - e.x0, e.z1 - e.z0) || 1;
      if (Math.abs(((e.x1 - e.x0) * tx + (e.z1 - e.z0) * tz) / el) < 0.85) continue; // roughly parallel only
      const [cx, cz] = closestOnSegment(px, pz, e.x0, e.z0, e.x1, e.z1);
      if (Math.hypot(cx - px, cz - pz) <= PARTY_GAP) { touched = true; break; }
    }
    if (touched) hit++;
  }
  return hit / n;
}

/** Venues in front of / behind the wall within reach, nearest first. */
function venuesAtWall(ctx, x0, z0, x1, z1, nx, nz) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
  const out = [];
  const reach = Math.max(VENUE_IN, VENUE_OUT);
  const cx0 = Math.floor((Math.min(x0, x1) - reach) / CELL), cx1 = Math.floor((Math.max(x0, x1) + reach) / CELL);
  const cz0 = Math.floor((Math.min(z0, z1) - reach) / CELL), cz1 = Math.floor((Math.max(z0, z1) + reach) / CELL);
  for (let i = cx0; i <= cx1; i++) for (let j = cz0; j <= cz1; j++) {
    for (const v of ctx.venueGrid.get(`${i},${j}`) || []) {
      const along = (v.x - x0) * tx + (v.z - z0) * tz;
      const out_ = (v.x - x0) * nx + (v.z - z0) * nz;
      if (along < -1 || along > len + 1 || out_ > VENUE_OUT || out_ < -VENUE_IN) continue;
      out.push({ v, along, depth: Math.abs(out_) });
    }
  }
  return out.sort((a, b) => a.depth - b.depth).map((e) => e.v);
}

/**
 * Per cleaned edge (flat over `rings` [[x, z], ...], in addBuilding's order): { kind, venues, conf }. `conf` is
 * `observed` (venue data), `inferred` (BBR use / preset) or `data` (street + footprint geometry only).
 */
function classifyWalls(b, rings, ctx) {
  const preset = b.facade?.ground_type;
  const trade = SHOP_USE(b.use);
  const out = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < MIN_WALL) { out.push({ kind: preset === 'blank' ? KIND.blank : KIND.rear, venues: [], conf: 'data' }); continue; }
      const nx = -(q[1] - p[1]) / len, nz = (q[0] - p[0]) / len;
      if (preset === 'blank') { out.push({ kind: KIND.blank, venues: [], conf: 'inferred' }); continue; }
      if (partyFraction(ctx, b.id, p[0], p[1], q[0], q[1]) >= PARTY_FRAC) { out.push({ kind: KIND.lotLine, venues: [], conf: 'data' }); continue; }
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if (!facesStreet(ctx, mx, mz, nx, nz)) { out.push({ kind: KIND.rear, venues: [], conf: 'data' }); continue; }
      const venues = venuesAtWall(ctx, p[0], p[1], q[0], q[1], nx, nz);
      if (venues.length) out.push({ kind: KIND.shop, venues, conf: 'observed' });
      else if (trade) out.push({ kind: KIND.shop, venues: [], conf: 'inferred' });
      else out.push({ kind: KIND.entry, venues: [], conf: 'data' });
    }
  }
  return out;
}

export { KIND, createContext, classifyWalls, facesStreet, partyFraction, venuesAtWall, SHOP_USE };
