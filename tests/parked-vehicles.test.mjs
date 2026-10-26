import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { applyStreets } from '../js/layout-cph.js';
import { createZoneMap } from '../js/zones-cph.js';
import { createRoadIndex, placeFurniture } from '../js/placement-cph.js';
import { buildFurniturePlan, composeYaw, indexItems } from '../js/street-furniture-data.js';
import { CAR_BODY_TYPES } from '../js/vehicle-fleet.js';
import { loadVehicleMaterials } from './helpers/vehicle-material.cjs';

const models = loadVehicleMaterials();
const materials = Object.fromEntries(CAR_BODY_TYPES.map((body) => [body, models.createLoftedCarMaterial(models.BODY_SPECS[body])]));
const transform = (p, m) => [0, 1, 2].map((i) => p[0] * m[i] + p[1] * m[4 + i] + p[2] * m[8 + i] + m[12 + i]);
const vertex = (material, env) => material.positionNode ? material.positionNode.eval(env) : env.positionLocal;

test('parked near and far cars contain no taxi signs or shared taxi material', () => {
  // Execute the renderer's construction path, including its spec and material-cache choices.
  const source = readFileSync(new URL('../js/street-furniture-cph.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const carSets = {}');
  const end = source.indexOf('// ------------------------------------------------------------------------------------------- props', start);
  assert.ok(start >= 0 && end > start);
  const sets = vm.runInNewContext(`(() => { ${source.slice(start, end)} return carSets; })()`, {
    ...models, CAR_BODY_TYPES, plan: { cars: CAR_BODY_TYPES.map((body) => ({ body })) }, count: (n) => n,
    mk: (name, geometry, material) => ({ name, geometry, material })
  });
  for (const body of CAR_BODY_TYPES) for (const lod of ['near', 'far']) {
    const { geometry, material } = sets[body][lod];
    assert.ok(!Array.from(geometry.attributes.partId.array).includes(6), `${body} ${lod} must have no sign vertices, irrespective of instance state`);
    if (models.BODY_SPECS[body].taxiSign) assert.notEqual(material, materials[body], `${body} parked material must not reuse the traffic taxi shader`);
    assert.equal(material.positionNode, undefined, 'parked geometry keeps its instance transform');
  }
});

test('Ravnsborggade keeps at least 60% of its bays occupied after instancing and both LODs', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url)));
  const geo = read('cph-geodata');
  applyStreets(geo, read('cph-streets'));
  const roads = createRoadIndex(geo), zones = createZoneMap({ geo, lakes: read('cph-lakes'), surfaces: read('cph-surfaces') });
  const onStreet = (b) => roads.nearest(b.x, b.z)?.rec.r.name === 'Ravnsborggade';
  const doc = read('cph-furniture');
  const bays = doc.parkingBays.filter(onStreet);
  const plan = buildFurniturePlan(doc, null, { place: (d) => placeFurniture(d, { geo, zones }) });
  const placedBays = plan.placedDoc.parkingBays.filter(onStreet);
  const cars = indexItems(plan.cars).queryRange(-10, -675, 110).filter(onStreet);
  assert.ok(bays.length >= 30, 'use the real street, not an empty fixture');
  const plannedShare = cars.length / placedBays.length;
  assert.ok(plannedShare >= 0.70 && plannedShare <= 0.85, `planned occupancy: ${cars.length}/${placedBays.length}`);
  for (const proxy of [false, true]) {
    let occupied = 0;
    for (const c of cars) {
      const spec = models.BODY_SPECS[c.body];
      const geometry = proxy ? models.buildCarProxyGeometry(spec) : models.buildCarGeometry(spec, true);
      const p = geometry.attributes.position, ids = geometry.attributes.partId;
      const i = Array.from(ids.array).findIndex((id) => id === 0);
      const local = [p.getX(i), p.getY(i), p.getZ(i)];
      const matrix = new Float32Array(16);
      composeYaw(matrix, 0, c.x, c.y, c.z, c.yaw);
      const expected = transform(local, matrix);
      const actual = vertex(materials[c.body], { position: local, positionLocal: expected, partId: 0, carState: [0, 0, 0, 0] });
      if (Math.hypot(...actual.map((v, j) => v - expected[j])) < 0.01) occupied++;
    }
    assert.ok(occupied / bays.length >= 0.60, `${proxy ? 'far' : 'near'} street occupancy: ${occupied}/${bays.length} (${(100 * occupied / bays.length).toFixed(1)}%)`);
    assert.equal(occupied, cars.length, 'every assigned car stays in its own bay');
  }
});

test('taxi and private body vertices retain translated, rotated instance positions', () => {
  for (const body of CAR_BODY_TYPES) for (const taxi of [0, 1]) {
    const material = materials[body], matrix = new Float32Array(16);
    composeYaw(matrix, 0, -38, 0.2, -640, 1.2, 0.9, 1.1, 1.2);
    for (const partId of [0, 1, 2, 3, 4, 5]) {
      const local = [0.4, 0.8, 1.5], expected = transform(local, matrix);
      assert.deepEqual(vertex(material, { position: local, positionLocal: expected, partId, carState: [0, 0, 0, taxi] }), expected, `${body}, part ${partId}, taxi ${taxi}`);
    }
  }
});

test('only taxi instances show the roof sign, while private car bodies remain visible', () => {
  for (const body of ['crossoverEV', 'estate']) for (const taxi of [0, 1]) {
    const material = materials[body];
    for (const partId of [0, 1, 2, 3, 4, 5, 6]) {
      assert.equal(material.maskNode.eval({ partId, carState: [0, 0, 0, taxi] })[0], partId !== 6 || taxi === 1);
    }
  }
});

test('moving taxi signs follow the chassis transform and map TAXI across their roof-mounted face', () => {
  for (const body of ['crossoverEV', 'estate']) {
    const spec = models.BODY_SPECS[body], material = materials[body];
    for (const geometry of [models.buildCarGeometry(spec, false), models.buildCarProxyGeometry(spec)]) {
      const p = geometry.attributes.position, ids = geometry.attributes.partId, points = [];
      for (let i = 0; i < p.count; i++) if (ids.getX(i) === 6) points.push([p.getX(i), p.getY(i), p.getZ(i)]);
      const lo = [0, 1, 2].map((a) => Math.min(...points.map((p) => p[a])));
      const hi = [0, 1, 2].map((a) => Math.max(...points.map((p) => p[a])));
      const matrix = new Float32Array(16);
      composeYaw(matrix, 0, -50, 0.2, -605, 2.4);
      for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]) {
        const local = [lo[0] + u * (hi[0] - lo[0]), lo[1] + v * (hi[1] - lo[1]), hi[2]];
        const expected = transform(local, matrix), carState = [0, 0, 0, 1];
        assert.deepEqual(vertex(material, { position: local, positionLocal: expected, partId: 6, carState }), expected);
        const color = material.colorNode.eval({ position: local, normal: [0, 0, 1], partId: 6, carState, paintColor: [0.2, 0.3, 0.4],
          sampleTexture: (tex, uv) => tex.image.width === 256 ? [uv[0], uv[1], 0.875, 1] : [0, 0, 0, 1]
        });
        for (const [i, value] of [u, v, 0.875].entries()) assert.ok(Math.abs(color[i] - value) < 1e-6, `${body} sign UV channel ${i}`);
      }
    }
  }
});

test('all modern bodies sample Danish plate textures on both front and rear faces', () => {
  for (const body of CAR_BODY_TYPES) for (const end of [0, 1]) {
    const spec = models.BODY_SPECS[body], material = materials[body];
    const front = end === 0, x = 0.08;
    let plateUV;
    const color = material.colorNode.eval({
      position: [x, spec.plates[end], front ? spec.zFront : spec.zRear], normal: [0, 0, front ? 1 : -1],
      partId: 0, carState: [0, 0, 0, 0], paintColor: [0.2, 0.3, 0.4],
      sampleTexture(tex, uv) {
        if (tex.image.width !== 520) return [0, 0, 0, 1];
        plateUV = uv;
        return [uv[0], uv[1], 0.875, 1];
      }
    });
    assert.ok(plateUV, `${body} ${front ? 'front' : 'rear'} samples the atlas`);
    const expected = [(front ? x : -x) / 0.52 + 0.5, plateUV[1], 0.875];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(color[i] - expected[i]) < 1e-6, `${body} ${front ? 'front' : 'rear'} plate channel ${i}: ${color[i]}`);
    assert.ok(plateUV[1] >= 0 && plateUV[1] <= 1);
  }
});
