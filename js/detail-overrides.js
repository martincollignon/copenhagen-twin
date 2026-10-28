// js/detail-overrides.js
// Detail overrides (docs/detail-overrides.md, format cph-detail/1): hand-guided or semi-automatic building reconstructions that take the
// place of the generated building in the near ring. Pure (no three.js, no fetch), so it runs in node.
//
// A tile's `overrides` layer (near ring only, in the detail packs) holds per GeoDanmark id one entry:
//   mode 'replace'  a mesh (a compact GLB: quantised attributes, webp textures) replaces the generated walls, roof, photo atlas and doors of
//                   the building and of every id in `covers`; colliders and walk space follow `footprint` ('gdk': unchanged, 'override':
//                   the entry's ring)
//   mode 'details'  parametric details (openings on wall edges, cornices, dormers, chimneys) are added to the generated building
// `details` may come with a mesh too (`baked: true`: the mesh carries them); they are then drawn only when the mesh is not shown (its load
// failed, or the texture budget did not admit it), so the building never goes back to bare walls.
//
// What lives here: the layer reader, the per-scene texture budget the meshes are admitted against (nearest first), the footprint substitution
// for colliders and walk space, and the geometry of the parametric details.

export const OVERRIDE_FORMAT = 'cph-detail/1';
export const OVERRIDE_LAYER = 'overrides';

export const OVERRIDE = Object.freeze({
  // decoded texture estimate (RGBA8 + mips, js/facade-lod.js estimateTextureBytes) of every resident override mesh. An overridden building
  // gives its photo atlas up (the photo budget plans it no more), so this is not all extra: the five photo-traced Nyhavn fronts hold 3.1 MB
  // here (all 97 Roofer-fitted Nyhavn buildings would hold 17 MB) and free their share of the 48 MB photo band.
  maxTextureBytes: 32 * 1024 * 1024,
  maxMeshes: 400, // resident override meshes (draw calls: 1 to 5 each)
  // how far away a mesh may be admitted (m, footprint centre): the near ring is up to 750 m + hysteresis; beyond this the generated
  // building with its measured tones is as good on screen and costs nothing extra
  maxDistance: 900
});

/**
 * `?overrides=0` (or `off`) switches the layer off (the generated city everywhere: the "before" of a comparison), `?overrides=details`
 * draws only the parametric details (no meshes), anything else / absent: on.
 */
export function overridesMode(search = globalThis.location?.search || '') {
  let flag = null;
  try { flag = new URLSearchParams(search).get('overrides'); } catch { /* no usable query string */ }
  if (flag === '0' || flag === 'off' || flag === 'false') return 'off';
  if (flag === 'details') return 'details';
  return 'on';
}

/** Ring centre (mean of the vertices) of a flat [x, z, ...] ring. */
function centreOf(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length >> 1;
  for (let i = 0; i + 1 < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return n ? [x / n, z / n] : [0, 0];
}

/**
 * A tile's layer payload -> { entries: Map(id -> entry), covered: Map(gdk id -> override id), attribution, pack } or null (absent,
 * another format). Entries without a usable mesh or details are dropped; `covers` always includes the entry's own id.
 */
export function readOverrideLayer(payload) {
  if (!payload || payload.format !== OVERRIDE_FORMAT || !payload.buildings) return null;
  const entries = new Map();
  const covered = new Map();
  for (const [id, e] of Object.entries(payload.buildings)) {
    const mesh = e.mode === 'replace' && e.mesh?.path ? e.mesh : null;
    const details = e.details && (e.details.openings?.length || e.details.cornices?.length || e.details.dormers?.length || e.details.chimneys?.length) ? e.details : null;
    if (!mesh && !details) continue;
    const covers = [...new Set([id, ...(e.covers || [])])];
    const b = e.bounds;
    const centre = b?.length === 6 ? [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2] : e.footprint?.ring ? centreOf(e.footprint.ring) : null;
    entries.set(id, { ...e, id, mode: mesh ? 'replace' : 'details', mesh, details, covers, centre });
    if (mesh) for (const c of covers) covered.set(c, id);
  }
  return { entries, covered, attribution: payload.attribution || {}, pack: payload.pack || null, tile: payload.tile };
}

/**
 * The texture budget every resident override mesh is admitted against (one per scene, like the photo budget). Pure bookkeeping:
 * reserve(id, bytes) -> bool, release(id). `p` = OVERRIDE (maxTextureBytes, maxMeshes).
 */
export function createOverrideBudget(p = OVERRIDE) {
  const held = new Map(); // id -> bytes
  let bytes = 0;
  let peak = 0;
  const stats = { admitted: 0, refused: 0, released: 0, loads: 0, failures: 0, aborted: 0 };
  return {
    p,
    stats,
    held,
    get bytes() { return bytes; },
    get peak() { return peak; },
    has: (id) => held.has(id),
    /** Reserves `n` texture bytes for a mesh; false (and nothing reserved) when the budget or the mesh count would be exceeded. */
    reserve(id, n) {
      if (held.has(id)) return true;
      if (bytes + n > p.maxTextureBytes || held.size >= p.maxMeshes) { stats.refused++; return false; }
      held.set(id, n);
      bytes += n;
      peak = Math.max(peak, bytes);
      stats.admitted++;
      return true;
    },
    release(id) {
      const n = held.get(id);
      if (n === undefined) return;
      held.delete(id);
      bytes -= n;
      stats.released++;
    },
    memory() { return { residentBytes: bytes, peakBytes: peak, budgetBytes: p.maxTextureBytes, meshes: held.size }; }
  };
}

/** A build-local view of the shared budget: the same override id can hold separate capacity while two builds overlap. */
export function createOverrideBudgetLease(budget) {
  if (!budget) return null;
  const held = new Map(); // build-local id -> unique key in the shared budget
  return {
    p: budget.p,
    stats: budget.stats,
    has: (id) => held.has(id),
    reserve(id, n) {
      if (held.has(id)) return true;
      const key = {};
      if (!budget.reserve(key, n)) return false;
      held.set(id, key);
      return true;
    },
    release(id) {
      const key = held.get(id);
      if (key === undefined) return;
      held.delete(id);
      budget.release(key);
    },
    releaseAll() {
      for (const key of held.values()) budget.release(key);
      held.clear();
    },
    memory: () => budget.memory()
  };
}

/**
 * Which of a tile's mesh overrides to show, nearest first, from camera (x, z): those within p.maxDistance whose texture bytes the budget
 * still admits (it reserves them). Returns { show: [entry], refused: [entry] } (refused: too far or over budget; they keep the generated
 * building and draw their parametric details when they have any).
 */
export function admitOverrides(layer, cam, budget, p = budget?.p || OVERRIDE) {
  const show = [];
  const refused = [];
  if (!layer) return { show, refused };
  const meshes = [...layer.entries.values()].filter((e) => e.mesh);
  const dist = (e) => (e.centre && cam ? Math.hypot(e.centre[0] - cam.x, e.centre[1] - cam.z) : 0);
  meshes.sort((a, b) => dist(a) - dist(b) || (a.id < b.id ? -1 : 1));
  for (const e of meshes) {
    if (dist(e) > p.maxDistance || (budget && !budget.reserve(e.id, e.mesh.textureBytes || 0))) refused.push(e);
    else show.push(e);
  }
  return { show, refused };
}

/**
 * The footprints colliders and walk space use for a tile's buildings: an override whose footprint matched the generated one within tolerance
 * (`footprint.use: 'gdk'`) changes nothing; one that did not (`'override'`, with its own ring) takes the place of every building it covers.
 * `layer` = readOverrideLayer(...) or null; `shown(id)` limits it to the overrides actually drawn (default: every mesh override).
 */
export function overrideFootprints(buildings, layer, shown = null) {
  if (!layer?.entries.size) return buildings;
  const swap = new Map(); // covered id -> replacement record (or null: covered by another building's replacement)
  for (const e of layer.entries.values()) {
    if (!e.mesh || e.footprint?.use !== 'override' || !e.footprint.ring?.length || (shown && !shown(e.id))) continue;
    for (const c of e.covers) swap.set(c, null);
    swap.set(e.id, { id: e.id, ring: e.footprint.ring, holes: e.footprint.holes || [], override: true });
  }
  if (!swap.size) return buildings;
  const out = [];
  for (const b of buildings) {
    if (!swap.has(b.id)) { out.push(b); continue; }
    const r = swap.get(b.id);
    if (r) out.push({ ...b, ring: r.ring, holes: r.holes, footprintOverride: true });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- parametric details (b)

const COLOURS = Object.freeze({
  glass: [0.035, 0.045, 0.055], // linear
  frame: [0.62, 0.6, 0.55],
  door: [0.06, 0.05, 0.045],
  shop: [0.05, 0.06, 0.065],
  cornice: [0.55, 0.52, 0.47],
  dormer: [0.2, 0.21, 0.2],
  dormerFace: [0.55, 0.54, 0.5],
  chimney: [0.36, 0.17, 0.12]
});

function makeSink() {
  const position = [];
  const normal = [];
  const color = [];
  const index = [];
  const quad = (a, b, c, d, n, col) => {
    const i = position.length / 3;
    for (const p of [a, b, c, d]) { position.push(p[0], p[1], p[2]); normal.push(n[0], n[1], n[2]); color.push(col[0], col[1], col[2]); }
    index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  /** Axis-free box from a base point, three edge vectors (ex: width, ey: height, ez: depth), all faces outward. */
  const box = (o, ex, ey, ez, col) => {
    const add = (p, v) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    const neg = (v) => [-v[0], -v[1], -v[2]];
    const unit = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const o1 = add(o, ex); const o2 = add(o1, ez); const o3 = add(o, ez);
    const t = (p) => add(p, ey);
    quad(o3, o2, t(o2), t(o3), unit(ez), col); // back (+ez)
    quad(o1, o, t(o), t(o1), unit(neg(ez)), col); // front (-ez)
    quad(o, o3, t(o3), t(o), unit(neg(ex)), col);
    quad(o2, o1, t(o1), t(o2), unit(ex), col);
    quad(t(o), t(o3), t(o2), t(o1), unit(ey), col); // top
  };
  return { position, normal, color, index, quad, box };
}

/** Edge i of a flat ring: start point, unit direction (x, z), length and the outward normal (the ring's winding decides which side). */
export function ringEdge(ring, i) {
  const n = ring.length >> 1;
  const a = [ring[2 * (i % n)], ring[2 * (i % n) + 1]];
  const b = [ring[2 * ((i + 1) % n)], ring[2 * ((i + 1) % n) + 1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d = L > 0 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
  // signed area (x, z): > 0 counter-clockwise seen with +z down the screen; the outward normal is to the right of the edge then
  let area = 0;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    area += ring[2 * k] * ring[2 * k1 + 1] - ring[2 * k1] * ring[2 * k + 1];
  }
  const out = area > 0 ? [d[1], -d[0]] : [-d[1], d[0]];
  return { a, d, L, out };
}

/**
 * Geometry (flat arrays: position, normal, color (linear RGB), index) of a building's parametric details on its generated walls and roof.
 * `b` is the building record (ring, ground); every v is metres above b.ground. Openings sit `proud` m in front of the wall (the generated
 * wall has no holes): a dark pane with a light frame; cornices a box along the edge; dormers a box with its face on the eave line, rising
 * from base[0] (front) to `top`; chimneys a box from base to top.
 */
export function detailGeometry(b, details, { proud = 0.03, frame = 0.08 } = {}) {
  const s = makeSink();
  if (!b?.ring || !details) return s;
  const g = b.ground ?? 0;
  const at = (e, u, v, off) => [e.a[0] + e.d[0] * u + e.out[0] * off, g + v, e.a[1] + e.d[1] * u + e.out[1] * off];
  const n3 = (e) => [e.out[0], 0, e.out[1]];
  for (const o of details.openings || []) {
    const e = ringEdge(b.ring, o.edge);
    const [u0, u1] = o.u;
    const [v0, v1] = o.v;
    if (!(u1 > u0 && v1 > v0)) continue;
    const pane = o.kind === 'door' ? COLOURS.door : o.kind === 'shopfront' ? COLOURS.shop : COLOURS.glass;
    // frame plate (slightly larger), the pane in front of it
    s.quad(at(e, u0 - frame, v0 - frame, proud), at(e, u1 + frame, v0 - frame, proud), at(e, u1 + frame, v1 + frame, proud), at(e, u0 - frame, v1 + frame, proud), n3(e), COLOURS.frame);
    s.quad(at(e, u0, v0, proud + 0.01), at(e, u1, v0, proud + 0.01), at(e, u1, v1, proud + 0.01), at(e, u0, v1, proud + 0.01), n3(e), pane);
  }
  for (const c of details.cornices || []) {
    const e = ringEdge(b.ring, c.edge);
    const [u0, u1] = c.u;
    const depth = c.depth ?? 0.15;
    const h = Math.max(0.05, c.height ?? 0.25);
    if (!(u1 > u0)) continue;
    const o = at(e, u0, c.v, 0);
    s.box(o, [e.d[0] * (u1 - u0), 0, e.d[1] * (u1 - u0)], [0, h, 0], [e.out[0] * depth, 0, e.out[1] * depth], COLOURS.cornice);
  }
  for (const d of details.dormers || []) {
    const e = ringEdge(b.ring, d.edge);
    const [u0, u1] = d.u;
    const depth = d.depth ?? 1.5;
    if (!(u1 > u0)) continue;
    const base = Math.min(...(Array.isArray(d.base) ? d.base : [d.base]));
    const h = Math.max(0.2, d.top - base);
    const inward = [-e.out[0] * depth, 0, -e.out[1] * depth];
    const o = at(e, u0, base, -0.05);
    s.box(o, [e.d[0] * (u1 - u0), 0, e.d[1] * (u1 - u0)], [0, h, 0], inward, COLOURS.dormer);
    // the window on its face
    const f = Math.min(0.15, (u1 - u0) * 0.15);
    s.quad(at(e, u0 + f, base + 0.2 * h, -0.04), at(e, u1 - f, base + 0.2 * h, -0.04), at(e, u1 - f, base + 0.85 * h, -0.04), at(e, u0 + f, base + 0.85 * h, -0.04), n3(e), COLOURS.glass);
  }
  for (const c of details.chimneys || []) {
    const [w, dd] = c.size || [0.6, 0.6];
    const h = Math.max(0.2, c.top - c.base);
    const o = [c.at[0] - w / 2, g + c.base, c.at[1] - dd / 2];
    s.box(o, [w, 0, 0], [0, h, 0], [0, 0, dd], COLOURS.chimney);
  }
  return s;
}

/** Attribution keys -> lines for the credits (the union over the given layers' attribution maps). */
export function attributionLines(layers) {
  const seen = new Map();
  for (const l of layers) for (const [k, v] of Object.entries(l?.attribution || {})) if (!seen.has(k)) seen.set(k, v);
  return [...seen.entries()].map(([key, v]) => ({ key, text: v.text || String(v), licence: v.licence || null, url: v.url || null }));
}
