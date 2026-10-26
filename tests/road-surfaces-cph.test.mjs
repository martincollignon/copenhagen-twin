import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoadSurfaceArrays, ROAD_PAINT } from '../js/road-surfaces-cph.js';

const geo = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));

test('road surface geometry is finite and inside the district', () => {
  const layers = buildRoadSurfaceArrays(geo);
  for (const [name, layer] of Object.entries(layers)) {
    assert.ok(layer.vertexCount > 0, `${name} has vertices`);
    const { position, index } = layer.arrays();
    for (let i = 0; i < position.length; i += 3) {
      assert.ok(Number.isFinite(position[i]) && Number.isFinite(position[i + 1]) && Number.isFinite(position[i + 2]));
      assert.ok(Math.abs(position[i]) <= 780 && Math.abs(position[i + 2]) <= 780, `${name} within bbox+30`);
    }
    for (const v of index) assert.ok(v < position.length / 3);
  }
  assert.ok(layers.cycle.vertexCount > 0 && layers.paint.vertexCount > 0);
});

test('road paint widths, dash rhythm, red BUS lanes, yellow curb lines and blue crossing symbols', () => {
  assert.deepEqual(ROAD_PAINT, {
    lineWidth: 0.1, parkingEdgeWidth: 0.3, cycleLaneWidth: 0.3, dashLength: 2.5, dashPeriod: 7.5
  });
  const fixture = {
    roads: [{
      id: 'paint-road', name: 'Testgade', class: 'secondary', pts: [0, 0, 80, 0], width: 12,
      lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'none', cs: { hw: 6 }
    }],
    sidewalks: [], cycleTracks: [], buildings: [], crossings: []
  };
  const surfaces = { markings: [
    { kind: 'red', ring: [4, -3.2, 44, -3.2, 44, -1.2, 4, -1.2] },
    { kind: 'yellow', ring: [4, 5.5, 30, 5.5, 30, 5.62, 4, 5.62] },
    { kind: 'bluecycle', ring: [54, -1.1, 60, -1.1, 60, 1.1, 54, 1.1] }
  ] };
  const bare = buildRoadSurfaceArrays(fixture);
  const painted = buildRoadSurfaceArrays(fixture, { surfaces });
  const quadBounds = (layer) => {
    const bounds = [];
    for (let i = 0; i < layer.pos.length; i += 12) {
      const xs = [0, 3, 6, 9].map((j) => layer.pos[i + j]);
      const zs = [2, 5, 8, 11].map((j) => layer.pos[i + j]);
      bounds.push({ x: Math.min(...xs), length: Math.max(...xs) - Math.min(...xs), z: (Math.max(...zs) + Math.min(...zs)) / 2, width: Math.max(...zs) - Math.min(...zs) });
    }
    return bounds;
  };
  const bounds = quadBounds(bare.paint);
  const centreDashes = bounds.filter((q) => Math.abs(q.z) < 0.001);
  assert.equal(centreDashes.length, 11);
  centreDashes.forEach((q, i) => {
    assert.ok(Math.abs(q.width - 0.1) < 1e-6, 'rendered centre paint is 10 cm wide');
    assert.ok(Math.abs(q.length - 2.5) < 1e-6 && Math.abs(q.x - i * 7.5) < 1e-6, 'rendered dashes follow the 2.5 m / 7.5 m rhythm');
  });
  assert.equal(bounds.filter((q) => q.length === 80 && Math.abs(q.width - 0.3) < 1e-6).length, 2, 'both parking edges render 30 cm wide');
  const contraflow = buildRoadSurfaceArrays({ ...fixture, roads: [{
    ...fixture.roads[0], oneway: true, carDir: 'fwd', bike: { contraflow: true, contraKind: 'lane' }
  }] });
  assert.ok(quadBounds(contraflow.paint).some((q) => q.x === 4 && q.length === 72 && Math.abs(q.width - 0.3) < 1e-6), 'the painted cycle lane renders a continuous 30 cm separator');
  assert.ok(painted.red.vertexCount > 0, 'red road-fill decals get their own rendering layer');
  assert.ok(painted.yellow.vertexCount > 0, 'yellow kerb markings get their own rendering layer');
  assert.ok(painted.blue.vertexCount > 0, 'surveyed blue cycle crossings remain blue');
  assert.ok(painted.paint.vertexCount > bare.paint.vertexCount, 'BUS lettering and bicycle pictogram sit over their coloured paint');

  const tooNarrow = buildRoadSurfaceArrays(fixture, { surfaces: { markings: [
    { kind: 'red', ring: [10, -0.25, 40, -0.25, 40, 0.25, 10, 0.25] },
    { kind: 'bluecycle', ring: [54, -0.15, 64, -0.15, 64, 0.15, 54, 0.15] }
  ] } });
  assert.equal(tooNarrow.paint.vertexCount, bare.paint.vertexCount, 'marking glyphs are omitted when their full footprint cannot fit');
  assert.ok(tooNarrow.red.vertexCount > 0 && tooNarrow.blue.vertexCount > 0, 'the source paint polygons still render');
});
