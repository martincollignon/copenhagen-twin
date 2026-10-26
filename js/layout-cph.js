// js/layout-cph.js
// Applies the compiled layout documents to a loaded cph-geodata set, once, before any layer is built, so that every
// layer (buildings, roads, pavements, lakes, furniture, cars) reads the SAME geometry and the SAME ground (pure,
// headless-testable; also used by tools/audit/dump_layout.mjs so the audit measures what the engine builds).

/**
 * Buildings stand on the terrain: `ground` becomes the measured terrain height along the outline
 * (data/cph-terrain.json `buildings`, tools/cph-geodata/terrain.py). A surveyed building's `eave` and `ridge` are absolute heights
 * (DSM) and are left alone, so its walls and roof keep their real tops; an unsurveyed one keeps its HEIGHT (see below).
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
    // A building with a MEASURED ground (DTM median) has an absolute DSM eave and ridge: they stay. One without a survey
    // (conf_fields.ground 'inferred': a default ground of 0, most are small outbuildings) only has a height: its eave and ridge
    // move with the ground so the building keeps that height.
    if (b.conf_fields?.ground === 'inferred') {
      const dh = g - b.ground;
      if (Number.isFinite(b.eave)) b.eave += dh;
      if (Number.isFinite(b.ridge)) b.ridge += dh;
    }
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
  // footprint errors resolved by source precedence (tools/cph-geodata/streets.py resolve_buildings): drops (a shed inside the main
  // building, a duplicate, a house in the lake) and clips (the older footprint loses the overlap). A clipped footprint keeps its
  // id and attributes; extra pieces become copies `id#k`.
  if (doc.buildings && geo.buildings) {
    const drop = new Set((doc.buildings.drop || []).map((d) => d.id));
    const clip = new Map((doc.buildings.clip || []).map((c) => [c.id, c]));
    const next = [];
    stats.buildingsDropped = 0;
    stats.buildingsClipped = 0;
    for (const b of geo.buildings) {
      if (drop.has(b.id)) { stats.buildingsDropped++; continue; }
      const c = clip.get(b.id);
      if (!c) { next.push(b); continue; }
      stats.buildingsClipped++;
      c.pieces.forEach((piece, k) => {
        const nb = { ...b, id: k === 0 ? b.id : `${b.id}#${k}`, ring: piece.ring, holes: piece.holes || [], footprintFix: c.reason, ringSurvey: b.ring };
        next.push(nb);
      });
    }
    geo.buildings = next;
  }
  if (doc.surfaceCuts) geo.surfaceCuts = doc.surfaceCuts;
  if (doc.sidewalks) { geo.sidewalksSurvey = geo.sidewalks; geo.sidewalks = doc.sidewalks; stats.sidewalks = doc.sidewalks.length; }
  if (doc.cycleTracks) { geo.cycleTracksSurvey = geo.cycleTracks; geo.cycleTracks = doc.cycleTracks; stats.cycleTracks = doc.cycleTracks.length; }
  return stats;
}

/**
 * Ground-surface cuts of two sources (the lake document's and the street layout's) as one list; where both cut the same polygon the
 * street layout's wins (it already subtracts the water, and keeps the polygon's holes).
 */
export function mergeSurfaceCuts(...lists) {
  const byId = new Map();
  for (const list of lists) for (const c of list || []) byId.set(c.id, c);
  return [...byId.values()];
}
