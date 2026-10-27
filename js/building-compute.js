// js/building-compute.js
// The CPU half of building a set of buildings (one streamed tile, or the whole district): everything buildRealBuildings
// (js/buildings-real.js) does before it touches three.js. Pure (no three.js, no DOM, no fetch), so it runs on the main thread (a
// generator it can time-slice) or in a Web Worker (js/building-worker.js, which returns the typed arrays as transferables):
//
//   the quadtree partition of the buildings into cells, per cell the merged wall / roof arrays (js/building-geometry.js addBuilding),
//   the placed doors, the photo-wall candidates and the ground-floor door info per building.
//
// Input (`job`, structured-cloneable): see buildingSteps. Output: see the return value of buildingSteps.

import { Quadtree } from './quadtree.js';
import { createAccumulator, addBuilding } from './building-geometry.js';
import { createContext as createGroundContext } from './groundfloor.js';
import { createEntranceIndex } from './entrances.js';
import { setCalibration, texturedWalls } from './appearance.js';

export const LEAF_CAPACITY = 48;
// Photo walls: every building whose appearance record carries an atlas descriptor (observed.atlas, written once the citywide Skraafoto
// atlas of the building exists); the global photo budget (js/facade-lod.js) bounds how many are resident.
export const LEAF_DEPTH = 5;
const SLICE_BUILDINGS = 6; // a generator step after this many buildings, so a caller can time-slice inside a cell

export function ringCentre(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / n, z / n];
}

function collectLeaves(node, out = []) {
  if (!node.divided) {
    if (node.items.length) out.push(node);
    return out;
  }
  for (const child of [node.nw, node.ne, node.sw, node.se]) collectLeaves(child, out);
  return out;
}

const f32 = (a) => (a.length ? Float32Array.from(a) : null);

/** The accumulator's wall arrays as typed arrays (the facade frame, or the colour of a `lite` wall). */
export function wallArrays(w) {
  if (!w.index.length) return null;
  const out = { position: f32(w.position), normal: f32(w.normal), index: Uint32Array.from(w.index) };
  if (w.color) out.color = f32(w.color);
  else Object.assign(out, { facadeUV: f32(w.facadeUV), facadeWall: f32(w.facadeWall), facadeBldg: f32(w.facadeBldg), facadeTone: f32(w.facadeTone), facadeWindow: f32(w.facadeWindow), facadeTop: f32(w.facadeTop) });
  return out;
}

export function roofArrays(r) {
  if (!r.index.length) return null;
  return { position: f32(r.position), normal: f32(r.normal), color: f32(r.color), mat: f32(r.mat), index: Uint32Array.from(r.index) };
}

/** Every ArrayBuffer of a result (for postMessage's transfer list). */
export function transferablesOf(result) {
  const out = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v)) { out.add(v.buffer); return; }
    for (const k of Array.isArray(v) ? v.keys() : Object.keys(v)) walk(v[k]);
  };
  walk(result);
  return [...out];
}

/**
 * A generator: `yield` after every few buildings (the caller may await a frame in between), the result is its return value.
 * @param {object} job
 *   buildings     the buildings to build (geodata records; heroes excluded or listed in heroIds)
 *   heroIds       ids built from their glTF instead
 *   context       { buildings, roads } the neighbourhood the ground floor classification reads (default: the buildings themselves)
 *   venues        ground-floor venues (js/groundfloor.js), entrances (the entrance document, or null)
 *   lod2          Map id -> parsed LoD2 record (js/lod2-geometry.js)
 *   lows          Map id -> lowest ground under the footprint (groundLow), when the build has no terrain
 *   observed, wantQuads (photo walls), doors, lite (tone-only walls, no facade frame, no doors, no details), calibration
 * @returns {{ leaves: object[], glass: object|null, doorInfo: Array, doors: Array, texCandidates: object[], stats: object }}
 *   leaves[i] = { centre, radius, wall, roof, roofRanges, wallRanges, detailParts, doors: [{ id, ground, doors }] }
 */
export function* buildingSteps(job) {
  const { buildings = [], heroIds = [], context = null, venues = [], entrances = null, lod2 = null, lows = null, observed = true, wantQuads = false, doors: wantDoors = true, lite = false, calibration } = job;
  if (calibration !== undefined) setCalibration(calibration);
  const heroSet = new Set(heroIds);
  const lod2Records = lod2 instanceof Map ? lod2 : new Map(Object.entries(lod2 || {}));

  const items = [];
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const b of buildings) {
    if (heroSet.has(b.id) || !b.ring || b.ring.length < 6) continue;
    const [cx, cz] = ringCentre(b.ring);
    items.push({ cx, cz, b });
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); z0 = Math.min(z0, cz); z1 = Math.max(z1, cz);
  }
  if (!items.length) { x0 = z0 = -750; x1 = z1 = 750; }
  // a tone-only tile is one cell (one wall and one roof mesh): at mid range the cells exist for the draw calls, not for culling
  const tree = new Quadtree({ minX: x0 - 50, maxX: x1 + 50, minZ: z0 - 50, maxZ: z1 + 50 }, lite ? Infinity : LEAF_CAPACITY, LEAF_DEPTH);
  for (const it of items) tree.insert(it);

  // ground-floor kinds per wall: street side from the road network, party walls from neighbouring footprints, shops from venue data
  const ground = lite ? null : createGroundContext({
    roads: context?.roads || [], buildings: context?.buildings || buildings, venues: !wantDoors ? [] : venues || [],
    entrances: !wantDoors || !entrances ? null : createEntranceIndex(entrances)
  });

  const leaves = [];
  const glassAcc = createAccumulator();
  const doorInfo = [];
  const texCandidates = [];
  let triangles = 0;
  let doorCount = 0;
  let n = 0;
  for (const leaf of collectLeaves(tree)) {
    const acc = createAccumulator({ lite });
    const leafDoors = [];
    for (const { b } of leaf.items) {
      const glassy = !lite && b.wall_material === 'glas';
      const quads = !lite && wantQuads && observed && !glassy && b.observed?.atlas?.walls?.length ? [] : null;
      const low = lows ? lows.get?.(b.id) ?? lows[b.id] : undefined;
      const added = addBuilding(acc, b, {
        ...(lite ? { lite: true } : { ground }), ...(glassy ? { wallAcc: glassAcc } : {}),
        ...(lod2Records.has(b.id) ? { lod2: lod2Records.get(b.id) } : {}), ...(quads ? { quads } : {}),
        ...(observed ? {} : { observed: false }), ...(low !== undefined ? { low } : {})
      });
      if (added) triangles += added.wallTriangles + added.roofTriangles;
      if (added?.doorInfo) doorInfo.push([b.id, added.doorInfo]);
      if (wantDoors && added?.doors?.length) { leafDoors.push({ id: b.id, ground: b.ground, doors: added.doors }); doorCount += added.doors.length; }
      if (added && quads) {
        const walls = texturedWalls(b, quads, added.mapping);
        if (walls) {
          const [cx, cz] = ringCentre(b.ring);
          texCandidates.push({ id: b.id, cx, cz, walls, tone: added.mapping.buildingTone, brick: added.style.mat === 0, layout: added.layout });
        }
      }
      if (++n % SLICE_BUILDINGS === 0) yield n;
    }
    const bounds = leaf.bounds;
    leaves.push({
      centre: [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2],
      radius: Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2,
      wall: wallArrays(acc.wall), wallRanges: acc.wallRanges.filter((r) => r.end > r.start),
      roof: roofArrays(acc.roof), roofRanges: acc.roofRanges.filter((r) => r.end > r.start), detailParts: acc.detailParts,
      doors: leafDoors
    });
    yield n;
  }
  return {
    leaves,
    glass: glassAcc.wall.index.length ? { wall: wallArrays(glassAcc.wall), wallRanges: glassAcc.wallRanges.filter((r) => r.end > r.start) } : null,
    doorInfo, texCandidates,
    stats: { triangles, doors: doorCount, buildings: n }
  };
}

/** Runs buildingSteps to the end. */
export function computeBuildings(job) {
  const gen = buildingSteps(job);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}
