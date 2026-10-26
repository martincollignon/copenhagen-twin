// Dumps the runtime layout the engine derives from the data files, using the engine's own pure modules:
// carriageway half-widths (road-width-cph.js), cycle-track sides, the ground-height field (road-surfaces-cph.js), the
// placed street-furniture plan (street-furniture-data.js: parked cars, lamps with wire spans, props, trees) and a few
// height-profile probes. Output: JSON consumed by tools/audit/audit.py.
// Usage: node tools/audit/dump_layout.mjs [out.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as widthMod from '../../js/road-width-cph.js';
import { vehicularRoads, buildGroundHeightField, cycleTrackIndex, buildRoadSurfaceArrays } from '../../js/road-surfaces-cph.js';

const { carriagewayWidth } = widthMod;
import { buildFurniturePlan } from '../../js/street-furniture-data.js';

// The terrain / layout modules are optional so this dump can also measure an older engine (the "before" numbers).
const optional = (p) => import(p).catch(() => null);
const terrainMod = await optional('../../js/terrain-cph.js');
const layoutMod = await optional('../../js/layout-cph.js');
const zonesMod = await optional('../../js/zones-cph.js');
const placeMod = await optional('../../js/placement-cph.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2] || resolve(root, 'tools/audit/out/layout.json');
const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const geo = read('data/cph-geodata.json');
const surfaces = read('data/cph-surfaces.json');
const furniture = read('data/cph-furniture.json');

const VEH = new Set(['primary', 'secondary', 'residential', 'service']);
const cycleSides = (r) => ({ left: r.cycleTrack === 'left' || r.cycleTrack === 'both', right: r.cycleTrack === 'right' || r.cycleTrack === 'both' });

let streetsDoc = null;
try { streetsDoc = layoutMod?.applyStreets ? read('data/cph-streets.json') : null; } catch { streetsDoc = null; }
if (streetsDoc) layoutMod.applyStreets(geo, streetsDoc);
// the raised cycle strips as the engine reads them: [{ side, w, ranges }] (or the OSM tag in an older engine)
const stripsOf = (r) => (widthMod.cycleStrips ? widthMod.cycleStrips(r) : [
  ...(cycleSides(r).left ? [{ side: -1, w: 2.2, ranges: null }] : []), ...(cycleSides(r).right ? [{ side: 1, w: 2.2, ranges: null }] : [])]);

const terrainDoc = terrainMod ? (() => { try { return read('data/cph-terrain.json'); } catch { return null; } })() : null;
const terrain = terrainMod && terrainDoc ? terrainMod.createTerrain(terrainDoc) : null;
if (terrain && layoutMod) layoutMod.applyTerrainGround(geo, terrain);
const t0 = Date.now();
const ground = buildGroundHeightField(geo, surfaces, terrain);
console.error('ground field', Date.now() - t0, 'ms');

const roads = [];
for (const r of geo.roads) {
  if (!r.pts || r.pts.length < 4) continue;
  const veh = VEH.has(r.class);
  roads.push({
    id: r.id, name: r.name, cls: r.class, pts: r.pts, veh, width: r.width, lanesFwd: r.lanesFwd, lanesBack: r.lanesBack,
    oneway: !!r.oneway, cycleTrack: r.cycleTrack, half: veh ? carriagewayWidth(r) / 2 : 0, cycle: cycleSides(r),
    strips: veh ? stripsOf(r) : [], drop: !!r.drop, prov: r.cs?.prov ?? null,
    // the strip the simulated traffic sweeps: lane pitch 3 m, two-way lanes start 1.5 m off the centre, a car is 1.9 m wide
    moving: veh ? (widthMod.movingHalfWidth ? widthMod.movingHalfWidth(r) : Math.min(Math.max(1, (r.lanesFwd ?? 1) + (r.oneway ? 0 : (r.lanesBack ?? 1))) * 3.0, carriagewayWidth(r)) / 2) : 0
  });
}

// lake walls: height of the wall top over the water at every shore vertex (js/lakes-cph.js), measured level per lake
let lakeWalls = null;
if (terrain && !terrain.flat) {
  const { buildLakeArrays } = await import('../../js/lakes-cph.js');
  const arrays = buildLakeArrays(read('data/cph-lakes.json'), { terrain });
  lakeWalls = { level: arrays.level, freeboards: arrays.freeboards.map((f) => ({ id: f.id, x: +f.x.toFixed(1), z: +f.z.toFixed(1), free: +f.free.toFixed(2) })) };
}

// the placer: ONE spatial constraint map (footprints, water, carriageway, strips, pavements) places the furniture
let zones = null;
if (zonesMod && placeMod && streetsDoc) {
  const lakesDoc = read('data/cph-lakes.json');
  const { applySurfaceCuts } = await import('../../js/lakes-cph.js');
  zones = zonesMod.createZoneMap({ geo, lakes: lakesDoc, surfaces: applySurfaceCuts(surfaces, layoutMod.mergeSurfaceCuts(lakesDoc.surface_cuts, geo.surfaceCuts)) });
}
const plan = buildFurniturePlan(furniture, ground, { seed: 1, place: zones ? (d) => placeMod.placeFurniture(d, { zones, geo }) : null });
const slim = (list, keys) => list.map((i) => Object.fromEntries(keys.map((k) => [k, i[k]])));
const base = ['x', 'z', 'y', 'yaw'];
// Buildings as the engine stands them: `ground`, and the height of the street (walking surface) just outside the outline
const medianOf = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const buildingsOut = geo.buildings.map((b) => {
  const r = b.ring;
  const n = r.length / 2;
  const street = [];
  const terr = [];
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) { cx += r[2 * i] / n; cz += r[2 * i + 1] / n; }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[2 * j] - r[2 * i];
    const dz = r[2 * j + 1] - r[2 * i + 1];
    const L = Math.hypot(dx, dz);
    if (L < 1) continue;
    // a point 1.2 m out from the edge midpoint, on the side away from the centroid
    let nx = -dz / L;
    let nz = dx / L;
    const mx = (r[2 * i] + r[2 * j]) / 2;
    const mz = (r[2 * i + 1] + r[2 * j + 1]) / 2;
    if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
    street.push(ground.heightAt(mx + nx * 1.2, mz + nz * 1.2));
    terr.push(ground.terrainAt ? ground.terrainAt(mx, mz) : 0);
  }
  return { id: b.id, ring: b.ring, holes: b.holes || [], ground: b.ground, eave: b.eave, street: medianOf(street), terrain: medianOf(terr), fix: b.footprintFix || null };
});

// what the engine actually draws: the asphalt and cycle-strip triangles (x, z in centimetres), the cleaned pavement and cycle polygons
const layers = buildRoadSurfaceArrays(geo, { surfaces, pavement: true, terrain });
const tris = (layer) => {
  const a = layer.arrays();
  const o = [];
  for (let t = 0; t < a.index.length; t += 3) for (let k = 0; k < 3; k++) { const v = a.index[t + k] * 3; o.push(Math.round(a.position[v] * 100), Math.round(a.position[v + 2] * 100)); }
  return o;
};

const layout = {
  layers: { asphalt: tris(layers.asphalt), cycle: tris(layers.cycle), blue: layers.blue ? tris(layers.blue) : [] },
  sidewalks: geo.sidewalks.map((s) => ({ id: s.id, ring: s.ring, holes: s.holes || [] })),
  cycleTracks: (geo.cycleTracks || []).map((c) => ({ id: c.id, pts: c.pts, width: c.width || null })),
  placed: plan.placedDoc ? { bikeRacks: plan.placedDoc.bikeRacks, parkingBays: plan.placedDoc.parkingBays, busStops: plan.placedDoc.busStops } : null,
  placement: plan.report ? { counts: plan.report.counts, dropped: plan.report.dropped.length, moved: plan.report.moved.length } : null,
  surfaceCuts: geo.surfaceCuts || [],
  roadGraph: { nodes: geo.roadGraph.nodes, links: geo.roadGraph.links },
  streets: streetsDoc ? { version: streetsDoc.version, stats: streetsDoc.stats } : null,
  terrain: terrain && !terrain.flat ? { min: terrainDoc.min, max: terrainDoc.max, lakes: terrainDoc.lakes } : null,
  buildings: buildingsOut,
  lakeWalls,
  roads,
  plan: {
    trees: slim(plan.trees, ['x', 'z', 'y', 'genus', 'height', 'crownR']),
    lamps: plan.lamps.map((l) => ({
      x: l.x, z: l.z, y: l.y, mount: l.mount, pole: l.pole, poleH: l.poleH, lampY: l.lampY, bracket: !!l.bracket,
      wire: l.wire ? { pts: l.wire.pts, wireY: l.wire.wireY, len: l.wire.len, t: l.wire.t } : null
    })),
    cars: slim(plan.cars, [...base, 'body']),
    meters: slim(plan.meters, base), bins: slim(plan.bins, base), glass: slim(plan.glass, base), stands: slim(plan.stands, base),
    bollards: slim(plan.bollards, [...base, 'material']), benches: slim(plan.benches, [...base, 'length']),
    hoops: slim(plan.hoops, base), bikes: slim(plan.bikes, base), flags: slim(plan.flags, base),
    shelters: slim(plan.shelters, base), countdowns: slim(plan.countdowns, base), rescue: slim(plan.rescue, base),
    lakeLights: slim(plan.lakeLights, ['x', 'z', 'y']), monuments: slim(plan.monuments, ['x', 'z', 'y', 'name'])
  },
  jumps: [],
  cycleProbe: null
};

// ground height profile probes: along every carriageway centreline and at lateral offsets, step 1 m
const probes = [];
for (const r of roads) {
  if (!r.veh) continue;
  const p = r.pts;
  for (const off of [0, r.half + 0.5, -(r.half + 0.5), r.half + 3, -(r.half + 3)]) {
    let prev = null;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i];
      const dz = p[i + 3] - p[i + 1];
      const L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const nx = -dz / L;
      const nz = dx / L;
      for (let s = 0; s < L; s += 1) {
        const x = p[i] + (dx / L) * s + nx * off;
        const z = p[i + 1] + (dz / L) * s + nz * off;
        const h = ground.heightAt(x, z);
        if (prev && Math.abs(h - prev.h) > 0.15) layout.jumps.push({ road: r.id, name: r.name, off: +off.toFixed(2), x: +x.toFixed(2), z: +z.toFixed(2), dh: +(h - prev.h).toFixed(3) });
        prev = { h };
      }
    }
  }
}
layout.jumpsTotalProbes = roads.filter((r) => r.veh).length * 5;

// the engine's "is on a cycle track" test, for the point layers
const cyc = cycleTrackIndex(geo);
const onCycle = (x, z) => cyc.near(x, z);
layout.onCycle = {};
for (const [k, list] of Object.entries(layout.plan)) {
  if (k === 'lamps') continue;
  layout.onCycle[k] = list.map((i, n) => (onCycle(i.x, i.z) ? n : -1)).filter((n) => n >= 0);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(layout));
console.error('wrote', out, Object.fromEntries(Object.entries(layout.plan).map(([k, v]) => [k, v.length])), 'jumps', layout.jumps.length);
