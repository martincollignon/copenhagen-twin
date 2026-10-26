import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec4, texture, positionWorld, fwidth, length, mix, smoothstep, step, context } from 'three/tsl';
import { groundField, LAND } from './ground-field-cph.js';
import { poolLightAt } from './pool-light-cph.js';
import { gravelRGB, noise2D, srgb, wetFinish, wetReflectionWeightAt } from './surface-materials-cph.js';

// js/ground-shader-cph.js
// The plain ground of the twin (what shows where no pavement / register polygon is drawn over it): quiet grey stone,
// grass in the parks, and along the Soerne a fine-gravel lake path of LAND.pathW metres (soft, noisy edge) between the
// granite coping and the grass slope. One world-space shader fed by the ground-field texture (js/ground-field-cph.js).

/** Replaces the colour of `material` with the field shader. Returns { field, texture }. */
export function applyGroundField(material, lakesDoc, parks, { bbox }) {
  const field = groundField(lakesDoc, parks, { bbox });
  const tex = new THREE.DataTexture(field.data, field.width, field.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const [x0, z0, x1, z1] = bbox;
  const wp = positionWorld.xz;
  const uvf = vec2(wp.x.sub(x0).div(x1 - x0), wp.y.sub(z0).div(z1 - z0));
  const inside = step(x0, wp.x).mul(step(wp.x, x1)).mul(step(z0, wp.y)).mul(step(wp.y, z1));
  const f = texture(tex, uvf);
  const dist = f.r.mul(field.max).add(float(1000).mul(float(1).sub(inside))); // outside the district: far from any lake
  const edge = float(LAND.pathW).add(noise2D(wp.mul(0.22)).sub(0.5).mul(1.8)).add(noise2D(wp.mul(1.7)).sub(0.5).mul(0.5));
  const pathMask = float(1).sub(smoothstep(edge.sub(0.55), edge.add(0.65), dist)).mul(step(0.05, dist.add(f.r))); // 1 on the path
  const underCoping = float(1).sub(smoothstep(0.0, 0.5, dist)); // damp dark strip at the coping foot
  const surface = Fn(() => {
    const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
    const fine = float(1).sub(smoothstep(0.02, 0.2, fpw));
    const park = f.g.mul(inside);
    const big = noise2D(wp.mul(0.35));
    const mid = noise2D(wp.mul(3.1));
    const speck = noise2D(wp.mul(46.0)).sub(0.5).mul(0.16).mul(fine);
    // quiet stone / packed earth where nothing is drawn over the ground
    const stone = mix(srgb(112, 109, 103), srgb(132, 128, 120), big).mul(float(0.94).add(mid.mul(0.1)).add(speck));
    // grass: two greens by large-scale noise, worn paler towards the path
    const grass = mix(srgb(74, 104, 44), srgb(112, 134, 62), big.mul(0.6).add(mid.mul(0.4))).mul(float(0.92).add(speck.mul(1.6)));
    const ground = mix(stone, grass, park);
    const gravel = gravelRGB(wp).mul(float(1).sub(underCoping.mul(0.28)));
    const wetPath = wetFinish(gravel, float(0.95), wp);
    return mix(vec4(ground, 0.95), wetPath, pathMask);
  })();
  material.colorNode = surface.xyz;
  material.emissiveNode = surface.xyz.mul(poolLightAt(positionWorld));
  material.roughnessNode = surface.w;
  material.metalness = 0;
  material.contextNode = context({
    wetSurfaceReflection: pathMask.mul(wetReflectionWeightAt(wp))
  });
  return { field, texture: tex };
}
