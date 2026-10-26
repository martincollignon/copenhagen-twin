// js/data-config.js
// ONE base URL for the bulky citywide data: data/tiles (tile index + layers), data/city (reached through the tile index) and the
// facade atlases (data/tex-look, data/tex). Pure (no three.js, no fetch), so it runs in node.
//
//   default      BUILD_DATA_BASE below: './data' in the repo (local dev); the Pages workflow rewrites it to the R2 URL
//                (see README, "Hosting the citywide data").
//   ?data=<url>  per-session override (an absolute URL or a path; a trailing slash is ignored).
//   ?tiles=<url> still overrides the tile directory alone (js/main.js).
//
// Layout under the base: tiles/<id>/<layer>.json, tiles/index.json, city/*, tex-look/*.webp, tex/*.jpg.

export const BUILD_DATA_BASE = './data';

const trim = (s) => String(s).replace(/\/+$/, '');

/** The data base for a query string: `?data=` when given, else the build default. */
export function resolveDataBase(search = globalThis.location?.search || '', configured = BUILD_DATA_BASE) {
  let override = null;
  try { override = new URLSearchParams(search).get('data'); } catch { /* no usable query string */ }
  return trim(override || configured || './data');
}

/** True for an absolute http(s) base: such data is versioned by its path prefix, so the browser may cache it normally. */
export const isRemoteBase = (base) => /^https?:\/\//i.test(String(base));

/** `<base>/<rel>` for the current page's data base. */
export function dataUrl(rel, base = resolveDataBase()) {
  return `${trim(base)}/${String(rel).replace(/^\/+/, '')}`;
}
