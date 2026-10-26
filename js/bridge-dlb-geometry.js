import { triangulatePolygon, pointInRing } from './polygon-cph.js';

// Dronning Louises Bro: dimensions are scaled from the inferred lake strip; the stone arch
// proportions are reconstructed from the heritage photographs and remain inferred.
export const DLB_ARCH = Object.freeze({
  count: 3,
  span: 7.2,
  rise: 1.6,
  pier: 1.3,
  ring: 0.4,
  parapet: 1.05,
  parapetThickness: 0.46,
  bodyThickness: 1.0,
  batter: 0.22
});

const SOURCE = 'https://kk.sites.itera.dk/apps/kk_monuments/pdf/190_db43_1.pdf';
const finite = (v) => Number.isFinite(v);
const median = (values) => {
  const a = values.filter(finite).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const pointAt = (s, t, axis, normal) => [axis[0] * s + normal[0] * t, axis[1] * s + normal[1] * t];

function stripAxis(ring, openEdges = []) {
  const edges = openEdges.length ? openEdges : Array.from({ length: ring.length / 2 }, (_, i) => i);
  const samples = edges.map((i) => {
    const j = (i + 1) % (ring.length / 2);
    const ax = ring[2 * i]; const az = ring[2 * i + 1];
    const bx = ring[2 * j]; const bz = ring[2 * j + 1];
    return { x: (ax + bx) / 2, z: (az + bz) / 2, weight: Math.hypot(bx - ax, bz - az) };
  }).filter((p) => p.weight > 1e-4);
  const totalWeight = samples.reduce((sum, p) => sum + p.weight, 0) || 1;
  const mx = samples.reduce((sum, p) => sum + p.x * p.weight, 0) / totalWeight;
  const mz = samples.reduce((sum, p) => sum + p.z * p.weight, 0) / totalWeight;
  let xx = 0; let zz = 0; let xz = 0;
  for (const sample of samples) {
    const x = sample.x - mx; const z = sample.z - mz;
    xx += sample.weight * x * x; zz += sample.weight * z * z; xz += sample.weight * x * z;
  }
  xx /= totalWeight; zz /= totalWeight; xz /= totalWeight;
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const axis = [Math.cos(angle), Math.sin(angle)];
  return { axis, normal: [-axis[1], axis[0]], centroid: [mx, mz] };
}

function segmentDistanceSquared(x, z, ax, az, bx, bz) {
  const dx = bx - ax; const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return (ax + t * dx - x) ** 2 + (az + t * dz - z) ** 2;
}

function namedRoadDirection(geo, center) {
  const graph = geo?.roadGraph;
  if (!graph?.links?.length) return null;
  let best = null;
  for (const link of graph.links) {
    const name = graph.names?.[link[6]] || '';
    if (!/nørrebro|dronning louises bro/i.test(name)) continue;
    const a = link[0]; const b = link[1];
    const ax = graph.nodes[a * 2]; const az = graph.nodes[a * 2 + 1];
    const bx = graph.nodes[b * 2]; const bz = graph.nodes[b * 2 + 1];
    const distance = segmentDistanceSquared(center[0], center[1], ax, az, bx, bz);
    if (!best || distance < best.distance) {
      const length = Math.hypot(bx - ax, bz - az) || 1;
      best = { distance, direction: [(bx - ax) / length, (bz - az) / length], name };
    }
  }
  return best;
}

function projectRing(ring, axis, normal) {
  const s = []; const t = [];
  for (let i = 0; i < ring.length; i += 2) {
    s.push(ring[i] * axis[0] + ring[i + 1] * axis[1]);
    t.push(ring[i] * normal[0] + ring[i + 1] * normal[1]);
  }
  return { s, t };
}

function stripSlice(ring, axis, normal, station) {
  const n = ring.length / 2;
  const crossings = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i]; const az = ring[2 * i + 1];
    const bx = ring[2 * j]; const bz = ring[2 * j + 1];
    const sa = ax * axis[0] + az * axis[1];
    const sb = bx * axis[0] + bz * axis[1];
    if ((sa <= station && sb > station) || (sb <= station && sa > station)) {
      const f = (station - sa) / (sb - sa);
      crossings.push((az + (bz - az) * f) * normal[1] + (ax + (bx - ax) * f) * normal[0]);
    }
  }
  crossings.sort((a, b) => a - b);
  if (crossings.length < 2) return null;
  return [crossings[0], crossings[crossings.length - 1]];
}

function polygonCentroid(ring) {
  let x = 0; let z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / (ring.length / 2), z / (ring.length / 2)];
}

function levelForBridge(lakesDoc, terrain) {
  const levels = new Map((terrain?.doc?.lakes || []).map((lake) => [lake.id, lake.level]));
  const main = (lakesDoc?.lakes || []).reduce((best, lake) => (!best || (lake.area_m2 || 0) > (best.area_m2 || 0) ? lake : best), null);
  const mainLevel = main ? levels.get(main.id) : null;
  if (finite(mainLevel)) return mainLevel;
  return -0.8;
}

function heritageLampRecords(furnitureDoc) {
  return (furnitureDoc?.lamps || []).filter((lamp) => /AMT El-gaslygte, Dr\. Louises bro/i.test(lamp.fixture || '')
    || /Lygtepæl Dr\. Louise/i.test(lamp.pole_text || ''));
}

function lampLayout(records, axis, normal) {
  if (records.length < 8) return null;
  const projected = records.map((lamp) => ({
    x: lamp.x, z: lamp.z, yaw: lamp.yaw,
    s: lamp.x * axis[0] + lamp.z * axis[1],
    t: lamp.x * normal[0] + lamp.z * normal[1],
    src: lamp.src?.[0] || null
  }));
  const byT = projected.slice().sort((a, b) => a.t - b.t);
  let split = 1; let largest = -Infinity;
  for (let i = 1; i < byT.length; i++) {
    const gap = byT[i].t - byT[i - 1].t;
    if (gap > largest) { largest = gap; split = i; }
  }
  const sides = [byT.slice(0, split), byT.slice(split)].sort((a, b) => median(a.map((p) => p.t)) - median(b.map((p) => p.t)));
  if (sides.some((side) => side.length !== 4)) return null;
  sides.forEach((side) => side.sort((a, b) => a.s - b.s));
  const stations = sides[0].map((lamp, i) => (lamp.s + sides[1][i].s) / 2);
  return {
    lamps: projected,
    sides: sides.map((side) => median(side.map((p) => p.t))),
    stations,
    archCenters: stations.slice(0, -1).map((s, i) => (s + stations[i + 1]) / 2),
    meanGap: median(stations.slice(1).map((s, i) => s - stations[i]))
  };
}

/** Fit the bridge to its water-facing strip edges and observed lamp stations. */
export function layoutBridgeDLB(geo, lakesDoc, { terrain = null, furnitureDoc = null } = {}) {
  const bridge = lakesDoc?.bridges?.filter((b) => b?.ring?.length >= 8 && b.open_edges?.length)
    .map((candidate) => {
      const road = namedRoadDirection(geo, polygonCentroid(candidate.ring));
      const matches = /nørrebrogade|dronning louises bro/i.test(road?.name || '');
      return { candidate, score: road ? road.distance + (matches ? 0 : 100000) : (candidate.id === 'bridge:0' ? 10000 : 20000) };
    }).sort((a, b) => a.score - b.score)[0]?.candidate;
  if (!bridge) return null;
  let { axis, normal } = stripAxis(bridge.ring, bridge.open_edges);
  const road = namedRoadDirection(geo, polygonCentroid(bridge.ring));
  if (road && dot(axis, road.direction) < 0) { axis = [-axis[0], -axis[1]]; normal = [-normal[0], -normal[1]]; }
  const projected = projectRing(bridge.ring, axis, normal);
  const sMin = Math.min(...projected.s); const sMax = Math.max(...projected.s);
  const stationFractions = [0.16, 0.25, 0.34, 0.43, 0.50, 0.57, 0.66, 0.75, 0.84];
  const slices = stationFractions.map((f) => stripSlice(bridge.ring, axis, normal, sMin + (sMax - sMin) * f)).filter(Boolean);
  const widths = slices.map(([a, b]) => b - a);
  const widthM = median(widths);
  const centers = slices.map(([a, b]) => (a + b) / 2);
  const centerT = median(centers);
  const deckY = terrain?.deckHeight?.(bridge.id) ?? 0.02;
  const waterY = levelForBridge(lakesDoc, terrain);
  const lengthM = sMax - sMin;
  const bodyTopY = deckY - (!terrain || terrain.flat ? 0.05 : 0.40);
  const springY = Math.min(waterY + 0.16, bodyTopY - DLB_ARCH.ring - 0.20);
  const rise = Math.max(0.08, Math.min(DLB_ARCH.rise, bodyTopY - springY - DLB_ARCH.ring - 0.08));
  const observedLamps = lampLayout(heritageLampRecords(furnitureDoc), axis, normal);
  const lampStations = observedLamps?.stations || [-1.5, -0.5, 0.5, 1.5].map((f) => (sMin + sMax) / 2 + (DLB_ARCH.span + DLB_ARCH.pier) * f);
  const inferredSpan = observedLamps ? Math.max(5.5, Math.min(8, observedLamps.meanGap - DLB_ARCH.pier)) : DLB_ARCH.span;
  const archCenters = observedLamps?.archCenters || (() => {
    const group = DLB_ARCH.count * inferredSpan + (DLB_ARCH.count - 1) * DLB_ARCH.pier;
    const start = (sMin + sMax - group) / 2;
    return Array.from({ length: DLB_ARCH.count }, (_, i) => start + inferredSpan / 2 + i * (inferredSpan + DLB_ARCH.pier));
  })();
  const arches = Array.from({ length: DLB_ARCH.count }, (_, i) => {
    const span = inferredSpan;
    const centerS = archCenters[i];
    return {
      index: i,
      centerS,
      span,
      rise,
      pier: DLB_ARCH.pier,
      ring: DLB_ARCH.ring,
      springY,
      crownY: springY + rise,
      opening: 'elliptic-segment'
    };
  });
  return {
    bridgeId: bridge.id,
    stripRing: bridge.ring,
    openEdges: bridge.open_edges,
    axis,
    normal,
    sMin,
    sMax,
    centerS: (sMin + sMax) / 2,
    centerT,
    lengthM,
    widthM,
    deckY,
    pavementY: deckY + 0.20,
    waterY,
    bodyTopY,
    bodyBottomY: waterY - 0.58,
    parapetHeight: DLB_ARCH.parapet,
    parapetTopY: deckY + 0.20 + DLB_ARCH.parapet,
    parapetThickness: DLB_ARCH.parapetThickness,
    bodyThickness: DLB_ARCH.bodyThickness,
    batter: DLB_ARCH.batter,
    arches,
    lampStations,
    heritageLamps: observedLamps?.lamps || [],
    lampSides: observedLamps?.sides || [centerT - widthM / 2, centerT + widthM / 2],
    archSpan: inferredSpan,
    benchPositions: (furnitureDoc?.benches || []).filter((bench) => pointInRing(bridge.ring, bench.x, bench.z)).map((bench) => ({
      x: bench.x, z: bench.z, yaw: bench.yaw, length: bench.length || 1.8, src: bench.src?.[0] || null
    })),
    sourceRoad: road?.name || 'strip-axis fallback'
  };
}

function part() { return { position: [], uv: [], kind: [], index: [] }; }

function addVertex(target, p, uv, kind = 0) {
  const index = target.position.length / 3;
  target.position.push(p[0], p[1], p[2]);
  target.uv.push(uv[0], uv[1]);
  target.kind.push(kind);
  return index;
}

function addQuad(target, points, uv = null, kind = 0) {
  const coords = uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
  const base = target.position.length / 3;
  for (let i = 0; i < 4; i++) addVertex(target, points[i], coords[i], kind);
  target.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function addBox(target, layout, { s, t, y, size, kind = 0, angle = 0 }) {
  const [ls, lt, h] = size;
  const c = Math.cos(angle); const sn = Math.sin(angle);
  const corners = [[-ls / 2, -lt / 2], [ls / 2, -lt / 2], [ls / 2, lt / 2], [-ls / 2, lt / 2]]
    .map(([a, b]) => [s + a * c - b * sn, t + a * sn + b * c]);
  const lo = corners.map(([a, b]) => pointAt(a, b, layout.axis, layout.normal));
  const lower = lo.map(([x, z]) => [x, y - h / 2, z]);
  const upper = lo.map(([x, z]) => [x, y + h / 2, z]);
  // Explicit outward winding in the (s,t,y) frame. Since s × t points down,
  // the top face runs against the corner order used to lay out the footprint.
  addQuad(target, [lower[0], upper[0], upper[1], lower[1]], null, kind);
  addQuad(target, [lower[1], upper[1], upper[2], lower[2]], null, kind);
  addQuad(target, [lower[2], upper[2], upper[3], lower[3]], null, kind);
  addQuad(target, [lower[3], upper[3], upper[0], lower[0]], null, kind);
  addQuad(target, [upper[0], upper[3], upper[2], upper[1]], null, kind);
  addQuad(target, [lower[0], lower[1], lower[2], lower[3]], null, kind);
}

function appendProfilePolygon(target, profile, layout, side, faceT, kind = 0) {
  const flat = profile.flatMap(([s, y]) => [s, y]);
  const { pts, idx } = triangulatePolygon(flat);
  const base = target.position.length / 3;
  for (let i = 0; i < pts.length; i += 2) {
    const s = pts[i]; const y = pts[i + 1];
    const t = faceT(s, y, side);
    const [x, z] = pointAt(s, t, layout.axis, layout.normal);
    addVertex(target, [x, y, z], [s, y - layout.waterY], kind);
  }
  for (let i = 0; i < idx.length; i += 3) {
    if (side > 0) target.index.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
    else target.index.push(base + idx[i], base + idx[i + 2], base + idx[i + 1]);
  }
}

function mergeParts(a, b) {
  const out = part();
  for (const source of [a, b]) {
    const base = out.position.length / 3;
    out.position.push(...source.position); out.uv.push(...source.uv); out.kind.push(...source.kind);
    for (const i of source.index) out.index.push(base + i);
  }
  return out;
}

function addArchRing(target, mortar, layout, arch, side, faceT, innerFaceT) {
  const half = arch.span / 2;
  const steps = 18;
  const thickness = arch.ring;
  const tOuter = faceT(arch.centerS, arch.springY, side);
  const tInner = innerFaceT(arch.centerS, arch.springY, side);
  // Carry the voussoirs through the full battered wall thickness so their backs
  // meet the barrel vault without a dark unmodeled gap.
  const ringDepth = Math.abs(tOuter - tInner);
  const depthBack = tOuter - side * ringDepth;
  const inner = []; const outer = [];
  for (let i = 0; i <= steps; i++) {
    const theta = Math.PI - Math.PI * i / steps;
    inner.push([arch.centerS + half * Math.cos(theta), arch.springY + arch.rise * Math.sin(theta)]);
    outer.push([arch.centerS + (half + thickness) * Math.cos(theta), arch.springY + (arch.rise + thickness) * Math.sin(theta)]);
  }
  const gap = 0.008;
  for (let i = 0; i < steps; i++) {
    const theta0 = Math.PI - Math.PI * i / steps - gap;
    const theta1 = Math.PI - Math.PI * (i + 1) / steps + gap;
    const point = (radiusS, radiusY, theta) => [arch.centerS + radiusS * Math.cos(theta), arch.springY + radiusY * Math.sin(theta)];
    const p = [point(half, arch.rise, theta0), point(half, arch.rise, theta1), point(half + thickness, arch.rise + thickness, theta1), point(half + thickness, arch.rise + thickness, theta0)];
    appendProfilePolygon(target, p, layout, side, () => tOuter, 3);
  }
  // Recessed radial joints and caps make the individual voussoirs visible at either mouth.
  for (let i = 0; i <= steps; i++) {
    const theta = Math.PI - Math.PI * i / steps;
    const innerPoint = [arch.centerS + half * Math.cos(theta), arch.springY + arch.rise * Math.sin(theta)];
    const outerPoint = [arch.centerS + (half + thickness) * Math.cos(theta), arch.springY + (arch.rise + thickness) * Math.sin(theta)];
    const [xi, zi] = pointAt(innerPoint[0], tOuter, layout.axis, layout.normal);
    const [xo, zo] = pointAt(outerPoint[0], tOuter, layout.axis, layout.normal);
    const [xob, zob] = pointAt(outerPoint[0], depthBack, layout.axis, layout.normal);
    const [xib, zib] = pointAt(innerPoint[0], depthBack, layout.axis, layout.normal);
    addQuad(mortar, [[xi, innerPoint[1], zi], [xo, outerPoint[1], zo], [xob, outerPoint[1], zob], [xib, innerPoint[1], zib]]);

    // A fine dark strip stays legible from the lake side even when the radial
    // depth cap itself is viewed nearly edge-on.
    if (i > 0 && i < steps) {
      const stripHalf = gap * 0.48;
      const radial = (radiusS, radiusY, angle) => [
        arch.centerS + radiusS * Math.cos(angle), arch.springY + radiusY * Math.sin(angle)
      ];
      const p0 = radial(half, arch.rise, theta - stripHalf);
      const p1 = radial(half + thickness, arch.rise + thickness, theta - stripHalf);
      const p2 = radial(half + thickness, arch.rise + thickness, theta + stripHalf);
      const p3 = radial(half, arch.rise, theta + stripHalf);
      appendProfilePolygon(mortar, [p0, p1, p2, p3], layout, side, () => tOuter);
    }
  }
  return { inner, outer, tOuter, tInner, depthBack };
}

function addVault(target, layout, arch, innerT0, innerT1) {
  const steps = 18;
  const half = arch.span / 2;
  for (let i = 0; i < steps; i++) {
    const a0 = Math.PI - Math.PI * i / steps;
    const a1 = Math.PI - Math.PI * (i + 1) / steps;
    const ss = [arch.centerS + half * Math.cos(a0), arch.centerS + half * Math.cos(a1)];
    const yy = [arch.springY + arch.rise * Math.sin(a0), arch.springY + arch.rise * Math.sin(a1)];
    const [x00, z00] = pointAt(ss[0], innerT0, layout.axis, layout.normal);
    const [x10, z10] = pointAt(ss[1], innerT0, layout.axis, layout.normal);
    const [x11, z11] = pointAt(ss[1], innerT1, layout.axis, layout.normal);
    const [x01, z01] = pointAt(ss[0], innerT1, layout.axis, layout.normal);
    addQuad(target, [[x00, yy[0], z00], [x10, yy[1], z10], [x11, yy[1], z11], [x01, yy[0], z01]],
      [[ss[0], innerT0], [ss[1], innerT0], [ss[1], innerT1], [ss[0], innerT1]], 0);
  }
}

function addBeam(target, a, b, width, depth, across) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d) || 1;
  const tangent = d.map((v) => v / len);
  let side = across || [1, 0, 0];
  const sideLen = Math.hypot(...side) || 1;
  side = side.map((v) => v / sideLen);
  const normal = [tangent[1] * side[2] - tangent[2] * side[1], tangent[2] * side[0] - tangent[0] * side[2], tangent[0] * side[1] - tangent[1] * side[0]];
  const nLen = Math.hypot(...normal) || 1;
  const n = normal.map((v) => v / nLen);
  const point = (p, u, v) => [p[0] + side[0] * u * width / 2 + n[0] * v * depth / 2,
    p[1] + side[1] * u * width / 2 + n[1] * v * depth / 2,
    p[2] + side[2] * u * width / 2 + n[2] * v * depth / 2];
  const q = [point(a, -1, -1), point(a, 1, -1), point(a, 1, 1), point(a, -1, 1), point(b, -1, -1), point(b, 1, -1), point(b, 1, 1), point(b, -1, 1)];
  addQuad(target, [q[0], q[1], q[5], q[4]]);
  addQuad(target, [q[1], q[2], q[6], q[5]]);
  addQuad(target, [q[2], q[3], q[7], q[6]]);
  addQuad(target, [q[3], q[0], q[4], q[7]]);
  addQuad(target, [q[0], q[1], q[2], q[3]]);
  addQuad(target, [q[4], q[7], q[6], q[5]]);
}

function addBench(parts, layout, station, side, curved = false, explicitT = null, benchLength = 1.8, terrain = null) {
  const t = explicitT ?? layout.centerT + side * (layout.widthM / 2 - 1.12);
  const [bx, bz] = pointAt(station, t, layout.axis, layout.normal);
  const baseY = terrain ? terrain.heightAt(bx, bz) + 0.20 : layout.pavementY;
  const y = baseY + 0.47;
  const segmentCount = curved ? 5 : 1;
  for (let i = 0; i < segmentCount; i++) {
    const f = segmentCount === 1 ? 0 : i / (segmentCount - 1) - 0.5;
    const s = station + f * (curved ? benchLength * 0.92 : 0);
    const angle = curved ? f * 0.48 : 0;
    for (let slat = 0; slat < 4; slat++) {
      const seatT = t + side * (slat - 1.5) * 0.095;
      addBox(parts.wood, layout, { s, t: seatT, y, size: [curved ? benchLength / segmentCount + 0.05 : benchLength, 0.075, 0.065], angle });
    }
    const armOffset = Math.max(0.55, benchLength / 2 - 0.10);
    for (const armSide of [-1, 1]) {
      addBox(parts.iron, layout, { s: s + armSide * (curved ? 0.18 : armOffset), t, y: baseY + 0.37, size: [0.11, 0.10, 0.74], angle });
      addBox(parts.iron, layout, { s: s + armSide * (curved ? 0.18 : armOffset), t: t + side * 0.12, y: baseY + 0.68, size: [0.10, 0.34, 0.09], angle });
    }
    if (!curved) {
      for (let slat = 0; slat < 3; slat++) addBox(parts.wood, layout, { s, t: t + side * (0.22 + slat * 0.08), y: baseY + 0.80 + slat * 0.09, size: [benchLength, 0.075, 0.065] });
    }
  }
}

function addRamp(parts, layout, signS, side, terrain) {
  const startS = signS < 0 ? layout.sMin + 3.0 : layout.sMax - 3.0;
  const t0 = layout.centerT + side * (layout.widthM / 2 - 1.0);
  const begin = pointAt(startS, t0, layout.axis, layout.normal);
  const end = pointAt(startS + signS * 10, t0 + side * 5, layout.axis, layout.normal);
  const y0 = terrain ? terrain.heightAt(...begin) + 0.20 : layout.pavementY;
  const y1 = Math.max(layout.waterY + 0.22, terrain ? terrain.heightAt(...end) + 0.03 : layout.waterY + 0.22);
  const samples = [];
  const steps = 16;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps, angle = f * Math.PI / 2;
    const s = startS + signS * 10 * (1 - Math.cos(angle));
    const t = t0 + side * 5 * Math.sin(angle);
    const ds = signS * 10 * Math.sin(angle), dt = side * 5 * Math.cos(angle);
    const length = Math.hypot(ds, dt);
    const y = y0 + (y1 - y0) * f;
    samples.push([-1, 1].map((edge) => {
      const [x, z] = pointAt(s - dt / length * edge * 1.2, t + ds / length * edge * 1.2, layout.axis, layout.normal);
      return [x, y, z];
    }));
  }
  const raised = (p, h) => [p[0], p[1] + h, p[2]];
  for (let k = 0; k < steps; k++) {
    addQuad(parts.granite, [samples[k][0], samples[k + 1][0], samples[k + 1][1], samples[k][1]], null, 1);
    for (let edge = 0; edge < 2; edge++) {
      const a = samples[k][edge], b = samples[k + 1][edge];
      addQuad(parts.granite, [raised(a, 0.12), raised(b, 0.12), raised(b, -0.45), raised(a, -0.45)]);
      addBeam(parts.iron, raised(a, 0.90), raised(b, 0.90), 0.055, 0.055, [0, 1, 0]);
      if (k % 2 === 0) addBeam(parts.iron, a, raised(a, 0.90), 0.045, 0.045, [layout.axis[0], 0, layout.axis[1]]);
    }
  }
}

function makeMetadata(layout) {
  const dimensions = {
    lengthM: { value: Number(layout.lengthM.toFixed(2)), confidence: 'scaled', source: 'projected cph-lakes bridge strip (source strip conf=inferred)' },
    widthM: { value: Number(layout.widthM.toFixed(2)), confidence: 'scaled', source: 'median cross-section of cph-lakes bridge strip (source strip conf=inferred)' },
    deckY: { value: layout.deckY, confidence: layout.deckY === 0.02 ? 'fallback' : 'measured', source: 'cph-terrain bridge deck' },
    waterY: { value: Number(layout.waterY.toFixed(2)), confidence: layout.waterY === -0.8 ? 'fallback' : 'measured', source: 'nearby cph-terrain lake levels' },
    archCount: { value: DLB_ARCH.count, confidence: 'observed', source: SOURCE },
    archSpanM: { value: layout.archSpan, confidence: layout.heritageLamps.length ? 'inferred from observed lamp stations' : 'inferred', source: layout.heritageLamps.length ? 'spacing between observed heritage lamps minus 1.3 m pier' : 'heritage photographs and strip fit' },
    archRiseM: { value: layout.arches[0]?.rise ?? DLB_ARCH.rise, confidence: 'inferred', source: 'heritage photographs and available deck clearance' },
    pierM: { value: DLB_ARCH.pier, confidence: 'inferred', source: 'heritage photographs' },
    voussoirThicknessM: { value: DLB_ARCH.ring, confidence: 'inferred', source: 'heritage photographs' },
    parapetHeightM: { value: DLB_ARCH.parapet, confidence: 'inferred', source: 'heritage photographs' }
  };
  return {
    name: 'Dronning Louises Bro',
    bridgeId: layout.bridgeId,
    source: SOURCE,
    dimensions,
    axis: layout.axis,
    sourceRoad: layout.sourceRoad,
    features: { arches: DLB_ARCH.count, heritageLamps: layout.heritageLamps.length || 8, benches: layout.benchPositions.length || 8, cornerRamps: 4, flagpoles: 4 },
    note: 'The bridge strip is inferred geometry; its projected dimensions are scaled. Arch proportions are inferred; terrain heights and heritage lamp positions are observed.'
  };
}

/** Pure, node-importable bridge layout and merged geometry. No THREE or browser APIs are used here. */
export function buildBridgeDLBGeometry(geo, lakesDoc, { terrain = null, furnitureDoc = null } = {}) {
  const layout = layoutBridgeDLB(geo, lakesDoc, { terrain, furnitureDoc });
  if (!layout) return null;
  const parts = { granite: part(), facade: part(), mortar: part(), iron: part(), wood: part(), fabric: part() };
  const halfWidth = layout.widthM / 2;
  const bodyTop = layout.bodyTopY;
  const faceT = (s, y, side) => layout.centerT + side * (halfWidth - layout.bodyThickness / 2 + layout.batter * Math.max(0, Math.min(1, (bodyTop - y) / (bodyTop - layout.bodyBottomY))));
  const innerFaceT = (s, y, side) => faceT(s, y, side) - side * layout.bodyThickness;
  const topY = bodyTop;

  // Long granite causeways and the three small central arch bays. The side face is
  // assembled around the arch profile, leaving real open polygons below each crown.
  for (const side of [-1, 1]) {
    const breaks = [layout.sMin];
    for (const arch of layout.arches) breaks.push(arch.centerS - arch.span / 2 - arch.ring, arch.centerS + arch.span / 2 + arch.ring);
    breaks.push(layout.sMax);
    for (let i = 0; i < breaks.length; i += 2) {
      const a = breaks[i]; const b = breaks[i + 1];
      if (b - a <= 0.02) continue;
      const profile = [[a, layout.bodyBottomY], [b, layout.bodyBottomY], [b, topY], [a, topY]];
      appendProfilePolygon(parts.facade, profile, layout, side, faceT, 0);
      appendProfilePolygon(parts.facade, profile, layout, side, innerFaceT, 0);
    }
    for (const arch of layout.arches) {
      const curve = [];
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const theta = Math.PI - Math.PI * i / steps;
        curve.push([arch.centerS + (arch.span / 2 + arch.ring) * Math.cos(theta), arch.springY + (arch.rise + arch.ring) * Math.sin(theta)]);
      }
      const left = curve[0][0]; const right = curve[curve.length - 1][0];
      const panel = [...curve, [right, topY], [left, topY]];
      appendProfilePolygon(parts.facade, panel, layout, side, faceT, 0);
      appendProfilePolygon(parts.facade, panel, layout, side, innerFaceT, 0);
      addArchRing(parts.granite, parts.mortar, layout, arch, side, faceT, innerFaceT);
    }
  }

  // Close the cut ends of the bridge body beneath the road and form the four
  // vertical jamb/reveal planes at each arch spring across the full tunnel width.
  const at = (s, t, y) => {
    const [x, z] = pointAt(s, t, layout.axis, layout.normal);
    return [x, y, z];
  };
  for (const s of [layout.sMin, layout.sMax]) {
    addQuad(parts.granite, [
      at(s, faceT(s, layout.bodyBottomY, -1), layout.bodyBottomY),
      at(s, faceT(s, layout.bodyBottomY, 1), layout.bodyBottomY),
      at(s, faceT(s, bodyTop, 1), bodyTop),
      at(s, faceT(s, bodyTop, -1), bodyTop)
    ], null, 0);
  }
  for (const arch of layout.arches) {
    for (const sign of [-1, 1]) {
      const s = arch.centerS + sign * arch.span / 2;
      const tLeft = faceT(s, arch.springY, -1);
      const tRight = faceT(s, arch.springY, 1);
      addQuad(parts.granite, [
        at(s, faceT(s, layout.bodyBottomY, -1), layout.bodyBottomY),
        at(s, faceT(s, layout.bodyBottomY, 1), layout.bodyBottomY),
        at(s, tRight, arch.springY),
        at(s, tLeft, arch.springY)
      ], null, 0);
    }
  }
  parts.granite = mergeParts(parts.granite, parts.facade);

  // Barrel vaults link the two open faces. Each section is radial and leaves the
  // opening below the intrados clear for the continuous lake water surface.
  for (const arch of layout.arches) {
    const tInnerLeft = innerFaceT(arch.centerS, arch.springY, -1);
    const tInnerRight = innerFaceT(arch.centerS, arch.springY, 1);
    addVault(parts.granite, layout, arch, tInnerLeft, tInnerRight);
  }

  // Underside of the roadway deck, kept above the arch extrados; no top deck is emitted.
  const deckUnderside = layout.bodyTopY;
  const left = pointAt(layout.sMin, layout.centerT - halfWidth, layout.axis, layout.normal);
  const right = pointAt(layout.sMax, layout.centerT - halfWidth, layout.axis, layout.normal);
  const right2 = pointAt(layout.sMax, layout.centerT + halfWidth, layout.axis, layout.normal);
  const left2 = pointAt(layout.sMin, layout.centerT + halfWidth, layout.axis, layout.normal);
  addQuad(parts.granite, [[left[0], deckUnderside, left[1]], [right[0], deckUnderside, right[1]], [right2[0], deckUnderside, right2[1]], [left2[0], deckUnderside, left2[1]]], null, 2);

  // Solid parapets and projecting coping. Openings are only below the deck; the parapet has no iron fence.
  const rampStations = [layout.sMin + 3.0, layout.sMax - 3.0].sort((a, b) => a - b);
  for (const side of [-1, 1]) {
    const railT = layout.centerT + side * (halfWidth - 0.31);
    const parapetSegments = [];
    let cursor = layout.sMin;
    for (const s of rampStations.filter((value) => value > layout.sMin + 1.45 && value < layout.sMax - 1.45)) {
      if (s - 1.42 > cursor) parapetSegments.push([cursor, s - 1.42]);
      cursor = Math.max(cursor, s + 1.42);
    }
    if (cursor < layout.sMax) parapetSegments.push([cursor, layout.sMax]);
    for (const [a, b] of parapetSegments) {
      if (b <= a) continue;
      addBox(parts.granite, layout, { s: (a + b) / 2, t: railT, y: layout.pavementY + (layout.parapetHeight - 0.22) / 2, size: [b - a, DLB_ARCH.parapetThickness, layout.parapetHeight - 0.22] });
      addBox(parts.granite, layout, { s: (a + b) / 2, t: railT, y: layout.parapetTopY - 0.11, size: [b - a, DLB_ARCH.parapetThickness + 0.30, 0.22], kind: 1 });
    }
    // Projecting cornice fascia closes the measured road deck to the parapet base.
    addBox(parts.granite, layout, { s: layout.centerS, t: layout.centerT + side * (halfWidth - 0.34), y: (layout.bodyTopY + layout.pavementY) / 2, size: [layout.lengthM, 0.82, layout.pavementY - layout.bodyTopY], kind: 1 });
    for (const s of layout.lampStations) {
      addBox(parts.granite, layout, { s, t: railT, y: layout.pavementY + 0.54, size: [0.78, DLB_ARCH.parapetThickness + 0.16, 1.08] });
    }
  }

  // Four descending stone-faced corner ramps with thin iron handrails.
  for (const sSign of [-1, 1]) for (const side of [-1, 1]) addRamp(parts, layout, sSign, side, terrain);

  // Surveyed deck benches and segmented corner seats. These replace
  // only furniture records whose measured points fall inside the bridge strip.
  if (layout.benchPositions.length) {
    for (const bench of layout.benchPositions) {
      const s = bench.x * layout.axis[0] + bench.z * layout.axis[1];
      const t = bench.x * layout.normal[0] + bench.z * layout.normal[1];
      const side = Math.sign(t - layout.centerT) || 1;
      addBench(parts, layout, s, side, false, t - side * 0.45, bench.length, terrain);
    }
    for (const side of [-1, 1]) for (const sign of [-1, 1]) {
      const station = sign < 0 ? layout.sMin + 10.5 : layout.sMax - 10.5;
      const t = layout.centerT + side * (halfWidth - 1.12);
      const hasNearbyBench = layout.benchPositions.some((bench) => {
        const s = bench.x * layout.axis[0] + bench.z * layout.axis[1];
        const bt = bench.x * layout.normal[0] + bench.z * layout.normal[1];
        return Math.abs(s - station) < 3.2 && Math.sign(bt - layout.centerT) === side;
      });
      if (!hasNearbyBench) addBench(parts, layout, station, side, true, t, 2.2, terrain);
    }
  } else {
    for (const side of [-1, 1]) {
      for (const fraction of [-0.25, 0.25]) addBench(parts, layout, layout.centerS + layout.lengthM * fraction, side, false, null, 1.8, terrain);
      for (const sSign of [-1, 1]) addBench(parts, layout, sSign < 0 ? layout.sMin + 10.5 : layout.sMax - 10.5, side, true, null, 2.2, terrain);
    }
  }

  // Four white end flagpoles with dark decorative footings.
  for (const sSign of [-1, 1]) for (const side of [-1, 1]) {
    const s = sSign < 0 ? layout.sMin + 1.6 : layout.sMax - 1.6;
    const t = layout.centerT + side * (halfWidth - 1.1);
    addBox(parts.iron, layout, { s, t, y: layout.pavementY + 0.18, size: [0.62, 0.62, 0.36] });
    const p = pointAt(s, t, layout.axis, layout.normal);
    addBeam(parts.fabric, [p[0], layout.pavementY + 0.36, p[1]], [p[0], layout.pavementY + 7.45, p[1]], 0.085, 0.085,
      [layout.axis[0], 0, layout.axis[1]]);
  }

  const metadata = makeMetadata(layout);
  return {
    layout,
    metadata,
    parts,
    openings: layout.arches.map((arch) => ({
      centerS: arch.centerS,
      springY: arch.springY,
      crownY: arch.crownY,
      halfSpan: arch.span / 2,
      rise: arch.rise,
      innerCurve: Array.from({ length: 25 }, (_, i) => {
        const theta = Math.PI - Math.PI * i / 24;
        return [arch.centerS + arch.span / 2 * Math.cos(theta), arch.springY + arch.rise * Math.sin(theta)];
      })
    }))
  };
}

/** True only for a feature physically inside the bridge strip footprint. */
export function isBridgeDLBPoint(layout, x, z) {
  return !!layout?.stripRing && finite(x) && finite(z) && pointInRing(layout.stripRing, x, z);
}

/** Filters bridge-overlapping default lamps and benches without changing the loaded document. */
export function filterDLBFurniture(doc, layout) {
  if (!doc || !layout) return doc;
  const removed = { lamps: 0, benches: 0 };
  const modeledLampIds = new Set((layout.heritageLamps || []).map((lamp) => lamp.src).filter(Boolean));
  const filter = (key) => (doc[key] || []).filter((item) => {
    const inStrip = isBridgeDLBPoint(layout, item.x, item.z);
    const heritageLamp = key === 'lamps' && (/AMT El-gaslygte, Dr\. Louises bro/i.test(item.fixture || '') || /Lygtepæl Dr\. Louise/i.test(item.pole_text || ''));
    const idMatch = (item.src || []).some((src) => modeledLampIds.has(src));
    const inside = key === 'benches' ? inStrip : heritageLamp && (idMatch || (inStrip && !modeledLampIds.size));
    if (inside) removed[key]++;
    return !inside;
  });
  const result = { ...doc, lamps: filter('lamps'), benches: filter('benches') };
  result.bridgeDLBFiltered = removed;
  return result;
}
