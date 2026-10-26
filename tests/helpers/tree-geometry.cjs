// Small geometry-only adapter for the repository's dependency-free Node suite.
// Production tree generation runs unchanged; no canvas, renderer or WebGPU device.
const { loadModule } = require('./module.cjs');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  multiplyScalar(k) { this.x *= k; this.y *= k; this.z *= k; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  normalize() { return this.multiplyScalar(1 / (Math.hypot(this.x, this.y, this.z) || 1)); }
  crossVectors(a, b) {
    this.x = a.y * b.z - a.z * b.y; this.y = a.z * b.x - a.x * b.z; this.z = a.x * b.y - a.y * b.x;
    return this;
  }
}
class Attribute {
  constructor(array, itemSize) { Object.assign(this, { array, itemSize, count: array.length / itemSize }); }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setXYZ(i, x, y, z) { this.array.splice(i * this.itemSize, 3, x, y, z); }
}
class InterleavedBufferAttribute {
  constructor(data, itemSize, offset) { Object.assign(this, { data, itemSize, offset, count: data.array.length / data.stride, isInterleavedBufferAttribute: true }); }
  getX(i) { return this.data.array[i * this.data.stride + this.offset]; }
  getY(i) { return this.data.array[i * this.data.stride + this.offset + 1]; }
  getZ(i) { return this.data.array[i * this.data.stride + this.offset + 2]; }
}
const THREE = {
  Vector3, InterleavedBufferAttribute,
  InterleavedBuffer: class { constructor(array, stride) { Object.assign(this, { array, stride }); } },
  BufferAttribute: Attribute, InstancedBufferAttribute: Attribute, Float32BufferAttribute: Attribute, Uint32BufferAttribute: Attribute,
  IcosahedronGeometry: class {
    constructor() {
      this.attributes = { position: new Attribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3),
        normal: new Attribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3), uv: new Attribute([0, 0, 1, 0, 0, 1], 2) };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    computeVertexNormals() {}
  },
  Color: class {
    setRGB(r, g, b) {
      const linear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      Object.assign(this, { r: linear(r), g: linear(g), b: linear(b) }); return this;
    }
  },
  BufferGeometry: class {
    constructor() { this.attributes = {}; this.userData = {}; }
    setAttribute(name, value) { this.attributes[name] = value; }
    setIndex(index) { this.index = index; }
    computeBoundingSphere() {}
    dispose() {}
  },
  DataTexture: class { constructor(data, width, height) { this.image = { data, width, height }; } }
};

function loadTreeGeometry(data, season, document) {
  const source = readFileSync(join(__dirname, '../../js/tree-geometry-cph.js'), 'utf8');
  return loadModule(source, { filename: 'tree-geometry-cph.js', globals: { document }, imports: {
    'three/webgpu': THREE,
    'three/tsl': { uniform: value => ({ value }) },
    './street-furniture-data.js': data,
    './tree-season.js': season,
    './tsl-materials.js': {},
    './surface-materials-cph.js': {}
  } });
}
function loadTreeShadow(data) {
  const source = readFileSync(join(__dirname, '../../js/street-furniture-geometry.js'), 'utf8');
  const G = loadModule(source, { filename: 'street-furniture-geometry.js', imports: {
    'three/webgpu': THREE, 'three/addons/utils/BufferGeometryUtils.js': {}, './street-furniture-data.js': data
  } });
  return G.buildMidCrown();
}
module.exports = { loadTreeGeometry, loadTreeShadow };
