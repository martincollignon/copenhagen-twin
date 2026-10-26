const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const { THREE: geometryDouble, geometryUtils } = require('./helpers/vehicle-geometry.cjs');
const fleet = loadModule(readFileSync(join(__dirname, '../js/vehicle-fleet.js'), 'utf8'));
const source = readFileSync(join(__dirname, '../js/actor-models.js'), 'utf8');
let models, canvases;

test.before(async () => {
  // A locally installed Three build can also exercise the suite against its actual primitives, without a browser.
  const engine = process.env.CPH_THREE_MODULE ? await import(process.env.CPH_THREE_MODULE) : geometryDouble;
  canvases = [];
  const document = { createElement() {
    const canvas = { draws: [] };
    const ctx = {};
    for (const name of ['fillRect', 'strokeRect', 'fillText']) ctx[name] = (...args) => canvas.draws.push({ name, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle });
    canvas.getContext = () => ctx;
    canvases.push(canvas);
    return canvas;
  } };
  models = loadModule(source, {
    imports: {
      'three/webgpu': { ...engine, CanvasTexture: class { constructor(image) { this.image = image; } } },
      'three/tsl': { Fn: (fn) => fn },
      './tsl-materials.js': {}, './vehicle-fleet.js': fleet,
      'three/addons/utils/BufferGeometryUtils.js': geometryUtils(engine)
    }, globals: { document }
  });
});

function checkGeometry(g) {
  const { position, normal, uv, partId } = g.attributes;
  assert.ok(position.count > 50 && g.index.count > 150);
  for (const attr of [position, normal, uv, partId]) assert.ok(Array.from(attr.array).every(Number.isFinite));
  assert.equal(normal.count, position.count);
  assert.equal(uv.count, position.count);
  assert.equal(partId.count, position.count);
  for (const index of g.index.array) assert.ok(index >= 0 && index < position.count);
}

for (const name of ['sedan', 'suv', ...fleet.CAR_BODY_TYPES]) {
  test(`${name} builds finite non-empty near and proxy geometry without chrome`, () => {
    const spec = models.BODY_SPECS[name];
    assert.equal(spec.chrome, false);
    const near = models.buildCarGeometry(spec, true), proxy = models.buildCarProxyGeometry(spec);
    checkGeometry(near); checkGeometry(proxy);
    assert.ok(proxy.index.count < near.index.count, 'the distant model reduces triangles');
    for (const geo of [near, proxy]) {
      const p = geo.attributes.position, ids = geo.attributes.partId;
      const zs = [], ys = [];
      for (let i = 0; i < p.count; i++) if (ids.getX(i) === 0 || ids.getX(i) === 1) { zs.push(p.getZ(i)); ys.push(p.getY(i)); }
      assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - spec.length) < 0.01);
      assert.ok(Math.max(...ys) > 1.4 && Math.max(...ys) < 2.7);
    }
  });
}

test('modern bodies have separate silhouettes, body dimensions and lamp positions', () => {
  const specs = models.BODY_SPECS;
  for (const [name, dimensions] of Object.entries({ crossoverEV: [4.6, 1.88, 1.63], hatch: [4.2, 1.79, 1.5], estate: [4.7, 1.83, 1.48], van: [5.9, 2, 2.65] })) {
    const s = specs[name];
    assert.deepEqual(Array.from([s.length, s.width, s.height]), dimensions);
    assert.ok(s.massRatio > 0 && s.massRatio < 1);
    assert.ok(s.headlight[0] < s.width / 2 && s.headlight[1] < s.height);
    assert.ok(s.wheelZ + s.wheelRadius < s.zFront);
    assert.ok(Math.abs(s.cabin.deck - s.zRear) < 0.12, 'no sedan boot deck');
  }
  assert.equal(specs.crossoverEV.lightBar, true);
  assert.equal(specs.crossoverEV.aero, true);
  assert.equal(specs.estate.rails, true);
  assert.equal(specs.van.panelVan, true);
  assert.ok(specs.estate.cabin.roofRear < specs.hatch.cabin.roofRear);
});

test('plate atlases keep every row at the physical aspect and provide white and yellow fields', () => {
  const { CAR_PLATE } = fleet;
  for (const commercial of [false, true]) {
    const tex = models.carPlateTexture(commercial), c = tex.image;
    assert.equal(c.width / (c.height / CAR_PLATE.variants), CAR_PLATE.width / CAR_PLATE.height);
    const field = c.draws.find((d) => d.name === 'fillRect');
    assert.equal(field.fill, commercial ? '#f3cf25' : '#f4f4ef');
    assert.equal(c.draws.filter((d) => d.name === 'fillText' && d.args[0] === 'DK').length, CAR_PLATE.variants);
    assert.equal(c.draws.filter((d) => d.name === 'fillText' && /^[A-Z]{2} \d{2} \d{3}$/.test(d.args[0])).length, CAR_PLATE.variants);
    assert.equal(c.draws.filter((d) => d.name === 'strokeRect' && d.stroke === '#bf2831').length, CAR_PLATE.variants);
    assert.equal(models.carPlateTexture(commercial), tex, 'atlas is shared');
  }
  assert.notEqual(models.carPlateTexture(false), models.carPlateTexture(true));
});

test('long buses have three wheel arches and a visible 18.75 m bellows body', () => {
  for (const s of [models.BUS_SPEC, models.BUS_LONG_SPEC]) {
    const g = models.buildLoftedBusBodyGeometry(s);
    checkGeometry(g);
    const p = g.attributes.position, ids = g.attributes.partId;
    const zs = [];
    let bellows = 0, signs = 0;
    for (let i = 0; i < p.count; i++) {
      if (ids.getX(i) === 0) zs.push(p.getZ(i));
      if (ids.getX(i) === 3) bellows++;
      if (ids.getX(i) === 4) signs++;
    }
    assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - s.length) < 0.01);
    assert.equal(bellows > 0, s === models.BUS_LONG_SPEC);
    assert.equal(signs, 12, 'front, side and rear displays share the body draw');
  }
  assert.equal(models.BUS_LONG_SPEC.axles.length, 3);
  assert.equal(models.BUS_LONG_SPEC.length, 18.75);
  assert.equal(models.BUS_LONG_SPEC.aLine, false);
});
