// Compile the scene materials against the fragment-output configurations used by the app.
// With Three cached at /private/tmp/dlb-three, run:
//   node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/shader-pass-matrix.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { mrt, output, normalView, roughness, vec2, vec3, vec4, float, positionView, smoothstep, ShadowNode } from 'three/tsl';
import { createRoadSurfaceMaterials, ssrReflectionWeight } from '../js/surface-materials-cph.js';
import { cityUniforms, createContactShadowMaterial, createCarFlareMaterial } from '../js/tsl-materials.js';
import { createLakeWallMaterial, createWaterMaterial } from '../js/water-cph.js';
import { applyGroundField } from '../js/ground-shader-cph.js';
import { createPhotoMaterial } from '../js/facade-photo-material.js';

const renderer = new THREE.WebGPURenderer({ canvas: { width: 1440, height: 900, style: {}, addEventListener() {} } });
renderer.hasFeature = () => false;
renderer._bindings = { getSharedBindGroup: (group) => group };

const geometry = new THREE.PlaneGeometry(10, 10);
for (const [name, size] of [['kuv', 2], ['seed', 1], ['wallUV', 2], ['wallKind', 1], ['flarePos', 4], ['flareCol', 4]]) {
  geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * size), size));
}

const roadMaterials = createRoadSurfaceMaterials();
const sdf = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
const groundFieldMaterial = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
applyGroundField(groundFieldMaterial, {
  lakes: [{ ring: [-10, -10, -10, 10, 10, 10, 10, -10] }]
}, [{ ring: [-18, -18, -18, 18, 18, 18, 18, -18] }], { bbox: [-20, -20, 20, 20] });
const materials = { ...roadMaterials, ...roadMaterials.ground };
delete materials.ground;
materials.groundField = groundFieldMaterial;
materials.wall = createLakeWallMaterial();
materials.water = createWaterMaterial({ sdf, bbox: [-750, -750, 750, 750], planar: null }).material;
materials.waterPlanar = createWaterMaterial({ sdf, bbox: [-750, -750, 750, 750], planar: { resolutionScale: 0.4 } }).material;

const photoAtlas = new THREE.Texture();
photoAtlas.colorSpace = THREE.SRGBColorSpace;
materials.photoMasked = createPhotoMaterial(photoAtlas);
materials.photoRaw = createPhotoMaterial(photoAtlas, { hasMask: false });
const photoVariants = [
  { tone: [0.19, 0.25, 0.3], brick: false, layout: { floorH: 3.3, groundH: 4.1, seed: 42 } },
  { tone: [0.6, 0.55, 0.4], brick: true, layout: { floorH: 2.7, groundH: 2.9, seed: 73 } }
];

const writeMaskMaterial = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
writeMaskMaterial.name = 'colorWrite:false/depthWrite:false';
writeMaskMaterial.colorWrite = false;
writeMaskMaterial.depthWrite = false;
const outputNodeMaterial = new THREE.MeshBasicNodeMaterial();
outputNodeMaterial.name = 'outputNode';
outputNodeMaterial.outputNode = vec4(0.32, 0.48, 0.64, 1);
const mrtEffects = {
  contactShadow: createContactShadowMaterial(),
  carFlare: createCarFlareMaterial()
};
const passMaterials = { ...materials, ...mrtEffects, writeMask: writeMaskMaterial, outputNode: outputNodeMaterial };
const reflectionHidesMaterial = (material) => Boolean(material?.mrtNode);
const reflectionMaterials = Object.fromEntries(Object.entries(passMaterials).filter(([, material]) => !reflectionHidesMaterial(material)));
const hiddenInReflection = Object.keys(passMaterials).filter((name) => reflectionHidesMaterial(passMaterials[name]));
assert.deepEqual(hiddenInReflection, ['contactShadow', 'carFlare'], 'reflection filter should hide only MRT-only contact/flaring effects');

const ssrFade = smoothstep(360, 180, positionView.z.negate());
const sceneMRT = mrt({
  output,
  normal: normalView,
  metalRough: vec2(roughness.lessThan(0.75).select(ssrReflectionWeight().mul(ssrFade), 0), roughness)
});
const normalDepthMRT = mrt({
  normal: normalView,
  depth: vec4(positionView.z, positionView.z, positionView.z, 1)
});

function configureTarget(mode) {
  renderer.setMRT(null);
  if (mode === 'canvas color-only check') {
    renderer.setRenderTarget(null);
    return;
  }
  if (mode === 'unnamed reflection target') {
    const target = new THREE.RenderTarget(640, 400);
    target.textures[0].name = '';
    renderer.setRenderTarget(target);
    return;
  }
  if (mode === 'main scene MRT') {
    const target = new THREE.RenderTarget(1440, 900, { count: 3 });
    target.textures.forEach((texture, index) => { texture.name = ['output', 'normal', 'metalRough'][index]; });
    renderer.setRenderTarget(target);
    renderer.setMRT(sceneMRT);
    return;
  }
  if (mode === 'partial normal/depth MRT check') {
    const target = new THREE.RenderTarget(640, 400, { count: 2 });
    target.textures.forEach((texture, index) => { texture.name = ['normal', 'depth'][index]; });
    renderer.setRenderTarget(target);
    renderer.setMRT(normalDepthMRT);
    return;
  }
  throw new Error(`Unknown shader pass: ${mode}`);
}

const lightsNode = new THREE.LightsNode().setLights([new THREE.DirectionalLight(), new THREE.HemisphereLight()]);
function compile(material, { shadowOverride = null } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const builder = new THREE.WGSLNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.camera = camera;
  builder.lightsNode = lightsNode;
  if (shadowOverride) {
    // ShadowNode's shadow render path installs this override before creating the render object.
    scene.overrideMaterial = shadowOverride;
    builder.material = scene.overrideMaterial;
  }
  builder.build();
  return builder;
}

function assertNoEmptyOutput(builder, label) {
  assert.doesNotMatch(builder.fragmentShader, /struct\s+(?:OutputType|OutputStruct)\s*\{\s*\}/, `${label} emitted an empty output structure`);
  assert.match(builder.fragmentShader, /struct\s+(?:OutputType|OutputStruct)\s*\{[\s\S]*?\}/, `${label} did not emit an output structure`);
}

function assertOutputLocations(builder, count, label) {
  const structure = builder.fragmentShader.match(/struct\s+(?:OutputType|OutputStruct)\s*\{([\s\S]*?)\}/)?.[1] || '';
  const locations = [...structure.matchAll(/@location\(\s*(\d+)\s*\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(locations, Array.from({ length: count }, (_, index) => index), `${label} emitted unexpected attachment locations`);
}

function assertWetnessAffectsColourAndRoughness(sourceMaterial, label) {
  const colourProbe = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  colourProbe.colorNode = sourceMaterial.colorNode;
  colourProbe.roughnessNode = float(0.95);
  colourProbe.emissiveNode = null;
  colourProbe.contextNode = null;
  const colourBuilder = compile(colourProbe);
  assertOutputLocations(colourBuilder, 1, `${label} isolated colour probe`);
  assert.ok(colourBuilder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
    `${label} colour no longer depends on uRoadWetness without SSR context`);

  const roughnessProbe = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  roughnessProbe.colorNode = vec3(0.4, 0.4, 0.4);
  roughnessProbe.roughnessNode = sourceMaterial.roughnessNode;
  roughnessProbe.emissiveNode = null;
  roughnessProbe.contextNode = null;
  const roughnessBuilder = compile(roughnessProbe);
  assertOutputLocations(roughnessBuilder, 1, `${label} isolated roughness probe`);
  assert.ok(roughnessBuilder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
    `${label} roughness no longer depends on uRoadWetness without SSR context`);
}

const passConfigurations = [
  { mode: 'canvas color-only check', materials: passMaterials, expectedOutputs: 1 },
  { mode: 'unnamed reflection target', materials: reflectionMaterials, expectedOutputs: 1 },
  // This is the app MRT consumed by SSR and GTAO; the named partial MRT below is only a robustness check.
  { mode: 'main scene MRT', materials: passMaterials, expectedOutputs: 3 },
  { mode: 'partial normal/depth MRT check', materials, expectedOutputs: 2 }
];

for (const { mode, materials: visibleMaterials, expectedOutputs } of passConfigurations) {
  configureTarget(mode);
  for (const [name, material] of Object.entries(visibleMaterials)) {
    const builder = compile(material);
    assertNoEmptyOutput(builder, `${mode} / ${name}`);
    assertOutputLocations(builder, expectedOutputs, `${mode} / ${name}`);
    if (name === 'photoMasked' || name === 'photoRaw') {
      for (const parameters of photoVariants) {
        const variant = compile(createPhotoMaterial(photoAtlas, { ...parameters, hasMask: name === 'photoMasked' }));
        assert.equal(variant.vertexShader, builder.vertexShader, `${mode} / ${name}: building parameters changed the vertex program`);
        assert.equal(variant.fragmentShader, builder.fragmentShader, `${mode} / ${name}: building parameters changed the fragment program`);
      }
    }
    if (mode === 'unnamed reflection target') {
      assert.match(builder.fragmentShader, /@location\(\s*0\s*\)\s+color\s*:/, `${name} has no color output for the unnamed reflection target`);
    }
    if (mode === 'main scene MRT' && name === 'asphalt') {
      assert.ok(builder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
        'wet SSR output no longer depends on uRoadWetness');
      assert.equal(material.metalness, 0, 'wet asphalt must remain dielectric');
      assert.equal(material.mrtNode, null, 'wet asphalt must not replace the renderer MRT');
      assert.ok(material.contextNode?.value?.wetSurfaceReflection, 'wet asphalt has no context SSR weight');
    }
    if (mode === 'main scene MRT' && name === 'groundField') {
      assert.ok(builder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
        'ground-field wet SSR output no longer depends on uRoadWetness');
      assert.equal(material.metalness, 0, 'ground-field wet gravel must remain dielectric');
      assert.equal(material.mrtNode, null, 'ground-field wet gravel must not replace the renderer MRT');
      assert.ok(material.contextNode?.value?.wetSurfaceReflection, 'ground-field material has no context SSR weight');
    }
  }
  if (mode === 'main scene MRT') {
    const wetProbe = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
    wetProbe.colorNode = vec3(0.4, 0.4, 0.4);
    wetProbe.roughnessNode = float(0.3);
    wetProbe.contextNode = roadMaterials.asphalt.contextNode;
    const probeBuilder = compile(wetProbe);
    assertNoEmptyOutput(probeBuilder, 'main scene MRT / isolated wet SSR probe');
    assertOutputLocations(probeBuilder, 3, 'main scene MRT / isolated wet SSR probe');
    assert.ok(probeBuilder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
      'isolated main SSR mask is not connected to wetness');

    const groundFieldProbe = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
    groundFieldProbe.colorNode = vec3(0.4, 0.4, 0.4);
    groundFieldProbe.roughnessNode = float(0.3);
    groundFieldProbe.contextNode = groundFieldMaterial.contextNode;
    const groundFieldProbeBuilder = compile(groundFieldProbe);
    assertNoEmptyOutput(groundFieldProbeBuilder, 'main scene MRT / isolated ground-field SSR probe');
    assertOutputLocations(groundFieldProbeBuilder, 3, 'main scene MRT / isolated ground-field SSR probe');
    assert.ok(groundFieldProbeBuilder.uniforms.fragment.some((nodeUniform) => nodeUniform.node === cityUniforms.uRoadWetness),
      'isolated ground-field SSR mask is not connected to wetness');
  }
  if (mode === 'partial normal/depth MRT check') {
    const builder = compile(roadMaterials.asphalt);
    assertOutputLocations(builder, 2, 'partial normal/depth MRT check');
  }
  console.log(`PASS ${mode} (${Object.keys(visibleMaterials).length} materials)`);
}

configureTarget('canvas color-only check');
assertWetnessAffectsColourAndRoughness(roadMaterials.ground.gravel, 'registered gravel');
assertWetnessAffectsColourAndRoughness(groundFieldMaterial, 'ground-field gravel');
console.log('PASS isolated wetness dependencies (registered and ground-field gravel colour and roughness)');

const directionalLight = new THREE.DirectionalLight();
const shadowNode = new ShadowNode(directionalLight);
const shadowOverride = shadowNode.getShadowMaterial();
assert.equal(shadowOverride.isShadowPassMaterial, true, 'shadow map override is not Three’s shadow-pass material');
assert.equal(shadowOverride.name, 'ShadowMaterial');
const shadowTarget = new THREE.RenderTarget(1024, 1024);
shadowTarget.texture.name = 'ShadowMap';
renderer.setRenderTarget(shadowTarget);
renderer.setMRT(null);
for (const [name, material] of Object.entries(passMaterials)) {
  const shadowBuilder = compile(material, { shadowOverride });
  assertNoEmptyOutput(shadowBuilder, `ShadowMap override / ${name}`);
  assertOutputLocations(shadowBuilder, 1, `ShadowMap override / ${name}`);
  assert.equal(shadowBuilder.material, shadowOverride, `${name} did not use the actual Three shadow override`);
}
console.log(`PASS Three ShadowNode ShadowMap override (${Object.keys(passMaterials).length} source materials)`);
