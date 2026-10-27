import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function hasMorphTargets(mesh) {
  const attributes = mesh.geometry?.morphAttributes || {};
  return mesh.morphTargetInfluences != null || Object.values(attributes).some((targets) => targets?.length > 0);
}

function hasCustomNodeMaterial(material) {
  return Object.keys(material).some((key) => /Node$/.test(key) && material[key] != null);
}

function canMerge(mesh, protectedMeshes) {
  if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.children?.length) return false;
  if (protectedMeshes.has(mesh) || mesh.visible === false || !mesh.geometry) return false;
  if (mesh.geometry.isInstancedBufferGeometry || hasMorphTargets(mesh)) return false;
  const drawRange = mesh.geometry.drawRange;
  if (drawRange && (drawRange.start !== 0 || drawRange.count !== Infinity)) return false;

  const material = mesh.material;
  if (!material || Array.isArray(material) || material.visible === false || material.transparent || material.opacity < 1) return false;
  if (material.alphaTest > 0 || material.alphaHash || material.alphaToCoverage || hasCustomNodeMaterial(material)) return false;
  return true;
}

function attributeLayout(geometry) {
  return Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, attribute]) => [
    name,
    attribute.itemSize,
    !!attribute.normalized,
    attribute.array?.constructor?.name || null,
    !!attribute.isInterleavedBufferAttribute,
    attribute.data?.stride ?? null,
    attribute.offset ?? null,
    attribute.gpuType ?? null,
    attribute.usage ?? null,
    attribute.meshPerAttribute ?? null,
    !!attribute.isInstancedBufferAttribute
  ]);
}

function compatibilityKey(mesh) {
  return JSON.stringify([
    attributeLayout(mesh.geometry),
    !!mesh.geometry.index,
    mesh.layers?.mask ?? 1,
    mesh.renderOrder ?? 0,
    mesh.frustumCulled ?? true,
    !!mesh.castShadow,
    !!mesh.receiveShadow
  ]);
}

function groupSiblings(parent, protectedMeshes) {
  const byMaterial = new Map();
  for (const child of parent.children || []) {
    if (!canMerge(child, protectedMeshes)) continue;
    const material = child.material;
    let byState = byMaterial.get(material);
    if (!byState) byMaterial.set(material, byState = new Map());
    const key = compatibilityKey(child);
    let group = byState.get(key);
    if (!group) byState.set(key, group = []);
    group.push(child);
  }
  return [...byMaterial.values()].flatMap((byState) => [...byState.values()]);
}

function localDeterminant(mesh) {
  if (mesh.matrixAutoUpdate && typeof mesh.updateMatrix === 'function') mesh.updateMatrix();
  if (typeof mesh.matrix?.determinant === 'function') return mesh.matrix.determinant();

  const e = mesh.matrix?.elements;
  if (!e) return 1;
  return e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
}

function mergeGroup(parent, sources) {
  const clones = [];
  let mergedGeometry = null;
  try {
    for (const source of sources) {
      if (localDeterminant(source) < 0 || !source.matrix) return false;
      const clone = source.geometry.clone();
      clones.push(clone);
      clone.applyMatrix4(source.matrix);
    }

    mergedGeometry = mergeGeometries(clones, false);
    if (!mergedGeometry) return false;
    mergedGeometry.computeBoundingBox();
    mergedGeometry.computeBoundingSphere();

    const first = sources[0];
    const merged = new first.constructor(mergedGeometry, first.material);
    merged.layers.mask = first.layers?.mask ?? 1;
    merged.renderOrder = first.renderOrder ?? 0;
    merged.frustumCulled = first.frustumCulled ?? true;
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;

    const firstIndex = Math.min(...sources.map((source) => parent.children.indexOf(source)));
    parent.add(merged);
    for (const source of sources) parent.remove(source);
    parent.children.splice(parent.children.indexOf(merged), 1);
    parent.children.splice(Math.min(firstIndex, parent.children.length), 0, merged);
    return true;
  } catch (_error) {
    mergedGeometry?.dispose?.();
    return false;
  } finally {
    for (const clone of clones) clone.dispose?.();
  }
}

/** Merge rigid siblings before their first GPU upload; protect any Mesh animated independently of its parent. */
export function mergeRigidMeshes(root, protectedMeshes = new Set()) {
  const stats = { groupsMerged: 0, meshesMerged: 0, meshesRemoved: 0, drawCallsReduced: 0 };

  function process(parent) {
    for (const child of [...(parent.children || [])]) {
      if (child.children?.length) process(child);
    }

    for (const sources of groupSiblings(parent, protectedMeshes)) {
      if (sources.length < 2 || !mergeGroup(parent, sources)) continue;
      stats.groupsMerged++;
      stats.meshesMerged += sources.length;
      stats.meshesRemoved += sources.length;
      stats.drawCallsReduced += sources.length - 1;
    }
  }

  if (root) process(root);
  return stats;
}
