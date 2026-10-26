import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoneMap, Z } from '../js/zones-cph.js';
import { placeFurniture, obb, obbOverlap } from '../js/placement-cph.js';
import { buildFurniturePlan } from '../js/street-furniture-data.js';
import { movingHalfWidth } from '../js/road-width-cph.js';

// A 100 m street along x: carriageway z in [-5, 5] (half width 5, two lanes), 3 m pavements both sides (|z| 5.3 .. 8.3),
// terraced houses beyond (|z| >= 8.3, 12 m high), a lake to the east end of the right pavement.
const rect = (x0, z0, x1, z1) => [x0, z0, x0, z1, x1, z1, x1, z0];
const street = (hw = 5, extra = {}) => ({
  roads: [{ id: 'r', class: 'residential', name: 'S', pts: [0, 0, 100, 0], lanesFwd: 1, lanesBack: 1, oneway: false, cs: { hw }, ...extra }],
  sidewalks: [{ id: 'sr', ring: rect(0, hw + 0.3, 100, 8.3) }, { id: 'sl', ring: rect(0, -8.3, 100, -(hw + 0.3)) }],
  buildings: [{ id: 'br', ring: rect(0, 8.3, 100, 20), eave: 12, ground: 0 }, { id: 'bl', ring: rect(0, -20, 100, -8.3), eave: 12, ground: 0 }],
  cycleTracks: []
});
const world = (geo = street()) => ({ geo, zones: createZoneMap({ geo, lakes: null, surfaces: null, bbox: [-20, -30, 120, 30] }) });
const emptyDoc = (extra = {}) => ({ trees: [], lamps: [], parkingBays: [], parkMeters: [], bins: [], glassContainers: [], binStands: [], bollards: [], rescuePosts: [], monuments: [], benches: [], bikeRacks: [], busStops: [], lakeLights: [], ...extra });

test('zones: carriageway, the swept moving strip, pavement, building, cycle strip, water with a bridge deck', () => {
  const geo = street(5, { cs: { hw: 5, cr: [2, [[0, 50]]] } });
  const lakes = { lakes: [{ id: 'l', ring: rect(60, -4, 100, 4), holes: [] }], bridges: [{ id: 'b', ring: rect(70, -4, 80, 4) }], ponds: [] };
  geo.roads[0].cs = { hw: 5, cr: [2, [[0, 50]]] };
  geo.roads[0].pts = [0, 0, 55, 0]; // the road ends before the lake
  const zones = createZoneMap({ geo, lakes, surfaces: null, bbox: [-20, -30, 120, 30] });
  const at = (x, z) => zones.flagsAt(x, z);
  assert.ok(at(10, 0) & Z.ROAD && at(10, 0) & Z.MOVING, 'centre of the road: asphalt and moving lanes');
  assert.ok(at(10, 4) & Z.ROAD && !(at(10, 4) & Z.MOVING), 'the parking lane is carriageway outside the swept strip');
  assert.ok(Math.abs(movingHalfWidth(geo.roads[0]) - 2.45) < 1e-9, 'two-way 1 + 1 lanes sweep 1.5 + 0.95 m');
  assert.ok(!(at(10, 2.6) & Z.MOVING) && at(10, 2.3) & Z.MOVING);
  assert.ok(at(10, 5.4) & Z.CYCLE, 'the cycle strip incl. its kerb, beside the carriageway');
  assert.ok(!(at(60, 5.4) & Z.CYCLE), 'not beyond its range');
  assert.ok(at(30, 7.8) & Z.PAVEMENT && at(30, 15) & Z.BUILDING);
  assert.ok(at(90, 0) & Z.WATER && !(at(75, 0) & Z.WATER), 'the bridge deck is not water');
  const c = zones.cover(30, 0, 0, 2, 4.6);
  assert.ok(c.road > 0.99 && c.solid > 0.99 && c.pavement === 0);
  assert.equal(zones.walkable(30, 7.9, 0, 0.5, 0.5), true);
  assert.equal(zones.walkable(30, 0, 0, 0.5, 0.5), false);
  const spot = zones.nearest(30, 0, (x, z) => zones.walkable(x, z, 0, 0.5, 0.5), 8);
  assert.ok(spot && Math.abs(spot.z) > 5, 'the nearest walkable spot is off the road');
});

test('oriented boxes overlap by the separating axis test', () => {
  const a = obb(0, 0, 0, 2, 4.6);
  assert.ok(obbOverlap(a, obb(1.5, 0, 0, 2, 4.6)));
  assert.ok(!obbOverlap(a, obb(2.1, 0, 0, 2, 4.6)));
  assert.ok(obbOverlap(a, obb(0, 2.2, Math.PI / 2, 2, 4.6)), 'rotated');
  assert.ok(!obbOverlap(obb(0, 0, Math.PI / 4, 1, 1), obb(1.25, 0, 0, 1, 1)), 'a 45 degree square reaches 0.71 m, not 1 m');
  assert.ok(obbOverlap(obb(0, 0, Math.PI / 4, 1, 1), obb(1.1, 0, 0, 1, 1)));
});

test('parked cars: in the parking lane, parallel to the kerb, outside the moving lanes, never on each other', () => {
  const { geo, zones } = world();
  const bays = [
    { x: 20, z: 3.9, yaw: Math.PI / 2, kind: 'par', src: ['a'] }, // already right (the street runs along x: parallel = yaw +-pi/2)
    { x: 20.3, z: 3.9, yaw: Math.PI / 2, kind: 'par', src: ['b'] }, // a duplicate of the first (another register)
    { x: 30, z: 6.4, yaw: Math.PI / 2 + 0.2, kind: 'par', src: ['c'] }, // on the pavement edge, 11 degrees off
    { x: 40, z: -3.9, yaw: -Math.PI / 2, kind: 'par', src: ['d'] }, // left side, driving the other way
    { x: 50, z: 0, yaw: Math.PI / 2, kind: 'par', src: ['e'] }, // in the middle of the road: pulled to a kerb
    { x: 60, z: 25, yaw: Math.PI / 2, kind: 'par', src: ['f'] } // in a courtyard far from the street
  ];
  const { doc, report } = placeFurniture(emptyDoc({ parkingBays: bays }), { zones, geo });
  assert.equal(doc.parkingBays.length, 4, 'two dropped: the duplicate and the courtyard');
  assert.equal(report.counts.cars['dropped:blocked'], 1, 'the duplicate bay is blocked by the first car');
  assert.equal(report.counts.cars['dropped:no-road'] + (report.counts.cars['dropped:off-carriageway'] || 0), 1);
  for (const b of doc.parkingBays) {
    const c = zones.cover(b.x, b.z, b.yaw, 1.95, 4.7);
    assert.ok(c.road > 0.97 && c.moving < 0.01 && c.cycle === 0 && c.building === 0 && c.pavement < 0.05, `car at ${b.x}, ${b.z} stands in the parking lane`);
    assert.ok(Math.abs(Math.abs(Math.sin(b.yaw)) - 1) < 1e-2 && Math.abs(Math.abs(b.z) - (5 - 0.975 - 0.12)) < 0.6, 'parallel to the kerb and against it');
  }
  assert.ok(doc.parkingBays.find((b) => b.src[0] === 'd').yaw < 0, 'the sense of the register is kept (facing -x)');
});

test('parked cars are dropped, not squeezed, where the lanes leave no room', () => {
  const { geo, zones } = world(street(3.4)); // a 6.8 m street: two lanes sweep 2.45 m each side, a car needs 2.1 m more
  const { doc, report } = placeFurniture(emptyDoc({ parkingBays: [{ x: 20, z: 2.9, yaw: Math.PI / 2, kind: 'par', src: ['a'] }] }), { zones, geo });
  assert.equal(doc.parkingBays.length, 0);
  assert.equal(report.counts.cars['dropped:no-room'], 1);
  assert.equal(report.dropped[0].reason, 'no-room');
  // a one-way street sweeps only 0.95 m around the centre line: the same bay fits
  const oneway = world(street(3.4, { oneway: true, lanesBack: 0 }));
  assert.equal(placeFurniture(emptyDoc({ parkingBays: [{ x: 20, z: 2.9, yaw: Math.PI / 2, kind: 'par', src: ['a'] }] }), oneway).doc.parkingBays.length, 1);
});

test('perpendicular bays need their full length clear of the moving strip', () => {
  const { geo, zones } = world(street(7.6)); // 15.2 m wide
  const bay = { x: 20, z: 4.5, yaw: 0.1, kind: 'perp', src: ['a'] }; // facing +z: across the street
  const { doc } = placeFurniture(emptyDoc({ parkingBays: [bay] }), { zones, geo });
  assert.equal(doc.parkingBays.length, 1, 'a 15 m street: 2.45 swept + 4.7 m across fits');
  assert.ok(Math.abs(Math.sin(doc.parkingBays[0].yaw)) < 0.01, 'across the street, nose or tail to the kerb');
  const narrow = world(street(5));
  assert.equal(placeFurniture(emptyDoc({ parkingBays: [{ ...bay, z: 3 }] }), narrow).doc.parkingBays.length, 0, 'a 10 m street cannot take a 4.7 m car across it beside two lanes');
});

test('trees leave the carriageway and the water, stay off facades; crowns that reach into a facade are trimmed', () => {
  const { geo, zones } = world();
  const trees = [
    { x: 30, z: 3.5, height: 12, crown_radius: 4, genus: 'lime' }, // in the parking lane: to the pavement
    { x: 40, z: 12, height: 10, crown_radius: 3, genus: 'lime' }, // inside a house: dropped
    { x: 50, z: 7.5, height: 14, crown_radius: 6, genus: 'plane' }, // on the pavement, crown 6 m wide, facade 0.8 m away
    { x: 70, z: -6.8, height: 6, crown_radius: 1.5, genus: 'hawthorn' } // fine as it is
  ];
  const { doc, report } = placeFurniture(emptyDoc({ trees }), { zones, geo });
  assert.equal(doc.trees.length, 3);
  assert.ok(Math.abs(doc.trees[0].z) > 5.2, 'moved off the asphalt');
  const plane = doc.trees.find((t) => t.genus === 'plane');
  assert.ok(plane.crown_radius <= 0.9 + (8.3 - plane.z) + 1e-6 && plane.crown_conf === 'trimmed', 'the crown reaches at most 0.9 m into the facade');
  assert.equal(doc.trees.find((t) => t.genus === 'hawthorn').crown_radius, 1.5);
  assert.equal(report.counts.trees['dropped:in-building'], 1);
  for (const t of doc.trees) assert.equal(zones.cover(t.x, t.z, 0, 0.3, 0.3).solid, 0);
});

test('wire lamps hang from facades across the street; without facades they become masts on the pavement', () => {
  const { geo, zones } = world();
  const lamps = [
    { x: 30, z: 0.5, mount: 'wire', pole: null, pole_h: 0, span: [30, -3, 55, 0.5], light: 'led', cct: 3000 }, // the surveyed line runs ALONG the street
    { x: 60, z: 1, mount: 'wire', span: [60, 1, 80, 2] },
    { x: 20, z: 6, mount: 'mast', pole: 'kbh', pole_h: 8 } // a mast standing on the cycle... pavement: stays
  ];
  const { doc, report } = placeFurniture(emptyDoc({ lamps }), { zones, geo });
  const wires = doc.lamps.filter((l) => l.mount === 'wire');
  assert.equal(wires.length, 2);
  for (const l of wires) {
    const [ax, az, bx, bz] = l.span;
    assert.ok(Math.abs(ax - bx) < 0.5 && Math.abs(az) > 8 && Math.abs(bz) > 8 && az * bz < 0, `anchored across the street on the two facades, got ${l.span}`);
    assert.ok(zones.flagsAt(l.x, l.z) & Z.ROAD, 'the lamp hangs over the carriageway');
    assert.ok(l.anchor_h[0] >= 5.8 && l.anchor_h[0] <= 8.9);
  }
  // remove the right-hand houses: only one facade is left -> a mast on the pavement
  const open = street();
  open.buildings = open.buildings.filter((b) => b.id === 'bl');
  const w2 = world(open);
  const out = placeFurniture(emptyDoc({ lamps: [lamps[0]] }), w2);
  assert.equal(out.doc.lamps.length, 1);
  assert.equal(out.doc.lamps[0].mount, 'mast');
  assert.equal(out.doc.lamps[0].pole_h, 6.2);
  assert.ok(w2.zones.cover(out.doc.lamps[0].x, out.doc.lamps[0].z, 0, 0.4, 0.4).solid === 0, 'the mast stands off the carriageway');
  assert.equal(out.report.counts.lamps['wire-to-mast'], 1);
  assert.equal(report.counts.lamps['wire-anchored'], 2);
});

test('street props stand on the pavement: snapped off the road, dropped from the water and houses, never on each other', () => {
  const { geo, zones } = world();
  const doc0 = emptyDoc({
    benches: [{ x: 20, z: 4.2, yaw: 0, length: 1.8 }, { x: 20.4, z: 6.5, yaw: 0, length: 1.8 }, { x: 40, z: 15, yaw: 0, length: 1.8 }],
    bins: [{ x: 30, z: -4.7, yaw: 0 }, { x: 30.1, z: -6.6, yaw: 0 }],
    bollards: [{ x: 10, z: 4.9, material: 'granite' }],
    glassContainers: [{ x: 70, z: 4, yaw: 0 }]
  });
  const { doc, report } = placeFurniture(doc0, { zones, geo });
  assert.equal(doc.benches.length, 2, 'the bench inside a house is dropped; the one in the parking lane moves to the pavement');
  assert.equal(doc.bins.length, 2);
  assert.equal(doc.glassContainers.length, 1);
  assert.equal(report.counts.benches['dropped:no-ground'], 1);
  assert.equal(doc.bollards.length, 1);
  for (const [key, w, d] of [['benches', 1.8, 0.55], ['bins', 0.52, 0.52], ['bollards', 0.3, 0.3], ['glassContainers', 3.8, 1.2]]) {
    for (const it of doc[key]) assert.equal(zones.cover(it.x, it.z, it.yaw || 0, w, d).solid, 0, `${key} off the asphalt`);
  }
  // two benches that would stand on each other: the second is moved or dropped, never overlapping
  const twin = placeFurniture(emptyDoc({ benches: [{ x: 20, z: 6.5, yaw: 0, length: 1.8 }, { x: 20.2, z: 6.5, yaw: 0, length: 1.8 }] }), { zones, geo });
  assert.equal(twin.doc.benches.length, 2);
  assert.ok(!obbOverlap(obb(twin.doc.benches[0].x, twin.doc.benches[0].z, 0, 1.8, 0.55), obb(twin.doc.benches[1].x, twin.doc.benches[1].z, 0, 1.8, 0.55)));
});

test('bike racks become clipped rows of at most 6 m on free ground', () => {
  const { geo, zones } = world();
  // a 12-slot rack (6 m) laid ACROSS the pavement: its ends run onto the road and into a house; a 40-slot rack along the pavement
  const racks = [{ x: 30, z: 6.8, yaw: 0, capacity: 12 }, { x: 60, z: 6.8, yaw: Math.PI / 2, capacity: 40 }, { x: 80, z: 0, yaw: Math.PI / 2, capacity: 8 }];
  const { doc, report } = placeFurniture(emptyDoc({ bikeRacks: racks }), { zones, geo });
  const across = doc.bikeRacks.filter((r) => r.x === 30 || Math.abs(r.x - 30) < 0.01);
  assert.equal(across.length, 1);
  assert.ok(across[0].capacity >= 4 && across[0].capacity < 12, `clipped to the pavement: ${across[0].capacity} slots`);
  const along = doc.bikeRacks.filter((r) => r.x > 40 && r.x < 75);
  assert.ok(along.length >= 4 && along.every((r) => r.capacity <= 12), 'a 40-slot rack becomes rows of at most 12 slots (6 m)');
  assert.equal(along.reduce((a, r) => a + r.capacity, 0), 40);
  for (const r of doc.bikeRacks) assert.ok(zones.cover(r.x, r.z, r.yaw, 1.75, r.capacity * 0.5).solid < 0.05, 'on free ground');
  assert.equal(report.counts.bikeRacks['dropped:no-ground'], 1, 'a rack in the road has nowhere to go');
  assert.ok(report.counts.bikeRacks.clipped >= 1);
});

test('bus stops: the flag and shelter stand on the pavement side, the glass faces the carriageway', () => {
  const { geo, zones } = world();
  const stops = [{ x: 40, z: 4.0, yaw: 0, tangent: [1, 0], name: 'S', shelter: true, bench: true, bin: true, countdown: true }];
  const { doc, report } = placeFurniture(emptyDoc({ busStops: stops }), { zones, geo });
  const s = doc.busStops[0];
  assert.equal(zones.cover(s.x, s.z, 0, 0.2, 0.2).solid, 0, 'the flag is off the asphalt');
  assert.ok(s.z > 5.3, 'on the right-hand pavement');
  assert.ok(Math.abs(s.yaw - Math.PI) < 0.05, 'facing the carriageway (towards -z)');
  assert.ok(s.shelterAt && zones.cover(s.shelterAt[0], s.shelterAt[1], s.yaw, 3.2, 1.7).solid === 0, 'the shelter stands on the pavement');
  assert.equal(report.counts.shelters.kept, 1);
  const plan = buildFurniturePlan(emptyDoc({ busStops: stops }), null, { place: (d) => placeFurniture(d, { zones, geo }) });
  assert.equal(plan.shelters.length, 1);
  assert.deepEqual([plan.shelters[0].x, plan.shelters[0].z], s.shelterAt);
  assert.ok(plan.report.counts.busStops.kept === 1 && !('report' in Object.fromEntries(Object.entries(plan))), 'the report rides along without being a plan category');
});

test('the shipped furniture, placed on the shipped layout, has no item on the wrong ground', async () => {
  const { readFileSync } = await import('node:fs');
  const { applyStreets } = await import('../js/layout-cph.js');
  const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
  const geo = read('data/cph-geodata.json');
  applyStreets(geo, read('data/cph-streets.json'));
  const zones = createZoneMap({ geo, lakes: read('data/cph-lakes.json'), surfaces: null });
  const { doc, report } = placeFurniture(read('data/cph-furniture.json'), { zones, geo });
  assert.ok(doc.parkingBays.length > 1000 && doc.trees.length > 4500);
  for (const b of doc.parkingBays) {
    const c = zones.cover(b.x, b.z, b.yaw, 1.95, 4.7);
    assert.ok(c.moving < 0.06 && c.cycle < 0.06 && c.building < 0.03 && c.water === 0 && c.road > 0.85, `bay ${b.x}, ${b.z}: ${JSON.stringify(c)}`);
  }
  for (const t of doc.trees) assert.equal(zones.cover(t.x, t.z, 0, 0.3, 0.3).solid, 0, `tree ${t.x}, ${t.z}`);
  for (const l of doc.lamps.filter((x) => x.mount === 'mast')) assert.equal(zones.cover(l.x, l.z, 0, 0.3, 0.3).solid, 0);
  assert.ok(doc.lamps.filter((l) => l.mount === 'wire').every((l) => l.span && Math.hypot(l.span[2] - l.span[0], l.span[3] - l.span[1]) >= 8));
  assert.ok(report.dropped.length > 0 && report.counts.cars.kept > 1000);
});
