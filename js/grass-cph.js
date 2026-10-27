// js/grass-cph.js
// Grass tufts near the camera, on the measured lawns (data/cph-vegetation.json). The ground polygons already carry the lawn
// colour (surface-materials-cph.js grassColour); this adds the third dimension close up, cheaply:
//   * ONE draw call: a 5-blade tuft (15 triangles) instanced over a torus of 8 m tiles around the camera (grass-layout-cph.js),
//     at most 49 tiles x 800 tufts, and only on lawn cells, so a typical view carries a few thousand tufts;
//   * no per-frame CPU work beyond refilling the tiles that came into range (4 per frame, one buffer upload when any did);
//   * wind, scale fade and colour are all vertex/fragment shader work: blades bend with a travelling wave, tufts shrink to
//     nothing at the edge of the field (no popping), and the colour is the ground's own field with a dark root and a bright tip.

import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, attribute, positionLocal, cameraPosition, time, sin, cos, mix, smoothstep, fract, dot, normalize, normalView, transformNormalToView } from 'three/tsl';
import { grassColour } from './surface-materials-cph.js';
import { createLawnMask, createGrassField, FADE_RADIUS } from './grass-layout-cph.js';

const BLADES = 5;
const TUFT_HEIGHT = 0.2; // m at scale 1
const TUFT_RADIUS = 0.07;

/** A tuft of BLADES blades fanned out from the root: 5 vertices (two segments) per blade. aH = height 0..1 for the shading. */
export function buildTuftGeometry() {
  const position = [];
  const aH = [];
  const index = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + rnd() * 0.8;
    const r = TUFT_RADIUS * (0.2 + 0.8 * rnd());
    const face = rnd() * Math.PI; // the blade's width direction
    const h = TUFT_HEIGHT * (0.55 + 0.45 * rnd());
    const lean = 0.35 + 0.5 * rnd(); // outward lean at the tip, as a fraction of the height
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const wx = Math.cos(face);
    const wz = Math.sin(face);
    const base = position.length / 3;
    const w = 0.0055;
    // base pair, mid pair, tip
    const rows = [[0, w, 0], [0.5, w * 0.75, lean * 0.3], [1, 0, lean]];
    for (const [t, half, out] of rows) {
      const px = cx * r + cx * out * h * 0.5;
      const pz = cz * r + cz * out * h * 0.5;
      const y = t * h;
      if (half > 0) {
        position.push(px - wx * half, y, pz - wz * half, px + wx * half, y, pz + wz * half);
        aH.push(t, t);
      } else {
        position.push(px, y, pz);
        aH.push(t);
      }
    }
    index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 1));
  g.setIndex(index);
  return g;
}

function buildMaterial() {
  const tuft = attribute('aTuft', 'vec4'); // x, y, z, seed (< 0: unused)
  const aH = attribute('aH', 'float');
  const hash = (n) => fract(sin(n.mul(127.1).add(311.7)).mul(43758.5453));

  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  mat.positionNode = Fn(() => {
    const seed = tuft.w;
    const live = smoothstep(-0.5, 0.0, seed);
    const d = tuft.xz.sub(cameraPosition.xz).length();
    const fade = float(1.0).sub(smoothstep(FADE_RADIUS * 0.55, FADE_RADIUS, d));
    const scale = fade.mul(live).mul(hash(seed).mul(0.7).add(0.75));
    const yaw = hash(seed.add(3.1)).mul(6.2832);
    const c = cos(yaw);
    const s = sin(yaw);
    const p = positionLocal;
    const rot = vec3(p.x.mul(c).sub(p.z.mul(s)), p.y, p.x.mul(s).add(p.z.mul(c))).mul(scale);
    // a travelling wave over the field, blades bend with the square of their height
    const phase = tuft.x.mul(0.6).add(tuft.z.mul(0.35)).sub(time.mul(1.7));
    const bend = sin(phase).mul(0.5).add(sin(phase.mul(2.3).add(seed.mul(9.0))).mul(0.25)).mul(aH.mul(aH)).mul(0.045).mul(scale);
    return vec3(tuft.x.add(rot.x).add(bend), tuft.y.add(rot.y), tuft.z.add(rot.z).add(bend.mul(0.4)));
  })();
  mat.colorNode = Fn(() => {
    const ground = grassColour(tuft.xz);
    const root = float(0.5);
    const tip = float(1.18);
    const variation = hash(tuft.w.mul(7.0)).mul(0.22).add(0.89);
    const lit = mix(root, tip, smoothstep(0.0, 0.85, aH));
    return ground.mul(lit).mul(variation).mul(vec3(1.0, 1.04, 0.92));
  })();
  // blades are thin and double-sided: light them as if facing the sky, so a blade turned from the sun is not black
  mat.normalNode = normalize(mix(normalView, transformNormalToView(vec3(0.0, 1.0, 0.0)), 0.7));
  return mat;
}

/**
 * @param {THREE.Scene} scene
 * @param {{ surfaces: Array }} vegetationDoc cph-vegetation/1 (only the lawn polygons are read)
 * @param {{ terrain?: object|null }} opts
 */
export function createGrass(scene, vegetationDoc, { terrain = null, mask: givenMask = null } = {}) {
  // `mask`: a streamed lawn mask (createTiledLawnMask) the streamer fills tile by tile; otherwise the document's lawns
  const mask = givenMask || createLawnMask(vegetationDoc?.surfaces);
  const field = createGrassField({ mask, terrain });
  const geometry = buildTuftGeometry();
  const attr = new THREE.InstancedBufferAttribute(field.data, 4);
  // Tufts change only when the field moves; StaticDraw avoids reuploading an unchanged buffer each frame.
  attr.setUsage(THREE.StaticDrawUsage);
  geometry.setAttribute('aTuft', attr);
  geometry.instanceCount = field.count;
  const mesh = new THREE.Mesh(geometry, buildMaterial());
  mesh.name = 'grass-tufts';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return {
    mesh,
    field,
    update(x, z) {
      if (field.update(x, z, 4)) attr.needsUpdate = true;
    },
    /** The lawn mask changed under the field: refill it. */
    invalidate() { field.invalidate(); },
    get tufts() { return field.tufts; },
    dispose() { scene.remove(mesh); geometry.dispose(); mesh.material.dispose(); }
  };
}
