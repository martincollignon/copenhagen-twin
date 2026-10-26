import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrain, decodeGrid, drapePositions, densifyPts, densifyRing, buildTerrainMeshArrays, FLAT_TERRAIN } from '../js/terrain-cph.js';
import { composeHeightField, createHeightGrid } from '../js/ground-height-cph.js';
import { buildRoadSurfaceArrays } from '../js/road-surfaces-cph.js';
import { buildLakeArrays, WATER } from '../js/lakes-cph.js';
import { applyTerrainGround } from '../js/layout-cph.js';

// a 4 x 4 grid of 10 m cells over [-20, 20]: height = 0.1 * x (a 10 % ramp towards +x), stored as int16 centimetres
function rampDoc(extra = {}) {
  const w = 4;
  const cm = new Int16Array(w * w);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) cm[j * w + i] = Math.round((-20 + (i + 0.5) * 10) * 0.1 * 100);
  const bytes = Buffer.from(cm.buffer, cm.byteOffset, cm.byteLength);
  return { version: 'cph-terrain/1', bbox: [-20, -20, 20, 20], cell: 10, width: w, height: w, min: -1.5, max: 1.5, lakes: [], ponds: [], bridges: [], data: bytes.toString('base64'), ...extra };
}

test('the grid decodes signed centimetres and heightAt is bilinear, clamped at the edge', () => {
  assert.deepEqual([...decodeGrid(Buffer.from(new Int16Array([-150, 7, 32767]).buffer).toString('base64'), 3)], [-1.5, 0.07, 327.67].map(Math.fround));
  const t = createTerrain(rampDoc());
  assert.ok(Math.abs(t.heightAt(0, 0) - 0) < 1e-6, 'centre of the ramp');
  assert.ok(Math.abs(t.heightAt(7, 3) - 0.7) < 1e-6, 'linear along x, independent of z');
  assert.ok(Math.abs(t.heightAt(-12, 11) - -1.2) < 1e-6);
  assert.equal(t.heightAt(900, 0), t.heightAt(15, 0), 'beyond the grid the nearest edge value is used');
  assert.equal(t.heightAt(-900, -900), t.heightAt(-15, -15));
});

test('without a terrain document everything stays on the flat plane', () => {
  assert.equal(createTerrain(null), FLAT_TERRAIN);
  assert.equal(FLAT_TERRAIN.heightAt(12, 34), 0);
  const pos = new Float32Array([1, 0.2, 2]);
  assert.deepEqual([...drapePositions(pos, FLAT_TERRAIN)], [1, Math.fround(0.2), 2]);
});

test('layer offsets are added to the terrain: drape, the composed height field and its parts', () => {
  const t = createTerrain(rampDoc());
  const pos = drapePositions(new Float32Array([10, 0.2, 0, -10, 0.02, 5]), t);
  assert.ok(Math.abs(pos[1] - 1.2) < 1e-5 && Math.abs(pos[4] - -0.98) < 1e-5);
  const grid = createHeightGrid({ bbox: [-20, -20, 20, 20], cell: 0.5 });
  grid.polygon([0, -5, 20, -5, 20, 5, 0, 5], 0.2); // a pavement 0.2 m up on x in [0, 20]
  const f = composeHeightField(t, grid);
  assert.ok(Math.abs(f.heightAt(10, 0) - (1.0 + 0.2)) < 1e-6, 'walking height = terrain + pavement offset');
  assert.ok(Math.abs(f.terrainAt(10, 0) - 1.0) < 1e-6);
  assert.ok(Math.abs(f.offsetAt(10, 0) - 0.2) < 1e-6);
  assert.ok(Math.abs(f.heightAt(-10, 0) - -1.0) < 1e-6, 'no offset off the pavement');
  assert.equal(composeHeightField(FLAT_TERRAIN, grid).terrainAt(10, 0), 0);
});

test('densify keeps the vertices and caps the segment length', () => {
  const d = densifyPts([0, 0, 25, 0], 6);
  assert.equal(d.length / 2, 6);
  assert.deepEqual(d.slice(0, 4), [0, 0, 5, 0]);
  assert.deepEqual(d.slice(-2), [25, 0]);
  assert.equal(densifyRing([0, 0, 10, 0, 10, 10], 6).length / 2, 2 + 2 + 3, 'a closed ring: every edge split, no repeated first vertex');
});

test('road surfaces follow the terrain: asphalt rides 0.02 m over it and the pavement 0.2 m, on a slope', () => {
  const t = createTerrain(rampDoc());
  const geo = { roads: [{ id: 'r', class: 'residential', pts: [-18, 0, 18, 0], width: 7, lanesFwd: 1, lanesBack: 1 }], sidewalks: [] };
  const flat = buildRoadSurfaceArrays(geo, {});
  const draped = buildRoadSurfaceArrays(geo, { terrain: t });
  const a = flat.asphalt.arrays();
  const b = draped.asphalt.arrays();
  assert.ok(b.position.length > a.position.length, 'long quads are split so they can follow the ground');
  for (let i = 0; i < b.position.length; i += 3) {
    const expect = t.heightAt(b.position[i], b.position[i + 2]) + 0.02;
    assert.ok(Math.abs(b.position[i + 1] - expect) < 1e-4, `vertex ${i / 3} on the terrain`);
  }
  assert.ok(Math.max(...a.position.filter((_, i) => i % 3 === 1)) < 0.05, 'without terrain the layers stay at their flat heights');
});

test('terrain mesh: every triangle faces up, lake cells are cut out, the frame closes the horizon', () => {
  const t = createTerrain(rampDoc({
    cut: { cell: 10, half: 20, skip: [10], pieces: [[1, 1, [-10, -10, -10, 0, 0, 0]]] },
    frame: [{ ring: [-100, -100, 100, -100, 100, 100, -100, 100], holes: [[-20, -20, 20, -20, 20, 20, -20, 20]] }]
  }));
  const m = buildTerrainMeshArrays(t);
  let area = 0;
  for (let k = 0; k < m.index.length; k += 3) {
    const [a, b, c] = [m.index[k] * 3, m.index[k + 1] * 3, m.index[k + 2] * 3];
    const cross = (m.position[b + 2] - m.position[a + 2]) * (m.position[c] - m.position[a]) - (m.position[b] - m.position[a]) * (m.position[c + 2] - m.position[a + 2]);
    assert.ok(cross > 0, 'wound to face up');
    area += cross / 2;
  }
  // 16 cells of 100 m2, minus the skipped cell and the cut cell (replaced by a 50 m2 piece), plus the frame (200^2 - 40^2)
  assert.ok(Math.abs(area - (1600 - 100 - 100 + 50 + (40000 - 1600))) < 1, `area ${area}`);
  for (let i = 0; i < m.position.length; i += 3) assert.ok(Math.abs(m.position[i + 1] - (t.heightAt(m.position[i], m.position[i + 2]) - 0.08)) < 1e-4, 'mesh lies under the field');
  assert.ok(Math.abs(m.normal[1] - 1) < 0.02 || m.normal[1] > 0.9, 'normals point up on a gentle slope');
});

test('lakes sit at their measured level, walls follow the shore terrain, bridges at the measured deck', () => {
  const lakes = {
    lakes: [{ id: 'lake:0', ring: [-9, -9, -9, 9, 9, 9, 9, -9], holes: [] }],
    ponds: [{ id: 'pond:1', ring: [15, 15, 15, 18, 18, 18, 18, 15] }],
    bridges: [{ id: 'bridge:0', ring: [-3, 9, -3, 12, 3, 12, 3, 9], open_edges: [0, 2] }]
  };
  const t = createTerrain(rampDoc({ lakes: [{ id: 'lake:0', level: -0.5 }], ponds: [{ id: 'pond:1', level: 1.5 }], bridges: [{ id: 'bridge:0', deck: 1.2 }] }));
  const a = buildLakeArrays(lakes, { bbox: [-20, -20, 20, 20], terrain: t });
  assert.equal(a.level, -0.5);
  const ys = new Set();
  for (let i = 1; i < a.surface.position.length; i += 3) ys.add(a.surface.position[i]);
  assert.ok(ys.has(-0.5), 'lake surface at the measured level');
  assert.ok(ys.has(1.52), 'pond surface at its level (+2 cm)');
  const free = a.freeboards.map((f) => f.free);
  assert.ok(free.length > 4 && Math.min(...free) >= WATER.minFreeboard - 1e-9, 'the wall never ends lower than the minimum free-board');
  const shoreEast = a.freeboards.filter((f) => f.x > 8).map((f) => f.free);
  const shoreWest = a.freeboards.filter((f) => f.x < -8).map((f) => f.free);
  assert.ok(Math.min(...shoreEast) > Math.max(...shoreWest), 'the quay is higher where the terrain rises');
  const soffitYs = new Set();
  for (let i = 1; i < a.soffit.position.length; i += 3) soffitYs.add(+a.soffit.position[i].toFixed(2));
  assert.ok(soffitYs.has(0.78) && !soffitYs.has(-0.4), 'soffit hangs 0.42 m under the measured deck');
  // no terrain: the old relative frame
  const old = buildLakeArrays(lakes, { bbox: [-20, -20, 20, 20] });
  assert.equal(old.level, WATER.surfaceY);
});

test('buildings take the terrain ground; eave and ridge stay the measured absolute heights', () => {
  const t = createTerrain(rampDoc({ buildings: { a: 1.25, b: -0.4 } }));
  const geo = { buildings: [{ id: 'a', ground: 0.3, eave: 10, ridge: 12 }, { id: 'b', ground: -0.4, eave: 7, ridge: 7 }, { id: 'c', ground: 2, eave: 9, ridge: 9 }] };
  assert.equal(applyTerrainGround(geo, t), 1);
  assert.deepEqual(geo.buildings.map((b) => b.ground), [1.25, -0.4, 2]);
  assert.deepEqual(geo.buildings.map((b) => b.eave), [10, 7, 9]);
  // an unsurveyed building (default ground 0, `eave` is only a height) keeps its height when the ground moves
  const shed = { buildings: [{ id: 'a', ground: 0, eave: 3.2, ridge: 3.2, conf_fields: { ground: 'inferred' } }] };
  applyTerrainGround(shed, t);
  assert.deepEqual([shed.buildings[0].ground, shed.buildings[0].eave, shed.buildings[0].ridge], [1.25, 4.45, 4.45], 'eave = ground + 3.2 m');
  assert.equal(geo.buildings[0].groundSurvey, 0.3);
  assert.equal(applyTerrainGround(geo, FLAT_TERRAIN), 0);
});

test('the shipped terrain agrees with the DHM terrain model at open spots (checked against the source rasters)', () => {
  const t = createTerrain(JSON.parse(readFileSync(new URL('../data/cph-terrain.json', import.meta.url), 'utf8')));
  // local (x, z) on road centrelines -> mean of the 4 x 4 source pixels around it (rasterio over
  // data/raw/dhm_dtm_*.tif, minus the origin height 6.84)
  for (const [x, z, h] of [[148.9, 291.73, 0.21], [451.46, -365.13, 1.85], [-55.37, 141.94, -0.35], [273.13, -70.14, 0.98], [215.78, 423.38, 1.71]]) {
    assert.ok(Math.abs(t.heightAt(x, z) - h) < 0.06, `terrain at (${x}, ${z}) = ${t.heightAt(x, z).toFixed(2)}, source ${h}`);
  }
  assert.ok(t.doc.min < -5 && t.doc.max > 5 && t.doc.max < 10, 'the district spans several metres of relief, not the old flat plane');
  const m = buildTerrainMeshArrays(t);
  assert.ok(m.stats.triangles > 100000 && m.stats.pieces > 0 && m.stats.skipped > 0);
  assert.equal(t.lakeLevel('lake:0'), -0.94);
  assert.ok(t.deckHeight('bridge:0') > 1, 'Dronning Louises Bro is a measured hump over the water');
});
