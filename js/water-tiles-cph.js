import { Arrays, wallAlong, surfaceArrays, WATER, KIND, BANK_BATTER, BEACH_BATTER } from './lakes-cph.js';
import { chamfer } from './ground-field-cph.js';

// js/water-tiles-cph.js
// Pure (no three.js) geometry and rasters of the streamed city's generic water (milestone C4). The `water` layer of a tile
// (data/tiles/<id>/water.json, tools/cph-geodata/city_water.py) holds, for every body that touches the tile:
//   polys   the body clipped to the tile (flat rings, x east, z south, counter-clockwise from above, holes the other way)
//   level   the water level (local y)
//   walls   shore runs: { s: 'q' quay | 'b' natural bank | 's' sand beach, pts: [x, z, ...], top: [y per vertex] }; the water is on the LEFT of travel
//   pond    flat water, no walls (fountains, pools: 1500 m2 and smaller)
// plus the ground-mesh cut (`cut`), the green ground (`green`) and the trimmed surface polygons (`surfaceCuts`).
// The quay / bank geometry is the district's (js/lakes-cph.js wallAlong): granite wall with a coping, or a grassed bank with a 1 : 1.6 batter.

export const POND_LIFT = 0.02;
export const SEA_LEVEL = -6.84; // 0 m DVR90 in the local frame
/** 1 for water at the sea level (harbour, canals, the sound), 0 for lakes and ponds: the water shader's `waterTint`. */
export const seaTint = (level, kind) => (kind === 'sea' || Math.abs(level - SEA_LEVEL) < 0.05 ? 1 : 0);

/** Water surface + shore walls of one tile layer, as plain arrays (the same shapes buildLakeArrays returns). */
export function buildTileWaterArrays(payload) {
  const surface = { position: [], index: [], tint: [] };
  const walls = new Arrays();
  let wallMetres = 0;
  let surfaces = 0;
  for (const body of payload?.bodies || []) {
    const y = body.pond ? body.level + POND_LIFT : body.level;
    for (const poly of body.polys || []) {
      const s = surfaceArrays(poly.ring, poly.holes || [], y);
      if (!s.index.length) continue;
      const base = surface.position.length / 3;
      for (let i = 0; i < s.position.length; i++) surface.position.push(s.position[i]);
      const t = body.pond ? 0 : seaTint(body.level, body.kind);
      for (let i = 0; i < s.position.length; i += 3) surface.tint.push(t);
      for (const i of s.index) surface.index.push(base + i);
      surfaces++;
    }
    const level = body.level;
    for (const run of body.walls || []) {
      if (!run.pts || run.pts.length < 4) continue;
      const bank = run.s === 'b';
      const sand = run.s === 's';
      wallMetres += wallAlong(walls, run.pts, {
        faceSign: 1, open: true,
        yBottom: level + (WATER.bedY - WATER.surfaceY),
        yTop: (x, z, k) => run.top[k],
        vOf: (y) => y - level + WATER.surfaceY,
        ...(sand ? { batter: BEACH_BATTER, kind: KIND.sand, coping: false } : bank ? { batter: BANK_BATTER, kind: KIND.bank, coping: false } : { coping: true })
      });
    }
  }
  return { surface, walls, stats: { surfaces, wallMetres: Math.round(wallMetres), triangles: surface.index.length / 3, wallTriangles: walls.index.length / 3 } };
}

/** Even-odd fill of many (disjoint) flat rings into a Uint8 mask over the square window (x0, z0, cell, n x n), by an edge table: O(edges). */
export function fillRingsWindow(rings, { x0, z0, cell, n }) {
  const rows = new Array(n);
  for (const r of rings) {
    for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
      const ax = r[k]; const az = r[k + 1]; const bx = r[i]; const bz = r[i + 1];
      if (az === bz) continue;
      const zlo = Math.min(az, bz);
      const zhi = Math.max(az, bz);
      const j0 = Math.max(0, Math.ceil((zlo - z0) / cell - 0.5));
      const j1 = Math.min(n - 1, Math.ceil((zhi - z0) / cell - 0.5) - 1);
      if (j1 < 0 || j0 >= n) continue;
      const inv = (bx - ax) / (bz - az);
      for (let j = j0; j <= j1; j++) {
        const zc = z0 + (j + 0.5) * cell;
        (rows[j] ||= []).push(ax + (zc - az) * inv);
      }
    }
  }
  const inside = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const xs = rows[j];
    if (!xs) continue;
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - x0) / cell - 0.5));
      const i1 = Math.min(n - 1, Math.floor((xs[q + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * n + i] = 1;
    }
  }
  return inside;
}

/**
 * Shore distance of the water in a square window (Uint8, metres * 255 / max): the generic water shader's soft shoreline. `rings` are the
 * water polygons (rings and holes). Cells outside any ring are land; the window edge is not a shore.
 */
export function shoreWindow(rings, { x0, z0, cell = 2, n = 1024, max = WATER.shoreMax } = {}) {
  const water = fillRingsWindow(rings, { x0, z0, cell, n });
  const land = new Uint8Array(n * n);
  for (let i = 0; i < land.length; i++) land[i] = water[i] ? 0 : 1;
  const d = chamfer(land, n, n);
  const data = new Uint8Array(n * n);
  for (let i = 0; i < data.length; i++) {
    const metres = water[i] ? Math.max(0, d[i] - 0.5) * cell : 0;
    data[i] = Math.min(255, Math.round((metres / max) * 255));
  }
  return { data, width: n, height: n, x0, z0, cell, max, water };
}

/**
 * The ground shader's window raster (RGBA bytes): R the distance over land from the walls of the hand-made lakes (the Soerne's gravel
 * path), G the green mask (parks, grass, cemeteries), 0 on water. Same channels as js/ground-field-cph.js groundField, on a window.
 */
export function groundWindow({ lakeRings = [], greenRings = [], waterRings = [] }, { x0, z0, cell = 1.5, n = 1024, max = 24 } = {}) {
  const lake = lakeRings.length ? fillRingsWindow(lakeRings, { x0, z0, cell, n }) : new Uint8Array(n * n);
  const water = waterRings.length ? fillRingsWindow(waterRings, { x0, z0, cell, n }) : null;
  const green = greenRings.length ? fillRingsWindow(greenRings, { x0, z0, cell, n }) : null;
  const d = lakeRings.length ? chamfer(lake, n, n) : null;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const wet = lake[i] || (water && water[i]);
    const metres = d && !lake[i] ? Math.max(0, d[i] - 0.5) * cell : 0;
    data[4 * i] = lake[i] ? 0 : d ? Math.min(255, Math.round((metres / max) * 255)) : 255;
    data[4 * i + 1] = !wet && green && green[i] ? 255 : 0;
    data[4 * i + 3] = 255;
  }
  return { data, width: n, height: n, x0, z0, cell, max };
}

/** Window origin that keeps a window of `size` metres centred on (x, z), snapped to `snap` so the texels do not swim. */
export function windowOrigin(x, z, size, snap = 64) {
  return [Math.round((x - size / 2) / snap) * snap, Math.round((z - size / 2) / snap) * snap];
}

/** Flat rings (outer + holes) of the pieces of a far-ring water list that lie in the window. */
export function ringsInWindow(pieceLists, x0, z0, size) {
  const out = [];
  for (const pieces of pieceLists) {
    for (const piece of pieces || []) {
      for (const poly of piece.p || [piece]) {
        const r = poly.ring;
        let a = Infinity; let b = Infinity; let c = -Infinity; let e = -Infinity;
        for (let i = 0; i < r.length; i += 2) { if (r[i] < a) a = r[i]; if (r[i] > c) c = r[i]; if (r[i + 1] < b) b = r[i + 1]; if (r[i + 1] > e) e = r[i + 1]; }
        if (c < x0 || a > x0 + size || e < z0 || b > z0 + size) continue;
        out.push(r, ...(poly.holes || []));
      }
    }
  }
  return out;
}
