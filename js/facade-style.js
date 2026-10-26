// js/facade-style.js
// Pure per-building facade style: what the wall is made of and how old the front looks. Encoded into one integer the facade
// shader decodes (facadeBldg.z): code = MAT + 4 * ERA.
//   MAT   0 brick (exposed Danish-format brick), 1 plaster (lime render, painted), 2 concrete panel / render, 3 timber boarding
//   ERA   0 modern (> 1960), 1 mid (1920-1960), 2 historic (< 1920: plinth, band courses and a cornice)
// The observed (calibrated) tone stays the base albedo; this only chooses the surface structure on top of it.

const MAT = { brick: 0, plaster: 1, concrete: 2, timber: 3 };
const ERA = { modern: 0, mid: 1, historic: 2 };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function sat([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx <= 1e-6 ? 0 : (mx - mn) / mx;
}
const brickHue = ([r, g, b]) => r >= g * 1.04 && g >= b * 0.88 && sat([r, g, b]) > 0.16;

/** Material class from BBR `wall_material` and the observed sRGB tone (plaster that BBR files under "mursten" is detected by colour). */
function wallMaterial(b, toneSrgb) {
  const m = b.wall_material;
  const t = Array.isArray(toneSrgb) ? toneSrgb : null;
  const L = t ? lum(t.map(srgbToLinear)) : 0.3;
  const paintedLight = t && L > 0.5 && sat(t) < 0.2; // very light, nearly grey: render or painted brick
  if (m === 'træ' || m === 'bindingsværk') return MAT.timber;
  if (m === 'betonelementer' || m === 'letbetonsten' || m === 'fibercement herunder asbest' || m === 'fibercement uden asbest') return MAT.concrete;
  if (m === 'mursten') return paintedLight ? MAT.plaster : MAT.brick;
  if (t && brickHue(t) && L < 0.45) return MAT.brick; // unlabelled but brick coloured
  return (b.year && b.year >= 1960) ? MAT.concrete : MAT.plaster;
}

function wallEra(b) {
  const y = b.year;
  if (!y) return (b.storeys || 0) >= 4 ? ERA.historic : ERA.mid; // unknown year: Søerne karré is mostly pre-1920
  if (y < 1920) return ERA.historic;
  if (y < 1960) return ERA.mid;
  return ERA.modern;
}

/** { mat, era, code } for one building; `toneSrgb` is the building-level observed tone (sRGB 0-1) when known. */
function facadeStyle(b, toneSrgb) {
  const mat = wallMaterial(b, toneSrgb);
  const era = (b.storeys || 1) <= 1 && (b.eave - b.ground) < 4.5 ? Math.min(wallEra(b), ERA.mid) : wallEra(b); // sheds get no cornice
  return { mat, era, code: mat + 4 * era };
}

export { MAT, ERA, wallMaterial, wallEra, facadeStyle };

export const FACADE_CORNER_PIER = 0.9;
export const WINDOW = Object.freeze({ transom: 0.68, ratioY: 0.64, whiteShare: 0.65 });
export const FRAME_COLOURS = Object.freeze([0xe8e5dc, 0x24392d, 0x242626, 0x423027]);

export function styleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  // Avalanche the sequential numeric building ids before choosing a palette.
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function windowStyle(b) {
  const h = styleHash(String(b.id));
  const pick = h / 4294967296;
  const frame = pick < WINDOW.whiteShare ? 0 : 1 + Math.min(2, Math.floor((pick - WINDOW.whiteShare) / (1 - WINDOW.whiteShare) * 3));
  const year = b.year || 1900;
  // korspost (0), T/flag (1), small upper lights (2), two plain casements / funkis (3).
  const type = year >= 1930 ? 3 : year >= 1915 ? 2 : h % 4 === 0 ? 1 : 0;
  return { frame, colour: FRAME_COLOURS[frame], type, frameWidth: 0.07 + ((h >>> 16) % 801) / 10000 * 0.375, reveal: 0.10 + ((h >>> 16) % 801) / 10000 };
}

/** Eligible for inferred physical trim; low outbuildings and modern/glazed facades stay plain. */
function hasFacadeDetails(b, style = facadeStyle(b)) {
  return style.era >= ERA.mid && b.wall_material !== 'glas' && b.facade?.ground_type !== 'blank'
    && !((b.storeys || 1) <= 1 && b.eave - b.ground < 4.5);
}
export { hasFacadeDetails };

// Existing time presets drive interiorGlow: midday .24, golden .48, twilight 1.25, night 1.55.
// A separate occupancy curve keeps bright late-night bulbs from implying that every apartment is awake.
export const WINDOW_OCCUPANCY = Object.freeze({ day: 0.12, evening: 0.50, night: 0.10 });
export function windowOccupancy(glow) {
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const { day, evening, night } = WINDOW_OCCUPANCY;
  return (day + (evening - day) * smooth(0.24, 0.48, glow)) * (1 - (1 - night / evening) * smooth(1.25, 1.55, glow));
}
