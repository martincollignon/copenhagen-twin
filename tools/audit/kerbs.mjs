// Kerbs inside carriageways, ranked by place. Usage: node tools/audit/kerbs.mjs [--depth 1] [--top 40] [--json out.json] [--views views.json] [--noclip]
// (--noclip measures the kerbs as they were drawn before road-surfaces-cph.js cut them at the carriageways)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStreets } from '../../js/layout-cph.js';
import { buildRoadSurfaceArrays } from '../../js/road-surfaces-cph.js';
import { kerbIntrusions, classify } from './kerbs-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const depth = Number(arg('--depth', 1));
const top = Number(arg('--top', 40));

const geo = read('data/cph-geodata.json');
applyStreets(geo, read('data/cph-streets.json'));
const surfaces = read('data/cph-surfaces.json');
const layers = buildRoadSurfaceArrays(geo, { surfaces, pavement: true, clipKerbs: !process.argv.includes('--noclip') });
const runs = layers.kerb.runs;
let total = 0;
for (const r of runs) total += r.pts.length;
const hits = kerbIntrusions(geo, runs, { depth });
console.log(`kerb runs ${runs.length}; samples inside a carriageway (> ${depth} m from both edges): ${hits.length}`);

const byCat = new Map();
for (const h of hits) byCat.set(classify(h), (byCat.get(classify(h)) || 0) + 1);
console.log('by category:', Object.fromEntries([...byCat].sort((a, b) => b[1] - a[1])));
const byKind = new Map();
for (const h of hits) byKind.set(h.kind, (byKind.get(h.kind) || 0) + 1);
console.log('by kerb kind:', Object.fromEntries(byKind));

// cluster: owner road + intruded road, 25 m cells
const cl = new Map();
for (const h of hits) {
  const k = `${h.owner.id}|${h.into.id}|${h.kind}|${Math.round(h.x / 25)}|${Math.round(h.z / 25)}`;
  const c = cl.get(k) || { n: 0, x: 0, z: 0, h, maxDepth: 0 };
  c.n++; c.x += h.x; c.z += h.z; c.maxDepth = Math.max(c.maxDepth, h.depth);
  cl.set(k, c);
}
const list = [...cl.values()].sort((a, b) => b.n - a.n);
console.log(`\n${list.length} clusters; top ${top}:`);
console.log('n\tx\tz\tcat\tkind\towner (class, hw) -> into (class, hw)\tmaxDepth');
for (const c of list.slice(0, top)) {
  const { h } = c;
  const hw = (r) => (r.cs ? r.cs.hw : '?');
  console.log(`${c.n}\t${(c.x / c.n).toFixed(1)}\t${(c.z / c.n).toFixed(1)}\t${classify(h)}\t${h.kind}${h.side ? (h.side > 0 ? 'R' : 'L') : ''}\t${h.owner.name || '-'} [${h.owner.id} ${h.owner.class} ${hw(h.owner)}] -> ${h.into.name || '-'} [${h.into.id} ${h.into.class} ${hw(h.into)}]\t${c.maxDepth.toFixed(1)}`);
}
const out = arg('--json', null);
if (out) {
  writeFileSync(out, JSON.stringify(list.map((c) => ({ n: c.n, x: +(c.x / c.n).toFixed(1), z: +(c.z / c.n).toFixed(1), cat: classify(c.h), kind: c.h.kind, owner: c.h.owner.id, ownerName: c.h.owner.name, into: c.h.into.id, intoName: c.h.into.name })), null, 1));
}

// camera views of the worst places (for tools/shoot-m2.py --kerbs): per category the biggest clusters, 40 m apart
const viewsOut = arg('--views', null);
if (viewsOut) {
  const per = { 'crossing-road': 5, 'parallel-same-name': 3, 'parallel-other-road': 2, 'own-bend': 2, 'mouth-arc': 2 };
  const picked = [];
  for (const [cat, k] of Object.entries(per)) {
    // named streets first: those are the ones a visitor walks down
    const cands = list.filter((c) => classify(c.h) === cat).sort((a, b) => (!!b.h.into.name - !!a.h.into.name) || b.n - a.n);
    const usedNames = new Set();
    let got = 0;
    for (const c of cands) {
      if (got >= k) break;
      const x = c.x / c.n;
      const z = c.z / c.n;
      if (picked.some((p) => Math.hypot(p.at[0] - x, p.at[1] - z) < 40) || (c.h.into.name && usedNames.has(c.h.into.name))) continue;
      if (c.h.into.name) usedNames.add(c.h.into.name);
      // look along the intruded carriageway from 16 m back, 2.5 m up
      const p = c.h.into.pts;
      let best = null;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2] - p[i]; const dz = p[i + 3] - p[i + 1]; const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
        const d = Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z);
        if (!best || d < best.d) best = { d, ux: dx / Math.sqrt(l2), uz: dz / Math.sqrt(l2) };
      }
      const name = `${String(picked.length + 1).padStart(2, '0')}-${cat}-${(c.h.into.name || c.h.into.id).replace(/[^\wæøåÆØÅ]+/g, '_')}`;
      picked.push({ name, at: [+x.toFixed(1), +z.toFixed(1)], cat, owner: c.h.owner.name || c.h.owner.id, into: c.h.into.name || c.h.into.id, n: c.n,
        pos: [+(x - best.ux * 16 - best.uz * 1.5).toFixed(2), 2.6, +(z - best.uz * 16 + best.ux * 1.5).toFixed(2)], look: [+x.toFixed(2), 0, +z.toFixed(2)], fov: 60 });
      picked.push({ name: `${name}-top`, at: [+x.toFixed(1), +z.toFixed(1)], cat, pos: [+(x - best.ux * 8).toFixed(2), 22, +(z - best.uz * 8 + 0.01).toFixed(2)], look: [+x.toFixed(2), 0, +z.toFixed(2)], fov: 55 });
      got++;
    }
  }
  writeFileSync(viewsOut, JSON.stringify(picked, null, 1));
  console.log(`\n${picked.length} views -> ${viewsOut}`);
  for (const v of picked) if (!v.name.endsWith('-top')) console.log(`  ${v.name}  at ${v.at}  (${v.owner} kerb in ${v.into}, ${v.n} samples)`);
}
