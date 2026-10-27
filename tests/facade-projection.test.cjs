const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Evaluate the production TSL expressions numerically, without a browser or Three dependency.
const f = Math.fround;
const values = (v) => v instanceof Node ? v.values : Array.isArray(v) ? v : [v];
function binary(a, b, op) {
  a = values(a); b = values(b);
  return new Node(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => op(a[i % a.length], b[i % b.length])));
}
class Node {
  constructor(v) { this.values = values(v).map(f); }
  get x() { return new Node(this.values[0]); }
  get y() { return new Node(this.values[1]); }
  get z() { return new Node(this.values[2]); }
  get w() { return new Node(this.values[3]); }
  get xyz() { return new Node(this.values.slice(0, 3)); }
  add(v) { return binary(this, v, (a, b) => a + b); }
  div(v) { return binary(this, v, (a, b) => a / b); }
  sub(v) { return binary(this, v, (a, b) => a - b); }
  mul(v) { return binary(this, v, (a, b) => a * b); }
  negate() { return this.mul(-1); }
  normalize() { const length = Math.hypot(...this.values); return new Node(this.values.map(v => v / length)); }
  toVar() { return this; }
  setInterpolation(sampling, mode) { this.interpolation = { sampling, mode }; return this; }
}
const unary = (op) => (v) => new Node(values(v).map(op));
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // Row-major normal matrices in this harness.
function matrix(elements) {
  return { mul(v) {
    const a = values(v);
    return new Node([0, 3, 6].map(i => f(f(f(elements[i] * a[0]) + f(elements[i + 1] * a[1])) + f(elements[i + 2] * a[2]))));
  } };
}
const source = readFileSync(join(__dirname, '../js/tsl-materials.js'), 'utf8');
const frame = source.match(/const facadeNormalVertex =[\s\S]*?const facadeAlongZ =[\s\S]*?\.setInterpolation\([\s\S]*?\);/);
assert.ok(frame, 'the shared camera-independent facade frame must exist');
const projectionStart = source.indexOf('function facadeCell(');
const projection = source.slice(source.indexOf('{', projectionStart) + 1, source.indexOf('let bayWidth', projectionStart));
const interiorStart = source.indexOf('const rayWorld =', source.indexOf('const evaluateApartmentInterior'));
const interior = source.slice(interiorStart, source.indexOf('// Slab intersection', interiorStart));
const buildFrame = vm.runInNewContext(`(function (normalLocal, modelNormalMatrix, normalWorldGeometry, cameraViewMatrix) {
  ${frame[0]}
  return {
    normal: facadeWorldNormal, axis: facadeAlongZ,
    project(boxLocal, normalGeometry, positionWorld) { ${projection} return { alongZ, uCoord, isRoof }; },
    interior(positionWorld, cameraPosition, wallTanNode = vec3(0, 0, 0)) { ${interior} return { dirX, dirY, dirZ }; }
  };
})`, {
  THREE: { InterpolationSamplingType: { FLAT: 'flat' }, InterpolationSamplingMode: { EITHER: 'either' } },
  normalize: v => v.normalize(),
  varying: v => new Node(v),
  abs: unary(Math.abs), sign: unary(Math.sign),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  max: (a, b) => binary(a, b, Math.max),
  length: v => new Node(Math.hypot(...values(v))),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  vec3: (...v) => new Node(v.flatMap(values)),
  dot: (a, b) => new Node(values(a).reduce((sum, v, i) => sum + v * values(b)[i], 0))
});
const scalar = v => v.values[0];
const position = new Node([-204.25, 220, 5267.625]);
const eye = new Node([-130, 250, 5180]);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 2e-6, `${actual} should equal ${expected}`);

// Float32 rotation into and out of view space reproduces the old normalWorldGeometry round-trip.
function cameraMatrix(yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(-0.38), sx = Math.sin(-0.38);
  const cz = Math.cos(0.03), sz = Math.sin(0.03);
  return [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx].map(f);
}
function roundTrip(normal, camera) {
  const transpose = [camera[0], camera[3], camera[6], camera[1], camera[4], camera[7], camera[2], camera[5], camera[8]];
  return matrix(transpose).mul(matrix(camera).mul(normal).normalize()).normalize();
}

for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  test(`45-degree facade (${sx}, ${sz}) keeps its windows and room frame across camera rotations`, () => {
    // Exact normal of One WTC's fitted diagonal glass shaft, including its slight outward slope.
    const normal = new Node([sx * 0.7068521976470947, -0.02683299221098423, sz * 0.7068521976470947]);
    const reference = buildFrame(normal, matrix(identity), normal, matrix(identity));
    const room = reference.interior(position, eye);
    const oldAxes = new Set();
    for (let i = 0; i < 720; i++) {
      const camera = cameraMatrix(i * Math.PI / 360);
      const unstable = roundTrip(normal, camera);
      oldAxes.add(Math.abs(unstable.values[0]) >= Math.abs(unstable.values[2]) ? 1 : 0);
      const actual = buildFrame(normal, matrix(identity), unstable, matrix(camera));
      assert.equal(scalar(actual.axis), 1, 'near-equal diagonal components have one deterministic tie-break');
      assert.deepEqual(actual.normal.values, reference.normal.values);
      const projected = actual.project(false, normal, position);
      assert.equal(scalar(projected.uCoord), position.values[2], 'the entire window grid must not switch to world X');
      assert.equal(scalar(projected.isRoof), 0);
      const directions = actual.interior(position, eye);
      for (const key of ['dirX', 'dirY', 'dirZ']) assert.deepEqual(directions[key].values, room[key].values);
    }
    assert.equal(oldAxes.size, 2, 'the fixture must expose the original camera-dependent axis flip');
    assert.equal(reference.axis.interpolation.sampling, 'flat', 'projection choice is constant across each triangle');
    assert.equal(reference.axis.interpolation.mode, 'either');
  });
}

test('cardinal facades retain their original world-coordinate mapping', () => {
  for (const [normal, axis] of [[[1, 0, 0], 1], [[-1, 0, 0], 1], [[0, 0, 1], 0], [[0, 0, -1], 0]]) {
    const n = new Node(normal);
    const frame = buildFrame(n, matrix(identity), n, matrix(identity));
    assert.equal(scalar(frame.axis), axis);
    assert.equal(scalar(frame.project(false, n, position).uCoord), position.values[axis ? 2 : 0]);
  }
});

test('world projection includes object rotation and the inverse scale used for normals', () => {
  // A +Z wall rotated 90 degrees around Y becomes a +X wall.
  const local = new Node([0, 0, 1]);
  const rotation = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const rotated = buildFrame(local, matrix(rotation), local, matrix(identity));
  assert.equal(scalar(rotated.axis), 1);
  assert.equal(scalar(rotated.project(false, local, position).uCoord), position.values[2]);
  assert.equal(scalar(rotated.project(true, local, position).alongZ), 0, 'box-local facade layout still uses its own axes');

  // Scaling a model by (2, 3, 0.5) gives a normal matrix with inverse scales (0.5, 1/3, 2).
  const scale = [0.5, 0, 0, 0, 1 / 3, 0, 0, 0, 2];
  const scaled = buildFrame(new Node([1, 1, 1]), matrix(scale), local, matrix(identity));
  const length = Math.hypot(0.5, 1 / 3, 2);
  [0.5, 1 / 3, 2].forEach((v, i) => close(scaled.normal.values[i], v / length));
  assert.equal(scalar(scaled.axis), 0, 'the dominant world normal component must be selected after inverse scaling');
});

// ---------------------------------------------------------------------------------------------------------------
// wallAttr mode: the wall frame comes from per-vertex attributes (buildings-real.js), not from the world axes.
// ---------------------------------------------------------------------------------------------------------------
const attrStart = source.indexOf('if (wallAttr) {', projectionStart);
const attrEnd = source.indexOf('  const cellId', attrStart);
assert.ok(attrStart > 0 && attrEnd > attrStart, 'the wallAttr block must exist in facadeCell');
const attrBlock = source.slice(attrStart, attrEnd);
const evalWall = vm.runInNewContext(`(function (attribute, facadeWorldNormal, cornerPier, boxLocalBays) {
  let bays = float(1), bayWidth = float(1), bayIdx = float(0), gridU = float(0), inPier = float(0), uCoord = float(0);
  let wallS = float(0), wallW = float(1), tone = float(0.5), kind = float(0), tint = null, winRatioX = null;
  let floorH = float(3), vCoord = float(0), gridV = float(0), wallTan = vec3(0, 0, 0);
  let measured = float(0), measuredSolid = float(0), mSill = float(0), mHead = float(0);
  const wallAttr = true;
  ${attrBlock}
  return { bays, bayWidth, bayIdx, gridU, inPier, uCoord, wallS, wallW, tone, kind, tint, winRatioX, floorH, vCoord, gridV, wallTan, measured, measuredSolid, mSill, mHead };
})`, {
  float: v => new Node(v),
  vec3: (...v) => new Node(v.flatMap(values)),
  floor: unary(Math.floor), min: (a, b) => binary(a, b, Math.min), max: (a, b) => binary(a, b, Math.max),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  mod: (a, b) => binary(a, b, (x, y) => x - y * Math.floor(x / y)), exp2: unary((x) => 2 ** x),
  clamp: (v, lo, hi) => binary(binary(v, lo, Math.max), hi, Math.min),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  normalize: v => v.normalize()
});
const attributes = (a) => (name) => new Node(a[name]);

function wallsOf(building, opts = {}) {
  const { createAccumulator, addBuilding } = geometry;
  const acc = createAccumulator();
  addBuilding(acc, building, opts);
  const w = acc.wall;
  const walls = [];
  for (let q = 0; q < w.position.length / 12; q++) {
    const vertex = (i) => {
      const k = q * 4 + i;
      return {
        position: w.position.slice(k * 3, k * 3 + 3), normal: w.normal.slice(k * 3, k * 3 + 3),
        facadeUV: w.facadeUV.slice(k * 4, k * 4 + 4), facadeWall: w.facadeWall.slice(k * 4, k * 4 + 4),
        facadeBldg: w.facadeBldg.slice(k * 4, k * 4 + 4), facadeTone: w.facadeTone.slice(k * 4, k * 4 + 4),
        facadeTop: w.facadeTop.slice(k * 4, k * 4 + 4), facadeWindow: w.facadeWindow.slice(k * 4, k * 4 + 4)
      };
    };
    walls.push([0, 1, 2, 3].map(vertex));
  }
  return walls;
}
const rectangle = (angleDeg, cx = 100, cz = -40) => {
  const a = angleDeg * Math.PI / 180;
  const pts = [[-10, -6], [10, -6], [10, 6], [-10, 6]]; // x east, north up; CCW in the (x, north) plane
  const ring = [];
  for (const [x, n] of pts) ring.push(cx + x * Math.cos(a) - n * Math.sin(a), cz - (x * Math.sin(a) + n * Math.cos(a)));
  return { id: 'test:rect', ring, holes: [], ground: 0, eave: 18, ridge: 18, roof: 'flat', facade: { floor_h: 3, ground_floor_h: 4, window_w: 1.2, bay_w: 3, ground_type: 'shop', tone: [0.7, 0.6, 0.5] }, conf_fields: { facade: 'inferred' } };
};
let geometry;
test.before(async () => { geometry = await import('../js/building-geometry.js'); });

for (const angle of [0, 15, 45, 90, 200]) {
  test(`wallAttr: a wall at ${angle} degrees gets its window grid from its own frame`, () => {
    const walls = wallsOf(rectangle(angle));
    assert.equal(walls.length, 4);
    for (const wall of walls) {
      const [a, b] = wall;
      const len = a.facadeWall[0];
      const d = [(b.position[0] - a.position[0]) / len, (b.position[2] - a.position[2]) / len];
      for (const vtx of wall) {
        const f = evalWall(attributes(vtx), new Node(vtx.normal), 0.9);
        // u is metres along the wall from its start, whatever the wall's world direction
        const along = (vtx.position[0] - a.position[0]) * d[0] + (vtx.position[2] - a.position[2]) * d[1];
        close(vtx.facadeUV[0], along);
        // the shader's tangent is the wall direction and lies in the horizontal plane
        close(f.wallTan.values[0], d[0]); close(f.wallTan.values[1], 0); close(f.wallTan.values[2], d[1]);
        // outward normal is perpendicular to the wall
        close(vtx.normal[0] * d[0] + vtx.normal[2] * d[1], 0);
        // whole bays between the corner piers; the grid cell is about the requested 3 m
        close(f.bays.values[0] * f.bayWidth.values[0] + 1.8, len);
        assert.ok(Math.abs(f.bayWidth.values[0] - 3) < 3 / f.bays.values[0] + 1e-6);
        assert.equal(f.kind.values[0], 0, 'shop ground floor');
        close(f.vCoord.values[0], vtx.facadeUV[1]); // v is metres above the ground, not world y
      }
    }
  });
}

test('wallAttr: window grid is rigid-motion invariant (same cells at the same wall positions for any rotation)', () => {
  const reference = wallsOf(rectangle(0));
  for (const angle of [15, 45, 133]) {
    const rotated = wallsOf(rectangle(angle, -300, 222));
    rotated.forEach((wall, w) => wall.forEach((vtx, i) => {
      const r = evalWall(attributes(vtx), new Node(vtx.normal), 0.9);
      const o = evalWall(attributes(reference[w][i]), new Node(reference[w][i].normal), 0.9);
      for (const key of ['gridU', 'gridV', 'bayWidth', 'inPier']) close(r[key].values[0], o[key].values[0]);
    }));
  }
});

test('wallAttr: the ground floor is cell 0 with its own height, every storey above uses floor_h', () => {
  const [wall] = wallsOf(rectangle(15));
  const at = (v) => evalWall(attributes({ ...wall[0], facadeUV: [5, v, 0, 0] }), new Node(wall[0].normal), 0.9).gridV.values[0];
  close(at(0), 0); close(at(4), 1); // ground_floor_h = 4
  close(at(2), 0.5);
  const floorH = wall[0].facadeWall[1];
  close(at(4 + floorH * 2), 3);
  assert.ok(Math.abs(floorH * Math.round(14 / 3) - 14) < 1e-5, 'floor height is fitted so whole storeys end at the eave');
});

test('wallAttr: walls of a concave ring and a courtyard hole all face away from the solid, with winding to match', () => {
  // L-shaped block (CCW) with a rectangular courtyard
  const ring = [0, 0, 30, 0, 30, -12, 12, -12, 12, -30, 0, -30];
  const hole = [4, -4, 4, -8, 8, -8, 8, -4]; // CW seen from above
  const building = { ...rectangle(0), id: 'test:L', ring, holes: [hole] };
  const flatToPts = (r) => r.map((v, i) => i % 2 ? null : [v, r[i + 1]]).filter(Boolean);
  const inside = (p) => {
    const inRing = (pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) if ((pts[i][1] > p[1]) !== (pts[j][1] > p[1]) && p[0] < ((pts[j][0] - pts[i][0]) * (p[1] - pts[i][1])) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c; return c; };
    return inRing(flatToPts(ring)) && !inRing(flatToPts(hole));
  };
  const walls = wallsOf(building);
  assert.equal(walls.length, 6 + 4);
  for (const wall of walls) {
    const [a, b] = wall;
    const mid = [(a.position[0] + b.position[0]) / 2, (a.position[2] + b.position[2]) / 2];
    const n = [a.normal[0], a.normal[2]];
    assert.equal(inside([mid[0] + n[0] * 0.02, mid[1] + n[1] * 0.02]), false, 'in front of the wall is outside the solid');
    assert.equal(inside([mid[0] - n[0] * 0.02, mid[1] - n[1] * 0.02]), true, 'behind the wall is inside the solid');
    // triangle (0, 1, 2) must be counter-clockwise seen from outside
    const e1 = [0, 1, 2].map((k) => b.position[k] - a.position[k]);
    const e2 = [0, 1, 2].map((k) => wall[2].position[k] - a.position[k]);
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    assert.ok(cross[0] * a.normal[0] + cross[2] * a.normal[2] > 0, 'front face points out of the building');
    const f = evalWall(attributes(a), new Node(a.normal), 0.9);
    close(f.wallTan.values[0] * a.normal[0] + f.wallTan.values[2] * a.normal[2], 0);
  }
});

test('wallAttr: a measured window grid (js/facade-layout.js) replaces the guessed bays, storeys and sill / head on its wall only', () => {
  // the rectangle's raw edge 0 runs 20 m along its first wall; a measured layout: 5 columns at 3.2 m from u0 = 1.5, the middle one blind,
  // ground floor 4.4 m, storeys 3.1 m, three rows, sill 0.9 / head 2.5, ground bays 0, 1 and 4 open
  const b = rectangle(15);
  const lay = { u0: 1.5, p: 3.2, n: 5, w: 1.2, cm: 0b11011, g: 4.4, f: 3.1, rows: 3, sill: 0.9, head: 2.5, gm: 0b10011, conf: 0.9 };
  b.observed = { walls: [{ ring: 0, edge: 0, tone: [0.7, 0.6, 0.5], conf: 'observed' }], atlas: { walls: [{ ring: 0, edge: 0, len_m: 20 }] }, layout: { '0:0': lay } };
  const walls = wallsOf(b);
  const vtx = walls[0][0];
  close(vtx.facadeWall[1], 3.1); close(vtx.facadeWall[2], 4.4); close(vtx.facadeWall[3], 3.2);
  const at = (u, v) => evalWall(attributes({ ...vtx, facadeUV: [u, v, vtx.facadeUV[2], vtx.facadeUV[3]] }), new Node(vtx.normal), 0.9);
  const f = at(1.5 + 3.2 * 0.5, 6);
  assert.equal(f.measured.values[0], 1);
  close(f.bays.values[0], 5); close(f.bayWidth.values[0], 3.2); close(f.bayIdx.values[0], 0);
  assert.ok(Math.abs(f.mSill.values[0] - 0.9 / 3.1) < 0.004 && Math.abs(f.mHead.values[0] - 2.5 / 3.1) < 0.004, 'sill / head as storey fractions');
  close(f.gridV.values[0], 1 + (6 - 4.4) / 3.1);
  const solid = (u, v) => at(u, v).measuredSolid.values[0];
  assert.equal(solid(1.5 + 3.2 * 0.5, 6), 0, 'column 0, first storey: windows');
  assert.equal(solid(1.5 + 3.2 * 2.5, 6), 1, 'column 2 is blind');
  assert.equal(solid(0.7, 6), 1, 'before the first column: wall');
  assert.equal(solid(1.5 + 3.2 * 5.2, 6), 1, 'after the last column: wall');
  assert.equal(solid(1.5 + 3.2 * 3.5, 4.4 + 3.1 * 3 + 0.5), 1, 'above the measured rows: wall');
  assert.equal(solid(1.5 + 3.2 * 1.5, 2), 0, 'ground bay 1 open');
  assert.equal(solid(1.5 + 3.2 * 3.5, 2), 1, 'ground bay 3 closed');
  // the other walls keep the guessed grid
  assert.equal(at(5, 6).inPier.values[0], 0);
  const other = evalWall(attributes(walls[1][0]), new Node(walls[1][0].normal), 0.9);
  assert.equal(other.measured.values[0], 0);
  assert.equal(other.measuredSolid.values[0], 0);
});
