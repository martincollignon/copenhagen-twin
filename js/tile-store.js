// js/tile-store.js
// Reads the tiled layers (data/tiles/index.json, data/tiles/<id>/<layer>.json, data/city/*; written by
// tools/cph-geodata/tile_split.py) and assembles them into the same documents the monolithic files hold, so the layer
// modules (buildings-real, street-furniture-data, terrain, surfaces, vegetation ...) take their inputs from tiles when
// the index exists and from data/cph-*.json otherwise (world.js decides).
//
// Pure assembly (no fetch, no three.js) lives in the `create*Assembler` functions: each has addTile(payload) and doc(), so
// the streamer of milestone C2 can add tiles one by one. Items keep the index they had in the source list (`ord`), so a
// complete set of tiles yields the source documents exactly; a partial set comes out in source order.
//
// Ownership is by centroid (no geometry is split): an item may stick out of its tile into a neighbour, so a consumer that
// loads a subset of tiles must also load the ring of neighbours around it.

import { parseLod2Record } from './lod2-geometry.js';
import { decodeGrid } from './terrain-cph.js';
import { tilesForLocalBbox } from './tile-grid.js';

export const TILES_URL = './data/tiles';
export const TILE_VERSION = 'cph-tiles/1';

// ------------------------------------------------------------------------------------------------------ assemblers

function listAssembler(keys) {
  const parts = new Map(keys.map((k) => [k, []]));
  return {
    addTile(payload) {
      for (const k of keys) {
        const items = payload?.[k];
        if (!items?.length) continue;
        const ord = payload.ord?.[k];
        const dst = parts.get(k);
        for (let i = 0; i < items.length; i++) dst.push([ord ? ord[i] : dst.length, items[i]]);
      }
    },
    list(k) {
      return parts.get(k).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    }
  };
}

function mapAssembler(key) {
  const out = {};
  return {
    addTile(payload) {
      Object.assign(out, payload?.[key]);
    },
    map: out
  };
}

/** cph-geodata/1 from the city meta, the road graph and the `buildings` and `roads` tile layers. */
export function createGeodataAssembler(meta, roadGraph) {
  const keys = ['buildings', 'roads', 'cycleTracks', 'sidewalks', 'water', 'parks'];
  const pointKeys = meta.geodata.points_keys || [];
  const a = listAssembler([...keys, ...pointKeys.map((k) => `points.${k}`)]);
  return {
    addTile: (layer, payload) => { if (layer === 'buildings' || layer === 'roads') a.addTile(payload); },
    doc() {
      const { points_keys: _pk, ...rest } = meta.geodata;
      const doc = { ...rest };
      for (const k of keys) doc[k] = a.list(k);
      doc.points = Object.fromEntries(pointKeys.map((k) => [k, a.list(`points.${k}`)]));
      doc.roadGraph = roadGraph;
      return doc;
    }
  };
}

export function createSurfacesAssembler(meta) {
  const a = listAssembler(['surfaces', 'markings']);
  return { addTile: (p) => a.addTile(p), doc: () => (meta.surfaces ? { ...meta.surfaces, surfaces: a.list('surfaces'), markings: a.list('markings') } : null) };
}

export function createFurnitureAssembler(meta) {
  const m = meta.furniture;
  const keys = m?.list_keys || [];
  const a = listAssembler(keys);
  return {
    addTile: (p) => a.addTile(p),
    doc() {
      if (!m) return null;
      const { list_keys: _lk, ...rest } = m;
      return { ...rest, ...Object.fromEntries(keys.map((k) => [k, a.list(k)])) };
    }
  };
}

export function createVegetationAssembler(meta) {
  const a = listAssembler(['surfaces', 'canopy']);
  return { addTile: (p) => a.addTile(p), doc: () => (meta.vegetation ? { ...meta.vegetation, surfaces: a.list('surfaces'), canopy: a.list('canopy') } : null) };
}

export function createEntrancesAssembler(meta) {
  const a = listAssembler(['entrances']);
  const sw = mapAssembler('stairwells');
  return {
    addTile: (p) => { a.addTile(p); sw.addTile(p); },
    doc() {
      if (!meta.entrances) return null;
      const { stairwells, ...rest } = meta.entrances;
      return { ...rest, entrances: a.list('entrances'), stairwells: { ...stairwells, ...sw.map } };
    }
  };
}

export function createVenuesAssembler() {
  const a = listAssembler(['venues']);
  return { addTile: (p) => a.addTile(p), venues: () => a.list('venues') };
}

/**
 * cph-terrain/1 with `grid` (Float32Array metres, row = z, col = x) instead of the base64 `data`: the chunks are pasted
 * where they belong. Cells of tiles that were not added stay 0.
 */
export function createTerrainAssembler(meta) {
  const t = meta.terrain;
  const bl = mapAssembler('buildings');
  const grid = t ? new Float32Array(t.width * t.height) : null;
  return {
    addTile(p) {
      bl.addTile(p);
      const c = p?.chunk;
      if (!c || !t) return;
      const src = decodeGrid(c.data, c.w * c.h);
      const c0 = Math.round((c.x0 - t.bbox[0]) / c.cell);
      const r0 = Math.round((c.z0 - t.bbox[1]) / c.cell);
      for (let r = 0; r < c.h; r++) grid.set(src.subarray(r * c.w, (r + 1) * c.w), (r0 + r) * t.width + c0);
    },
    doc: () => (t ? { ...t, buildings: bl.map, grid } : null)
  };
}

/**
 * The loadLod2() interface over per-tile records: { index, prefetch, ready(id), get(id), entry(id) }.
 * `fetchBin(tileId)` resolves to the tile's lod2.bin ArrayBuffer (or null); records are fetched when first asked for.
 */
export function createTileLod2(meta, fetchBin) {
  const index = { ...meta.lod2, buildings: {} };
  const owner = new Map();
  const bins = new Map();
  const records = new Map();
  const bin = (tid) => {
    if (!bins.has(tid)) bins.set(tid, Promise.resolve(fetchBin(tid)).catch(() => null));
    return bins.get(tid);
  };
  async function ready(id) {
    const e = index.buildings[id];
    if (!e || e.conf !== 'measured' || e.offset === undefined) return null;
    if (records.has(id)) return records.get(id);
    const buf = await bin(owner.get(id));
    const rec = buf && e.offset + e.length <= buf.byteLength ? parseLod2Record(buf, e.offset, e.length) : null;
    records.set(id, rec);
    return rec;
  }
  return {
    index,
    addTile(tid, payload) {
      for (const [id, e] of Object.entries(payload?.buildings || {})) { index.buildings[id] = e; owner.set(id, tid); }
    },
    prefetch: async () => {},
    ready,
    get: (id) => records.get(id) || null,
    entry: (id) => index.buildings[id] || null,
    drop(tid) {
      for (const [id, t] of owner) if (t === tid) { owner.delete(id); delete index.buildings[id]; records.delete(id); }
      bins.delete(tid);
    }
  };
}

// ------------------------------------------------------------------------------------------------------------ store

/**
 * Opens data/tiles/index.json. Null when absent or not cph-tiles/1: the engine then loads the monolithic files.
 * @returns {Promise<null | { index, ids: string[], tilesForLocalBbox, loadCity, loadTiles, loadArea }>}
 */
export async function openTileStore({ baseUrl = TILES_URL, fetchImpl = globalThis.fetch } = {}) {
  let index;
  try {
    const response = await fetchImpl(`${baseUrl}/index.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    index = await response.json();
  } catch (error) {
    console.info('[cph] no tile index:', error?.message || error);
    return null;
  }
  if (index?.version !== TILE_VERSION || !index.tiles) return null;

  const json = async (url, signal) => {
    const r = await fetchImpl(url, { cache: 'no-cache', ...(signal ? { signal } : {}) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  };
  const cityUrl = (rel) => `${baseUrl}/${rel}`;

  let cityPromise = null;
  const loadCity = () => {
    cityPromise ||= (async () => {
      const [meta, roadGraph, streets, lakes] = await Promise.all([
        json(cityUrl(index.city.meta)), json(cityUrl(index.city.roadgraph)),
        index.city.streets ? json(cityUrl(index.city.streets)).catch(() => null) : null,
        index.city.lakes ? json(cityUrl(index.city.lakes)).catch(() => null) : null
      ]);
      return { meta, roadGraph, streets, lakes };
    })();
    return cityPromise;
  };

  const cache = new Map(); // tile id -> Promise<{ [layer]: payload }>
  const loadTile = (tid) => {
    if (!cache.has(tid)) {
      const names = Object.keys(index.tiles[tid]?.layers || {}).filter((n) => !n.endsWith('.bin'));
      cache.set(tid, Promise.all(names.map(async (n) => [n, await json(`${baseUrl}/${tid}/${n}.json`)])).then(Object.fromEntries));
    }
    return cache.get(tid);
  };
  const fetchBin = async (tid) => {
    if (!index.tiles[tid]?.layers?.['lod2.bin']) return null;
    const r = await fetchImpl(`${baseUrl}/${tid}/lod2.bin`);
    return r.ok ? r.arrayBuffer() : null;
  };
  // The streamer (js/tile-streamer.js) keeps the payloads itself: one layer per request, abortable, never cached here.
  const hasLayer = (tid, name) => !!index.tiles[tid]?.layers?.[name];
  const fetchLayer = (tid, name, signal) => (hasLayer(tid, name) ? json(`${baseUrl}/${tid}/${name}.json`, signal) : Promise.resolve(null));
  const layerBytes = (tid, name) => index.tiles[tid]?.layers?.[name] || 0;

  const ids = Object.keys(index.tiles).sort();
  return {
    index,
    ids,
    tilesForLocalBbox: (bbox, margin = 0) => tilesForLocalBbox(bbox, margin).filter((id) => index.tiles[id]),
    loadCity,
    loadTile,
    fetchBin,
    hasLayer,
    fetchLayer,
    layerBytes,
    /** Loads every tile touching a local bbox [xmin, zmin, xmax, zmax] (+ margin m) and assembles the layer documents. */
    async loadArea(bbox, margin = 25) {
      const tileIds = this.tilesForLocalBbox(bbox, margin);
      const [city, loaded] = await Promise.all([loadCity(), Promise.all(tileIds.map(async (id) => [id, await loadTile(id)]))]);
      const set = assembleArea(city, loaded, fetchBin);
      for (const id of tileIds) cache.delete(id); // the assembled documents own the data now; C2 will manage tile lifetimes
      return set;
    }
  };
}

/** city = { meta, roadGraph, streets, lakes }; loaded = [[tileId, { layer: payload }]]. */
export function assembleArea(city, loaded, fetchBin = async () => null) {
  const geo = createGeodataAssembler(city.meta, city.roadGraph);
  const surfaces = createSurfacesAssembler(city.meta);
  const furniture = createFurnitureAssembler(city.meta);
  const vegetation = createVegetationAssembler(city.meta);
  const entrances = createEntrancesAssembler(city.meta);
  const venues = createVenuesAssembler();
  const terrain = createTerrainAssembler(city.meta);
  const lod2 = city.meta.lod2 ? createTileLod2(city.meta, fetchBin) : null;
  for (const [tid, layers] of loaded) {
    geo.addTile('buildings', layers.buildings);
    geo.addTile('roads', layers.roads);
    surfaces.addTile(layers.surfaces);
    furniture.addTile(layers.furniture);
    vegetation.addTile(layers.vegetation);
    entrances.addTile(layers.entrances);
    venues.addTile(layers.groundfloor);
    terrain.addTile(layers.terrain);
    lod2?.addTile(tid, layers.lod2);
  }
  return {
    tiles: loaded.map(([id]) => id),
    geo: geo.doc(),
    surfaces: surfaces.doc(),
    furniture: furniture.doc(),
    vegetation: vegetation.doc(),
    entrances: entrances.doc(),
    venues: venues.venues(),
    terrain: terrain.doc(),
    streets: city.streets,
    lakes: city.lakes,
    lod2
  };
}
