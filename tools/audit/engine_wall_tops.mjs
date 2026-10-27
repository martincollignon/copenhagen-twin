// Dumps the wall frame the engine draws for the citywide tile buildings, using the engine's own pure modules: per raw ring edge
// (the key of the appearance atlas strips) the ground and the top of the cleaned wall it lands on (js/building-geometry.js
// addBuilding opts.quads: the roofer LoD2 eave of that edge, or the DSM/BBR eave, and the roofer wall pieces above it), as the tile streamer assembles a building
// (js/tile-data.js buildings(): street-layout footprint fixes, terrain ground; js/buildings-real.js: no LoD2 for a fixed footprint).
// The atlas pipeline's Python port (tools/cph-geodata/engine_walls.py) is checked against this dump.
// Usage: node tools/audit/engine_wall_tops.mjs <tiles dir> <tile id> [...tile ids] > out.json
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAccumulator, addBuilding, cleanRing } from '../../js/building-geometry.js';
import { mapObservedEdges } from '../../js/appearance.js';
import { parseLod2Record } from '../../js/lod2-geometry.js';
import { applyStreets, applyTerrainGround } from '../../js/layout-cph.js';

const [tilesDir, ...tiles] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = {};
for (const tid of tiles) {
  const dir = resolve(tilesDir, tid);
  if (!existsSync(resolve(dir, 'buildings.json'))) continue;
  const list = read(resolve(dir, 'buildings.json')).buildings.filter((b) => b.ring?.length >= 6);
  const mini = { buildings: list.map((b) => ({ ...b })), roads: [] };
  const streets = existsSync(resolve(dir, 'streets.json')) ? read(resolve(dir, 'streets.json')) : null;
  if (streets?.buildings) applyStreets(mini, { roads: {}, buildings: streets.buildings });
  const terrainDoc = existsSync(resolve(dir, 'terrain.json')) ? read(resolve(dir, 'terrain.json')) : null;
  if (terrainDoc) applyTerrainGround(mini, { flat: false, doc: terrainDoc });
  const lodIdx = existsSync(resolve(dir, 'lod2.json')) ? read(resolve(dir, 'lod2.json')).buildings : {};
  const bin = existsSync(resolve(dir, 'lod2.bin')) ? readFileSync(resolve(dir, 'lod2.bin')) : null;
  const buf = bin ? bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) : null;
  for (const b of mini.buildings) {
    const e = lodIdx[b.id];
    const rec = !b.footprintFix && buf && e?.conf === 'measured' && e.offset !== undefined && e.offset + e.length <= buf.byteLength
      ? parseLod2Record(buf, e.offset, e.length) : null;
    const quads = [];
    const added = addBuilding(createAccumulator(), { ...b, observed: null }, { quads, details: false, ...(rec ? { lod2: rec } : {}) });
    if (!added) continue;
    const topOf = new Map(quads.map((q) => [q.edgeNo, q.top]));
    const quadOf = new Map(quads.map((q) => [q.edgeNo, q]));
    const rings = [cleanRing(b.ring, true), ...(b.holes || []).map((h) => cleanRing(h, false)).filter(Boolean)];
    // per raw edge the cleaned edge it lands on (mapObservedEdges with that edge as the only observed wall: the atlas strip's quad)
    const edges = {};
    const pieces = {}; // raw edge -> [highest roofer wall piece above its eave, number of pieces] (gables, steps)
    [b.ring, ...(b.holes || [])].forEach((ring, ri) => {
      const key = ri === 0 ? 0 : `hole_${ri - 1}`;
      for (let i = 0; i < ring.length / 2; i++) {
        const m = mapObservedEdges({ ...b, observed: { walls: [{ ring: key, edge: i, tone: [0.5, 0.5, 0.5], conf: 'observed' }] } }, rings);
        const ci = m.edges.findIndex((x) => x.raw);
        if (ci >= 0 && topOf.has(ci)) edges[`${key}:${i}`] = Math.round(topOf.get(ci) * 1000) / 1000;
        const ps = ci >= 0 ? quadOf.get(ci)?.pieces || [] : [];
        if (ps.length) pieces[`${key}:${i}`] = [Math.round(Math.max(...ps.flatMap((t) => t.map((p) => p[1]))) * 1000) / 1000, ps.length];
      }
    });
    out[b.id] = { tile: tid, ground: b.ground, eave: b.eave, lod2: !!rec, fix: b.footprintFix || null, edges, pieces };
  }
}
process.stdout.write(JSON.stringify(out));
