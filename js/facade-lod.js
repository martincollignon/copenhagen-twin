// js/facade-lod.js
// Pure LOD policy for the photo facades: which buildings keep their wall photos resident near the camera and how the photo
// fades into the tone + procedural facade with distance. The GPU side (js/facade-photo-material.js) uses the same
// constants for its per-fragment crossfade, so CPU residency and the shader fade agree.

const PHOTO = {
  close0: 45, // m: nearer than this the facade is fully procedural (Skraafoto is 10-13 cm/px: a window is ~9 px and reads as a smudge up close)
  close1: 80, // m: the photo is fully in from here (smoothstep between close0 and close1)
  near: 115, // m: fully photographic up to here
  far: 150, // m: fully procedural from here (smoothstep crossfade in between)
  residency: 165, // m: buildings inside this radius may hold an atlas (a little beyond `far` so nothing pops in mid-fade)
  budget: 56, // hard resident count cap (nearest first)
  qualityTiers: [
    { maxDimension: 8192, through: 70 }, // native atlas resolution when the byte budget allows
    { maxDimension: 4096, through: 105 },
    { maxDimension: 2048, through: 140 },
    { maxDimension: 512, through: 165 }
  ],
  qualityHysteresis: 8, // m: hold the resident tier briefly on either side of a distance boundary
  maxResidentBytes: 48 * 1024 * 1024, // estimated RGBA8+mipmap budget, also reserved for in-flight uploads
  concurrency: 2
};

/** Scaled atlas dimensions for a maximum texture dimension, preserving the source aspect ratio. */
function scaledTextureSize(size, maxDimension) {
  const [width, height] = size || [];
  if (!(width > 0 && height > 0)) return [0, 0];
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

/** Conservative RGBA8 allocation estimate, summing every level of the full mip chain. */
function estimateTextureBytes(size, maxDimension = Math.max(...(size || [0, 0]))) {
  let [width, height] = scaledTextureSize(size, maxDimension);
  if (!(width > 0 && height > 0)) return 0;
  let pixels = 0;
  while (true) {
    pixels += width * height;
    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return pixels * 4;
}

function preferredTierIndex(distance, currentTier, p) {
  const tiers = p.qualityTiers || PHOTO.qualityTiers;
  let preferred = tiers.findIndex((tier) => distance <= tier.through);
  if (preferred < 0) preferred = tiers.length - 1;
  const current = tiers.findIndex((tier) => tier.maxDimension === currentTier);
  if (current < 0 || current === preferred) return preferred;

  const hysteresis = p.qualityHysteresis || 0;
  if (current < preferred) {
    const boundary = tiers[current].through;
    if (distance <= boundary + hysteresis) return current;
  } else {
    const boundary = tiers[current - 1].through;
    if (distance >= boundary - hysteresis) return current;
  }
  return preferred;
}

const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Photo opacity at camera distance `d` metres: 0 very close (procedural detail), 1 in the photo band, 0 far (tone + procedural). */
const photoFade = (d, p = PHOTO) => smooth(p.close0, p.close1, d) * (1 - smooth(p.near, p.far, d));

/** Photo walls are the default; `?tex=0` (or `?debug=notex`) turns them off, `?tex=1` / `?debug=tex` stay accepted. */
function texRequested(search = typeof location === 'undefined' ? '' : location.search) {
  const q = new URLSearchParams(search);
  if (q.get('tex') === '0' || (q.get('debug') || '').split(',').includes('notex')) return false;
  return true;
}

/**
 * Residency plan for one camera position: `candidates` [{ id, cx, cz }]. Returns { want: [ids nearest first, at most
 * `budget`], `qualityById`: selected tier and estimated size per id, and `inRange`: every id within the residency radius
 * (kept while still in range, so a building is only evicted when it leaves the radius or loses its budget slot).
 */
function selectPhotoSet(candidates, x, z, p = PHOTO, currentTiers = new Map()) {
  const near = [];
  for (const c of candidates) {
    const d = Math.hypot(c.cx - x, c.cz - z);
    if (d < p.residency) near.push([d, c]);
  }
  near.sort((a, b) => a[0] - b[0]);
  const want = [];
  const qualityById = new Map();
  let residentBytes = 0;
  const maxResidentBytes = p.maxResidentBytes ?? Infinity;
  const tiers = p.qualityTiers || PHOTO.qualityTiers;
  for (const [distance, candidate] of near) {
    if (want.length >= p.budget) break;
    const size = candidate.walls?.size || candidate.size;
    const sourceMax = Math.max(...(size || [0, 0]));
    const preferred = preferredTierIndex(distance, currentTiers.get(candidate.id), p);
    for (let tierIndex = preferred; tierIndex < tiers.length; tierIndex++) {
      const tier = tiers[tierIndex];
      const [width, height] = sourceMax > 0 ? scaledTextureSize(size, tier.maxDimension) : [0, 0];
      const maxDimension = sourceMax > 0 ? Math.min(sourceMax, tier.maxDimension) : tier.maxDimension;
      const bytes = sourceMax > 0 ? estimateTextureBytes(size, maxDimension) : 0;
      if (residentBytes + bytes > maxResidentBytes) continue;
      want.push(candidate.id);
      qualityById.set(candidate.id, {
        tier: tier.maxDimension,
        maxDimension,
        width,
        height,
        bytes,
        distance
      });
      residentBytes += bytes;
      break;
    }
  }
  return { want, qualityById, residentBytes, inRange: new Set(near.map((e) => e[1].id)) };
}

/** Atlas file the photo walls are read from: the processed RGBA look atlas (tools/cph-geodata/facade_look.py) first. */
const lookFile = (file) => file.replace(/^tex\//, 'tex-look/').replace(/\.jpe?g$/i, '.webp');

const bytesOf = (entry) => entry?.bytes || 0;

/** Every manager's resident and in-flight atlas reservation (managers: createTexManager in js/buildings-real.js). */
function photoReservation(managers) {
  let residentBytes = 0;
  let pendingBytes = 0;
  let residentCount = 0;
  let pendingCount = 0;
  for (const m of managers) {
    for (const r of m.state.resident.values()) residentBytes += bytesOf(r);
    for (const job of m.state.loading.values()) pendingBytes += bytesOf(job);
    residentCount += m.state.resident.size;
    pendingCount += m.state.loading.size;
  }
  return { residentBytes, pendingBytes, reservedBytes: residentBytes + pendingBytes, residentCount, pendingCount };
}

/**
 * Frees the farthest resident atlases (by their rank in `want`, unwanted first) over every manager until `bytes` more fit in
 * `maxBytes`. The resident atlas of `protectedId` stays (a quality replacement keeps it visible until the new one is in), and when that
 * atlas plus the in-flight requests alone cannot fit nothing is evicted.
 */
function makePhotoRoom(managers, bytes, protectedId, want, maxBytes = PHOTO.maxResidentBytes) {
  const order = new Map(want.map((id, index) => [id, index]));
  const rank = (id) => order.get(id) ?? Infinity;
  const residents = [];
  let total = bytes;
  let protectedBytes = 0;
  let pendingBytes = 0;
  for (const m of managers) {
    for (const [id, r] of m.state.resident) {
      total += bytesOf(r);
      if (id === protectedId) protectedBytes += bytesOf(r);
      else residents.push([id, m, bytesOf(r)]);
    }
    for (const [id, job] of m.state.loading) {
      total += bytesOf(job);
      if (id !== protectedId) pendingBytes += bytesOf(job);
    }
  }
  if (protectedBytes + pendingBytes + bytes > maxBytes) return false;
  residents.sort((a, b) => { const ra = rank(a[0]); const rb = rank(b[0]); return ra === rb ? 0 : rb > ra ? 1 : -1; }); // farther first
  for (const [id, m, held] of residents) {
    if (total <= maxBytes) break;
    m.evict(id);
    total -= held;
  }
  return total <= maxBytes;
}

/**
 * Carries out one residency plan (selectPhotoSet over the candidates of `managers`) on those managers. A manager is
 * { state: { enabled, resident: Map id -> { bytes, width, height, tier }, loading: Map id -> { bytes, width, height, tier }, failed: Set,
 * failedTiers: Map, probed, probing }, has(id), prune(wantSet, qualityById), evict(id), start(id, quality) }.
 * Unwanted residents go first; then one quality replacement at a time (the old atlas stays visible meanwhile), else new atlases nearest
 * first within `p.concurrency` in-flight loads and `p.maxResidentBytes`. The first atlas of a manager is its presence probe: nothing else
 * of that manager starts until it is settled.
 */
function applyPhotoPlan(managers, plan, p = PHOTO) {
  const { want, qualityById } = plan;
  const wantSet = new Set(want);
  for (const m of managers) m.prune(wantSet, qualityById);
  const owner = new Map();
  for (const id of want) {
    for (const m of managers) if (m.has(id)) { owner.set(id, m); break; }
  }
  const loading = () => { let n = 0; for (const m of managers) n += m.state.loading.size; return n; };
  const usable = (q) => q && q.width > 0 && q.height > 0;
  const room = (q, id) => makePhotoRoom(managers, q.bytes, id, want, p.maxResidentBytes ?? Infinity);

  const replacementId = want.find((id) => {
    const m = owner.get(id);
    const resident = m?.state.resident.get(id);
    const q = qualityById.get(id);
    return resident && q && (resident.width !== q.width || resident.height !== q.height) && m.state.failedTiers.get(id) !== q.tier;
  });
  if (replacementId && loading() === 0) {
    const q = qualityById.get(replacementId);
    if (usable(q) && room(q, replacementId)) owner.get(replacementId).start(replacementId, q);
    return;
  }

  for (const id of want) {
    if (loading() >= p.concurrency) break;
    const m = owner.get(id);
    const s = m?.state;
    if (!s || !s.enabled || s.probing || s.resident.has(id) || s.loading.has(id) || s.failed.has(id)) continue;
    const q = qualityById.get(id);
    if (!usable(q) || !room(q, id)) continue;
    if (!s.probed) s.probed = s.probing = true; // cleared by the manager once its probe settles
    m.start(id, q);
  }
}

/**
 * One photo budget over every manager it holds: one district (createTexManager makes its own) or every tile of a streamed city
 * (js/buildings-stream.js), so the PHOTO.budget count cap and the PHOTO.maxResidentBytes texture budget hold for the whole scene instead
 * of once per tile. Each update plans over the candidates of all managers at once (nearest first, quality tiers by distance with the
 * resident tier as hysteresis) and evicts across managers to make room.
 */
function createPhotoBudget({ interval = 350, select = selectPhotoSet, p = PHOTO } = {}) {
  const managers = new Set();
  let lastRun = -Infinity;
  let peakReservedBytes = 0;
  const sum = (f) => { let n = 0; for (const m of managers) n += f(m.state); return n; };
  return {
    managers,
    add(manager) { if (manager) managers.add(manager); },
    remove(manager) { managers.delete(manager); },
    held: () => sum((s) => s.resident.size + s.loading.size),
    loading: () => sum((s) => s.loading.size),
    /** Records the current reservation as a peak candidate (a manager calls it when it reserves a load). */
    notePeak() { peakReservedBytes = Math.max(peakReservedBytes, photoReservation(managers).reservedBytes); },
    /** Resident and in-flight texture estimate over every manager, against the byte budget. */
    memory() {
      const r = photoReservation(managers);
      return {
        residentBytes: r.residentBytes, pendingBytes: r.pendingBytes, reservedBytes: r.reservedBytes, peakReservedBytes,
        budgetBytes: p.maxResidentBytes, residentCount: r.residentCount, pendingCount: r.pendingCount
      };
    },
    /** Called every frame with the camera position; plans at most every `interval` ms. */
    update(x, z, now = performance.now()) {
      if (now - lastRun < interval) return false;
      lastRun = now;
      const live = [...managers].filter((m) => m.state.enabled && m.loader);
      if (!live.length) return true;
      const currentTiers = new Map();
      for (const m of live) {
        for (const [id, r] of m.state.resident) currentTiers.set(id, r.tier);
        for (const [id, job] of m.state.loading) if (!currentTiers.has(id)) currentTiers.set(id, job.tier);
      }
      const plan = select(live.flatMap((m) => m.candidates), x, z, p, currentTiers);
      applyPhotoPlan([...managers], plan, p); // every manager: a disabled one still frees what it holds outside the plan
      return true;
    }
  };
}

export { PHOTO, photoFade, texRequested, selectPhotoSet, createPhotoBudget, applyPhotoPlan, makePhotoRoom, photoReservation, lookFile, estimateTextureBytes, scaledTextureSize };
