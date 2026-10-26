// js/hero-cache.js
// A hero glTF (the NS37 model) is parsed once and handed out as clones: a tile rebuilds when it moves between the near and the mid ring,
// and streams out and in again, and every build used to fetch and parse the glb again. The clones share the geometries, materials and
// textures of the cached template (which the cache owns). A hero whose load failed (the glb is not on this machine) is not asked for
// again for `retryMs`: the failure is cached too, so a rebuild does not repeat two 404s.
//
// Pure (no three.js): `load(hero)` resolves to an object with clone(); `mark(template)` flags the template (default: userData.cached).

export const HERO_RETRY_MS = 5 * 60 * 1000;

export function createHeroCache(load, { retryMs = HERO_RETRY_MS, now = () => (typeof performance === 'undefined' ? Date.now() : performance.now()), mark = (t) => { if (t?.userData) t.userData.cached = true; return t; } } = {}) {
  const entries = new Map(); // building id -> { template: Promise, error?, at }
  const stats = { loads: 0, hits: 0, failures: 0, suppressed: 0 };
  return {
    stats,
    entries,
    /** The hero as a fresh clone of the cached template. Rejects with the cached error while a failed load is not due again. */
    async get(hero) {
      const key = String(hero.building_id);
      let entry = entries.get(key);
      if (entry?.error) {
        if (now() - entry.at < retryMs) { stats.suppressed++; throw entry.error; }
        entry = null;
      }
      if (!entry) {
        stats.loads++;
        const self = { at: now(), template: Promise.resolve(load(hero)).then(mark) };
        self.template.catch((error) => { self.error = error; self.at = now(); stats.failures++; });
        entries.set(key, self);
        entry = self;
      } else stats.hits++;
      return (await entry.template).clone();
    },
    clear() { entries.clear(); }
  };
}
