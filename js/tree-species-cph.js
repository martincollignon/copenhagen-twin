import { hash2 } from './street-furniture-data.js';

// js/tree-species-cph.js
// Pure tree-species logic of the Copenhagen twin: Latin / Danish name -> the genus family the procedural models know, and
// the default genus for the ~3,700 laser-detected crowns that carry no species at all. The defaults follow the visual
// references (docs/research/visual-refs.md §9): the Soerne avenues are lime (Tilia) and horse chestnut (Aesculus),
// limes are KK's most common street tree (5,325 = 26 % of the street trees), the rest of the city is a mixed stock.

/** Latin / Danish name prefixes (lower case) -> genus family; first hit wins (same table as tools/cph-geodata/furniture.py). */
export const GENUS_NAMES = [
  ['tilia', 'lime'], ['lind', 'lime'], ['aesculus', 'chestnut'], ['hestekastanie', 'chestnut'], ['kastanie', 'chestnut'],
  ['ulmus', 'elm'], ['elm', 'elm'], ['acer', 'maple'], ['løn', 'maple'], ['platan', 'plane'], ['quercus', 'oak'], ['eg', 'oak'],
  ['prunus', 'cherry'], ['kirsebær', 'cherry'], ['robin', 'robinia'], ['sophora', 'robinia'], ['styphnolobium', 'robinia'],
  ['populus', 'poplar'], ['salix', 'willow'], ['fraxinus', 'ash'], ['ailanthus', 'ash'], ['betula', 'birch'],
  ['crataegus', 'hawthorn'], ['malus', 'hawthorn'], ['pyrus', 'hawthorn'], ['sorbus', 'hawthorn'], ['corylus', 'hawthorn'],
  ['metasequoia', 'conifer'], ['pinus', 'conifer'], ['picea', 'conifer'], ['fagus', 'maple'], ['alnus', 'birch'],
  ['ginkgo', 'maple'], ['liriodendron', 'maple'], ['liriodéndron', 'maple'], ['catalpa', 'maple'], ['catálpa', 'maple'], ['liquidambar', 'maple'],
  ['cercidiph', 'maple'], ['pterocarya', 'ash'], ['pterocárya', 'ash'], ['magnolia', 'cherry']
];

/** Genus family of a Latin or Danish tree name, or 'generic' when nothing matches. */
export function genusFromName(name) {
  const words = String(name || '').toLowerCase().match(/[a-zæøåéüáíóú]+/g) || [];
  for (const [needle, key] of GENUS_NAMES) if (words.slice(0, 2).some((w) => w.startsWith(needle))) return key;
  return 'generic';
}

/** Default genus mixes (weights sum to 1) by context. */
export const DEFAULT_MIX = Object.freeze({
  // within LAKESIDE_M of the Soerne: the lake avenues
  lakeside: [['chestnut', 0.46], ['lime', 0.42], ['plane', 0.06], ['maple', 0.06]],
  // KK street trees: lime is the most common
  street: [['lime', 0.34], ['plane', 0.12], ['maple', 0.16], ['elm', 0.10], ['chestnut', 0.08], ['cherry', 0.1], ['ash', 0.1]],
  // courtyards, parks and everything else
  mixed: [['maple', 0.22], ['lime', 0.16], ['chestnut', 0.1], ['ash', 0.14], ['birch', 0.1], ['cherry', 0.1], ['hawthorn', 0.1], ['elm', 0.08]]
});
export const LAKESIDE_M = 28;

/** Weighted pick from a mix for a stable [0, 1) value. */
export function pick(mix, u) {
  let acc = 0;
  for (const [g, w] of mix) {
    acc += w;
    if (u < acc) return g;
  }
  return mix[mix.length - 1][0];
}

/**
 * Genus for one tree record. A recorded genus / species wins; an unknown one gets a context default:
 * `lakeDistance(x, z)` metres to the nearest Soerne wall (or null), `category` 'gadetræ' = street tree.
 * Returns { genus, source }: source is 'recorded' | 'name' | 'lakeside' | 'street' | 'mixed'.
 */
export function resolveGenus(tree, { lakeDistance = null } = {}) {
  if (tree.genus && tree.genus !== 'generic') return { genus: tree.genus, source: 'recorded' };
  const named = genusFromName(tree.species || tree.name);
  if (named !== 'generic') return { genus: named, source: 'name' };
  const u = hash2(tree.x, tree.z, 4242);
  const d = lakeDistance ? lakeDistance(tree.x, tree.z) : null;
  if (d != null && d <= LAKESIDE_M) return { genus: pick(DEFAULT_MIX.lakeside, u), source: 'lakeside' };
  if (tree.category === 'gadetræ') return { genus: pick(DEFAULT_MIX.street, u), source: 'street' };
  return { genus: pick(DEFAULT_MIX.mixed, u), source: 'mixed' };
}
