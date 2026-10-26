// js/tile-data.js
// The data side of tile streaming (pure: no three.js, no fetch; runs in node). It holds the layer payloads the streamer has
// fetched, applies the compiled layouts (street cross-sections, building footprint fixes, terrain ground, surface cuts) the
// same way the district build does, and assembles for a tile the CONTEXT its layers are built from: the items the tile owns
// plus the items of the tiles around it (a junction, a kerb, a party wall or a placement zone reaches over a tile edge).
//
//   createCityGeo(...)     boot: the road layer of every tile assembled once, streets applied, bucketed by tile. The agent
//                          systems (traffic, cyclists, pedestrians) and the ground shader read this whole-city document.
//   createTileData(...)    the per-tile layer store with prepared (layout-applied) views and tileContext(id, ring)

import { createGeodataAssembler, createFurnitureAssembler, createSurfacesAssembler, createVegetationAssembler, createEntrancesAssembler, createVenuesAssembler } from './tile-store.js';
import { applyStreets, applyTerrainGround, mergeSurfaceCuts } from './layout-cph.js';
import { applySurfaceCuts } from './lakes-cph.js';
import { tileOfLocal, tileBoundsLocal } from './tile-grid.js';
import { neighbourIds } from './tile-rings.js';

const bboxCentre = (flat) => {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] < x0) x0 = flat[i];
    if (flat[i] > x1) x1 = flat[i];
    if (flat[i + 1] < z0) z0 = flat[i + 1];
    if (flat[i + 1] > z1) z1 = flat[i + 1];
  }
  return [(x0 + x1) / 2, (z0 + z1) / 2];
};

/** Tile that owns a polyline / ring (centre of its bbox, as tile_split.py owns them). */
export const ownerOfFlat = (flat) => (flat?.length >= 2 ? tileOfLocal(...bboxCentre(flat)) : null);

/**
 * The whole-city road document. `roadPayloads` = [[tileId, roads layer payload]]; `streets` = data/city/streets.json (or null).
 * Mutates the assembled roads like the district build does (applyStreets), then buckets roads, pavements and cycle tracks by
 * the tile their centre lies in. Returns { geo, roadsByTile: Map(id -> { roads, sidewalks, cycleTracks }), stats }.
 */
export function createCityGeo(meta, roadGraph, roadPayloads, streets = null) {
  const asm = createGeodataAssembler(meta, roadGraph);
  for (const [, payload] of roadPayloads) asm.addTile('roads', payload);
  const geo = asm.doc();
  const stats = streets ? applyStreets(geo, streets) : null;
  const roadsByTile = new Map();
  const bucket = (key) => {
    for (const item of geo[key] || []) {
      const tid = ownerOfFlat(item.pts || item.ring);
      if (!tid) continue;
      let t = roadsByTile.get(tid);
      if (!t) roadsByTile.set(tid, (t = { roads: [], sidewalks: [], cycleTracks: [] }));
      t[key].push(item);
    }
  };
  for (const key of ['roads', 'sidewalks', 'cycleTracks']) bucket(key);
  return { geo, roadsByTile, stats };
}

/** The footprint fixes of the street layout (drops and clips) that concern the given building ids. */
function fixesFor(streets, ids) {
  const b = streets?.buildings;
  if (!b) return null;
  return { drop: (b.drop || []).filter((d) => ids.has(d.id)), clip: (b.clip || []).filter((c) => ids.has(c.id)) };
}

/**
 * @param {{ index: object, meta: object, streets?: object|null, lakes?: object|null, geo: object, roadsByTile: Map, terrain: object, lod2?: object|null }} city
 */
export function createTileData({ index, meta, streets = null, lakes = null, geo, roadsByTile, terrain, lod2 = null }) {
  const exists = (id) => !!index.tiles[id];
  const entries = new Map(); // id -> { layers: Map(name -> payload), memo: {} }
  const cuts = mergeSurfaceCuts(lakes?.surface_cuts, geo.surfaceCuts);
  const entry = (id) => {
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { layers: new Map(), memo: {} }));
    return e;
  };
  const roadsOf = (id) => roadsByTile.get(id) || { roads: [], sidewalks: [], cycleTracks: [] };

  const api = {
    entries,
    has: (id, layer) => !!entries.get(id)?.layers.has(layer),
    layersOf: (id) => [...(entries.get(id)?.layers.keys() || [])],
    held: () => [...entries.keys()],

    /** Stores a fetched layer (null = the tile has none). Feeds the terrain and the LoD2 index right away. */
    setLayer(id, name, payload, { pin = false } = {}) {
      const e = entry(id);
      e.layers.set(name, payload);
      e.memo = {}; // every prepared view may depend on the new layer
      if (name === 'terrain' && payload) terrain.addTile?.(payload, { pin });
      if (name === 'lod2' && payload) lod2?.addTile(id, payload);
    },

    /** Drops a layer (and, when it was the last, the tile). The terrain chunk of a pinned tile stays. */
    dropLayer(id, name) {
      const e = entries.get(id);
      if (!e?.layers.has(name)) return;
      const payload = e.layers.get(name);
      e.layers.delete(name);
      e.memo = {};
      if (name === 'terrain') terrain.removeTile?.(id, Object.keys(payload?.buildings || {}));
      if (name === 'lod2') lod2?.drop(id);
      if (!e.layers.size) entries.delete(id);
    },
    dropTile(id) {
      for (const name of api.layersOf(id)) api.dropLayer(id, name);
      entries.delete(id);
    },

    /** The tile's buildings with the layouts applied (footprint fixes, terrain ground), in source order. */
    buildings(id) {
      const e = entries.get(id);
      if (!e?.layers.has('buildings')) return [];
      return (e.memo.buildings ||= (() => {
        const p = e.layers.get('buildings');
        const list = p?.buildings ? [...p.buildings] : [];
        const mini = { buildings: list, roads: [] };
        if (streets) applyStreets(mini, { roads: {}, buildings: fixesFor(streets, new Set(list.map((b) => b.id))) });
        applyTerrainGround(mini, terrain);
        return mini.buildings;
      })());
    },

    /** Surface register of the tile: its polygons and the measured lawns, lake / street cuts applied; and its markings. */
    surfaces(id) {
      const e = entries.get(id);
      if (!e || !(e.layers.has('surfaces') || e.layers.has('vegetation'))) return { surfaces: [], markings: [] };
      return (e.memo.surfaces ||= (() => {
        const p = e.layers.get('surfaces');
        const veg = e.layers.get('vegetation');
        const own = [...(p?.surfaces || []), ...(veg?.surfaces || [])];
        const ids = new Set(own.map((s) => s.id));
        const tileCuts = cuts.length ? cuts.filter((c) => ids.has(c.id)) : [];
        return { surfaces: applySurfaceCuts({ surfaces: own }, tileCuts).surfaces, markings: p?.markings || [] };
      })());
    },

    /** Lawn polygons (uncut: the grass reads them as they are measured). */
    lawns: (id) => entries.get(id)?.layers.get('vegetation')?.surfaces || [],

    /**
     * The build context of a tile: `geo` (the tile and its neighbours' buildings, roads, pavements, cycle tracks; `own` marks
     * what the tile emits), `surfaces`, `furniture`, `lawns`, `entrances`, `venues`, `heroes`. Getters are lazy: a mid tile
     * never touches the near-only layers.
     */
    tileContext(id, ring) {
      const around = [id, ...neighbourIds(id, exists)];
      const ownRoads = roadsOf(id);
      const ownBuildings = api.buildings(id);
      const cat = (fn) => around.flatMap(fn);
      const ctxGeo = {
        ...geo,
        buildings: cat((t) => api.buildings(t)),
        roads: cat((t) => roadsOf(t).roads),
        sidewalks: cat((t) => roadsOf(t).sidewalks),
        cycleTracks: cat((t) => roadsOf(t).cycleTracks),
        own: { roads: new Set(ownRoads.roads), sidewalks: new Set(ownRoads.sidewalks), cycleTracks: new Set(ownRoads.cycleTracks) }
      };
      const ids = new Set(ownBuildings.map((b) => b.id));
      const heroes = (geo.heroes || []).filter((h) => ids.has(h.building_id));
      let surfaces = null;
      return {
        id,
        ring,
        bounds: tileBoundsLocal(id),
        neighbours: around,
        geo: ctxGeo,
        ownBuildings,
        heroes,
        /** What buildings-real builds: the owned buildings with the tile's heroes. */
        get buildingGeo() { return { ...geo, buildings: ownBuildings, roads: ctxGeo.roads, heroes }; },
        get surfaces() {
          if (surfaces) return surfaces;
          const own = api.surfaces(id);
          const doc = { ...(meta.surfaces || {}), surfaces: cat((t) => api.surfaces(t).surfaces), markings: cat((t) => api.surfaces(t).markings) };
          doc.own = { surfaces: new Set(own.surfaces), markings: new Set(own.markings) };
          return (surfaces = doc);
        },
        get lawns() { return cat((t) => api.lawns(t)); },
        get furniture() {
          const asm = createFurnitureAssembler(meta);
          asm.addTile(entries.get(id)?.layers.get('furniture'));
          return asm.doc();
        },
        get entrances() {
          const asm = createEntrancesAssembler(meta);
          asm.addTile(entries.get(id)?.layers.get('entrances'));
          return asm.doc();
        },
        get venues() {
          const asm = createVenuesAssembler();
          for (const t of around) asm.addTile(entries.get(t)?.layers.get('groundfloor'));
          return asm.venues();
        }
      };
    }
  };
  return api;
}

export { createSurfacesAssembler, createVegetationAssembler };
