import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { WATER, KIND, extendBeyondBbox, buildLakeArrays, groundWithHoles, inLake, shoreDistanceField, applySurfaceCuts } from '../js/lakes-cph.js';
import { trianglesArea, ringArea, pointInRing } from '../js/polygon-cph.js';
import { createTerrain } from '../js/terrain-cph.js';

const doc = JSON.parse(readFileSync(new URL('../data/cph-lakes.json', import.meta.url), 'utf8'));
const terrainDoc = JSON.parse(readFileSync(new URL('../data/cph-terrain.json', import.meta.url), 'utf8'));
const BBOX = [-750, -750, 750, 750];
// a 40 x 40 lake (counter-clockwise seen from above: negative shoelace in x/z)
const SQUARE = { lakes: [{ id: 't', ring: [0, 0, 0, 40, 40, 40, 40, 0] }] };

test('water sits about 0.45 m below the coping with measured freeboard preserved', () => {
  assert.equal(WATER.surfaceY, -0.45);
  assert.equal(WATER.minFreeboard, 0.45);
  const a = buildLakeArrays(SQUARE, { bbox: BBOX });
  assert.ok(a.surface.position.every((v, i) => i % 3 !== 1 || v === WATER.surfaceY));
  const ys = a.walls.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), WATER.bedY);
  assert.equal(Math.max(...ys), WATER.wallTop);
  assert.ok(WATER.wallTop > 0 && WATER.wallTop < 0.2);
  assert.ok(Math.abs(WATER.wallTop - WATER.surfaceY - 0.53) < 1e-9);

  const measured = { flat: false, lakeLevel: () => WATER.surfaceY, heightAt: () => 0 };
  const terrainArrays = buildLakeArrays(SQUARE, { bbox: BBOX, terrain: measured });
  assert.ok(terrainArrays.freeboards.every((point) => point.free >= WATER.minFreeboard));
  assert.ok(terrainArrays.freeboards.some((point) => Math.abs(point.free - 0.53) < 1e-6));
});

test('measured Søerne levels rise 0.35 m and retain the minimum coping freeboard', () => {
  const lake = { id: 'connected', area_m2: 100000, ring: SQUARE.lakes[0].ring };
  const terrain = { flat: false, lakeLevel: () => -1, heightAt: () => -0.49 };
  const a = buildLakeArrays({ lakes: [lake] }, { bbox: BBOX, terrain });
  assert.equal(a.level, -1 + WATER.measuredSurfaceOffset, 'planar reflections use the corrected rendered water level');
  assert.ok(a.surface.position.every((v, i) => i % 3 !== 1 || Math.abs(v - (-1 + WATER.measuredSurfaceOffset)) < 1e-9));
  assert.ok(a.freeboards.every((point) => point.free >= WATER.minFreeboard));
  assert.ok(a.freeboards.every((point) => Math.abs(point.free - 0.45) < 1e-9));
});

test('measured Søerne coping freeboards are near 0.45 m after the render-level adjustment', () => {
  const terrain = createTerrain(terrainDoc);
  const a = buildLakeArrays(doc, { bbox: BBOX, terrain });
  for (const id of ['lake:0', 'lake:1', 'lake:2']) {
    const free = a.freeboards.filter((point) => point.id === id).map((point) => point.free).sort((x, y) => x - y);
    assert.ok(free.length > 0, `${id} has measured shoreline samples`);
    assert.ok(free[0] >= WATER.minFreeboard, `${id} respects the minimum freeboard`);
    assert.ok(free[Math.floor(free.length / 2)] <= 0.6, `${id} median freeboard stays near the 0.45 m target`);
  }
});

test('lake-wall tops batter landward while the coping keeps its measured width', () => {
  const { walls } = buildLakeArrays(SQUARE, { bbox: BBOX });
  const p = walls.position;
  const normal = walls.normal;
  const horizontalNormalLength = Math.hypot(normal[0], normal[2]);
  const nx = normal[0] / horizontalNormalLength;
  const nz = normal[2] / horizontalNormalLength;
  const dx = p[9] - p[0]; // top-start vertex minus bottom-start vertex
  const dz = p[11] - p[2];
  const intoWater = dx * nx + dz * nz;
  assert.ok(Math.abs(intoWater + WATER.wallBatter) < 1e-6, 'top moves 0.15 m away from the water-facing normal');

  const copeInner = [p[12], p[14]];
  const copeOuter = [p[21], p[23]];
  const copingOutward = (copeOuter[0] - copeInner[0]) * nx + (copeOuter[1] - copeInner[1]) * nz;
  assert.ok(Math.abs(copingOutward + WATER.copingW) < 1e-6, 'coping projects 0.3 m landward from the wall face');
});

test('bridge fascias stay vertical when lake walls use a landward batter', () => {
  const ring = [-20, -20, -20, 20, 20, 20, 20, -20];
  const arrays = buildLakeArrays({ lakes: [], bridges: [{ id: 'b', ring, open_edges: [0] }] }, { bbox: BBOX });
  const p = arrays.soffit.position;
  const base = ring.length / 2; // bridge deck vertices precede the fascia quad
  const a = base;
  const b = base + 1;
  const c = base + 2;
  const d = base + 3;
  assert.equal(p[3 * a], p[3 * d]);
  assert.equal(p[3 * a + 2], p[3 * d + 2]);
  assert.equal(p[3 * b], p[3 * c]);
  assert.equal(p[3 * b + 2], p[3 * c + 2]);
});

test('Peblinge coping closes to the registered gravel at the real lake-path camera cross-section', () => {
  const surfaces = applySurfaceCuts(
    JSON.parse(readFileSync(new URL('../data/cph-surfaces.json', import.meta.url), 'utf8')),
    doc.surface_cuts
  ).surfaces;
  const lake = doc.lakes.find((item) => item.id === 'lake:0');
  const hint = [-70.5, -300];
  let closest = null;
  let area = 0;
  for (let i = 0; i < lake.ring.length; i += 2) {
    const j = (i + 2) % lake.ring.length;
    area += lake.ring[i] * lake.ring[j + 1] - lake.ring[j] * lake.ring[i + 1];
  }
  area /= 2;
  for (let i = 0; i < lake.ring.length; i += 2) {
    const j = (i + 2) % lake.ring.length;
    const ax = lake.ring[i];
    const az = lake.ring[i + 1];
    const dx = lake.ring[j] - ax;
    const dz = lake.ring[j + 1] - az;
    const length = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((hint[0] - ax) * dx + (hint[1] - az) * dz) / (length * length)));
    const x = ax + dx * t;
    const z = az + dz * t;
    const distance = Math.hypot(hint[0] - x, hint[1] - z);
    if (closest && distance >= closest.distance) continue;
    const left = [-dz / length, dx / length];
    const waterLeft = pointInRing(lake.ring, x + left[0] * 0.5, z + left[1] * 0.5);
    const waterRight = pointInRing(lake.ring, x - left[0] * 0.5, z - left[1] * 0.5);
    const land = waterLeft !== waterRight ? (waterLeft ? [-left[0], -left[1]] : left) : (area < 0 ? left : [-left[0], -left[1]]);
    closest = { x, z, distance, land };
  }

  const arrays = buildLakeArrays(doc, { bbox: BBOX, terrain: createTerrain(terrainDoc) });
  const terrain = createTerrain(terrainDoc);
  const outerX = closest.x + closest.land[0] * (WATER.wallBatter + WATER.copingW);
  const outerZ = closest.z + closest.land[1] * (WATER.wallBatter + WATER.copingW);
  const registeredGravel = surfaces.find((surface) => surface.cls === 'gravel' && pointInRing(surface.ring, outerX, outerZ));
  assert.ok(registeredGravel, 'the target coping edge is covered by the measured gravel polygon');

  let nearest = null;
  for (let i = 0; i < arrays.walls.kind.length; i++) {
    if (arrays.walls.kind[i] !== KIND.fascia) continue;
    const x = arrays.walls.position[3 * i];
    const z = arrays.walls.position[3 * i + 2];
    const d = Math.hypot(x - outerX, z - outerZ);
    if (!nearest || d < nearest.distance) nearest = { i, x, z, distance: d };
  }
  assert.ok(nearest && nearest.distance < 3, 'the landward coping fascia reaches this real shoreline segment');
  assert.ok(pointInRing(registeredGravel.ring, nearest.x, nearest.z), 'the fascia endpoint lies inside the same registered gravel polygon');
  const samePointY = [];
  for (let i = 0; i < arrays.walls.kind.length; i++) {
    if (arrays.walls.kind[i] !== KIND.fascia) continue;
    if (Math.hypot(arrays.walls.position[3 * i] - nearest.x, arrays.walls.position[3 * i + 2] - nearest.z) < 1e-8) {
      samePointY.push(arrays.walls.position[3 * i + 1]);
    }
  }
  const fasciaBottom = Math.min(...samePointY);
  const fasciaTop = Math.max(...samePointY);
  const gravelTop = terrain.heightAt(nearest.x, nearest.z) + 0.014;
  assert.ok(fasciaTop - gravelTop > 0.25, 'real terrain leaves a substantial height step under the raised coping');
  assert.ok(Math.abs(fasciaBottom - gravelTop) < 1e-6, 'the fascia closes that step exactly to the terrain-draped gravel level');
});

test('lake walls face the water; the water surface and the soffit face up / down', () => {
  const a = buildLakeArrays(SQUARE, { bbox: BBOX });
  const W = a.walls;
  for (let i = 0; i < W.index.length; i += 3) {
    const [p, q, r] = [W.index[i], W.index[i + 1], W.index[i + 2]];
    const P = (k) => [W.position[3 * k], W.position[3 * k + 1], W.position[3 * k + 2]];
    const [A, B, C] = [P(p), P(q), P(r)];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const stored = [W.normal[3 * p], W.normal[3 * p + 1], W.normal[3 * p + 2]];
    assert.ok(n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] > 0, 'geometric normal agrees with the stored one');
    if (W.kind[p] === KIND.wall) { // water-facing wall: points into the lake (towards its centre)
      const toCentre = [20 - A[0], 20 - A[2]];
      assert.ok(stored[0] * toCentre[0] + stored[2] * toCentre[1] > 0, 'faces the water');
    } else if (W.kind[p] === KIND.fascia) {
      const awayFromLake = [A[0] - 20, A[2] - 20];
      assert.ok(stored[0] * awayFromLake[0] + stored[2] * awayFromLake[1] > 0, 'landward fascia faces away from the water');
    }
  }
  const S = a.surface;
  for (let i = 0; i < S.index.length; i += 3) {
    const [p, q, r] = [S.index[i], S.index[i + 1], S.index[i + 2]];
    const ax = S.position[3 * q] - S.position[3 * p];
    const az = S.position[3 * q + 2] - S.position[3 * p + 2];
    const bx = S.position[3 * r] - S.position[3 * p];
    const bz = S.position[3 * r + 2] - S.position[3 * p + 2];
    assert.ok(az * bx - ax * bz > 0, 'water faces up');
  }
});

test('the ground plane has the lake cut out: no ground shows through the water', () => {
  const a = buildLakeArrays(SQUARE, { bbox: BBOX });
  const g = groundWithHoles(8000, a.cutRings, a.islands);
  const pts = [];
  for (let i = 0; i < g.position.length; i += 3) pts.push(g.position[i], g.position[i + 2]);
  assert.ok(Math.abs(trianglesArea(pts, g.index) - (8000 * 8000 - 1600)) < 1);
});

test('real lakes: Peblinge Sø is water, Nørre Søgade and the road are not', () => {
  assert.ok(inLake(doc, -60, -200), 'middle of Peblinge Sø');
  assert.ok(inLake(doc, 100, -520), 'Sortedams Sø, north of Dronning Louises Bro');
  assert.ok(!inLake(doc, 0, 0), 'Nørre Søgade 37');
});

test('water is under the bridge: Dronning Louises Bro spans a bridge strip with soffit and fascia', () => {
  assert.equal(doc.bridges.length, 1);
  const a = buildLakeArrays(doc, { bbox: BBOX });
  assert.equal(a.stats.bridges, 1);
  assert.ok(a.soffit.index.length > 0);
  // the deck centre (97, -476.7) lies in the bridge strip, which the merged lake outline contains
  const b = doc.bridges[0];
  assert.ok(ringArea(b.ring) > 1500);
  const lake = doc.lakes.find((l) => l.area_m2 > 100000);
  const inRing = (ring, x, z) => { let c = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c; return c; };
  assert.ok(inRing(lake.ring, 97, -476.7), 'water under the bridge');
});

test('lake outlines cut by the district edge run on to the horizon without walls there', () => {
  const ring = [700, 100, 750, 100, 750, 600, 700, 600];
  const ext = extendBeyondBbox(ring, BBOX);
  assert.ok(ext.some((v, i) => i % 2 === 0 && v === WATER.far));
  const a = buildLakeArrays({ lakes: [{ id: 'e', ring: [700, 100, 700, 600, 750, 600, 750, 100] }] }, { bbox: BBOX });
  const xs = a.walls.position.filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs) < 760, 'no wall beyond the district');
  const small = extendBeyondBbox([700, 100, 750, 100, 750, 130, 700, 130], BBOX);
  assert.ok(!small.includes(WATER.far), 'a small pond cut by the edge just ends there');
});

test('shore distance field: zero at the wall, grows into the lake, capped', () => {
  const f = shoreDistanceField(SQUARE, { bbox: BBOX });
  const at = (x, z) => f.data[Math.floor(z + 750) * f.width + Math.floor(x + 750)];
  assert.ok(at(1.5, 20) < 3 * 255 / WATER.shoreMax, 'about 1-2 m from the wall');
  assert.ok(at(20, 20) > at(5, 20));
  assert.equal(at(100, 100), 0, 'land');
});

test('surface cuts replace or drop surface polygons', () => {
  const doc2 = { version: 'cph-surfaces/1', surfaces: [{ id: 'a', cls: 'gravel', ring: [0, 0, 1, 0, 1, 1] }, { id: 'b', cls: 'gravel', ring: [0, 0, 5, 0, 5, 5] }, { id: 'c', cls: 'cobbles', ring: [9, 9, 10, 9, 10, 10] }] };
  const out = applySurfaceCuts(doc2, [{ id: 'a', replace: [] }, { id: 'b', replace: [{ id: 'b', ring: [0, 0, 2, 0, 2, 2] }] }]);
  assert.deepEqual(out.surfaces.map((s) => s.id), ['b', 'c']);
  assert.deepEqual(out.surfaces[0].ring, [0, 0, 2, 0, 2, 2]);
  assert.equal(out.surfaces[0].cls, 'gravel');
  assert.equal(doc2.surfaces.length, 3, 'input untouched');
});
