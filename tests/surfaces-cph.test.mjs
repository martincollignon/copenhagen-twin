import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKerbFrame } from '../js/walk-space-cph.js';
import { buildPavementBuckets, createSurfaceIndex, sidewalkClass } from '../js/pavement-cph.js';
import { triangulatePolygon, trianglesArea, ringArea } from '../js/polygon-cph.js';
import { buildRoadSurfaceArrays } from '../js/road-surfaces-cph.js';

// a carriageway at 30 degrees from the x axis (local frame: z south), 7 m wide
const ANGLE = Math.PI / 6;
const DIR = [Math.cos(ANGLE), Math.sin(ANGLE)];
const NORM = [-DIR[1], DIR[0]]; // right of travel
const road = { pts: [0, 0, DIR[0] * 200, DIR[1] * 200], half: 3.5, cycle: {} };

test('kerb frame: u runs along an angled kerb and v steps out from it', () => {
  const f = createKerbFrame([road], { kerb: 0.18 });
  const at = (s, lat) => f.frameAt(DIR[0] * s + NORM[0] * lat, DIR[1] * s + NORM[1] * lat);
  const a = at(40, 5);
  const b = at(60, 5);
  const c = at(40, 7);
  assert.ok(Math.abs(b.u - a.u - 20) < 1e-9, 'u grows by the distance moved along the street');
  assert.ok(Math.abs(b.v - a.v) < 1e-9, 'v is constant along a line parallel to the kerb');
  assert.ok(Math.abs(c.u - a.u) < 1e-9, 'u is constant across the street');
  assert.ok(Math.abs(c.v - a.v - 2) < 1e-9, 'v grows by the distance moved away from the kerb');
  assert.ok(Math.abs(a.v - (5 - 3.5 - 0.18)) < 1e-9, 'v = 0 at the inner edge of the pavement');
  assert.equal(at(40, -5).side, 'left');
  assert.ok(Math.abs(at(40, -5).v - a.v) < 1e-9, 'both pavements measure from their own kerb');
});

test('kerb frame: a pavement behind a raised cycle track starts after the track', () => {
  const f = createKerbFrame([{ ...road, cycle: { right: true } }], { kerb: 0.18, cycleInner: 2.56 });
  const right = f.frameAt(NORM[0] * 8, NORM[1] * 8);
  assert.ok(Math.abs(right.v - (8 - 3.5 - 0.18 - 2.56)) < 1e-9);
  const left = f.frameAt(-NORM[0] * 8, -NORM[1] * 8);
  assert.ok(Math.abs(left.v - (8 - 3.5 - 0.18)) < 1e-9, 'the other side has no track');
});

test('pavement triangles share one segment frame, so the pattern is exactly parallel to the kerb', () => {
  // a pavement strip along the angled road, 2 m wide starting 0.5 m past the kerb, 60 m long
  const corner = (s, lat) => [DIR[0] * s + NORM[0] * lat, DIR[1] * s + NORM[1] * lat];
  const ring = [...corner(10, 4.5), ...corner(70, 4.5), ...corner(70, 6.5), ...corner(10, 6.5)];
  const buckets = buildPavementBuckets({ sidewalks: [{ ring }] }, null, { roads: [road], y: 0.2, groundY: 0.01 });
  const b = buckets.get('kbh_fortov');
  assert.ok(b && b.vertexCount >= 6);
  const { position, kuv } = b.arrays();
  for (let i = 0; i < position.length / 3; i++) {
    const x = position[3 * i];
    const z = position[3 * i + 2];
    const s = x * DIR[0] + z * DIR[1];
    const lat = x * NORM[0] + z * NORM[1];
    assert.ok(Math.abs(kuv[2 * i] - s) < 1e-3, `u follows the street at vertex ${i}`);
    assert.ok(Math.abs(kuv[2 * i + 1] - (lat - 3.5 - 0.18)) < 1e-3, `v follows the kerb offset at vertex ${i}`);
  }
});

test('pavements default to the Københavnerfortov unless the surface register says otherwise', () => {
  const strip = [0, 5, 40, 5, 40, 7, 0, 7];
  const plain = buildPavementBuckets({ sidewalks: [{ ring: strip }] }, null, { roads: [{ pts: [0, 0, 40, 0], half: 3.5 }], y: 0.2, groundY: 0.01 });
  assert.deepEqual([...plain.keys()], ['kbh_fortov']);
  const doc = { surfaces: [{ cls: 'setts', ring: [-5, 0, 100, 0, 100, 20, -5, 20] }] };
  const over = buildPavementBuckets({ sidewalks: [{ ring: strip }] }, doc, { roads: [{ pts: [0, 0, 40, 0], half: 3.5 }], y: 0.2, groundY: 0.01 });
  assert.ok(over.has('setts') && !over.has('kbh_fortov'), 'register polygon overrides the default');
  assert.ok(over.has('ground:setts'), 'the register polygon is also drawn as ground');
  // "other" (tree grates, ...) never replaces the pavement
  const grate = buildPavementBuckets({ sidewalks: [{ ring: strip }] }, { surfaces: [{ cls: 'other', ring: [-5, 0, 100, 0, 100, 20, -5, 20] }] }, { roads: [{ pts: [0, 0, 40, 0], half: 3.5 }], y: 0.2, groundY: 0.01 });
  assert.ok(grate.has('kbh_fortov'));
});

test('class lookup and plaza inference', () => {
  const idx = createSurfaceIndex([{ cls: 'cobbles', ring: [0, 0, 10, 0, 10, 10, 0, 10] }]);
  assert.equal(idx.classAt(5, 5), 'cobbles');
  assert.equal(idx.classAt(15, 5), null);
  assert.equal(sidewalkClass([0, 0, 40, 0, 40, 3, 0, 3]), 'kbh_fortov', 'a pavement strip is a Københavnerfortov');
  assert.equal(sidewalkClass([0, 0, 30, 0, 30, 30, 0, 30]), 'raadhus', 'a plaza-sized block reads as a square');
});

test('polygon holes are carved out by the triangulation', () => {
  const outer = [0, 0, 20, 0, 20, 20, 0, 20];
  const hole = [5, 5, 5, 10, 10, 10, 10, 5];
  const { pts, idx } = triangulatePolygon(outer, [hole]);
  assert.ok(Math.abs(trianglesArea(pts, idx) - (ringArea(outer) - ringArea(hole))) < 1e-6);
});

test('every KK register surface and marking triangulates to its polygon area (+-0.5%)', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/cph-surfaces.json', import.meta.url), 'utf8'));
  let withHoles = 0;
  const bad = [];
  for (const s of [...doc.surfaces, ...doc.markings]) {
    if (!s.ring || s.ring.length < 6) continue;
    if (s.holes?.length) withHoles++;
    const { pts, idx } = triangulatePolygon(s.ring, s.holes);
    const want = ringArea(s.ring) - (s.holes || []).reduce((a, h) => a + ringArea(h), 0);
    const got = trianglesArea(pts, idx);
    if (Math.abs(got - want) > 0.005 * Math.abs(want) + 1e-6) bad.push(`${s.id} want ${want.toFixed(2)} got ${got.toFixed(2)}`);
  }
  assert.ok(withHoles > 500, 'the hole polygons are present');
  assert.deepEqual(bad, []);
});

test('cycle tracks: raised dark asphalt with granite kerbs, blue only through junctions', () => {
  // a T junction: a main road with a cycle track on its right and a side road meeting it at the end of the main road
  const mk = (id, pts, extra = {}) => ({ id, class: 'secondary', pts, width: 8, lanesFwd: 1, lanesBack: 1, oneway: false, cycleTrack: 'none', ...extra });
  const geo = {
    roads: [
      mk('a', [0, 0, 100, 0], { cycleTrack: 'right' }),
      mk('b', [100, 0, 200, 0], { cycleTrack: 'right' }),
      mk('c', [100, 0, 100, 80], { cycleTrack: 'none' }),
      mk('d', [100, 0, 100, -80], { cycleTrack: 'none' })
    ],
    cycleTracks: [], sidewalks: []
  };
  const layers = buildRoadSurfaceArrays(geo, { pavement: true });
  assert.ok(layers.cycle.vertexCount > 0 && layers.kerb.vertexCount > 0);
  assert.ok(layers.blue && layers.blue.vertexCount > 0, 'junction crossing is blue where KK has no blue polygon');
  const { position } = layers.blue.arrays();
  for (let i = 0; i < position.length; i += 3) assert.ok(position[i] > 90 && position[i] < 110, 'blue stays within the junction');
  assert.ok(!('sidewalk' in layers), 'pavements come from pavement-cph when pavement: true');
  // a blue KK polygon near the junction replaces the fallback
  const withKk = buildRoadSurfaceArrays(geo, { pavement: true, surfaces: { markings: [{ kind: 'bluecycle', ring: [101, 4, 107, 4, 107, 6, 101, 6] }] } });
  const blueX = withKk.blue.arrays().position;
  let wide = false;
  for (let i = 0; i < blueX.length; i += 3) if (blueX[i] > 110 || blueX[i] < 90) wide = true;
  assert.ok(!wide);
  assert.equal(withKk.blue.vertexCount, 4, 'only the KK polygon is drawn');
});
