// js/tile-streamer.js
// Keeps the tiles around the camera resident (docs/citywide-plan.md, milestone C2). Every update (throttled) it
//   1. classifies the tiles of the index into rings around the camera with hysteresis (js/tile-rings.js, pure),
//   2. works out which layers of which tiles must be in memory (the ring's own plus the context of the neighbours),
//   3. aborts requests nobody wants any more, fetches the missing layers nearest-first under a concurrency cap,
//   4. builds the wanted tiles in the layer modules, one tile at a time, yielding between layers, nearest and near-ring first,
//   5. removes the layers of tiles that left their ring and releases data nobody needs.
//
// A layer module is { name, rings: ['near'] | ['near', 'mid'], fidelity?: boolean, add(ctx, ring), remove(id) }:
//   add    builds the tile (a context from js/tile-data.js tileContext; async allowed). Called again with the new ring
//          when a `fidelity` layer's tile moves between near and mid (it replaces its own previous build).
//   remove disposes everything add created for the tile.
// Layers run in the order given. A layer that throws is logged and skipped; the tile still counts as built.

import { layerDemand, planStreaming, wantedTiles, RING_LAYERS, CONTEXT_LAYERS, neighbourIds } from './tile-rings.js';
import { tileBoundsLocal } from './tile-grid.js';
import { nextFrame } from './yield-frame.js';

/**
 * @param {object} o
 *   store   the opened tile store (fetchLayer, hasLayer, layerBytes, ids)
 *   data    js/tile-data.js createTileData
 *   layers  layer modules, in build order
 *   cfg     js/tile-rings.js streamConfig
 *   interval  minimum ms between two classifications
 */
export function createTileStreamer({ store, data, layers, cfg, interval = 200, onError = (e) => console.warn('[cph] tile streamer:', e), yieldFrame = nextFrame }) {
  const exists = (id) => !!store.index.tiles[id];
  const tiles = store.ids.map((id) => ({ id, bounds: tileBoundsLocal(id) }));
  const boundsOf = new Map(tiles.map((t) => [t.id, t.bounds]));
  const ringOfBuilt = new Map(); // id -> ring the tile was last fully built at
  const layerRing = new Map(); // id -> Map(layer name -> ring it was built at)
  const fetching = new Map(); // `${id}/${layer}` -> { id, layer, controller }
  const building = new Set();
  const cancelled = new Set(); // tiles whose build must be undone when it finishes (they left every ring meanwhile)
  const failed = new Map(); // `${id}/${layer}` -> time of the last failure (retry after a while)
  let wanted = new Map();
  let demand = new Map();
  let cam = { x: 0, z: 0 };
  let lastRun = -Infinity;
  let active = 0; // tile builds running (cfg.maxBuilds at most)
  const waiters = [];

  const stats = {
    cfg,
    loads: 0, // layer fetches completed
    unloads: 0, // tiles removed from the layers
    builds: 0,
    rebuilds: 0,
    aborts: 0,
    errors: 0,
    bytes: 0, // JSON bytes of the layers in memory (as the index sizes them)
    slow: [], // the last add() calls that took > 40 ms: { t (performance.now), layer, id, ring, ms }
    layerMs: {}, // per layer module: builds, total and worst ms of add()
    lastBuildMs: 0,
    maxBuildMs: 0,
    updates: 0,
    peak: { near: 0, mid: 0 }
  };
  const bytesHeld = () => {
    let b = 0;
    for (const id of data.held()) for (const name of data.layersOf(id)) b += store.layerBytes(id, name);
    return b;
  };

  const layerNeeded = (id, name) => demand.get(id)?.has(name);

  /** Layers of the tile (and the context of its neighbours) that a build at `ring` needs and that are not in memory yet. */
  function missingFor(id, ring) {
    const missing = [];
    for (const name of RING_LAYERS[ring]) if (!data.has(id, name)) missing.push([id, name]);
    for (const n of neighbourIds(id, exists)) for (const name of CONTEXT_LAYERS[ring]) if (!data.has(n, name)) missing.push([n, name]);
    return missing;
  }
  const ready = (id) => missingFor(id, wanted.get(id).ring).length === 0;

  // ---------------------------------------------------------------------------------------------------- fetching
  // the request a layer is served by: one per layer unpacked, one per pack (several layers) packed (js/data-packs.js)
  const requestKey = (id, name) => (store.requestKey ? store.requestKey(id, name) : `${id}/${name}`);
  const inflightRequests = () => new Set([...fetching.values()].map((f) => f.request));

  function startFetch(id, name) {
    const key = `${id}/${name}`;
    if (fetching.has(key)) return false;
    if (!store.hasLayer(id, name)) { data.setLayer(id, name, null); return false; } // the tile has no such layer: settled
    const controller = new AbortController();
    fetching.set(key, { id, layer: name, controller, request: requestKey(id, name) });
    store.fetchLayer(id, name, controller.signal).then((payload) => {
      fetching.delete(key);
      if (controller.signal.aborted) return;
      if (!layerNeeded(id, name)) { stats.aborts++; return; } // arrived stale: dropped, never stored
      data.setLayer(id, name, payload);
      stats.loads++;
      stats.bytes = bytesHeld();
      pump();
    }).catch((error) => {
      fetching.delete(key);
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      stats.errors++;
      failed.set(key, performance.now());
      onError(error);
      pump();
    });
    return true;
  }

  function fetchMissing() {
    const requests = inflightRequests();
    if (requests.size >= cfg.maxConcurrent) return;
    // nearest tiles first, the near ring before the mid ring; context layers inherit the priority of the tile that needs them
    const want = [];
    const seen = new Set();
    const add = (id, name, w) => {
      const key = `${id}/${name}`;
      if (seen.has(key) || data.has(id, name) || fetching.has(key)) return;
      if (failed.has(key) && performance.now() - failed.get(key) < 5000) return;
      seen.add(key);
      want.push({ id, name, rank: (w.ring === 'near' ? 0 : 1e7) + w.d });
    };
    for (const [id, w] of wanted) {
      for (const name of RING_LAYERS[w.ring]) add(id, name, w);
      for (const n of neighbourIds(id, exists)) for (const name of CONTEXT_LAYERS[w.ring]) add(n, name, w);
    }
    want.sort((a, b) => a.rank - b.rank);
    // at most cfg.maxConcurrent requests in flight; a layer whose request is already running (another layer of the same pack) joins it
    for (const { id, name } of want) {
      const request = requestKey(id, name);
      if (!requests.has(request) && requests.size >= cfg.maxConcurrent) continue;
      if (startFetch(id, name)) requests.add(request);
    }
  }

  // ---------------------------------------------------------------------------------------------------- building
  const layersFor = (ring) => layers.filter((l) => l.rings.includes(ring));

  function removeFromLayers(id, only = null) {
    const lr = layerRing.get(id);
    for (const layer of [...layers].reverse()) {
      if (only && !only.has(layer.name)) continue;
      if (!lr?.has(layer.name)) continue;
      try { layer.remove(id); } catch (error) { stats.errors++; onError(error); }
      lr.delete(layer.name);
    }
    if (!lr?.size) layerRing.delete(id);
  }

  async function buildTile(id, ring) {
    const t0 = performance.now();
    building.add(id);
    const ctx = data.tileContext(id, ring);
    let lr = layerRing.get(id);
    if (!lr) layerRing.set(id, (lr = new Map()));
    const rebuilt = ringOfBuilt.has(id);
    try {
      for (const layer of layers) {
        const has = layer.rings.includes(ring);
        const at = lr.get(layer.name);
        if (!has) {
          if (at) { try { layer.remove(id); } catch (error) { stats.errors++; onError(error); } lr.delete(layer.name); }
          continue;
        }
        if (at && (!layer.fidelity || at === ring)) continue;
        const l0 = performance.now();
        try {
          await layer.add(ctx, ring);
          lr.set(layer.name, ring);
          const ms = performance.now() - l0;
          const m = (stats.layerMs[layer.name] ||= { n: 0, total: 0, max: 0 });
          m.n++; m.total += ms; m.max = Math.max(m.max, ms);
          if (ms > 40) { stats.slow.push({ t: Math.round(l0), layer: layer.name, id, ring, ms: Math.round(ms) }); if (stats.slow.length > 100) stats.slow.shift(); }
        } catch (error) {
          stats.errors++;
          onError(error);
        }
        await yieldFrame(); // one layer per frame at most: a tile never stalls the render loop for long
        if (cancelled.has(id)) break;
      }
    } finally {
      building.delete(id);
    }
    if (cancelled.has(id) || !wanted.has(id)) {
      cancelled.delete(id);
      removeFromLayers(id);
      ringOfBuilt.delete(id);
      stats.unloads++;
    } else {
      ringOfBuilt.set(id, ring);
      stats[rebuilt ? 'rebuilds' : 'builds']++;
    }
    stats.lastBuildMs = performance.now() - t0;
    stats.maxBuildMs = Math.max(stats.maxBuildMs, stats.lastBuildMs);
  }

  /** Releases the data nobody needs, but only while no build is reading it. */
  function releaseData() {
    if (building.size) return;
    for (const id of data.held()) {
      const need = demand.get(id);
      for (const name of data.layersOf(id)) if (!need?.has(name)) data.dropLayer(id, name);
    }
    stats.bytes = bytesHeld();
  }

  function pump() {
    const plan = planStreaming({
      wanted, demand, built: ringOfBuilt, building, fetching: new Set([...fetching.values()].map((f) => f.id)),
      held: new Set(data.held()), ready
    });
    // requests nobody wants any more
    for (const [key, f] of fetching) {
      if (!layerNeeded(f.id, f.layer)) { f.controller.abort(); fetching.delete(key); stats.aborts++; }
    }
    // tiles that left every ring
    for (const id of plan.unbuild) {
      removeFromLayers(id);
      ringOfBuilt.delete(id);
      stats.unloads++;
    }
    for (const id of building) { if (wanted.has(id)) cancelled.delete(id); else cancelled.add(id); }
    releaseData();
    fetchMissing();
    const order = (a, b) => (a.ring === b.ring ? a.d - b.d : a.ring === 'near' ? -1 : 1);
    const maxBuilds = cfg.maxBuilds ?? 1;
    if (active < maxBuilds) {
      const todo = [...plan.build, ...plan.rebuild].filter((n) => !building.has(n.id)).sort(order);
      for (const next of todo) {
        if (active >= maxBuilds) break;
        active++;
        buildTile(next.id, next.ring).then(() => { active--; pump(); }, (error) => { active--; stats.errors++; onError(error); pump(); });
      }
    }
    if (!active && !plan.build.length && !plan.rebuild.length) for (const w of waiters.splice(0)) w();
    const resident = { near: 0, mid: 0 };
    for (const ring of ringOfBuilt.values()) resident[ring]++;
    stats.peak.near = Math.max(stats.peak.near, resident.near);
    stats.peak.mid = Math.max(stats.peak.mid, resident.mid);
  }

  // ---------------------------------------------------------------------------------------------------- public
  function classify(x, z) {
    cam = { x, z };
    // hysteresis applies to every tile we already spent work on: the built ones and the ones still loading
    const current = new Map(ringOfBuilt);
    for (const [id, w] of wanted) if (!current.has(id)) current.set(id, w.ring);
    wanted = wantedTiles(cam, tiles, current, cfg);
    demand = layerDemand(wanted, exists);
    stats.updates++;
  }

  return {
    cfg,
    stats,
    /** Called every frame with the camera position (local frame); does its work at most every `interval` ms. */
    update(x, z, now = performance.now()) {
      if (now - lastRun < interval) return false;
      lastRun = now;
      classify(x, z);
      pump();
      return true;
    },
    /** Resolves when every wanted tile is built (boot: the loading screen waits for the first ring). */
    async settle(x, z, { timeout = 180000 } = {}) {
      lastRun = performance.now();
      classify(x, z);
      const t0 = performance.now();
      for (;;) {
        pump();
        const pending = [...wanted.keys()].some((id) => ringOfBuilt.get(id) !== wanted.get(id).ring);
        if (!pending && !building.size) return true;
        if (performance.now() - t0 > timeout) return false;
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
      }
    },
    isBuilt: (id) => ringOfBuilt.has(id),
    ringOf: (id) => ringOfBuilt.get(id) ?? null,
    /** For the headless checks and `?hooks`: what is resident now. */
    snapshot() {
      const resident = { near: [], mid: [] };
      for (const [id, ring] of ringOfBuilt) resident[ring].push(id);
      resident.near.sort(); resident.mid.sort();
      return {
        cfg,
        camera: cam,
        resident: { near: resident.near.length, mid: resident.mid.length, total: ringOfBuilt.size, ids: resident },
        wanted: wanted.size,
        held: data.held().length,
        fetching: fetching.size,
        building: building.size,
        ...stats,
        bytes: stats.bytes
      };
    },
    boundsOf: (id) => boundsOf.get(id)
  };
}
