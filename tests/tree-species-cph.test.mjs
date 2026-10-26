import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { genusFromName, resolveGenus, pick, DEFAULT_MIX, LAKESIDE_M } from '../js/tree-species-cph.js';
import { mapTrees, TREE_STYLES } from '../js/street-furniture-data.js';
import { groundField, lakeDistanceFrom } from '../js/ground-field-cph.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('Latin and Danish names map to the genus families', () => {
  const cases = { 'Tilia platyphyllos': 'lime', "Tilia hybr. europaea 'Pallida'": 'lime', 'Aesculus hippocastanum': 'chestnut', 'Platanus hybr. acerifolia': 'plane',
    "Ulmus 'New Horizon'": 'elm', 'Acer platanoides': 'maple', "Prunus avium 'Plena'": 'cherry', 'Hestekastanie': 'chestnut', 'Ginkgo biloba': 'maple', 'Kaktus': 'generic', '': 'generic' };
  for (const [name, genus] of Object.entries(cases)) assert.equal(genusFromName(name), genus, name);
});

test('a recorded genus or species always wins over the context default', () => {
  assert.deepEqual(resolveGenus({ x: 0, z: 0, genus: 'elm' }, { lakeDistance: () => 2 }), { genus: 'elm', source: 'recorded' });
  assert.deepEqual(resolveGenus({ x: 0, z: 0, genus: 'generic', species: 'Tilia sp.' }), { genus: 'lime', source: 'name' });
});

test('default mixes are probability vectors and the pick is stable', () => {
  for (const [k, mix] of Object.entries(DEFAULT_MIX)) assert.ok(Math.abs(mix.reduce((a, [, w]) => a + w, 0) - 1) < 1e-9, k);
  assert.equal(pick(DEFAULT_MIX.lakeside, 0), 'chestnut');
  assert.equal(pick(DEFAULT_MIX.lakeside, 0.999999), DEFAULT_MIX.lakeside.at(-1)[0]);
  const a = resolveGenus({ x: 12.3, z: 45.6, genus: 'generic' }, { lakeDistance: () => 5 });
  assert.deepEqual(a, resolveGenus({ x: 12.3, z: 45.6, genus: 'generic' }, { lakeDistance: () => 5 }));
});

test('real data: the Soerne avenues are lime / horse chestnut, no tree stays generic, every genus has a style', () => {
  const fur = read('../data/cph-furniture.json');
  const lakes = read('../data/cph-lakes.json');
  const field = groundField(lakes, []);
  const lakeDistance = lakeDistanceFrom(field);
  const plan = mapTrees(fur.trees, null, { resolve: (t) => resolveGenus(t, { lakeDistance }) });
  assert.equal(plan.filter((t) => t.genus === 'generic').length, 0, 'the context defaults cover every untyped crown');
  for (const t of plan) assert.ok(TREE_STYLES[t.genus], t.genus);
  const side = plan.filter((t) => t.genusSource === 'lakeside');
  assert.ok(side.length > 300, `${side.length} lakeside trees defaulted`);
  const share = side.filter((t) => t.genus === 'lime' || t.genus === 'chestnut').length / side.length;
  assert.ok(share > 0.8, `lime + chestnut share on the lake avenues ${share.toFixed(2)}`);
  const recorded = fur.trees.filter((t) => (t.canopy_original?.genus ?? t.genus) !== 'generic' && !t.canopy_added).length;
  assert.equal(plan.filter((t) => t.genusSource === 'recorded').length, recorded, 'recorded genera are untouched');
  assert.ok(LAKESIDE_M > 10);
});
