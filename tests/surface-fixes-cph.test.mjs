import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoadSurfaceArrays, buildGroundBuckets, buildGroundHeightField, SURFACE_Y } from '../js/road-surfaces-cph.js';
import { findMouths } from '../js/junction-mouths-cph.js';
import { createBuildingEdgeIndex, facadeStrips } from '../js/pavement-cph.js';
import { pointInRing } from '../js/polygon-cph.js';

const geoReal = JSON.parse(readFileSync(new URL('../data/cph-geodata.json', import.meta.url), 'utf8'));
const surfaces = JSON.parse(readFileSync(new URL('../data/cph-surfaces.json', import.meta.url), 'utf8'));

// A through road along x with a vertex at the origin, a side street leaving it to the south (right of travel)
const mk = (id, cls, pts, extra = {}) => ({ id, name: id, class: cls, pts, width: 8, lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'none', ...extra });
const tee = (sideClass, mainExtra = {}) => ({
  roads: [mk('main', 'secondary', [-120, 0, 0, 0, 120, 0], mainExtra), mk('side', sideClass, [0, 0, 0, 80])],
  cycleTracks: [], sidewalks: [], buildings: []
});

test('side streets are found at interior vertices of the through road only', () => {
  const m = findMouths(tee('residential').roads);
  assert.equal(m.size, 1);
  const [mouth] = m.get(0);
  assert.equal(mouth.side, 1);
  assert.equal(mouth.raised, true);
  assert.equal(findMouths(tee('secondary').roads).get(0)[0].raised, false);
  // a road continuing straight on is not a mouth
  assert.equal(findMouths([mk('a', 'secondary', [-50, 0, 0, 0, 50, 0]), mk('b', 'secondary', [0, 0, 40, 2])]).size, 0);
});

const near = (arr, pred) => { for (let i = 0; i < arr.length; i += 3) if (pred(arr[i], arr[i + 1], arr[i + 2])) return true; return false; };

test('residential mouth: the kerb is cut across the opening and the carriageway ramps up to the pavement', () => {
  const layers = buildRoadSurfaceArrays(tee('residential'));
  const h = 3.85; // 2 lanes + 1.5 m shoulder = 7.7 m / 2
  const kerb = layers.kerb.arrays().position;
  const asphalt = layers.asphalt.arrays().position;
  assert.ok(near(kerb, (x, y, z) => Math.abs(x) > 8 && Math.abs(z - (h + 0.15)) < 0.01), 'the kerb continues beside the opening');
  assert.ok(!near(kerb, (x, y, z) => Math.abs(x) < 2.5 && z > 0 && z < h + 0.4), 'no kerb across the side street');
  assert.ok(near(asphalt, (x, y) => Math.abs(y - SURFACE_Y.sidewalk) < 1e-6), 'ramp reaches pavement height');
  // the pavement-level plateau is a pavement triangle bucket
  const b = buildGroundBuckets(tee('residential'), null).get('kbh_fortov');
  assert.ok(b && b.vertexCount >= 6, 'plateau slabs');
});

test('through side street (secondary): kerb, cycle track and pavement edge stop; the kerb returns round the corners', () => {
  const g = tee('secondary', { cycleTrack: 'both' });
  const layers = buildRoadSurfaceArrays(g);
  const cyc = layers.cycle.arrays().position;
  assert.ok(near(cyc, (x, y, z) => x > 12 && z > 0), 'cycle track continues away from the opening');
  assert.ok(!near(cyc, (x, y, z) => Math.abs(x) < 4 && z > 0), 'cycle track is cut across a through side street');
  const kerb = layers.kerb.arrays().position;
  // corner arcs leave the main road line and head south into the side street
  assert.ok(near(kerb, (x, y, z) => z > 8 && Math.abs(x) > 3.5 && Math.abs(x) < 6), 'kerb return into the side street');
});

test('facade sett strip: along pavement edges that run on a building line, never along the kerb', () => {
  const building = { ring: [0, 0, 30, 0, 30, -10, 0, -10] };
  const sidewalk = { ring: [0, 0.05, 30, 0.05, 30, 3, 0, 3] };
  const idx = createBuildingEdgeIndex([building]);
  const strips = facadeStrips([sidewalk], idx);
  assert.equal(strips.length, 1, 'only the edge on the footprint');
  const q = strips[0];
  assert.ok(Math.abs(q[5] - q[3] - 0.4) < 0.11, 'about 0.4 m wide');
  const b = buildGroundBuckets({ ...tee('residential'), roads: [mk('r', 'secondary', [-50, 8, 80, 8])], sidewalks: [sidewalk], buildings: [building] }, null);
  assert.ok(b.get('setts')?.vertexCount >= 6, 'setts triangles emitted');
  const noB = buildGroundBuckets({ roads: [mk('r', 'secondary', [-50, 8, 80, 8])], sidewalks: [sidewalk], buildings: [] }, null);
  assert.ok(!noB.get('setts'), 'no strip without a building');
});

test('ground height field: carriageway, cycle track and pavement heights, ramps in between', () => {
  const g = { ...tee('residential', { cycleTrack: 'right' }), sidewalks: [{ ring: [-100, 9, 100, 9, 100, 14, -100, 14] }] };
  const f = buildGroundHeightField(g);
  const near2 = (v, want) => assert.ok(Math.abs(v - want) <= 0.02, `${v} vs ${want}`);
  near2(f.heightAt(-50, 0), SURFACE_Y.asphalt);
  near2(f.heightAt(-50, 3.85 + 0.15 + 1.1), SURFACE_Y.cycle);
  near2(f.heightAt(-50, 11.5), SURFACE_Y.sidewalk);
  near2(f.heightAt(-50, 40), 0); // open ground
  near2(f.heightAt(0, 15), 0);
  // across the side-street mouth the carriageway rises to the pavement and back
  assert.ok(f.heightAt(0, 15.0) < 0.05);
});

test('pedestrian walking positions on the real pavements sit at pavement height (+-2 cm)', () => {
  const f = buildGroundHeightField(geoReal, surfaces);
  let n = 0;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const s of geoReal.sidewalks) {
    const r = s.ring;
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); }
    for (let k = 0; k < 6; k++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      // a walking position: inside the pavement with 0.6 m clear of its edge in every direction
      const clear = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([dx, dz]) => pointInRing(r, x + dx, z + dz)) && pointInRing(r, x, z);
      if (!clear) continue;
      // not on a cycle track or crossing: the pavement polygon is the pavement
      const y = f.heightAt(x, z);
      if (Math.abs(y - SURFACE_Y.sidewalk) <= 0.02) n++;
      else assert.ok(y >= SURFACE_Y.cycle - 0.02, `walking position (${x.toFixed(1)}, ${z.toFixed(1)}) at ${y}`); // overlap with a cycle track polygon only
    }
  }
  assert.ok(n > 500, `sampled ${n} pedestrian positions at pavement height`);
});
