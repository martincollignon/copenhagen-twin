import * as THREE from 'three/webgpu';

const BATCHABLE_MESH_NAMES = new Set(['walls', 'roofs', 'entrance-doors']);

function offsetRanges(ranges, offset) {
  if (!Array.isArray(ranges)) return [];
  return ranges.map((range) => ({ ...range, start: range.start + offset, end: range.end + offset }));
}

/** Packs the static mesh children of named building cells into material/name batches. */
function batchBuildingCells(root, leaves, pickables) {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groupsByMaterial = new Map();
  const originallyPickable = new Set(pickables);

  for (const cell of leaves) {
    if (cell.name !== 'buildings-cell') continue;
    for (const mesh of cell.children) {
      if (!mesh.isMesh || !BATCHABLE_MESH_NAMES.has(mesh.name) || Array.isArray(mesh.material)) continue;
      const position = mesh.geometry?.getAttribute('position');
      if (!position || !mesh.material) continue;

      let groupsByName = groupsByMaterial.get(mesh.material);
      if (!groupsByName) groupsByMaterial.set(mesh.material, groupsByName = new Map());
      let group = groupsByName.get(mesh.name);
      if (!group) {
        group = { material: mesh.material, name: mesh.name, sources: [], vertexCount: 0, indexCount: 0 };
        groupsByName.set(mesh.name, group);
      }
      group.sources.push({ mesh, cell });
      group.vertexCount += position.count;
      group.indexCount += mesh.geometry.index?.count ?? position.count;
    }
  }

  const batches = [];
  const replacementBySource = new Map();
  for (const groupsByName of groupsByMaterial.values()) {
    for (const group of groupsByName.values()) {
      const batch = new THREE.BatchedMesh(
        group.sources.length,
        group.vertexCount,
        group.indexCount,
        group.material
      );
      batch.name = group.name;
      batch.sortObjects = false;
      batch.perObjectFrustumCulled = true;
      batch.castShadow = group.sources[0].mesh.castShadow;
      batch.receiveShadow = group.sources[0].mesh.receiveShadow;
      batch.userData.ranges = [];
      batch.userData.detailRanges = [];

      let isPickable = false;
      for (const { mesh, cell } of group.sources) {
        const geometryId = batch.addGeometry(mesh.geometry);
        const indexOffset = batch.getGeometryRangeAt(geometryId).indexStart;
        const instanceId = batch.addInstance(geometryId);
        const instanceMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
        batch.setMatrixAt(instanceId, instanceMatrix);
        if (cell.visible === false) batch.setVisibleAt(instanceId, false);

        if (!cell.userData.batchInstances) cell.userData.batchInstances = [];
        cell.userData.batchInstances.push({ batch, instanceId });
        batch.userData.ranges.push(...offsetRanges(mesh.userData.ranges, indexOffset));
        batch.userData.detailRanges.push(...offsetRanges(mesh.userData.detailRanges, indexOffset));
        if (originallyPickable.has(mesh)) isPickable = true;

        cell.remove(mesh);
        const geometry = mesh.geometry;
        geometry.dispose();
        mesh.geometry = null;
      }

      batch.computeBoundingBox();
      batch.computeBoundingSphere();
      root.add(batch);
      batches.push(batch);
      if (isPickable) {
        for (const { mesh } of group.sources) replacementBySource.set(mesh, batch);
      }
    }
  }

  if (replacementBySource.size) {
    const nextPickables = [];
    const addedBatches = new Set();
    for (const pickable of pickables) {
      const replacement = replacementBySource.get(pickable);
      if (!replacement) {
        nextPickables.push(pickable);
      } else if (!addedBatches.has(replacement)) {
        nextPickables.push(replacement);
        addedBatches.add(replacement);
      }
    }
    pickables.splice(0, pickables.length, ...nextPickables);
  }

  return batches;
}

/** Mirrors cell streaming visibility onto each batched instance in that cell. */
function updateBuildingCellVisibility(cell, visible) {
  if (cell.visible === visible) return;
  cell.visible = visible;
  for (const { batch, instanceId } of cell.userData.batchInstances || []) {
    batch.setVisibleAt(instanceId, visible);
  }
}

export { batchBuildingCells, updateBuildingCellVisibility };
