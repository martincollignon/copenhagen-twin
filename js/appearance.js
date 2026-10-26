// js/appearance.js
// Pure (no three.js) glue between the photogrammetric appearance pass (`buildings[].observed`, docs/cph-geodata-schema.md
// "Appearance") and the building meshes:
//   - mapObservedEdges: observed wall entries are keyed by the RAW ring edge (ring 0 or "hole_<k>", edge index). The mesh
//     is built on cleaned rings (cleanRing merges collinear/duplicate vertices, may reverse a ring and drops degenerate
//     holes), so each cleaned edge is matched to the raw edge(s) it covers by geometry; the longest raw edge wins.
//   - roofAppearance: linear colour plus roughness/metalness by the roof type hint.
//   - texturedWalls: wall strips of the per-building atlas mapped onto the cleaned edges (`?tex=1`).
//   - describeAppearance: the colour source of the wall/roof under the cursor, for the info panel.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toLinear = (rgb) => rgb.map(srgbToLinear);
const isRgb = (t) => Array.isArray(t) && t.length === 3 && t.every(Number.isFinite);

// Calibrated wall tones (tools/cph-geodata/appearance_calibrate.py adds `tone_cal`): used when present. `?debug=nocal`
// (setCalibration(false)) shows the raw photogrammetric tones for before/after comparisons.
let useCalibrated = true;
const setCalibration = (on) => { useCalibrated = !!on; };
const calibrationOn = () => useCalibrated;
const wallRgb = (w) => (useCalibrated && isRgb(w.tone_cal) ? w.tone_cal : w.tone);

// The observed tone is what a camera recorded under sun and sky, not a reflectance: lit by the engine's sun it would be
// lit twice. Photo exposure puts white plaster at ~0.9 sRGB (0.79 linear); real plaster reflects ~0.65, brick 0.2-0.35.
// So the albedo is the linear tone scaled by ALBEDO_GAIN with a soft shoulder above ALBEDO_KNEE (no pure white walls).
const ALBEDO_GAIN = 0.72;
const ALBEDO_KNEE = 0.4;
const ALBEDO_MAX = 0.58;
function albedoFromLinear(v) {
  const x = v * ALBEDO_GAIN;
  return x <= ALBEDO_KNEE ? x : ALBEDO_KNEE + (ALBEDO_MAX - ALBEDO_KNEE) * (1 - Math.exp(-(x - ALBEDO_KNEE) / (ALBEDO_MAX - ALBEDO_KNEE)));
}
const observedAlbedo = (rgb) => toLinear(rgb).map(albedoFromLinear);

const MATCH_DIST = 0.12; // metres between a raw edge midpoint and the cleaned edge that covers it
const MIN_PARALLEL = 0.5; // |cos| between raw and cleaned edge directions

/** Raw edges of the geodata building in record order: [{ ringKey, edge, x0, z0, x1, z1 }]. Ring key 0 or "hole_<k>". */
function rawRingEdges(b) {
  const out = [];
  [b.ring, ...(b.holes || [])].forEach((ring, ri) => {
    const ringKey = ri === 0 ? 0 : `hole_${ri - 1}`;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push({ ringKey, edge: i, x0: ring[2 * i], z0: ring[2 * i + 1], x1: ring[2 * j], z1: ring[2 * j + 1] });
    }
  });
  return out;
}

const wallKey = (ring, edge) => `${ring}:${edge}`;

function distToSegment(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** Building-level linear wall tone: median of the observed walls, else the preset `facade.tone`, else a neutral plaster. */
function buildingTone(b) {
  const seen = (b.observed?.walls || []).filter((w) => isRgb(w.tone) && w.conf !== 'inferred');
  if (seen.length) return [0, 1, 2].map((k) => albedoFromLinear(srgbToLinear(median(seen.map((w) => wallRgb(w)[k])))));
  return toLinear(isRgb(b.facade?.tone) ? b.facade.tone : [0.7, 0.65, 0.58]);
}

/** Building-level observed wall tone in sRGB (median of the observed walls, calibrated when available), or null. */
function observedToneSrgb(b) {
  const seen = (b.observed?.walls || []).filter((w) => isRgb(w.tone) && w.conf !== 'inferred');
  return seen.length ? [0, 1, 2].map((k) => median(seen.map((w) => wallRgb(w)[k]))) : null;
}

/**
 * Per cleaned edge (flat over `cleanedRings`, in build order, [[x, z], ...] each): the linear wall tone and where it came
 * from. Edges no observed wall maps onto keep the building tone (`wall: null`).
 * Returns { edges: [{ tone, wall, raw, flip }], buildingTone, hasObserved }.
 */
function mapObservedEdges(b, cleanedRings) {
  const base = buildingTone(b);
  const cleaned = [];
  for (const ring of cleanedRings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      cleaned.push({ x0: p[0], z0: p[1], x1: q[0], z1: q[1], len: Math.hypot(q[0] - p[0], q[1] - p[1]) });
    }
  }
  const edges = cleaned.map(() => ({ tone: base, wall: null, raw: null, flip: false, rawLen: 0 }));
  const walls = b.observed?.walls;
  if (!walls?.length) return { edges, buildingTone: base, hasObserved: false };
  const byKey = new Map(walls.map((w) => [wallKey(w.ring, w.edge), w]));
  for (const raw of rawRingEdges(b)) {
    const wall = byKey.get(wallKey(raw.ringKey, raw.edge));
    if (!wall || !isRgb(wall.tone)) continue;
    const rl = Math.hypot(raw.x1 - raw.x0, raw.z1 - raw.z0);
    if (rl < 0.05) continue;
    const mx = (raw.x0 + raw.x1) / 2;
    const mz = (raw.z0 + raw.z1) / 2;
    let best = -1;
    let bd = MATCH_DIST;
    cleaned.forEach((c, ci) => {
      if (c.len < 0.05) return;
      const cos = ((raw.x1 - raw.x0) * (c.x1 - c.x0) + (raw.z1 - raw.z0) * (c.z1 - c.z0)) / (rl * c.len);
      if (Math.abs(cos) < MIN_PARALLEL) return;
      const d = distToSegment(mx, mz, c.x0, c.z0, c.x1, c.z1);
      if (d < bd) { bd = d; best = ci; }
    });
    if (best < 0 || rl <= edges[best].rawLen) continue;
    const c = cleaned[best];
    const cos = ((raw.x1 - raw.x0) * (c.x1 - c.x0) + (raw.z1 - raw.z0) * (c.z1 - c.z0)) / (rl * c.len);
    edges[best] = { tone: observedAlbedo(wallRgb(wall)), wall, raw, flip: cos < 0, rawLen: rl };
  }
  return { edges, buildingTone: base, hasObserved: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------------------------------------------
// [roughness, metalness] by the observed type hint (nadir colour heuristics) - the tone itself carries the colour.
const ROOF_SURFACE = {
  'tagpap': [0.96, 0.0], // bitumen felt: dark, matte
  'tile': [0.82, 0.0],
  'slate': [0.58, 0.0],
  'metal': [0.42, 0.45],
  'fibre-cement': [0.92, 0.0],
  'copper': [0.4, 0.5],
  'green': [1.0, 0.0],
  'solar': [0.3, 0.1],
  'other': [0.85, 0.0]
};
const BBR_ROOF_HINT = {
  'tagpap': 'tagpap', 'tagpap med lille hældning': 'tagpap', 'tagpap med stor hældning': 'tagpap',
  'tegl': 'tile', 'betontagsten': 'tile', 'fibercement herunder asbest': 'fibre-cement', 'fibercement uden asbest': 'fibre-cement',
  'metal': 'metal', 'levende tage': 'green', 'glas': 'solar'
};
const ROOF_FALLBACK_SURFACE = [0.88, 0.02];

/** { hint, rough, metal, observed } for the roof material of `b`; the hint is the observed one, else derived from BBR. */
function roofSurface(b) {
  const seen = b.observed?.roof;
  const observed = seen?.conf === 'observed' && isRgb(seen.tone);
  const hint = (observed && seen.type_hint) || BBR_ROOF_HINT[b.roof_material] || null;
  const [rough, metal] = ROOF_SURFACE[hint] || ROOF_FALLBACK_SURFACE;
  return { hint, rough, metal, observed };
}

// ---------------------------------------------------------------------------------------------------------------
// Textured walls (?tex=1)
// ---------------------------------------------------------------------------------------------------------------
const TEX_MAX_FILLED = 0.5; // beyond this the strip is mostly fill (nearest-texel smear / flat median): tone + procedural windows look better. The look atlas drops filled texels via alpha and whole strips above this.
const TEX_LIFT = 0.01; // metres the photo quad sits in front of the extruded wall (the material adds a depth bias, so this is only a safety margin)

/** Map `${ring}:${edge}` -> atlas wall entry of a building (empty without an atlas). */
function atlasWalls(b) {
  const out = new Map();
  for (const w of b.observed?.atlas?.walls || []) out.set(wallKey(w.ring, w.edge), w);
  return out;
}

/** True when the atlas strip of `entry` is trustworthy enough to show instead of the tone + procedural facade. */
function usableStrip(entry, wall) {
  return !!entry && Array.isArray(entry.uv) && entry.uv.length === 4 && (entry.filled_frac ?? 1) <= TEX_MAX_FILLED
    && (!wall || wall.conf !== 'inferred') && entry.h_m > 0.5;
}

/**
 * Photo quads for one building. `quads` come from addBuilding (`opts.quads`): { edgeNo, p0, p1, bottom, top, ground }
 * with the cleaned edge's endpoints; `mapping` is mapObservedEdges' result. Each quad spans the part of the cleaned edge
 * covered by the raw edge whose strip is used. Returns flat arrays { position, normal, uv, index } (uv in texture
 * space, v down as in the JPEG) and the number of quads, or null when no strip is usable.
 */
function texturedWalls(b, quads, mapping) {
  const strips = atlasWalls(b);
  if (!strips.size) return null;
  const position = [];
  const normal = [];
  const uv = [];
  const wallUV = [];
  const index = [];
  let count = 0;
  for (const q of quads) {
    const m = mapping.edges[q.edgeNo];
    if (!m?.raw) continue;
    const strip = strips.get(wallKey(m.raw.ringKey, m.raw.edge));
    if (!usableStrip(strip, m.wall)) continue;
    const dx = q.p1[0] - q.p0[0];
    const dz = q.p1[1] - q.p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const l2 = len * len;
    // Raw edge endpoints projected on the cleaned edge, in raw order (u0 at raw start, u1 at raw end)
    const tOf = (x, z) => Math.max(0, Math.min(1, ((x - q.p0[0]) * dx + (z - q.p0[1]) * dz) / l2));
    const ta = tOf(m.raw.x0, m.raw.z0);
    const tb = tOf(m.raw.x1, m.raw.z1);
    if (Math.abs(tb - ta) < 1e-3) continue;
    const [u0, v0, u1, v1] = strip.uv;
    const nx = -dz / len;
    const nz = dx / len;
    const top = Math.min(q.top, q.ground + strip.h_m);
    const hTop = top - q.ground;
    const vAt = (h) => v1 + (v0 - v1) * Math.min(h / strip.h_m, 1);
    const base = position.length / 3;
    for (const [t, u, y, h] of [[ta, u0, q.ground, 0], [tb, u1, q.ground, 0], [tb, u1, top, hTop], [ta, u0, top, hTop]]) {
      position.push(q.p0[0] + dx * t + nx * TEX_LIFT, y, q.p0[1] + dz * t + nz * TEX_LIFT);
      normal.push(nx, 0, nz);
      uv.push(u, vAt(h));
      wallUV.push(t * len, y - q.ground);
    }
    // quad corners run raw-start -> raw-end; the outward normal needs the CCW order seen from outside
    if (tb > ta) index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else index.push(base, base + 2, base + 1, base, base + 3, base + 2);
    count++;
  }
  return count ? { position, normal, uv, wallUV, index, count, file: b.observed.atlas.file, size: b.observed.atlas.size } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------------------------------------------
const FALLBACK_TEXT = { building: 'same building', neighbours: 'neighbouring buildings', preset: 'period preset' };

/** Human-readable colour source of one observed wall entry: { text, kind: 'observed' | 'prior' | 'inferred', flags }. */
function wallSource(wall) {
  if (!wall) return { text: 'not mapped (building tone)', kind: 'inferred', flags: [] };
  const flags = [];
  if (wall.flags?.includes('year_disagree')) flags.push('colour differs between 2023 and 2025: probably repainted');
  if (wall.conf === 'inferred') return { text: `inferred from ${FALLBACK_TEXT[wall.fallback] || wall.fallback || 'the building'}`, kind: 'inferred', flags };
  const year = wall.year ?? (String(wall.views?.[0] || '').match(/_(20\d\d)_/)?.[1]) ?? '';
  const lit = wall.sunlit ?? !wall.shadow_corrected;
  if (wall.conf === 'observed+prior') return { text: `observed ${year}, shadow, brick hue prior`, kind: 'prior', flags };
  return { text: lit ? `observed ${year}, sunlit` : `observed ${year}, shadow, white-balanced`, kind: 'observed', flags };
}

function roofSource(b) {
  const r = b.observed?.roof;
  if (r?.conf === 'observed' && isRgb(r.tone)) {
    const year = r.year ?? '';
    const lit = r.sunlit === false ? 'shadow' : 'sunlit';
    return { text: `observed ${year} ${lit}${r.type_hint ? `, ${r.type_hint}` : ''}${r.pitched ? ', pitched' : ''}`, kind: 'observed', tone: r.tone, flags: r.flags?.includes('year_disagree') ? ['colour differs between 2023 and 2025'] : [] };
  }
  return { text: `BBR roof material${b.roof_material ? ` (${b.roof_material})` : ''}`, kind: 'inferred', tone: null, flags: [] };
}

/** Nearest raw ring edge of `b` to a world point (x, z): { ringKey, edge, dist }. */
function nearestRawEdge(b, x, z) {
  let best = null;
  for (const e of rawRingEdges(b)) {
    const d = distToSegment(x, z, e.x0, e.z0, e.x1, e.z1);
    if (!best || d < best.dist) best = { ringKey: e.ringKey, edge: e.edge, dist: d };
  }
  return best;
}

/**
 * Appearance rows for the info panel. `surface` is 'wall' (nearest wall edge to `point`), 'roof', or an inferred architectural 'detail'.
 */
function describeAppearance(b, surface, point, { textured = false } = {}) {
  const out = { roof: roofSource(b), wall: null };
  if (surface === 'detail') return { roof: null, wall: null, detail: { kind: 'inferred', text: 'Architectural style detail' } };
  if (surface !== 'roof' && point) {
    const near = nearestRawEdge(b, point.x, point.z);
    const wall = near && (b.observed?.walls || []).find((w) => w.ring === near.ringKey && w.edge === near.edge);
    const src = wallSource(wall || null);
    src.tone = wall ? wallRgb(wall) : null;
    src.edge = near ? `${near.ringKey === 0 ? '' : `${near.ringKey} `}edge ${near.edge}` : null;
    src.photo = textured && usableStrip(atlasWalls(b).get(wallKey(wall?.ring, wall?.edge)), wall);
    out.wall = src;
  }
  return out;
}

export {
  srgbToLinear, setCalibration, calibrationOn, wallRgb, albedoFromLinear, rawRingEdges, buildingTone, observedToneSrgb, mapObservedEdges, roofSurface, atlasWalls, usableStrip, texturedWalls,
  wallSource, roofSource, describeAppearance, nearestRawEdge, ROOF_SURFACE, TEX_MAX_FILLED
};
