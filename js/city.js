// js/city.js
// City switch: `?city=cph` (default) boots the Copenhagen twin, `?city=nyc` keeps the original Manhattan build.
// Everything Manhattan-only (synthetic lots, city grid, boroughs, landmarks, fire escapes, NYC street details,
// the NYC traffic network) is imported dynamically by main.js only when CITY === 'nyc'.

export const CITIES = ['cph', 'nyc'];

export function resolveCity(search) {
  let value = null;
  try {
    value = new URLSearchParams(search || '').get('city');
  } catch { /* an unparseable query falls back to the default */ }
  value = value ? value.toLowerCase() : 'cph';
  return CITIES.includes(value) ? value : 'cph';
}

export const CITY = resolveCity(globalThis.location?.search);
export const IS_NYC = CITY === 'nyc';
export const IS_CPH = CITY === 'cph';
