// js/data-packs.js
// The packed data layout (tools/hosting/build_packs.py): a few hundred content-hashed pack files instead of thousands of small ones, so
// static hosts with per-IP or per-bucket request limits (r2.dev, a Hugging Face dataset) can serve a visit. Pure apart from fetch
// (no three.js), so it runs in node.
//
//   <base>/manifest.json     the root (no-cache): which pack holds which file, which packs a tile has
//   <base>/c/<hash>.pack     city packs: tiles/index.json, city/post.json, city/meta.json, ... (entries named by their unpacked path)
//   <base>/t/<hash>.pack     the core layers (what a mid-ring tile needs) and `atlas.index` of a tile, or of a block of tiles
//   <base>/d/<hash>.pack     the detail layers (what only the near ring needs) of a tile or a block of tiles
//                            tile entries are named '<tile id>/<layer>' ('1443_12343/buildings', '1443_12343/lod2.bin')
//   <base>/a/<hash>.pack     a tile's facade atlases (webp), split into spatially compact chunks that are read with HTTP Range
//
// Pack container (little endian):  "CPHPACK1"  u32 header length  header JSON (UTF-8)  payloads
//   header = { format: 'cph-pack/1', entries: [{ name, type: 'json'|'bin'|'webp', enc: 'gzip'|'identity', offset, length, size }],
//              chunks?: [[offset, length], ...] }    offsets are absolute in the file; `size` is the decoded length
// JSON and binary entries are gzip-compressed inside the pack (the host need not set Content-Encoding); they are inflated with
// DecompressionStream (every WebGPU-capable browser has it: Chrome 80, Safari 16.4, Firefox 113). Atlases are stored as they are.
// Pack names carry the hash of their bytes, so they are immutable and may be cached forever; only manifest.json is revalidated.

export const PACK_MAGIC = 'CPHPACK1';
export const PACK_FORMAT = 'cph-pack/1';
export const MANIFEST_FORMAT = 'cph-packs/1';
export const MANIFEST_NAME = 'manifest.json';

const te = new TextEncoder();
const td = new TextDecoder();
const trim = (s) => String(s).replace(/\/+$/, '');
const httpError = (status, what) => Object.assign(new Error(`HTTP ${status} ${what}`), { status });
const abortError = () => (typeof DOMException === 'function' ? new DOMException('aborted', 'AbortError') : Object.assign(new Error('aborted'), { name: 'AbortError' }));
export const corruptError = (what) => Object.assign(new Error(`corrupt pack ${what}`), { corrupt: true });

// ------------------------------------------------------------------------------------------------------------- container

/** Header of a pack (Uint8Array of at least its first bytes). Throws a `corrupt` error when it is not a pack. */
export function parsePackHeader(u8, what = 'pack') {
  if (!(u8 instanceof Uint8Array) || u8.byteLength < 12) throw corruptError(what);
  for (let i = 0; i < 8; i++) if (u8[i] !== PACK_MAGIC.charCodeAt(i)) throw corruptError(what);
  const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
  if (12 + len > u8.byteLength) throw corruptError(what);
  let header;
  try { header = JSON.parse(td.decode(u8.subarray(12, 12 + len))); } catch { throw corruptError(what); }
  if (header?.format !== PACK_FORMAT || !Array.isArray(header.entries)) throw corruptError(what);
  const entries = new Map();
  for (const e of header.entries) entries.set(e.name, e);
  return { header, entries, dataStart: 12 + len };
}

/** A pack from its whole bytes: { entries: Map, chunks, bytes }; every entry must lie inside the file. */
export function readPack(buf, what = 'pack') {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { header, entries, dataStart } = parsePackHeader(u8, what);
  for (const e of entries.values()) if (!(e.offset >= dataStart && e.offset + e.length <= u8.byteLength)) throw corruptError(what);
  return { entries, chunks: header.chunks || null, bytes: u8, header };
}

/** gzip -> bytes with the platform's DecompressionStream. */
export async function gunzip(u8) {
  if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream is not available');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The decoded bytes of one entry of a read pack. */
export async function entryBytes(pack, name) {
  const e = pack.entries.get(name);
  if (!e) return null;
  const raw = pack.bytes.subarray(e.offset, e.offset + e.length);
  if (e.enc !== 'gzip') return raw;
  let out;
  try { out = await gunzip(raw); } catch { throw corruptError(name); }
  if (e.size !== undefined && out.byteLength !== e.size) throw corruptError(name);
  return out;
}

export async function entryJson(pack, name) {
  const b = await entryBytes(pack, name);
  return b ? JSON.parse(td.decode(b)) : null;
}

/** An ArrayBuffer of its own (what fetch().arrayBuffer() would have handed out). */
export const ownBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);

/**
 * Writes a pack (the JS twin of tools/hosting/build_packs.py, for the tests): files = [{ name, type, data: Uint8Array, gzip? }].
 * `chunks` = [[first entry index, entry count], ...] become absolute byte ranges in the header.
 */
export async function encodePack(files, { chunks = null } = {}) {
  const payloads = [];
  const entries = [];
  for (const f of files) {
    const z = f.gzip ? await gzip(f.data) : null;
    payloads.push(z || f.data);
    entries.push({ name: f.name, type: f.type || 'bin', enc: z ? 'gzip' : 'identity', offset: 0, length: (z || f.data).byteLength, size: f.data.byteLength });
  }
  // header length depends on the offsets: iterate until it is stable
  let headerBytes = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    let o = 12 + headerBytes.byteLength;
    for (const e of entries) { e.offset = o; o += e.length; }
    const header = { format: PACK_FORMAT, entries };
    if (chunks) header.chunks = chunks.map(([a, n]) => [entries[a].offset, entries[a + n - 1].offset + entries[a + n - 1].length - entries[a].offset]);
    const next = te.encode(JSON.stringify(header));
    if (next.byteLength === headerBytes.byteLength) { headerBytes = next; break; }
    headerBytes = next;
  }
  const total = 12 + headerBytes.byteLength + payloads.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(te.encode(PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(8, headerBytes.byteLength, true);
  out.set(headerBytes, 12);
  let o = 12 + headerBytes.byteLength;
  for (const p of payloads) { out.set(p, o); o += p.byteLength; }
  return out;
}

// ------------------------------------------------------------------------------------------------------------- fetching

/** A byte-bounded LRU of settled values; pending entries are never evicted. */
function createLru(cap) {
  const map = new Map(); // key -> { value, bytes }
  let bytes = 0;
  return {
    get(key) { const e = map.get(key); if (!e) return undefined; map.delete(key); map.set(key, e); return e.value; },
    set(key, value, size) {
      const old = map.get(key);
      if (old) { bytes -= old.bytes; map.delete(key); }
      map.set(key, { value, bytes: size });
      bytes += size;
      for (const [k, e] of map) { if (bytes <= cap || map.size <= 1) break; if (k === key) continue; map.delete(k); bytes -= e.bytes; }
    },
    delete(key) { const e = map.get(key); if (e) { bytes -= e.bytes; map.delete(key); } },
    get bytes() { return bytes; },
    get size() { return map.size; }
  };
}

/**
 * One request shared by every caller that wants the same key. A caller's `signal` only detaches that caller; the request itself is aborted
 * when every caller left before it settled.
 */
function createShared() {
  const inflight = new Map(); // key -> { promise, controller, waiters }
  return {
    run(key, start, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      let f = inflight.get(key);
      if (!f) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        f = { controller, waiters: 0, promise: null };
        f.promise = Promise.resolve().then(() => start(controller?.signal)).finally(() => { if (inflight.get(key) === f) inflight.delete(key); });
        f.promise.catch(() => {});
        inflight.set(key, f);
      }
      f.waiters++;
      if (!signal) return f.promise;
      return new Promise((resolve, reject) => {
        let done = false;
        const onAbort = () => {
          if (done) return;
          done = true;
          if (--f.waiters <= 0 && inflight.get(key) === f) { inflight.delete(key); f.controller?.abort(); }
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        f.promise.then((v) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); resolve(v); } },
          (e) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); reject(e); } });
      });
    },
    has: (key) => inflight.has(key),
    get size() { return inflight.size; }
  };
}

/** Request accounting shared by the pack and atlas clients (for the headless checks: `?hooks` exposes it). */
export const packStats = { requests: 0, bytes: 0, packs: 0, ranges: 0, wholeFiles: 0, hits: 0, refetches: 0, retries: 0, errors: 0 };

/**
 * Whole-pack client: fetch a pack once, keep its (compressed) bytes in a byte-bounded LRU, hand out decoded entries.
 * A pack that does not parse is fetched once more past the HTTP cache (`cache: 'reload'`) before the error goes up.
 */
export function createPackClient({ base, fetchImpl = globalThis.fetch, cacheBytes = 96 * 1024 * 1024, stats = packStats } = {}) {
  const lru = createLru(cacheBytes);
  const shared = createShared();
  const seen = new Set();
  const url = (file) => `${trim(base)}/${file}`;
  async function download(file, signal, cache) {
    stats.requests++;
    const r = await fetchImpl(url(file), { cache, ...(signal ? { signal } : {}) });
    if (!r.ok) throw httpError(r.status, file);
    const buf = new Uint8Array(await r.arrayBuffer());
    stats.bytes += buf.byteLength;
    return buf;
  }
  return {
    base,
    lru,
    /** The read pack (cached). */
    pack(file, signal) {
      const hit = lru.get(file);
      if (hit) { stats.hits++; return Promise.resolve(hit); }
      return shared.run(file, async (sig) => {
        if (seen.has(file)) stats.refetches++;
        let pack;
        try {
          pack = readPack(await download(file, sig, 'default'), file);
        } catch (error) {
          if (!error?.corrupt) { stats.errors++; throw error; }
          stats.retries++;
          try { pack = readPack(await download(file, sig, 'reload'), file); } catch (e) { stats.errors++; throw e; }
        }
        seen.add(file);
        stats.packs++;
        lru.set(file, pack, pack.bytes.byteLength);
        return pack;
      }, signal);
    },
    async json(file, name, signal) { return entryJson(await this.pack(file, signal), name); },
    async bytes(file, name, signal) { return entryBytes(await this.pack(file, signal), name); },
    inflight: (file) => shared.has(file)
  };
}

// --------------------------------------------------------------------------------------------------------------- atlases

/**
 * Facade atlases read out of the per-tile atlas packs. `register(index)` adds a tile's `atlas.index` (from its core pack):
 *   { file: 'a/<hash>.pack', size, chunks: [[offset, length], ...], atlases: { <stem>: [chunk, offset, length] } }
 * blob('tex-look/<stem>.webp') fetches the atlas's chunk with one Range request (kept in a byte-bounded LRU, so the other atlases of the
 * chunk and later tier changes cost nothing) and slices the atlas out of it. A host that answers a Range request with the whole file
 * (200) switches the source to whole files: the file is kept and every chunk is sliced from it.
 */
export function createAtlasSource({ base, fetchImpl = globalThis.fetch, cacheBytes = 48 * 1024 * 1024, stats = packStats, range = true } = {}) {
  const atlases = new Map(); // stem -> { file, chunk, offset, length }
  const named = new Map(); // base-relative path -> { file, chunk, offset, length, enc, size } (the override meshes: js/detail-overrides.js)
  const files = new Map(); // file -> { size, chunks }
  const lru = createLru(cacheBytes);
  const shared = createShared();
  let rangeOk = range;
  const url = (file) => `${trim(base)}/${file}`;

  async function whole(file, signal) {
    const key = `${file}#`;
    const hit = lru.get(key);
    if (hit) return hit;
    return shared.run(key, async (sig) => {
      stats.requests++;
      stats.wholeFiles++;
      const r = await fetchImpl(url(file), { cache: 'default', ...(sig ? { signal: sig } : {}) });
      if (!r.ok) throw httpError(r.status, file);
      const buf = new Uint8Array(await r.arrayBuffer());
      stats.bytes += buf.byteLength;
      const f = files.get(file);
      if (f?.size && buf.byteLength !== f.size) throw corruptError(file);
      lru.set(key, buf, buf.byteLength);
      return buf;
    }, signal);
  }

  /** -> { bytes: Uint8Array, start: absolute offset of bytes[0] } covering chunk `ci` of `file`. */
  async function chunk(file, ci, signal) {
    const all = lru.get(`${file}#`);
    if (all) { stats.hits++; return { bytes: all, start: 0 }; }
    const f = files.get(file);
    const [o, n] = f.chunks[ci];
    if (!rangeOk || (o === 0 && n === f.size)) return { bytes: await whole(file, signal), start: 0 };
    const key = `${file}#${ci}`;
    const hit = lru.get(key);
    if (hit) { stats.hits++; return { bytes: hit, start: o }; }
    const got = await shared.run(key, async (sig) => {
      stats.requests++;
      stats.ranges++;
      const r = await fetchImpl(url(file), { cache: 'default', headers: { Range: `bytes=${o}-${o + n - 1}` }, ...(sig ? { signal: sig } : {}) });
      if (!r.ok) throw httpError(r.status, file);
      const buf = new Uint8Array(await r.arrayBuffer());
      stats.bytes += buf.byteLength;
      if (r.status === 206) {
        if (buf.byteLength !== n) throw corruptError(`${file} range`);
        lru.set(key, buf, buf.byteLength);
        return { bytes: buf, start: o };
      }
      // 200: the host ignored the Range header and sent the whole file. Keep it, and stop asking for ranges.
      rangeOk = false;
      if (f.size && buf.byteLength !== f.size) throw corruptError(file);
      lru.set(`${file}#`, buf, buf.byteLength);
      return { bytes: buf, start: 0 };
    }, signal);
    return got;
  }

  return {
    get rangeOk() { return rangeOk; },
    lru,
    /**
     * A chunked pack's index: { file, size, chunks, atlases?: { stem: [chunk, offset, length] }, entries?: { path: [chunk, offset, length, enc, size] } }.
     * `atlases` are facade atlases (blob() by file name), `entries` any other file by its base-relative path (bytes(); gzip'd ones inflated).
     */
    register(index) {
      if (!index?.file || !(index.atlases || index.entries)) return;
      files.set(index.file, { size: index.size, chunks: index.chunks || [[0, index.size]] });
      for (const [stem, [c, offset, length]] of Object.entries(index.atlases || {})) atlases.set(stem, { file: index.file, chunk: c, offset, length });
      for (const [path, [c, offset, length, enc, size]] of Object.entries(index.entries || {})) named.set(path, { file: index.file, chunk: c, offset, length, enc, size });
    },
    has: (rel) => atlases.has(stemOf(rel)),
    hasFile: (path) => named.has(String(path).replace(/^\/+/, '')),
    get count() { return atlases.size; },
    /** A registered file's decoded bytes (one Range request per chunk, shared and cached like the atlases); a file not registered is a 404. */
    async bytes(path, signal) {
      const a = named.get(String(path).replace(/^\/+/, ''));
      if (!a) throw httpError(404, path);
      const { bytes, start } = await chunk(a.file, a.chunk, signal);
      const from = a.offset - start;
      if (from < 0 || from + a.length > bytes.byteLength) throw corruptError(path);
      const raw = bytes.subarray(from, from + a.length);
      if (a.enc !== 'gzip') return raw.slice();
      let out;
      try { out = await gunzip(raw); } catch { throw corruptError(path); }
      if (a.size !== undefined && out.byteLength !== a.size) throw corruptError(path);
      return out;
    },
    /** The atlas as a Blob; a file the packs do not hold is a 404 (no request is made). */
    async blob(rel, signal) {
      const a = atlases.get(stemOf(rel));
      if (!a) throw httpError(404, rel);
      const { bytes, start } = await chunk(a.file, a.chunk, signal);
      const from = a.offset - start;
      if (from < 0 || from + a.length > bytes.byteLength) throw corruptError(rel);
      return new Blob([bytes.subarray(from, from + a.length)], { type: 'image/webp' });
    }
  };
}

const stemOf = (rel) => String(rel).replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');

let atlasSource = null;
/** The atlas source of the open packed store (null: atlases are plain files under the data base). */
export const getAtlasSource = () => atlasSource;
export const setAtlasSource = (src) => { atlasSource = src; };

// -------------------------------------------------------------------------------------------------------------- manifest

/** Normalises 'tiles/../city/meta.json' -> 'city/meta.json'. */
export function normalizePath(p) {
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

/** <base>/manifest.json, or null when absent, unreadable or not cph-packs/1 (the store then reads the unpacked layout). */
export async function fetchManifest(base, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(`${trim(base)}/${MANIFEST_NAME}`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const m = await r.json();
    return m?.format === MANIFEST_FORMAT && m.tiles && m.files ? m : null;
  } catch (error) {
    console.info('[cph] no pack manifest:', error?.message || error);
    return null;
  }
}

/**
 * The file source of the tile store over a manifest. Paths are relative to the tile directory as the unpacked store uses them
 * ('index.json', '../city/meta.json', '<tile>/<layer>.json', '<tile>/lod2.bin').
 *   json(rel, signal), bin(rel), key(rel) (the request a path is served by: the streamer caps concurrent requests, not layers)
 * A tile pack that fails (missing, or corrupt twice) falls back to `manifest.fallback` (a base-relative unpacked tile directory)
 * when the manifest names one; otherwise the error goes up (the streamer retries the layer a few seconds later).
 */
export function createPackSource(manifest, { base, fetchImpl = globalThis.fetch, packs = null, atlases = null } = {}) {
  const client = packs || createPackClient({ base, fetchImpl });
  const groupOf = new Map();
  (manifest.groups || []).forEach((g, i) => { for (const l of g.layers) groupOf.set(l, i); });
  const atlasIndexEntry = manifest.atlasIndex || 'atlas.index';
  const registered = new Map(); // core pack file -> Promise
  const fallbackBase = manifest.fallback ? `${trim(base)}/${trim(manifest.fallback)}` : null;

  function locate(rel) {
    const p = normalizePath(`tiles/${rel}`);
    if (manifest.files[p]) return { file: manifest.files[p], name: p };
    const m = /^tiles\/([^/]+)\/(.+)$/.exec(p);
    if (!m) return null;
    const name = m[2].replace(/\.json$/, '');
    const g = groupOf.get(name);
    const file = g === undefined ? null : manifest.tiles[m[1]]?.[g];
    return file ? { file, name: `${m[1]}/${name}`, tile: m[1], group: g } : null;
  }

  async function registerAtlases(file, tile) {
    if (!atlases) return;
    const key = `${file}#${tile}`;
    if (!registered.has(key)) {
      registered.set(key, (async () => {
        const pack = await client.pack(file);
        const name = `${tile}/${atlasIndexEntry}`;
        if (pack.entries.has(name)) atlases.register(await entryJson(pack, name));
      })().catch((e) => { registered.delete(key); throw e; }));
    }
    return registered.get(key);
  }

  async function viaFallback(rel, kind, error) {
    if (!fallbackBase || error?.name === 'AbortError') throw error;
    const r = await fetchImpl(`${fallbackBase}/${rel}`);
    if (!r.ok) throw error;
    return kind === 'json' ? r.json() : r.arrayBuffer();
  }

  return {
    manifest,
    client,
    locate,
    key: (rel) => locate(rel)?.file || rel,
    async json(rel, signal) {
      const at = locate(rel);
      if (!at) throw httpError(404, rel);
      try {
        const pack = await client.pack(at.file, signal);
        if (at.group === 0 && atlases) await registerAtlases(at.file, at.tile);
        if (!pack.entries.has(at.name)) throw httpError(404, rel);
        return await entryJson(pack, at.name);
      } catch (error) {
        if (at.tile) return viaFallback(rel, 'json', error);
        throw error;
      }
    },
    async bin(rel) {
      const at = locate(rel);
      if (!at) return null;
      try {
        const b = await client.bytes(at.file, at.name);
        return b ? ownBuffer(b) : null;
      } catch (error) {
        if (at.tile) return viaFallback(rel, 'bin', error).catch(() => null);
        throw error;
      }
    }
  };
}
