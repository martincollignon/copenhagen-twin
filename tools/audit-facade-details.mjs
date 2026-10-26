// Run with node tools/audit-facade-details.mjs. Counts geometry; this is not a rendered FPS benchmark.
import { readFile } from 'node:fs/promises';
import { createAccumulator, addBuilding, cleanRing } from '../js/building-geometry.js';
import { createContext, classifyWalls } from '../js/groundfloor.js';
import { selectDetailEdges } from '../js/building-details.js';
import { loadLod2 } from '../js/lod2-geometry.js';

const geo = JSON.parse(await readFile(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
const localFetch = async (url) => {
  try {
    const bytes = await readFile(new URL(`../${url.replace(/^\.\//, '')}`, import.meta.url));
    return { ok: true, json: async () => JSON.parse(bytes.toString('utf8')), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  } catch { return { ok: false }; }
};
const lod = await loadLod2('./data/lod2', localFetch);
if (!lod) throw new Error('The local LoD2 data is required for this audit');
await lod.prefetch();
const venueResponse = await localFetch('./data/cph-groundfloor.json');
const venues = venueResponse.ok ? (await venueResponse.json()).venues || [] : [];
const ground = createContext({ roads: geo.roads || [], buildings: geo.buildings || [], venues });
const acc = createAccumulator();
let baseline = 0, lodCount = 0, selectedEdges = 0, maxSelected = 0;
for (const b of geo.buildings || []) {
  const rings = [cleanRing(b.ring, true), ...(b.holes || []).map((h) => cleanRing(h, false)).filter(Boolean)];
  if (!rings[0]) continue;
  const wallKinds = classifyWalls(b, rings, ground);
  const mask = selectDetailEdges(rings, wallKinds);
  selectedEdges += mask.filter(Boolean).length;
  maxSelected = Math.max(maxSelected, mask.filter(Boolean).length);
  const rec = lod ? await lod.ready(b.id) : null;
  if (rec) lodCount++;
  const added = addBuilding(acc, b, { ...(rec ? { lod2: rec } : {}), wallKinds });
  if (added) baseline += added.wallTriangles + added.roofTriangles - added.detailTriangles;
}
const pos = acc.roof.position, normal = acc.roof.normal, index = acc.roof.index;
const kindTriangles = {};
let badParts = 0, openEdges = 0, degenerateTriangles = 0, badWinding = 0, nonPositiveVolumes = 0;
const pointKey = (v) => [0, 1, 2].map((k) => Math.round(pos[v * 3 + k] * 1000)).join(',');
for (const part of acc.detailParts) {
  kindTriangles[part.kind] = (kindTriangles[part.kind] || 0) + (part.end - part.start) / 3;
  const edges = new Map();
  let volume6 = 0, invalid = false;
  for (let i = part.start; i < part.end; i += 3) {
    const ids = [index[i], index[i + 1], index[i + 2]];
    const points = ids.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    const u = points[1].map((x, k) => x - points[0][k]);
    const v = points[2].map((x, k) => x - points[0][k]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area2 = Math.hypot(...cross);
    if (!Number.isFinite(area2) || area2 <= 1e-8) { degenerateTriangles++; invalid = true; }
    for (const id of ids) {
      const n = [normal[id * 3], normal[id * 3 + 1], normal[id * 3 + 2]];
      if (!n.every(Number.isFinite) || Math.abs(Math.hypot(...n) - 1) > 1e-5 || cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] <= area2 * 0.999) { badWinding++; invalid = true; }
    }
    volume6 += points[0][0] * (points[1][1] * points[2][2] - points[1][2] * points[2][1]) + points[0][1] * (points[1][2] * points[2][0] - points[1][0] * points[2][2]) + points[0][2] * (points[1][0] * points[2][1] - points[1][1] * points[2][0]);
    for (let e = 0; e < 3; e++) {
      const a = pointKey(ids[e]), b = pointKey(ids[(e + 1) % 3]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const dir = a < b ? 1 : -1;
      const state = edges.get(key) || { count: 0, direction: 0 };
      state.count++;
      state.direction += dir;
      edges.set(key, state);
    }
  }
  const open = [...edges.values()].filter((e) => e.count !== 2 || e.direction !== 0).length;
  if (open) { openEdges += open; invalid = true; }
  if (!Number.isFinite(volume6) || volume6 / 6 <= 1e-7) { nonPositiveVolumes++; invalid = true; }
  if (invalid) badParts++;
}
// Main colour pass, two sun shadow cascades, and the lake reflection colour pass.
// water-cph.js disables shadow updates during reflection. Counting every detail in all four is conservative.
const detailTriangles = Object.values(kindTriangles).reduce((sum, n) => sum + n, 0);
const renderedUpperEstimate = detailTriangles * 4;
const budgetLimit = 6_000_000 * 0.08;
const budgetPass = renderedUpperEstimate <= budgetLimit;
const result = {
  buildings: geo.buildings.length, roads: geo.roads.length, lod2Buildings: lodCount,
  baselineWallRoofTriangles: baseline, selectedOuterEdges: selectedEdges, maxSelectedPerBuilding: maxSelected,
  detailTriangles, renderedUpperEstimate, addedPercent: renderedUpperEstimate / 6_000_000 * 100, budgetLimit, budgetPass, kindTriangles,
  detailParts: acc.detailParts.length,
  closure: { badParts, openDirectedEdges: openEdges, degenerateTriangles, badWinding, nonPositiveVolumes }
};
console.log(JSON.stringify(result, null, 2));
if (!budgetPass || badParts) process.exitCode = 1;
