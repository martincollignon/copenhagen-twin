// Generate WGSL without a browser/GPU. Usage: node tools/check-facade-shaders.mjs /path/to/three-build
// The directory must contain the same three.webgpu.js, three.core.js and three.tsl.js used by the app.
// This validates node-graph generation, not GPU execution or rendered appearance.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv[2]) {
  // Resolve symlinks so Three's relative imports and the bare imports share one TSL module / node stack.
  const base = pathToFileURL(`${realpathSync(resolve(process.argv[2]))}/`).href;
  const loader = `export async function resolve(specifier, context, next) {
    const files = {'three':'three.webgpu.js','three/webgpu':'three.webgpu.js','three/tsl':'three.tsl.js'};
    return files[specifier] ? {url: new URL(files[specifier], ${JSON.stringify(base)}).href, shortCircuit: true} : next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
}
const THREE = await import('three/webgpu');
const { attribute } = await import('three/tsl');
const { createPreWarBuildingMaterial, createCurtainWallMaterial } = await import('../js/tsl-materials.js');
const { createPhotoMaterial } = await import('../js/facade-photo-material.js');
const renderer = new THREE.WebGPURenderer({
  canvas: { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} }
});
// No device is created: report optional float filtering unsupported, matching baseline WebGPU capabilities.
renderer.hasFeature = () => false;
renderer._bindings = { getSharedBindGroup: (group) => group };
const geometry = new THREE.BoxGeometry();
const attributes = {
  facadeUV: 2, facadeWall: 4, facadeBldg: 4, facadeTone: 4, facadeTop: 1, facadeWindow: 4,
  roofMat: 2, color: 3, box: 4, faces: 4, wallUV: 2
};
for (const [name, n] of Object.entries(attributes)) {
  geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * n).fill(1), n));
}
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
const roof = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
roof.roughnessNode = attribute('roofMat', 'vec2').x;
roof.metalnessNode = attribute('roofMat', 'vec2').y;
const configurations = {
  masonry: createPreWarBuildingMaterial({ wallAttr: true, windowRatioY: 0.64 }),
  box: createPreWarBuildingMaterial({ boxLocal: true }),
  world: createPreWarBuildingMaterial(),
  curtain: createCurtainWallMaterial({ wallAttr: true }),
  photo: createPhotoMaterial(new THREE.Texture()),
  jpeg: createPhotoMaterial(new THREE.Texture(), { hasMask: false }),
  roof
};
console.log(`Three.js ${THREE.REVISION}: WGSL generation (no GPU execution)`);
for (const [name, material] of Object.entries(configurations)) {
  const mesh = new THREE.Mesh(geometry, material);
  const builder = renderer.backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.camera = camera;
  builder.build();
  assert.ok(builder.vertexShader.length && builder.fragmentShader.length, `${name}: generated shaders`);
  assert.doesNotMatch(builder.vertexShader + builder.fragmentShader, /NaN|undefined/, `${name}: valid generated values`);
  if (name === 'masonry') assert.ok(builder.attributes.length <= 8, 'Copenhagen walls fit the WebGPU baseline vertex-buffer limit');
  console.log(name, builder.vertexShader.length, builder.fragmentShader.length, 'attributes', builder.attributes.length);
}
