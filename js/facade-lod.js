// js/facade-lod.js
// Pure LOD policy for the photo facades: which buildings keep their wall photos resident near the camera and how the photo
// fades into the tone + procedural facade with distance. The GPU side (js/facade-photo-material.js) uses the same
// constants for its per-fragment crossfade, so CPU residency and the shader fade agree.

const PHOTO = {
  close0: 14, // m: nearer than this the facade is fully procedural (the photo is 10 cm/px: crisp brick, windows and reveals win)
  close1: 40, // m: the photo is fully in from here (smoothstep between close0 and close1)
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

export { PHOTO, photoFade, texRequested, selectPhotoSet, lookFile, estimateTextureBytes, scaledTextureSize };
