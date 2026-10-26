const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');
const { THREE, geometryUtils } = require('./vehicle-geometry.cjs');

// Evaluate the production material expressions at a vertex/fragment without a GPU.
// positionLocal is supplied AFTER the instance matrix, as in Three's NodeMaterial.setupPosition.
class Node {
  constructor(fn) { this.fn = fn; }
  eval(env, cache = new Map()) {
    if (!cache.has(this)) cache.set(this, this.fn(env, cache));
    return cache.get(this);
  }
  add(b) { return op((a, b) => a + b, this, b); }
  sub(b) { return op((a, b) => a - b, this, b); }
  mul(b) { return op((a, b) => a * b, this, b); }
  div(b) { return op((a, b) => a / b, this, b); }
  pow(b) { return op(Math.pow, this, b); }
  negate() { return this.mul(-1); }
  lessThan(b) { return op((a, b) => a < b, this, b); }
  toVar() { return this; }
}
const node = (v) => v instanceof Node ? v : new Node(() => Array.isArray(v) ? v : [v]);
const op = (fn, ...args) => new Node((env, cache) => {
  const values = args.map((v) => node(v).eval(env, cache));
  return Array.from({ length: Math.max(...values.map((v) => v.length)) }, (_, i) => fn(...values.map((v) => v[i % v.length])));
});
for (const key of ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a', 'xy', 'xyz', 'rgb']) {
  Object.defineProperty(Node.prototype, key, { get() {
    return new Node((env, cache) => [...key].map((k) => this.eval(env, cache)['xyzw'.includes(k) ? 'xyzw'.indexOf(k) : 'rgba'.indexOf(k)]));
  } });
}
const vector = (n) => (...args) => new Node((env, cache) => {
  const v = args.flatMap((v) => node(v).eval(env, cache));
  return v.length === 1 ? Array(n).fill(v[0]) : v;
});
const tsl = {
  Fn: (fn) => (...args) => fn(args), float: node, vec2: vector(2), vec3: vector(3),
  attribute: (name) => new Node((env) => [].concat(env[name])),
  positionLocal: new Node((env) => env.positionLocal),
  color: (hex) => node([16, 8, 0].map((s) => ((hex >>> s) & 255) / 255)),
  uniform: (v) => node(typeof v === 'object' ? [v.x, v.y, v.z, v.w] : v),
  abs: (v) => op(Math.abs, v), sin: (v) => op(Math.sin, v), floor: (v) => op(Math.floor, v),
  fract: (v) => op((x) => x - Math.floor(x), v), min: (a, b) => op(Math.min, a, b), max: (a, b) => op(Math.max, a, b),
  clamp: (v, lo, hi) => op((x, l, h) => Math.max(l, Math.min(h, x)), v, lo, hi),
  mix: (a, b, t) => op((a, b, t) => a * (1 - t) + b * t, a, b, t),
  step: (edge, v) => op((e, x) => x < e ? 0 : 1, edge, v),
  smoothstep: (lo, hi, v) => op((l, h, x) => { const t = Math.max(0, Math.min(1, (x - l) / (h - l))); return t * t * (3 - 2 * t); }, lo, hi, v),
  length: (v) => new Node((env, cache) => [Math.hypot(...node(v).eval(env, cache))]),
  fwidth: () => node(0.001), time: node(0), instanceIndex: node(0),
  texture: (tex, uv) => new Node((env, cache) => env.sampleTexture ? env.sampleTexture(tex, uv.eval(env, cache)) : [1, 1, 1, 1])
};

function loadVehicleMaterials() {
  const read = (name) => readFileSync(join(__dirname, '../../js', name), 'utf8');
  const fleet = loadModule(read('vehicle-fleet.js'));
  const document = { createElement() {
    const canvas = {};
    canvas.getContext = () => ({ fillRect() {}, strokeRect() {}, fillText() {} });
    return canvas;
  } };
  return loadModule(read('actor-models.js'), { imports: {
    'three/webgpu': { ...THREE, MeshStandardNodeMaterial: class { constructor() { this.userData = {}; } },
      Vector4: class { constructor(x, y, z, w) { Object.assign(this, { x, y, z, w }); } },
      CanvasTexture: class { constructor(image) { this.image = image; } } },
    'three/tsl': tsl, './tsl-materials.js': { cityUniforms: { uInteriorGlow: node(0) } },
    './vehicle-fleet.js': fleet, 'three/addons/utils/BufferGeometryUtils.js': geometryUtils()
  }, globals: { document } });
}

module.exports = { loadVehicleMaterials };
