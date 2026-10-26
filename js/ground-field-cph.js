import { extendBeyondBbox } from './lakes-cph.js';

// js/ground-field-cph.js
// Pure raster behind the lake-path ground shader (js/water-cph.js applyGroundField): for every cell of the district
//   R  distance from the lake wall over LAND, metres (capped at LAND.max), 0 on water
//   G  park / green area mask (parks, the Soerne shore strips), 0 on water
// The ground shader paints a fine-gravel path in the first LAND.pathW metres from the quay and grass beyond it in parks,
// from this one texture, so the gravel register polygons (same colour function) and the band never show a seam.

export const LAND = Object.freeze({ cell: 1, max: 24, pathW: 3.6 });

/** Scanline even-odd fill of `rings` (flat [x, z, ...]) into a Uint8 mask over bbox at `cell`. */
export function fillRings(rings, { bbox, cell = LAND.cell, w, h, into = null }) {
  const [x0, z0] = bbox;
  const inside = into || new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const zc = z0 + (j + 0.5) * cell;
    const xs = [];
    for (const r of rings) {
      for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
        const zi = r[i + 1];
        const zk = r[k + 1];
        if ((zi > zc) !== (zk > zc)) xs.push(r[i] + ((zc - zi) / (zk - zi)) * (r[k] - r[i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[q + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  return inside;
}

/** Two-pass chamfer distance (cells) from every cell to the nearest cell where `source` is 1; source cells get 0. */
export function chamfer(source, w, h) {
  const BIG = 1e4;
  const d = new Float32Array(w * h);
  for (let n = 0; n < d.length; n++) d[n] = source[n] ? 0 : BIG;
  const SQ = Math.SQRT2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = j * w + i;
      let v = d[n];
      if (!v) continue;
      if (i > 0) v = Math.min(v, d[n - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[n - w] + 1);
        if (i > 0) v = Math.min(v, d[n - w - 1] + SQ);
        if (i < w - 1) v = Math.min(v, d[n - w + 1] + SQ);
      }
      d[n] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const n = j * w + i;
      let v = d[n];
      if (!v) continue;
      if (i < w - 1) v = Math.min(v, d[n + 1] + 1);
      if (j < h - 1) {
        v = Math.min(v, d[n + w] + 1);
        if (i < w - 1) v = Math.min(v, d[n + w + 1] + SQ);
        if (i > 0) v = Math.min(v, d[n + w - 1] + SQ);
      }
      d[n] = v;
    }
  }
  return d;
}

/**
 * @param {object} lakesDoc cph-lakes (lakes with holes)
 * @param {Array<{ring: number[], holes?: number[][]}>} parks green areas
 * @returns {{ data: Uint8Array, width: number, height: number, bbox: number[], cell: number, max: number }} RGBA bytes
 */
export function groundField(lakesDoc, parks = [], { bbox = [-750, -750, 750, 750], cell = LAND.cell, max = LAND.max } = {}) {
  const [x0, z0, x1, z1] = bbox;
  const w = Math.ceil((x1 - x0) / cell);
  const h = Math.ceil((z1 - z0) / cell);
  const waterRings = [];
  for (const lake of lakesDoc?.lakes || []) {
    waterRings.push(extendBeyondBbox(lake.ring, bbox));
    for (const hole of lake.holes || []) waterRings.push(extendBeyondBbox(hole, bbox));
  }
  const water = fillRings(waterRings, { bbox, cell, w, h });
  const green = new Uint8Array(w * h);
  for (const p of parks) {
    if (!p.ring || p.ring.length < 6) continue;
    fillRings([p.ring, ...(p.holes || [])], { bbox, cell, w, h, into: green });
  }
  const d = chamfer(water, w, h);
  const data = new Uint8Array(w * h * 4);
  for (let n = 0; n < w * h; n++) {
    const metres = water[n] ? 0 : Math.max(0, d[n] - 0.5) * cell; // the wall sits half a cell outside the first water cell centre
    data[4 * n] = Math.min(255, Math.round((metres / max) * 255));
    data[4 * n + 1] = !water[n] && green[n] ? 255 : 0;
    data[4 * n + 3] = 255;
  }
  return { data, width: w, height: h, bbox, cell, max };
}

/** Distance (m) from (x, z) over land to the nearest lake wall, from a `groundField` (nearest cell; 0 on water, `max` far away). */
export function lakeDistanceFrom(field) {
  const { data, width, height, bbox, cell, max } = field;
  return (x, z) => {
    const i = Math.floor((x - bbox[0]) / cell);
    const j = Math.floor((z - bbox[1]) / cell);
    if (i < 0 || j < 0 || i >= width || j >= height) return max;
    return (data[(j * width + i) * 4] / 255) * max;
  };
}
