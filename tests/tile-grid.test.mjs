import test from 'node:test';
import assert from 'node:assert/strict';
import { CPH_FRAME } from '../js/city-config.js';
import { ORIGIN_E, ORIGIN_N, tileOfPoint, tileOfLocal, tileBoundsUtm, tileBoundsLocal, tilesForBbox, tilesForLocalBbox, lod2CellOfTile, parseTileId } from '../js/tile-grid.js';

test('origin constants match city-config', () => {
  assert.deepEqual([ORIGIN_E, ORIGIN_N], [CPH_FRAME.origin[0], CPH_FRAME.origin[1]]);
});

test('tile ids and bounds (same numbers as tools/cph-geodata/tests/test_frame.py)', () => {
  assert.equal(tileOfPoint(723900, 6176500), '1447_12353');
  assert.deepEqual(tileBoundsUtm('1447_12353'), [723500, 6176500, 724000, 6177000]);
  assert.deepEqual(tileBoundsLocal('1447_12353'), [-400, -500, 100, 0]);
  assert.equal(tileOfLocal(0, 0), '1447_12353');
  assert.equal(tileOfLocal(0, 0.01), '1447_12352');
  assert.throws(() => parseTileId('x_y'));
});

test('four tiles fill one LoD2 cell', () => {
  const cells = new Map();
  for (const ie of [1446, 1447]) for (const n of [12352, 12353]) {
    const c = lod2CellOfTile(`${ie}_${n}`);
    cells.set(c, (cells.get(c) || 0) + 1);
  }
  assert.deepEqual([...cells], [['6176_723', 4]]);
});

test('the district touches 4x4 tiles; edge contact does not leak', () => {
  const [x0, z0, x1, z1] = CPH_FRAME.bbox;
  const ids = tilesForLocalBbox([x0, z0, x1, z1]);
  assert.equal(ids.length, 16);
  assert.ok(ids.includes('1446_12351') && ids.includes('1449_12354'));
  assert.deepEqual(tilesForBbox([723500, 6176500, 724000, 6177000]), ['1447_12353']);
  assert.equal(tilesForBbox([723500, 6176500, 724000, 6177000], 1).length, 9);
});
