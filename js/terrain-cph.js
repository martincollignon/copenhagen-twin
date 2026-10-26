// js/terrain-cph.js
// The ONE ground height field of the Copenhagen twin (pure, headless-testable). data/cph-terrain.json
// (tools/cph-geodata/terrain.py) is the DHM terrain model averaged to a 2 m grid; every layer of the scene takes its
// ground from `heightAt(x, z)` and adds only its own offset: carriageway +0.02, cycle track +0.12, pavement +0.20, a
// building's ground floor, the base of a tree, the wheels of a parked car. Frame: x east, z south, y up (local height =
// DVR90 - origin). Outside the grid the nearest edge value is used (clamped).

import { triangulatePolygon } from './polygon-cph.js';
import { tileOfLocal } from './tile-grid.js';
import { CPH_FRAME, getDataBbox } from './city-config.js';

export const TERRAIN_URL = './data/cph-terrain.json';
export const TERRAIN_MESH_DROP = 0.08; // the ground mesh lies this far under the field so surfaces never z-fight it

/** Fetches the compiled terrain. Null when absent or unreadable: the twin then boots on the flat plane (y = 0). */
export async function loadCphTerrain(url = TERRAIN_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-terrain/') ? doc : null;
  } catch (error) {
    console.info('[cph] no terrain loaded:', error?.message || error);
    return null;
  }
}

/** int16 centimetres (little endian, base64) -> Float32Array metres. */
export function decodeGrid(b64, count) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = ((v << 16) >> 16) / 100;
  }
  return out;
}

/** The flat plane (y = 0) with the same interface, for a twin without terrain data. */
export const FLAT_TERRAIN = Object.freeze({
  flat: true,
  heightAt: () => 0,
  lakeLevel: () => null,
  pondLevel: () => null,
  deckHeight: () => null,
  bbox: [...CPH_FRAME.bbox]
});

/**
 * @param {object} doc cph-terrain/1
 * @returns {{ heightAt: (x: number, z: number) => number, bbox: number[], cell: number, lakeLevel: Function, ... }}
 */
export function createTerrain(doc) {
  if (!doc) return FLAT_TERRAIN;
  const { width: w, height: h, cell } = doc;
  const [x0, z0] = doc.bbox;
  const grid = doc.grid || decodeGrid(doc.data, w * h); // tiles hand over `grid` already decoded (js/tile-store.js)
  const heightAt = (x, z) => {
    let fx = (x - x0) / cell - 0.5;
    let fz = (z - z0) / cell - 0.5;
    fx = fx < 0 ? 0 : fx > w - 1.000001 ? w - 1.000001 : fx;
    fz = fz < 0 ? 0 : fz > h - 1.000001 ? h - 1.000001 : fz;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const o = j * w + i;
    return (grid[o] * (1 - tx) + grid[o + 1] * tx) * (1 - tz) + (grid[o + w] * (1 - tx) + grid[o + w + 1] * tx) * tz;
  };
  const byId = (list, key) => new Map((list || []).map((e) => [e.id, e[key]]));
  const lakes = byId(doc.lakes, 'level');
  const ponds = byId(doc.ponds, 'level');
  const decks = byId(doc.bridges, 'deck');
  return {
    flat: false,
    doc,
    cell,
    bbox: doc.bbox,
    grid,
    heightAt,
    /** Measured water level of a lake / pond (the DTM there is the water surface), or null. */
    lakeLevel: (id) => lakes.get(id) ?? null,
    pondLevel: (id) => ponds.get(id) ?? null,
    /** Measured deck height of a bridge strip, or null. */
    deckHeight: (id) => decks.get(id) ?? null
  };
}

/**
 * The same height field held as per-tile chunks (js/tile-store.js `terrain` layer: int16 cm, 2 m cells, cell centres owned by
 * the tile), so tiles can come and go with the streamer. `heightAt` clamps to the compiled grid like createTerrain, then reads
 * the chunk the cell lives in; a cell whose tile is not resident reads 0, i.e. flat ground at the datum.
 * `header` is the city meta's `terrain` entry (bbox, cell, width, height, lakes, ponds, bridges, cut ...).
 * Pinned chunks (the tiles under the lakes, whose rims are baked into the water meshes at boot) are never removed.
 */
export function createChunkSampler(header) {
  const { width: w, height: h, cell } = header;
  const [X0, Z0] = header.bbox;
  const chunks = new Map(); // tile id -> { x0, z0, x1, z1, w, h, grid, pinned }
  let last = null;
  const chunkAt = (px, pz) => {
    if (last && px >= last.x0 && px < last.x1 && pz >= last.z0 && pz < last.z1) return last;
    const c = chunks.get(tileOfLocal(px, pz));
    if (c) last = c;
    return c || null;
  };
  const cellValue = (i, j) => {
    const c = chunkAt(X0 + (i + 0.5) * cell, Z0 + (j + 0.5) * cell);
    if (!c) return 0;
    const ci = Math.floor((X0 + (i + 0.5) * cell - c.x0) / cell);
    const cj = Math.floor((Z0 + (j + 0.5) * cell - c.z0) / cell);
    return ci >= 0 && cj >= 0 && ci < c.w && cj < c.h ? c.grid[cj * c.w + ci] : 0;
  };
  const heightAt = (x, z) => {
    let fx = (x - X0) / cell - 0.5;
    let fz = (z - Z0) / cell - 0.5;
    fx = fx < 0 ? 0 : fx > w - 1.000001 ? w - 1.000001 : fx;
    fz = fz < 0 ? 0 : fz > h - 1.000001 ? h - 1.000001 : fz;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return (cellValue(i, j) * (1 - tx) + cellValue(i + 1, j) * tx) * (1 - tz) + (cellValue(i, j + 1) * (1 - tx) + cellValue(i + 1, j + 1) * tx) * tz;
  };
  return {
    heightAt,
    chunks,
    /** chunk = { x0, z0, w, h, cell, grid: Float32Array metres } */
    set(id, chunk, pinned = false) {
      chunks.set(id, { x0: chunk.x0, z0: chunk.z0, x1: chunk.x0 + chunk.w * chunk.cell, z1: chunk.z0 + chunk.h * chunk.cell, w: chunk.w, h: chunk.h, grid: chunk.grid, pinned });
      last = null;
    },
    delete(id) { last = null; return chunks.delete(id); }
  };
}

export function createStreamTerrain(header) {
  const { cell } = header;
  const sampler = createChunkSampler(header);
  const chunks = sampler.chunks;
  const doc = { ...header, buildings: {} };
  const byId = (list, key) => new Map((list || []).map((e) => [e.id, e[key]]));
  const lakes = byId(header.lakes, 'level');
  const ponds = byId(header.ponds, 'level');
  const decks = byId(header.bridges, 'deck');
  return {
    flat: false,
    stream: true,
    doc,
    cell,
    bbox: header.bbox,
    heightAt: sampler.heightAt,
    lakeLevel: (id) => lakes.get(id) ?? null,
    pondLevel: (id) => ponds.get(id) ?? null,
    deckHeight: (id) => decks.get(id) ?? null,
    /** payload = the tile's `terrain` layer ({ tile, chunk, buildings }). */
    addTile(payload, { pin = false } = {}) {
      const c = payload?.chunk;
      if (!payload?.tile) return;
      if (c) {
        const old = chunks.get(payload.tile);
        sampler.set(payload.tile, { x0: c.x0, z0: c.z0, w: c.w, h: c.h, cell: c.cell, grid: decodeGrid(c.data, c.w * c.h) }, pin || !!old?.pinned);
      }
      Object.assign(doc.buildings, payload.buildings);
    },
    /** Drops the chunk and the per-building ground heights of a tile (`buildingIds` = the ids that tile owned). */
    removeTile(id, buildingIds = []) {
      const c = chunks.get(id);
      if (!c || c.pinned) return false;
      sampler.delete(id);
      for (const b of buildingIds) delete doc.buildings[b];
      return true;
    },
    hasTile: (id) => chunks.has(id),
    /** The decoded chunk of a tile { x0, z0, w, h, cell, grid } (what a worker's terrain is made of), or null. */
    chunkOf(id) {
      const c = chunks.get(id);
      return c ? { x0: c.x0, z0: c.z0, w: c.w, h: c.h, cell, grid: c.grid } : null;
    },
    get chunkCount() { return chunks.size; },
    header
  };
}

/** Adds the terrain height under every vertex of a flat xyz position array (in place). Returns the array. */
export function drapePositions(position, terrain) {
  if (!terrain || terrain.flat) return position;
  for (let i = 0; i < position.length; i += 3) position[i + 1] += terrain.heightAt(position[i], position[i + 2]);
  return position;
}

/** Splits a flat polyline [x0, z0, x1, z1, ...] so no segment is longer than `maxLen` (original vertices are kept). */
export function densifyPts(pts, maxLen = 6) {
  if (pts.length < 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const az = pts[i + 1];
    const bx = pts[i + 2];
    const bz = pts[i + 3];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / maxLen);
    for (let k = 1; k < n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
    out.push(bx, bz);
  }
  return out;
}

/** Same for a closed ring (the closing edge included; the first vertex is not repeated). */
export function densifyRing(ring, maxLen = 6) {
  const closed = densifyPts([...ring, ring[0], ring[1]], maxLen);
  return closed.slice(0, closed.length - 2);
}

/** Per-vertex unit normals (y up) of an indexed triangle mesh. */
export function vertexNormals(position, index) {
  const nrm = new Float32Array(position.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    const ux = position[b] - position[a];
    const uy = position[b + 1] - position[a + 1];
    const uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a];
    const vy = position[c + 1] - position[a + 1];
    const vz = position[c + 2] - position[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  return nrm;
}

/** Per-vertex normals of a non-indexed triangle list: every triangle's own face normal (what computeVertexNormals gives such a geometry). */
export function faceNormals(position) {
  const nrm = new Float32Array(position.length);
  for (let t = 0; t + 8 < position.length; t += 9) {
    const ux = position[t + 3] - position[t];
    const uy = position[t + 4] - position[t + 1];
    const uz = position[t + 5] - position[t + 2];
    const vx = position[t + 6] - position[t];
    const vy = position[t + 7] - position[t + 1];
    const vz = position[t + 8] - position[t + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { nrm[t + 3 * k] = nx; nrm[t + 3 * k + 1] = ny; nrm[t + 3 * k + 2] = nz; }
  }
  return nrm;
}

/**
 * The ground mesh: a regular grid over the district (cells the lakes touch are replaced by the clipped pieces in
 * `doc.cut`, cells inside water are left out), plus the frame polygon out to the horizon. Every vertex lies
 * TERRAIN_MESH_DROP under the height field. All triangles face up.
 * @returns {{ position: Float32Array, normal: Float32Array, uv: Float32Array, index: Uint32Array, stats: object }}
 */
export function buildTerrainMeshArrays(terrain, { cut = terrain.doc?.cut, frame = terrain.doc?.frame, drop = TERRAIN_MESH_DROP, uvSize = 8000, region = null, step = 1, frameOnly = false } = {}) {
  const pos = [];
  const idx = [];
  const y = (x, z) => terrain.heightAt(x, z) - drop;
  const vert = (x, z) => { pos.push(x, y(x, z), z); return pos.length / 3 - 1; };
  const up = (a, b, c) => {
    // wind so the normal points up: (b - a) x (c - a) has y = az*bx - ax*bz in (x, z)
    const cross = (pos[3 * b + 2] - pos[3 * a + 2]) * (pos[3 * c] - pos[3 * a]) - (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 2] - pos[3 * a + 2]);
    if (cross > 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  const half = cut?.half ?? getDataBbox()[2];
  const [bx0, bz0, bx1, bz1] = [-half, -half, half, half];
  const cell = cut?.cell ?? 4;
  const n = Math.round((bx1 - bx0) / cell);
  const skip = new Set(cut?.skip || []);
  const pieceCells = new Set((cut?.pieces || []).map((p) => p[1] * n + p[0]));
  // grid nodes are created on demand and shared between the cells that use them
  const node = new Map();
  const nodeAt = (i, j) => {
    const k = j * (n + 1) + i;
    let v = node.get(k);
    if (v === undefined) { v = vert(bx0 + i * cell, bz0 + j * cell); node.set(k, v); }
    return v;
  };
  let cells = 0;
  // `region` [x0, z0, x1, z1]: one tile's share of the grid (cells whose centre lies inside it, so neighbouring regions share
  // their edge nodes and leave no crack). `step` 2, 4 ...: coarser quads on the same lattice (only valid where no cut cell lies).
  const inRegion = (ci, cj) => {
    if (!region) return true;
    const mx = bx0 + (ci + step / 2) * cell;
    const mz = bz0 + (cj + step / 2) * cell;
    return mx >= region[0] && mx < region[2] && mz >= region[1] && mz < region[3];
  };
  for (let j = 0; j < (frameOnly ? 0 : n); j += step) {
    for (let i = 0; i < n; i += step) {
      if (!inRegion(i, j)) continue;
      const k = j * n + i;
      if (skip.has(k) || pieceCells.has(k)) continue;
      const a = nodeAt(i, j);
      const b = nodeAt(i + step, j);
      const c = nodeAt(i + step, j + step);
      const d = nodeAt(i, j + step);
      // split along the diagonal that follows the terrain (lower height difference)
      if (Math.abs(pos[3 * a + 1] - pos[3 * c + 1]) <= Math.abs(pos[3 * b + 1] - pos[3 * d + 1])) { up(a, b, c); up(a, c, d); } else { up(a, b, d); up(b, c, d); }
      cells++;
    }
  }
  for (const [pi, pj, ring] of frameOnly ? [] : cut?.pieces || []) {
    if (region && !inRegion(pi, pj)) continue;
    const { pts, idx: tri } = triangulatePolygon(ring);
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i += 2) vert(pts[i], pts[i + 1]);
    for (let t = 0; t < tri.length; t += 3) up(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
  }
  // frame: the hole edges follow the district edge, so they are densified to the grid cell (no cracks against the grid)
  for (const poly of region && !frameOnly ? [] : frame || [{ ring: [-4000, -4000, 4000, -4000, 4000, 4000, -4000, 4000], holes: [[bx0, bz0, bx1, bz0, bx1, bz1, bx0, bz1]] }]) {
    const { pts, idx: tri } = triangulatePolygon(poly.ring, (poly.holes || []).map((h) => densifyRing(h, cell)));
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i += 2) vert(pts[i], pts[i + 1]);
    for (let t = 0; t < tri.length; t += 3) up(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
  }
  const position = new Float32Array(pos);
  const index = new Uint32Array(idx);
  const uv = new Float32Array((position.length / 3) * 2);
  for (let i = 0; i < position.length / 3; i++) {
    uv[2 * i] = (position[3 * i] + uvSize / 2) / uvSize;
    uv[2 * i + 1] = (uvSize / 2 - position[3 * i + 2]) / uvSize;
  }
  return { position, normal: vertexNormals(position, index), uv, index, stats: { cells, pieces: cut?.pieces?.length || 0, skipped: skip.size, triangles: index.length / 3 } };
}

/** True when a cut cell (lake clipping) lies in the region: such a region must be meshed at step 1. */
export function cutTouchesRegion(cut, region, { half = cut?.half ?? getDataBbox()[2] } = {}) {
  if (!cut || !region) return false;
  const n = Math.round((2 * half) / cut.cell);
  const inside = (k) => {
    const i = k % n;
    const j = Math.floor(k / n);
    const mx = -half + (i + 0.5) * cut.cell;
    const mz = -half + (j + 0.5) * cut.cell;
    return mx >= region[0] - cut.cell && mx < region[2] + cut.cell && mz >= region[1] - cut.cell && mz < region[3] + cut.cell;
  };
  for (const k of cut.skip || []) if (inside(k)) return true;
  for (const [i, j] of cut.pieces || []) if (inside(j * n + i)) return true;
  return false;
}

/**
 * One tile's ground on the global lattice (origin -half, spacing cell: the lattice the district grid uses, so a tile of the
 * district and one outside it share nodes). Cells whose centre lies in `region` [x0, z0, x1, z1] are meshed; inside the cut area
 * (|x|, |z| < half) the lake cut cells are left out and replaced by their clipped pieces (js/terrain-cph.js buildTerrainMeshArrays),
 * outside it every cell is plain ground. `step` 2, 4 ...: coarser quads (only valid where no cut cell lies).
 * @returns {{ position: Float32Array, normal: Float32Array, uv: Float32Array, index: Uint32Array, stats: object }}
 */
export function buildTileGroundArrays(terrain, { cut = terrain.doc?.cut, region, step = 1, drop = TERRAIN_MESH_DROP, uvSize = 8000 } = {}) {
  const half = cut?.half ?? getDataBbox()[2];
  const cell = cut?.cell ?? 4;
  const n = Math.round((2 * half) / cell);
  const skip = new Set(cut?.skip || []);
  const pieceCells = new Set((cut?.pieces || []).map((p) => p[1] * n + p[0]));
  const pos = [];
  const idx = [];
  const OFF = 1 << 14;
  const node = new Map();
  const vert = (x, z) => { pos.push(x, terrain.heightAt(x, z) - drop, z); return pos.length / 3 - 1; };
  const nodeAt = (i, j) => {
    const k = (j + OFF) * (2 * OFF) + (i + OFF);
    let v = node.get(k);
    if (v === undefined) { v = vert(-half + i * cell, -half + j * cell); node.set(k, v); }
    return v;
  };
  const up = (a, b, c) => {
    const cross = (pos[3 * b + 2] - pos[3 * a + 2]) * (pos[3 * c] - pos[3 * a]) - (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 2] - pos[3 * a + 2]);
    if (cross > 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  // lattice blocks (multiples of `step`) whose centre lies in the region
  const lo = (v) => Math.ceil(((v + half) / cell - step / 2) / step - 1e-9) * step;
  const iStart = lo(region[0]);
  const jStart = lo(region[1]);
  let cells = 0;
  for (let j = jStart; -half + (j + step / 2) * cell < region[3]; j += step) {
    const mz = -half + (j + step / 2) * cell;
    if (mz < region[1]) continue;
    for (let i = iStart; -half + (i + step / 2) * cell < region[2]; i += step) {
      const mx = -half + (i + step / 2) * cell;
      if (mx < region[0]) continue;
      if (i >= 0 && j >= 0 && i < n && j < n) {
        const k = j * n + i;
        if (skip.has(k) || pieceCells.has(k)) continue;
      }
      const a = nodeAt(i, j);
      const b = nodeAt(i + step, j);
      const c = nodeAt(i + step, j + step);
      const d = nodeAt(i, j + step);
      if (Math.abs(pos[3 * a + 1] - pos[3 * c + 1]) <= Math.abs(pos[3 * b + 1] - pos[3 * d + 1])) { up(a, b, c); up(a, c, d); } else { up(a, b, d); up(b, c, d); }
      cells++;
    }
  }
  for (const [pi, pj, ring] of cut?.pieces || []) {
    const mx = -half + (pi + 0.5) * cell;
    const mz = -half + (pj + 0.5) * cell;
    if (mx < region[0] || mx >= region[2] || mz < region[1] || mz >= region[3]) continue;
    const { pts, idx: tri } = triangulatePolygon(ring);
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i += 2) vert(pts[i], pts[i + 1]);
    for (let t = 0; t < tri.length; t += 3) up(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
  }
  const position = new Float32Array(pos);
  const index = new Uint32Array(idx);
  const uv = new Float32Array((position.length / 3) * 2);
  for (let i = 0; i < position.length / 3; i++) {
    uv[2 * i] = (position[3 * i] + uvSize / 2) / uvSize;
    uv[2 * i + 1] = (uvSize / 2 - position[3 * i + 2]) / uvSize;
  }
  return { position, normal: vertexNormals(position, index), uv, index, stats: { cells, triangles: index.length / 3 } };
}
