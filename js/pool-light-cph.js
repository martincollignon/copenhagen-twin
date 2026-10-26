import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uniform, texture, step, clamp, max } from 'three/tsl';

// js/pool-light-cph.js
// The shader side of the clustered street-light pools (pure side: js/night-lights-cph.js). One RGBA8 window raster of the
// ground illuminance around the camera (sqrt-encoded lux); the ground, road and pavement materials add
// `albedo * poolLightAt(position)` to their emission, so every lantern lights its street and pavement at the cost of one
// texture sample per ground fragment. `on` is the lamps' switch-on factor (0 by day).

export const POOL = Object.freeze({ size: 256, cell: 0.75, maxLux: 40 });

export const poolUniforms = {
  origin: uniform(new THREE.Vector2(1e6, 1e6)), // world x, z of the window's minimum corner
  extent: uniform(POOL.size * POOL.cell),
  on: uniform(0),
  strength: uniform(0.13) // emission per lux (albedo * lux * strength): 15 lux lights a pale slab to ~2 (before tone mapping)
};

export const poolTexture = new THREE.DataTexture(new Uint8Array(POOL.size * POOL.size * 4), POOL.size, POOL.size, THREE.RGBAFormat, THREE.UnsignedByteType);
poolTexture.magFilter = poolTexture.minFilter = THREE.LinearFilter;
poolTexture.wrapS = poolTexture.wrapT = THREE.ClampToEdgeWrapping;
poolTexture.generateMipmaps = false;
poolTexture.colorSpace = THREE.NoColorSpace;
poolTexture.needsUpdate = true;

/** Uploads a window built by night-lights-cph.js buildPoolWindow / encodePoolWindow. */
export function setPoolWindow(win, bytes) {
  poolTexture.image.data.set(bytes);
  poolTexture.needsUpdate = true;
  poolUniforms.origin.value.set(win.x0, win.z0);
}

/** Linear rgb light (to be multiplied by the surface albedo) at a world position, 0 outside the window. `wp` = positionWorld (vec3). */
export const poolLightAt = Fn(([wp]) => {
  const uvp = vec2(wp.x.sub(poolUniforms.origin.x), wp.z.sub(poolUniforms.origin.y)).div(poolUniforms.extent);
  const inside = step(0.0, uvp.x).mul(step(uvp.x, 1.0)).mul(step(0.0, uvp.y)).mul(step(uvp.y, 1.0));
  const enc = texture(poolTexture, uvp).rgb;
  const lux = enc.mul(enc).mul(POOL.maxLux);
  return lux.mul(poolUniforms.strength).mul(poolUniforms.on).mul(inside);
});
