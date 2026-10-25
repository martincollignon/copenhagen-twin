// js/layout-cph.js
// Applies the compiled layout documents to a loaded cph-geodata set, once, before any layer is built, so that every
// layer (buildings, roads, pavements, lakes, furniture, cars) reads the SAME geometry and the SAME ground (pure,
// headless-testable; also used by tools/audit/dump_layout.mjs so the audit measures what the engine builds).

/**
 * Buildings stand on the terrain: `ground` becomes the measured terrain height along the outline
 * (data/cph-terrain.json `buildings`, tools/cph-geodata/terrain.py). `eave` and `ridge` are absolute heights (DSM) and are
 * left alone, so the walls and roofs keep their real tops.
 * @returns {number} buildings changed
 */
export function applyTerrainGround(geo, terrain) {
  const ground = terrain && !terrain.flat ? terrain.doc?.buildings : null;
  if (!ground) return 0;
  let n = 0;
  for (const b of geo?.buildings || []) {
    const g = ground[b.id];
    if (g === undefined || g === b.ground) continue;
    b.groundSurvey = b.ground; // the old per-footprint DTM median, kept for reference
    b.ground = g;
    n++;
  }
  return n;
}
