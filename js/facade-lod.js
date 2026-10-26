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
  maxTextureDimension: 2048, // clamp tall WebP atlases before GPU upload
  maxResidentBytes: 48 * 1024 * 1024, // decoded RGBA8 plus mipmaps, shared across resident photo walls
  concurrency: 2
};

/** Conservative RGBA8 allocation estimate, including the full mip chain. */
function estimateTextureBytes(size, p = PHOTO) {
  const [width, height] = size || [];
  if (!(width > 0 && height > 0)) return 0;
  const maxDimension = p.maxTextureDimension || Math.max(width, height);
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return Math.ceil(width * scale) * Math.ceil(height * scale) * 4 * (4 / 3);
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
 * `budget`], inRange: Set of every id within the residency radius (kept while still in range, so a building is only
 * evicted when it leaves the radius or loses its budget slot to a nearer one) }.
 */
function selectPhotoSet(candidates, x, z, p = PHOTO) {
  const near = [];
  for (const c of candidates) {
    const d = Math.hypot(c.cx - x, c.cz - z);
    if (d < p.residency) near.push([d, c]);
  }
  near.sort((a, b) => a[0] - b[0]);
  const want = [];
  let residentBytes = 0;
  const maxResidentBytes = p.maxResidentBytes ?? Infinity;
  for (const [, candidate] of near) {
    if (want.length >= p.budget) break;
    const bytes = estimateTextureBytes(candidate.walls?.size || candidate.size, p);
    if (residentBytes + bytes > maxResidentBytes) continue;
    want.push(candidate.id);
    residentBytes += bytes;
  }
  return { want, inRange: new Set(near.map((e) => e[1].id)) };
}

/** Atlas file the photo walls are read from: the processed RGBA look atlas (tools/cph-geodata/facade_look.py) first. */
const lookFile = (file) => file.replace(/^tex\//, 'tex-look/').replace(/\.jpe?g$/i, '.webp');

export { PHOTO, photoFade, texRequested, selectPhotoSet, lookFile };
