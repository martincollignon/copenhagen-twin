import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { WATER, extendBeyondBbox, buildLakeArrays, groundWithHoles, inLake, shoreDistanceField, applySurfaceCuts } from '../js/lakes-cph.js';
import { trianglesArea, ringArea } from '../js/polygon-cph.js';

const doc = JSON.parse(readFileSync(new URL('../data/cph-lakes.json', import.meta.url), 'utf8'));
const BBOX = [-750, -750, 750, 750];
// a 40 x 40 lake (counter-clockwise seen from above: negative shoelace in x/z)
const SQUARE = { lakes: [{ id: 't', ring: [0, 0, 0, 40, 40, 40, 40, 0] }] };

test('water sits 0.5-1.0 m below the ground, walls rise to just above it', () => {
  assert.ok(WATER.surfaceY <= -0.5 && WATER.surfaceY >= -1.0);
  const a = buildLakeArrays(SQUARE, { bbox: BBOX });
  assert.ok(a.surface.position.every((v, i) => i % 3 !== 1 || v === WATER.surfaceY));
  const ys = a.walls.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), WATER.bedY);
  assert.equal(Math.max(...ys), WATER.wallTop);
  assert.ok(WATER.wallTop > 0 && WATER.wallTop < 0.2);
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
    if (stored[1] === 0) { // a wall face: points into the lake (towards its centre)
      const toCentre = [20 - A[0], 20 - A[2]];
      assert.ok(stored[0] * toCentre[0] + stored[2] * toCentre[1] > 0, 'faces the water');
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

// ---- water level / terrain consistency (data/cph-terrain.json + data/cph-lakes.json) ----
import { createTerrain } from '../js/terrain-cph.js';
const terrainDoc = JSON.parse(readFileSync(new URL('../data/cph-terrain.json', import.meta.url), 'utf8'));
const realTerrain = createTerrain(terrainDoc);

test('Sortedams Sø and Peblinge Sø are separate basins with their own measured level (0.84 m apart)', () => {
  const basins = doc.basins.filter((b) => b.lake === 'lake:0');
  assert.equal(basins.length, 2, 'the bridge strip splits the merged lake');
  const [a, b] = basins.map((x) => x.level).sort((p, q) => p - q);
  assert.ok(b - a > 0.5 && b - a < 1.2, `levels ${a} / ${b}`);
  // the measured level is the DTM over the water: the terrain at an open-water point equals its basin's level
  assert.ok(Math.abs(realTerrain.heightAt(-60, -200) - a) < 0.05, 'Peblinge');
  assert.ok(Math.abs(realTerrain.heightAt(150, -650) - b) < 0.05, 'Sortedams');
});

test('lake walls: the quay of the Soerne stands 0.3-1.2 m over its own water, except at the bridge approach', () => {
  const a = buildLakeArrays(doc, { terrain: realTerrain });
  const soerne = a.freeboards.filter((f) => !f.natural && !f.abutment);
  assert.ok(soerne.length > 1000);
  const tall = soerne.filter((f) => f.free > 1.2);
  assert.equal(tall.length, 0, `walls over 1.2 m: ${tall.slice(0, 5).map((f) => `${f.id} ${f.x},${f.z} ${f.free.toFixed(2)}`).join('; ')}`);
  assert.ok(soerne.every((f) => f.free >= WATER.minFreeboard - 1e-9));
  const sorted = soerne.map((f) => f.free).sort((p, q) => p - q);
  const med = sorted[sorted.length >> 1];
  assert.ok(med > 0.4 && med < 0.8, `median free-board ${med.toFixed(2)} m (visual-refs 8a: 0.3-0.8 m)`);
});

test('the bridge approach is the only place a Soerne wall may be taller than the deck allows', () => {
  const a = buildLakeArrays(doc, { terrain: realTerrain });
  const abut = a.freeboards.filter((f) => !f.natural && f.abutment);
  assert.ok(abut.length > 20 && Math.max(...abut.map((f) => f.free)) < 4.2, 'bridge deck 1.62 m over a -0.94 m lake plus the coping');
});

test('natural park lakes get grassed banks, not quay walls with coping', () => {
  const a = buildLakeArrays(doc, { terrain: realTerrain });
  const kinds = new Set(a.walls.kind);
  assert.ok(kinds.has(3), 'bank faces exist');
  assert.ok(kinds.has(0) && kinds.has(1), 'quay wall + coping exist for the Soerne');
  assert.ok(a.freeboards.filter((f) => f.natural).length > 0);
});
