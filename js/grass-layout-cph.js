// js/grass-layout-cph.js
// Where the grass tufts stand (pure, no three.js; testable headless). The lawn polygons of data/cph-vegetation.json are
// rasterised once to a 1 m coverage grid; tufts live in a torus of TILE x TILE m tiles around the camera, so moving
// refills only the row/column of tiles that came into range and every tile always lands in the same buffer slot.
// A tuft is (x, y, z, seed); seed < 0 marks an unused instance (hidden by the shader). Frame: x east, z south.

import { createHeightGrid } from './ground-height-cph.js';
import { getDataBbox } from './city-config.js';

export const TILE = 8; // m
export const SPAN = 7; // tiles per side of the torus: 56 m, the fade radius is (SPAN - 2) / 2 tiles
export const PER_TILE = 800; // tufts per tile at full coverage: 12.5 per m2
export const TUFT_LIFT = 0.016; // base height over the terrain: just above the grass ground polygon (SURFACE_Y.ground 0.014)

/** Fade radius (m): tufts shrink to nothing here, the outermost tile ring is where tiles are still being filled. */
export const FADE_RADIUS = ((SPAN - 2) / 2) * TILE;

const hash = (a, b, c) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 1 m lawn coverage grid from the vegetation surfaces ({ ring, holes }). Returns { has(x, z), cells(x0, z0, x1, z1) }. */
export function createLawnMask(surfaces, bbox = getDataBbox().map((v, i) => v + (i < 2 ? -20 : 20))) {
  const grid = createHeightGrid({ bbox, cell: 1 });
  for (const s of surfaces || []) if (s.ring?.length >= 6) grid.polygon(s.ring, 0.001, s.holes || []);
  const [x0, z0] = bbox;
  const w = Math.ceil((bbox[2] - x0) / 1);
  const h = Math.ceil((bbox[3] - z0) / 1);
  const has = (x, z) => {
    const i = Math.floor(x - x0);
    const j = Math.floor(z - z0);
    return i >= 0 && j >= 0 && i < w && j < h && grid.data[j * w + i] > 0;
  };
  return { has };
}

/**
 * The lawn mask as per-tile chunks (1 m cells over the tile): `addTile(id, surfaces, bounds)` rasterises the lawn polygons that
 * reach the tile (its neighbours' too), `removeTile(id)` frees it. `tileOf(x, z)` = js/tile-grid.js tileOfLocal. Outside a
 * resident chunk there is no lawn.
 */
export function createTiledLawnMask(tileOf) {
  const chunks = new Map();
  return {
    has(x, z) {
      const c = chunks.get(tileOf(x, z));
      return !!c && c.has(x, z);
    },
    addTile(id, surfaces, bounds) {
      chunks.set(id, createLawnMask(surfaces, [...bounds]));
    },
    removeTile: (id) => chunks.delete(id),
    hasTile: (id) => chunks.has(id),
    get size() { return chunks.size; }
  };
}

/** Writes the tufts of tile (tx, tz) into out[offset ...] (PER_TILE * 4 floats); returns how many are in use. */
export function fillTile(tx, tz, mask, terrain, out, offset) {
  const n = Math.ceil(Math.sqrt(PER_TILE));
  const step = TILE / n;
  let used = 0;
  for (let i = 0; i < PER_TILE; i++) {
    const gx = i % n;
    const gz = Math.floor(i / n);
    const x = tx * TILE + (gx + hash(tx, tz, i * 2)) * step;
    const z = tz * TILE + (gz + hash(tx, tz, i * 2 + 1)) * step;
    const o = offset + i * 4;
    if (mask.has(x, z)) {
      out[o] = x;
      out[o + 1] = (terrain && !terrain.flat ? terrain.heightAt(x, z) : 0) + TUFT_LIFT;
      out[o + 2] = z;
      out[o + 3] = hash(tx, tz, i + 7919);
      used++;
    } else {
      out[o] = x;
      out[o + 1] = 0;
      out[o + 2] = z;
      out[o + 3] = -1;
    }
  }
  return used;
}

/**
 * The torus of tiles around the camera. `update(x, z, budget)` refills at most `budget` stale tiles (nearest first) and
 * returns how many it filled; `data` is the instance buffer (SPAN * SPAN * PER_TILE tufts of 4 floats).
 */
export function createGrassField({ mask, terrain = null }) {
  const slots = SPAN * SPAN;
  const data = new Float32Array(slots * PER_TILE * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = -1;
  const owner = new Int32Array(slots * 2).fill(0x7fffffff); // (tx, tz) per slot
  const mod = (a) => ((a % SPAN) + SPAN) % SPAN;
  let tufts = 0;
  const used = new Int32Array(slots);

  function update(x, z, budget = 4) {
    const cx = Math.floor(x / TILE);
    const cz = Math.floor(z / TILE);
    const half = (SPAN - 1) / 2;
    const stale = [];
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        const tx = cx + dx;
        const tz = cz + dz;
        const s = mod(tx) + SPAN * mod(tz);
        if (owner[2 * s] !== tx || owner[2 * s + 1] !== tz) stale.push([dx * dx + dz * dz, tx, tz, s]);
      }
    }
    stale.sort((a, b) => a[0] - b[0]);
    let done = 0;
    for (const [, tx, tz, s] of stale) {
      if (done >= budget) break;
      tufts -= used[s];
      used[s] = fillTile(tx, tz, mask, terrain, data, s * PER_TILE * 4);
      tufts += used[s];
      owner[2 * s] = tx;
      owner[2 * s + 1] = tz;
      done++;
    }
    return done;
  }

  /** The lawn mask changed (a tile came or went): every slot is refilled as the camera's frames allow. */
  function invalidate() {
    owner.fill(0x7fffffff);
  }

  return { data, update, invalidate, get tufts() { return tufts; }, count: slots * PER_TILE };
}
