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
import { dataUrl, isRemoteBase, resolveDataBase, packsWanted } from './data-config.js';
import { fetchManifest, createPackSource, createAtlasSource, setAtlasSource } from './data-packs.js';

/** The tile directory of this page: `<data base>/tiles` (js/data-config.js: `?data=` or the build default, './data' locally). */
export const tilesUrl = () => dataUrl('tiles');
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

/**
 * Merges a tile's `appearance` layer ({ buildings: { <gdk id>: { walls, roof, summary, atlas? } } }, tools/cph-geodata/appearance_city*.py) into
 * its building records as `observed` = { walls, roof, atlas? } (what js/appearance.js reads). A building that already carries an `observed`
 * block (the district's) keeps it untouched. Mutates and returns `buildings`.
 */
export function applyAppearance(buildings, payload) {
  const rec = payload?.buildings;
  if (!rec || !buildings) return buildings;
  for (const b of buildings) {
    if (b.observed) continue;
    const a = rec[b.id];
    if (!a) continue;
    const observed = { walls: a.walls || [], roof: a.roof || null };
    if (a.atlas) observed.atlas = a.atlas;
    if (a.summary) observed.summary = a.summary;
    b.observed = observed;
  }
  return buildings;
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

/** The unpacked layout: one file per layer under the tile directory (data/tiles), the city files beside it. */
export function createFileSource(baseUrl, fetchImpl = globalThis.fetch) {
  // remote data sits under a version prefix and is served with long cache headers: let the browser cache it
  const remote = isRemoteBase(baseUrl);
  return {
    kind: 'files',
    async index() {
      const response = await fetchImpl(`${baseUrl}/index.json`, { cache: 'no-cache' });
      return response.ok ? response.json() : null;
    },
    async json(rel, signal) {
      const url = `${baseUrl}/${rel}`;
      const r = await fetchImpl(url, { cache: remote ? 'default' : 'no-cache', ...(signal ? { signal } : {}) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r.json();
    },
    async bin(rel) {
      const r = await fetchImpl(`${baseUrl}/${rel}`);
      return r.ok ? r.arrayBuffer() : null;
    },
    key: (rel) => rel,
    url: (rel) => `${baseUrl}/${rel}`
  };
}

/** The packed layout (js/data-packs.js): the same paths, read out of the packs a manifest names. */
export function createPackedSource(manifest, opts) {
  const src = createPackSource(manifest, opts);
  return { kind: 'packs', ...src, index: () => src.json('index.json') };
}

/**
 * Opens the tile store. With `packs` (js/data-config.js packsWanted: any data base but the repo's own ./data) the packed layout is tried
 * first (<data base>/manifest.json); without a manifest, or with an explicit `baseUrl` (?tiles=), data/tiles/index.json is read.
 * Null when neither is there or the index is not cph-tiles/1: the engine then loads the monolithic files.
 * @returns {Promise<null | { index, ids: string[], tilesForLocalBbox, loadCity, loadTiles, loadArea }>}
 */
export async function openTileStore({ baseUrl = null, fetchImpl = globalThis.fetch, dataBase = resolveDataBase(), packs = baseUrl ? false : packsWanted() } = {}) {
  let source = null;
  if (packs) {
    const manifest = await fetchManifest(dataBase, fetchImpl);
    if (manifest) {
      const atlases = createAtlasSource({ base: dataBase, fetchImpl });
      source = createPackedSource(manifest, { base: dataBase, fetchImpl, atlases });
      setAtlasSource(atlases);
    }
  }
  source ||= createFileSource(baseUrl || dataUrl('tiles', dataBase), fetchImpl);
  let index;
  try {
    index = await source.index();
    if (!index) return null;
  } catch (error) {
    console.info('[cph] no tile index:', error?.message || error);
    return null;
  }
  if (index?.version !== TILE_VERSION || !index.tiles) return null;
  return createStore(index, source);
}

async function createStore(index, source) {
  const json = (rel, signal) => source.json(rel, signal);
  const cityDir = String(index.city?.meta || '../city/meta.json').replace(/\/[^/]*$/, '');

  // Post-process layers (data/city/post.json, written by tools/cph-geodata/far_lod.py and tile_streets.py after the tile compiler):
  //   far      { header, bin }               the far-ring block meshes (js/far-lod.js)
  //   streets  { graph, tiles: { id: bytes } }  the street layout bucketed per tile (a `streets` layer of those tiles) + the graph fix
  //   water    { header, tiles: { id: bytes } }  the generic water, ground cut and green ground per tile (a `water` layer of those tiles,
  //            tools/cph-geodata/city_water.py) + the city header (bodies, far-ring pieces, the Soerne override)
  let post = null;
  try {
    const doc = await json(`${cityDir}/post.json`);
    if (doc?.version?.startsWith('cph-post/')) post = doc;
  } catch { /* no post-process layers: the engine uses what the tile index and the city files hold */ }

  let cityPromise = null;
  const loadCity = () => {
    cityPromise ||= (async () => {
      // with a per-tile street layout the whole-city streets.json is not read at all (it is only meaningful for the tiles it covers)
      const tiled = !!post?.streets;
      const [meta, roadGraph, streets, streetsGraph, lakes, water] = await Promise.all([
        json(index.city.meta), json(index.city.roadgraph),
        !tiled && index.city.streets ? json(index.city.streets).catch(() => null) : null,
        tiled && post.streets.graph ? json(`${cityDir}/${post.streets.graph}`).catch(() => null) : null,
        index.city.lakes ? json(index.city.lakes).catch(() => null) : null,
        post?.water?.header ? json(`${cityDir}/${post.water.header}`).catch(() => null) : null
      ]);
      return { meta, roadGraph, streets, streetsGraph, lakes, water: water?.version?.startsWith('cph-water/') ? water : null };
    })();
    return cityPromise;
  };

  /** The whole street layout document (data/city/streets.json), even where the tiles carry it per tile; null when absent. */
  const loadStreets = async () => (index.city.streets ? json(index.city.streets).catch(() => null) : null);

  const cache = new Map(); // tile id -> Promise<{ [layer]: payload }>
  const loadTile = (tid) => {
    if (!cache.has(tid)) {
      const names = [...Object.keys(index.tiles[tid]?.layers || {}), ...(post?.streets?.tiles?.[tid] ? ['streets'] : []), ...(post?.water?.tiles?.[tid] ? ['water'] : []), ...(post?.appearance?.tiles?.[tid] ? ['appearance'] : [])].filter((n) => !n.endsWith('.bin'));
      cache.set(tid, Promise.all(names.map(async (n) => [n, await json(`${tid}/${n}.json`)])).then(Object.fromEntries));
    }
    return cache.get(tid);
  };
  const fetchBin = async (tid) => {
    if (!index.tiles[tid]?.layers?.['lod2.bin']) return null;
    return source.bin(`${tid}/lod2.bin`);
  };
  // The streamer (js/tile-streamer.js) keeps the payloads itself: one layer per request, abortable, never cached here.
  const layerSize = (tid, name) => index.tiles[tid]?.layers?.[name] || (name === 'streets' ? post?.streets?.tiles?.[tid] : name === 'water' ? post?.water?.tiles?.[tid] : name === 'appearance' ? post?.appearance?.tiles?.[tid] : 0) || 0;
  const hasLayer = (tid, name) => !!index.tiles[tid] && layerSize(tid, name) > 0;
  const fetchLayer = (tid, name, signal) => (hasLayer(tid, name) ? json(`${tid}/${name}.json`, signal) : Promise.resolve(null));
  /** The request a layer is served by (one per layer unpacked, one per pack packed): the streamer caps requests, not layers. */
  const requestKey = (tid, name) => source.key(`${tid}/${name}.json`);
  const layerBytes = layerSize;

  const ids = Object.keys(index.tiles).sort();
  return {
    index,
    post,
    source: source.kind,
    /** URL of a city file (unpacked layout only; packed files have no URL of their own). */
    cityUrl: (rel) => (source.url ? source.url(`${cityDir}/${rel}`) : null),
    fetchCityBin: async (rel) => { const b = await source.bin(`${cityDir}/${rel}`); if (!b) throw new Error(`HTTP 404 ${rel}`); return b; },
    fetchCityJson: (rel) => json(`${cityDir}/${rel}`),
    ids,
    tilesForLocalBbox: (bbox, margin = 0) => tilesForLocalBbox(bbox, margin).filter((id) => index.tiles[id]),
    loadCity,
    loadStreets,
    loadTile,
    fetchBin,
    hasLayer,
    fetchLayer,
    layerBytes,
    requestKey,
    /** Loads every tile touching a local bbox [xmin, zmin, xmax, zmax] (+ margin m) and assembles the layer documents. */
    async loadArea(bbox, margin = 25) {
      const tileIds = this.tilesForLocalBbox(bbox, margin);
      const [city0, loaded] = await Promise.all([loadCity(), Promise.all(tileIds.map(async (id) => [id, await loadTile(id)]))]);
      // an area document carries the whole street layout, even where the engine streams it per tile
      const city = city0.streets ? city0 : { ...city0, streets: await loadStreets() };
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
    if (layers.appearance && layers.buildings) applyAppearance(layers.buildings.buildings, layers.appearance);
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
    streetsGraph: city.streetsGraph,
    lakes: city.lakes,
    lod2
  };
}
