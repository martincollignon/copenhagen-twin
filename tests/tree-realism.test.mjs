import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as data from '../js/street-furniture-data.js';
import * as season from '../js/tree-season.js';
import { resolveGenus } from '../js/tree-species-cph.js';
import { treeCapacities, originalTreeBudget, selectTreeDraws, treeVertexBufferCount } from '../js/tree-budget.js';
import { groundField, lakeDistanceFrom } from '../js/ground-field-cph.js';
import { loadTreeGeometry, loadTreeShadow } from './helpers/tree-geometry.cjs';

const read = name => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url)));
const doc = read('cph-furniture');
const T = loadTreeGeometry(data, season);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const genera = Object.keys(data.TREE_STYLES);

test('canopy medians move toward LiDAR; grouped corrections keep their measured evidence', () => {
  const original = doc.trees.filter(t => t.canopy_original);
  assert.equal(median(original.map(t => t.canopy_original.crown_radius)), 3.5);
  assert.equal(median(original.map(t => t.crown_radius)), 4.38);
  assert.ok(Math.abs(4.38 - doc.tree_canopy.lidar_radius_median) < Math.abs(3.5 - doc.tree_canopy.lidar_radius_median));
  for (const t of original) {
    if (!t.crown_measurement) { assert.equal(t.crown_radius, t.canopy_original.crown_radius); continue; }
    const m = t.crown_measurement;
    assert.ok(Math.abs(m.radius - Math.sqrt(m.area / Math.PI)) < 0.011);
    assert.equal(t.conf_fields.crown_radius, m.isolated ? 'measured' : 'scaled');
    assert.ok(m.src.every(src => t.src.includes(src)));
    if (!m.isolated) assert.ok(t.crown_radius <= Math.max(0.9, t.canopy_original.crown_radius * 1.25) + 0.011);
    if (t.canopy_original.genus !== 'generic') assert.equal(t.genus, t.canopy_original.genus);
    if (t.canopy_original.conf_fields?.height === 'measured') assert.equal(t.height, t.canopy_original.height);
  }
});

test('all canopy additions have observation provenance and are outside the original trunks', () => {
  const original = doc.trees.filter(t => !t.canopy_added), added = doc.trees.filter(t => t.canopy_added);
  assert.equal(added.length, 644);
  assert.equal(doc.tree_canopy.added_trees, added.length);
  assert.equal(doc.stats.trees, original.length + added.length);
  assert.equal(doc.tree_canopy.input_trees, original.length);
  for (const t of added) {
    assert.ok(t.canopy_area >= 12);
    assert.equal(t.conf, 'observed');
    assert.ok(t.src.includes('dhm:punktsky:class5'));
    assert.ok(t.src.includes('geodanmark:orto_foraar_cir:2025-04-27'));
    assert.ok(original.every(o => Math.hypot(t.x - o.x, t.z - o.z) > 9));
  }
  assert.equal(added.filter(t => t.conf_fields.height === 'measured').length, doc.tree_canopy.height_measured);
});

test('measured crowns and short trees reach the renderer without a height/radius ratio clamp', () => {
  const plan = data.mapTrees(doc.trees, null);
  doc.trees.forEach((t, i) => {
    assert.equal(plan[i].height, t.height);
    assert.equal(plan[i].crownR, t.crown_radius);
    assert.ok(plan[i].crown.cy + plan[i].crown.ry <= t.height);
  });
  assert.deepEqual(data.treeDimensions({ height: 2.1, crown_radius: 6 }), { height: 2.1, crownRadius: 6 });
});

test('date conversion reuses Copenhagen validation and handles midnight, invalid dates and leap years', () => {
  for (const date of [undefined, null, 'invalid', '2026-02-30', '2026-10-26', '2024-10-26']) assert.equal(season.treeDayOfYear(date), 299);
  assert.equal(season.treeDayOfYear('2026-01-01'), 1);
  assert.equal(season.treeDayOfYear('2026-12-31'), 365);
  assert.equal(season.treeDayOfYear(new Date('2026-06-20T22:30:00Z')), 172, 'Copenhagen is already on June 21');
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /treeDate: lightingSystem.currentSunDateTime/);
  assert.doesNotMatch(readFileSync(new URL('../js/tree-season.js', import.meta.url), 'utf8'), /URLSearchParams|location.search/);
});

test('October chestnut, lime, plane and willow retain distinct colours and densities', () => {
  const { treeSeason, TREE_SEASONS } = season;
  for (const [genus, retained] of [['chestnut', 0.45], ['lime', 0.65], ['plane', 0.80], ['willow', 0.88]]) {
    assert.ok(Math.abs(treeSeason(genus).density - retained) < 1e-12);
    treeSeason(genus).colour.forEach((v, i) => assert.ok(Math.abs(v - TREE_SEASONS[genus].autumn[i]) < 1e-12));
  }
  assert.ok(treeSeason('willow').colour[1] > treeSeason('willow').colour[0]);
  for (const genus of genera) {
    assert.equal(treeSeason(genus, 190).density, 1);
    for (const day of [35, 355]) assert.equal(treeSeason(genus, day).density, genus === 'conifer' ? 1 : 0);
    for (let day = 1; day <= 365; day++) {
      const state = treeSeason(genus, day);
      assert.ok(state.density >= 0 && state.density <= 1 && state.litter >= 0 && state.litter <= 1);
    }
  }
});

test('individual October trees span green, gold and brown with species-appropriate retention', () => {
  const trees = doc.trees.filter(t => t.lakeside);
  const offsets = trees.map(t => season.treePhenologyOffset(t.x, t.z));
  assert.ok(Math.min(...offsets) < -10 && Math.max(...offsets) > 10);
  assert.ok(offsets.every(offset => Math.abs(offset) <= 12));
  assert.deepEqual(offsets, trees.map(t => season.treePhenologyOffset(t.x, t.z)), 'stable across rebuilds');
  for (const [genus, min, max] of [['chestnut', 0.30, 0.60], ['lime', 0.60, 0.80]]) {
    const states = trees.map(t => T.treeInstanceSeason(genus, 299, t.x, t.z));
    assert.ok(states.every(s => s.density >= min && s.density <= max));
    assert.ok(states.some(s => s.colour[1] > s.colour[0]), `${genus} includes green individuals`);
    assert.ok(states.some(s => s.colour[0] > s.colour[1] * 1.2), `${genus} includes gold/brown individuals`);
    assert.ok(new Set(states.map(s => s.colour.map(c => Math.round(c * 255)).join(','))).size > 100);
  }
  for (const genus of genera) for (let day = 275; day <= 330; day++) {
    const [r, g, b] = season.treeLeafColour(genus, day, T.LOOK[genus].leaf);
    assert.ok(g > b * 1.4 && g > r * 0.45, `${genus}/${day} avoids pink or red-heavy browns`);
    const state = T.treeInstanceSeason(genus, day, 12, 34);
    assert.ok([...state.early, ...state.late].every(Number.isFinite));
    if (genus !== 'conifer' && day === 296) assert.notDeepEqual(state.early.slice(0, 3), state.late.slice(0, 3), 'leaf hue endpoints differ');
  }
});

test('shared seasonal meshes retain every eligible individual spray and expose wood', () => {
  for (const genus of ['chestnut', 'lime', 'plane', 'willow']) for (const build of [T.buildNearTree, T.buildMidTree]) {
    const full = build(genus, 190), autumn = build(genus, 299, { variation: true });
    const ranks = geometry => {
      const leaf = geometry.attributes.leafData, result = new Set();
      for (const i of geometry.index.array) if (leaf.data.array[i * leaf.data.stride + leaf.offset + 3]) result.add(leaf.getX(i));
      return [...result];
    };
    const all = ranks(full), retained = ranks(autumn);
    for (let offset = -12; offset <= 12; offset++) {
      const density = season.treeSeason(genus, 299 + offset).density;
      assert.equal(retained.filter(r => r < density).length, all.filter(r => r < density).length);
    }
    assert.equal(autumn.userData.woodTriangles, full.userData.woodTriangles);
    assert.ok(autumn.index.count <= full.index.count);
    if (genus === 'chestnut') {
      const fraction = retained.filter(r => r < 0.45).length / all.length;
      assert.ok(fraction >= 0.3 && fraction <= 0.6, `chestnut retained sprays: ${fraction}`);
    }
  }
});

test('near leaf sprays have smaller metric edges and folded corners without more triangles', () => {
  for (const [genus, maxMedian, triangles] of [['chestnut', 1.10, 1918], ['lime', 0.65, 2454], ['plane', 0.90, 1878]]) {
    const geometry = T.buildNearTree(genus, 190), p = geometry.attributes.position;
    const leaf = geometry.attributes.leafData, edges = [];
    let folded = 0;
    const point = i => [p.getX(i), p.getY(i), p.getZ(i)];
    const sub = (a, b) => a.map((v, i) => v - b[i]);
    for (let i = 0; i < geometry.index.count; i += 6) {
      const [a, b, c, , , d] = Array.from(geometry.index.array.slice(i, i + 6));
      if (leaf.getX(a) < 0) continue;
      const ab = sub(point(b), point(a)), ac = sub(point(c), point(a)), ad = sub(point(d), point(a));
      edges.push(Math.hypot(...ab));
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      if (Math.abs(cross.reduce((sum, v, k) => sum + v * ad[k], 0)) > 1e-5) folded++;
    }
    assert.ok(median(edges) < maxMedian, `${genus} metric spray size ${median(edges)}`);
    assert.equal(folded, edges.length, 'every spray has non-coplanar corners');
    assert.equal(geometry.index.count / 3, triangles, 'summer topology stays at the main budget');
  }
});

test('near and mid trees shed actual sprays, preserve wood, and fit per-tree metric dimensions', () => {
  for (const genus of genera) for (const build of [T.buildNearTree, T.buildMidTree]) {
    const summer = build(genus, 190), autumn = build(genus, 299), winter = build(genus, 35);
    assert.ok(autumn.index.count <= summer.index.count);
    assert.equal(winter.userData.woodTriangles, summer.userData.woodTriangles);
    assert.ok(winter.userData.woodTriangles >= 168);
    if (genus !== 'conifer') {
      assert.equal(winter.userData.leafCards, 0);
      assert.equal(winter.index.count / 3, winter.userData.woodTriangles);
      assert.ok(autumn.userData.leafCards < summer.userData.leafCards);
    }
    const [tree] = data.mapTrees([{ x: 0, z: 0, height: 18, crown_radius: 6, genus }]);
    const p = summer.attributes.position, n = summer.attributes.normal;
    let radius = 0, top = 0;
    for (let i = 0; i < p.count; i++) {
      radius = Math.max(radius, Math.hypot(p.getX(i), p.getZ(i)) * tree.sxz);
      top = Math.max(top, p.getY(i) * tree.sy);
      assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-6);
    }
    assert.ok(Math.abs(radius - 6) < 1e-5, `${genus} radius ${radius}`);
    assert.ok(Math.abs(top - 18) < 1e-5, `${genus} height ${top}`);
    const a = summer.attributes.position.data.array, b = winter.attributes.position.data.array;
    for (let i = 0; i < a.length; i += summer.attributes.position.data.stride) assert.deepEqual(a.slice(i, i + 3), b.slice(i, i + 3), 'shedding never resizes wood');
  }
});

test('each tree material stays within eight vertex buffers including four for instanceMatrix', () => {
  for (const genus of genera) for (const geometry of [T.buildNearTree(genus), T.buildMidTree(genus), T.buildBillboard(0)]) {
    T.attachTreeSeasonAttributes(geometry, 1);
    assert.equal(treeVertexBufferCount(geometry), 7);
    assert.ok(treeVertexBufferCount(geometry) <= 8, `${genus} colour/shadow material`);
  }
  const loose = { attributes: Object.fromEntries(['position', 'normal', 'uv', 'color', 'sway'].map(k => [k, {}])) };
  assert.equal(treeVertexBufferCount(loose, { colored: true }), 10, 'detects the original unpacked layout');
  assert.equal(treeVertexBufferCount(T.buildTreeLitterGeometry()), 5, 'litter also packs its attributes');
  assert.equal(treeVertexBufferCount(loadTreeShadow(data)), 8, 'existing crown shadow proxy remains within the limit');
});

test('distant winter atlas retains branch strokes and removes deciduous leaf dabs', () => {
  const draw = day => {
    let branches = 0, leaves = 0;
    const context = new Proxy({ stroke() { branches++; }, ellipse() { leaves++; },
      getImageData() { return { data: new Uint8Array(T.BILL.cols * T.BILL.w * T.BILL.rows * T.BILL.h * 4) }; }
    }, { get: (target, key) => target[key] || (() => {}) });
    const document = { createElement: () => ({ getContext: () => context }) };
    loadTreeGeometry(data, season, document).createBillboardAtlas(['chestnut', 'lime', 'plane', 'willow'], day);
    return { branches, leaves };
  };
  const winter = draw(35), autumn = draw(299), summer = draw(190);
  assert.ok(winter.branches > 100);
  assert.equal(winter.leaves, 0);
  assert.equal(winter.branches, summer.branches);
  assert.ok(autumn.leaves > 0 && autumn.leaves < summer.leaves);
});

test('real-data camera budgets never exceed original draws/triangles across three seasons', () => {
  const lakeDistance = lakeDistanceFrom(groundField(read('cph-lakes'), []));
  const trees = data.mapTrees(doc.trees, null, { resolve: t => resolveGenus(t, { lakeDistance }) });
  const caps = treeCapacities(trees), originalCaps = treeCapacities(trees, true);
  const full = Object.fromEntries(genera.map(g => [g, { near: T.buildNearTree(g, 190).index.count / 3, mid: 260, far: 4 }]));
  let added = 0;
  for (const day of [35, 190, 299]) {
    const costs = Object.fromEntries(genera.map(g => [g, { near: T.buildNearTree(g, day, { variation: true }).index.count / 3, mid: T.buildMidTree(g, day, { variation: true }).index.count / 3, far: 4 }]));
    for (const x of [-600, -300, 0, 300, 600]) for (const z of [-600, -300, 0, 300, 600]) {
      const candidates = trees.map(tree => ({ tree, distance: Math.hypot(tree.x - x, tree.z - z) }));
      const budget = originalTreeBudget(candidates, full, originalCaps);
      const result = selectTreeDraws(candidates, costs, caps, budget);
      assert.ok(result.draws <= budget.draws);
      assert.ok(result.triangles <= budget.triangles);
      assert.equal(result.selected.length, candidates.filter(s => s.distance <= 950).length, 'keep the complete distant treeline');
      assert.equal(new Set(result.selected.map(s => s.tree)).size, result.selected.length);
      assert.equal(result.triangles, result.selected.reduce((sum, s) => sum + costs[s.tree.genus][s.lod], 0));
      added += result.selected.filter(s => s.tree.canopyAdded).length;
    }
  }
  assert.ok(added > 100, 'observed additions are admitted within the budget');
});

test('litter keeps its surveyed ground origin when a trunk moves; summer coverage is zero', () => {
  const records = doc.trees.filter(t => t.litter_points?.length);
  assert.ok(records.length > 400);
  for (const t of records) {
    assert.ok(['chestnut', 'lime'].includes(t.genus));
    const [mapped] = data.mapTrees([{ ...t, x: t.x + 3, z: t.z + 2 }]);
    assert.deepEqual(mapped.litterOrigin, t.litter_origin);
    assert.equal(t.litter_points.length % 2, 0);
    for (let i = 0; i < t.litter_points.length; i += 2) assert.ok(Math.hypot(t.litter_points[i], t.litter_points[i + 1]) <= t.crown_radius + 0.02);
  }
  assert.equal(season.treeSeason('chestnut', 190).litter, 0);
  assert.ok(season.treeSeason('chestnut', 299).litter > 0.3);
});
