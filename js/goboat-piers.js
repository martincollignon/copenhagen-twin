import * as THREE from 'three/webgpu';
import { createGoBoat } from './goboat.js';
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

const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x776a57, roughness: 0.89, metalness: 0.02 });
const plankLineMaterial = new THREE.LineBasicMaterial({ color: 0x403d37, transparent: true, opacity: 0.55 });
const floatMaterial = new THREE.MeshStandardMaterial({ color: 0x202629, roughness: 0.82 });
const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0x8eacb1, roughness: 0.17, metalness: 0.12, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
const pavilionTimber = new THREE.MeshStandardMaterial({ color: 0x34332f, roughness: 0.88 });
const solarMaterial = new THREE.MeshStandardMaterial({ color: 0x182a35, roughness: 0.28, metalness: 0.44 });
const ropeMaterial = new THREE.LineBasicMaterial({ color: 0x786d5c, transparent: true, opacity: 0.78 });
const buoyMaterial = new THREE.MeshStandardMaterial({ color: 0xb74735, roughness: 0.46 });

function ringPoints(flat) {
  const points = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push(new THREE.Vector2(flat[i], flat[i + 1]));
  if (points.length > 2 && points[0].distanceToSquared(points[points.length - 1]) < 0.0001) points.pop();
  return points;
}

function polygonGeometry(flat, y) {
  const contour = ringPoints(flat);
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = contour.map((p) => [p.x, y, p.y]).flat();
  const indices = triangles.flatMap(([a, b, c]) => [a, c, b]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function polygonEdges(flat, y) {
  const geometry = new THREE.BufferGeometry();
  const points = ringPoints(flat), positions = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    positions.push(a.x, y, a.y, b.x, y, b.y);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

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

function lineIntersections(flat, origin, axis, normal, u) {
  const points = ringPoints(flat).map((p) => {
    const dx = p.x - origin[0], dz = p.y - origin[1];
    return [dx * axis[0] + dz * axis[1], dx * normal[0] + dz * normal[1]];
  });
  const intersections = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if ((a[0] <= u && b[0] > u) || (b[0] <= u && a[0] > u)) {
      const f = (u - a[0]) / (b[0] - a[0]);
      intersections.push(a[1] + (b[1] - a[1]) * f);
    }
  }
  intersections.sort((a, b) => a - b);
  return intersections;
}

function plankGeometry(record, deckY) {
  const a = record.spine.start, b = record.spine.end;
  const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  const axis = [dx / length, dz / length], normal = [-axis[1], axis[0]], positions = [];
  for (let u = 0.10; u < length; u += 0.17) {
    const cuts = lineIntersections(record.dockRing, a, axis, normal, u);
    for (let j = 0; j + 1 < cuts.length; j += 2) {
      const p0 = [a[0] + axis[0] * u + normal[0] * cuts[j], a[1] + axis[1] * u + normal[1] * cuts[j]];
      const p1 = [a[0] + axis[0] * u + normal[0] * cuts[j + 1], a[1] + axis[1] * u + normal[1] * cuts[j + 1]];
      positions.push(p0[0], deckY + 0.012, p0[1], p1[0], deckY + 0.012, p1[1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function centroid(flat) {
  const points = ringPoints(flat);
  const total = points.reduce((acc, p) => [acc[0] + p.x, acc[1] + p.y], [0, 0]);
  return [total[0] / points.length, total[1] / points.length];
}

function quadMesh(quads, material) {
  const positions = [], indices = [];
  for (const q of quads) {
    const n = positions.length / 3;
    positions.push(...q.flat()); indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}
function addPavilion(group, record) {
  const base = record.deckHeight + 0.08, height = 3.05, points = ringPoints(record.pavilionRing);
  const walls = [], glazing = [], frame = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz);
    const panel = (low, high) => [[a.x, low, a.y], [b.x, low, b.y], [b.x, high, b.y], [a.x, high, a.y]];
    walls.push(panel(base, base + 0.34), panel(base + 2.80, base + height));
    if (i === points.length - 1) walls.push(panel(base + 0.34, base + 2.80));
    else {
      glazing.push(panel(base + 0.34, base + 2.80));
      const count = Math.max(1, Math.ceil(length / 1.0));
      for (let j = 0; j <= count; j++) {
        const t = j / count, x = a.x + dx * t, z = a.y + dz * t;
        frame.push(x, base + 0.34, z, x, base + 2.80, z);
      }
      for (const h of [1.25, 2.15]) frame.push(a.x, base + h, a.y, b.x, base + h, b.y);
    }
  }
  const timber = quadMesh(walls, pavilionTimber); timber.material.side = THREE.DoubleSide; group.add(timber);
  group.add(quadMesh(glazing, glassMaterial));
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(frame, 3));
  group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x242b2c })));
  group.add(new THREE.Mesh(polygonGeometry(record.pavilionRing, base), woodMaterial));
  const center = centroid(record.pavilionRing);
  const roofRing = record.pavilionRing.map((v, i) => center[i % 2] + (v - center[i % 2]) * 1.07);
  const roofY = base + height + 0.10;
  group.add(new THREE.Mesh(polygonGeometry(roofRing, roofY), solarMaterial));
  group.add(new THREE.LineSegments(polygonEdges(roofRing, roofY + 0.01), new THREE.LineBasicMaterial({ color: 0x9a9d96 })));
  const roofLines = [], a = [center[0] - 15, center[1] - 15];
  for (const [axis, normal] of [[[1, 0], [0, 1]], [[0, 1], [1, 0]]]) {
    for (let u = 0; u < 30; u += 0.8) {
      const cuts = lineIntersections(roofRing, a, axis, normal, u);
      for (let j = 0; j + 1 < cuts.length; j += 2) for (const v of [cuts[j], cuts[j + 1]]) roofLines.push(a[0] + axis[0] * u + normal[0] * v, roofY + 0.012, a[1] + axis[1] * u + normal[1] * v);
    }
  }
  const grid = new THREE.BufferGeometry(); grid.setAttribute('position', new THREE.Float32BufferAttribute(roofLines, 3));
  group.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x697d89, transparent: true, opacity: 0.45 })));
}
function makeFleetLayout(record) {
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
function boatRing(p) {
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  return [[-1, -2.5], [1, -2.5], [1, 2.5], [-1, 2.5]].flatMap(([x, z]) => [p.x + c * x + s * z, p.z - s * x + c * z]);
}
function addFleet(group, record, waterLevel) {
  const positions = makeFleetLayout(record), template = createGoBoat({ fleet: true }).group;
  template.updateMatrixWorld(true);
  const transform = new THREE.Matrix4(), local = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0), scale = new THREE.Vector3(1, 1, 1), position = new THREE.Vector3();
  template.traverse(mesh => {
    if (!mesh.isMesh) return;
    const instances = new THREE.InstancedMesh(mesh.geometry, mesh.material, positions.length);
    positions.forEach((p, i) => {
      transform.compose(position.set(p.x, waterLevel, p.z), quaternion.setFromAxisAngle(up, p.heading), scale);
      local.multiplyMatrices(transform, mesh.matrixWorld); instances.setMatrixAt(i, local);
    });
    instances.instanceMatrix.needsUpdate = true; group.add(instances);
  });
  const ropes = [];
  const buoyGeometry = new THREE.SphereGeometry(0.16, 10, 8);
  for (const p of positions) {
    const sx = Math.sin(p.heading), sz = Math.cos(p.heading);
    ropes.push(p.x + sx * 2.40, waterLevel + 0.68, p.z + sz * 2.40,
      p.x + sx * 2.90, record.deckHeight + 0.02, p.z + sz * 2.90);
    const buoy = new THREE.Mesh(buoyGeometry, buoyMaterial);
    buoy.position.set(p.x - sx * 2.8, waterLevel + 0.06, p.z - sz * 2.8); group.add(buoy);
  }
  const ropeGeometry = new THREE.BufferGeometry(); ropeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ropes, 3));
  group.add(new THREE.LineSegments(ropeGeometry, ropeMaterial));
  record.obstacles.push(...positions.map(boatRing));
  return positions;
}
function buildPier(group, record) {
  const deck = new THREE.Mesh(polygonGeometry(record.dockRing, record.deckHeight), woodMaterial);
  deck.receiveShadow = true; group.add(deck);
  const sides = [], points = ringPoints(record.dockRing);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], top = record.deckHeight;
    sides.push([[a.x, top, a.y], [a.x, top - 0.38, a.y], [b.x, top - 0.38, b.y], [b.x, top, b.y]]);
  }
  const skirt = quadMesh(sides, floatMaterial); skirt.material.side = THREE.DoubleSide; group.add(skirt);
  group.add(new THREE.LineSegments(plankGeometry(record, record.deckHeight), plankLineMaterial));
  group.add(new THREE.LineSegments(polygonEdges(record.dockRing, record.deckHeight + 0.01), plankLineMaterial));
  addPavilion(group, record);
}

/** Geometry and navigation share the observed dock footprint and inferred fleet moorings. */
export function createGoBoatPiers({ records = GOBOAT_PIER_RECORDS, frame = null, waterLevel = GOBOAT_SEA_LEVEL_LOCAL } = {}) {
  const group = new THREE.Group(); group.name = 'GoBoatIslandsBryggePier';
  const normalized = normalizeGoBoatPierRecords(records, frame);
  const fleets = [];
  for (const record of normalized) {
    record.deckHeight += waterLevel - GOBOAT_SEA_LEVEL_LOCAL;
    record.waterLevel = waterLevel;
    buildPier(group, record); fleets.push(addFleet(group, record, waterLevel));
  }
  const getDeckHeightAt = (x, z) => {
    for (const record of normalized) {
      const flat = record.dockRing;
      let inside = false;
      for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
        if ((flat[i + 1] > z) !== (flat[j + 1] > z) && x < (flat[j] - flat[i]) * (z - flat[i + 1]) / (flat[j + 1] - flat[i + 1]) + flat[i]) inside = !inside;
      }
      if (inside) return record.deckHeight;
    }
    return null;
  };
  return { group, records: normalized, fleetLayouts: fleets, obstacles: normalized.flatMap(r => r.obstacles), getDeckHeightAt };
}
