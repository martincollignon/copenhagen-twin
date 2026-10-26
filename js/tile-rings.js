// js/tile-rings.js
// The pure part of the tile streamer (no three.js, no fetch; runs in node): which tiles are wanted around the camera and at
// which fidelity, with hysteresis, and what has to be loaded, upgraded, downgraded, unloaded or aborted to get there.
//
//   near  full fidelity (facades, LoD2, surfaces, furniture, vegetation, grass, entrances, ground floor)
//   mid   buildings and roads (tone-only walls, no facade photos, doors, furniture, vegetation)
//   far   not a streamer ring: js/far-lod.js draws one block mesh per tile for every tile that is not resident
//
// A tile enters a ring when its nearest point is within the ring radius and leaves it only beyond radius + hysteresis, so a
// camera standing on a ring edge does not load and unload the same tile every frame.

import { tileBoundsLocal, parseTileId, tileId } from './tile-grid.js';

export const DEFAULT_STREAM = Object.freeze({ near: 750, mid: 2500, hysteresis: 250 });

/** Layers (data/tiles/<id>/<layer>.json) a tile needs for what it is asked to be. `roads` and `streets` stream with the tile. */
export const RING_LAYERS = Object.freeze({
  near: ['buildings', 'appearance', 'terrain', 'lod2', 'surfaces', 'vegetation', 'furniture', 'entrances', 'groundfloor', 'roads', 'streets', 'water'],
  mid: ['buildings', 'appearance', 'terrain', 'lod2', 'roads', 'streets', 'water']
});
/** What a neighbour contributes to the context (footprints, ground, surfaces) of a built tile. */
export const CONTEXT_LAYERS = Object.freeze({
  near: ['buildings', 'terrain', 'surfaces', 'vegetation', 'entrances', 'groundfloor', 'roads', 'streets'],
  mid: ['buildings', 'terrain', 'roads', 'streets']
});

/** ?stream=<near> -> a config. Mid defaults to 10/3 of near (750 -> 2500) and the hysteresis to a third of it, at most 250 m. */
export function streamConfig(opts = {}) {
  const near = Number.isFinite(opts.near) ? opts.near : DEFAULT_STREAM.near;
  const mid = Number.isFinite(opts.mid) ? opts.mid : near === DEFAULT_STREAM.near ? DEFAULT_STREAM.mid : Math.round((near * 10) / 3);
  const hysteresis = Number.isFinite(opts.hysteresis) ? opts.hysteresis : Math.min(DEFAULT_STREAM.hysteresis, Math.round(near / 3));
  if (!(near > 0) || mid < near || hysteresis < 0) throw new Error(`bad stream config ${JSON.stringify({ near, mid, hysteresis })}`);
  return { near, mid, hysteresis, maxConcurrent: opts.maxConcurrent ?? 4, maxBuilds: opts.maxBuilds ?? 1 };
}

/** Distance from (x, z) to the rectangle [x0, z0, x1, z1] (0 inside). */
export function distanceToRect(x, z, [x0, z0, x1, z1]) {
  const dx = Math.max(x0 - x, 0, x - x1);
  const dz = Math.max(z0 - z, 0, z - z1);
  return Math.hypot(dx, dz);
}

/** Ring a tile at distance d should be in, given the ring it is in now (null: not resident). */
export function ringFor(d, current, cfg) {
  const h = cfg.hysteresis;
  if (d <= cfg.near) return 'near';
  if (current === 'near') {
    if (d <= cfg.near + h) return 'near';
    return d <= cfg.mid + h ? 'mid' : null;
  }
  if (d <= cfg.mid) return 'mid';
  if (current === 'mid' && d <= cfg.mid + h) return 'mid';
  return null;
}

/**
 * Wanted tiles and their rings.
 * @param {{ x: number, z: number }} cam camera, local frame
 * @param {Array<{ id: string, bounds: number[] }>} tiles every tile of the index (bounds = local [xmin, zmin, xmax, zmax])
 * @param {Map<string, string>} current ring per tile now (absent: not resident)
 * @returns {Map<string, { ring: 'near'|'mid', d: number }>}
 */
export function wantedTiles(cam, tiles, current, cfg) {
  const out = new Map();
  for (const t of tiles) {
    const d = distanceToRect(cam.x, cam.z, t.bounds);
    const ring = ringFor(d, current.get(t.id) ?? null, cfg);
    if (ring) out.set(t.id, { ring, d });
  }
  return out;
}

/** The (up to 8) tiles around a tile that exist in the index. */
export function neighbourIds(id, exists) {
  const [ie, in_] = parseTileId(id);
  const out = [];
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      if (!a && !b) continue;
      const n = tileId(ie + a, in_ + b);
      if (exists(n)) out.push(n);
    }
  }
  return out;
}

/** Layers each tile must hold: its own ring's, plus the context layers for the tiles around a wanted one. Map id -> Set(layer). */
export function layerDemand(wanted, exists) {
  const demand = new Map();
  const need = (id, layers) => {
    let s = demand.get(id);
    if (!s) demand.set(id, (s = new Set()));
    for (const l of layers) s.add(l);
  };
  for (const [id, { ring }] of wanted) {
    need(id, RING_LAYERS[ring]);
    for (const n of neighbourIds(id, exists)) need(n, CONTEXT_LAYERS[ring]);
  }
  return demand;
}

/**
 * What to do now. `built` = ring each built tile has (Map), `building` = tiles whose build is running, `fetching` = Set of
 * tiles with a request in flight (their demand is `layerDemand`), `ready(id)` = every layer of the demand is in memory.
 * Returns { build: [{id, ring, d}] (nearest first, near before mid), rebuild: [{id, ring}] (a built tile whose ring changed),
 * unbuild: [id] (built but no longer wanted), release: [id] (data held for nobody), abort: [id] (request in flight for nobody) }.
 */
export function planStreaming({ wanted, demand, built, building = new Set(), fetching = new Set(), held, ready }) {
  const out = { build: [], rebuild: [], unbuild: [], release: [], abort: [] };
  for (const id of built.keys()) if (!wanted.has(id) && !building.has(id)) out.unbuild.push(id);
  for (const [id, w] of wanted) {
    if (building.has(id)) continue;
    const have = built.get(id);
    if (have === w.ring) continue;
    if (!ready(id)) continue;
    // a mid tile asked to be near, or the reverse, is rebuilt at its new fidelity
    (have ? out.rebuild : out.build).push({ id, ring: w.ring, d: w.d });
  }
  const order = (a, b) => (a.ring === b.ring ? a.d - b.d : a.ring === 'near' ? -1 : 1);
  out.build.sort(order);
  out.rebuild.sort(order);
  for (const id of held) if (!demand.has(id) && !building.has(id)) out.release.push(id);
  for (const id of fetching) if (!demand.has(id)) out.abort.push(id);
  return out;
}

/** Local extent [minX, minZ, maxX, maxZ] of a set of tile ids (their rectangles united). */
export function extentOfTiles(ids) {
  let b = null;
  for (const id of ids) {
    const r = tileBoundsLocal(id);
    b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : [...r];
  }
  return b;
}
