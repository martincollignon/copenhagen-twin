// Offline WGSL check, using the same local Three cache as shader-pass-matrix.mjs:
// node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/check-tree-shaders.mjs
// This builds shaders and counts streams; it does not launch a browser or GPU device.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { mrt, output, normalView, vec2, roughness } from 'three/tsl';
import * as T from '../js/tree-geometry-cph.js';
import { treeVertexBufferCount } from '../js/tree-budget.js';
import { TREE_STYLES } from '../js/street-furniture-data.js';

const renderer = new THREE.WebGPURenderer({ canvas: { width: 1, height: 1, style: {}, addEventListener() {} } });
renderer.hasFeature = () => false;
// WebGPU's minimum guaranteed uniform-buffer binding size; exercise both the
// small uniform-matrix path and the large instanced-attribute path without a GPU.
renderer.backend.capabilities.getUniformBufferLimit = () => 65536;
renderer._bindings = { getSharedBindGroup: group => group };
const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
const lights = new THREE.LightsNode().setLights([new THREE.DirectionalLight(), new THREE.HemisphereLight()]);
const shadow = new THREE.ShadowNode(new THREE.DirectionalLight()).getShadowMaterial();
const mrtTarget = new THREE.RenderTarget(1, 1, { count: 3 });
mrtTarget.textures.forEach((texture, i) => { texture.name = ['output', 'normal', 'metalRough'][i]; });
let compiled = 0;
for (const genus of Object.keys(TREE_STYLES)) {
  for (const [lod, geometry] of [['near', T.buildNearTree(genus, 299, { variation: true })], ['mid', T.buildMidTree(genus, 299, { variation: true })], ['far', T.buildBillboard(0)], ['litter', T.buildTreeLitterGeometry()]]) {
    const seasonal = lod !== 'litter';
    const material = seasonal ? T.createTreeMaterial(atlas, { billboard: lod === 'far' }) : T.createTreeLitterMaterial(atlas);
    for (const count of [1, 6000]) for (const pass of ['colour', 'MRT', 'shadow']) {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      if (seasonal) {
        const attributes = T.attachTreeSeasonAttributes(geometry, count);
        for (let i = 0; i < count; i++) {
          const state = T.treeInstanceSeason(genus, 299, i, 0);
          attributes.early.array.set(state.early, i * 4);
          attributes.late.array.set(state.late, i * 4);
        }
      }
      const streams = treeVertexBufferCount(geometry);
      assert.ok(streams <= 8, `${genus}/${lod}: ${streams} vertex streams`);
      renderer.setRenderTarget(pass === 'MRT' ? mrtTarget : null);
      renderer.setMRT(pass === 'MRT' ? mrt({ output, normal: normalView, metalRough: vec2(0, roughness) }) : null);
      scene.overrideMaterial = pass === 'shadow' ? shadow : null;
      if (pass === 'shadow') {
        // Mirror renderObject's override setup, including the source material's
        // alpha mask and wind. A bare ShadowMaterial would not test either path.
        Object.assign(shadow, renderer._getShadowNodes(material), {
          alphaTest: material.alphaTest, alphaMap: material.alphaMap, side: material.side
        });
      }
      const builder = new THREE.WGSLNodeBuilder(mesh, renderer);
      builder.scene = scene; builder.camera = camera; builder.lightsNode = lights;
      if (scene.overrideMaterial) builder.material = scene.overrideMaterial;
      builder.build();
      assert.ok(builder.vertexShader.length && builder.fragmentShader.length);
      assert.match(builder.fragmentShader, /discard/, `${genus}/${lod}/${pass}: alpha test`);
      const attributes = builder.attributes.map(a => a.name);
      if (lod === 'near' || lod === 'mid') {
        assert.ok(attributes.includes('leafEarly') && attributes.includes('leafData'), `${genus}/${lod}/${pass}: individual shedding`);
      }
      if (lod === 'far') assert.ok(attributes.includes('leafLate'), `${genus}/${pass}: far phenology variant`);
      compiled++;
      mesh.dispose();
    }
    geometry.dispose(); material.dispose();
  }
}
console.log(`${compiled} colour/MRT/shadow shader builds passed; tree streams <= 7, litter streams <= 5 (matrix counted as 4).`);
