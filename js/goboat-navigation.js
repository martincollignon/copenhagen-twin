// Metres in the Copenhagen local frame (x east, z south). Only rendered water belongs in this adapter.
export const GOBOAT_SEA_LEVEL_LOCAL = -6.84;
export const GOBOAT_HULL_RADIUS = 2.7;
const EPS = 1e-7;
const finitePoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.z);
const cross = (ax, az, bx, bz) => ax * bz - az * bx;
const ringOf = ring => !Array.isArray(ring) ? [] : Array.isArray(ring[0]) ? ring : Array.from({ length: ring.length / 2 }, (_, i) => [ring[i * 2], ring[i * 2 + 1]]);
function bounds(points) {
  return points.reduce((b, [x, z]) => ({ minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minZ: Math.min(b.minZ, z), maxZ: Math.max(b.maxZ, z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}
const within = (b, x, z, margin = 0) => x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;
const overlap = (a, b) => a.minX <= b.maxX + EPS && a.maxX >= b.minX - EPS && a.minZ <= b.maxZ + EPS && a.maxZ >= b.minZ - EPS;
function distanceSq(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return (x - a[0] - t * dx) ** 2 + (z - a[1] - t * dz) ** 2;
}
export function pointInRing(x, z, ring, boundaryInside = true) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (distanceSq(x, z, a, b) < EPS * EPS) return boundaryInside;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function polygon(item) {
  const ring = ringOf(item?.ring);
  if (ring.length < 3 || ring.some(p => p.length < 2 || !p.every(Number.isFinite))) return null;
  const holes = (item.holes || []).map(ringOf).filter(r => r.length >= 3 && r.every(p => p.every(Number.isFinite)));
  return { ...item, ring, holes, bounds: bounds(ring) };
}
const inPolygon = (p, x, z) => within(p.bounds, x, z) && pointInRing(x, z, p.ring) && !p.holes.some(h => pointInRing(x, z, h));
function edges(ring) {
  return ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], bounds: bounds([a, ring[(i + 1) % ring.length]]) })).filter(e => distanceSq(e.a[0], e.a[1], e.b, e.b) > EPS * EPS);
}
// Parameters where b meets a, including overlapping collinear ends. Disjoint collinear segments never intersect.
function intersections(a, b) {
  if (!overlap(a.bounds, b.bounds)) return [];
  const rx = a.b[0] - a.a[0], rz = a.b[1] - a.a[1], sx = b.b[0] - b.a[0], sz = b.b[1] - b.a[1];
  const qx = b.a[0] - a.a[0], qz = b.a[1] - a.a[1], den = cross(rx, rz, sx, sz);
  if (Math.abs(den) > EPS) {
    const t = cross(qx, qz, sx, sz) / den, u = cross(qx, qz, rx, rz) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [Math.max(0, Math.min(1, t))] : [];
  }
  if (Math.abs(cross(qx, qz, rx, rz)) > EPS) return [];
  const lengthSq = rx * rx + rz * rz;
  return [((b.a[0] - a.a[0]) * rx + (b.a[1] - a.a[1]) * rz) / lengthSq,
    ((b.b[0] - a.a[0]) * rx + (b.b[1] - a.a[1]) * rz) / lengthSq].filter(t => t >= -EPS && t <= 1 + EPS).map(t => Math.max(0, Math.min(1, t)));
}
function touches(a, b) {
  if (!overlap(a.bounds, b.bounds)) return false;
  return a.ring.some(([x, z]) => inPolygon(b, x, z)) || b.ring.some(([x, z]) => inPolygon(a, x, z))
    || a.edges.some(e => b.edges.some(f => intersections(e, f).length));
}
function segmentIndex(segments, cell = 32) {
  const buckets = new Map();
  for (const segment of segments) {
    for (let x = Math.floor(segment.bounds.minX / cell); x <= Math.floor(segment.bounds.maxX / cell); x++) {
      for (let z = Math.floor(segment.bounds.minZ / cell); z <= Math.floor(segment.bounds.maxZ / cell); z++) {
        const key = `${x}:${z}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(segment);
      }
    }
  }
  return (box) => {
    const found = new Set();
    for (let x = Math.floor(box.minX / cell); x <= Math.floor(box.maxX / cell); x++) {
      for (let z = Math.floor(box.minZ / cell); z <= Math.floor(box.maxZ / cell); z++) {
        for (const s of buckets.get(`${x}:${z}`) || []) if (overlap(s.bounds, box)) found.add(s);
      }
    }
    return found;
  };
}
function unionBoundary(polygons, contains) {
  const all = polygons.flatMap(p => [p.ring, ...p.holes].flatMap(edges));
  const nearby = segmentIndex(all), exterior = [];
  for (const edge of all) {
    const cuts = [0, 1];
    for (const other of nearby(edge.bounds)) if (other !== edge) cuts.push(...intersections(edge, other));
    cuts.sort((a, b) => a - b);
    const dx = edge.b[0] - edge.a[0], dz = edge.b[1] - edge.a[1], length = Math.hypot(dx, dz);
    for (let i = 1; i < cuts.length; i++) {
      if ((cuts[i] - cuts[i - 1]) * length < EPS) continue;
      const t = (cuts[i] + cuts[i - 1]) / 2, x = edge.a[0] + dx * t, z = edge.a[1] + dz * t;
      const offset = Math.min(0.0001, (cuts[i] - cuts[i - 1]) * length / 10);
      if (contains(x - dz / length * offset, z + dx / length * offset) === contains(x + dz / length * offset, z - dx / length * offset)) continue;
      const a = [edge.a[0] + dx * cuts[i - 1], edge.a[1] + dz * cuts[i - 1]];
      const b = [edge.a[0] + dx * cuts[i], edge.a[1] + dz * cuts[i]];
      exterior.push({ a, b, bounds: bounds([a, b]) });
    }
  }
  return exterior;
}

/** Supply the water polygons actually drawn by the world, with local-y levels and local-frame pier records.
 * The component connected to a pier is navigable; isolated lakes are never selected. No water is invented.
 * lakeData.lakes is a rendering collection, not an exclusion list: it may contain the expanded harbour.
 */
export function createGoBoatNavigation({ geo, lakeData, waterOverride, harbourDoc, pierRecords = [], obstacleRings = [], hullRadius = GOBOAT_HULL_RADIUS, clearance = 0.12 } = {}) {
  const source = waterOverride ?? harbourDoc?.water ?? harbourDoc?.polygons ?? lakeData?.lakes ?? geo?.water ?? [];
  const polygons = (Array.isArray(source) ? source : source.water || source.polygons || []).map(polygon).filter(Boolean);
  if (!polygons.length || !pierRecords.length || !Number.isFinite(hullRadius) || hullRadius <= 0) return null;
  for (const p of polygons) p.edges = edges(p.ring);
  const seeds = pierRecords.map(p => p.departurePoint).filter(finitePoint);
  const first = polygons.find(p => seeds.some(s => inPolygon(p, s.x, s.z)));
  if (!first) return null;
  const connected = new Set([first]), queue = [first];
  while (queue.length) {
    const p = queue.pop();
    for (const q of polygons) if (!connected.has(q) && touches(p, q)) { connected.add(q); queue.push(q); }
  }
  const component = [...connected];
  const waterAt = (x, z) => component.some(p => inPolygon(p, x, z));
  const obstacles = [...obstacleRings, ...pierRecords.flatMap(p => p.obstacles || [])].map(r => ringOf(r.ring || r)).filter(r => r.length >= 3);
  const boundary = unionBoundary(component, waterAt);
  const nearBoundary = segmentIndex([...boundary, ...obstacles.flatMap(edges)]);
  const radius = hullRadius + Math.max(0, clearance), radiusSq = radius * radius;
  const isPositionLegal = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !waterAt(x, z) || obstacles.some(r => pointInRing(x, z, r))) return false;
    for (const s of nearBoundary({ minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius })) {
      if (distanceSq(x, z, s.a, s.b) < radiusSq) return false;
    }
    return true;
  };
  const seed = seeds.find(p => isPositionLegal(p.x, p.z));
  if (!seed) return null;
  const seedPolygon = component.find(p => inPolygon(p, seed.x, seed.z));
  return {
    enabled: true, hullRadius, clearance, polygons: component, obstacles, boundary,
    bounds: bounds(component.flatMap(p => p.ring)), seed: { ...seed },
    level: Number.isFinite(seedPolygon.level) ? seedPolygon.level : GOBOAT_SEA_LEVEL_LOCAL,
    isWaterPoint: waterAt, isPositionLegal,
    findNearestLegalPosition(x, z, maxDistance = 24, step = 0.5) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      if (isPositionLegal(x, z)) return { x, z };
      if (!(step > 0)) return null;
      for (let radius = step; radius <= maxDistance; radius += step) {
        const count = Math.max(16, Math.ceil(2 * Math.PI * radius / step));
        for (let i = 0; i < count; i++) {
          const angle = i * Math.PI * 2 / count, p = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
          if (isPositionLegal(p.x, p.z)) return p;
        }
      }
      return null;
    }
  };
}
export function confineGoBoatMotion(navigation, start, delta, maxStep = 0.25) {
  if (!finitePoint(start) || !finitePoint(delta) || !navigation?.isPositionLegal(start.x, start.z)) return { x: start?.x ?? 0, z: start?.z ?? 0, dx: 0, dz: 0, blocked: true };
  const distance = Math.hypot(delta.x, delta.z), steps = Math.max(1, Math.ceil(distance / (maxStep > 0 ? maxStep : 0.25)));
  let x = start.x, z = start.z;
  for (let i = 1; i <= steps; i++) {
    const nx = start.x + delta.x * i / steps, nz = start.z + delta.z * i / steps;
    if (!navigation.isPositionLegal(nx, nz)) break;
    x = nx; z = nz;
  }
  return { x, z, dx: x - start.x, dz: z - start.z, blocked: Math.hypot(x - start.x - delta.x, z - start.z - delta.z) > 1e-6 };
}

export const GOBOAT_MAX_SPEED = 6 / 3.6;
export function advanceGoBoatSpeed(speed, throttle, dt) {
  dt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  throttle = Math.max(-1, Math.min(1, Number(throttle) || 0));
  if (!throttle) return speed * Math.exp(-0.7 * dt);
  if (speed * throttle < 0) return Math.sign(speed) * Math.max(0, Math.abs(speed) - 1.6 * Math.abs(throttle) * dt);
  return Math.max(-0.85, Math.min(GOBOAT_MAX_SPEED, speed + throttle * 0.55 * dt));
}
