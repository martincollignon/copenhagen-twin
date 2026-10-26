import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccumulator, addBuilding, hashString } from '../js/building-geometry.js';
import { selectDetailEdges } from '../js/building-details.js';
import { createContext, classifyWalls, KIND } from '../js/groundfloor.js';

const rect = (length = 10, width = 6) => [0, 0, length, 0, length, -width, 0, -width];
const building = (extra = {}) => ({
  id: 'detail:1', ring: rect(), holes: [], ground: 0, eave: 10, ridge: 10, roof: 'flat', year: 1890,
  facade: { floor_h: 3, ground_floor_h: 3.3, bay_w: 3, window_w: 1.2, tone: [0.68, 0.54, 0.42] },
  ...extra
});

function roofRecord(length = 10, width = 6, eave = 5, ridge = 8) {
  const p = [
    [0, eave, 0], [length, eave, 0], [length, ridge, -width / 2], [0, ridge, -width / 2],
    [length, eave, -width], [0, eave, -width]
  ];
  return {
    nV: p.length, nT: 4, nE: 4,
    pos: Float32Array.from(p.flat()),
    idx: Uint16Array.from([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]),
    kind: new Uint8Array(4), edge: new Int16Array(4).fill(-1), top: new Float32Array(4).fill(eave)
  };
}

const pointKey = (position, i) => [0, 1, 2].map((k) => Math.round(position[i * 3 + k] * 1e5)).join(',');

function assertWatertightPart(acc, part) {
  const edges = new Map();
  const detail = acc.roof;
  for (let i = part.start; i < part.end; i += 3) {
    const ids = [detail.index[i], detail.index[i + 1], detail.index[i + 2]];
    const p = ids.map((v) => [detail.position[v * 3], detail.position[v * 3 + 1], detail.position[v * 3 + 2]]);
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const nl = Math.hypot(...n);
    assert.ok(nl > 1e-8, `${part.kind} has no degenerate triangles`);
    for (const id of ids) {
      const normal = detail.normal.slice(id * 3, id * 3 + 3);
      assert.ok(normal.every(Number.isFinite), `${part.kind} has finite normals`);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6, `${part.kind} normals are unit length`);
      assert.ok(n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] > nl * 0.999, `${part.kind} winding matches its normals`);
    }
    for (let e = 0; e < 3; e++) {
      const a = pointKey(detail.position, ids[e]);
      const b = pointKey(detail.position, ids[(e + 1) % 3]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.ok(edges.size > 0, `${part.kind} has triangles`);
  for (const [edge, count] of edges) assert.equal(count, 2, `${part.kind} edge ${edge} is shared by exactly two triangles`);
}

function verticesOfPart(acc, part) {
  const out = [];
  for (let i = part.start; i < part.end; i++) {
    const v = acc.roof.index[i];
    out.push([acc.roof.position[3 * v], acc.roof.position[3 * v + 1], acc.roof.position[3 * v + 2]]);
  }
  return out;
}

test('detail selector reuses main street classification and excludes courtyards and party walls', () => {
  const b = building();
  const rings = [[[0, 0], [10, 0], [10, -6], [0, -6]], [[3, -2], [3, -4], [7, -4], [7, -2]]];
  const road = { class: 'residential', name: 'Testgade', width: 4, pts: [-20, 3, 30, 3] };
  const ctx = createContext({ roads: [road], buildings: [b] });
  assert.deepEqual(selectDetailEdges(rings, classifyWalls(b, rings, ctx)), [true, false, false, false, false, false, false, false]);
  assert.ok(selectDetailEdges(rings, Array(8).fill({ kind: KIND.lotLine })).every((v) => !v));
  assert.ok(selectDetailEdges(rings, classifyWalls(b, rings, createContext())).every((v) => !v));
});

test('detail selection favors long frontages while keeping the four-edge budget', () => {
  const rings = [[[0, 0], [20, 0], [20, -2], [18, -2], [18, -10], [0, -10]]];
  assert.deepEqual(selectDetailEdges(rings, Array(6).fill({ kind: KIND.entry })), [true, false, false, true, true, true]);
});

test('historic cornice, dark plinth and gutter are closed, mitered solids under the eave', () => {
  const acc = createAccumulator();
  const b = building();
  const added = addBuilding(acc, b, { streetEdges: [true, true, true, true, true, true, true, true] });
  assert.ok(added.detailTriangles > 0);
  assert.equal(acc.roofRanges[0].id, b.id);
  assert.equal(acc.roofRanges[0].end, acc.roof.index.length, "trim shares the existing roof draw range");
  assert.deepEqual(acc.detailParts.map((p) => p.kind), ['cornice', 'plinth', 'gutter']);
  for (const part of acc.detailParts) assertWatertightPart(acc, part);

  const cornice = verticesOfPart(acc, acc.detailParts.find((p) => p.kind === 'cornice'));
  const corniceY = cornice.map((p) => p[1]);
  assert.ok(Math.max(...corniceY) < b.eave, 'cornice stays below the eave');
  assert.ok(Math.max(...corniceY) - Math.min(...corniceY) >= 0.4 && Math.max(...corniceY) - Math.min(...corniceY) <= 0.7);
  assert.ok(Math.min(...cornice.map((p) => p[0])) <= -0.25 && Math.min(...cornice.map((p) => p[0])) >= -0.45, 'cornice projection is within the Copenhagen range');

  const plinth = verticesOfPart(acc, acc.detailParts.find((p) => p.kind === 'plinth'));
  const plinthY = plinth.map((p) => p[1]);
  assert.ok(Math.max(...plinthY) - Math.min(...plinthY) >= 0.6 && Math.max(...plinthY) - Math.min(...plinthY) <= 1.2);
  assert.ok(Math.min(...plinth.map((p) => p[0])) <= -0.03 && Math.min(...plinth.map((p) => p[0])) >= -0.05, 'plinth projects 3–5 cm');

  const gutter = verticesOfPart(acc, acc.detailParts.find((p) => p.kind === 'gutter'));
  assert.ok(Math.max(...gutter.map((p) => p[1])) < b.eave, 'zinc band sits below the eave');
  assert.ok(Math.min(...gutter.map((p) => p[0])) < -0.5, 'historic gutter projects past the cornice so it remains visible');
  assert.ok(acc.roof.mat.some((v) => v > 0.5), 'zinc gutter carries a metal value');
});

test('main era rules give mid-era and unknown-year fronts trim, but modern buildings and sheds none', () => {
  for (const extra of [{ year: 1965 }, { year: 1890, storeys: 1, eave: 3 }, { facade: { ground_type: 'blank' } }]) {
    const acc = createAccumulator();
    addBuilding(acc, building(extra), { streetEdges: [true, true, true, true] });
    assert.equal(acc.detailParts.length, 0);
  }
  for (const extra of [{ year: 1935 }, { year: null, storeys: 4 }]) {
    const acc = createAccumulator();
    addBuilding(acc, building(extra), { streetEdges: [true, true, false, false] });
    assert.deepEqual(acc.detailParts.map((p) => p.kind), ['cornice', 'plinth', 'gutter']);
    for (const part of acc.detailParts) assertWatertightPart(acc, part);
    assert.equal(acc.detailParts.find((p) => p.kind === 'plinth').end - acc.detailParts.find((p) => p.kind === 'plinth').start, 60);
    assert.deepEqual(acc.wall.facadeWindow.filter((_, i) => i % 4 === 1).map((v) => Math.floor(v / 4)), [...Array(8).fill(1), ...Array(8).fill(0)], 'painted cornice disabled only where physical trim exists');
  }
});

test('ridge chimneys follow shared pitched LoD2 roof edges at roughly ten metre spacing', () => {
  const acc = createAccumulator();
  const b = building({ id: 'detail:roof', ring: rect(40, 8), ground: 0, eave: 5, ridge: 8, year: 1910, roof: 'pitched' });
  const rec = roofRecord(40, 8, 5, 8);
  const sourceBuilding = structuredClone(b);
  const sourceRecord = { ...rec, pos: rec.pos.slice(), idx: rec.idx.slice(), kind: rec.kind.slice(), edge: rec.edge.slice(), top: rec.top.slice() };
  addBuilding(acc, b, { lod2: rec, streetEdges: [true, true, true, true] });
  assert.deepEqual(b, sourceBuilding, 'the BBR source record is unchanged');
  assert.deepEqual([...rec.pos], [...sourceRecord.pos], 'LoD2 positions are unchanged');
  assert.deepEqual([...rec.idx], [...sourceRecord.idx], 'LoD2 indices are unchanged');
  const chimneys = acc.detailParts.filter((p) => p.kind === 'chimney');
  assert.equal(chimneys.length, 4, '40 m ridge has four evenly spaced stacks');
  for (const part of acc.detailParts) assertWatertightPart(acc, part);
  const lod2Gutter = verticesOfPart(acc, acc.detailParts.find((p) => p.kind === 'gutter'));
  assert.ok(Math.max(...lod2Gutter.map((p) => p[1])) < 5, 'gutter follows below the measured LoD2 eaves');
  const centers = chimneys.map((part) => {
    const points = verticesOfPart(acc, part);
    return points.reduce((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length, s[2] + p[2] / points.length], [0, 0, 0]);
  }).sort((a, b2) => a[0] - b2[0]);
  assert.ok(centers.every((p) => Math.abs(p[2] + 4) < 0.01), 'stacks lie on the measured ridge line at z = -4');
  const spacing = centers.slice(1).map((p, i) => p[0] - centers[i][0]);
  assert.ok(spacing.every((d) => d >= 8 && d <= 12), 'chimney spacing remains in the target range');

  const modern = createAccumulator();
  addBuilding(modern, { ...b, id: 'detail:modern-roof', year: 1940 }, { lod2: roofRecord(40, 8, 5, 8), streetEdges: [true, true, true, true] });
  assert.equal(modern.detailParts.some((p) => p.kind === 'chimney'), false, 'post-1939 buildings get no inferred ridge stacks');

  const flat = createAccumulator();
  const flatRoof = { ...roofRecord(10, 6, 5, 5), pos: Float32Array.from([
    0, 5, 0, 10, 5, 0, 10, 5, -6, 0, 5, -6
  ]), idx: Uint16Array.from([0, 1, 2, 0, 2, 3]), nV: 4, nT: 2 };
  addBuilding(flat, { ...building({ id: 'detail:flat', ground: 0, eave: 5, ridge: 5, year: 1910 }), roof: 'flat' }, { lod2: flatRoof, streetEdges: [true, true, true, true] });
  assert.equal(flat.detailParts.some((p) => p.kind === 'chimney'), false, 'flat LoD2 roof gets no ridge stacks');
});

test('decorative bands stay on the outer ring and leave courtyard walls untouched', () => {
  const acc = createAccumulator();
  const b = building({
    ring: [0, 0, 20, 0, 20, -10, 0, -10],
    holes: [[5, -3, 5, -7, 15, -7, 15, -3]]
  });
  addBuilding(acc, b, { streetEdges: [true, true, true, true, true, true, true, true] });
  for (const part of acc.detailParts) assertWatertightPart(acc, part);
  const all = acc.detailParts.flatMap((part) => verticesOfPart(acc, part));
  for (const [x, , z] of all) {
    assert.equal(x > 4.9 && x < 15.1 && z < -2.9 && z > -7.1, false, 'no detail enters the courtyard ring');
  }
});

test('an unselected concave outer ring still yields closed detail solids', () => {
  const acc = createAccumulator();
  const b = building({
    id: 'detail:concave', year: 1890,
    ring: [0, 0, 12, 0, 12, -4, 8, -4, 8, -8, 4, -8, 4, -4, 0, -4]
  });
  addBuilding(acc, b, { streetEdges: [true, true, true, true, true, true, true, true] });
  assert.ok(acc.detailParts.length > 0);
  for (const part of acc.detailParts) assertWatertightPart(acc, part);
});

test('physical plinths leave main entrance bays open and stop below shop glazing', () => {
  for (const kind of [KIND.entry, KIND.shop]) {
    const b = building({ ring: rect(30, 8) });
    const acc = createAccumulator();
    addBuilding(acc, b, { wallKinds: [{ kind }, ...Array(3).fill({ kind: KIND.rear })] });
    const bays = Math.floor((30 - 1.8) / 3 + 0.5), bay = (30 - 1.8) / bays;
    const doorBay = Math.min(Math.floor((hashString(String(b.id)) % 1000) / 1000 * bays), bays - 1);
    const door0 = 0.9 + (doorBay + 0.21) * bay, door1 = 0.9 + (doorBay + 0.79) * bay;
    const plinths = acc.detailParts.filter((p) => p.kind === 'plinth');
    assert.ok(plinths.length);
    for (const part of plinths) {
      assertWatertightPart(acc, part);
      const points = verticesOfPart(acc, part);
      assert.ok(points.every(([x]) => x <= door0 + 1e-6 || x >= door1 - 1e-6));
      const xs = points.map(([x]) => x);
      assert.ok(Math.max(...xs) <= door0 + 1e-6 || Math.min(...xs) >= door1 - 1e-6, 'no plinth spans the doorway');
      if (kind === KIND.shop) assert.ok(points.every(([, y]) => y <= b.facade.ground_floor_h * 0.17 + 1e-6));
    }
  }
});
