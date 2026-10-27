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
  qualityHoldSteps: 2, // the resident tier is kept while it is this many steps from the planned one (and fits): no churn at boundaries
  closeMargin: 10, // m: a building whose photo walls are all nearer than close0 - closeMargin draws no photo and holds no atlas
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
 * close0 - closeMargin (all of it nearer than that draws no photo), nearest first, at most `budget`. Its tier is the atlas scale
 * its walls need on screen (densityScale) at the finest density of p.densities at which every wanted building fits
 * p.maxResidentBytes; the resident tier is held within p.qualityHoldSteps while the bytes allow. Only when even the coarsest density
 * does not fit are the farthest buildings coarsened further, then dropped. Returns { want, qualityById (tier, size, bytes per id),
 * residentBytes, density, inRange: every id within the residency radius }.
 */
function selectPhotoSet(candidates, x, z, p = PHOTO, currentTiers = new Map(), y = undefined) {
  const near = [];
  const reach = p.residency + 400; // cheap centre prefilter: no building's walls reach 400 m from its centre
  const closeLimit = p.close0 - (p.closeMargin ?? 10);
  for (const c of candidates) {
    if (Math.abs(c.cx - x) > reach || Math.abs(c.cz - z) > reach) continue;
    const d = wallDistance(c, x, y, z);
    if (d.near < p.residency && d.far >= closeLimit) near.push({ distance: d.near, far: d.far, c });
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
  let density = densities.at(-1);
  let planned = stepsAt(density);
  for (const k of densities) {
    const list = stepsAt(k);
    if (total(list) <= maxResidentBytes) { density = k; planned = list; break; }
  }

  // hold resident tiers near the plan (fewer reloads while the camera moves); a finer held tier only while the bytes allow
  const hold = p.qualityHoldSteps ?? 0;
  let bytes = total(planned);
  const tiers = planned.map((step, i) => {
    const current = currentTiers.get(chosen[i].c.id);
    const ci = steps.indexOf(current);
    const pi = steps.indexOf(step);
    if (ci < 0 || ci === pi || Math.abs(ci - pi) > hold) return step;
    const size = sizeOf(chosen[i].c);
    const extra = atlasBytes(size, current).bytes - atlasBytes(size, step).bytes;
    if (bytes + extra > maxResidentBytes) return step;
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
  return { want, qualityById, residentBytes, density, inRange: new Set(near.map((e) => e.c.id)) };
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
 * Unwanted residents go first; then new atlases nearest first within `p.concurrency` in-flight loads and `p.maxResidentBytes`; when
 * nothing is in flight, one quality replacement (downgrades first; the old atlas stays visible meanwhile). The first atlas of a manager
 * is its presence probe: nothing else of that manager starts until it is settled.
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

  // new atlases first (a building without its photo is the bigger miss), nearest first within the in-flight cap
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
  // still to do after this pass: a wanted atlas not resident, in flight or failed (createPhotoBudget re-applies the plan between plans)
  const backlog = want.some((id) => { const s = owner.get(id)?.state; return s && s.enabled && !s.resident.has(id) && !s.loading.has(id) && !s.failed.has(id); });
  if (loading() > 0) return backlog;

  // then one quality replacement at a time (the old atlas stays visible meanwhile): downgrades first, they give bytes back
  const stale = want.filter((id) => {
    const m = owner.get(id);
    const resident = m?.state.resident.get(id);
    const q = qualityById.get(id);
    return resident && usable(q) && (resident.width !== q.width || resident.height !== q.height) && m.state.failedTiers.get(id) !== q.tier;
  });
  const smaller = (id) => qualityById.get(id).bytes < bytesOf(owner.get(id).state.resident.get(id));
  for (const id of [...stale.filter(smaller), ...stale.filter((id) => !smaller(id))]) {
    const q = qualityById.get(id);
    if (room(q, id)) { owner.get(id).start(id, q); return true; }
  }
  return backlog;
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
  const sum = (f) => { let n = 0; for (const m of managers) n += f(m.state); return n; };
  return {
    managers,
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
    /** Called every frame with the camera position (`y` its height: distances are 3D); plans at most every `interval` ms. */
    update(x, z, now = performance.now(), y = undefined) {
      if (now - lastRun < interval) {
        // between plans, keep the loads flowing: a settled load frees its in-flight slot for the next atlas of the same plan
        if (planned && backlog && sum((s) => s.loading.size) < p.concurrency) backlog = applyPhotoPlan([...managers], planned, p);
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
      const plan = select(live.flatMap((m) => m.candidates), x, z, p, currentTiers, y);
      lastPlan = { density: plan.density, wanted: plan.want.length };
      planned = plan;
      backlog = applyPhotoPlan([...managers], plan, p); // every manager: a disabled one still frees what it holds outside the plan
      return true;
    }
  };
}

export { PHOTO, photoFade, texRequested, selectPhotoSet, wallDistance, densityScale, quantiseStep, pixelMetres, createPhotoBudget, applyPhotoPlan, makePhotoRoom, photoReservation, lookFile, estimateTextureBytes, scaledTextureSize };
