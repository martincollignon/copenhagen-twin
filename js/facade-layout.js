// js/facade-layout.js
// Measured window layouts (tools/cph-geodata/facade_layout.py, the tile layer `windows`, format cph-facade-layout/1, docs/facade-layout.md):
// a regular window grid per photographed wall strip, fitted to the Skraafoto look atlas, that the procedural facade shader draws instead
// of the grid it guesses from the storey count. Pure (no three.js): runs in the build workers and in node tests.
//
// A layout is keyed like the atlas strips ("<ring>:<edge>" of the geodata record, u in metres from the raw edge's start, v in metres
// above the building's ground, the frame js/appearance.js texturedWalls maps the photo into), so the windows sit where the photo's are:
//   u0 p n w     grid start, column pitch, columns, window width (frame included); column c is centred at u0 + (c + 0.5) p
//   cm           column mask (bit c: column c has windows on the upper storeys)
//   g f rows     ground-floor height, storey pitch, upper storeys with windows
//   sill head    window sill / head above each storey's floor
//   gm           ground-floor bay mask (bit c: an opening below column c; absent = unknown, every bay open)
//   conf         0..1 (the file only carries walls the extractor keeps)

export const LAYOUT_FORMAT = 'cph-facade-layout/1';
export const LAYOUT_MAX_COLS = 32; // columns the shader masks one by one (two 16-bit words); further columns count as windowed
export const LAYOUT_MAX_GROUND = 16; // ground-floor bays the shader masks; further bays count as open
export const LAYOUT_MAX_ROWS = 63;
const MIN_COVER = 0.6; // the raw edge's share of the strip that must land on the cleaned edge

/** `?windows=0` (or `off`) leaves the measured layouts out: every wall keeps the guessed grid (the "before" of a comparison). */
export function windowsRequested(search = typeof location === 'undefined' ? '' : location.search) {
  let flag = null;
  try { flag = new URLSearchParams(search).get('windows'); } catch { /* no usable query string */ }
  return !(flag === '0' || flag === 'off');
}
const ENABLED = windowsRequested();

/** Puts a tile's `windows` layer on its building records as `observed.layout` (only on buildings with an observed block). Mutates. */
export function applyWindows(buildings, payload, enabled = ENABLED) {
  if (!enabled || !buildings || payload?.format !== LAYOUT_FORMAT || !payload.buildings) return buildings;
  for (const b of buildings) {
    const l = payload.buildings[b.id];
    if (l && b.observed && !b.observed.layout) b.observed.layout = l;
  }
  return buildings;
}

const bit = (mask, i) => Math.floor(mask / 2 ** i) % 2;

function reverseMask(mask, n) {
  let out = 0;
  for (let i = 0; i < n; i++) if (bit(mask, i)) out += 2 ** (n - 1 - i);
  return out;
}

/**
 * The measured grid of every cleaned edge (flat over `cleanedRings`, build order), in that edge's frame (u from its start), or null.
 * `mapping` is js/appearance.js mapObservedEdges(b, cleanedRings). A strip whose raw edge runs against the cleaned edge is mirrored.
 */
export function measuredEdges(b, cleanedRings, mapping) {
  const layouts = b.observed?.layout;
  const edges = [];
  for (const ring of cleanedRings) for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  const out = edges.map(() => null);
  if (!layouts || !mapping?.edges) return out;
  const stripLen = new Map((b.observed.atlas?.walls || []).map((w) => [`${w.ring}:${w.edge}`, w.len_m]));
  edges.forEach(([p0, p1], k) => {
    const raw = mapping.edges[k]?.raw;
    if (!raw) return;
    const key = `${raw.ringKey}:${raw.edge}`;
    const lay = layouts[key];
    if (!lay || !(lay.p > 0) || !(lay.n > 0) || !(lay.f > 0)) return;
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const l2 = len * len;
    const tOf = (x, z) => Math.max(0, Math.min(1, ((x - p0[0]) * dx + (z - p0[1]) * dz) / l2));
    const ta = tOf(raw.x0, raw.z0), tb = tOf(raw.x1, raw.z1);
    const L = stripLen.get(key) || Math.hypot(raw.x1 - raw.x0, raw.z1 - raw.z0);
    if (!(L > 0) || Math.abs(tb - ta) * len < MIN_COVER * L) return;
    const scale = ((tb - ta) * len) / L; // cleaned metres per strip metre (signed)
    const n = Math.min(lay.n, LAYOUT_MAX_COLS * 2);
    const at = (u) => ta * len + scale * u;
    const flip = scale < 0;
    const u0 = flip ? at(lay.u0 + n * lay.p) : at(lay.u0);
    const nGround = Math.min(n, LAYOUT_MAX_GROUND);
    out[k] = {
      key, u0, p: Math.abs(scale) * lay.p, n, w: Math.abs(scale) * lay.w,
      cm: flip ? reverseMask(lay.cm ?? 2 ** n - 1, n) : (lay.cm ?? 2 ** n - 1),
      gm: lay.gm === undefined || lay.gm === null ? null : flip ? reverseMask(lay.gm % 2 ** n, n) : lay.gm,
      nGround,
      g: lay.g, f: lay.f, rows: Math.min(lay.rows, LAYOUT_MAX_ROWS), sill: lay.sill, head: lay.head, conf: lay.conf
    };
  });
  return out;
}

/**
 * Vertex words for one wall (js/building-geometry.js, read by js/tsl-materials.js facadeCell), each an integer <= 65535 so it survives
 * varying interpolation (the shader rounds it):
 *   top   [u0, sillQ + 256 headQ, rows + 64 cols]   (0 in the second word: not measured)
 *   uv    [column mask bits 0-15, bits 16-31]
 *   ground the ground-floor bay mask (16 bits; 65535 = every bay open)
 * `m` is a measuredEdges entry or null.
 */
export function layoutWords(m) {
  if (!m) return { top: [0, 0, 0], uv: [0, 0], ground: 65535 };
  const q = (x) => Math.max(1, Math.min(254, Math.round(x * 255)));
  const sillQ = q(m.sill / m.f);
  const headQ = Math.max(sillQ + 1, q(Math.min(m.head / m.f, 0.97)));
  const cols = Math.min(m.n, 63);
  let lo = 0, hi = 0;
  for (let i = 0; i < Math.min(cols, LAYOUT_MAX_COLS); i++) {
    if (!bit(m.cm, i)) continue;
    if (i < 16) lo += 2 ** i; else hi += 2 ** (i - 16);
  }
  let ground = 65535;
  if (m.gm !== null && m.gm !== undefined) {
    ground = 0;
    for (let i = 0; i < 16; i++) if (i >= m.nGround || bit(m.gm, i)) ground += 2 ** i;
  }
  return { top: [m.u0, sillQ + 256 * headQ, Math.max(1, m.rows) + 64 * cols], uv: [lo, hi], ground };
}

/** Bay centre (u, cleaned-edge frame) nearest `along` on a measured edge, when within `maxShift` metres; else null. */
export function snapToBay(m, along, maxShift = 0.9) {
  if (!m) return null;
  const c = Math.round((along - m.u0) / m.p - 0.5);
  if (c < 0 || c >= m.n) return null;
  const u = m.u0 + (c + 0.5) * m.p;
  return Math.abs(u - along) <= maxShift ? { u, bay: c } : null;
}

/** Openings a measured edge draws (u in its frame, v above the ground): what tests and audits compare against the photo. */
export function layoutOpenings(m) {
  const out = [];
  if (!m) return out;
  for (let r = 0; r < m.rows; r++) {
    const v0 = m.g + r * m.f + m.sill;
    for (let c = 0; c < m.n; c++) {
      if (c < LAYOUT_MAX_COLS && !bit(m.cm, c)) continue;
      const u = m.u0 + (c + 0.5) * m.p;
      out.push({ u: [u - m.w / 2, u + m.w / 2], v: [v0, m.g + r * m.f + Math.min(m.head, 0.97 * m.f)], kind: 'window', row: r + 1, col: c });
    }
  }
  return out;
}
