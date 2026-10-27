import assert from 'node:assert/strict';
import test from 'node:test';
import { PHOTO, photoFade, texRequested, selectPhotoSet, wallDistance, lookFile } from '../js/facade-lod.js';
import { createContext, classifyWalls, KIND } from '../js/groundfloor.js';
import { facadeStyle, MAT, ERA, wallMaterial, wallEra } from '../js/facade-style.js';
import { texturedWalls } from '../js/appearance.js';
import { createAccumulator, addBuilding, cleanRing } from '../js/building-geometry.js';

// ---------------------------------------------------------------------------------------------------------------
// LOD selection
// ---------------------------------------------------------------------------------------------------------------
test('photoFade: procedural very close and far, photographic in between, monotone ramps', () => {
  assert.equal(photoFade(0), 0);
  assert.equal(photoFade(PHOTO.close0), 0);
  assert.equal(photoFade(PHOTO.close1), 1);
  assert.equal(photoFade((PHOTO.close1 + PHOTO.near) / 2), 1);
  assert.equal(photoFade(PHOTO.far), 0);
  assert.equal(photoFade(400), 0);
  let prev = 0;
  for (let d = PHOTO.close0; d <= PHOTO.close1; d += 0.5) { const f = photoFade(d); assert.ok(f >= prev - 1e-12); prev = f; }
  prev = 1;
  for (let d = PHOTO.near; d <= PHOTO.far; d += 0.5) { const f = photoFade(d); assert.ok(f <= prev + 1e-12); prev = f; }
  assert.ok(photoFade((PHOTO.close0 + PHOTO.close1) / 2) > 0.3 && photoFade((PHOTO.close0 + PHOTO.close1) / 2) < 0.7, 'smoothstep midpoint');
  assert.ok(PHOTO.residency >= PHOTO.far, 'atlases are resident before the fade starts to show them');
});

test('selectPhotoSet: nearest first, radius respected, nothing that is all nearer than the fade-in', () => {
  const cands = [];
  for (let i = 0; i < 100; i++) cands.push({ id: `b${i}`, cx: i * 2, cz: 0 }); // along x, 0 .. 198 m
  const { want, inRange } = selectPhotoSet(cands, 0, 0);
  const closeLimit = PHOTO.close0 - PHOTO.closeMargin; // 35 m: b18 is the first whose photo can show
  assert.deepEqual(want.slice(0, 3), ['b18', 'b19', 'b20']);
  assert.ok(want.length === 65 && want.at(-1) === 'b82', 'every building from close0 - closeMargin to the 165 m residency radius');
  assert.ok(inRange.has('b82') && !inRange.has('b83') && !inRange.has('b17'), `inRange is the residency band from ${closeLimit} m`);
  const capped = selectPhotoSet(cands, 0, 0, { ...PHOTO, budget: 10 });
  assert.deepEqual(capped.want, cands.slice(18, 28).map((c) => c.id), 'the count cap keeps the nearest');
  const few = selectPhotoSet(cands.slice(0, 10), 400, 0, PHOTO);
  assert.equal(few.want.length, 0);
  const mid = selectPhotoSet(cands, 100, 0);
  assert.deepEqual(mid.want.slice(0, 2).sort(), ['b32', 'b68'], 'b32 / b68 are 36 m away');
  assert.ok(!mid.want.includes('b33') && !mid.want.includes('b50'), 'b33 .. b67 are within 35 m: no photo shows on them');
});

test('selectPhotoSet: distances are to the photo walls in 3D, not to the centre in plan', () => {
  // a 100 m long block: its centre is 80 m away, its near end 30 m
  const long = { id: 'long', cx: 80, cz: 0, walls: { size: [1000, 200], segs: [30, 0, 130, 0], y0: 0, y1: 20 } };
  assert.ok(Math.abs(wallDistance(long, 0, undefined, 0).near - 30) < 1e-9);
  assert.ok(Math.abs(wallDistance(long, 0, undefined, 0).far - 130) < 1e-9);
  assert.equal(selectPhotoSet([long], 0, 0).want.length, 1, 'kept: its far walls are in the photo band');
  // from 400 m up, a building below is outside the photo band (the shader fades it out by 150 m): no atlas
  const below = { id: 'below', cx: 0, cz: 0, walls: { size: [400, 200], segs: [-10, 0, 10, 0], y0: 0, y1: 20 } };
  assert.equal(selectPhotoSet([below], 0, 0, PHOTO, new Map(), 400).want.length, 0);
  assert.equal(selectPhotoSet([below], 60, 0, PHOTO, new Map(), 12).want.length, 1);
});

test('texRequested: photo walls are on by default, ?tex=0 / debug=notex turn them off', () => {
  assert.equal(texRequested(''), true);
  assert.equal(texRequested('?hooks'), true);
  assert.equal(texRequested('?tex=1'), true);
  assert.equal(texRequested('?tex=0'), false);
  assert.equal(texRequested('?debug=nowater,notex'), false);
});

test('lookFile maps the JPEG atlas to the processed WebP', () => {
  assert.equal(lookFile('tex/gdk_1.jpg'), 'tex-look/gdk_1.webp');
});

// ---------------------------------------------------------------------------------------------------------------
// Strip alignment
// ---------------------------------------------------------------------------------------------------------------
const wallObs = (ring, edge, tone) => ({ ring, edge, tone, conf: 'observed', views: ['east_2025_x'], sunlit: true, year: 2025 });
const strip = (edge, len, px) => ({ edge, ring: 0, len_m: len, h_m: 9, texel_m: 0.1, filled_frac: 0.1, uv: px, px: [0, 0, 1, 1] });
function slab(rawRing, atlasStrips) {
  return {
    id: 'gdk:s', ring: rawRing, ground: 0, eave: 9, ridge: 9.2, roof: 'flat', wall_material: 'mursten',
    facade: { floor_h: 3, ground_floor_h: 3.5, window_w: 1.2, bay_w: 4, ground_type: 'residential', tone: [0.5, 0.5, 0.5] },
    observed: {
      walls: rawRing.length ? [0, 1, 2, 3].map((e) => wallObs(0, e, [0.6, 0.55, 0.5])) : [],
      atlas: { file: 'tex/gdk_s.jpg', size: [100, 400], walls: atlasStrips }
    }
  };
}
const RECT = [0, 0, 10, 0, 10, -6, 0, -6]; // CCW seen from above (x, -z)
const quadsOf = (b) => {
  const acc = createAccumulator();
  const quads = [];
  const added = addBuilding(acc, b, { quads });
  return { quads, added, walls: texturedWalls(b, quads, added.mapping) };
};
const verts = (w, quad) => Array.from({ length: 4 }, (_, i) => ({ x: w.position[(quad * 4 + i) * 3], y: w.position[(quad * 4 + i) * 3 + 1], z: w.position[(quad * 4 + i) * 3 + 2], u: w.uv[(quad * 4 + i) * 2], v: w.uv[(quad * 4 + i) * 2 + 1], s: w.wallUV[(quad * 4 + i) * 2], h: w.wallUV[(quad * 4 + i) * 2 + 1] }));

test('strip alignment: a full raw edge maps its strip rectangle onto the whole wall, corner to corner', () => {
  const b = slab(RECT, [strip(0, 10, [0.1, 0.0, 0.9, 0.5])]);
  const { quads, walls } = quadsOf(b);
  assert.equal(walls.count, 1);
  const q = quads[0];
  const vs = verts(walls, 0);
  const nx = -(q.p1[1] - q.p0[1]) / 10, nz = (q.p1[0] - q.p0[0]) / 10;
  // quad corners sit on the wall endpoints (offset only along the outward normal by the safety lift)
  const startCorner = vs.filter((v) => v.s === 0), endCorner = vs.filter((v) => Math.abs(v.s - 10) < 1e-9);
  assert.equal(startCorner.length, 2);
  assert.equal(endCorner.length, 2);
  for (const v of startCorner) { assert.ok(Math.abs(v.x - nx * 0.01 - q.p0[0]) < 1e-6 && Math.abs(v.z - nz * 0.01 - q.p0[1]) < 1e-6); assert.equal(v.u, 0.1); }
  for (const v of endCorner) { assert.ok(Math.abs(v.x - nx * 0.01 - q.p1[0]) < 1e-6 && Math.abs(v.z - nz * 0.01 - q.p1[1]) < 1e-6); assert.equal(v.u, 0.9); }
  const bottom = vs.filter((v) => v.h === 0), top = vs.filter((v) => Math.abs(v.h - 9) < 1e-9);
  assert.equal(bottom.length, 2);
  assert.equal(top.length, 2);
  for (const v of bottom) assert.equal(v.v, 0.5, 'wall foot = bottom row of the strip rectangle (v down)');
  for (const v of top) assert.equal(v.v, 0.0, 'wall top = top row');
  const lift = Math.hypot(vs[0].x - q.p0[0], vs[0].z - q.p0[1]);
  assert.ok(lift <= 0.0101, 'no offset beyond the 1 cm safety lift');
});

test('strip alignment: a raw edge shorter than the cleaned wall covers exactly its own span', () => {
  // south wall is two raw edges (4 m + 6 m) merged into one cleaned wall; the strip of the longer one covers 4..10 m
  const ring = [0, 0, 4, 0, 10, 0, 10, -6, 0, -6];
  const b = slab(ring, [{ edge: 1, ring: 0, len_m: 6, h_m: 9, texel_m: 0.1, filled_frac: 0.1, uv: [0.2, 0.1, 0.8, 0.6], px: [0, 0, 1, 1] }]);
  b.observed.walls = [0, 1, 2, 3, 4].map((e) => wallObs(0, e, [0.6, 0.55, 0.5]));
  const { walls } = quadsOf(b);
  assert.equal(walls.count, 1);
  const vs = verts(walls, 0);
  const sValues = [...new Set(vs.map((v) => +v.s.toFixed(6)))].sort((a, c) => a - c);
  assert.deepEqual(sValues, [4, 10]);
  assert.deepEqual([...new Set(vs.filter((v) => Math.abs(v.s - 4) < 1e-6).map((v) => v.u))], [0.2]);
  assert.deepEqual([...new Set(vs.filter((v) => Math.abs(v.s - 10) < 1e-6).map((v) => v.u))], [0.8]);
});

test('strip alignment: triangles face outwards (CCW seen from outside) for every wall', () => {
  const strips = [0, 1, 2, 3].map((e) => ({ edge: e, ring: 0, len_m: e % 2 ? 6 : 10, h_m: 9, texel_m: 0.1, filled_frac: 0.1, uv: [0, e * 0.25, 1, e * 0.25 + 0.2], px: [0, 0, 1, 1] }));
  const { walls } = quadsOf(slab(RECT, strips));
  assert.equal(walls.count, 4);
  for (let k = 0; k < walls.count; k++) {
    const i = walls.index.slice(k * 6, k * 6 + 3).map((n) => n * 3);
    const [a, bb, c] = i.map((n) => [walls.position[n], walls.position[n + 1], walls.position[n + 2]]);
    const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out = [walls.normal[i[0]], walls.normal[i[0] + 1], walls.normal[i[0] + 2]];
    assert.ok(n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0, `quad ${k} winds towards its normal`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Ground-floor classification
// ---------------------------------------------------------------------------------------------------------------
// x east, z south. Building A occupies x 0..20, z 0..10; its south wall (z = 10) faces a road at z = 18; B abuts A on the east
// (x 20..30). Rings are CCW seen from above (x, -z).
const A = { id: 'A', ring: [0, 10, 20, 10, 20, 0, 0, 0], use: 140, facade: { ground_type: 'entrance' } };
const B = { id: 'B', ring: [20, 10, 30, 10, 30, 0, 20, 0], use: 140, facade: { ground_type: 'entrance' } };
const road = { class: 'residential', name: 'Testgade', width: 8, pts: [-30, 18, 60, 18] };
const wallsOf = (b, ctx) => classifyWalls(b, [cleanRing(b.ring, true)], ctx);

test('ground floor: street-facing wall without a venue is a residential entry, courtyard wall is rear, party wall is blank', () => {
  const ctx = createContext({ roads: [road], buildings: [A, B], venues: [] });
  const k = wallsOf(A, ctx);
  const byNormal = (b, ring) => ring.map((p, i) => { const q = ring[(i + 1) % ring.length]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });
  const mids = byNormal(A, cleanRing(A.ring, true));
  const kindAt = (mx, mz) => k[mids.findIndex(([x, z]) => Math.abs(x - mx) < 0.01 && Math.abs(z - mz) < 0.01)].kind;
  assert.equal(kindAt(10, 10), KIND.entry, 'south wall faces the road');
  assert.equal(kindAt(10, 0), KIND.rear, 'north wall: courtyard side, no road');
  assert.equal(kindAt(20, 5), KIND.lotLine, 'east wall abuts B');
  assert.equal(kindAt(0, 5), KIND.rear, 'west wall: gable on open ground');
});

test('ground floor: a venue in front of or inside the street wall makes a shopfront; the other walls do not follow', () => {
  const cafe = { x: 8, z: 7, kind: 'food' }; // 3 m inside the south wall
  const ctx = createContext({ roads: [road], buildings: [A, B], venues: [cafe] });
  const ring = cleanRing(A.ring, true);
  const k = classifyWalls(A, [ring], ctx);
  const south = ring.findIndex((p, i) => { const q = ring[(i + 1) % ring.length]; return Math.abs(p[1] - 10) < 1e-9 && Math.abs(q[1] - 10) < 1e-9; });
  assert.equal(k[south].kind, KIND.shop);
  assert.equal(k[south].conf, 'observed');
  assert.equal(k[south].venues[0], cafe);
  assert.equal(k.filter((w) => w.kind === KIND.shop).length, 1);
  const far = createContext({ roads: [road], buildings: [A, B], venues: [{ x: 8, z: 60, kind: 'food' }] });
  assert.equal(classifyWalls(A, [ring], far).filter((w) => w.kind === KIND.shop).length, 0, 'a venue far away is not this building');
});

test('ground floor: BBR trade use is an inferred shop; preset blank outbuildings stay blank; courtyard footways are not streets', () => {
  const trade = { ...A, use: 322 };
  const ring = cleanRing(A.ring, true);
  const ctx = createContext({ roads: [road], buildings: [trade, B], venues: [] });
  const shop = classifyWalls(trade, [ring], ctx).find((w) => w.kind === KIND.shop);
  assert.ok(shop && shop.conf === 'inferred');
  const shed = { ...A, facade: { ground_type: 'blank' } };
  assert.ok(classifyWalls(shed, [ring], ctx).every((w) => w.kind === KIND.blank));
  const path = { class: 'footway', pts: [-30, 18, 60, 18], width: 2 }; // unnamed footway
  const ctx2 = createContext({ roads: [path], buildings: [A], venues: [] });
  assert.ok(classifyWalls(A, [ring], ctx2).every((w) => w.kind === KIND.rear), 'no street: every wall is rear');
});

test('ground floor kinds reach the wall vertices (facadeBldg.y) and the style code reaches facadeBldg.z', () => {
  const b = { ...A, ground: 0, eave: 12, ridge: 12, roof: 'flat', storeys: 4, year: 1895, wall_material: 'mursten', facade: { floor_h: 3, ground_floor_h: 3.5, window_w: 1.2, bay_w: 4, ground_type: 'shop', tone: [0.5, 0.3, 0.2] } };
  const ctx = createContext({ roads: [road], buildings: [b, B], venues: [{ x: 8, z: 7 }] });
  const acc = createAccumulator();
  const added = addBuilding(acc, b, { ground: ctx });
  const kinds = new Set();
  for (let i = 0; i < acc.wall.facadeBldg.length; i += 4) kinds.add(acc.wall.facadeBldg[i + 1]);
  assert.ok(kinds.has(KIND.shop) && kinds.has(KIND.rear) && kinds.has(KIND.lotLine));
  assert.equal(added.style.code, MAT.brick + 4 * ERA.historic);
  assert.equal(acc.wall.facadeBldg[2], added.style.code);
  assert.equal(acc.wall.facadeTop.length, acc.wall.position.length / 3);
  assert.equal(acc.wall.facadeTop[0], 12);
});

// ---------------------------------------------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------------------------------------------
test('facade style: material from BBR + colour, era from the BBR year', () => {
  assert.equal(wallMaterial({ wall_material: 'mursten' }, [0.55, 0.3, 0.22]), MAT.brick);
  assert.equal(wallMaterial({ wall_material: 'mursten' }, [0.9, 0.89, 0.86]), MAT.plaster, 'painted-light "brick" is render');
  assert.equal(wallMaterial({ wall_material: 'træ' }, [0.5, 0.4, 0.3]), MAT.timber);
  assert.equal(wallMaterial({ wall_material: 'betonelementer' }, [0.6, 0.6, 0.6]), MAT.concrete);
  assert.equal(wallMaterial({ wall_material: null, year: 1890 }, [0.8, 0.75, 0.6]), MAT.plaster);
  assert.equal(wallMaterial({ wall_material: null, year: 1890 }, [0.5, 0.25, 0.18]), MAT.brick, 'unlabelled but brick coloured');
  assert.equal(wallEra({ year: 1899 }), ERA.historic);
  assert.equal(wallEra({ year: 1930 }), ERA.mid);
  assert.equal(wallEra({ year: 1999 }), ERA.modern);
  const shed = facadeStyle({ year: 1890, storeys: 1, eave: 3, ground: 0, wall_material: 'mursten' }, [0.5, 0.25, 0.2]);
  assert.ok(shed.era < ERA.historic, 'sheds get no cornice');
});
