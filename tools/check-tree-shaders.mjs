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
renderer._bindings = { getSharedBindGroup: group => group };
const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
const lights = new THREE.LightsNode().setLights([new THREE.DirectionalLight(), new THREE.HemisphereLight()]);
const shadow = new THREE.ShadowNode(new THREE.DirectionalLight()).getShadowMaterial();
const mrtTarget = new THREE.RenderTarget(1, 1, { count: 3 });
mrtTarget.textures.forEach((texture, i) => { texture.name = ['output', 'normal', 'metalRough'][i]; });
let compiled = 0;
for (const genus of Object.keys(TREE_STYLES)) {
  for (const [lod, geometry] of [['near', T.buildNearTree(genus)], ['mid', T.buildMidTree(genus)], ['far', T.buildBillboard(0)], ['litter', T.buildTreeLitterGeometry()]]) {
    const colored = lod !== 'litter';
    const material = colored ? T.createTreeMaterial(atlas, { billboard: lod === 'far' }) : T.createTreeLitterMaterial(atlas);
    const streams = treeVertexBufferCount(geometry, { colored });
    assert.ok(streams <= 8, `${genus}/${lod}: ${streams} vertex streams`);
    for (const count of [1, 6000]) for (const pass of ['colour', 'MRT', 'shadow']) {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      if (colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      renderer.setRenderTarget(pass === 'MRT' ? mrtTarget : null);
      renderer.setMRT(pass === 'MRT' ? mrt({ output, normal: normalView, metalRough: vec2(0, roughness) }) : null);
      scene.overrideMaterial = pass === 'shadow' ? shadow : null;
      const builder = new THREE.WGSLNodeBuilder(mesh, renderer);
      builder.scene = scene; builder.camera = camera; builder.lightsNode = lights;
      if (scene.overrideMaterial) builder.material = scene.overrideMaterial;
      builder.build();
      assert.ok(builder.vertexShader.length && builder.fragmentShader.length);
      compiled++;
      mesh.dispose();
    }
    geometry.dispose(); material.dispose();
  }
}
console.log(`${compiled} colour/MRT/shadow shader builds passed; tree streams <= 6, litter streams <= 5 (matrix counted as 4).`);
