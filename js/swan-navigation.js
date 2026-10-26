import { pointInRing } from './polygon-cph.js';

// Kaffesalonen's floating dock, OSM way 146419897, in the Copenhagen local frame.
export const SWAN_PIER_RING = Object.freeze([
  0.6, -402.1, -0.7, -399.6, -20.2, -409.6, -14.2, -420.8, -17.7, -422.5,
  -16.6, -424.6, -15.6, -426.4, -12.1, -424.7, -10.6, -427.6, -10.6, -428.8,
  -8.4, -432.9, -7.3, -433.5, -5.9, -436.5, 13.1, -426.6, 11.8, -424.0,
  9.0, -425.5, 6.2, -420.2, 0.6, -423.0, 1.1, -424.1, -4.4, -426.8,
  -5.6, -424.5, 7.3, -417.9, 2.6, -408.8, -10.2, -415.3, -13.3, -409.2
]);

const dockEdge = { a: [-5.9, -436.5], b: [13.1, -426.6] };
const outward = { x: 9.9 / Math.hypot(9.9, 19.0), z: -19.0 / Math.hypot(9.9, 19.0) };
const dockOffset = 1.9;
const mooringT = [0.08, 0.22, 0.36, 0.50, 0.64, 0.78, 0.92];
// Axis of Dronning Louises Bro from the local lake data. Keep the boat on Peblinge's southwest side.
const bridgeAxis = { ax: 46.51, az: -491.57, bx: 151.36, bz: -428.08 };
export const SWAN_HEADING = Math.atan2(outward.x, outward.z);
export const SWAN_MOORINGS = Object.freeze(mooringT.map((t) => Object.freeze({
  x: dockEdge.a[0] + (dockEdge.b[0] - dockEdge.a[0]) * t + outward.x * dockOffset,
  z: dockEdge.a[1] + (dockEdge.b[1] - dockEdge.a[1]) * t + outward.z * dockOffset,
  heading: SWAN_HEADING
})));
export const SWAN_START = SWAN_MOORINGS[3];
export const SWAN_STATIC_MOORINGS = Object.freeze(SWAN_MOORINGS.filter((_, i) => i !== 3));
export const SWAN_BOAT_CLEARANCE = 1.65;
export const SWAN_MAX_SPEED = 6 / 3.6;

export function advanceSwanSpeed(speed, throttle, dt) {
  throttle = Math.max(-1, Math.min(1, Number(throttle) || 0));
  dt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  if (!throttle) return speed * Math.exp(-0.55 * dt);
  if (speed * throttle < 0) {
    const amount = Math.abs(throttle) * 3.2 * dt;
    return Math.abs(speed) <= amount ? 0 : speed - Math.sign(speed) * amount;
  }
  const acceleration = throttle < 0 ? 0.72 : 0.92;
  return Math.max(-SWAN_MAX_SPEED, Math.min(SWAN_MAX_SPEED, speed + throttle * acceleration * dt));
}

function closestOnRing(ring, x, z) {
  let bestDistanceSq = Infinity;
  let bestX = x;
  let bestZ = z;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i], az = ring[i + 1], dx = ring[j] - ax, dz = ring[j + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const qx = ax + dx * t, qz = az + dz * t;
    const distanceSq = (x - qx) ** 2 + (z - qz) ** 2;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestX = qx;
      bestZ = qz;
    }
  }
  const distance = Math.sqrt(bestDistanceSq);
  const normal = distance > 1e-6 ? { x: (x - bestX) / distance, z: (z - bestZ) / distance } : { x: 0, z: 0 };
  return { x: bestX, z: bestZ, distance, normal };
}

/** Builds a single-basin navigation surface from the same measured polygons used to draw the lakes. */
export function createSwanNavigation(doc, {
  lakeId = 'lake:0',
  pierRing = SWAN_PIER_RING,
  clearance = SWAN_BOAT_CLEARANCE
} = {}) {
  const lake = (doc?.lakes || []).find((item) => item.id === lakeId);
  if (!lake?.ring?.length) return null;
  const holes = lake.holes || [];
  const separatesSortedams = (doc?.bridges || []).some((bridge) => bridge.id === 'bridge:0');
  // Dronning Louises Bro spans the basin and stays a hard boundary for pedal boats.
  const obstacles = [pierRing, ...(doc?.bridges || []).map((bridge) => bridge.ring)].filter((ring) => ring?.length >= 6);
  const boundaries = [lake.ring, ...holes, ...obstacles];
  const nearestBoundary = (x, z) => {
    let closest = null;
    for (let index = 0; index < boundaries.length; index++) {
      const hit = closestOnRing(boundaries[index], x, z);
      if (!closest || hit.distance < closest.distance) closest = { ...hit, index };
    }
    if (!closest) return { x: 0, z: 0 };
    const outer = closest.index === 0;
    const inside = pointInRing(boundaries[closest.index], x, z);
    // On the outside of the lake, or inside an island/dock/bridge, reverse the vector away from that ring.
    if (outer !== inside) {
      closest.normal.x *= -1;
      closest.normal.z *= -1;
    }
    return closest;
  };
  const isPositionLegal = (x, z) => {
    if (!pointInRing(lake.ring, x, z)) return false;
    if (separatesSortedams) {
      const dx = bridgeAxis.bx - bridgeAxis.ax, dz = bridgeAxis.bz - bridgeAxis.az;
      const sideDistance = (dx * (z - bridgeAxis.az) - dz * (x - bridgeAxis.ax)) / Math.hypot(dx, dz);
      if (sideDistance < clearance) return false;
    }
    if (closestOnRing(lake.ring, x, z).distance < clearance) return false;
    for (const ring of holes) {
      if (pointInRing(ring, x, z) || closestOnRing(ring, x, z).distance < clearance) return false;
    }
    for (const ring of obstacles) {
      if (pointInRing(ring, x, z) || closestOnRing(ring, x, z).distance < clearance) return false;
    }
    return true;
  };
  return { lake, holes, obstacles, clearance, isPositionLegal, nearestBoundary };
}

/** Substeps a boat's circular hull clearance, then projects blocked motion along the contacted shoreline. */
export function confineSwanMotion(navigation, start, delta, maxStep = 0.35) {
  const distance = Math.hypot(delta.x, delta.z);
  const steps = Math.max(1, Math.ceil(distance / maxStep));
  const stepX = delta.x / steps, stepZ = delta.z / steps;
  let x = start.x, z = start.z;
  for (let i = 0; i < steps; i++) {
    const nextX = x + stepX, nextZ = z + stepZ;
    if (navigation.isPositionLegal(nextX, nextZ)) {
      x = nextX;
      z = nextZ;
      continue;
    }
    const boundary = navigation.nearestBoundary(x, z);
    const intoWall = stepX * boundary.normal.x + stepZ * boundary.normal.z;
    let slideX = stepX, slideZ = stepZ;
    if (intoWall < 0) {
      slideX -= boundary.normal.x * intoWall;
      slideZ -= boundary.normal.z * intoWall;
    }
    const slidX = x + slideX, slidZ = z + slideZ;
    if (navigation.isPositionLegal(slidX, slidZ)) {
      x = slidX;
      z = slidZ;
      continue;
    }
    // Axis fallbacks handle concave corners and narrow dock edges without allowing a diagonal corner to tunnel through.
    const xOnly = x + stepX, zOnly = z + stepZ;
    if (navigation.isPositionLegal(xOnly, z)) {
      x = xOnly;
    } else if (navigation.isPositionLegal(x, zOnly)) {
      z = zOnly;
    }
  }
  return { x, z, dx: x - start.x, dz: z - start.z };
}
