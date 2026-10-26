// js/ground-height-cph.js
// Walking height of the Copenhagen ground surface model (pure, headless-testable). The street surfaces are layered
// geometry on top of the terrain (carriageway +0.02 m, cycle track +0.12 m, pavement +0.20 m, ramps between them); this
// rasterises those layer OFFSETS into a 0.5 m grid so pedestrians, cyclists and the player on foot or bike stand on what
// they see. `composeHeightField` adds the terrain (js/terrain-cph.js, the one ground model of the scene).
// Frame: x east, z south. heightAt() is bilinear, so a kerb is a ~0.5 m ramp instead of a one-frame jump.

export function createHeightGrid({ bbox, cell = 0.5 }) {
  const [x0, z0, x1, z1] = bbox;
  const w = Math.ceil((x1 - x0) / cell);
  const h = Math.ceil((z1 - z0) / cell);
  const data = new Uint8Array(w * h); // millimetres, 0..255
  const mm = (y) => Math.max(0, Math.min(255, Math.round(y * 1000)));

  // even-odd scanline fill of a flat ring at the cell centres; `value(xc, zc)` gives the height of a covered cell
  function fillRings(rings, value) {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { minZ = Math.min(minZ, r[i]); maxZ = Math.max(maxZ, r[i]); }
    const j0 = Math.max(0, Math.floor((minZ - z0) / cell - 0.5));
    const j1 = Math.min(h - 1, Math.ceil((maxZ - z0) / cell));
    for (let j = j0; j <= j1; j++) {
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
        for (let i = i0; i <= i1; i++) data[j * w + i] = mm(value(x0 + (i + 0.5) * cell, zc));
      }
    }
  }

  return {
    cell,
    bbox,
    /** Set every cell inside the polygon (flat ring, optional holes) to height y. */
    polygon(ring, y, holes = []) {
      if (ring.length >= 6) { const v = mm(y); fillRings([ring, ...holes.filter((r) => r.length >= 6)], () => v / 1000); }
    },
    /** Sloped quad (four x, z corners; heights per corner, rising along corner 0-1 -> 3-2): linear between the edges. */
    slope(quad, ys) {
      const ax = (quad[0] + quad[2]) / 2;
      const az = (quad[1] + quad[3]) / 2;
      const vx = (quad[4] + quad[6]) / 2 - ax;
      const vz = (quad[5] + quad[7]) / 2 - az;
      const l2 = vx * vx + vz * vz || 1;
      const ya = (ys[0] + ys[1]) / 2;
      const yb = (ys[2] + ys[3]) / 2;
      fillRings([quad], (x, z) => ya + (yb - ya) * Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)));
    },
    /** A strip of constant height between lateral offsets o0..o1 (right of travel positive) along a polyline. */
    ribbon(pts, o0, o1, y) {
      const n = pts.length / 2;
      for (let i = 0; i + 1 < n; i++) {
        const dx = pts[2 * i + 2] - pts[2 * i];
        const dz = pts[2 * i + 3] - pts[2 * i + 1];
        const l = Math.hypot(dx, dz);
        if (l < 1e-6) continue;
        const nx = -dz / l;
        const nz = dx / l;
        // a little extra length so consecutive segments leave no gaps at bends
        const e = 0.05;
        const a = [pts[2 * i] - (dx / l) * e, pts[2 * i + 1] - (dz / l) * e];
        const b = [pts[2 * i + 2] + (dx / l) * e, pts[2 * i + 3] + (dz / l) * e];
        const v = mm(y) / 1000;
        fillRings([[a[0] + nx * o0, a[1] + nz * o0, b[0] + nx * o0, b[1] + nz * o0, b[0] + nx * o1, b[1] + nz * o1, a[0] + nx * o1, a[1] + nz * o1]], () => v);
      }
    },
    /** Bilinear height (m) at (x, z); 0 outside the grid. */
    heightAt(x, z) {
      const fx = (x - x0) / cell - 0.5;
      const fz = (z - z0) / cell - 0.5;
      const i = Math.floor(fx);
      const j = Math.floor(fz);
      if (i < 0 || j < 0 || i + 1 >= w || j + 1 >= h) return 0;
      const tx = fx - i;
      const tz = fz - j;
      const o = j * w + i;
      const top = data[o] * (1 - tx) + data[o + 1] * tx;
      const bot = data[o + w] * (1 - tx) + data[o + w + 1] * tx;
      return (top * (1 - tz) + bot * tz) / 1000;
    },
    data
  };
}

/**
 * The scene's ground model: terrain + street-surface offsets.
 *   heightAt(x, z)    walking surface (terrain + the layer offset: pavement 0.2, carriageway 0.02, ...)
 *   terrainAt(x, z)   bare terrain (what cars and buses rest on, give or take the 0.02 m asphalt)
 *   offsetAt(x, z)    the layer offset alone
 * @param {{ heightAt: Function, flat?: boolean }|null} terrain
 * @param {{ heightAt: Function }} offsets grid from createHeightGrid (or any object with heightAt)
 */
export function composeHeightField(terrain, offsets) {
  const t = terrain && !terrain.flat ? terrain : null;
  return {
    ...offsets,
    terrain: t,
    offsetAt: (x, z) => offsets.heightAt(x, z),
    terrainAt: (x, z) => (t ? t.heightAt(x, z) : 0),
    heightAt: (x, z) => (t ? t.heightAt(x, z) : 0) + offsets.heightAt(x, z)
  };
}

/**
 * composeHeightField over per-tile offset grids: `addTile(id, grid, bounds)` / `removeTile(id)` as the streamer brings tiles in
 * and out. A point reads the grid of the tile it lies in (the grids reach 20 m past their tile, so the bilinear lookup never
 * runs off a grid inside its own tile); a tile without a grid has offset 0, i.e. bare terrain.
 * @param {{ heightAt: Function, flat?: boolean }|null} terrain the streamed terrain (js/terrain-cph.js createStreamTerrain)
 * @param {(x: number, z: number) => string} tileOf tile id of a local point (js/tile-grid.js tileOfLocal)
 */
export function createTiledHeightField(terrain, tileOf) {
  const grids = new Map();
  let lastId = null;
  let last = null;
  const offsets = {
    heightAt(x, z) {
      const id = tileOf(x, z);
      if (id !== lastId) { lastId = id; last = grids.get(id) || null; }
      return last ? last.heightAt(x, z) : 0;
    }
  };
  const field = composeHeightField(terrain, offsets);
  Object.assign(field, {
    stream: true,
    addTile(id, grid) { grids.set(id, grid); lastId = null; },
    removeTile(id) { const had = grids.delete(id); lastId = null; return had; },
    hasTile: (id) => grids.has(id)
  });
  Object.defineProperty(field, 'tileCount', { get: () => grids.size, enumerable: true });
  return field;
}
