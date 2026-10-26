import { triangulatePolygon, pointInRing } from './polygon-cph.js';
import { densifyRing } from './terrain-cph.js';

// js/lakes-cph.js
// Pure (no three.js) geometry for the Soerne (Peblinge, Sortedams and Sankt Joergens Soe) and the other lakes of
// data/cph-lakes.json (tools/cph-geodata/lakes.py): the water sits WATER.surfaceY below the surrounding ground, held by
// vertical stone walls with a granite coping; the ground plane has the lake outline cut out of it; a shore-distance
// field drives the soft shoreline of the water shader. Flat rings are [x0, z0, x1, z1, ...] (x east, z south).

export const WATER = Object.freeze({
  surfaceY: -0.8, // water level relative to the ground (y = 0): 0.8 m below the lake walls' top
  bedY: -2.6, // lake bed (the wall foot; hidden under the opaque water)
  wallTop: 0.08, // granite coping height above the ground surface layers (0.02 gravel .. 0.2 pavement)
  copingW: 0.3, // coping ledge width beyond the wall face
  soffitY: -0.4, // underside of a bridge deck over water
  deckY: 0.02, // bridge deck (road surface layer)
  extendMinArea: 20000, // m2: only the big lakes (Soerne) are continued to the horizon
  far: 2400, // lake outlines that touch the district bbox are continued to here: the water reaches the horizon
  snap: 0.3, // m: lakes whose measured level is within this of the biggest lake share its level
  minFreeboard: 0.3, // m: the wall top never lies lower than this over the water
  shoreProbe: 2, // m: land-side probe distance for the quay height
  wallStep: 8, // m: wall / coping segments follow the terrain at this spacing
  abutmentM: 60, // m: shore within this of a bridge strip is the bridge approach / abutment: a quay there is as tall as the bridge deck
  shoreMax: 16, // distance-field range in metres
  cell: 1 // distance-field cell in metres
});

const EDGE_EPS = 0.6;

const shoelace = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    a += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return a;
};


/**
 * A lake cut by the district edge runs on to the horizon: each run of ring vertices on the bbox boundary (the clip line)
 * is replaced by P_first, P_first pushed out to +-far, P_last pushed out, P_last. The shoreline inside the district is
 * untouched; the new edges lie on or beyond the boundary (no walls there, see `outsideEdge`).
 */
export function extendBeyondBbox(ring, bbox, far = WATER.far) {
  if (Math.abs(shoelace(ring)) / 2 < WATER.extendMinArea) return ring.slice(); // a small pond cut by the edge just ends there
  const [x0, z0, x1, z1] = bbox;
  const n = ring.length / 2;
  const onEdge = (k) => ring[2 * k] <= x0 + EDGE_EPS || ring[2 * k] >= x1 - EDGE_EPS || ring[2 * k + 1] <= z0 + EDGE_EPS || ring[2 * k + 1] >= z1 - EDGE_EPS;
  const flags = Array.from({ length: n }, (_, k) => onEdge(k));
  if (!flags.some(Boolean) || flags.every(Boolean)) return ring.slice();
  const push = (k) => {
    let x = ring[2 * k];
    let z = ring[2 * k + 1];
    if (x <= x0 + EDGE_EPS) x = -far; else if (x >= x1 - EDGE_EPS) x = far;
    if (z <= z0 + EDGE_EPS) z = -far; else if (z >= z1 - EDGE_EPS) z = far;
    return [x, z];
  };
  // start at a vertex that is not on the boundary so runs never wrap
  const start = flags.findIndex((f) => !f);
  const out = [];
  let k = 0;
  while (k < n) {
    const i = (start + k) % n;
    if (!flags[i]) { out.push(ring[2 * i], ring[2 * i + 1]); k++; continue; }
    let m = k;
    while (m + 1 < n && flags[(start + m + 1) % n]) m++;
    const first = (start + k) % n;
    const last = (start + m) % n;
    out.push(ring[2 * first], ring[2 * first + 1]);
    if (m > k) out.push(...push(first), ...push(last), ring[2 * last], ring[2 * last + 1]);
    k = m + 1;
  }
  return out;
}

/** True when a ring edge lies on or beyond the district boundary: no wall there, the water just continues. */
const outsideEdge = (ring, i, bbox) => {
  const j = (i + 2) % ring.length;
  const mx = (ring[i] + ring[j]) / 2;
  const mz = (ring[i + 1] + ring[j + 1]) / 2;
  return mx <= bbox[0] + 0.01 || mx >= bbox[2] - 0.01 || mz <= bbox[1] + 0.01 || mz >= bbox[3] - 0.01;
};

/** Distance from (x, z) to the outline of a flat ring. */
function ringDistance(ring, x, z) {
  let best = Infinity;
  for (let i = 0, k = ring.length - 2; i < ring.length; k = i, i += 2) {
    const ax = ring[k];
    const az = ring[k + 1];
    const dx = ring[i] - ax;
    const dz = ring[i + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) best = d;
  }
  return best;
}

class Arrays {
  constructor() { this.position = []; this.normal = []; this.uv = []; this.kind = []; this.index = []; }
  get vertexCount() { return this.position.length / 3; }
  vertex(x, y, z, nx, ny, nz, u, v, kind) {
    this.position.push(x, y, z); this.normal.push(nx, ny, nz); this.uv.push(u, v); this.kind.push(kind);
    return this.vertexCount - 1;
  }
}

export const KIND = Object.freeze({ wall: 0, coping: 1, soffit: 2, bank: 3 });

/** Natural lakes (OSM water without a name, e.g. park ponds) have grassed banks, not quay walls: 1 : BANK_BATTER slope. */
export const BANK_BATTER = 1.6;
export const isNaturalLake = (lake) => !lake.name || lake.name === 'Lake';

/**
 * Wall strips along one ring. `faceSign` +1 faces the left of the ring direction, -1 the right; (nx, nz) is that
 * horizontal normal. A coping ledge (copingW wide, on the side opposite to the face normal) caps the wall top when
 * `coping` is set. Returns the metres of wall emitted.
 */
function wallAlong(arrays, ring, { faceSign, yBottom, yTop, coping = false, bbox = null, skip = null, vOf = (y) => y, batter = 0, kind = KIND.wall }) {  // vOf(y, x, z)
  const n = ring.length / 2;
  // heights may follow terrain: yBottom / yTop are numbers or functions of the vertex (x, z)
  const yb = typeof yBottom === 'function' ? yBottom : () => yBottom;
  const yt = typeof yTop === 'function' ? yTop : () => yTop;
  // miter normals (unit, pointing away from the face side) for the coping outline
  const nrm = [];
  for (let k = 0; k < n; k++) {
    const p = (k + n - 1) % n;
    const q = (k + 1) % n;
    const e0 = [ring[2 * k] - ring[2 * p], ring[2 * k + 1] - ring[2 * p + 1]];
    const e1 = [ring[2 * q] - ring[2 * k], ring[2 * q + 1] - ring[2 * k + 1]];
    const l0 = Math.hypot(...e0) || 1;
    const l1 = Math.hypot(...e1) || 1;
    // normals pointing AWAY from the face (into the wall's back): -faceSign * left
    const n0 = [faceSign * e0[1] / l0, -faceSign * e0[0] / l0];
    const n1 = [faceSign * e1[1] / l1, -faceSign * e1[0] / l1];
    let mx = n0[0] + n1[0];
    let mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1[0]; mz = n1[1]; } else { mx /= ml; mz /= ml; }
    const cosHalf = Math.max(mx * n1[0] + mz * n1[1], 0.5); // limit the miter to 2x
    nrm.push([mx / cosHalf, mz / cosHalf]);
  }
  let along = 0;
  let metres = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const dx = ring[2 * j] - ring[2 * k];
    const dz = ring[2 * j + 1] - ring[2 * k + 1];
    const len = Math.hypot(dx, dz);
    const start = along;
    along += len;
    if (len < 1e-4 || (bbox && outsideEdge(ring, 2 * k, bbox)) || (skip && skip(k))) continue;
    const fnx = faceSign * -dz / len; // left normal is (-dz, dx)
    const fnz = faceSign * dx / len;
    const yBk = yb(ring[2 * k], ring[2 * k + 1]);
    const yBj = yb(ring[2 * j], ring[2 * j + 1]);
    const yTk = yt(ring[2 * k], ring[2 * k + 1]);
    const yTj = yt(ring[2 * j], ring[2 * j + 1]);
    // a bank leans back from the top edge into the water: the foot is `batter` x the height inward of the outline
    const fa = batter ? (yTk - yBk) * batter : 0;
    const fb = batter ? (yTj - yBj) * batter : 0;
    const ax = ring[2 * k] - (batter ? nrm[k][0] * fa : 0);
    const az = ring[2 * k + 1] - (batter ? nrm[k][1] * fa : 0);
    const bx = ring[2 * j] - (batter ? nrm[j][0] * fb : 0);
    const bz = ring[2 * j + 1] - (batter ? nrm[j][1] * fb : 0);
    const ny = batter ? 1 / batter : 0;
    const nl = Math.hypot(fnx, ny, fnz);
    const a = arrays.vertex(ax, yBk, az, fnx / nl, ny / nl, fnz / nl, start, vOf(yBk, ring[2 * k], ring[2 * k + 1]), kind);
    const b = arrays.vertex(bx, yBj, bz, fnx / nl, ny / nl, fnz / nl, start + len, vOf(yBj, ring[2 * j], ring[2 * j + 1]), kind);
    const c = arrays.vertex(ring[2 * j], yTj, ring[2 * j + 1], fnx / nl, ny / nl, fnz / nl, start + len, vOf(yTj, ring[2 * j], ring[2 * j + 1]), kind);
    const d = arrays.vertex(ring[2 * k], yTk, ring[2 * k + 1], fnx / nl, ny / nl, fnz / nl, start, vOf(yTk, ring[2 * k], ring[2 * k + 1]), kind);
    // (a, b, c) faces the left of the direction of travel; flip for the right-hand face
    if (faceSign > 0) arrays.index.push(a, b, c, a, c, d); else arrays.index.push(a, c, b, a, d, c);
    metres += len;
    if (coping) {
      const w = WATER.copingW;
      const ox0 = ring[2 * k] + nrm[k][0] * w;
      const oz0 = ring[2 * k + 1] + nrm[k][1] * w;
      const ox1 = ring[2 * j] + nrm[j][0] * w;
      const oz1 = ring[2 * j + 1] + nrm[j][1] * w;
      const e = arrays.vertex(ring[2 * k], yTk, ring[2 * k + 1], 0, 1, 0, start, 0, KIND.coping);
      const f = arrays.vertex(ring[2 * j], yTj, ring[2 * j + 1], 0, 1, 0, start + len, 0, KIND.coping);
      const g = arrays.vertex(ox1, yTj, oz1, 0, 1, 0, start + len, w, KIND.coping);
      const h = arrays.vertex(ox0, yTk, oz0, 0, 1, 0, start, w, KIND.coping);
      // upward-facing quad (e, f, g, h): the outer edge lies on the away side of the face
      const cross = edgeTurn(arrays, e, f, g);
      if (cross > 0) arrays.index.push(e, f, g, e, g, h); else arrays.index.push(e, g, f, e, h, g);
    }
  }
  return metres;
}

// y component of (f - e) x (g - e) for stored vertices
function edgeTurn(arrays, e, f, g) {
  const P = arrays.position;
  const ax = P[3 * f] - P[3 * e];
  const az = P[3 * f + 2] - P[3 * e + 2];
  const bx = P[3 * g] - P[3 * e];
  const bz = P[3 * g + 2] - P[3 * e + 2];
  return az * bx - ax * bz; // y of a x b for vectors (x, 0, z)
}

/** Triangulated water surface (normal up) at `y` for a lake record with outline `ring` and `holes` (already extended). */
function surfaceArrays(ring, holes, y) {
  const { pts, idx } = triangulatePolygon(ring, holes);
  const position = [];
  for (let i = 0; i < pts.length; i += 2) position.push(pts[i], y, pts[i + 1]);
  const index = [];
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
    // want +y normal: (q - p) x (r - p) in (x, z) has y = az*bx - ax*bz
    const y2 = (pts[2 * q + 1] - pts[2 * p + 1]) * (pts[2 * r] - pts[2 * p]) - (pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]);
    if (y2 > 0) index.push(p, q, r); else index.push(p, r, q);
  }
  return { position, index };
}

/**
 * Everything the lake system draws, as plain arrays.
 *   surface: one merged water surface at WATER.surfaceY (+ ponds, flat at ground level -0.12)
 *   walls:   lake walls (faces towards the water), granite coping on top, bridge soffits and fascias
 *   ground:  the lakes' extended outlines (holes of the ground plane) and the islands inside them
 */
export function buildLakeArrays(doc, { bbox = [-750, -750, 750, 750], terrain = null, modelBridge = () => false } = {}) {
  const lakes = doc?.lakes || [];
  const measured = terrain && !terrain.flat ? terrain : null;
  // With terrain every lake sits at its MEASURED water level (the DTM over the lake is the water surface); lakes within
  // SNAP of the biggest one share its level (they are one water body split by a bridge). Without terrain the lakes use the
  // old relative frame (ground y = 0, water 0.8 m below).
  const main = measured ? lakes.reduce((best, l) => (!best || Math.abs(shoelace(l.ring)) > Math.abs(shoelace(best.ring)) ? l : best), null) : null;
  const mainLevel = main ? measured.lakeLevel(main.id) : null;
  // top of the quay at a shore vertex: the median terrain on the land side (the DTM right at the outline is partly water
  // or the lake bed), plus the coping; never lower than minFreeboard over the water
  const shoreTop = (x, z, lvl) => {
    const land = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const px = x + Math.cos(a) * WATER.shoreProbe;
      const pz = z + Math.sin(a) * WATER.shoreProbe;
      if (!inLake(doc, px, pz)) land.push(measured.heightAt(px, pz));
    }
    land.sort((p, q) => p - q);
    const ground = land.length ? land[land.length >> 1] : lvl + 0.8;
    return Math.max(ground + WATER.wallTop, lvl + WATER.minFreeboard);
  };
  const snapLevel = (v) => (mainLevel != null && Math.abs(v - mainLevel) < WATER.snap ? mainLevel : v);
  const levelOf = (lake) => {
    const v = measured ? measured.lakeLevel(lake.id) : null;
    if (v == null) return null;
    return mainLevel != null && Math.abs(v - mainLevel) < WATER.snap ? mainLevel : v;
  };
  const surface = { position: [], index: [] };
  const walls = new Arrays();
  const cutRings = [];
  const islands = [];
  let wallMetres = 0;
  const freeboards = []; // wall height above the water at every densified shore vertex (terrain mode)
  const addSurface = (ringIn, holesIn, y) => {
    const s = surfaceArrays(ringIn, holesIn, y);
    const base = surface.position.length / 3;
    surface.position.push(...s.position);
    for (const i of s.index) surface.index.push(base + i);
  };
  const basinLevels = []; // every water basin of the district with its own measured level
  for (const lake of lakes) {
    const ring = extendBeyondBbox(lake.ring, bbox);
    const holes = (lake.holes || []).map((h) => extendBeyondBbox(h, bbox));
    const lvl = levelOf(lake);
    const basins = measured ? (doc.basins || []).filter((b) => b.lake === lake.id) : [];
    // a lake the bridge strips split into basins has one water surface per basin (js/lakes-cph.js header)
    const pieces = basins.length > 1
      ? basins.map((b) => ({ id: b.id, ring: extendBeyondBbox(b.ring, bbox), holes: (b.holes || []).map((h) => extendBeyondBbox(h, bbox)), level: snapLevel(b.level), raw: b.ring }))
      : [{ id: lake.id, ring, holes, level: lvl ?? WATER.surfaceY, raw: null }];
    for (const pc of pieces) { addSurface(pc.ring, pc.holes, pc.level); basinLevels.push({ id: pc.id, level: pc.level }); }
    if (basins.length > 1) {
      const low = Math.min(...pieces.map((pc) => pc.level));
      for (const b of doc.bridges || []) addSurface(b.ring, [], low); // the water under a bridge deck lies at the lower basin's level
    }
    // level at a shore vertex: the nearest basin (distance to its outline)
    const cache = new Map();
    const lvlAt = (x, z) => {
      if (pieces.length === 1) return pieces[0].level;
      const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      let v = cache.get(key);
      if (v === undefined) {
        let best = Infinity;
        for (const pc of pieces) {
          const d = ringDistance(pc.raw, x, z);
          if (d < best) { best = d; v = pc.level; }
        }
        cache.set(key, v);
      }
      return v;
    };
    // Rings are counter-clockwise seen from above (negative shoelace in x/z): the water is on the right of travel on the
    // outer ring and on the left of travel round an island (hole rings run the other way).
    const outerSign = Math.sign(shoelace(ring)) > 0 ? 1 : -1; // water side of the exterior ring
    // wall: from the lake bed to the terrain at the shore (never lower than 0.3 m over the water), densified to follow it
    const wallArgs = lvl == null
      ? { yBottom: WATER.bedY, yTop: WATER.wallTop }
      : { yBottom: (x, z) => lvlAt(x, z) + (WATER.bedY - WATER.surfaceY), yTop: (x, z) => shoreTop(x, z, lvlAt(x, z)), vOf: (y, x, z) => y - lvlAt(x, z) + WATER.surfaceY };
    const dense = (r) => (lvl == null ? r : densifyRing(r, WATER.wallStep));
    if (lvl != null) { const d = dense(ring); for (let i = 0; i < d.length; i += 2) { const l = lvlAt(d[i], d[i + 1]); freeboards.push({ id: lake.id, x: d[i], z: d[i + 1], free: shoreTop(d[i], d[i + 1], l) - l, natural: isNaturalLake(lake), abutment: (doc.bridges || []).some((b) => ringDistance(b.ring, d[i], d[i + 1]) < WATER.abutmentM) }); } }
    const natural = isNaturalLake(lake) && lvl != null;
    const kindArgs = natural ? { batter: BANK_BATTER, kind: KIND.bank, coping: false } : { coping: true };
    wallMetres += wallAlong(walls, dense(ring), { faceSign: outerSign, ...wallArgs, ...kindArgs, bbox });
    cutRings.push({ ring, holes });
    for (const hole of holes) {
      wallMetres += wallAlong(walls, dense(hole), { faceSign: Math.sign(shoelace(hole)) > 0 ? -1 : 1, ...wallArgs, ...kindArgs, bbox });
      islands.push(hole);
    }
  }
  const bridges = [];
  const soffit = new Arrays();
  for (const b of doc?.bridges || []) {
    // The hero bridge owns its own arch vault and fascia. Preserve the bridge
    // record/statistics and all lake cuts/water; suppress only this flat slab.
    if (modelBridge(b)) {
      bridges.push(b.id);
      continue;
    }
    const { pts, idx } = triangulatePolygon(b.ring);
    const base = soffit.vertexCount;
    // a measured deck height (the DTM along the bridge) replaces the old "deck = road layer, 0.02 above the ground"
    const deck = measured?.deckHeight(b.id);
    const deckY = deck != null ? deck : WATER.deckY;
    const soffitY = deck != null ? deck - (WATER.deckY - WATER.soffitY) : WATER.soffitY;
    for (let i = 0; i < pts.length; i += 2) soffit.vertex(pts[i], soffitY, pts[i + 1], 0, -1, 0, pts[i], pts[i + 1], KIND.soffit);
    for (let i = 0; i < idx.length; i += 3) {
      const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
      const y2 = (pts[2 * q + 1] - pts[2 * p + 1]) * (pts[2 * r] - pts[2 * p]) - (pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]);
      if (y2 < 0) soffit.index.push(base + p, base + q, base + r); else soffit.index.push(base + p, base + r, base + q); // facing down
    }
    // fascia on the edges that open onto water, facing away from the deck
    const open = new Set(b.open_edges || []);
    const outer = Math.sign(shoelace(b.ring)) > 0 ? -1 : 1; // outward = right of a CCW-in-math ring
    wallAlong(soffit, b.ring, { faceSign: outer, yBottom: soffitY, yTop: deckY, skip: (k) => !open.has(k) });
    bridges.push(b.id);
  }
  for (const p of doc?.ponds || []) {
    const pl = measured ? measured.pondLevel(p.id) : null;
    const s = surfaceArrays(p.ring, [], pl != null ? pl + 0.02 : -0.12); // a pond lies where the terrain dips to its level
    const base = surface.position.length / 3;
    surface.position.push(...s.position);
    for (const i of s.index) surface.index.push(base + i);
  }
  return { surface, walls, soffit, cutRings, islands, level: mainLevel ?? WATER.surfaceY, basins: basinLevels, freeboards, stats: { lakes: lakes.length, wallMetres: Math.round(wallMetres), bridges: bridges.length } };
}

/** Ground plane (size x size, centred on the origin) with the lake outlines cut out and the islands filled back in. */
export function groundWithHoles(size, cutRings, islands = [], uvSize = size) {
  const h = size / 2;
  const outer = [-h, -h, h, -h, h, h, -h, h];
  const holes = cutRings.map((c) => c.ring);
  const position = [];
  const uv = [];
  const index = [];
  const push = (pts, idx) => {
    const base = position.length / 3;
    for (let i = 0; i < pts.length; i += 2) {
      position.push(pts[i], 0, pts[i + 1]);
      uv.push((pts[i] + uvSize / 2) / uvSize, (uvSize / 2 - pts[i + 1]) / uvSize);
    }
    for (let i = 0; i < idx.length; i += 3) {
      const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
      const y2 = (pts[2 * q + 1] - pts[2 * p + 1]) * (pts[2 * r] - pts[2 * p]) - (pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]);
      if (y2 > 0) index.push(base + p, base + q, base + r); else index.push(base + p, base + r, base + q);
    }
  };
  const t = triangulatePolygon(outer, holes);
  push(t.pts, t.idx);
  for (const island of islands) {
    const s = triangulatePolygon(island);
    push(s.pts, s.idx);
  }
  return { position, uv, index };
}

/** True when (x, z) is in a lake (outline minus islands) of the lake document, using the un-extended rings. */
export function inLake(doc, x, z) {
  for (const lake of doc?.lakes || []) {
    if (pointInRing(lake.ring, x, z) && !(lake.holes || []).some((h) => pointInRing(h, x, z))) return true;
  }
  return false;
}

/**
 * Distance (metres, capped at WATER.shoreMax) from every water cell of the district to the nearest wall, as a Uint8
 * grid (value = distance * 255 / shoreMax). The water shader samples it bilinearly for the soft shoreline.
 * Rasterised at cell centres; cells outside the grid count as water (no shore at the district edge).
 */
export function shoreDistanceField(doc, { bbox = [-750, -750, 750, 750], cell = WATER.cell, max = WATER.shoreMax } = {}) {
  const [x0, z0, x1, z1] = bbox;
  const w = Math.ceil((x1 - x0) / cell);
  const h = Math.ceil((z1 - z0) / cell);
  const inside = new Uint8Array(w * h);
  const rings = [];
  for (const lake of doc?.lakes || []) {
    rings.push(extendBeyondBbox(lake.ring, bbox));
    for (const hole of lake.holes || []) rings.push(extendBeyondBbox(hole, bbox));
  }
  for (let j = 0; j < h; j++) {
    const zc = z0 + (j + 0.5) * cell;
    const xs = [];
    for (const r of rings) {
      for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
        const zi = r[i + 1];
        const zk = r[k + 1];
        if ((zi > zc) !== (zk > zc)) xs.push(r[i] + ((zc - zi) / (zk - zi)) * (r[k] - r[i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[q + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  // two-pass chamfer distance (in cells) to the nearest land cell
  const BIG = 1e4;
  const d = new Float32Array(w * h);
  for (let n = 0; n < d.length; n++) d[n] = inside[n] ? BIG : 0;
  const SQ = Math.SQRT2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = j * w + i;
      if (!d[n]) continue;
      let v = d[n];
      if (i > 0) v = Math.min(v, d[n - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[n - w] + 1);
        if (i > 0) v = Math.min(v, d[n - w - 1] + SQ);
        if (i < w - 1) v = Math.min(v, d[n - w + 1] + SQ);
      }
      d[n] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const n = j * w + i;
      if (!d[n]) continue;
      let v = d[n];
      if (i < w - 1) v = Math.min(v, d[n + 1] + 1);
      if (j < h - 1) {
        v = Math.min(v, d[n + w] + 1);
        if (i < w - 1) v = Math.min(v, d[n + w + 1] + SQ);
        if (i > 0) v = Math.min(v, d[n + w - 1] + SQ);
      }
      d[n] = v;
    }
  }
  const data = new Uint8Array(w * h);
  for (let n = 0; n < data.length; n++) {
    // the wall sits half a cell outside the first water cell centre
    const metres = d[n] === 0 ? 0 : Math.max(0, d[n] - 0.5) * cell;
    data[n] = Math.min(255, Math.round((metres / max) * 255));
  }
  return { data, width: w, height: h, bbox, cell, max };
}

/** Replaces cut surfaces of a cph-surfaces document (see `surface_cuts` in cph-lakes.json); the input is not modified. */
export function applySurfaceCuts(surfacesDoc, cuts) {
  if (!surfacesDoc?.surfaces || !cuts?.length) return surfacesDoc;
  const byId = new Map(cuts.map((c) => [c.id, c.replace || []]));
  const surfaces = [];
  for (const s of surfacesDoc.surfaces) {
    const replace = byId.get(s.id);
    if (!replace) { surfaces.push(s); continue; }
    for (const piece of replace) surfaces.push({ ...s, ...piece });
  }
  return { ...surfacesDoc, surfaces };
}
