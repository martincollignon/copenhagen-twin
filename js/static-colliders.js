// Build pure, immutable-enough collision records from the final geometry and placed furniture plan.
import { triangulatePolygon } from './polygon-cph.js';
import { cleanRing } from './building-geometry.js';

const INDEX_CELL = 16;
const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;

function groundAt(groundHeight, x, z) {
  if (typeof groundHeight === 'function') return groundHeight(x, z);
  if (groundHeight?.terrainAt) return groundHeight.terrainAt(x, z);
  if (groundHeight?.terrain?.heightAt) return groundHeight.terrain.heightAt(x, z);
  if (groundHeight?.heightAt) return groundHeight.heightAt(x, z);
  return 0;
}

function boundsForRing(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    area += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return area / 2;
}

function boundaryData(ring, isHole, vertices) {
  const edges = [];
  const areaSign = Math.sign(signedArea(ring)) || 1;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
    const dx = bx - ax, dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-8) continue;
    // For positive x/z winding, the ring interior is left of an edge. Outer edges point right to free space;
    // hole edges point left into the walkable courtyard. Reverse both for negative winding.
    const side = (isHole ? 1 : -1) * areaSign;
    const nx = side * -dz / length, nz = side * dx / length;
    edges.push({ ax, az, bx, bz, nx, nz });
    vertices.push({ x: ax, z: az });
  }
  return edges;
}

function buildingCollider(building, groundHeight) {
  if (!building.ring || building.ring.length < 6 || !building.ring.every(Number.isFinite)) return null;
  const ring = cleanRing(building.ring, true)?.flat();
  if (!ring || ring.length < 6) return null;
  const holes = (building.holes || [])
    .filter((hole) => hole?.length >= 6 && hole.every(Number.isFinite))
    .map((hole) => cleanRing(hole, false)?.flat())
    .filter((hole) => hole?.length >= 6);
  const bounds = boundsForRing(ring);
  const triangles = triangulatePolygon(ring, holes);
  const boundaryVertices = [];
  const boundaryEdges = [
    ...boundaryData(ring, false, boundaryVertices),
    ...holes.flatMap((hole) => boundaryData(hole, true, boundaryVertices))
  ];
  // The extrusion skirt dips below the building's recorded base so sloping terrain never opens a gap.
  let minTerrain = numberOr(building.ground, 0);
  if (groundHeight) {
    for (const boundary of [ring, ...holes]) {
      for (let i = 0; i < boundary.length; i += 2) minTerrain = Math.min(minTerrain, groundAt(groundHeight, boundary[i], boundary[i + 1]));
    }
  }
  const eave = numberOr(building.eave, Math.max(3, minTerrain + 3));
  const hipped = holes.length === 0 && ring.length === 8 && building.roof !== 'flat' && numberOr(building.ridge, eave) > eave + 1.5;
  const maxY = hipped ? Math.max(eave + 0.45, Math.min(numberOr(building.ridge, eave), eave + 6.5)) : eave + 0.45;
  return {
    id: `building:${building.id ?? 'unknown'}`,
    type: 'building',
    ...bounds,
    minY: groundHeight ? minTerrain - 0.25 : Math.min(minTerrain, 0) - 0.1,
    maxY,
    ring: Array.from(ring),
    holes: holes.map((hole) => Array.from(hole)),
    triangles,
    boundaryEdges,
    boundaryVertices
  };
}

function obbCollider(id, type, x, y, z, yaw, width, length, height) {
  const hx = Math.max(0.01, width) * 0.5;
  const hz = Math.max(0.01, length) * 0.5;
  const cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
  const extX = Math.abs(cs) * hx + Math.abs(sn) * hz;
  const extZ = Math.abs(sn) * hx + Math.abs(cs) * hz;
  return {
    id, type,
    minX: x - extX, maxX: x + extX, minZ: z - extZ, maxZ: z + extZ,
    minY: y, maxY: y + height,
    obb: { cx: x, cz: z, hx, hz, cs, sn }
  };
}

function circleCollider(id, type, x, y, z, radius, height) {
  const r = Math.max(0.025, radius);
  return {
    id, type,
    shape: 'circle', radius: r,
    minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r,
    minY: y, maxY: y + height,
    obb: { cx: x, cz: z, hx: r, hz: r, cs: 1, sn: 0 }
  };
}

function offsetByYaw(item, localX, localZ) {
  const c = Math.cos(item.yaw || 0), s = Math.sin(item.yaw || 0);
  return { x: item.x + c * localX + s * localZ, z: item.z - s * localX + c * localZ };
}

function appendShelters(colliders, shelters, groundHeight) {
  appendPlaced(colliders, shelters, (shelter, index) => {
    const baseY = numberOr(shelter.y, groundAt(groundHeight, shelter.x, shelter.z));
    const yaw = shelter.yaw || 0;
    const add = (suffix, type, localX, localZ, width, depth, minY, height, localYaw = yaw) => {
      const point = offsetByYaw(shelter, localX, localZ);
      colliders.push(obbCollider(`shelter:${index}:${suffix}`, type, point.x, baseY + minY, point.z,
        localYaw, width, depth, height));
    };
    // Four visible corner posts, open at +z, glass only across the back and sides, and a roof high enough to
    // leave pedestrians and cars underneath. The render plan places an actual shelter rather than a solid box.
    for (const x of [-1.45, 1.45]) for (const z of [-0.7, 0.7]) add(`post:${x}:${z}`, 'shelter-post', x, z, 0.06, 0.06, 0, 2.35);
    add('back-glass', 'shelter-glass', 0, -0.7, 2.84, 0.025, 0.45, 1.6);
    for (const x of [-1.45, 1.45]) add(`side-glass:${x}`, 'shelter-glass', x, 0, 0.025, 1.34, 0.45, 1.6);
    add('roof', 'shelter-roof', 0, 0, 3.2, 1.7, 2.36, 0.08, yaw + 0.05);
    add('bench', 'shelter-bench', 0, -0.42, 2, 0.4, 0.44, 0.08);
    return null;
  });
}

function appendPlaced(colliders, list, make) {
  for (let i = 0; i < (list || []).length; i++) {
    const item = list[i];
    if (!Number.isFinite(item.x) || !Number.isFinite(item.z)) continue;
    const collider = make(item, i);
    if (collider) colliders.push(collider);
  }
}

/**
 * Build static colliders from the final geodata and furniture plan.
 * `furniturePlan` is the plan returned by createStreetFurniture, after placement and ground sampling.
 */
export function buildStaticColliders(geo, { furniturePlan = null, carSpecs = {}, groundHeight = null } = {}) {
  const colliders = [];
  for (const building of geo?.buildings || []) {
    const collider = buildingCollider(building, groundHeight);
    if (collider) colliders.push(collider);
  }
  const candidatePlan = furniturePlan?.plan || furniturePlan;
  // Raw cph-furniture.json has trees/lamps but not the placed cars and ground sampled by buildFurniturePlan.
  const plan = Array.isArray(candidatePlan?.trees) && Array.isArray(candidatePlan?.lamps) && Array.isArray(candidatePlan?.cars)
    ? candidatePlan : null;
  if (plan) {
    appendPlaced(colliders, plan.trees, (tree, index) => {
      const y = numberOr(tree.y, groundAt(groundHeight, tree.x, tree.z));
      const radius = Math.max(0.14, Math.min(0.55, numberOr(tree.height, 8) * 0.0225));
      return circleCollider(`tree:${index}`, 'tree', tree.x, y, tree.z, radius,
        Math.max(2.2, numberOr(tree.crown?.base, 3.2)));
    });
    appendPlaced(colliders, plan.lamps, (lamp, index) => {
      if (lamp.mount === 'wire' || lamp.bracket) return null;
      const y = numberOr(lamp.y, groundAt(groundHeight, lamp.x, lamp.z));
      return circleCollider(`lamp:${index}`, 'lamp', lamp.x, y, lamp.z, lamp.pole === 'kbh' ? 0.19 : lamp.pole === 'park' ? 0.11 : 0.12,
        Math.max(1.2, numberOr(lamp.poleH, 3)));
    });
    appendPlaced(colliders, plan.cars, (car, index) => {
      const spec = carSpecs?.[car.body] || {};
      const width = numberOr(spec.width, car.body === 'van' ? 2 : car.body === 'crossoverEV' ? 1.88 : car.body === 'estate' ? 1.83 : 1.79);
      const length = numberOr(spec.length, car.body === 'van' ? 5.9 : car.body === 'crossoverEV' ? 4.6 : car.body === 'estate' ? 4.7 : 4.2);
      const height = numberOr(spec.height, car.body === 'van' ? 2.65 : car.body === 'crossoverEV' ? 1.63 : 1.5);
      return obbCollider(`parked-car:${index}`, 'parked-car', car.x, numberOr(car.y, groundAt(groundHeight, car.x, car.z)), car.z, car.yaw || 0, width, length, height);
    });
    appendPlaced(colliders, plan.bollards, (item, index) => circleCollider(`bollard:${index}`, 'bollard', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, item.material === 'granite' ? 0.15 : 0.08,
      item.material === 'granite' ? 0.77 : 0.9));
    appendPlaced(colliders, plan.benches, (item, index) => obbCollider(`bench:${index}`, 'bench', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, item.yaw || 0, numberOr(item.length, 1.8), 0.56, 0.95));
    appendPlaced(colliders, plan.bins, (item, index) => circleCollider(`bin:${index}`, 'bin', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, 0.26, 0.89));
    appendPlaced(colliders, plan.glass, (item, index) => circleCollider(`glass:${index}`, 'glass-container', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, 0.75, 1.16));
    appendPlaced(colliders, plan.meters, (item, index) => obbCollider(`meter:${index}`, 'parking-meter', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, item.yaw || 0, 0.46, 0.32, 1.43));
    appendPlaced(colliders, plan.stands, (item, index) => {
      const y = numberOr(item.y, groundAt(groundHeight, item.x, item.z));
      for (let k = -1; k <= 1; k++) {
        const point = offsetByYaw(item, k * 0.68, 0);
        colliders.push(obbCollider(`bin-stand:${index}:${k}`, 'bin-stand', point.x, y + 0.16, point.z,
          item.yaw || 0, 0.56, 0.66, 0.84));
      }
      return null;
    });
    appendPlaced(colliders, plan.hoops, (item, index) => {
      for (const localZ of [-0.2, 0.2]) {
        const point = offsetByYaw(item, 0, localZ);
        colliders.push(circleCollider(`rack-hoop:${index}:${localZ}`, 'bike-rack', point.x,
          numberOr(item.y, groundAt(groundHeight, item.x, item.z)), point.z, 0.015, 0.74));
      }
      colliders.push(obbCollider(`rack-hoop:${index}:top`, 'bike-rack', item.x,
        numberOr(item.y, groundAt(groundHeight, item.x, item.z)) + 0.735, item.z, item.yaw || 0, 0.43, 0.03, 0.03));
      return null;
    });
    appendPlaced(colliders, plan.bikes, (item, index) => {
      const size = numberOr(item.size, 1);
      return obbCollider(`parked-bike:${index}`, 'parked-bike', item.x,
        numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, item.yaw || 0, 0.5 * size, 1.75 * size, 1.2 * size);
    });
    appendShelters(colliders, plan.shelters, groundHeight);
    appendPlaced(colliders, plan.flags, (item, index) => circleCollider(`bus-flag:${index}`, 'bus-flag', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, 0.04, 3.9));
    appendPlaced(colliders, plan.countdowns, (item, index) => {
      const point = offsetByYaw(item, 0, 0.12);
      return obbCollider(`bus-countdown:${index}`, 'bus-countdown', point.x,
        numberOr(item.y, groundAt(groundHeight, item.x, item.z)) + 2.4, point.z, item.yaw || 0, 0.62, 0.1, 0.3);
    });
    appendPlaced(colliders, plan.rescue, (item, index) => circleCollider(`rescue:${index}`, 'rescue-post', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, 0.25, 1.7));
    appendPlaced(colliders, plan.lakeLights, (item, index) => circleCollider(`lake-light:${index}`, 'lake-light', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, 0.06, 1.05));
    appendPlaced(colliders, plan.monuments, (item, index) => obbCollider(`monument:${index}`, 'monument', item.x,
      numberOr(item.y, groundAt(groundHeight, item.x, item.z)), item.z, item.yaw || 0, 1.3, 1.3, 2.3));
  }
  return colliders;
}

/** 16 m uniform grid. query() clears and reuses `out`, returning only nearby broad-phase records in build order. */
export function createStaticIndex(colliders) {
  const cells = new Map();
  const seen = new WeakMap();
  const orderOf = new WeakMap();
  const key = (ix, iz) => `${ix}:${iz}`;
  for (let order = 0; order < (colliders || []).length; order++) {
    const collider = colliders[order];
    orderOf.set(collider, order);
    for (let ix = Math.floor(collider.minX / INDEX_CELL); ix <= Math.floor(collider.maxX / INDEX_CELL); ix++) {
      for (let iz = Math.floor(collider.minZ / INDEX_CELL); iz <= Math.floor(collider.maxZ / INDEX_CELL); iz++) {
        const k = key(ix, iz);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(collider);
      }
    }
  }
  let stamp = 0;
  return {
    query(x, z, radius, out = []) {
      out.length = 0;
      const current = ++stamp;
      const minX = Math.floor((x - radius) / INDEX_CELL), maxX = Math.floor((x + radius) / INDEX_CELL);
      const minZ = Math.floor((z - radius) / INDEX_CELL), maxZ = Math.floor((z + radius) / INDEX_CELL);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iz = minZ; iz <= maxZ; iz++) {
          const list = cells.get(key(ix, iz));
          if (!list) continue;
          for (const collider of list) {
            if (seen.get(collider) === current) continue;
            seen.set(collider, current);
            if (collider.maxX < x - radius || collider.minX > x + radius || collider.maxZ < z - radius || collider.minZ > z + radius) continue;
            out.push(collider);
          }
        }
      }
      if (out.length > 1) out.sort((a, b) => orderOf.get(a) - orderOf.get(b));
      return out;
    }
  };
}

/**
 * The static index of a streamed city: one createStaticIndex per tile part (a tile's buildings, its placed furniture), set when the
 * part streams in and dropped when it goes, behind the same query(). Parts are skipped by their bounds first, so a query costs one
 * bounds test per resident part plus the grid lookups of the parts it touches.
 */
export function createTiledStaticIndex() {
  const parts = new Map(); // key -> { index, colliders, minX, minZ, maxX, maxZ, count }
  const scratch = [];
  let colliderCount = 0;
  return {
    set(key, colliders) {
      this.remove(key);
      if (!colliders?.length) return;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const c of colliders) {
        if (c.minX < minX) minX = c.minX;
        if (c.minZ < minZ) minZ = c.minZ;
        if (c.maxX > maxX) maxX = c.maxX;
        if (c.maxZ > maxZ) maxZ = c.maxZ;
      }
      parts.set(key, { index: createStaticIndex(colliders), colliders, minX, minZ, maxX, maxZ, count: colliders.length });
      colliderCount += colliders.length;
    },
    remove(key) {
      const part = parts.get(key);
      if (!part) return;
      colliderCount -= part.count;
      parts.delete(key);
    },
    query(x, z, radius, out = []) {
      out.length = 0;
      for (const part of parts.values()) {
        if (part.maxX < x - radius || part.minX > x + radius || part.maxZ < z - radius || part.minZ > z + radius) continue;
        part.index.query(x, z, radius, scratch);
        for (let i = 0; i < scratch.length; i++) out.push(scratch[i]);
      }
      return out;
    },
    /** Every resident collider (a fresh array: for tools and checks, not per frame). */
    all() { return [...parts.values()].flatMap((part) => part.colliders); },
    get parts() { return parts.size; },
    get size() { return colliderCount; }
  };
}
