const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

let bindings = [];

function node(op, args = []) {
  const target = { __expr: true, op, args };
  return new Proxy(target, {
    get(expression, key) {
      if (key === 'then' || key === 'toJSON') return undefined;
      if (Object.hasOwn(expression, key)) return expression[key];
      if (['r', 'g', 'b', 'a', 'rgb', 'x', 'y', 'z'].includes(key)) return node(`swizzle:${key}`, [expression]);
      return (...values) => node(String(key), [expression, ...values]);
    }
  });
}

const operation = (name) => (...args) => node(name, args);

class Vector3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
}

class MeshStandardNodeMaterial {
  constructor(options) { Object.assign(this, options); }
}

function uniform(value) {
  const index = bindings.length;
  bindings.push(value);
  return node('uniform', [index]);
}

function symbolicValue(value) {
  if (value?.__expr) return [value.op, value.args.map(symbolicValue)];
  if (value instanceof Vector3) return [value.x, value.y, value.z];
  if (Array.isArray(value)) return value.map(symbolicValue);
  return value;
}

const cityUniforms = {
  uSkySunDir: node('cityUniform', ['uSkySunDir']),
  uInteriorGlow: node('cityUniform', ['uInteriorGlow'])
};

const tsl = {
  Fn: (fn) => () => fn(),
  float: (value) => node('float', [value]),
  vec2: operation('vec2'),
  vec3: operation('vec3'),
  texture: operation('texture'),
  uv: () => node('uv'),
  attribute: (name, type) => node('attribute', [name, type]),
  positionWorld: node('positionWorld'),
  cameraPosition: node('cameraPosition'),
  length: operation('length'),
  dot: operation('dot'),
  mix: operation('mix'),
  step: operation('step'),
  smoothstep: operation('smoothstep'),
  max: operation('max'),
  exp: operation('exp'),
  floor: operation('floor'),
  mod: operation('mod'),
  dFdx: operation('dFdx'),
  dFdy: operation('dFdy'),
  normalize: operation('normalize'),
  normalWorldGeometry: node('normalWorldGeometry'),
  clamp: operation('clamp'),
  sin: operation('sin'),
  fract: operation('fract'),
  uniform
};

const { createPhotoMaterial } = loadModule(readFileSync(join(__dirname, '../js/facade-photo-material.js'), 'utf8'), {
  imports: {
    'three/webgpu': { MeshStandardNodeMaterial, Vector3 },
    'three/tsl': tsl,
    './tsl-materials.js': {
      cityUniforms,
      apartmentOccupancy: () => node('apartmentOccupancy'),
      apartmentLight: operation('apartmentLight'),
      bumpNormal: operation('bumpNormal'),
      canyonSkyAONode: () => node('canyonSkyAONode'),
      gridLine: operation('gridLine'),
      noise2D: operation('noise2D'),
      BRICK_L: 0.24,
      BRICK_H: 0.075
    },
    './facade-lod.js': { PHOTO: { close0: 0.18, close1: 0.42, near: 18, far: 110 } }
  },
  filename: 'facade-photo-material.js'
});

function build(options) {
  bindings = [];
  const material = createPhotoMaterial('facade-atlas', options);
  const graph = {
    color: symbolicValue(material.colorNode),
    roughness: symbolicValue(material.roughnessNode),
    normal: symbolicValue(material.normalNode),
    emissive: symbolicValue(material.emissiveNode),
    opacity: symbolicValue(material.opacityNode)
  };
  return { graph, graphText: JSON.stringify(graph), uniforms: bindings.map(symbolicValue) };
}

test('tone, brick, and layout values bind as uniforms without changing the same-mask shader graph', () => {
  const baseOptions = { hasMask: true, tone: [0.4, 0.38, 0.34], brick: true, layout: { floorH: 3, groundH: 3, seed: 0 } };
  const baseline = build(baseOptions);
  const variants = [
    { ...baseOptions, tone: [0, 0, 0] },
    { ...baseOptions, brick: false },
    { ...baseOptions, layout: { ...baseOptions.layout, floorH: 2.8 } },
    { ...baseOptions, layout: { ...baseOptions.layout, groundH: 3.6 } },
    { ...baseOptions, layout: { ...baseOptions.layout, seed: 19 } }
  ].map(build);

  for (const variant of variants) assert.equal(variant.graphText, baseline.graphText);
  assert.equal(baseline.uniforms.length, 3);
  assert.ok(Math.abs(baseline.uniforms[0] - (0.2126 * 0.4 + 0.7152 * 0.38 + 0.0722 * 0.34)) < 1e-12);
  assert.equal(baseline.uniforms[1], 1);
  assert.deepEqual(baseline.uniforms[2], [3, 3, 0]);
  assert.equal(variants[0].uniforms[0], 0.02, 'near-black tone luminance keeps its shader clamp');
  assert.equal(variants[1].uniforms[1], 0);
  assert.deepEqual(variants[2].uniforms[2], [2.8, 3, 0]);
  assert.deepEqual(variants[3].uniforms[2], [3, 3.6, 0]);
  assert.deepEqual(variants[4].uniforms[2], [3, 3, 19]);
});

test('hasMask still selects a different shader graph', () => {
  const masked = build({ hasMask: true });
  const unmasked = build({ hasMask: false });
  assert.notEqual(unmasked.graphText, masked.graphText);
});
