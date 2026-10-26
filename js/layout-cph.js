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

export const STREETS_URL = './data/cph-streets.json';

/** Fetches the compiled street layout. Null when absent or unreadable: the twin then keeps the OSM centrelines and capped widths. */
export async function loadCphStreets(url = STREETS_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-streets/') ? doc : null;
  } catch (error) {
    console.info('[cph] no street layout loaded:', error?.message || error);
    return null;
  }
}

/**
 * ONE street cross-section (tools/cph-geodata/streets.py): every vehicular road is re-centred on its MEASURED carriageway
 * (a per-vertex lateral shift), gets the measured half width `cs.hw` and the cycle strips that really stand beside it
 * (`cs.cl` / `cs.cr` = [width, arc-length ranges]); gateways through buildings are dropped. The road graph follows: its
 * nodes move with the roads, its link widths are the measured carriageway widths, the links of dropped roads carry no lanes.
 * Pavements and KK cycle tracks are replaced by the cleaned set (no overlap with the carriageway, strips, buildings, water).
 * Mutates `geo`. Returns counters for the info line.
 */
export function applyStreets(geo, doc) {
  if (!doc?.roads) return null;
  const stats = { roads: 0, dropped: 0, nodes: 0, widths: 0, sidewalks: 0, cycleTracks: 0 };
  for (const r of geo.roads || []) {
    const rec = doc.roads[r.id];
    if (!rec) continue;
    r.ptsSurvey = r.pts; // the OSM centreline
    r.pts = rec.p;
    r.cs = { hw: rec.hw, prov: rec.prov, ...(rec.cl ? { cl: rec.cl } : {}), ...(rec.cr ? { cr: rec.cr } : {}) };
    if (rec.drop) { r.drop = rec.drop; stats.dropped++; }
    stats.roads++;
  }
  // the pieces of roads that were cut where they ran through a building: copies of the base road with their own cross-section
  const byId = new Map((geo.roads || []).map((r) => [r.id, r]));
  for (const e of doc.extraRoads || []) {
    const base = byId.get(e.base);
    if (!base) continue;
    geo.roads.push({ ...base, id: e.id, pts: e.p, cs: { hw: e.hw, prov: e.prov, ...(e.cl ? { cl: e.cl } : {}), ...(e.cr ? { cr: e.cr } : {}) } });
    stats.roads++;
  }
  const rg = geo.roadGraph;
  if (rg && doc.graph) {
    for (const [i, x, z] of doc.graph.nodes) { rg.nodes[2 * i] = x; rg.nodes[2 * i + 1] = z; stats.nodes++; }
    for (const [li, w] of doc.graph.widths) { rg.links[li][4] = w; stats.widths++; }
    for (const li of doc.graph.dropLinks || []) { rg.links[li][2] = 0; rg.links[li][3] = 0; }
    rg.layout = doc.version;
  }
  if (doc.sidewalks) { geo.sidewalksSurvey = geo.sidewalks; geo.sidewalks = doc.sidewalks; stats.sidewalks = doc.sidewalks.length; }
  if (doc.cycleTracks) { geo.cycleTracksSurvey = geo.cycleTracks; geo.cycleTracks = doc.cycleTracks; stats.cycleTracks = doc.cycleTracks.length; }
  return stats;
}
