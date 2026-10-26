import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildBridgeDLBGeometry, filterDLBFurniture, layoutBridgeDLB } from '../js/bridge-dlb-geometry.js';
import { buildLakeArrays, inLake } from '../js/lakes-cph.js';
import { createTerrain, FLAT_TERRAIN } from '../js/terrain-cph.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const geo = read('../data/cph-geodata.json');
const lakes = read('../data/cph-lakes.json');
const furniture = read('../data/cph-furniture.json');
const terrain = createTerrain(read('../data/cph-terrain.json'));

function cross(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

function contains2d(point, a, b, c) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign(point, a, b); const d2 = sign(point, b, c); const d3 = sign(point, c, a);
  const hasNeg = d1 < -1e-7 || d2 < -1e-7 || d3 < -1e-7;
  const hasPos = d1 > 1e-7 || d2 > 1e-7 || d3 > 1e-7;
  return !(hasNeg && hasPos);
}

const model = buildBridgeDLBGeometry(geo, lakes, { terrain, furnitureDoc: furniture });

test('parapet coping is 1.05 metres above the bridge pavement datum', () => {
  const { layout, parts } = model;
  assert.ok(Math.abs(layout.parapetTopY - layout.pavementY - 1.05) < 1e-9);
  const copingHeights = parts.granite.position.filter((_, i) => i % 3 === 1 && parts.granite.kind[(i - 1) / 3] === 1);
  assert.ok(copingHeights.some((y) => Math.abs(y - layout.parapetTopY) < 1e-9), 'the coping mesh reaches the declared height');
});

test('layout fits the selected lake strip and uses observed height and heritage lamp positions', () => {
  const { layout, metadata } = model;
  assert.equal(layout.bridgeId, 'bridge:0');
  assert.ok(Math.abs(layout.lengthM - 128.05) < 0.5);
  assert.ok(Math.abs(layout.widthM - 26.5) < 1.0);
  assert.equal(layout.deckY, 1.62);
  assert.equal(layout.waterY, -0.94);
  assert.equal(layout.heritageLamps.length, 8);
  assert.equal(new Set(layout.heritageLamps.map((lamp) => lamp.src)).size, 8);
  assert.equal(layout.benchPositions.length, 20);
  assert.equal(metadata.dimensions.lengthM.confidence, 'scaled');
  assert.match(metadata.note, /strip is inferred geometry/);
  assert.equal(metadata.dimensions.archCount.confidence, 'observed');
});

test('three small arch bays are symmetric, fit below the deck, and have real facade openings', () => {
  const { layout, parts, openings, metadata } = model;
  assert.equal(layout.arches.length, 3);
  assert.deepEqual(layout.arches.map((arch) => arch.span), [layout.archSpan, layout.archSpan, layout.archSpan]);
  assert.ok(layout.arches[0].centerS < layout.arches[1].centerS && layout.arches[1].centerS < layout.arches[2].centerS);
  const gaps = layout.arches.slice(1).map((arch, i) => arch.centerS - layout.arches[i].centerS - arch.span);
  assert.ok(gaps.every((gap) => gap > 1.1 && gap < 1.6), `pier gaps ${gaps}`);
  assert.ok(layout.arches.every((arch) => arch.crownY < layout.bodyTopY - arch.ring + 1e-8));
  assert.equal(metadata.dimensions.archRiseM.value, layout.arches[0].rise);
  assert.equal(openings.length, 3);

  for (const arch of layout.arches) {
    const sample = [arch.centerS, arch.springY + 0.2];
    let facadeHits = 0;
    const facade = parts.facade;
    for (let i = 0; i < facade.index.length; i += 3) {
      const tri = [facade.index[i], facade.index[i + 1], facade.index[i + 2]].map((vertex) => {
        const x = facade.position[3 * vertex]; const y = facade.position[3 * vertex + 1]; const z = facade.position[3 * vertex + 2];
        return [x * layout.axis[0] + z * layout.axis[1], y];
      });
      if (contains2d(sample, ...tri)) facadeHits++;
    }
    assert.equal(facadeHits, 0, `the opening at s=${arch.centerS} remains void at spring + 0.2 m`);
  }
});

test('all generated parts are finite, indexed, and remain near the inferred strip footprint', () => {
  const ring = model.layout.stripRing;
  const bounds = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < ring.length; i += 2) {
    bounds[0] = Math.min(bounds[0], ring[i]); bounds[1] = Math.max(bounds[1], ring[i]);
    bounds[2] = Math.min(bounds[2], ring[i + 1]); bounds[3] = Math.max(bounds[3], ring[i + 1]);
  }
  for (const [name, part] of Object.entries(model.parts)) {
    const vertices = part.position.length / 3;
    assert.equal(part.position.length % 3, 0, `${name} positions are xyz triples`);
    assert.equal(part.uv.length, vertices * 2, `${name} has UVs for every vertex`);
    assert.equal(part.kind.length, vertices, `${name} has a material kind for every vertex`);
    assert.ok(part.position.every(Number.isFinite), `${name} positions are finite`);
    assert.ok(part.uv.every(Number.isFinite), `${name} UVs are finite`);
    assert.ok(part.index.length % 3 === 0, `${name} index is triangulated`);
    assert.ok(part.index.every((index) => Number.isInteger(index) && index >= 0 && index < vertices), `${name} indices are in range`);
    for (let i = 0; i < part.position.length; i += 3) {
      const x = part.position[i]; const z = part.position[i + 2];
      assert.ok(x >= bounds[0] - 12 && x <= bounds[1] + 12, `${name} x=${x} stays near the strip`);
      assert.ok(z >= bounds[2] - 12 && z <= bounds[3] + 12, `${name} z=${z} stays near the strip`);
    }
  }
});

test('box faces wind outward and bridge facade faces point away from the tunnel', () => {
  const wood = model.parts.wood;
  const point = (index) => [wood.position[3 * index], wood.position[3 * index + 1], wood.position[3 * index + 2]];
  const boxCenter = [0, 0, 0];
  for (let i = 0; i < 24; i++) point(i).forEach((v, j) => { boxCenter[j] += v / 24; });
  for (const [offset, faceCenterIndices] of [[0, [0, 1, 2]], [24, [16, 17, 18]]]) {
    const [a, b, c] = wood.index.slice(offset, offset + 3).map(point);
    const normal = cross(a, b, c);
    const faceCenter = [0, 0, 0];
    faceCenterIndices.forEach((i) => point(i).forEach((v, j) => { faceCenter[j] += v / 3; }));
    const outward = normal.reduce((sum, v, j) => sum + v * (faceCenter[j] - boxCenter[j]), 0);
    assert.ok(outward > 0, `box face ${offset} points outward`);
  }

  const facade = model.parts.facade; const n = model.layout.normal;
  for (let i = 0; i < facade.index.length; i += 3) {
    const tri = [facade.index[i], facade.index[i + 1], facade.index[i + 2]].map((index) => [
      facade.position[3 * index], facade.position[3 * index + 1], facade.position[3 * index + 2]
    ]);
    const normal = cross(...tri);
    const t = tri.reduce((sum, p) => sum + p[0] * n[0] + p[2] * n[1], 0) / 3;
    const facing = (normal[0] * n[0] + normal[2] * n[1]) * Math.sign(t - model.layout.centerT);
    assert.ok(facing > 0, 'facade triangles face outward from the bridge body');
  }
});

test('flat fallback clamps the arch crown below its deck clearance', () => {
  const layout = layoutBridgeDLB(geo, lakes, { terrain: FLAT_TERRAIN, furnitureDoc: furniture });
  assert.equal(layout.deckY, 0.02);
  assert.equal(layout.waterY, -0.8);
  assert.ok(layout.arches[0].rise > 0);
  assert.ok(layout.arches[0].crownY + layout.arches[0].ring < layout.bodyTopY);
});

test('modeled bridge removes only its own fallback soffit and preserves continuous lake water', () => {
  const fallback = buildLakeArrays(lakes);
  const modeled = buildLakeArrays(lakes, { modelBridge: (bridge) => bridge.id === model.layout.bridgeId });
  assert.equal(fallback.stats.bridges, 1);
  assert.equal(modeled.stats.bridges, 1);
  assert.ok(fallback.soffit.index.length > 0);
  assert.equal(modeled.soffit.index.length, 0);
  assert.deepEqual(modeled.surface, fallback.surface);
  assert.deepEqual(modeled.cutRings, fallback.cutRings);
  assert.ok(inLake(lakes, 97, -476.7), 'the water surface continues underneath the modeled deck');
});

test('bridge furniture replacement filters all eight modeled lamps and only in-strip benches', () => {
  const before = JSON.stringify(furniture);
  const filtered = filterDLBFurniture(furniture, model.layout);
  assert.equal(JSON.stringify(furniture), before, 'the source furniture document is not mutated');
  assert.equal(filtered.bridgeDLBFiltered.lamps, 8);
  assert.equal(filtered.lamps.length, furniture.lamps.length - 8);
  assert.equal(filtered.bridgeDLBFiltered.benches, model.layout.benchPositions.length);
  assert.equal(filtered.benches.length, furniture.benches.length - model.layout.benchPositions.length);
  const modeledIds = new Set(model.layout.heritageLamps.map((lamp) => lamp.src));
  assert.ok(filtered.lamps.every((lamp) => !lamp.src.some((src) => modeledIds.has(src))));
});
