// Tree-only submission budgets, compared with the original trees at the same camera.
// Seasonal savings can pay for observed additions and litter; closer trees win.
export const TREE_LOD = Object.freeze({ near: 34, mid: 200, far: 950 });
export const TREE_CAPACITY = Object.freeze({ near: 260, mid: 900, far: 4000 });
export const treeLod = distance => distance <= TREE_LOD.near ? 'near' : distance <= TREE_LOD.mid ? 'mid' : 'far';

export function treeCapacities(trees, original = false) {
  const counts = {};
  for (const t of trees) {
    if (original && t.canopyAdded) continue;
    const genus = original ? t.baselineGenus : t.genus;
    counts[genus] = (counts[genus] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([genus, n]) => [genus,
    Object.fromEntries(Object.entries(TREE_CAPACITY).map(([lod, cap]) => [lod, Math.min(n, cap)]))]));
}

/** Counts the unchanged main geometry, including its per-genus mesh capacities. */
export function originalTreeBudget(candidates, fullCosts, capacities) {
  const groups = new Map();
  let triangles = 0, shadows = 0;
  for (const { tree: t, distance } of candidates) {
    if (t.canopyAdded || distance > TREE_LOD.far) continue;
    const lod = treeLod(distance), genus = t.baselineGenus;
    const key = `${lod}:${genus}`, count = groups.get(key) || 0;
    if (count < capacities[genus][lod]) {
      groups.set(key, count + 1);
      triangles += fullCosts[genus][lod];
    }
    if (distance <= 90) shadows++;
  }
  return { draws: groups.size, triangles, shadows: Math.min(600, shadows) };
}

/** Reserve distant coverage first, then spend the remaining budget on nearby detail. */
export function selectTreeDraws(candidates, costs, capacities, budget) {
  const groups = new Map(), selected = [];
  let triangles = 0;
  for (const candidate of [...candidates].sort((a, b) => a.distance - b.distance)) {
    const { tree: t, distance } = candidate;
    if (distance > TREE_LOD.far) continue;
    const key = `far:${t.genus}`, count = groups.get(key) || 0;
    if (count >= capacities[t.genus].far || (!count && groups.size >= budget.draws)) continue;
    if (triangles + costs[t.genus].far > budget.triangles) continue;
    groups.set(key, count + 1);
    triangles += costs[t.genus].far;
    selected.push({ ...candidate, lod: 'far' });
  }
  for (const lod of ['near', 'mid']) {
    for (const candidate of selected) {
      const { tree: t, distance } = candidate;
      if (candidate.lod !== 'far' || distance > TREE_LOD[lod]) continue;
      const key = `${lod}:${t.genus}`, count = groups.get(key) || 0;
      const farKey = `far:${t.genus}`, farCount = groups.get(farKey);
      const draws = groups.size + (count ? 0 : 1) - (farCount === 1 ? 1 : 0);
      const delta = costs[t.genus][lod] - costs[t.genus].far;
      if (count >= capacities[t.genus][lod] || draws > budget.draws || triangles + delta > budget.triangles) continue;
      if (farCount === 1) groups.delete(farKey); else groups.set(farKey, farCount - 1);
      groups.set(key, count + 1);
      triangles += delta;
      candidate.lod = lod;
    }
  }
  return { selected, draws: groups.size, triangles };
}

/** Count physical vertex streams; count instanceMatrix as four even on storage-buffer paths. */
export function treeVertexBufferCount(geometry, { instanced = true, colored = false } = {}) {
  const buffers = new Set(Object.values(geometry.attributes).map(a => a.isInterleavedBufferAttribute ? a.data : a));
  return buffers.size + (instanced ? 4 : 0) + (colored ? 1 : 0);
}
