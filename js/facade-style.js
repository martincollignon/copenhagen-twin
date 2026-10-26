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
