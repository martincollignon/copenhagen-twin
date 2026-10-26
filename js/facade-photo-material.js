import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, uniform, texture, uv, attribute, positionWorld, cameraPosition, length, dot, mix, step, smoothstep,
  max, exp, floor, mod
} from 'three/tsl';
import { bumpNormal, canyonSkyAONode, gridLine, noise2D, BRICK_L, BRICK_H } from './tsl-materials.js';
import { PHOTO } from './facade-lod.js';

// js/facade-photo-material.js
// Wall photos (the processed RGBA look atlases, tools/cph-geodata/facade_look.py) as a lit overlay on the extruded wall:
//   rgb    de-lit photo, normalised to the calibrated tone (the base albedo); mapped through the same gain + soft shoulder as
//          the procedural walls, so photo and procedural facades meet without a step in brightness
//   alpha  0 = unobserved texel (the procedural wall shows through), 128 = observed wall, 255 = window blob. Inside a blob the
//          dark pane pixels become glass: dark, smooth and reflective (sky IBL), recessed with a reveal shadow; frames and
//          reveals keep their photo
//   fade   smoothstep(close0, close1) * (1 - smoothstep(near, far)) of the distance, per fragment: procedural facade very close
//          (10 cm/px photo texels would be a blur there) and far away, the photo in between
//   detail the photo gets the real brick module (or plaster grain) back as relief and mortar
// `hasMask` false = a plain JPEG atlas (no alpha): everything counts as observed wall, no glass.

const ALBEDO_GAIN = 0.72;
const ALBEDO_KNEE = 0.4;
const ALBEDO_MAX = 0.58;
const lumW = vec3(0.2126, 0.7152, 0.0722);

function createPhotoMaterial(map, { hasMask = true, tone = [0.4, 0.38, 0.34], brick = true, texel = [1 / 128, 1 / 128] } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0 });
  mat.transparent = true;
  mat.depthWrite = false;
  mat.polygonOffset = true; // coplanar with the wall underneath: pulled towards the camera instead of lifted off the wall
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  mat.aoNode = canyonSkyAONode();
  const uTexel = uniform(new THREE.Vector2(texel[0], texel[1]));
  const wallLum = float(Math.max(0.02, 0.2126 * tone[0] + 0.7152 * tone[1] + 0.0722 * tone[2]));
  const brickOn = float(brick ? 1 : 0);
  const wuv = attribute('wallUV', 'vec2'); // metres along the wall, metres above the ground
  const camDist = length(positionWorld.sub(cameraPosition));

  const sample = (offset) => texture(map, uv().add(offset));
  const base = sample(vec2(0, 0));
  const blobAt = (offset) => (hasMask ? smoothstep(0.72, 0.95, sample(offset).a) : float(0));
  const observed = hasMask ? smoothstep(0.1, 0.45, base.a) : float(1);
  const blob = blobAt(vec2(0, 0));
  const lumTex = dot(base.rgb, lumW);
  const pane = blob.mul(smoothstep(0.86, 0.5, lumTex.div(wallLum)));

  // Reveal: the glass sits ~15 cm behind the wall face; the top and the sun-side jamb are in shade
  const dy = uTexel.y.mul(2.5);
  const dx = uTexel.x.mul(2.5);
  const shadeTop = hasMask ? pane.mul(float(1).sub(blobAt(vec2(0, dy.negate())))) : float(0);
  const shadeSide = hasMask ? pane.mul(float(1).sub(blobAt(vec2(dx.negate(), 0)))) : float(0);
  const reveal = float(1).sub(shadeTop.mul(0.55)).sub(shadeSide.mul(0.35));

  const gain = (c) => {
    const x = c.mul(ALBEDO_GAIN);
    const shoulder = float(1).sub(exp(x.sub(ALBEDO_KNEE).div(ALBEDO_MAX - ALBEDO_KNEE).negate())).mul(ALBEDO_MAX - ALBEDO_KNEE).add(ALBEDO_KNEE);
    return mix(x, shoulder, step(ALBEDO_KNEE, x));
  };

  // Close-range detail: real brick module / plaster grain over the photo
  const nearDetail = float(1).sub(smoothstep(8.0, 26.0, camDist));
  const row = floor(wuv.y.div(BRICK_H));
  const col = wuv.x.div(BRICK_L).add(mod(row, 2.0).mul(0.5));
  const bed = gridLine(wuv.y, BRICK_H, 0.010);
  const head = gridLine(col.mul(BRICK_L), BRICK_L, 0.010).mul(float(1).sub(bed));
  const mortar = max(bed, head).mul(brickOn).mul(nearDetail);
  const grain = noise2D(vec2(wuv.x.mul(5.0), wuv.y.mul(5.0))).sub(0.5).mul(0.10).mul(float(1).sub(brickOn)).mul(nearDetail);

  mat.colorNode = Fn(() => {
    const albedo = vec3(gain(base.r), gain(base.g), gain(base.b));
    const lit = albedo.mul(float(1).add(grain)).mul(float(1).sub(mortar.mul(0.16)));
    const glassCol = vec3(0.022, 0.03, 0.04);
    return mix(lit, glassCol, pane.mul(0.7)).mul(mix(float(1), reveal, blob));
  })();
  mat.roughnessNode = mix(float(0.86), float(0.05), pane);
  mat.metalnessNode = float(0);
  mat.normalNode = Fn(() => {
    const recess = blob.mul(-0.05).mul(float(1).sub(smoothstep(30.0, 90.0, camDist)));
    const relief = mortar.mul(-0.0018);
    return bumpNormal(recess.add(relief));
  })();
  mat.opacityNode = smoothstep(PHOTO.close0, PHOTO.close1, camDist).mul(float(1).sub(smoothstep(PHOTO.near, PHOTO.far, camDist))).mul(observed);
  return mat;
}

export { createPhotoMaterial };
