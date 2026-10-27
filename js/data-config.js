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

/**
 * Whether hero glTFs (data/heroes/<id>/building.{json,glb}) may be requested. They are built from building-case drawings,
 * which are third-party copyrighted works (.claude/skills/building-case-to-3d/SKILL.md): the models stay outside git and are
 * never published, neither in the Pages artifact nor on R2. So they only exist in a local checkout (tools/link-heroes.sh), and
 * a published build (BUILD_DATA_BASE rewritten to an http(s) URL by the Pages workflow) never asks for them and extrudes the
 * footprint instead. `?heroes=0` / `?heroes=1` overrides either way.
 */
export function heroesEnabled(search = globalThis.location?.search || '', configured = BUILD_DATA_BASE) {
  let flag = null;
  try { flag = new URLSearchParams(search).get('heroes'); } catch { /* no usable query string */ }
  if (flag === '0' || flag === 'off') return false;
  if (flag !== null) return true;
  return !isRemoteBase(configured);
}
