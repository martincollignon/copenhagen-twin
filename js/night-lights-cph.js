// js/night-lights-cph.js
// Pure night-lighting logic of the Copenhagen twin (no three.js, headless-testable):
//   * photometry per lamp class from the register data (light source, colour temperature, wattage, mounting height);
//   * a clustered "light pool" raster: the illuminance of every lamp on the ground, splatted into one RGB window around
//     the camera (the ground / road / pavement shaders add it as light, js/pool-light-cph.js), so every lantern in the
//     district lights its street without a real light each;
//   * the choice of the few REAL point lights that light cars, people, benches and facades next to the camera.
// Colour temperature comes from the data (`cct`: LED 2700-4000 K, metal halide 3000 K, sodium 2000 K), see lightColor().

import { lightColor } from './street-furniture-data.js';

/** Luminous efficacy (lm/W at the lamp, fixture losses included) and a sky-glow tint per source class. */
export const EFFICACY = Object.freeze({ led: 105, metalhalide: 78, sodium: 95, fluorescent: 62, mercury: 45, unknown: 80 });
/** Peak ground illuminance (lux) of a typical 70 W lantern at 8 m (KK lighting classes: 10-20 lux on a street). */
export const PEAK_LUX = Object.freeze({ wire: 13, mast: 17, park: 9, lake: 4.5 });

/**
 * Photometric record of a mapped lamp (street-furniture-data.js mapLamps) or a lake light:
 * { color (linear-ish rgb 0-1 from the CCT), lux (ground illuminance under the lamp), height (m above the ground),
 *   radius (pool radius, m), watt, cls ('led' | 'metalhalide' | 'sodium' | ...), real (point-light candela) }
 */
export function lampPhotometry(l) {
  const cls = l.light || (l.led ? 'led' : 'unknown');
  const cct = l.cct || 3000;
  const watt = Math.max(5, l.watt || 60);
  const kind = l.kind || (l.mount === 'wire' ? 'wire' : l.pole === 'park' ? 'park' : l.mount === 'mast' ? 'mast' : 'wire');
  const height = Math.max(0.6, l.lampY != null && l.y != null ? l.lampY - l.y : l.height || 6);
  const lumens = watt * (EFFICACY[cls] || EFFICACY.unknown);
  // ground illuminance scales with the flux of the lamp against a 70 W / 6 klm reference, sub-linearly (optics are tuned to the street width)
  const lux = PEAK_LUX[kind] * Math.pow(Math.max(0.15, lumens / 6000), 0.7);
  const radius = Math.min(18, 2.6 * height);
  return { color: l.color || lightColor(cct), lux, height, radius, watt, cls, kind, cct, lumens, real: lumens * 0.09 };
}

/** Ground illuminance (lux) of a lamp at horizontal distance r: I0 cos^2 distribution, peak `lux` under the lamp. */
export function poolLux(photo, r) {
  const h = photo.height;
  const d2 = h * h + r * r;
  // E = I0 h^3 / d^5 with E(0) = lux  =>  E(r) = lux * (h^2 / d^2)^2.5
  const k = (h * h) / d2;
  return photo.lux * Math.pow(k, 2.5);
}

/**
 * The pool window: an RGB raster (`size` texels square, `cell` metres) centred near (cx, cz), snapped to `snap` metres so the
 * raster does not swim while the camera moves. Values are illuminance in lux (sum over lamps) per channel, scaled by the lamp colour.
 * @returns {{ data: Float32Array, size: number, cell: number, x0: number, z0: number, lamps: number }}
 */
export function buildPoolWindow(lamps, cx, cz, { size = 256, cell = 0.75, snap = 12, target = null } = {}) {
  const half = (size * cell) / 2;
  const x0 = Math.round(cx / snap) * snap - half;
  const z0 = Math.round(cz / snap) * snap - half;
  const data = target && target.length === size * size * 3 ? target.fill(0) : new Float32Array(size * size * 3);
  let used = 0;
  for (const l of lamps) {
    const p = l.photo || (l.photo = lampPhotometry(l));
    const R = p.radius;
    if (l.x + R < x0 || l.x - R > x0 + size * cell || l.z + R < z0 || l.z - R > z0 + size * cell) continue;
    used++;
    const i0 = Math.max(0, Math.floor((l.x - R - x0) / cell));
    const i1 = Math.min(size - 1, Math.ceil((l.x + R - x0) / cell));
    const j0 = Math.max(0, Math.floor((l.z - R - z0) / cell));
    const j1 = Math.min(size - 1, Math.ceil((l.z + R - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * cell - l.z;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * cell - l.x;
        const r = Math.hypot(dx, dz);
        if (r > R) continue;
        // smooth cut-off at the radius so the pool has no edge
        const fade = r > R * 0.7 ? 1 - Math.pow((r - R * 0.7) / (R * 0.3), 2) : 1;
        const e = poolLux(p, r) * Math.max(0, fade);
        const o = (j * size + i) * 3;
        data[o] += e * p.color[0];
        data[o + 1] += e * p.color[1];
        data[o + 2] += e * p.color[2];
      }
    }
  }
  return { data, size, cell, x0, z0, lamps: used };
}

/** Encodes a pool window to RGBA8 (sqrt of lux / `maxLux`), the format the ground shaders sample. */
export function encodePoolWindow(win, { maxLux = 40, out = null } = {}) {
  const n = win.size * win.size;
  const bytes = out && out.length === n * 4 ? out : new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) bytes[4 * k + c] = Math.min(255, Math.round(Math.sqrt(Math.min(1, win.data[3 * k + c] / maxLux)) * 255));
    bytes[4 * k + 3] = 255;
  }
  return bytes;
}

/**
 * The `n` real point lights next to the camera: nearest lamps first, weighted by their flux, so a lantern right above the
 * camera always wins. `lamps` are items with { x, z, lampY, photo? }. Returns the selected items (at most n), nearest first.
 */
export function selectRealLights(lamps, cx, cz, n = 8, maxDist = 48) {
  const scored = [];
  for (const l of lamps) {
    const d = Math.hypot(l.x - cx, l.z - cz);
    if (d > maxDist) continue;
    const p = l.photo || (l.photo = lampPhotometry(l));
    scored.push([d / Math.sqrt(Math.max(0.2, p.lumens / 6000)), l]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, n).map((s) => s[1]);
}

/** Point-light candela for a selected lamp (the PointLight intensity), tuned against the pool raster. */
export const realIntensity = (photo) => 18 + photo.real * 0.045;

/** Glare halo diameter (m) of a lantern seen from `dist` metres: grows with distance, a faint core when very close. */
export function haloSize(photo, dist) {
  const base = 0.5 + Math.min(1.2, photo.lumens / 9000);
  return Math.min(7, base * (1 + dist * 0.045));
}
