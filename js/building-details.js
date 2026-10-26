// Pure geometry helpers for light facade and roof details. The generated meshes are closed solids so they can be
// batched into a cell-wide stream without relying on a double-sided material.
// Dormers stay deferred: this data has no surveyed opening locations, and adding them requires invasive roof cutouts.

import { facadeStyle, hasFacadeDetails, ERA, FACADE_CORNER_PIER } from './facade-style.js';
import { KIND } from './groundfloor.js';

const MAX_STREET_EDGES = 4;
const MIN_DETAIL_EDGE_LENGTH = 1.5;

const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const length2 = (a) => Math.hypot(a[0], a[1]);

/** Main's street/venue/party-wall classification also selects physical trim. Long frontages win the four-edge cap. */
function selectDetailEdges(rings, wallKinds) {
  const selected = Array(rings.reduce((n, ring) => n + ring.length, 0)).fill(false);
  const candidates = rings[0].map((p, i) => {
    const q = rings[0][(i + 1) % rings[0].length];
    return { i, length: Math.hypot(q[0] - p[0], q[1] - p[1]), kind: wallKinds?.[i]?.kind };
  }).filter((e) => e.length >= MIN_DETAIL_EDGE_LENGTH && (e.kind === KIND.entry || e.kind === KIND.shop));
  candidates.sort((a, b) => b.length - a.length || a.i - b.i);
  for (const { i } of candidates.slice(0, MAX_STREET_EDGES)) selected[i] = true;
  return selected;
}

function outwardOffsetRing(ring, projection) {
  const n = ring.length;
  const normals = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  });
  return ring.map((p, i) => {
    const prev = normals[(i + n - 1) % n];
    const next = normals[i];
    const denominator = Math.max(0.25, 1 + dot2(prev, next));
    const scale = Math.min(projection / denominator, projection * 2.5);
    return [p[0] + (prev[0] + next[0]) * scale, p[1] + (prev[1] + next[1]) * scale];
  });
}

function properSegmentCross(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c), abD = orient(a, b, d);
  const cdA = orient(c, d, a), cdB = orient(c, d, b);
  return ((abC > 1e-8 && abD < -1e-8) || (abC < -1e-8 && abD > 1e-8))
    && ((cdA > 1e-8 && cdB < -1e-8) || (cdA < -1e-8 && cdB > 1e-8));
}

function edgeRuns(selected, ring) {
  const count = ring.length;
  const edges = Array.from({ length: count }, (_, i) => {
    const p = ring[i];
    const q = ring[(i + 1) % count];
    return (selected?.[i] ?? true) && Math.hypot(q[0] - p[0], q[1] - p[1]) >= MIN_DETAIL_EDGE_LENGTH;
  });
  if (!edges.some(Boolean)) return [];
  if (edges.every(Boolean)) return [{ edges: Array.from({ length: count }, (_, i) => i), closed: true }];
  const runs = [];
  for (let i = 0; i < count; i++) {
    if (!edges[i] || edges[(i + count - 1) % count]) continue;
    const run = [];
    let j = i;
    while (edges[j]) {
      run.push(j);
      j = (j + 1) % count;
    }
    runs.push({ edges: run, closed: false });
  }
  return runs;
}

function triangleNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  return [nx, ny, nz];
}

function pushVertex(mesh, point, normal, material) {
  mesh.position.push(point[0], point[1], point[2]);
  mesh.normal.push(normal[0], normal[1], normal[2]);
  mesh.color.push(material.color[0], material.color[1], material.color[2]);
  mesh.mat.push(material.rough, material.metal);
}

function addTriangle(mesh, a, b, c, expectedNormal, material) {
  let p1 = b, p2 = c;
  const n = triangleNormal(a, p1, p2);
  if (dot2([n[0], n[2]], [expectedNormal[0], expectedNormal[2]]) + n[1] * expectedNormal[1] < 0) [p1, p2] = [p2, p1];
  const normal = triangleNormal(a, p1, p2);
  const base = mesh.position.length / 3;
  pushVertex(mesh, a, normal, material);
  pushVertex(mesh, p1, normal, material);
  pushVertex(mesh, p2, normal, material);
  mesh.index.push(base, base + 1, base + 2);
}

function addQuad(mesh, a, b, c, d, expectedNormal, material) {
  addTriangle(mesh, a, b, c, expectedNormal, material);
  addTriangle(mesh, a, c, d, expectedNormal, material);
}

function appendPart(mesh, parts, id, kind, build, edges = []) {
  const start = mesh.index.length;
  build();
  const end = mesh.index.length;
  if (end > start) parts.push({ id, kind, start, end, edges });
}

/** Appends one mitered, capped annular band per selected edge run. */
function appendRingBand(mesh, parts, id, kind, ring, selected, bottoms, tops, projection, material) {
  const n = ring.length;
  if (n < 3) return;
  const outer = outwardOffsetRing(ring, projection);
  const safe = selected.slice();
  for (let i = 0; i < n; i++) {
    if (!safe[i]) continue;
    for (let j = 0; j < n; j++) {
      if (j !== i && properSegmentCross(outer[i], outer[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
        safe[i] = false;
        break;
      }
      if (j > i && safe[j] && j !== (i + 1) % n && i !== (j + 1) % n
        && properSegmentCross(outer[i], outer[(i + 1) % n], outer[j], outer[(j + 1) % n])) {
        safe[i] = false;
        safe[j] = false;
      }
    }
  }
  for (const run of edgeRuns(safe, ring)) {
    appendPart(mesh, parts, id, kind, () => {
      for (const i of run.edges) {
        const j = (i + 1) % n;
        const inner0b = [ring[i][0], bottoms[i], ring[i][1]];
        const inner1b = [ring[j][0], bottoms[j], ring[j][1]];
        const outer0b = [outer[i][0], bottoms[i], outer[i][1]];
        const outer1b = [outer[j][0], bottoms[j], outer[j][1]];
        const inner0t = [ring[i][0], tops[i], ring[i][1]];
        const inner1t = [ring[j][0], tops[j], ring[j][1]];
        const outer0t = [outer[i][0], tops[i], outer[i][1]];
        const outer1t = [outer[j][0], tops[j], outer[j][1]];
        const dx = ring[j][0] - ring[i][0], dz = ring[j][1] - ring[i][1];
        const len = Math.hypot(dx, dz) || 1;
        const outwardNormal = [-dz / len, 0, dx / len];
        const inwardNormal = [dz / len, 0, -dx / len];
        addQuad(mesh, outer0b, outer1b, outer1t, outer0t, outwardNormal, material);
        addQuad(mesh, inner0b, inner1b, inner1t, inner0t, inwardNormal, material);
        addQuad(mesh, inner0t, inner1t, outer1t, outer0t, [0, 1, 0], material);
        addQuad(mesh, inner0b, outer0b, outer1b, inner1b, [0, -1, 0], material);
      }
      if (run.closed) return;
      const first = run.edges[0];
      const last = run.edges[run.edges.length - 1];
      const end = (last + 1) % n;
      const p = ring[first], q = outer[first];
      const d = ring[end], r = outer[end];
      const firstNext = ring[(first + 1) % n];
      const startDir = [firstNext[0] - p[0], firstNext[1] - p[1]];
      const startLen = length2(startDir) || 1;
      addQuad(mesh,
        [p[0], bottoms[first], p[1]], [q[0], bottoms[first], q[1]],
        [q[0], tops[first], q[1]], [p[0], tops[first], p[1]],
        [-startDir[0] / startLen, 0, -startDir[1] / startLen], material);
      const prev = ring[last];
      const endDir = [d[0] - prev[0], d[1] - prev[1]];
      const endLen = length2(endDir) || 1;
      addQuad(mesh,
        [d[0], bottoms[end], d[1]], [r[0], bottoms[end], r[1]],
        [r[0], tops[end], r[1]], [d[0], tops[end], d[1]],
        [endDir[0] / endLen, 0, endDir[1] / endLen], material);
    }, run.edges);
  }
}

function srgb(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const PLINTH_MATERIAL = { color: [0.24, 0.25, 0.25].map(srgb), rough: 0.92, metal: 0.02 };
const GUTTER_MATERIAL = { color: [0.46, 0.49, 0.51].map(srgb), rough: 0.38, metal: 0.72 };
const CHIMNEY_MATERIAL = { color: [0.52, 0.28, 0.22].map(srgb), rough: 0.91, metal: 0.0 };

function corniceMetrics(year, era) {
  if (era === ERA.mid) return { projection: 0.25, height: 0.4 };
  if (year < 1870) return { projection: 0.34, height: 0.52 };
  if (year <= 1920) return { projection: 0.42, height: 0.64 };
  return { projection: 0.30, height: 0.46 };
}

function eavesAtVertices(ring, edgeTops, edgeOffset) {
  const n = ring.length;
  return Array.from({ length: n }, (_, i) => Math.min(edgeTops[edgeOffset + ((i + n - 1) % n)], edgeTops[edgeOffset + i]));
}

function addBox(mesh, parts, id, center, along, across, yBottom, yTop, lengthAlong, widthAcross, material) {
  const hx = along[0] * lengthAlong * 0.5;
  const hz = along[1] * lengthAlong * 0.5;
  const wx = across[0] * widthAcross * 0.5;
  const wz = across[1] * widthAcross * 0.5;
  const lower = [
    [center[0] - hx - wx, yBottom, center[1] - hz - wz],
    [center[0] + hx - wx, yBottom, center[1] + hz - wz],
    [center[0] + hx + wx, yBottom, center[1] + hz + wz],
    [center[0] - hx + wx, yBottom, center[1] - hz + wz]
  ];
  const upper = lower.map(([x, , z]) => [x, yTop, z]);
  appendPart(mesh, parts, id, 'chimney', () => {
    addQuad(mesh, lower[0], lower[3], lower[2], lower[1], [0, -1, 0], material);
    addQuad(mesh, upper[0], upper[1], upper[2], upper[3], [0, 1, 0], material);
    const normals = [
      [-across[0], 0, -across[1]],
      [along[0], 0, along[1]],
      [across[0], 0, across[1]],
      [-along[0], 0, -along[1]]
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      addQuad(mesh, lower[i], lower[j], upper[j], upper[i], normals[i], material);
    }
  });
}

function keyPoint(p) {
  return `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;
}

/** Finds shared, near-horizontal edges between differently sloped roof triangles and merges their subdivisions. */
function ridgeLines(triangles) {
  const edges = new Map();
  let roofMax = -Infinity;
  const addEdge = (a, b, normal) => {
    const ka = keyPoint(a), kb = keyPoint(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    let edge = edges.get(key);
    if (!edge) { edge = { a, b, normals: [] }; edges.set(key, edge); }
    edge.normals.push(normal);
  };
  for (const tri of triangles) {
    const normal = triangleNormal(tri[0], tri[1], tri[2]);
    roofMax = Math.max(roofMax, tri[0][1], tri[1][1], tri[2][1]);
    for (let i = 0; i < 3; i++) addEdge(tri[i], tri[(i + 1) % 3], normal);
  }
  const segments = [];
  for (const edge of edges.values()) {
    if (edge.normals.length < 2) continue;
    const [a, b] = [edge.a, edge.b];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz);
    if (length < 0.25 || Math.abs(b[1] - a[1]) > 0.12 || (a[1] + b[1]) * 0.5 < roofMax - 0.35) continue;
    const n0 = edge.normals[0], n1 = edge.normals[1];
    const slope0 = Math.abs(n0[1]), slope1 = Math.abs(n1[1]);
    if (slope0 > 0.98 || slope1 > 0.98) continue;
    const ndot = Math.max(-1, Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
    if (Math.abs(ndot) > 0.985) continue;
    let ux = dx / length, uz = dz / length;
    if (ux < -1e-6 || (Math.abs(ux) <= 1e-6 && uz < 0)) { ux = -ux; uz = -uz; }
    const px = -uz, pz = ux;
    const ta = a[0] * ux + a[2] * uz;
    const tb = b[0] * ux + b[2] * uz;
    segments.push({ ux, uz, px, pz, offset: (a[0] + b[0]) * 0.5 * px + (a[2] + b[2]) * 0.5 * pz, lo: Math.min(ta, tb), hi: Math.max(ta, tb), y: (a[1] + b[1]) * 0.5 });
  }
  segments.sort((a, b) => a.ux - b.ux || a.uz - b.uz || a.offset - b.offset || a.y - b.y || a.lo - b.lo);
  const groups = [];
  for (const segment of segments) {
    let group = groups.find((g) => {
      const parallel = Math.abs(g.ux * segment.uz - g.uz * segment.ux) < 0.015;
      const collinear = Math.abs(g.offset - segment.offset) < 0.18;
      const joined = segment.lo <= g.hi + 0.18 && segment.hi >= g.lo - 0.18;
      return parallel && collinear && joined && Math.abs(g.y - segment.y) < 0.2;
    });
    if (!group) { group = { ...segment }; groups.push(group); }
    else {
      group.lo = Math.min(group.lo, segment.lo);
      group.hi = Math.max(group.hi, segment.hi);
      group.y = (group.y + segment.y) * 0.5;
    }
  }
  return groups.filter((g) => g.hi - g.lo >= 1.5).map((g) => ({ ...g, length: g.hi - g.lo }));
}

function addChimneys(mesh, parts, id, triangles) {
  const lines = ridgeLines(triangles);
  for (const line of lines) {
    const count = line.length < 16 ? 1 : Math.max(1, Math.round(line.length / 10));
    const spacing = line.length / count;
    for (let i = 0; i < count; i++) {
      const t = line.lo + spacing * (i + 0.5);
      const center = [line.ux * t + line.px * line.offset, line.uz * t + line.pz * line.offset];
      addBox(mesh, parts, id, center, [line.ux, line.uz], [line.px, line.pz], line.y - 0.65, line.y + 0.9, 0.8, 0.5, CHIMNEY_MATERIAL);
    }
  }
}

// Keep main's inferred entrance bay clear. The shader uses the same pier/bay fit and building hash.
// Shop plinths stop at the existing stall riser instead of covering the glazing above it.
function plinthOutline(building, ring, selected, height, layout) {
  if (!layout) return { ring, selected, tops: Array(ring.length).fill(building.ground + height) };
  const points = [], mask = [], edgeHeights = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const kind = layout.wallKinds?.[i]?.kind;
    const h = kind === KIND.shop ? Math.min(height, layout.groundH * 0.17) : height;
    points.push(p); mask.push(selected[i]); edgeHeights.push(h);
    if (!selected[i] || (kind !== KIND.entry && kind !== KIND.shop)) continue;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const pier = Math.min(FACADE_CORNER_PIER, len * 0.2);
    const bays = Math.max(1, Math.floor((len - 2 * pier) / layout.bayW + 0.5));
    const bay = (len - 2 * pier) / bays;
    const door = Math.min(Math.floor(layout.tone * bays), bays - 1);
    for (const [u, keep] of [[0.21, false], [0.79, true]]) {
      const t = (pier + (door + u) * bay) / len;
      points.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      mask.push(keep); edgeHeights.push(h);
    }
  }
  const tops = edgeHeights.map((h, i) => building.ground + Math.min(h, edgeHeights[(i + edgeHeights.length - 1) % edgeHeights.length]));
  return { ring: points, selected: mask, tops };
}

/** Adds cornices, plinths, the zinc eave band and eligible ridge chimneys to a detail stream. */
function appendBuildingDetails(mesh, parts, building, rings, edgeTops, streetEdges, roofTriangles, wallTone, layout = null) {
  const style = facadeStyle(building);
  if (!hasFacadeDetails(building, style)) return mesh.index.length;
  const id = building.id;
  const ring = rings[0];
  if (!ring || ring.length < 3) return 0;
  const n = ring.length;
  const selected = streetEdges ? streetEdges.slice(0, n) : Array(n).fill(true);
  const ground = building.ground;
  const eaves = eavesAtVertices(ring, edgeTops, 0);
  const year = building.year !== null && building.year !== undefined && Number.isFinite(Number(building.year)) ? Number(building.year) : null;
  const plinthHeight = Math.min(1.2, Math.max(0.6, building.facade?.plinth_h || (year !== null && year < 1950 ? 0.95 : 0.75)));
  const wallHeight = Math.min(...eaves) - ground;
  if (!Number.isFinite(wallHeight) || wallHeight < 0.75) return mesh.index.length;
  let cornice = corniceMetrics(year || 1900, style.era);
  // Keep the historic band below the gutter and above the plinth. Very low sheds do not have room for all three details.
  if (cornice && wallHeight < 0.18 + cornice.height + plinthHeight + 0.03) cornice = null;
  if (cornice) {
    const metrics = cornice;
    const tops = eaves.map((y) => y - 0.18);
    const bottoms = tops.map((y) => y - metrics.height);
    const color = (wallTone || [0.48, 0.4, 0.32]).map((v) => v * 0.9);
    appendRingBand(mesh, parts, id, 'cornice', ring, selected, bottoms, tops, metrics.projection, { color, rough: 0.88, metal: 0.01 });
  }

  const plinth = plinthOutline(building, ring, selected, plinthHeight, layout);
  appendRingBand(mesh, parts, id, 'plinth', plinth.ring, plinth.selected, Array(plinth.ring.length).fill(ground), plinth.tops, 0.04, PLINTH_MATERIAL);

  const gutterTops = eaves.map((y) => y - 0.035);
  const gutterProjection = cornice ? cornice.projection + 0.14 : 0.15;
  appendRingBand(mesh, parts, id, 'gutter', ring, selected, gutterTops.map((y) => y - 0.13), gutterTops, gutterProjection, GUTTER_MATERIAL);

  const pitched = roofTriangles.some((tri) => {
    const ny = triangleNormal(tri[0], tri[1], tri[2])[1];
    return ny < 0.98 && ny > 0.1;
  });
  if (year !== null && year < 1940 && pitched && roofTriangles.length) addChimneys(mesh, parts, id, roofTriangles);
  return mesh.index.length;
}

export { selectDetailEdges, appendBuildingDetails, outwardOffsetRing, ridgeLines };
