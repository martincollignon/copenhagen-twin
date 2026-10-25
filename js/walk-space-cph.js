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
