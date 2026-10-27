const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const geometryClones = [];
let mergeBehavior = 'merge';

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeTranslation(x, y, z) {
    this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
    return this;
  }
  determinant() { const e = this.elements; return e[0] * e[5] * e[10]; }
}

class BufferAttribute {
  constructor(array, itemSize, normalized = false) {
    this.array = ArrayBuffer.isView(array) ? new array.constructor(array) : new Float32Array(array);
    this.itemSize = itemSize;
    this.count = this.array.length / itemSize;
    this.normalized = normalized;
  }
  clone() { return new BufferAttribute(this.array, this.itemSize, this.normalized); }
}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.morphAttributes = {};
    this.groups = [];
  }
  setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
  setIndex(index) { this.index = index == null ? null : { array: ArrayBuffer.isView(index) ? index : new Uint16Array(index) }; return this; }
  clone() {
    const copy = new BufferGeometry();
    for (const [name, attribute] of Object.entries(this.attributes)) copy.setAttribute(name, attribute.clone());
    if (this.index) copy.index = { array: new this.index.array.constructor(this.index.array) };
    copy.morphAttributes = this.morphAttributes;
    copy.groups = this.groups.map((group) => ({ ...group }));
    geometryClones.push(copy);
    return copy;
  }
  applyMatrix4(matrix) {
    const position = this.attributes.position;
    const e = matrix.elements;
    for (let i = 0; i < position.count; i++) {
      const x = position.array[i * 3], y = position.array[i * 3 + 1], z = position.array[i * 3 + 2];
      position.array[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      position.array[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      position.array[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return this;
  }
  computeBoundingBox() { this.boundingBoxComputed = true; }
  computeBoundingSphere() { this.boundingSphereComputed = true; }
  dispose() { this.disposed = true; }
}

class Object3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.position = { x: 0, y: 0, z: 0 };
    this.matrix = new Matrix4();
    this.matrixAutoUpdate = true;
    this.layers = { mask: 1 };
    this.renderOrder = 0;
    this.frustumCulled = true;
    this.castShadow = false;
    this.receiveShadow = false;
  }
  add(...objects) {
    for (const object of objects) {
      object.parent?.remove(object);
      this.children.push(object);
      object.parent = this;
    }
  }
  remove(object) {
    const index = this.children.indexOf(object);
    if (index >= 0) this.children.splice(index, 1);
    object.parent = null;
  }
  updateMatrix() {
    this.matrix.makeTranslation(this.position.x, this.position.y, this.position.z);
    this.matrixUpdates = (this.matrixUpdates || 0) + 1;
  }
}

class Group extends Object3D {}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; }
}
class InstancedMesh extends Mesh { constructor(geometry, material) { super(geometry, material); this.isInstancedMesh = true; } }
class SkinnedMesh extends Mesh { constructor(geometry, material) { super(geometry, material); this.isSkinnedMesh = true; } }

function triangleGeometry({ indexed = true, extraAttribute = false, morphTargets = false } = {}) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  if (extraAttribute) geometry.setAttribute('custom', new BufferAttribute([1, 2, 3], 1));
  if (indexed) geometry.setIndex([0, 1, 2]);
  if (morphTargets) geometry.morphAttributes.position = [new BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)];
  return geometry;
}

function makeMesh(material, options = {}) {
  const mesh = new Mesh(options.geometry || triangleGeometry(), material);
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  if (options.layer != null) mesh.layers.mask = options.layer;
  if (options.renderOrder != null) mesh.renderOrder = options.renderOrder;
  if (options.frustumCulled != null) mesh.frustumCulled = options.frustumCulled;
  return mesh;
}

function mergeGeometries(geometries) {
  if (mergeBehavior === 'throw') throw new Error('forced merge error');
  if (mergeBehavior === 'null') return null;

  const first = geometries[0];
  const names = Object.keys(first.attributes);
  if (geometries.some((geometry) => JSON.stringify(Object.keys(geometry.attributes).sort()) !== JSON.stringify(names.slice().sort()))) return null;
  if (geometries.some((geometry) => !!geometry.index !== !!first.index)) return null;

  const merged = new BufferGeometry();
  for (const name of names) {
    const attributes = geometries.map((geometry) => geometry.attributes[name]);
    const values = attributes.flatMap((attribute) => Array.from(attribute.array));
    merged.setAttribute(name, new BufferAttribute(values, attributes[0].itemSize, attributes[0].normalized));
  }
  if (first.index) {
    const indices = [];
    let offset = 0;
    for (const geometry of geometries) {
      indices.push(...geometry.index.array.map((index) => index + offset));
      offset += geometry.attributes.position.count;
    }
    merged.setIndex(indices);
  }
  return merged;
}

const { mergeRigidMeshes } = loadModule(readFileSync(join(__dirname, '../js/rigid-meshes.js'), 'utf8'), {
  imports: { 'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries } },
  filename: 'rigid-meshes.js'
});

test('merges transformed siblings and keeps shared source geometry untouched', () => {
  geometryClones.length = 0;
  mergeBehavior = 'merge';
  const material = { color: 'uniform' };
  const sharedGeometry = triangleGeometry();
  const root = new Group();
  const manual = makeMesh(material, { geometry: sharedGeometry });
  manual.matrixAutoUpdate = false;
  manual.matrix.makeTranslation(2, 0, 0);
  const automatic = makeMesh(material, { geometry: sharedGeometry });
  automatic.position.x = 5;
  root.add(manual, automatic);

  const stats = mergeRigidMeshes(root);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { groupsMerged: 1, meshesMerged: 2, meshesRemoved: 2, drawCallsReduced: 1 });
  assert.equal(root.children.length, 1);
  const merged = root.children[0];
  assert.equal(merged.material, material);
  assert.equal(merged.castShadow, true);
  assert.equal(merged.receiveShadow, true);
  assert.equal(merged.frustumCulled, true);
  assert.equal(merged.geometry.boundingBoxComputed, true);
  assert.equal(merged.geometry.boundingSphereComputed, true);
  assert.deepEqual(Array.from(merged.geometry.attributes.position.array), [
    2, 0, 0, 3, 0, 0, 2, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0
  ]);
  assert.equal(manual.matrixUpdates || 0, 0, 'a manual matrix stays untouched');
  assert.equal(automatic.matrixUpdates, 1, 'auto-updated local transforms are refreshed');
  assert.equal(sharedGeometry.disposed, undefined, 'original shared geometry is retained');
  assert.deepEqual(Array.from(sharedGeometry.attributes.position.array), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(geometryClones.length, 2);
  assert.ok(geometryClones.every((geometry) => geometry.disposed), 'temporary geometry clones are disposed');
});

test('keeps material, layer, render, shadow, index, and attribute-layout boundaries separate', () => {
  mergeBehavior = 'merge';
  const root = new Group();
  const material = { color: 'same' };
  const pairs = [];
  const addPair = (options = {}) => {
    const pair = [makeMesh(options.material || material, options), makeMesh(options.material || material, options)];
    root.add(...pair);
    pairs.push(pair);
  };

  addPair();
  addPair({ layer: 2 });
  addPair({ renderOrder: 4 });
  addPair({ castShadow: false });
  addPair({ receiveShadow: false });
  addPair({ frustumCulled: false });
  addPair({ material: { color: 'same values, different identity' } });
  addPair({ geometry: triangleGeometry({ indexed: false }) });
  addPair({ geometry: triangleGeometry({ extraAttribute: true }) });

  const stats = mergeRigidMeshes(root);
  assert.equal(stats.groupsMerged, pairs.length);
  assert.equal(stats.meshesRemoved, pairs.length * 2);
  assert.equal(root.children.length, pairs.length);
  assert.equal(root.children.some((mesh) => !mesh.geometry.index), true, 'nonindexed geometry merges only with nonindexed siblings');
  assert.equal(root.children.some((mesh) => mesh.layers.mask === 2), true);
  assert.equal(root.children.some((mesh) => mesh.renderOrder === 4), true);
  assert.equal(root.children.some((mesh) => mesh.castShadow === false), true);
  assert.equal(root.children.some((mesh) => mesh.receiveShadow === false), true);
  assert.equal(root.children.some((mesh) => mesh.frustumCulled === false), true);
  assert.equal(root.children.some((mesh) => Object.hasOwn(mesh.geometry.attributes, 'custom')), true);
  assert.equal(root.children.some((mesh) => mesh.material !== material), true);
});

test('preserves Group pivots and individually protected pedal and linkage Mesh references', () => {
  mergeBehavior = 'merge';
  const root = new Group();
  const pivot = new Group();
  root.add(pivot);
  const material = { color: 'moving-part material' };
  const pedals = [makeMesh(material), makeMesh(material)];
  const steeringLinkage = makeMesh(material);
  const staticA = makeMesh(material);
  const staticB = makeMesh(material);
  pivot.add(...pedals, steeringLinkage, staticA, staticB);

  const stats = mergeRigidMeshes(root, new Set([...pedals, steeringLinkage]));
  assert.equal(stats.groupsMerged, 1);
  assert.equal(root.children[0], pivot);
  assert.equal(pedals.every((pedal) => pedal.parent === pivot && pivot.children.includes(pedal)), true);
  assert.equal(steeringLinkage.parent, pivot);
  assert.equal(pivot.children.length, 4, 'the pivot, pedal refs, linkage ref, and one static merged mesh remain');
  assert.equal(pivot.children.some((child) => child.isMesh && child !== steeringLinkage && pedals.includes(child)), true);
});

test('skips reflected local transforms and Mesh objects that have children', () => {
  mergeBehavior = 'merge';
  const root = new Group();
  const material = {};
  const reflected = makeMesh(material);
  reflected.matrixAutoUpdate = false;
  reflected.matrix.elements[0] = -1;
  const unreflected = makeMesh(material);
  const meshParent = makeMesh(material);
  const sibling = makeMesh({});
  const innerA = makeMesh(material);
  const innerB = makeMesh(material);
  meshParent.add(innerA, innerB);
  root.add(reflected, unreflected, meshParent, sibling);

  const stats = mergeRigidMeshes(root);
  assert.equal(stats.groupsMerged, 1, 'only the two inner leaf meshes merge');
  assert.equal(root.children.includes(reflected), true);
  assert.equal(root.children.includes(unreflected), true);
  assert.equal(root.children.includes(meshParent), true);
  assert.equal(root.children.includes(sibling), true);
  assert.equal(meshParent.children.length, 1);
});

test('skips transparent, alpha-tested, instanced, skinned, morph, hidden, array, and custom-node meshes', () => {
  mergeBehavior = 'merge';
  const root = new Group();
  const addPair = (material, create = (geo) => new Mesh(geo, material)) => {
    const pair = [create(triangleGeometry()), create(triangleGeometry())];
    root.add(...pair);
    return pair;
  };
  const morphPair = [makeMesh({}, { geometry: triangleGeometry({ morphTargets: true }) }), makeMesh({}, { geometry: triangleGeometry({ morphTargets: true }) })];
  const hiddenPair = [makeMesh({}), makeMesh({})];
  root.add(...morphPair, ...hiddenPair);
  const pairs = [
    addPair({ transparent: true }),
    addPair({ alphaTest: 0.2 }),
    addPair({ opacity: 0.5 }),
    addPair({}, (geometry, material = {}) => new InstancedMesh(geometry, material)),
    addPair({}, (geometry, material = {}) => new SkinnedMesh(geometry, material)),
    addPair({ colorNode: { kind: 'custom color' } }),
    addPair({ positionNode: { kind: 'positionLocal' } }),
    addPair([{}, {}]),
    morphPair,
    hiddenPair
  ];
  for (const mesh of pairs.at(-1)) mesh.visible = false;
  const partialDrawRange = [makeMesh({}), makeMesh({})];
  for (const mesh of partialDrawRange) mesh.geometry.drawRange = { start: 0, count: 2 };
  root.add(...partialDrawRange);
  pairs.push(partialDrawRange);

  const allSources = pairs.flat();
  const stats = mergeRigidMeshes(root);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { groupsMerged: 0, meshesMerged: 0, meshesRemoved: 0, drawCallsReduced: 0 });
  assert.equal(root.children.length, allSources.length);
  assert.equal(allSources.every((mesh) => mesh.parent === root && root.children.includes(mesh)), true);
});

test('retains source meshes when geometry merging returns null or throws', () => {
  for (const behavior of ['null', 'throw']) {
    mergeBehavior = behavior;
    const root = new Group();
    const material = {};
    const sources = [makeMesh(material), makeMesh(material)];
    root.add(...sources);

    const stats = mergeRigidMeshes(root);
    assert.deepEqual(JSON.parse(JSON.stringify(stats)), { groupsMerged: 0, meshesMerged: 0, meshesRemoved: 0, drawCallsReduced: 0 });
    assert.deepEqual(root.children, sources);
    assert.ok(sources.every((mesh) => mesh.geometry.disposed === undefined));
  }
  mergeBehavior = 'merge';
});
