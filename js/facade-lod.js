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
  budget: 224, // resident count cap (nearest first): above the busiest photo band (Nyhavn: about 190 buildings), bounds the photo draw calls
  // Quality follows the on-screen texel density where the photo is actually seen. A reference view of `view.fovDeg` over
  // `view.heightPx` pixels spans d * 2 tan(fov / 2) / heightPx metres per pixel at distance d. A building's atlas is sized for the
  // wall distance in [nearest, farthest photo wall] where the photo needs the most texels per metre: photoFade(d) / pixel(d), which
  // peaks near 77 m (the photo is faint in its 45-80 m fade-in and its 115-150 m fade-out) and is never taken nearer than close0.
  // Every plan solves one density `k` (texels per pixel at that distance, from `densities`, finest first) at which every wanted
  // building fits the byte budget, so the photo band is complete and equally sharp on screen instead of native near and missing beyond.
  view: { fovDeg: 60, heightPx: 1080 },
  densities: Array.from({ length: 17 }, (_, i) => +(2 ** (-i / 8)).toFixed(3)), // 1 .. 0.25 in steps of 2^(-1/8) (9 %)
  nativeTexelM: 0.1, // m/texel of the atlases (docs/cph-geodata-schema.md, about 10 cm/px) when a candidate does not say
  qualitySteps: Array.from({ length: 25 }, (_, i) => +(2 ** (-i / 8)).toFixed(3)), // atlas scales (the tier): 1 .. 0.125, 2^(-i/8)
  // Hysteresis, so that a still camera settles and a moving one reloads in proportion to the distance it covers:
  qualityHoldSteps: 3, // a coarser resident tier is kept while it is this many steps from the planned one (2^(-3/8): 77 % of the texels)
  downgradeHoldSteps: 24, // a finer resident tier is kept up to this many steps (24: any) while the bytes allow: a receding building
  // is not re-decoded every few metres, only when its bytes are needed (and then the farthest go first)
  densityHeadroom: 0.94, // the previous plan's density stays while it fits; a finer one is only taken once it fits with this share of
  // the budget (the one global density otherwise flips with every step of the camera that adds or frees bytes, re-planning every tier)
  closeMargin: 10, // m: a building whose photo walls are all nearer than close0 - closeMargin draws no photo and holds no atlas
  residencyHold: 12, // m: a building that holds its atlas keeps it until it is this much beyond either edge (no evict / reload at it)
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

/** Metres one screen pixel spans at distance `d` in the reference view (PHOTO.view). */
function pixelMetres(d, p = PHOTO) {
  const view = p.view || PHOTO.view;
  return d * 2 * Math.tan((view.fovDeg * Math.PI) / 360) / view.heightPx;
}

let fadePeak = null; // [p, d]: where photoFade(d) / d peaks (rises through the fade-in, falls as 1/d and through the fade-out)

/** Interval maximum of photoFade(d) / d over [d0, d1]: the distance in that span that needs the most texels per metre. */
function peakFadePerMetre(d0, d1, p = PHOTO) {
  if (fadePeak?.[0] !== p) {
    let best = [0, p.close1];
    for (let d = p.close0; d <= p.far; d += 0.25) if (photoFade(d, p) / d > best[0]) best = [photoFade(d, p) / d, d];
    fadePeak = [p, best[1]];
  }
  const a = Math.max(d0, p.close0);
  const b = Math.min(d1, p.far);
  if (!(b >= a)) return 0;
  const d = Math.min(Math.max(fadePeak[1], a), b); // unimodal: the peak, or the span end nearest to it
  return photoFade(d, p) / d;
}

/**
 * Atlas scale (fraction of native, at most 1) for `k` texels per screen pixel on the photo walls between `near` and `far` metres:
 * k * native texel size / pixel size, at the distance in that span where the photo needs the most (peakFadePerMetre, weighted by
 * the photo's opacity there).
 */
function densityScale(near, far, nativeTexelM, k = 1, p = PHOTO) {
  return Math.min(1, (k * nativeTexelM * peakFadePerMetre(near, far, p)) / pixelMetres(1, p));
}

/** The coarsest of p.qualitySteps that is at least `scale` (never blurrier than asked), the finest step for scale >= 1. */
function quantiseStep(scale, p = PHOTO) {
  const steps = p.qualitySteps || PHOTO.qualitySteps;
  let best = steps[0];
  for (const step of steps) if (step >= scale - 1e-9) best = step; // finest -> coarsest
  return best;
}

/**
 * Nearest and farthest camera distance (m) to a candidate's photo walls. `walls.segs` (flat [x0, z0, x1, z1, ...], the foot of every
 * photo wall, js/appearance.js texturedWalls) with `walls.y0` / `walls.y1` (their vertical extent) when present, else its footprint
 * `ring` (+ `holes`) between `y0` and `y1`, else its centre. `y` undefined measures in plan only.
 */
function wallDistance(c, x, y, z) {
  const segs = c.walls?.segs;
  const rings = segs ? null : c.ring ? [c.ring, ...(c.holes || [])] : null;
  const y0 = c.walls?.y0 ?? c.y0;
  const y1 = c.walls?.y1 ?? c.y1;
  const vertical = (y === undefined || y === null || y0 === undefined) ? 0 : y > y1 ? y - y1 : y < y0 ? y0 - y : 0;
  const verticalFar = (y === undefined || y === null || y0 === undefined) ? 0 : Math.max(Math.abs(y - y0), Math.abs(y - y1));
  if (!segs && !rings) {
    const d = Math.hypot(c.cx - x, c.cz - z);
    return { near: Math.hypot(d, vertical), far: Math.hypot(d, verticalFar) };
  }
  let near = Infinity;
  let far = 0;
  const visit = (ax, az, bx, bz) => {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    near = Math.min(near, Math.hypot(x - ax - t * dx, z - az - t * dz));
    far = Math.max(far, Math.hypot(ax - x, az - z), Math.hypot(bx - x, bz - z));
  };
  if (segs) for (let i = 0; i + 3 < segs.length; i += 4) visit(segs[i], segs[i + 1], segs[i + 2], segs[i + 3]);
  else {
    for (const r of rings) {
      const n = r.length;
      for (let i = 0; i + 1 < n; i += 2) visit(r[i], r[i + 1], r[(i + 2) % n], r[(i + 3) % n]);
    }
  }
  return { near: Math.hypot(near, vertical), far: Math.hypot(far, verticalFar) };
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

const atlasBytes = (size, step) => {
  const sourceMax = Math.max(...(size || [0, 0]));
  if (!(sourceMax > 0)) return { maxDimension: 8192, width: 0, height: 0, bytes: 0 };
  const maxDimension = Math.max(1, Math.round(sourceMax * step));
  const [width, height] = scaledTextureSize(size, maxDimension);
  return { maxDimension, width, height, bytes: estimateTextureBytes(size, maxDimension) };
};

/**
 * Residency plan for one camera position (x, y, z; `y` undefined plans in plan view): `candidates` [{ id, cx, cz, walls }].
 * A building is wanted while its nearest photo wall (wallDistance) is within PHOTO.residency and its farthest one reaches past
 * close0 - closeMargin (all of it nearer than that draws no photo), nearest first, at most `budget`; one that holds an atlas
 * (`currentTiers`, id -> resident tier) stays wanted p.residencyHold beyond either edge. Its tier is the atlas scale its walls need on
 * screen (densityScale) at one density of p.densities for all: the finest at which every wanted building fits p.maxResidentBytes, or
 * `previousDensity` (the last plan's) while that still fits and a finer one would not fit with p.densityHeadroom of the budget. A resident
 * tier is held while the bytes allow: a coarser one within p.qualityHoldSteps, a finer one within p.downgradeHoldSteps. Only when even the
 * coarsest density does not fit are the farthest buildings coarsened further, then dropped. Returns { want, qualityById (tier, size,
 * bytes per id), residentBytes, density, inRange: every id within the residency radius }.
 */
function selectPhotoSet(candidates, x, z, p = PHOTO, currentTiers = new Map(), y = undefined, previousDensity = undefined) {
  const near = [];
  const reach = p.residency + 400; // cheap centre prefilter: no building's walls reach 400 m from its centre
  const closeLimit = p.close0 - (p.closeMargin ?? 10);
  const hold = p.residencyHold ?? 0; // a held atlas (in currentTiers) stays wanted this far past either edge
  const inRange = new Set();
  for (const c of candidates) {
    if (Math.abs(c.cx - x) > reach + hold || Math.abs(c.cz - z) > reach + hold) continue;
    const d = wallDistance(c, x, y, z);
    const held = currentTiers.has(c.id) ? hold : 0;
    if (d.near < p.residency + held && d.far >= closeLimit - held) {
      near.push({ distance: d.near, far: d.far, c });
      if (d.near < p.residency && d.far >= closeLimit) inRange.add(c.id);
    }
  }
  near.sort((a, b) => a.distance - b.distance);
  const chosen = near.slice(0, p.budget);
  const maxResidentBytes = p.maxResidentBytes ?? Infinity;
  const steps = p.qualitySteps || PHOTO.qualitySteps;
  const densities = p.densities || PHOTO.densities;
  const nativeOf = (c) => c.walls?.texelM || c.texelM || p.nativeTexelM || PHOTO.nativeTexelM;
  const sizeOf = (c) => c.walls?.size || c.size;

  for (const e of chosen) e.need = (nativeOf(e.c) * peakFadePerMetre(e.distance, e.far, p)) / pixelMetres(1, p); // scale at k = 1, unclamped
  const stepsAt = (k) => chosen.map((e) => quantiseStep(Math.min(1, k * e.need), p));
  const total = (list) => list.reduce((n, step, i) => n + atlasBytes(sizeOf(chosen[i].c), step).bytes, 0);
  // the finest density that fits (fit) and the finest that fits with p.densityHeadroom to spare (safe, never finer than fit)
  const headroom = (p.densityHeadroom ?? 1) * maxResidentBytes;
  let fit = densities.length - 1;
  let safe = densities.length - 1;
  for (let i = 0; i < densities.length; i++) {
    const bytes = total(stepsAt(densities[i]));
    if (bytes <= maxResidentBytes && fit === densities.length - 1) fit = i;
    if (bytes <= headroom) { safe = i; break; }
  }
  safe = Math.max(safe, fit);
  // hysteresis: keep the previous density while it fits and is no coarser than `safe`; a first plan takes the finest that fits
  const previous = densities.indexOf(previousDensity);
  const pick = previous < 0 || previous < fit ? fit : previous > safe ? safe : previous;
  const density = densities[pick];
  const planned = stepsAt(density);

  // hold resident tiers near the plan (no reload at a step boundary); a finer held tier only while the bytes allow, nearest first
  const holdSteps = p.qualityHoldSteps ?? 0;
  let bytes = total(planned);
  const tiers = planned.map((step, i) => {
    const current = currentTiers.get(chosen[i].c.id);
    const ci = steps.indexOf(current);
    const pi = steps.indexOf(step);
    const size = sizeOf(chosen[i].c);
    if (ci < 0 || ci === pi || (ci > pi ? ci - pi > holdSteps : pi - ci > (p.downgradeHoldSteps ?? holdSteps))) return step;
    const extra = atlasBytes(size, current).bytes - atlasBytes(size, step).bytes;
    if (extra > 0 && bytes + extra > maxResidentBytes) return step;
    bytes += extra;
    return current;
  });

  const want = [];
  const qualityById = new Map();
  let residentBytes = 0;
  chosen.forEach((e, i) => {
    const size = sizeOf(e.c);
    // over budget only below the coarsest density: this one goes coarser, and is left out when even the coarsest step does not fit
    for (let s = Math.max(0, steps.indexOf(tiers[i])); s < steps.length; s++) {
      const q = atlasBytes(size, steps[s]);
      if (residentBytes + q.bytes > maxResidentBytes) continue;
      want.push(e.c.id);
      qualityById.set(e.c.id, { tier: steps[s], ...q, distance: e.distance });
      residentBytes += q.bytes;
      break;
    }
  });
  return { want, qualityById, residentBytes, density, inRange };
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
 * `maxBytes`. Only residents ranked after `rankLimit` may go (default: after `protectedId`, never a nearer wanted atlas; applyPhotoPlan
 * passes want.length, unwanted ones only). The resident atlas of `protectedId` stays (a quality replacement keeps it visible until the new
 * one is in), and when what may not be evicted plus the in-flight requests cannot fit nothing is evicted.
 */
function makePhotoRoom(managers, bytes, protectedId, want, maxBytes = PHOTO.maxResidentBytes, onEvict = null, rankLimit = undefined) {
  const order = new Map(want.map((id, index) => [id, index]));
  const rank = (id) => order.get(id) ?? Infinity;
  const limit = rankLimit ?? rank(protectedId);
  const residents = [];
  let total = bytes;
  let protectedBytes = 0;
  let pendingBytes = 0;
  for (const m of managers) {
    for (const [id, r] of m.state.resident) {
      total += bytesOf(r);
      if (id === protectedId || !(rank(id) > limit)) protectedBytes += bytesOf(r);
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
    onEvict?.(id, held, rank(id));
    m.evict(id);
    total -= held;
  }
  return total <= maxBytes;
}

/**
 * Carries out one residency plan (selectPhotoSet over the candidates of `managers`) on those managers. A manager is
 * { state: { enabled, resident: Map id -> { bytes, width, height, tier }, loading: Map id -> { bytes, width, height, tier }, failed: Set,
 * failedTiers: Map, probed, probing }, has(id), prune(wantSet, qualityById), evict(id), start(id, quality) }.
 * Unwanted residents go first; then new atlases nearest first within `p.concurrency` in-flight loads and `p.maxResidentBytes`; then
 * downgrades in the free slots; then, with nothing in flight, upgrades (a replacement keeps the old atlas visible meanwhile). No wanted
 * atlas is evicted to make room: the plan fits the budget, so what holds more than it is a resident still finer than its planned tier,
 * and its downgrade gives the bytes back. (Evicting instead made the farthest wanted atlases evict each other in turn, reloading
 * hundreds of times a minute, while the downgrades waited for a moment with nothing in flight that never came.) `stats`
 * (createPhotoStats) counts what is started. The first atlas of a manager is its presence probe: nothing else of that manager starts
 * until it is settled.
 */
function applyPhotoPlan(managers, plan, p = PHOTO, stats = null) {
  const { want, qualityById } = plan;
  const wantSet = new Set(want);
  for (const m of managers) m.prune(wantSet, qualityById);
  const owner = new Map();
  for (const id of want) {
    for (const m of managers) if (m.has(id)) { owner.set(id, m); break; }
  }
  const loading = () => { let n = 0; for (const m of managers) n += m.state.loading.size; return n; };
  const usable = (q) => q && q.width > 0 && q.height > 0;
  const onEvict = stats ? (forId) => (id, held, rank) => { stats.evictions++; logPhoto(stats, { e: 'evict', id, for: forId, bytes: held, rank: rank === Infinity ? -1 : rank }); } : () => null;
  // room for an atlas: only unwanted residents may go (see above)
  const room = (q, id, rankLimit = want.length) => makePhotoRoom(managers, q.bytes, id, want, p.maxResidentBytes ?? Infinity, onEvict(id), rankLimit);

  // new atlases first (a building without its photo is the bigger miss), nearest first within the in-flight cap
  let waiting = false; // a new atlas not started yet
  for (const id of want) {
    const m = owner.get(id);
    const s = m?.state;
    if (!s || !s.enabled || s.resident.has(id) || s.loading.has(id) || s.failed.has(id)) continue;
    waiting = true;
    if (loading() >= p.concurrency || s.probing) continue;
    const q = qualityById.get(id);
    if (!usable(q) || !room(q, id)) continue;
    waiting = false;
    if (!s.probed) s.probed = s.probing = true; // cleared by the manager once its probe settles
    if (stats) {
      stats.newLoads++;
      logPhoto(stats, { e: 'new', id, tier: q.tier, w: q.width, d: +q.distance?.toFixed(1), k: plan.density, reserved: photoReservation(managers).reservedBytes });
    }
    m.start(id, q);
  }
  // quality replacements (the old atlas stays visible meanwhile)
  const stale = want.filter((id) => {
    const m = owner.get(id);
    const resident = m?.state.resident.get(id);
    const q = qualityById.get(id);
    return resident && !m.state.loading.has(id) && usable(q) && (resident.width !== q.width || resident.height !== q.height) && m.state.failedTiers.get(id) !== q.tier;
  });
  const smaller = (id) => qualityById.get(id).bytes < bytesOf(owner.get(id).state.resident.get(id));
  // downgrades in any free slot, even while new atlases load: they give back the bytes the plan counts on (a resident finer than its
  // planned tier holds more than the plan, and new atlases wait for that room)
  const downgrades = stale.filter(smaller);
  for (const id of downgrades) {
    if (loading() >= p.concurrency) break;
    const q = qualityById.get(id);
    if (owner.get(id).state.resident.has(id) && room(q, id)) {
      if (stats) {
        const r = owner.get(id).state.resident.get(id);
        stats.replacements++;
        stats.downgrades++;
        logPhoto(stats, { e: 'replace', id, from: r.tier, fromW: r.width, to: q.tier, toW: q.width, d: +q.distance?.toFixed(1), k: plan.density });
      }
      owner.get(id).start(id, q);
    }
  }
  // nothing in flight and no downgrade fits next to its old atlas: the farthest one swaps in place (its old atlas goes first), rather than
  // evicting a wanted atlas that would then reload
  if (loading() === 0) {
    const swap = downgrades.filter((id) => owner.get(id).state.resident.has(id)).at(-1);
    if (swap !== undefined) {
      const q = qualityById.get(swap);
      const m = owner.get(swap);
      if (stats) {
        const r = m.state.resident.get(swap);
        stats.replacements++;
        stats.downgrades++;
        logPhoto(stats, { e: 'swap', id: swap, from: r.tier, fromW: r.width, to: q.tier, toW: q.width, d: +q.distance?.toFixed(1), k: plan.density });
      }
      m.evict(swap);
      if (room(q, swap)) m.start(swap, q);
    }
  }
  // upgrades last, once nothing else is in flight (a building without its photo, or a downgrade that gives bytes back, comes first), the
  // one furthest below its planned tier first
  const residentOf = (id) => owner.get(id).state.resident.get(id);
  const upgrades = waiting || loading() > 0 ? [] : stale.filter((id) => residentOf(id) && !owner.get(id).state.loading.has(id) && !smaller(id));
  const gap = (id) => qualityById.get(id).tier / (residentOf(id).tier || 1);
  const order = new Map(want.map((id, index) => [id, index]));
  upgrades.sort((a, b) => gap(b) - gap(a) || order.get(a) - order.get(b));
  for (const id of upgrades) {
    if (loading() >= p.concurrency) break;
    const q = qualityById.get(id);
    if (!room(q, id)) continue;
    if (stats) {
      const r = owner.get(id).state.resident.get(id);
      stats.replacements++;
      stats.upgrades++;
      logPhoto(stats, { e: 'replace', id, from: r.tier, fromW: r.width, to: q.tier, toW: q.width, d: +q.distance?.toFixed(1), k: plan.density });
    }
    owner.get(id).start(id, q);
  }
  // still to do after this pass (createPhotoBudget re-applies the plan between plans while a slot frees up): a wanted atlas or a downgrade
  // not started (an upgrade waits for the next plan)
  return waiting || downgrades.some((id) => !owner.get(id).state.loading.has(id));
}

/** Churn counters of one photo budget (createPhotoBudget().stats): plans, loads by kind, decodes, GPU uploads, tier flips. */
function createPhotoStats(logSize = 400) {
  return {
    plans: 0, newLoads: 0, replacements: 0, upgrades: 0, downgrades: 0, decodes: 0, uploads: 0, discarded: 0, aborted: 0,
    densityChanges: 0, tierFlips: 0, evictions: 0, logSize, log: []
  };
}

/** Appends one event to the bounded churn log (oldest dropped). */
function logPhoto(stats, event) {
  if (!stats.logSize) return;
  stats.log.push({ t: Math.round(typeof performance === 'undefined' ? 0 : performance.now()), ...event });
  if (stats.log.length > stats.logSize) stats.log.splice(0, stats.log.length - stats.logSize);
}

/**
 * One photo budget over every manager it holds: one district (createTexManager makes its own) or every tile of a streamed city
 * (js/buildings-stream.js), so the PHOTO.budget count cap and the PHOTO.maxResidentBytes texture budget hold for the whole scene instead
 * of once per tile. Each update plans over the candidates of all managers at once (nearest first, quality tiers by on-screen texel density
 * with the resident tier as hysteresis) and evicts across managers to make room.
 */
function createPhotoBudget({ interval = 350, select = selectPhotoSet, p = PHOTO } = {}) {
  const managers = new Set();
  let lastRun = -Infinity;
  let peakReservedBytes = 0;
  let lastPlan = null;
  let planned = null; // the last plan, re-applied between plans while it has a backlog
  let backlog = false;
  let lastTiers = new Map(); // id -> tier of the previous plan (churn counters)
  const stats = createPhotoStats();
  const sum = (f) => { let n = 0; for (const m of managers) n += f(m.state); return n; };
  return {
    managers,
    stats,
    add(manager) { if (manager) managers.add(manager); },
    remove(manager) { managers.delete(manager); },
    held: () => sum((s) => s.resident.size + s.loading.size),
    loading: () => sum((s) => s.loading.size),
    /**
     * The photo band seen from (x, y, z): candidates with a photo wall nearer than PHOTO.far and one beyond close0 (what the shader can
     * draw), and how many of them hold their atlas. For the headless checks.
     */
    band(x, y, z) {
      let inBand = 0;
      let resident = 0;
      for (const m of managers) {
        for (const c of m.candidates || []) {
          if (Math.abs(c.cx - x) > p.far + 400 || Math.abs(c.cz - z) > p.far + 400) continue;
          const d = wallDistance(c, x, y, z);
          if (d.near >= p.far || d.far <= p.close0) continue;
          inBand++;
          if (m.state.resident.has(c.id)) resident++;
        }
      }
      return { inBand, resident };
    },
    /** Records the current reservation as a peak candidate (a manager calls it when it reserves a load). */
    notePeak() { peakReservedBytes = Math.max(peakReservedBytes, photoReservation(managers).reservedBytes); },
    /** Resident and in-flight texture estimate over every manager, against the byte budget. */
    memory() {
      const r = photoReservation(managers);
      return {
        residentBytes: r.residentBytes, pendingBytes: r.pendingBytes, reservedBytes: r.reservedBytes, peakReservedBytes,
        budgetBytes: p.maxResidentBytes, residentCount: r.residentCount, pendingCount: r.pendingCount,
        wanted: lastPlan?.wanted ?? null, density: lastPlan?.density ?? null
      };
    },
    /** The last residency plan (selectPhotoSet), for the headless checks. */
    get lastPlan() { return planned; },
    /** Called every frame with the camera position (`y` its height: distances are 3D); plans at most every `interval` ms. */
    update(x, z, now = performance.now(), y = undefined) {
      if (now - lastRun < interval) {
        // between plans, keep the loads flowing: a settled load frees its in-flight slot for the next atlas of the same plan
        if (planned && backlog && sum((s) => s.loading.size) < p.concurrency) backlog = applyPhotoPlan([...managers], planned, p, stats);
        return false;
      }
      lastRun = now;
      const live = [...managers].filter((m) => m.state.enabled && m.loader);
      if (!live.length) return true;
      const currentTiers = new Map();
      for (const m of live) {
        for (const [id, r] of m.state.resident) currentTiers.set(id, r.tier);
        for (const [id, job] of m.state.loading) if (!currentTiers.has(id)) currentTiers.set(id, job.tier);
      }
      const plan = select(live.flatMap((m) => m.candidates), x, z, p, currentTiers, y, lastPlan?.density);
      stats.plans++;
      if (lastPlan && lastPlan.density !== plan.density) {
        stats.densityChanges++;
        logPhoto(stats, { e: 'density', from: lastPlan.density, to: plan.density, want: plan.want.length });
      }
      const tiers = new Map();
      for (const [id, q] of plan.qualityById) {
        tiers.set(id, q.tier);
        const before = lastTiers.get(id);
        if (before !== undefined && before !== q.tier) {
          stats.tierFlips++;
          logPhoto(stats, { e: 'tier', id, from: before, to: q.tier, held: currentTiers.get(id), d: +q.distance.toFixed(1), k: plan.density });
        }
      }
      lastTiers = tiers;
      lastPlan = { density: plan.density, wanted: plan.want.length };
      planned = plan;
      backlog = applyPhotoPlan([...managers], plan, p, stats); // every manager: a disabled one still frees what it holds outside the plan
      return true;
    }
  };
}

export { PHOTO, photoFade, texRequested, selectPhotoSet, wallDistance, densityScale, quantiseStep, pixelMetres, createPhotoBudget, applyPhotoPlan, makePhotoRoom, createPhotoStats, logPhoto, photoReservation, lookFile, estimateTextureBytes, scaledTextureSize };
