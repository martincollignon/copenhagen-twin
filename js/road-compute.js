// js/road-compute.js
// The CPU half of a streamed tile's road surfaces (js/road-surfaces-cph.js createRoadSurfaceLayer): the carriageway, kerb, cycle,
// paint, pavement and register-ground meshes as typed arrays, and the 0.5 m ground-height grid. Pure: runs in a Web Worker
// (js/tile-worker.js) or on the main thread. The job carries what the build reads (the roads, pavements and cycle tracks of the tile
// and its neighbours, the footprints, the surface register, the terrain chunks around) and which items the tile owns, as indices:
// object identity does not survive the trip to a worker (js/tile-own.js `own` sets).

import { computeSurfaceMeshes, buildGroundHeightGrid } from './road-surfaces-cph.js';
import { createChunkSampler } from './terrain-cph.js';

const HEIGHT_MARGIN = 20;
const DROP = new Set(['src', 'ptsSurvey', 'conf_fields', 'conf']);
const slimRecord = (o) => {
  const out = {};
  for (const k of Object.keys(o)) if (!DROP.has(k)) out[k] = o[k];
  return out;
};
const indicesOf = (list, set) => {
  const out = [];
  if (set) list.forEach((it, i) => { if (set.has(it)) out.push(i); });
  return out;
};

/**
 * The job of a tile build (main thread). `ctx` = a tile context (js/tile-data.js), `terrain` = the stream terrain (chunkOf).
 */
export function makeRoadJob(ctx, { near, terrain }) {
  const g = ctx.geo;
  const own = g.own || {};
  const sf = near ? ctx.surfaces : null;
  const chunks = [];
  if (terrain && !terrain.flat && terrain.chunkOf) for (const id of ctx.neighbours) { const c = terrain.chunkOf(id); if (c) chunks.push([id, c]); }
  return {
    near, bounds: ctx.bounds,
    geo: {
      roads: g.roads.map(slimRecord), sidewalks: g.sidewalks, cycleTracks: g.cycleTracks,
      buildings: (g.buildings || []).map((b) => ({ id: b.id, ring: b.ring, holes: b.holes }))
    },
    own: { roads: indicesOf(g.roads, own.roads), sidewalks: indicesOf(g.sidewalks, own.sidewalks), cycleTracks: indicesOf(g.cycleTracks, own.cycleTracks) },
    surfaces: sf ? { ...sf, own: undefined, surfaces: sf.surfaces, markings: sf.markings } : null,
    surfacesOwn: sf?.own ? { surfaces: indicesOf(sf.surfaces, sf.own.surfaces), markings: indicesOf(sf.markings, sf.own.markings) } : null,
    terrain: chunks.length ? { header: { width: terrain.header.width, height: terrain.header.height, cell: terrain.header.cell, bbox: terrain.header.bbox }, chunks } : null
  };
}

/** @returns {{ meshes: object[], heightGrid: { bbox, cell, data }|null }} */
export function computeRoadSurfaces(job) {
  const { geo: g, surfaces: sf, own: o, surfacesOwn, near, bounds } = job;
  let terrain = null;
  if (job.terrain) {
    const sampler = createChunkSampler(job.terrain.header);
    for (const [id, c] of job.terrain.chunks) sampler.set(id, c);
    terrain = { flat: false, heightAt: sampler.heightAt };
  }
  const geo = { roads: g.roads, sidewalks: g.sidewalks, cycleTracks: g.cycleTracks, buildings: g.buildings };
  geo.own = { roads: new Set(o.roads.map((i) => g.roads[i])), sidewalks: new Set(o.sidewalks.map((i) => g.sidewalks[i])), cycleTracks: new Set(o.cycleTracks.map((i) => g.cycleTracks[i])) };
  let surfaces = null;
  if (sf) {
    surfaces = { ...sf };
    if (surfacesOwn) surfaces.own = { surfaces: new Set(surfacesOwn.surfaces.map((i) => sf.surfaces[i])), markings: new Set(surfacesOwn.markings.map((i) => sf.markings[i])) };
  }
  const meshes = computeSurfaceMeshes(geo, near ? surfaces : null, terrain, { lite: !near });
  let heightGrid = null;
  if (near && bounds) {
    const grid = buildGroundHeightGrid(geo, surfaces, [bounds[0] - HEIGHT_MARGIN, bounds[1] - HEIGHT_MARGIN, bounds[2] + HEIGHT_MARGIN, bounds[3] + HEIGHT_MARGIN]);
    if (grid) heightGrid = { bbox: grid.bbox, cell: grid.cell, data: grid.data };
  }
  return { meshes, heightGrid };
}
