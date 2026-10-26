import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
