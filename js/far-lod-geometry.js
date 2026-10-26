// js/far-lod-geometry.js
// The geometry side of the far ring (docs/citywide-plan.md, C5). Pure: no three.js, no fetch, so it runs in node (the tests) and
// could run in a worker. Reads the blocks tools/cph-geodata/far_lod.py writes into data/city/far.bin (the layout is in its
// docstring) and builds typed arrays:
//   farTileArrays(buf, off, len, { wall, roof })  the merged prisms of one tile: walls and flat roofs, one tone per face group
//   farGroundArrays(buf, off, len, bounds)         the tile's 16 x 16 ground grid, coloured water / park / urban by height and the park bits
//   farWaterArrays(polygons)                       the lake and harbour polygons
// Positions of a tile are relative to its north-west corner (x = east, z = south); the layer places the mesh there.

import earcut from './earcut.js';

export const FAR_GRID = 16;
const HEAD = 4 + (FAR_GRID + 1) * (FAR_GRID + 1) * 2 + (FAR_GRID * FAR_GRID) / 8;

/** Reads the header of a tile block. */
export function readFarHeader(buf, off) {
  const v = new DataView(buf, off);
  return { count: v.getUint16(0, true), heightsAt: off + 4, parksAt: off + 4 + (FAR_GRID + 1) * (FAR_GRID + 1) * 2, buildingsAt: off + HEAD };
}

/** The 17 x 17 ground heights (metres, local y), row = z. */
export function farHeights(buf, off) {
  const { heightsAt } = readFarHeader(buf, off);
  const v = new DataView(buf, heightsAt);
  const out = new Float32Array((FAR_GRID + 1) * (FAR_GRID + 1));
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true) / 100;
  return out;
}

function parkBit(buf, parksAt, cell) {
  return (new Uint8Array(buf, parksAt, (FAR_GRID * FAR_GRID) / 8)[cell >> 3] >> (cell & 7)) & 1;
}

/**
 * Walls and roofs of the tile's prisms.
 * @returns {{ position: Float32Array, normal: Int8Array, color: Uint8Array, index: Uint32Array, buildings: number, triangles: number }}
 *   `normal` is Int8 (normalised, x y z 0), `color` Uint8 sRGB (r g b 255)
 */
export function farTileArrays(buf, off, len, { wallShade = 1, roofShade = 1 } = {}) {
  const { count, buildingsAt } = readFarHeader(buf, off);
  const end = off + len;
  const v = new DataView(buf);
  // first pass: sizes
  let o = buildingsAt;
  let verts = 0;
  let tris = 0;
  const recs = [];
  for (let b = 0; b < count && o < end; b++) {
    const start = o;
    const nOuter = v.getUint8(o);
    const nHoles = v.getUint8(o + 1);
    o += 12;
    const outerAt = o;
    o += nOuter * 4;
    const holes = [];
    for (let h = 0; h < nHoles; h++) {
      const n = v.getUint8(o);
      holes.push([o + 1, n]);
      o += 1 + n * 4;
    }
    const rings = nOuter + holes.reduce((s, h) => s + h[1], 0);
    verts += rings * 4 + rings; // wall quads + the roof's own vertices (one per ring point)
    tris += rings * 2 + Math.max(0, rings - 2 + 2 * nHoles);
    recs.push({ start, nOuter, outerAt, holes });
  }
  const position = new Float32Array(verts * 3);
  const normal = new Int8Array(verts * 4);
  const color = new Uint8Array(verts * 4);
  const index = new Uint32Array(tris * 3 + 3 * 8 * recs.length);
  let vi = 0;
  let ii = 0;
  const shade = (c, s) => Math.max(0, Math.min(255, Math.round(c * s)));
  for (const r of recs) {
    const base = v.getInt16(r.start + 2, true) / 100;
    const top = v.getInt16(r.start + 4, true) / 100;
    const wall = [v.getUint8(r.start + 6), v.getUint8(r.start + 7), v.getUint8(r.start + 8)];
    const roof = [v.getUint8(r.start + 9), v.getUint8(r.start + 10), v.getUint8(r.start + 11)];
    const rings = [[r.outerAt, r.nOuter], ...r.holes];
    const flat = []; // roof polygon for earcut: x, n (= -z)
    const holeIdx = [];
    const roofVerts = [];
    rings.forEach(([at, n], ri) => {
      if (ri > 0) holeIdx.push(flat.length / 2);
      const xs = new Float32Array(n);
      const zs = new Float32Array(n);
      for (let i = 0; i < n; i++) { xs[i] = v.getInt16(at + i * 4, true) / 10; zs[i] = v.getInt16(at + i * 4 + 2, true) / 10; }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = xs[j] - xs[i];
        const dz = zs[j] - zs[i];
        const l = Math.hypot(dx, dz);
        if (l < 0.05) continue;
        const nx = -dz / l;
        const nz = dx / l;
        const shadeW = wallShade * (0.86 + 0.14 * (nx * 0.4 + nz * 0.9)); // a little face-to-face variation the lights add to
        for (let k = 0; k < 4; k++) {
          const px = k === 1 || k === 2 ? xs[j] : xs[i];
          const pz = k === 1 || k === 2 ? zs[j] : zs[i];
          position.set([px, k < 2 ? base : top, pz], vi * 3);
          normal.set([Math.round(nx * 127), 0, Math.round(nz * 127), 0], vi * 4);
          color.set([shade(wall[0], shadeW), shade(wall[1], shadeW), shade(wall[2], shadeW), 255], vi * 4);
          vi++;
        }
        index.set([vi - 4, vi - 3, vi - 2, vi - 4, vi - 2, vi - 1], ii);
        ii += 6;
      }
      for (let i = 0; i < n; i++) { flat.push(xs[i], -zs[i]); roofVerts.push(xs[i], zs[i]); }
    });
    const roofBase = vi;
    for (let i = 0; i < roofVerts.length; i += 2) {
      position.set([roofVerts[i], top, roofVerts[i + 1]], vi * 3);
      normal.set([0, 127, 0, 0], vi * 4);
      color.set([shade(roof[0], roofShade), shade(roof[1], roofShade), shade(roof[2], roofShade), 255], vi * 4);
      vi++;
    }
    const t = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    for (let k = 0; k + 2 < t.length; k += 3) {
      const a = t[k]; const b = t[k + 1]; const c = t[k + 2];
      const area = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
      if (area >= 0) index.set([roofBase + a, roofBase + b, roofBase + c], ii); else index.set([roofBase + a, roofBase + c, roofBase + b], ii);
      ii += 3;
    }
  }
  return {
    position: position.subarray(0, vi * 3), normal: normal.subarray(0, vi * 4), color: color.subarray(0, vi * 4), index: index.subarray(0, ii),
    buildings: recs.length, triangles: ii / 3
  };
}

export const FAR_COLORS = Object.freeze({ water: [58, 96, 118], park: [92, 118, 70], urban: [118, 116, 108] });

/**
 * The ground of one tile on its 16 x 16 grid: positions relative to the tile's north-west corner, colour by what the cell is.
 * Heights at the sea (within 0.12 m of `sea`) are water, whatever the bits say.
 */
export function farGroundArrays(buf, off, bounds, sea = -6.84, colors = FAR_COLORS) {
  const n = FAR_GRID + 1;
  const h = farHeights(buf, off);
  const { parksAt } = readFarHeader(buf, off);
  const w = bounds[2] - bounds[0];
  const d = bounds[3] - bounds[1];
  const position = new Float32Array(n * n * 3);
  const color = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      position.set([(i / FAR_GRID) * w, h[k], (j / FAR_GRID) * d], k * 3);
      // a vertex is park when most of its (up to four) cells are; water when it is at the sea
      let park = 0; let cells = 0;
      for (const [ci, cj] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
        if (ci < 0 || cj < 0 || ci >= FAR_GRID || cj >= FAR_GRID) continue;
        cells++;
        park += parkBit(buf, parksAt, cj * FAR_GRID + ci);
      }
      const c = h[k] <= sea + 0.12 ? colors.water : park * 2 > cells ? colors.park : colors.urban;
      color.set([c[0], c[1], c[2], 255], k * 4);
    }
  }
  const index = new Uint16Array(FAR_GRID * FAR_GRID * 6);
  let ii = 0;
  for (let j = 0; j < FAR_GRID; j++) {
    for (let i = 0; i < FAR_GRID; i++) {
      const a = j * n + i; const b = a + 1; const c = a + n; const e = c + 1;
      // CCW seen from above (x east, z south): a, c, b / b, c, e
      index.set([a, c, b, b, c, e], ii);
      ii += 6;
    }
  }
  return { position, color, index };
}

/** Flat polygons (earcut) at their levels: lakes, ponds, harbour basins. Positions are absolute (local frame). */
export function farWaterArrays(polygons, { lift = 0.08 } = {}) {
  const pos = [];
  const idx = [];
  for (const p of polygons) {
    const ring = p.ring;
    const n = ring.length / 2;
    if (n < 3) continue;
    const flat = [];
    for (let i = 0; i < n; i++) flat.push(ring[2 * i], -ring[2 * i + 1]);
    const t = earcut(flat, undefined, 2);
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) pos.push(ring[2 * i], p.level + lift, ring[2 * i + 1]);
    for (let k = 0; k + 2 < t.length; k += 3) {
      const a = t[k]; const b = t[k + 1]; const c = t[k + 2];
      const area = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
      if (area >= 0) idx.push(base + a, base + b, base + c); else idx.push(base + a, base + c, base + b);
    }
  }
  return { position: new Float32Array(pos), index: new Uint32Array(idx) };
}

