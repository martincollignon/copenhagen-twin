import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance } from '../js/tile-store.js';
import { RING_LAYERS } from '../js/tile-rings.js';
import { computeBuildings } from '../js/building-compute.js';

const ring = [100, 100, 110, 100, 110, 110, 100, 110];
const mk = (id, extra = {}) => ({ id, ring, holes: [], ground: 0, eave: 6, ridge: 6, roof: 'flat', storeys: 2, wall_material: 'mursten', roof_material: 'tagpap', facade: { floor_h: 3, ground_floor_h: 3, window_w: 1, bay_w: 5, tone: [0.6, 0.4, 0.3] }, ...extra });

test('appearance is a ring layer of near and mid tiles', () => {
  assert.ok(RING_LAYERS.near.includes('appearance') && RING_LAYERS.mid.includes('appearance'));
});

test('applyAppearance sets observed by id and never replaces an existing block', () => {
  const district = { walls: [{ edge: 0, ring: 0, tone: [1, 0, 0], conf: 'observed' }], roof: null };
  const list = [mk('gdk:1'), mk('gdk:2', { observed: district }), mk('gdk:3')];
  const atlas = { file: 'tex/gdk_1.jpg', size: [10, 10], walls: [] };
  applyAppearance(list, { buildings: { 'gdk:1': { walls: [{ edge: 0, ring: 0, tone: [0.5, 0.5, 0.5], conf: 'observed' }], roof: { tone: [0.2, 0.3, 0.4], conf: 'observed' }, summary: { wall: [0.5, 0.5, 0.5], roof: [0.2, 0.3, 0.4] }, atlas }, 'gdk:2': { walls: [], roof: null } } });
  assert.equal(list[0].observed.roof.tone[2], 0.4);
  assert.equal(list[0].observed.atlas, atlas);
  assert.equal(list[1].observed, district);
  assert.equal(list[2].observed, undefined);
});

test('photo candidates need an atlas descriptor, not a place in the district', () => {
  const walls = [{ edge: 0, ring: 0, len_m: 10, h_m: 6, texel_m: 0.1, filled_frac: 0.2, uv: [0, 0, 1, 0.5], px: [0, 0, 100, 60] }];
  const far = mk('gdk:9', { ring: ring.map((v) => v + 5000) });
  far.observed = { walls: [{ edge: 0, ring: 0, tone: [0.5, 0.5, 0.5], conf: 'observed' }], roof: null, atlas: { file: 'tex/gdk_9.jpg', size: [100, 60], walls } };
  const out = computeBuildings({ buildings: [far, mk('gdk:8', { ring: ring.map((v) => v + 5000) })], wantQuads: true, doors: false });
  assert.deepEqual(out.texCandidates.map((c) => c.id), ['gdk:9']);
});
