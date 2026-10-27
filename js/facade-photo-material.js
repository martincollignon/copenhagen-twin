import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, texture, uv, attribute, positionWorld, cameraPosition, length, dot, mix, step, smoothstep,
  max, exp, floor, mod, dFdx, dFdy, normalize, normalWorldGeometry, clamp, sin, fract, uniform
} from 'three/tsl';
import { cityUniforms, apartmentOccupancy, apartmentLight, bumpNormal, canyonSkyAONode, gridLine, noise2D, BRICK_L, BRICK_H } from './tsl-materials.js';
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

function createPhotoMaterial(map, { hasMask = true, tone = [0.4, 0.38, 0.34], brick = true, layout = { floorH: 3, groundH: 3, seed: 0 } } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0 });
  mat.transparent = true;
  mat.depthWrite = false;
  mat.polygonOffset = true; // coplanar with the wall underneath: pulled towards the camera instead of lifted off the wall
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  mat.aoNode = canyonSkyAONode();
  // Per-building values must stay out of WGSL: constants compile a new GPU pipeline for every arriving photo wall.
  const wallLum = uniform(Math.max(0.02, 0.2126 * tone[0] + 0.7152 * tone[1] + 0.0722 * tone[2]));
  const brickOn = uniform(brick ? 1 : 0);
  const facadeLayout = uniform(new THREE.Vector3(layout.floorH, layout.groundH, layout.seed));
  const wuv = attribute('wallUV', 'vec2'); // metres along the wall, metres above the ground
  const camDist = length(positionWorld.sub(cameraPosition));

  const sample = (offset) => texture(map, uv().add(offset));
  const base = sample(vec2(0, 0));
  const blobAt = (offset) => (hasMask ? smoothstep(0.72, 0.95, sample(offset).a) : float(0));
  const observed = hasMask ? smoothstep(0.1, 0.45, base.a) : float(1);
  const blob = blobAt(vec2(0, 0));
  const lumTex = dot(base.rgb, lumW);
  const pane = blob.mul(smoothstep(0.86, 0.5, lumTex.div(wallLum)));

  // Atlas axes may be flipped. Derivatives convert metres along/up the wall to signed atlas offsets.
  // Two mask lookups replace the old fixed top/left lookups, retaining the photo's actual openings and frames.
  const metresToAtlas = (texCoord, wallCoord) => {
    const t = vec2(dFdx(texCoord), dFdy(texCoord));
    const w = vec2(dFdx(wallCoord), dFdy(wallCoord));
    return dot(t, w).div(max(dot(w, w), 1e-10));
  };
  const scale = vec2(metresToAtlas(uv().x, wuv.x), metresToAtlas(uv().y, wuv.y));
  const tangent = normalize(vec3(normalWorldGeometry.z, 0, normalWorldGeometry.x.negate()));
  const ray = normalize(positionWorld.sub(cameraPosition));
  const shift = clamp(vec2(dot(ray, tangent), ray.y).div(max(dot(ray, normalWorldGeometry).negate(), 0.05)).mul(0.14), vec2(-0.6), vec2(0.6));
  const sun = normalize(cityUniforms.uSkySunDir);
  const facing = dot(sun, normalWorldGeometry);
  const sunShift = clamp(vec2(dot(sun, tangent), sun.y).div(max(facing, 0.05)).mul(0.14), vec2(-0.6), vec2(0.6));
  const throughReveal = hasMask ? blobAt(shift.mul(scale)) : float(0);
  const sunOpen = hasMask ? blobAt(shift.add(sunShift).mul(scale)).mul(step(0, facing)) : float(0);
  const reveal = mix(float(1), float(0.5).add(sunOpen.mul(0.5)), pane);
  const glass = pane.mul(throughReveal);
  // The alpha atlas has no window IDs. Occupancy is coherent per storey, avoiding invented divisions across photo panes.
  const storey = max(float(0), floor(wuv.y.sub(facadeLayout.y).div(facadeLayout.x)).add(1));
  const roomPick = fract(sin(storey.mul(73.7).add(facadeLayout.z)).mul(43758.5453));
  const occupied = step(float(1).sub(apartmentOccupancy()), roomPick);

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
    return mix(lit, glassCol, glass.mul(0.7)).mul(mix(float(1), reveal, blob));
  })();
  mat.roughnessNode = mix(float(0.86), float(0.05), glass);
  mat.metalnessNode = float(0);
  mat.normalNode = Fn(() => {
    const recess = blob.mul(-0.14).mul(float(1).sub(smoothstep(30.0, 90.0, camDist)));
    const relief = mortar.mul(-0.0018);
    return bumpNormal(recess.add(relief));
  })();
  mat.emissiveNode = apartmentLight(roomPick).mul(occupied).mul(glass).mul(cityUniforms.uInteriorGlow).mul(0.3);
  mat.opacityNode = smoothstep(PHOTO.close0, PHOTO.close1, camDist).mul(float(1).sub(smoothstep(PHOTO.near, PHOTO.far, camDist))).mul(observed);
  return mat;
}

export { createPhotoMaterial };
