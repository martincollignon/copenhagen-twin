import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoadSurfaceArrays } from '../js/road-surfaces-cph.js';

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
