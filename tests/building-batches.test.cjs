const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

class Matrix4 {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  copy(matrix) { this.x = matrix.x; this.y = matrix.y; this.z = matrix.z; return this; }
  invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  multiplyMatrices(left, right) {
    this.x = left.x + right.x;
    this.y = left.y + right.y;
    this.z = left.z + right.z;
    return this;
  }
}

class BatchedMesh {
  constructor(maxInstanceCount, maxVertexCount, maxIndexCount, material) {
    this.maxInstanceCount = maxInstanceCount;
    this.maxVertexCount = maxVertexCount;
    this.maxIndexCount = maxIndexCount;
    this.material = material;
    this.userData = {};
    this.children = [];
    this.geometryRanges = [];
    this.instances = [];
    this.visibleCalls = [];
    this.attributes = {};
    this.index = [];
    this.isMesh = true;
    this.perObjectFrustumCulled = true;
    this.sortObjects = true;
  }
  addGeometry(geometry) {
    const vertexStart = this.geometryRanges.reduce((sum, range) => sum + range.vertexCount, 0);
    const indexStart = this.geometryRanges.reduce((sum, range) => sum + range.indexCount, 0);
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (!this.attributes[name]) this.attributes[name] = [];
      this.attributes[name].push(...attribute.array);
    }
    const sourceIndex = geometry.index?.array || [];
    this.index.push(...sourceIndex.map((index) => index + vertexStart));
    const range = {
      vertexStart,
      vertexCount: geometry.getAttribute('position').count,
      indexStart,
      indexCount: sourceIndex.length,
      start: indexStart,
      count: sourceIndex.length
    };
    this.geometryRanges.push(range);
    return this.geometryRanges.length - 1;
  }
  getGeometryRangeAt(id) { return this.geometryRanges[id]; }
  addInstance(geometryId) { this.instances.push({ geometryId, visible: true, matrix: null }); return this.instances.length - 1; }
  setMatrixAt(id, matrix) { this.instances[id].matrix = { x: matrix.x, y: matrix.y, z: matrix.z }; }
  setVisibleAt(id, visible) { this.visibleCalls.push([id, visible]); this.instances[id].visible = visible; }
  computeBoundingBox() { this.boundingBoxComputed = true; }
  computeBoundingSphere() { this.boundingSphereComputed = true; }
}

class Group {
  constructor(name = '') {
    this.name = name;
    this.children = [];
    this.userData = {};
    this.visible = true;
    this.matrixWorld = { x: 0, y: 0, z: 0 };
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }
  updateMatrixWorld() { this.matrixWorldUpdates = (this.matrixWorldUpdates || 0) + 1; }
}

function geometry(seed) {
  const attributes = {
    position: { count: 4, array: [seed, 0, 0, seed + 1, 0, 0, seed + 1, 1, 0, seed, 1, 0] },
    normal: { count: 4, array: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] },
    detail: { count: 4, array: [seed, seed + 1, seed + 2, seed + 3] }
  };
  return {
    attributes,
    index: { count: 6, array: [0, 1, 2, 0, 2, 3] },
    getAttribute(name) { return this.attributes[name]; },
    dispose() { this.disposed = true; }
  };
}

function mesh(name, material, x, seed, ranges = [], detailRanges = []) {
  const sourceGeometry = geometry(seed);
  return {
    isMesh: true,
    name,
    material,
    geometry: sourceGeometry,
    sourceGeometry,
    userData: { ranges, detailRanges },
    castShadow: true,
    receiveShadow: true,
    matrixWorld: { x, y: 2, z: -3 },
    parent: null
  };
}

const imports = { 'three/webgpu': { Matrix4, BatchedMesh } };
const modulePath = path.join(__dirname, '../js/building-batches.js');
const { batchBuildingCells, updateBuildingCellVisibility } = loadModule(fs.readFileSync(modulePath, 'utf8'), {
  imports,
  filename: 'building-batches.js'
});

test('batches only named building cells and preserves copied geometry, transforms, flags, and picking ranges', () => {
  const wallMaterial = { name: 'walls' };
  const otherWallMaterial = { name: 'walls' };
  const roofMaterial = { name: 'roof' };
  const doorMaterial = { name: 'doors' };
  const glassMaterial = { name: 'glass' };
  const root = new Group('root');
  root.matrixWorld = { x: 100, y: 2, z: -3 };

  const cellA = new Group('buildings-cell');
  const cellB = new Group('buildings-cell');
  const wallA = mesh('walls', wallMaterial, 110, 1, [{ id: 'wall-a', start: 0, end: 6 }]);
  const wallB = mesh('walls', wallMaterial, 120, 2, [{ id: 'wall-b', start: 0, end: 6 }]);
  const otherMaterialWall = mesh('walls', otherWallMaterial, 130, 8);
  cellB.add(otherMaterialWall);
  const roofA = mesh('roofs', roofMaterial, 110, 3, [{ id: 'roof-a', start: 0, end: 6 }], [{ id: 'detail-a', start: 0, end: 3 }]);
  const roofB = mesh('roofs', roofMaterial, 120, 4, [{ id: 'roof-b', start: 0, end: 6 }], [{ id: 'detail-b', start: 0, end: 3 }]);
  roofA.castShadow = roofB.castShadow = false;
  const doorA = mesh('entrance-doors', doorMaterial, 110, 5);
  const doorB = mesh('entrance-doors', doorMaterial, 120, 6);
  const photo = mesh('photo-walls', wallMaterial, 110, 7);
  for (const child of [wallA, roofA, doorA, photo]) cellA.add(child);
  for (const child of [wallB, roofB, doorB]) cellB.add(child);
  root.add(cellA);
  root.add(cellB);

  const heroGroup = new Group('Hero-fallback');
  const heroRoof = mesh('roofs', roofMaterial, 130, 8);
  heroGroup.add(heroRoof);
  root.add(heroGroup);

  const glassWall = mesh('glass-walls', glassMaterial, 100, 9);
  cellA.add(glassWall);
  const pickables = [wallA, roofA, wallB, roofB, glassWall];
  const batches = batchBuildingCells(root, [cellA, cellB, heroGroup], pickables);

  assert.equal(root.matrixWorldUpdates, 1);
  assert.equal(batches.length, 4);
  const walls = batches.find((batch) => batch.name === 'walls' && batch.material === wallMaterial);
  const otherMaterialWalls = batches.find((batch) => batch.name === 'walls' && batch.material === otherWallMaterial);
  const roofs = batches.find((batch) => batch.name === 'roofs');
  const doors = batches.find((batch) => batch.name === 'entrance-doors');
  assert.ok(walls && roofs && doors);
  assert.ok(otherMaterialWalls, 'same mesh names with different material identities stay in separate batches');
  assert.equal(otherMaterialWalls.maxInstanceCount, 1);
  assert.equal(otherMaterialWalls.material, otherWallMaterial);
  assert.equal(otherMaterialWalls.userData.ranges.length, 0);
  assert.equal(pickables.includes(otherMaterialWalls), false, 'a batch with no originally pickable sources is not pickable');

  for (const [batch, material, sources] of [
    [walls, wallMaterial, [wallA, wallB]],
    [roofs, roofMaterial, [roofA, roofB]],
    [doors, doorMaterial, [doorA, doorB]]
  ]) {
    assert.equal(batch.material, material);
    assert.equal(batch.maxInstanceCount, 2);
    assert.equal(batch.maxVertexCount, 8);
    assert.equal(batch.maxIndexCount, 12);
    assert.equal(batch.castShadow, batch === roofs ? false : true);
    assert.equal(batch.receiveShadow, true);
    assert.equal(batch.sortObjects, false);
    assert.equal(batch.perObjectFrustumCulled, true);
    assert.equal(batch.boundingBoxComputed, true);
    assert.equal(batch.boundingSphereComputed, true);
    assert.equal(batch.instances.length, 2);
    assert.equal(batch.instances[0].matrix.x, 10);
    assert.equal(batch.instances[1].matrix.x, 20);
    for (const source of sources) {
      assert.equal(source.parent, null);
      assert.equal(source.geometry, null);
      assert.equal(source.sourceGeometry.disposed, true);
    }
    for (const name of Object.keys(sources[0].sourceGeometry.attributes)) {
      assert.deepEqual(batch.attributes[name], sources.flatMap((source) => source.sourceGeometry.attributes[name].array));
      assert.notEqual(batch.attributes[name], sources[0].sourceGeometry.attributes[name].array);
    }
    assert.deepEqual(batch.index, [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  }

  assert.equal(JSON.stringify(roofs.userData.ranges), JSON.stringify([
    { id: 'roof-a', start: 0, end: 6 },
    { id: 'roof-b', start: 6, end: 12 }
  ]));
  assert.equal(JSON.stringify(roofs.userData.detailRanges), JSON.stringify([
    { id: 'detail-a', start: 0, end: 3 },
    { id: 'detail-b', start: 6, end: 9 }
  ]));
  assert.equal(walls.userData.ranges[1].start, 6);
  assert.equal(doors.userData.ranges.length, 0);

  assert.equal(cellA.children.includes(photo), true);
  assert.equal(cellA.children.includes(glassWall), true);
  assert.equal(heroRoof.parent, heroGroup);
  assert.equal(pickables.includes(walls), true);
  assert.equal(pickables.includes(roofs), true);
  assert.equal(pickables.includes(glassWall), true);
  assert.equal(pickables.includes(doors), false);
  assert.equal(pickables.includes(wallA), false);
  assert.equal(pickables.includes(roofA), false);
  assert.equal(root.children.includes(walls), true);
  assert.equal(root.children.includes(roofs), true);
  assert.equal(root.children.includes(doors), true);
});

test('cell streaming visibility is mirrored to its batched instances only when it changes', () => {
  const material = { name: 'roof' };
  const root = new Group('root');
  const cell = new Group('buildings-cell');
  const roof = mesh('roofs', material, 0, 1, [{ id: 'roof', start: 0, end: 6 }]);
  cell.add(roof);
  root.add(cell);
  const pickables = [roof];
  const [batch] = batchBuildingCells(root, [cell], pickables);

  assert.equal(cell.visible, true);
  assert.equal(batch.instances[0].visible, true);
  updateBuildingCellVisibility(cell, false);
  assert.equal(cell.visible, false);
  assert.equal(batch.instances[0].visible, false);
  assert.deepEqual(batch.visibleCalls, [[0, false]]);

  updateBuildingCellVisibility(cell, false);
  assert.deepEqual(batch.visibleCalls, [[0, false]]);
  updateBuildingCellVisibility(cell, true);
  assert.equal(cell.visible, true);
  assert.equal(batch.instances[0].visible, true);
  assert.deepEqual(batch.visibleCalls, [[0, false], [0, true]]);
});

test('a batch instance starts hidden when its cell is already hidden', () => {
  const root = new Group('root');
  const cell = new Group('buildings-cell');
  cell.visible = false;
  const roof = mesh('roofs', { name: 'roof' }, 0, 1, [{ id: 'roof', start: 0, end: 6 }]);
  cell.add(roof);
  root.add(cell);
  const [batch] = batchBuildingCells(root, [cell], [roof]);

  assert.equal(cell.visible, false);
  assert.equal(batch.instances[0].visible, false);
  assert.deepEqual(batch.visibleCalls, [[0, false]]);
  updateBuildingCellVisibility(cell, false);
  assert.deepEqual(batch.visibleCalls, [[0, false]], 'same-visibility update needs no extra instance write');
});
