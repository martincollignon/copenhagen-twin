// js/tile-data.js
// The data side of tile streaming (pure: no three.js, no fetch; runs in node). It holds the layer payloads the streamer has
// fetched, applies the compiled layouts (street cross-sections, building footprint fixes, terrain ground, surface cuts) the
// same way the district build does, and assembles for a tile the CONTEXT its layers are built from: the items the tile owns
// plus the items of the tiles around it (a junction, a kerb, a party wall or a placement zone reaches over a tile edge).
//
//   createBaseGeo(...)     the whole-city document without any tile's items: the road graph (with the street layout's node / width
//                          fixes), the frame, the point layers' keys. Roads, pavements, cycle tracks and signals come per tile.
//   createCityGeo(...)     the district-sized variant: every tile's road layer assembled at once (tests, small tile sets)
//   createTileData(...)    the per-tile layer store with prepared (layout-applied) views, roadsOf(id) (the tile's roads with the
//                          street layout applied, from its `roads` and `streets` layers) and tileContext(id, ring)

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
 * The city document the tiles hang off: `meta.geodata` plus the road graph and empty lists (what the tiles bring is held per tile).
 * `graphFix` (the street layout's node moves, link widths and dropped links, indices of THIS graph; tools/cph-geodata/tile_streets.py
 * writes it for the citywide graph) is applied to the graph here.
 */
export function createBaseGeo(meta, roadGraph, graphFix = null) {
  const asm = createGeodataAssembler(meta, roadGraph);
  const geo = asm.doc();
  const stats = graphFix ? applyStreets(geo, { version: 'cph-streets/1', roads: {}, graph: graphFix }) : null;
  return { geo, stats };
}

/**
 * The street layout's graph part for a graph it was not made for: the indices of data/city/streets.json refer to the district's
 * road graph, so a citywide graph (different numbering) must not take them. Checks a sample of the nodes against `roadGraph`.
 */
export function graphFixFits(graph, roadGraph, tolerance = 30) {
  if (!graph?.nodes?.length || !roadGraph?.nodes) return false;
  const step = Math.max(1, Math.floor(graph.nodes.length / 40));
  for (let k = 0; k < graph.nodes.length; k += step) {
    const [i, x, z] = graph.nodes[k];
    if (2 * i + 1 >= roadGraph.nodes.length || Math.hypot(roadGraph.nodes[2 * i] - x, roadGraph.nodes[2 * i + 1] - z) > tolerance) return false;
  }
  return true;
}

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
export function createTileData({ index, meta, streets = null, lakes = null, geo, roadsByTile = null, terrain, lod2 = null }) {
  const exists = (id) => !!index.tiles[id];
  const entries = new Map(); // id -> { layers: Map(name -> payload), memo: {} }
  const cuts = mergeSurfaceCuts(lakes?.surface_cuts, geo.surfaceCuts, streets?.surfaceCuts);
  // `streets` is either the whole street layout (data/city/streets.json: roads by id, pavements and cycle tracks bucketed here
  // by the tile that owns them) or absent, in which case each tile brings its own `streets` layer (tile_streets.py)
  const legacy = streets?.roads && !streets.tile ? streets : null;
  const legacyBuckets = { sidewalks: new Map(), cycleTracks: new Map() };
  let legacyExtent = null; // the area the whole street layout covers: its pavements and cycle tracks replace a tile's own only there
  if (legacy) {
    let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
    const grow = (flat) => {
      for (let i = 0; i + 1 < flat.length; i += 2) { x0 = Math.min(x0, flat[i]); x1 = Math.max(x1, flat[i]); z0 = Math.min(z0, flat[i + 1]); z1 = Math.max(z1, flat[i + 1]); }
    };
    for (const [key, field] of [['sidewalks', 'ring'], ['cycleTracks', 'pts']]) {
      for (const item of legacy[key] || []) {
        grow(item[field]);
        const tid = ownerOfFlat(item[field]);
        if (!tid) continue;
        if (!legacyBuckets[key].has(tid)) legacyBuckets[key].set(tid, []);
        legacyBuckets[key].get(tid).push(item);
      }
    }
    for (const rec of Object.values(legacy.roads || {})) grow(rec.p);
    if (Number.isFinite(x0)) legacyExtent = [x0, z0, x1, z1];
  }
  const legacyCovers = (id) => {
    if (!legacyExtent) return false;
    const b = tileBoundsLocal(id);
    return !(b[2] <= legacyExtent[0] || b[0] >= legacyExtent[2] || b[3] <= legacyExtent[1] || b[1] >= legacyExtent[3]);
  };
  const entry = (id) => {
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { layers: new Map(), memo: {} }));
    return e;
  };
  const EMPTY_ROADS = Object.freeze({ roads: [], sidewalks: [], cycleTracks: [], signals: [] });
  /** The street layout that applies to a tile: its own `streets` layer, or the legacy whole-city document restricted to it. */
  const streetsDocOf = (id, roads) => {
    const layer = entries.get(id)?.layers.get('streets');
    if (layer) return layer;
    if (!legacy) return null;
    const ids = new Set(roads.map((r) => r.id));
    return {
      roads: legacy.roads,
      extraRoads: (legacy.extraRoads || []).filter((e) => ids.has(e.base)),
      // inside the area the layout covers its pavements and cycle tracks ARE the tile's (even when it has none there)
      sidewalks: legacyCovers(id) ? legacyBuckets.sidewalks.get(id) || [] : null,
      cycleTracks: legacyCovers(id) ? legacyBuckets.cycleTracks.get(id) || [] : null
    };
  };
  const roadsOf = (id) => {
    if (roadsByTile) return roadsByTile.get(id) || EMPTY_ROADS;
    const e = entries.get(id);
    const p = e?.layers.get('roads');
    if (!p) return EMPTY_ROADS;
    return (e.memo.roads ||= (() => {
      // the tile's items with its street layout applied (the payload objects are updated in place, once per layer set)
      const mini = { roads: [...(p.roads || [])], sidewalks: [...(p.sidewalks || [])], cycleTracks: [...(p.cycleTracks || [])] };
      const doc = streetsDocOf(id, mini.roads);
      if (doc) applyStreets(mini, { roads: doc.roads || {}, extraRoads: doc.extraRoads, sidewalks: doc.sidewalks || null, cycleTracks: doc.cycleTracks || null });
      return { roads: mini.roads, sidewalks: mini.sidewalks, cycleTracks: mini.cycleTracks, signals: p['points.signals'] || [] };
    })());
  };

  const api = {
    entries,
    has: (id, layer) => !!entries.get(id)?.layers.has(layer),
    layersOf: (id) => [...(entries.get(id)?.layers.keys() || [])],
    held: () => [...entries.keys()],
    /** The tile's roads, pavements, cycle tracks (street layout applied) and signals; empty until its `roads` layer is held. */
    roadsOf,

    /** Stores a fetched layer (null = the tile has none). Feeds the terrain and the LoD2 index right away. */
    setLayer(id, name, payload, { pin = false } = {}) {
      const e = entry(id);
      e.layers.set(name, payload);
      // every prepared view may depend on the new layer (the tile's roads only on its own roads and streets layers: applying the street
      // layout twice would lose the survey centrelines)
      e.memo = name === 'roads' || name === 'streets' || !e.memo.roads ? {} : { roads: e.memo.roads };
      if (name === 'terrain' && payload) terrain.addTile?.(payload, { pin });
      if (name === 'lod2' && payload) lod2?.addTile(id, payload);
    },

    /** Drops a layer (and, when it was the last, the tile). The terrain chunk of a pinned tile stays. */
    dropLayer(id, name) {
      const e = entries.get(id);
      if (!e?.layers.has(name)) return;
      const payload = e.layers.get(name);
      e.layers.delete(name);
      e.memo = name === 'roads' || name === 'streets' || !e.memo.roads ? {} : { roads: e.memo.roads };
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
        const fixes = e.layers.get('streets')?.buildings || (streets ? fixesFor(streets, new Set(list.map((b) => b.id))) : null);
        if (fixes) applyStreets(mini, { roads: {}, buildings: fixes });
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
        const layerCuts = mergeSurfaceCuts(e.layers.get('streets')?.surfaceCuts, e.layers.get('water')?.surfaceCuts);
        const tileCuts = mergeSurfaceCuts(cuts.length ? cuts.filter((c) => ids.has(c.id)) : [], layerCuts);
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
        points: { ...geo.points, signals: cat((t) => roadsOf(t).signals) },
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
        /** The tile's `water` layer (generic water, ground cut, green ground), or null. */
        get water() { return entries.get(id)?.layers.get('water') || null; },
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
