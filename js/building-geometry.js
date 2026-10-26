// js/building-geometry.js
// Pure (no three.js) geometry for the Copenhagen real buildings: polygon rings with holes extruded from `ground` to
// `eave`, a flat roof with a low parapet or (only for plain quadrilaterals) a hipped cap, and the per-vertex facade
// frame the wallAttr facade shaders read (tsl-materials.js facadeCell):
//   facadeUV   (u, v)       metres along the wall from its start, metres above the building's ground
//   facadeWall (len, floor_h, ground_floor_h, bay_w)
//   facadeBldg (hash 0..1, WALL_KINDS of the ground floor, style code = material + 4 * era, integer seed)
//   facadeWindow (frame palette, division type + 4 if a physical cornice is present, frame width m, reveal depth m)
//   facadeTop  metres from the ground to the top of the wall (cornice placement)
//   facadeTone (r, g, b linear, window width / bay width)
// Frame (docs/cph-geodata-schema.md): x east, z south, y up. Rings are CCW seen from above (in x / -z), holes CW, so
// the outward normal of the wall p0 -> p1 (direction d) is (-d.z, 0, d.x) and u grows along d.
// With a LoD2 record (opts.lod2, js/lod2-geometry.js) the roof is the roofer mesh and each wall ends at its roofer eave.
import { lod2EdgeTops, lod2RoofTriangles, lod2WallPieces } from './lod2-geometry.js';
import { mapObservedEdges, roofSurface, observedToneSrgb } from './appearance.js';
import { facadeStyle, windowStyle } from './facade-style.js';
import { classifyWalls, doorSummary } from './groundfloor.js';
import { appendBuildingDetails, selectDetailEdges } from './building-details.js';
import { placeDoors } from './entrances.js';

const PARAPET_H = 0.45;
const PARAPET_T = 0.22;
const WALL_KIND = { shop: 0, entrance: 1, residential: 1, blank: 4 };

// sRGB values (converted to linear when written)
const ROOF_COLOURS = {
  'tagpap': [0.2, 0.2, 0.22],
  'tagpap med lille hældning': [0.2, 0.2, 0.22],
  'tagpap med stor hældning': [0.24, 0.23, 0.24],
  'tegl': [0.46, 0.19, 0.13],
  'betontagsten': [0.33, 0.27, 0.24],
  'fibercement herunder asbest': [0.23, 0.25, 0.27],
  'fibercement uden asbest': [0.23, 0.25, 0.27],
  'metal': [0.42, 0.46, 0.48],
  'glas': [0.35, 0.45, 0.5],
  'levende tage': [0.2, 0.32, 0.17],
  'plastmaterialer': [0.4, 0.4, 0.42],
  'andet materiale': [0.32, 0.31, 0.3]
};
const ROOF_DEFAULT = [0.34, 0.33, 0.32];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Signed area of a flat [x0, z0, ...] ring in the (x, north = -z) plane: positive when CCW seen from above. */
function ringArea(ring) {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[2 * i] * -ring[2 * j + 1] - ring[2 * j] * -ring[2 * i + 1];
  }
  return a / 2;
}

/** Points [[x, z], ...] with duplicates and (near-)collinear vertices removed, in the requested orientation. */
function cleanRing(flat, ccw) {
  let pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  const dedup = [];
  for (const p of pts) {
    const q = dedup[dedup.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) dedup.push(p);
  }
  if (dedup.length > 1 && Math.hypot(dedup[0][0] - dedup[dedup.length - 1][0], dedup[0][1] - dedup[dedup.length - 1][1]) <= 0.05) dedup.pop();
  pts = dedup;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (scale > 0 && Math.abs(cross) / scale < 0.0087 && dot > 0) { // < 0.5 degrees and not a spike
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (pts.length < 3) return null;
  const flatOut = pts.flat();
  if ((ringArea(flatOut) > 0) !== ccw) pts.reverse();
  return pts;
}

// ---------------------------------------------------------------------------------------------------------------
// Triangulation: ear clipping after bridging each hole into the outer ring. Works in the (x, north) plane.
// ---------------------------------------------------------------------------------------------------------------
const cross2 = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segmentsCross(p, q, r, s) {
  const d1 = cross2(p[0], p[1], q[0], q[1], r[0], r[1]);
  const d2 = cross2(p[0], p[1], q[0], q[1], s[0], s[1]);
  const d3 = cross2(r[0], r[1], s[0], s[1], p[0], p[1]);
  const d4 = cross2(r[0], r[1], s[0], s[1], q[0], q[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * outer: CCW [[x, n], ...]; holes: CW [[x, n], ...]. Returns { points: [[x, n], ...], indices } with CCW triangles
 * (points may repeat the bridge vertices).
 */
function triangulate(outer, holes = []) {
  let poly = outer.map((p) => p.slice());
  const edgesOf = (ring) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
  const allHoles = holes.slice().sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  const merged = [];
  for (const hole of allHoles) {
    const blockers = [...edgesOf(poly), ...merged.flatMap(edgesOf)];
    const blockersAll = [...blockers, ...edgesOf(hole)];
    let best = null;
    for (let hi = 0; hi < hole.length; hi++) {
      for (let pi = 0; pi < poly.length; pi++) {
        const d = Math.hypot(hole[hi][0] - poly[pi][0], hole[hi][1] - poly[pi][1]);
        if (best && d >= best.d) continue;
        const clear = blockersAll.every(([a, b]) => !segmentsCross(hole[hi], poly[pi], a, b));
        if (!clear) continue;
        // The bridge must also start inside the polygon: its midpoint has to lie inside the (current) outer ring
        const mx = (hole[hi][0] + poly[pi][0]) / 2;
        const my = (hole[hi][1] + poly[pi][1]) / 2;
        if (!pointInRing(mx, my, outer)) continue;
        best = { d, hi, pi };
      }
    }
    if (!best) continue; // an unreachable hole is dropped rather than breaking the whole building
    const h = [...hole.slice(best.hi), ...hole.slice(0, best.hi)];
    poly = [...poly.slice(0, best.pi + 1), ...h.map((p) => p.slice()), h[0].slice(), poly[best.pi].slice(), ...poly.slice(best.pi + 1)];
    merged.push(hole);
  }
  const n = poly.length;
  const prev = Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const next = Array.from({ length: n }, (_, i) => (i + 1) % n);
  const indices = [];
  let remaining = n;
  let i = 0;
  let guard = 0;
  const isEar = (a, b, c) => {
    const A = poly[a], B = poly[b], C = poly[c];
    if (cross2(A[0], A[1], B[0], B[1], C[0], C[1]) <= 1e-12) return false;
    let k = next[c];
    while (k !== a) {
      const P = poly[k];
      const coincident = (P[0] === A[0] && P[1] === A[1]) || (P[0] === B[0] && P[1] === B[1]) || (P[0] === C[0] && P[1] === C[1]);
      if (!coincident
        && cross2(A[0], A[1], B[0], B[1], P[0], P[1]) >= 0
        && cross2(B[0], B[1], C[0], C[1], P[0], P[1]) >= 0
        && cross2(C[0], C[1], A[0], A[1], P[0], P[1]) >= 0) return false;
      k = next[k];
    }
    return true;
  };
  while (remaining > 3 && guard++ < n * n + 10) {
    const a = prev[i], c = next[i];
    if (isEar(a, i, c)) {
      indices.push(a, i, c);
      next[a] = c;
      prev[c] = a;
      remaining--;
      i = c;
      guard = 0;
    } else {
      i = next[i];
    }
  }
  if (remaining === 3) indices.push(prev[i], i, next[i]);
  return { points: poly, indices };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------------------------------------------
// Accumulator: wall and roof arrays shared by every building of a streaming cell.
// ---------------------------------------------------------------------------------------------------------------
function createAccumulator() {
  const wall = { position: [], normal: [], facadeUV: [], facadeWall: [], facadeBldg: [], facadeTone: [], facadeTop: [], facadeWindow: [], index: [] };
  const roof = { position: [], normal: [], color: [], mat: [], index: [] };
  return { wall, roof, wallRanges: [], roofRanges: [], detailParts: [] };
}

/**
 * Linear roof colour + [roughness, metalness]: the observed tone when the appearance pass saw the roof, else the BBR roof
 * material; the surface comes from the observed type hint (tagpap dark matte, tile, slate, metal, ...).
 */
function roofColourFor(b, useObserved = true, pitched = false) {
  const seen = useObserved ? b.observed?.roof : null;
  let rgb = seen?.conf === 'observed' && Array.isArray(seen.tone) && seen.tone.length === 3 ? seen.tone : (ROOF_COLOURS[b.roof_material] || ROOF_DEFAULT);
  const { rough, metal, hint } = roofSurface(useObserved ? b : { ...b, observed: null });
  // Dark pitched roof photographs contain reflected sky; preserve hue and leave metals / flat decks alone.
  if (pitched && ['slate', 'fibre-cement', 'tagpap'].includes(hint)) {
    const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const gain = Math.min(1, 0.26 / Math.max(luma, 0.001));
    rgb = rgb.map((v) => v * gain);
  }
  return [...rgb.map(srgbToLinear), rough, metal];
}

/**
 * Appends one building: its roof to `acc`, its walls to `opts.wallAcc` (default `acc`; glass towers go to their own mesh).
 * `opts.lod2` (a parsed record, see lod2-geometry.js) swaps the flat roof for the roofer LoD2.2 roof and ends each wall at
 * its roofer eave. Hero buildings are skipped by the caller. Returns the numbers of triangles added.
 */
function addBuilding(acc, b, opts = {}) {
  const wallAcc = opts.wallAcc || acc;
  const outerPts = cleanRing(b.ring, true);
  if (!outerPts) return null;
  const holePts = (b.holes || []).map((h) => cleanRing(h, false)).filter(Boolean);
  const ground = b.ground;
  const eave = Math.max(b.eave, ground + 0.5);
  // The wall stands on the terrain (js/terrain-cph.js, the one ground model): its skirt reaches 0.25 m under the lowest
  // ground along the outline, so a sloping street never shows a gap. Without terrain: the flat plane at y = 0.
  let bottom = Math.min(ground, 0) - 0.1;
  if (opts.terrain && !opts.terrain.flat) {
    let low = ground;
    for (const ring of [outerPts, ...holePts]) for (const p of ring) low = Math.min(low, opts.terrain.heightAt(p[0], p[1]));
    bottom = low - 0.25;
  }
  const f = b.facade || {};
  const groundH = f.ground_floor_h || f.floor_h || 3;
  // Fit a whole number of storeys between the ground floor and the eave (the BBR storey count and the DSM height
  // disagree by a fraction of a floor on many buildings; the fit keeps the top row from ending in a blank band)
  const nominalFloor = f.floor_h || 3;
  const upper = Math.max(eave - ground - groundH, 0);
  const floorH = upper > nominalFloor * 0.5 ? upper / Math.max(1, Math.round(upper / nominalFloor)) : nominalFloor;
  const bayW = f.bay_w || 3;
  const windowW = f.window_w || 1.2;
  const tone = (f.tone || [0.7, 0.65, 0.58]).map(srgbToLinear);
  const idHash = hashString(String(b.id));
  const kind = WALL_KIND[f.ground_type] ?? 1;
  // facadeBldg.z carries the style code (js/facade-style.js: material + era), not the old inferred flag
  const style = facadeStyle(b, observedToneSrgb(b) || (f.tone || null));
  const styleCode = style.code;
  const windows = windowStyle(b);

  const wallStart = wallAcc.wall.index.length;
  const roofStart = acc.roof.index.length;
  const w = wallAcc.wall;

  const rings = [outerPts, ...holePts];
  // Ground-floor treatment per wall (street side + venue data, js/groundfloor.js); without a context the preset kind is used
  const wallKinds = opts.wallKinds || (opts.ground ? classifyWalls(b, rings, opts.ground) : null);
  const doors = opts.ground?.entrances?.has(b.id) ? placeDoors(b, rings, opts.ground.entrances.get(b.id)) : [];
  const lod2 = opts.lod2 || null;
  const lod = lod2 ? lod2EdgeTops(lod2, b, rings, eave, ground + 1.0) : null;
  const roofTriangles = lod2 ? lod2RoofTriangles(lod2) : [];
  const pitched = lod2 ? roofTriangles.some(([a, c, d]) => {
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const ny = (uz * vx - ux * vz) / (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1);
    return ny > 0.1 && ny < 0.98;
  }) : holePts.length === 0 && outerPts.length === 4 && b.roof !== 'flat' && b.ridge > eave + 1.5;
  const roofColour = roofColourFor(b, opts.observed !== false, pitched);
  const edgeVertices = [];
  // Observed wall tone per cleaned edge (ring/edge keyed in the data, matched by geometry); `opts.observed === false` keeps the preset
  const mapping = opts.observed === false ? null : mapObservedEdges(b, rings);
  const buildingTone = mapping?.hasObserved ? mapping.buildingTone : tone;
  const edgeTone = (k) => (mapping?.hasObserved ? mapping.edges[k].tone : tone);
  let edgeNo = -1;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      edgeNo++;
      const p0 = ring[i];
      const p1 = ring[(i + 1) % ring.length];
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const base = w.position.length / 3;
      edgeVertices[edgeNo] = base;
      const top = lod ? lod.tops[edgeNo] : eave;
      const wt = edgeTone(edgeNo);
      // +0.25 marks a wall whose heuristic shader door is off (real entrance data: tsl-materials.js facadeCell reads fract(kind))
      const wallKind = (wallKinds?.[edgeNo]?.kind ?? kind) + (wallKinds?.[edgeNo]?.doorless ? 0.25 : 0);
      if (opts.quads) opts.quads.push({ edgeNo, p0, p1, top, ground });
      const v0 = bottom - ground;
      const v1 = top - ground;
      const corners = [[p0, 0, bottom, v0], [p1, len, bottom, v0], [p1, len, top, v1], [p0, 0, top, v1]];
      for (const [p, u, y, v] of corners) {
        w.position.push(p[0], y, p[1]);
        w.normal.push(nx, 0, nz);
        w.facadeUV.push(u, v);
        w.facadeWall.push(len, floorH, groundH, bayW);
        w.facadeBldg.push((idHash % 1000) / 1000, wallKind, styleCode, idHash % 997);
        w.facadeTone.push(wt[0], wt[1], wt[2], Math.min(Math.max(windowW / bayW, 0.12), 0.85));
        w.facadeTop.push(v1);
        w.facadeWindow.push(windows.frame, windows.type, windows.frameWidth, windows.reveal);
      }
      w.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  if (lod2) {
    // Roofer outer walls above each edge's eave (gables, steps) and inner step walls, as plain masonry in the edge's frame
    const edgeFrames = [];
    rings.forEach((ring) => ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; edgeFrames.push([p, q]); }));
    for (const { edge, tri } of lod2WallPieces(lod2, lod)) {
      const [e0, e1] = edge >= 0 ? edgeFrames[edge] : [null, null];
      let dxw, dzw;
      if (e0) { dxw = e1[0] - e0[0]; dzw = e1[1] - e0[1]; } else {
        const a = tri[0], c = tri[1], d = tri[2];
        const nxv = (c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]);
        const nzv = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
        dxw = nzv; dzw = -nxv; // tangent of a wall whose horizontal normal is (nxv, nzv): d = (nz, -nx)
      }
      const dl = Math.hypot(dxw, dzw) || 1;
      const tx = dxw / dl, tz = dzw / dl;
      const org = e0 || [tri[0][0], tri[0][2]];
      const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
      const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
      let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const base = w.position.length / 3;
      for (const q of tri) {
        w.position.push(q[0], q[1], q[2]);
        w.normal.push(fx, fy, fz);
        w.facadeUV.push((q[0] - org[0]) * tx + (q[2] - org[1]) * tz, q[1] - ground);
        w.facadeWall.push(e0 ? Math.hypot(dxw, dzw) : 10, floorH, groundH, bayW);
        w.facadeBldg.push((idHash % 1000) / 1000, WALL_KIND.blank, styleCode, idHash % 997);
        w.facadeWindow.push(windows.frame, windows.type, windows.frameWidth, windows.reveal);
        w.facadeTop.push(1e4); // roofer gables / step walls: no cornice
        const pt = edge >= 0 ? edgeTone(edge) : buildingTone;
        w.facadeTone.push(pt[0], pt[1], pt[2], Math.min(Math.max(windowW / bayW, 0.12), 0.85));
      }
      w.index.push(base, base + 1, base + 2);
    }
    addLod2Roof(acc.roof, lod2, roofColour, roofTriangles);
  } else {
    addRoof(acc.roof, b, outerPts, holePts, eave, roofColour);
  }

  // Details share the existing roof material, buffers, shadows, culling and picking range: zero extra draws.
  // Without street context, callers can explicitly supply an edge mask for isolated geometry work.
  const detailStart = acc.roof.index.length;
  const partStart = acc.detailParts.length;
  if (opts.details !== false && (wallKinds || opts.streetEdges || opts.details === true)) {
    const selected = opts.streetEdges || selectDetailEdges(rings, wallKinds);
    appendBuildingDetails(acc.roof, acc.detailParts, b, rings,
      lod?.tops || Array(rings.reduce((n, r) => n + r.length, 0)).fill(eave), selected, roofTriangles, buildingTone,
      wallKinds ? { wallKinds, groundH, bayW, tone: (idHash % 1000) / 1000 } : null);
    for (const part of acc.detailParts.slice(partStart)) {
      if (part.kind !== 'cornice') continue;
      for (const edge of part.edges) {
        const base = edgeVertices[edge];
        for (let v = base; v < base + 4; v++) w.facadeWindow[v * 4 + 1] = windows.type + 4;
      }
    }
  }
  const detailTriangles = (acc.roof.index.length - detailStart) / 3;

  wallAcc.wallRanges.push({ id: b.id, start: wallStart, end: w.index.length });
  acc.roofRanges.push({ id: b.id, start: roofStart, end: acc.roof.index.length });
  return { wallTriangles: (w.index.length - wallStart) / 3, roofTriangles: (acc.roof.index.length - roofStart) / 3, detailTriangles, mapping, wallKinds, style, layout: { floorH, groundH, seed: idHash % 997 }, doors, doorInfo: wallKinds ? doorSummary(wallKinds, doors) : null };
}

/** The roofer roof surfaces with flat per-triangle normals (a pitched roof is faceted). */
function addLod2Roof(r, rec, colour, triangles = lod2RoofTriangles(rec)) {
  for (const tri of triangles) {
    const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
    const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    nx /= l; ny /= l; nz /= l;
    const base = r.position.length / 3;
    for (const q of tri) pushRoofVertex(r, q[0], q[1], q[2], nx, ny, nz, colour);
    r.index.push(base, base + 1, base + 2);
  }
}

function pushRoofVertex(r, x, y, z, nx, ny, nz, colour) {
  r.position.push(x, y, z);
  r.normal.push(nx, ny, nz);
  r.color.push(colour[0], colour[1], colour[2]);
  r.mat.push(colour[3] ?? 0.88, colour[4] ?? 0.02);
  return r.position.length / 3 - 1;
}

// Miter-inset copy of a ring (edges move by t towards the building's solid, i.e. to the left of travel for CCW rings)
function insetRing(ring, t) {
  const n = ring.length;
  const normals = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len]; // outward from the solid
  });
  return ring.map((p, i) => {
    const a = normals[(i + n - 1) % n];
    const c = normals[i];
    const d = 1 + a[0] * c[0] + a[1] * c[1];
    const k = Math.min(t / Math.max(d, 0.35), t * 2.5);
    return [p[0] - (a[0] + c[0]) * k, p[1] - (a[1] + c[1]) * k];
  });
}

function addRoof(r, b, outer, holes, eave, colour) {
  const hipped = holes.length === 0 && outer.length === 4 && b.roof !== 'flat' && b.ridge > eave + 1.5;
  if (hipped) {
    addHippedRoof(r, outer, eave, Math.min(b.ridge - eave, 6.5), colour);
    return;
  }
  const rings = [outer, ...holes];
  const top = eave + PARAPET_H;
  const insets = rings.map((ring) => insetRing(ring, PARAPET_T));
  rings.forEach((ring, ri) => {
    const inner = insets[ri];
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = ring[j][0] - ring[i][0], dz = ring[j][1] - ring[i][1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = -dz / len, nz = dx / len;
      // Outer face (flush with the facade), top, inner face
      let a = pushRoofVertex(r, ring[i][0], eave, ring[i][1], nx, 0, nz, colour);
      let c = pushRoofVertex(r, ring[j][0], eave, ring[j][1], nx, 0, nz, colour);
      let d = pushRoofVertex(r, ring[j][0], top, ring[j][1], nx, 0, nz, colour);
      let e = pushRoofVertex(r, ring[i][0], top, ring[i][1], nx, 0, nz, colour);
      r.index.push(a, c, d, a, d, e);
      a = pushRoofVertex(r, ring[i][0], top, ring[i][1], 0, 1, 0, colour);
      c = pushRoofVertex(r, ring[j][0], top, ring[j][1], 0, 1, 0, colour);
      d = pushRoofVertex(r, inner[j][0], top, inner[j][1], 0, 1, 0, colour);
      e = pushRoofVertex(r, inner[i][0], top, inner[i][1], 0, 1, 0, colour);
      r.index.push(a, c, d, a, d, e);
      // Inner face looks into the roof (towards the solid), against the outward wall direction
      a = pushRoofVertex(r, inner[i][0], top, inner[i][1], -nx, 0, -nz, colour);
      c = pushRoofVertex(r, inner[j][0], top, inner[j][1], -nx, 0, -nz, colour);
      d = pushRoofVertex(r, inner[j][0], eave, inner[j][1], -nx, 0, -nz, colour);
      e = pushRoofVertex(r, inner[i][0], eave, inner[i][1], -nx, 0, -nz, colour);
      r.index.push(a, d, e, a, c, d);
    }
  });
  // Roof deck inside the parapet, at eave level, slightly darker than the parapet
  const deck = [colour[0] * 0.85, colour[1] * 0.85, colour[2] * 0.85, colour[3], colour[4]];
  const tri = triangulate(insets[0].map(([x, z]) => [x, -z]), insets.slice(1).map((h) => h.map(([x, z]) => [x, -z])));
  const base = r.position.length / 3;
  for (const [x, n] of tri.points) pushRoofVertex(r, x, eave, -n, 0, 1, 0, deck);
  for (const k of tri.indices) r.index.push(base + k);
}

function addHippedRoof(r, ring, eave, rise, colour) {
  const len = (a, c) => Math.hypot(c[0] - a[0], c[1] - a[1]);
  const long0 = len(ring[0], ring[1]) + len(ring[2], ring[3]);
  const long1 = len(ring[1], ring[2]) + len(ring[3], ring[0]);
  const k = long0 >= long1 ? 0 : 1;
  const [c0, c1, c2, c3] = [0, 1, 2, 3].map((j) => ring[(k + j) % 4]);
  const longLen = (len(c0, c1) + len(c3, c2)) / 2;
  const shortLen = (len(c1, c2) + len(c0, c3)) / 2;
  const a = Math.min(shortLen / (2 * longLen), 0.5);
  const h = Math.min(rise, shortLen * 0.55);
  const P = (s, t) => [
    (1 - t) * ((1 - s) * c0[0] + s * c1[0]) + t * ((1 - s) * c3[0] + s * c2[0]),
    (1 - t) * ((1 - s) * c0[1] + s * c1[1]) + t * ((1 - s) * c3[1] + s * c2[1])
  ];
  const r0 = P(a, 0.5);
  const r1 = P(1 - a, 0.5);
  const faces = [
    [[c0, eave], [c1, eave], [r1, eave + h], [r0, eave + h]],
    [[c1, eave], [c2, eave], [r1, eave + h]],
    [[c2, eave], [c3, eave], [r0, eave + h], [r1, eave + h]],
    [[c3, eave], [c0, eave], [r0, eave + h]]
  ];
  for (const face of faces) {
    const p = face.map(([q, y]) => [q[0], y, q[1]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = pushRoofVertex(r, p[0][0], p[0][1], p[0][2], nx, ny, nz, colour);
    for (let i = 1; i < p.length; i++) pushRoofVertex(r, p[i][0], p[i][1], p[i][2], nx, ny, nz, colour);
    for (let i = 1; i < p.length - 1; i++) r.index.push(base, base + i, base + i + 1);
  }
}

export {
  PARAPET_H, WALL_KIND, ROOF_COLOURS,
  hashString, ringArea, cleanRing, triangulate, roofColourFor, createAccumulator, addBuilding, insetRing
};
