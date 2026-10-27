import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGoBoatNavigation, confineGoBoatMotion, goBoatWaterFromCity, pointInRing, GOBOAT_HULL_RADIUS } from '../js/goboat-navigation.js';
import { GOBOAT_PIER_RECORDS, normalizeGoBoatPierRecords, makeFleetLayout, boatRing, isGoBoatPierBuilding } from '../js/goboat-pier-data.js';
import { tileOfLocal, tileBoundsLocal } from '../js/tile-grid.js';

// The real harbour (R2 v3 data, tools/cph-geodata/city_water.py): the sea-level `far` pieces of data/city/water.json for the inner harbour
// tiles, and the full-resolution water layers (polys only) of the tiles around the Islands Brygge pier, Langebro and Christianshavn.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/goboat-harbour.json', import.meta.url), 'utf8'));
const tileGrid = { tileOf: tileOfLocal, boundsOf: tileBoundsLocal };
const records = normalizeGoBoatPierRecords();
for (const r of records) r.obstacles.push(...makeFleetLayout(r).map(boatRing));
const coarse = () => createGoBoatNavigation({ waterOverride: goBoatWaterFromCity(fixture), pierRecords: records, tileGrid });
const detailed = () => {
  const nav = coarse();
  for (const [id, payload] of Object.entries(fixture.tiles)) assert.ok(nav.setDetailWater(id, payload), id);
  return nav;
};
const pts = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);

// Breadth-first search over a 2 m lattice of legal hull positions from the departure point (cells are tested lazily). A 2 m step cannot
// cross land: both ends keep the full hull clearance, so the land between them would be narrower than the step.
function reach(nav, targets, { cell = 2, limit = 400000 } = {}) {
  const start = records[0].departurePoint;
  const key = (i, j) => `${i},${j}`;
  const seen = new Set([key(0, 0)]);
  const queue = [[0, 0]];
  const found = new Map();
  const want = targets.map(([name, x, z]) => ({ name, i: Math.round((x - start.x) / cell), j: Math.round((z - start.z) / cell) }));
  for (let h = 0; h < queue.length && h < limit && found.size < want.length; h++) {
    const [i, j] = queue[h];
    for (const t of want) if (!found.has(t.name) && Math.abs(t.i - i) <= 1 && Math.abs(t.j - j) <= 1) found.set(t.name, h);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(i + di, j + dj);
      if (seen.has(k)) continue;
      seen.add(k);
      if (nav.isPositionLegal(start.x + (i + di) * cell, start.z + (j + dj) * cell)) queue.push([i + di, j + dj]);
    }
  }
  return found;
}

// open water of the canals (OSM centre lines / water polygons projected to the local frame)
const TARGETS = [
  ['Langebro, under the bridge', 1141, 1304],
  ['Knippelsbro, under the bridge', 1655, 789],
  ['Christianshavns Kanal (south, by Trangravsbroen)', 1550, 1140],
  ['Christianshavns Kanal (north end)', 2031, 845],
  ['Nyhavn, mouth', 1900, 240],
  ['Nyhavn, inner basin', 1753, 180]
];

test('the citywide sea-level water: the pier departure is open water at the sea level', () => {
  const nav = coarse();
  assert.ok(nav, 'navigation from the citywide water');
  assert.equal(nav.level, -6.84);
  const d = records[0].departurePoint;
  assert.ok(nav.isPositionLegal(d.x, d.z));
  assert.ok(nav.polygons.length > 20, `the harbour spans many tiles (${nav.polygons.length} pieces)`);
});

test('GoBoat reaches Nyhavn and the Christianshavn canals from the Islands Brygge pier, under Langebro and Knippelsbro', () => {
  for (const nav of [coarse(), detailed()]) {
    const found = reach(nav, TARGETS);
    for (const [name] of TARGETS) assert.ok(found.has(name), `${name} reachable`);
  }
});

test('GoBoat stays out of the land: Islands Brygge, Slotsholmen and Christianshavn are not water', () => {
  const nav = detailed();
  for (const [x, z] of [[1180, 1420], [1250, 1480], [1000, 1000], [1700, 1000], [1600, 400]]) assert.equal(nav.isPositionLegal(x, z), false, `${x}, ${z}`);
});

test('the full-resolution quay: no hull position comes closer to the drawn shore than the hull radius, and the seams are open', () => {
  const nav = detailed();
  const shore = [];
  const water = [];
  for (const [id, payload] of Object.entries(fixture.tiles)) {
    const [x0, z0, x1, z1] = tileBoundsLocal(id);
    for (const body of payload.bodies) {
      if (Math.abs(body.level - fixture.sea) > 0.05) continue;
      for (const poly of body.polys) {
        water.push({ id, ring: pts(poly.ring), holes: (poly.holes || []).map(pts) });
        for (const r of [poly.ring, ...(poly.holes || [])]) {
          const p = pts(r);
          for (let i = 0; i < p.length; i++) {
            const a = p[i], b = p[(i + 1) % p.length];
            const seam = [x0, x1].some((v) => Math.abs(a[0] - v) < 0.05 && Math.abs(b[0] - v) < 0.05) || [z0, z1].some((v) => Math.abs(a[1] - v) < 0.05 && Math.abs(b[1] - v) < 0.05);
            if (!seam) shore.push([a, b]);
          }
        }
      }
    }
  }
  const dist = (x, z, [a, b]) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
  };
  // drive in straight lines from the pier in every direction until the hull stops, also across the tile seam at x = 1100
  const d = records[0].departurePoint;
  let checked = 0;
  for (let k = 0; k < 48; k++) {
    const h = (k / 48) * Math.PI * 2;
    let p = { x: d.x, z: d.z };
    for (let s = 0; s < 400; s++) {
      const m = confineGoBoatMotion(nav, p, { x: Math.sin(h) * 1.5, z: Math.cos(h) * 1.5 });
      p = { x: m.x, z: m.z };
      if (nav.hasDetailAt(p.x, p.z)) {
        assert.ok(water.some((w) => tileOfLocal(p.x, p.z) === w.id && pointInRing(p.x, p.z, w.ring) && !w.holes.some((r) => pointInRing(p.x, p.z, r))), `on drawn water at ${p.x}, ${p.z}`);
        const near = Math.min(...shore.map((e) => dist(p.x, p.z, e)));
        assert.ok(near >= GOBOAT_HULL_RADIUS, `hull clear of the quay at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} (${near.toFixed(2)} m)`);
        checked++;
      }
      if (m.blocked) break;
    }
  }
  assert.ok(checked > 500, `positions checked against the drawn quay: ${checked}`);
  // the coarse pieces wander up to 2 m off the drawn shore; the detail water must change the verdict somewhere near the quay
  const c = coarse();
  let differ = 0;
  for (let x = 1100; x < 1200; x += 0.5) for (let z = 1380; z < 1480; z += 0.5) if (c.isPositionLegal(x, z) !== nav.isPositionLegal(x, z)) differ++;
  assert.ok(differ > 0, 'the drawn quay refines the coarse water');
});

test('the pier and its moored boats float on the harbour at the real spot, inside the drawn quay', () => {
  const nav = detailed();
  const r = records[0];
  const tile = fixture.tiles[tileOfLocal(r.departurePoint.x, r.departurePoint.z)];
  const polys = tile.bodies.filter((b) => b.level === fixture.sea).flatMap((b) => b.polys.map((p) => ({ ring: pts(p.ring), holes: (p.holes || []).map(pts) })));
  const onWater = (x, z) => polys.some((p) => pointInRing(x, z, p.ring) && !p.holes.some((h) => pointInRing(x, z, h)));
  const fleet = makeFleetLayout(r);
  assert.ok(fleet.length >= 20);
  for (const b of fleet) {
    for (const [x, z] of pts(boatRing(b))) assert.ok(onWater(x, z), `moored boat corner on the water at ${x.toFixed(1)}, ${z.toFixed(1)}`);
    // bow in: the bow (heading) points at the spine
    const bow = [b.x + Math.sin(b.heading) * 2.5, b.z + Math.cos(b.heading) * 2.5];
    const stern = [b.x - Math.sin(b.heading) * 2.5, b.z - Math.cos(b.heading) * 2.5];
    const spine = (p) => {
      const [a, c] = [r.spine.start, r.spine.end];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      return Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / Math.hypot(dx, dz);
    };
    assert.ok(spine(bow) < spine(stern), 'bow toward the pier');
  }
  // the floating spine is on the water; its pavilion end meets the quay
  const dock = pts(r.dockRing);
  assert.ok(dock.filter(([x, z]) => onWater(x, z)).length >= dock.length - 2, 'the dock outline lies on the water');
  assert.ok(nav.isPositionLegal(r.departurePoint.x, r.departurePoint.z), 'departure clear of the dock, the fleet and the drawn quay');
});

test('the GeoDanmark footprints of the GoBoat pavilion are the pier, not city buildings', () => {
  const pavilion = [
    { id: 'gdk:1205593464', ring: [1141.01, 1440.31, 1134.02, 1436.42, 1131.74, 1439.82, 1137.95, 1444.79] },
    { id: 'gdk:1205593478', ring: [1141.85, 1439.11, 1131.96, 1433.62, 1128.27, 1438.9, 1130.83, 1440.95, 1131.74, 1439.82, 1134.02, 1436.42] },
    { id: 'gdk:1233983966', ring: [1137.11, 1446.03, 1137.95, 1444.79, 1131.74, 1439.82, 1130.83, 1440.95] }
  ];
  for (const b of pavilion) assert.ok(isGoBoatPierBuilding(b), b.id);
  const quayside = { id: 'gdk:1064687279', ring: [1180.41, 1428.02, 1186.9, 1418.4, 1187.9, 1416.92, 1185.35, 1415.21, 1175.82, 1408.81, 1172.03, 1414.41] };
  assert.equal(isGoBoatPierBuilding(quayside), false);
  assert.equal(isGoBoatPierBuilding({ ring: [] }), false);
  assert.equal(GOBOAT_PIER_RECORDS[0].source.dock, 'osm:way/297639626');
});
