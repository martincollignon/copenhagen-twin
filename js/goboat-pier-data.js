// js/goboat-pier-data.js
// The GoBoat piers as plain data (no three.js): the observed OSM footprints, the inferred berth line and the boarding / departure points,
// in the local frame (metres, x east, z south). The world reads them before any tile builds (the GeoDanmark footprints of the pavilion are
// left out of the buildings and their colliders, js/world.js); js/goboat-piers.js draws them, js/goboat-navigation.js steers around them.
import { GOBOAT_SEA_LEVEL_LOCAL } from './goboat-navigation.js';

export const GOBOAT_OSM_FRAME = Object.freeze({ epsg: 25832, origin: Object.freeze([723900.0, 6176500.0, 6.84]) });

const DOCK_RING = Object.freeze([
  1145.043,1405.107, 1144.533,1404.743, 1144.336,1403.493, 1143.135,1403.778, 1142.551,1403.340,
  1142.250,1403.735, 1139.693,1402.049, 1139.433,1400.434, 1142.047,1396.631, 1141.766,1396.433,
  1138.212,1401.568, 1141.930,1404.242, 1115.074,1444.835, 1117.589,1446.556, 1125.384,1434.334,
  1129.476,1437.055, 1128.414,1438.827, 1137.587,1446.460, 1142.560,1438.900, 1132.108,1433.117,
  1130.640,1435.322, 1126.567,1432.600, 1144.493,1405.927, 1148.248,1408.342, 1151.910,1403.213,
  1151.563,1402.964, 1148.856,1406.928, 1147.269,1407.066, 1144.804,1405.465
]);

const PAVILION_RING = Object.freeze([
  1128.414,1438.827, 1129.476,1437.055, 1130.640,1435.322, 1132.108,1433.117,
  1142.560,1438.900, 1137.587,1446.460
]);

/** OSM outlines are observed map footprints; non-footprint elevations and the berth layout are inferred. */
export const GOBOAT_PIER_RECORDS = Object.freeze([Object.freeze({
  id: 'islands-brygge',
  name: 'GoBoat Islands Brygge',
  epsg: 25832,
  source: Object.freeze({ dock: 'osm:way/297639626', pavilion: 'osm:way/297639625', licence: 'ODbL' }),
  dockRing: DOCK_RING,
  pavilionRing: PAVILION_RING,
  // The spine follows the long OSM footprint; this two-ended line is an inferred mooring layout, not a survey trace.
  spine: Object.freeze({ start: Object.freeze([1116.33, 1445.70]), end: Object.freeze([1143.21, 1405.08]) }),
  boardingPoint: Object.freeze({ x: 1117.1, z: 1444.4, heading: 0.62 }),
  departurePoint: Object.freeze({ x: 1111.0, z: 1446.0, heading: -1.0 }),
  deckHeight: GOBOAT_SEA_LEVEL_LOCAL + 0.88,
  fleetCount: 30
})]);

function transformLocalRing(ring, frame) {
  const reference = GOBOAT_OSM_FRAME.origin;
  const target = frame?.origin || reference;
  const dx = reference[0] - target[0], dz = target[1] - reference[1];
  const out = [];
  for (let i = 0; i + 1 < ring.length; i += 2) out.push(ring[i] + dx, ring[i + 1] + dz);
  return out;
}

function normalizeRecord(record, frame) {
  const dockRing = transformLocalRing(record.dockRing, frame);
  const pavilionRing = transformLocalRing(record.pavilionRing, frame);
  const dx = (GOBOAT_OSM_FRAME.origin[0] - (frame?.origin?.[0] ?? GOBOAT_OSM_FRAME.origin[0]));
  const dz = ((frame?.origin?.[1] ?? GOBOAT_OSM_FRAME.origin[1]) - GOBOAT_OSM_FRAME.origin[1]);
  const shiftPoint = (p) => ({ ...p, x: p.x + dx, z: p.z + dz });
  const shiftPair = (p) => [p[0] + dx, p[1] + dz];
  return {
    ...record,
    dockRing,
    pavilionRing,
    obstacles: [dockRing, pavilionRing],
    boardingPoint: shiftPoint(record.boardingPoint),
    departurePoint: shiftPoint(record.departurePoint),
    spine: { start: shiftPair(record.spine.start), end: shiftPair(record.spine.end) }
  };
}

export function normalizeGoBoatPierRecords(records = GOBOAT_PIER_RECORDS, frame = null) {
  return records.map(record => normalizeRecord(record, frame));
}


function insideFlat(x, z, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    if ((flat[i + 1] > z) !== (flat[j + 1] > z) && x < (flat[j] - flat[i]) * (z - flat[i + 1]) / (flat[j + 1] - flat[i + 1]) + flat[i]) inside = !inside;
  }
  return inside;
}

/** A tile building ({ ring: [x, z, ...] }) that is the pier or its pavilion: GeoDanmark maps the GoBoat pavilion as three small
 *  buildings at the sea level. The pier model draws them; left in, they would stand as boxes over the deck and block it as colliders. */
export function isGoBoatPierBuilding(building, records = GOBOAT_PIER_RECORDS) {
  const ring = building?.ring;
  if (!ring || ring.length < 6) return false;
  let x = 0, z = 0;
  for (let i = 0; i + 1 < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  x /= ring.length / 2; z /= ring.length / 2;
  return records.some((r) => insideFlat(x, z, r.pavilionRing) || insideFlat(x, z, r.dockRing));
}

/** The inferred berths: bow-in boats on both sides of the spine ({ x, z, heading }). */
export function makeFleetLayout(record) {
  const a = record.spine.start, b = record.spine.end, dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  const axis = [dx / length, dz / length], normal = [-axis[1], axis[0]], positions = [];
  const n = Math.max(2, Math.floor(record.fleetCount / 2));
  for (const side of [-1, 1]) for (let i = 0; i < n; i++) {
    const t = 0.07 + 0.86 * i / (n - 1);
    // Keep the shore-side gangway and pavilion approach empty, as seen in the aerial photograph.
    if (side === 1 && t > 0.17 && t < 0.36) continue;
    const inward = [-normal[0] * side, -normal[1] * side];
    positions.push({ x: a[0] + dx * t + normal[0] * side * 3.9, z: a[1] + dz * t + normal[1] * side * 3.9, heading: Math.atan2(inward[0], inward[1]) });
  }
  return positions;
}
/** The 5 x 2 m hull footprint of a moored boat (flat ring). */
export function boatRing(p) {
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  return [[-1, -2.5], [1, -2.5], [1, 2.5], [-1, 2.5]].flatMap(([x, z]) => [p.x + c * x + s * z, p.z - s * x + c * z]);
}
