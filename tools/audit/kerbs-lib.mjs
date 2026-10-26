// Kerbs inside carriageways: samples every kerb line the engine builds (road-surfaces-cph.js, kerb layer `runs`) and flags
// the samples that lie deeper than `depth` m inside a vehicular carriageway, measured against the asphalt quads the engine
// draws (createCarriagewayIndex: inside a quad and farther than `depth` from both of its kerb-side edges). Pure; used by
// tools/audit/kerbs.mjs and tests/kerbs-cph.test.mjs.
import { rightNormals } from '../../js/road-width-cph.js';
import { createCarriagewayIndex } from '../../js/road-surfaces-cph.js';

/** Points along the kerb's centre line every `step` m: [{x, z, tx, tz}] (tx, tz = unit tangent). */
export function kerbSamples(run, step = 1) {
  const { pts } = run;
  const o = (run.o0 + run.o1) / 2;
  const nr = rightNormals(pts);
  const out = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const k = i / 2;
    const ax = pts[i] + nr[k][0] * o;
    const az = pts[i + 1] + nr[k][1] * o;
    const bx = pts[i + 2] + nr[k + 1][0] * o;
    const bz = pts[i + 3] + nr[k + 1][1] * o;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / step));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / L, tz: (bz - az) / L });
    }
  }
  return out;
}

/** The unit direction of `road` nearest to (x, z). */
function roadDir(road, x, z) {
  const p = road.pts;
  let best = null;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i];
    const dz = p[i + 3] - p[i + 1];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
    const d = Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z);
    if (!best || d < best.d) best = { d, ux: dx / Math.sqrt(l2), uz: dz / Math.sqrt(l2) };
  }
  return best;
}

/**
 * @param geo cph-geodata after applyStreets
 * @param runs kerb layer runs of buildRoadSurfaceArrays
 * @returns {Array<{x, z, owner, kind, side, into, cos, depth}>} kerb samples deeper than `depth` inside a carriageway
 */
export function kerbIntrusions(geo, runs, { depth = 1.0, step = 1 } = {}) {
  const cw = createCarriagewayIndex(geo.roads);
  const out = [];
  for (const run of runs) {
    for (const s of kerbSamples(run, step)) {
      const hit = cw.at(s.x, s.z);
      if (hit.depth < depth) continue;
      const d = roadDir(hit.road, s.x, s.z);
      out.push({ x: s.x, z: s.z, owner: run.road, kind: run.kind, side: run.side, into: hit.road, cos: Math.abs(s.tx * d.ux + s.tz * d.uz), depth: hit.depth });
    }
  }
  return out;
}

/** Category of an intrusion: what the kerb is doing inside which carriageway. */
export function classify(f) {
  if (f.kind === 'arc') return 'mouth-arc';
  if (f.into === f.owner) return 'own-bend';
  const parallel = f.cos > 0.9;
  const same = (f.owner.name || '') === (f.into.name || '') && f.owner.name;
  if (parallel) return same ? 'parallel-same-name' : 'parallel-other-road';
  return 'crossing-road';
}
