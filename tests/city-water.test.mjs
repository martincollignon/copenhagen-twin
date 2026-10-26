import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTileWaterArrays } from '../js/water-tiles-cph.js';
import { buildTileGroundArrays } from '../js/terrain-cph.js';
import { pointInRing } from '../js/polygon-cph.js';
import { tileOfLocal, tileBoundsLocal } from '../js/tile-grid.js';

// The citywide water data (tools/cph-geodata/city_water.py): runs against data/city + data/tiles when they hold it, otherwise skipped.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const headerPath = path.join(ROOT, 'data/city/water.json');
const have = fs.existsSync(headerPath) && fs.existsSync(path.join(ROOT, 'data/city/post.json'));
const header = have ? JSON.parse(fs.readFileSync(headerPath, 'utf8')) : null;
const layer = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tiles', id, 'water.json'), 'utf8'));
const skip = !have && 'run uv run tools/cph-geodata/city_water.py after the tile compiler';

test('the header: levels per body, the sea level, the Soerne override with the district levels', { skip }, () => {
  assert.equal(header.version, 'cph-water/1');
  assert.equal(header.sea, -6.84);
  assert.ok(header.stats.bodies > 100 && header.stats.quay_km > 50);
  for (const b of header.bodies) assert.ok(Number.isFinite(b.level) && b.area_m2 > 0, b.id);
  assert.ok(header.bodies.some((b) => b.sea && b.level === -6.84), 'the harbour is at the sea');
  const o = header.override;
  assert.ok(o.lakes.length >= 3 && o.bridges.length >= 1 && o.basins.length >= 4);
  // Peblinge Soe and Sortedams Soe: two basins, 0.84 m apart (data/cph-lakes.json basins, the DTM over the water)
  const levels = o.basins.map((b) => b.level);
  assert.ok(levels.some((v) => Math.abs(v + 0.94) < 0.06) && levels.some((v) => Math.abs(v + 0.1) < 0.06), `basin levels ${levels}`);
  assert.ok(Math.abs(o.terrain.bridges[0].deck - 1.62) < 0.1, 'the Dronning Louises Bro deck');
  assert.equal(o.terrain.lakes.length, o.lakes.length);
  for (const l of o.lakes) assert.ok(o.terrain.lakes.some((t) => t.id === l.id));
});

test('Nyhavn: the harbour has a quay, the ground is cut under the water, nothing of the ground lies in it', { skip }, () => {
  const id = tileOfLocal(2000, 300); // the canal mouth
  const p = layer(id);
  const a = buildTileWaterArrays(p);
  assert.ok(a.surface.index.length > 0 && a.walls.index.length > 0);
  assert.ok(p.bodies.some((b) => b.level === -6.84 && (b.walls || []).some((w) => w.s === 'q')), 'a quay at sea level');
  for (const b of p.bodies) for (const w of b.walls || []) assert.equal(w.top.length, w.pts.length / 2, 'a wall-top height per vertex');
  assert.ok(p.cut && p.cut.skip.length && p.cut.pieces.length);
  const terrain = { heightAt: () => 0, doc: {}, flat: false };
  const g = buildTileGroundArrays(terrain, { region: tileBoundsLocal(id), tileCut: p.cut, uvSize: 8000 });
  const water = p.bodies.filter((b) => !b.pond).flatMap((b) => b.polys);
  let inside = 0;
  const P = g.position;
  for (let i = 0; i < g.index.length; i += 3) {
    const x = (P[3 * g.index[i]] + P[3 * g.index[i + 1]] + P[3 * g.index[i + 2]]) / 3;
    const z = (P[3 * g.index[i] + 2] + P[3 * g.index[i + 1] + 2] + P[3 * g.index[i + 2] + 2]) / 3;
    const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap((k) => [P[3 * g.index[i + k]], P[3 * g.index[i + k] + 2]]);
    if (Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) < 0.02) continue; // the rounding slivers along the outline
    if (water.some((poly) => pointInRing(poly.ring, x, z) && !(poly.holes || []).some((h) => pointInRing(h, x, z)))) inside++;
  }
  assert.equal(inside, 0, 'no ground triangle centre inside the water');
});

test('green ground and far water pieces are clipped to their tile', { skip }, () => {
  const id = tileOfLocal(-1900, 800); // Frederiksberg Have
  const b = tileBoundsLocal(id);
  const p = layer(id);
  assert.ok((p.green || []).length > 0, 'the park is green');
  for (const g of p.green) for (let i = 0; i < g.ring.length; i += 2) assert.ok(g.ring[i] >= b[0] - 0.01 && g.ring[i] <= b[2] + 0.01 && g.ring[i + 1] >= b[1] - 0.01 && g.ring[i + 1] <= b[3] + 0.01);
  for (const [tid, pieces] of Object.entries(header.far)) {
    const tb = tileBoundsLocal(tid);
    for (const pc of pieces) for (const q of pc.p) for (let i = 0; i < q.ring.length; i += 2) assert.ok(q.ring[i] >= tb[0] - 0.2 && q.ring[i] <= tb[2] + 0.2 && q.ring[i + 1] >= tb[1] - 0.2 && q.ring[i + 1] <= tb[3] + 0.2, tid);
  }
});
