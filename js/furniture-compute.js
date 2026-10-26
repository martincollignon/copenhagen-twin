// js/furniture-compute.js
// The CPU half of a streamed tile's street furniture: the spatial constraint map (js/zones-cph.js: footprints, water, carriageways,
// cycle strips, pavements on a 0.5 m raster over the tile and a margin) and the placement of the tile's items against it
// (js/placement-cph.js). Pure: runs in a Web Worker (js/tile-worker.js) or on the main thread. What comes back is the placed furniture
// document (the layers then build their instances from it) and the placement report.

import { createZoneMap } from './zones-cph.js';
import { placeFurniture } from './placement-cph.js';

const inBox = (ring, [x0, z0, x1, z1]) => {
  let a = Infinity; let b = Infinity; let c = -Infinity; let d = -Infinity;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    if (ring[i] < a) a = ring[i];
    if (ring[i] > c) c = ring[i];
    if (ring[i + 1] < b) b = ring[i + 1];
    if (ring[i + 1] > d) d = ring[i + 1];
  }
  return !(c < x0 || a > x1 || d < z0 || b > z1);
};

/** The job of a tile (main thread): `ctx` = tile context, `doc` = the tile's furniture document, `water` = every lake / pond / bridge strip. */
export function makeFurnitureJob(ctx, { doc, water, margin = 30 }) {
  const bbox = [ctx.bounds[0] - margin, ctx.bounds[1] - margin, ctx.bounds[2] + margin, ctx.bounds[3] + margin];
  const g = ctx.geo;
  const near = (list) => (list || []).filter((l) => l.ring && inBox(l.ring, bbox));
  return {
    bbox, doc,
    geo: { roads: g.roads, sidewalks: g.sidewalks, cycleTracks: g.cycleTracks, buildings: (g.buildings || []).map((b) => ({ id: b.id, ring: b.ring, holes: b.holes })) },
    surfaces: ctx.surfaces,
    lakes: water ? { ...water, lakes: near(water.lakes), ponds: near(water.ponds), bridges: near(water.bridges) } : null
  };
}

/** @returns {{ doc: object, report: object }} the furniture placed against the street layout */
export function computeFurniturePlacement(job) {
  const zones = createZoneMap({ geo: job.geo, lakes: job.lakes, surfaces: job.surfaces, bbox: job.bbox });
  return placeFurniture(job.doc, { zones, geo: job.geo });
}
