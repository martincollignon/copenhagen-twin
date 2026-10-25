// js/lod2-geometry.js
// Pure (no three.js) LoD2 roof support for the Copenhagen buildings. The offline pipeline (tools/lod2/) turns DHM
// Punktsky point clouds into roofer LoD2.2 meshes and packs them per 1 km tile into data/lod2/<tile>.bin, addressed by
// data/lod2/index.json ({buildings: {id: {tile, offset, length, conf, ...}}}). Record layout: tools/lod2/convert.py.
//
// How the engine uses a record (building-geometry.js addBuilding):
//   - roof triangles replace the flat deck + parapet (or the hipped cap),
//   - the footprint-extruded facade walls stay (they carry the facade shader frame) but now end at the roofer eave of
//     each edge (`top`), so a pitched roof meets its wall instead of floating above or sinking into it,
//   - roofer outer-wall triangles are kept only above that eave (gables, dormer-height steps) and inner step walls
//     (edge -1) are kept whole; both are drawn as plain masonry.

const LOD2_NO_TOP = -32768;
const ROOF = 0;
const WALL = 1;

/** Decodes one record. Positions come back in absolute local metres (x east, y up, z south). */
function parseLod2Record(buffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset) {
  const view = new DataView(buffer, byteOffset, byteLength);
  const ox = view.getFloat32(0, true);
  const oy = view.getFloat32(4, true);
  const oz = view.getFloat32(8, true);
  const nV = view.getUint16(12, true);
  const nT = view.getUint16(14, true);
  const nE = view.getUint16(16, true);
  let o = 18;
  const i16 = (count) => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(o + 2 * i, true);
    o += 2 * count;
    return out;
  };
  const raw = i16(3 * nV);
  const pos = new Float32Array(3 * nV);
  for (let i = 0; i < nV; i++) {
    pos[3 * i] = ox + raw[3 * i] / 100;
    pos[3 * i + 1] = oy + raw[3 * i + 1] / 100;
    pos[3 * i + 2] = oz + raw[3 * i + 2] / 100;
  }
  const idx = new Uint16Array(3 * nT);
  for (let i = 0; i < 3 * nT; i++) idx[i] = view.getUint16(o + 2 * i, true);
  o += 6 * nT;
  const kind = new Uint8Array(nT);
  for (let i = 0; i < nT; i++) kind[i] = view.getUint8(o + i);
  o += nT;
  const edge = i16(nT);
  const topRaw = i16(nE);
  const top = new Float32Array(nE);
  for (let i = 0; i < nE; i++) top[i] = topRaw[i] === LOD2_NO_TOP ? NaN : topRaw[i] / 100;
  return { origin: [ox, oy, oz], nV, nT, nE, pos, idx, kind, edge, top };
}

/**
 * Loads data/lod2/index.json and lazily the tile binaries. Returns null when the index is absent or not lod2/1, so the
 * engine falls back to flat roofs. `get(id)` resolves to a parsed record for a building with `conf: "measured"`, else null.
 */
async function loadLod2(baseUrl = './data/lod2', fetchImpl = globalThis.fetch) {
  let index;
  try {
    const response = await fetchImpl(`${baseUrl}/index.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    index = await response.json();
  } catch (error) {
    console.info('[cph] no LoD2 roofs loaded:', error?.message || error);
    return null;
  }
  if (!index?.version?.startsWith('lod2/') || !index.buildings) return null;
  const tiles = new Map();
  const tile = (name) => {
    if (!tiles.has(name)) {
      const file = index.tiles?.[name]?.file || `${name}.bin`;
      tiles.set(name, fetchImpl(`${baseUrl}/${file}`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
    }
    return tiles.get(name);
  };
  const records = new Map();
  /** Fetches every tile that has a mesh, then parses the records on demand (cached). */
  async function prefetch() { await Promise.all([...new Set(Object.values(index.buildings).filter((e) => e.offset !== undefined).map((e) => e.tile))].map(tile)); }
  async function ready(id) {
    const e = index.buildings[id];
    if (!e || e.conf !== 'measured' || e.offset === undefined) return null;
    if (records.has(id)) return records.get(id);
    const buf = await tile(e.tile);
    const rec = buf && e.offset + e.length <= buf.byteLength ? parseLod2Record(buf, e.offset, e.length) : null;
    records.set(id, rec);
    return rec;
  }
  return { index, prefetch, ready, get: (id) => records.get(id) || null, entry: (id) => index.buildings[id] || null };
}

/** [{x0, z0, x1, z1}] for the geodata building's outer ring then holes: the indexing of the record's `edge` / `top`. */
function rawEdges(b) {
  const out = [];
  for (const ring of [b.ring, ...(b.holes || [])]) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push({ x0: ring[2 * i], z0: ring[2 * i + 1], x1: ring[2 * j], z1: ring[2 * j + 1] });
    }
  }
  return out;
}

function distToSegment(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

/**
 * Per cleaned-ring edge (flat index over the cleaned rings, in build order) the roofer eave `top`, and the map from the
 * record's raw edge index to that cleaned edge. cleanRing() merges collinear and duplicate vertices, so one cleaned edge
 * may cover several raw edges: its top is the lowest top among them (higher parts are filled by wall pieces above it).
 * Edges the roofer did not match keep `fallback` (the DSM eave).
 */
function lod2EdgeTops(rec, b, cleanRings, fallback, minTop) {
  const cleaned = [];
  for (const ring of cleanRings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      cleaned.push([p[0], p[1], q[0], q[1]]);
    }
  }
  const raw = rawEdges(b);
  const rawToClean = new Int32Array(raw.length).fill(-1);
  const tops = new Float32Array(cleaned.length).fill(NaN);
  raw.forEach((e, k) => {
    const mx = (e.x0 + e.x1) / 2;
    const mz = (e.z0 + e.z1) / 2;
    let best = -1;
    let bd = 0.12;
    cleaned.forEach((c, ci) => {
      const d = distToSegment(mx, mz, c[0], c[1], c[2], c[3]);
      if (d < bd) { bd = d; best = ci; }
    });
    rawToClean[k] = best;
    if (best >= 0 && k < rec.nE && Number.isFinite(rec.top[k]) && rec.top[k] >= minTop) {
      tops[best] = Number.isFinite(tops[best]) ? Math.min(tops[best], rec.top[k]) : rec.top[k];
    }
  });
  for (let i = 0; i < tops.length; i++) if (!Number.isFinite(tops[i])) tops[i] = fallback;
  return { tops, rawToClean, cleaned };
}

const FRAGMENT_MIN_AREA = 2.0; // m2 of connected roof surface below which a piece is roofer debris
const FRAGMENT_MIN_WIDTH = 0.3; // m: area / longest extent of a small piece; thinner ones are slivers
const FRAGMENT_SLIVER_MAX_AREA = 12.0; // slivers are only dropped below this area (long thin real roofs stay)

/**
 * Roof triangles worth drawing as [[x, y, z] x3] indices into `rec.idx` order: roofer meshes carry small disconnected
 * fragments and thin slivers (point-cloud noise: chimneys, antennas, cars at the edge) that show up as spikes near streets.
 * Triangles are grouped into connected pieces (vertices welded at 1 cm); a piece is dropped when its area is under
 * `minArea`, or when it is a thin sliver (area / longest extent under `minWidth`, area under `sliverMaxArea`). The largest
 * piece is always kept, so a roof never vanishes. Returns { keep: Uint8Array per triangle (1 = keep), pieces, dropped }.
 */
function roofFragmentMask(rec, { minArea = FRAGMENT_MIN_AREA, minWidth = FRAGMENT_MIN_WIDTH, sliverMaxArea = FRAGMENT_SLIVER_MAX_AREA } = {}) {
  const tris = [];
  for (let t = 0; t < rec.nT; t++) if (rec.kind[t] === ROOF) tris.push(t);
  const weld = new Map();
  const vid = (v) => {
    const key = `${Math.round(rec.pos[3 * v] * 100)},${Math.round(rec.pos[3 * v + 1] * 100)},${Math.round(rec.pos[3 * v + 2] * 100)}`;
    if (!weld.has(key)) weld.set(key, weld.size);
    return weld.get(key);
  };
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const ids = tris.map((t) => [0, 1, 2].map((k) => vid(rec.idx[3 * t + k])));
  for (let i = 0; i < weld.size; i++) parent.push(i);
  for (const [a, b, c] of ids) { parent[find(a)] = find(b); parent[find(b)] = find(c); }
  const pieces = new Map();
  tris.forEach((t, i) => {
    const root = find(ids[i][0]);
    const v = [0, 1, 2].map((k) => rec.idx[3 * t + k]);
    const P = v.map((q) => [rec.pos[3 * q], rec.pos[3 * q + 1], rec.pos[3 * q + 2]]);
    const area = triArea2(P) / 2;
    let piece = pieces.get(root);
    if (!piece) { piece = { area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tris: [] }; pieces.set(root, piece); }
    piece.area += area;
    piece.tris.push(t);
    for (const p of P) for (let k = 0; k < 3; k++) { piece.min[k] = Math.min(piece.min[k], p[k]); piece.max[k] = Math.max(piece.max[k], p[k]); }
  });
  const keep = new Uint8Array(rec.nT);
  let biggest = null;
  for (const piece of pieces.values()) if (!biggest || piece.area > biggest.area) biggest = piece;
  let dropped = 0;
  for (const piece of pieces.values()) {
    const extent = Math.max(Math.hypot(piece.max[0] - piece.min[0], piece.max[2] - piece.min[2]), 1e-6);
    const sliver = piece.area < sliverMaxArea && piece.area / extent < minWidth;
    const drop = piece !== biggest && (piece.area < minArea || sliver);
    if (drop) { dropped += piece.tris.length; continue; }
    for (const t of piece.tris) keep[t] = 1;
  }
  return { keep, pieces: pieces.size, dropped };
}

/** Roof triangles as [[x, y, z] x3] (counter-clockwise from above) from the record, fragments filtered (`filter: false` keeps all). */
function lod2RoofTriangles(rec, { filter = true } = {}) {
  const mask = filter ? roofFragmentMask(rec).keep : null;
  const out = [];
  for (let t = 0; t < rec.nT; t++) {
    if (rec.kind[t] !== ROOF || (mask && !mask[t])) continue;
    out.push([0, 1, 2].map((k) => { const v = rec.idx[3 * t + k]; return [rec.pos[3 * v], rec.pos[3 * v + 1], rec.pos[3 * v + 2]]; }));
  }
  return out;
}

/** Keeps the part of a triangle at or above y = yMin; returns 0 to 2 triangles (the clip polygon fanned). */
function clipAbove(tri, yMin) {
  const poly = [];
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const ain = a[1] >= yMin;
    const bin = b[1] >= yMin;
    if (ain) poly.push(a);
    if (ain !== bin) {
      const t = (yMin - a[1]) / (b[1] - a[1]);
      poly.push([a[0] + (b[0] - a[0]) * t, yMin, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const out = [];
  for (let i = 1; i < poly.length - 1; i++) out.push([poly[0], poly[i], poly[i + 1]]);
  return out;
}

function triArea2(t) {
  const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
  const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Roofer wall triangles worth drawing on top of the extruded walls: outer-wall triangles clipped to above the cleaned
 * edge's top (snapped onto that edge's line), and inner step walls whole. Each is { edge, tri } with `edge` the flat
 * cleaned-edge index or -1.
 */
function lod2WallPieces(rec, lod) {
  const out = [];
  for (let t = 0; t < rec.nT; t++) {
    if (rec.kind[t] !== WALL) continue;
    const tri = [0, 1, 2].map((k) => { const v = rec.idx[3 * t + k]; return [rec.pos[3 * v], rec.pos[3 * v + 1], rec.pos[3 * v + 2]]; });
    const raw = rec.edge[t];
    if (raw < 0) {
      if (triArea2(tri) > 1e-4) out.push({ edge: -1, tri });
      continue;
    }
    const ci = lod.rawToClean[raw] ?? -1;
    if (ci < 0) continue;
    const [x0, z0, x1, z1] = lod.cleaned[ci];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz || 1;
    for (const piece of clipAbove(tri, lod.tops[ci] - 1e-4)) {
      const snapped = piece.map(([x, y, z]) => {
        const t2 = ((x - x0) * dx + (z - z0) * dz) / l2;
        return [x0 + dx * t2, y, z0 + dz * t2];
      });
      if (triArea2(snapped) > 1e-4) out.push({ edge: ci, tri: snapped });
    }
  }
  return out;
}

export { LOD2_NO_TOP, ROOF, WALL, parseLod2Record, loadLod2, rawEdges, lod2EdgeTops, lod2RoofTriangles, roofFragmentMask, lod2WallPieces, clipAbove };
