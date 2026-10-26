import * as THREE from 'three/webgpu';
import { buildRealBuildings, createBuildingMaterials, createInfoPanel } from './buildings-real.js';
import { texRequested } from './facade-lod.js';
import { createSlicer } from './yield-frame.js';

// js/buildings-stream.js
// The buildings of the streamed city: one buildRealBuildings() instance per tile (its own quadtree cells, photo manager and
// geometries), sharing one set of materials, behind the same interface the district build has (update / pick / attach /
// showBuilding / stats / byId / texManager), so main.js and the headless checks do not know the difference.
// A near tile builds with facade photos and entrance doors; a mid tile (buildings only) without them. A tile that moves between
// the two is rebuilt. removeTile() disposes the geometries and the photo textures; the materials live as long as the layer.

export function createBuildingsLayer(scene, { terrain = null, lod2 = null, observed = true, tex = texRequested() } = {}) {
  const root = new THREE.Group();
  root.name = 'CopenhagenBuildings';
  scene.add(root);
  const shared = createBuildingMaterials();
  const tiles = new Map(); // id -> { instance, ring, token }
  let camera = null;
  let pinned = null;
  let panel = null;
  const owner = new Map(); // building id -> tile id (for the panel)

  const totals = () => {
    const t = { buildings: 0, cells: 0, triangles: 0, doors: 0, lod2: 0, meshes: 0, tiles: tiles.size, heroes: [] };
    const neon = { panels: 0 };
    let candidates = 0;
    for (const { instance } of tiles.values()) {
      const s = instance.stats;
      for (const k of ['buildings', 'cells', 'triangles', 'doors', 'lod2', 'meshes']) t[k] += s[k] || 0;
      t.heroes.push(...(s.heroes || []));
      neon.panels += s.neon?.panels || 0;
      candidates += s.tex?.candidates || 0;
    }
    return { ...t, neon, tex: tex ? { candidates } : null };
  };

  const api = {
    group: root,
    /**
     * @param {string} id tile id
     * @param {object} ctx tileContext (js/tile-data.js)
     * @param {'near'|'mid'} ring
     */
    async addTile(id, ctx, ring) {
      this.removeTile(id);
      const token = {};
      tiles.set(id, { instance: null, ring, token });
      const near = ring === 'near';
      const holder = new THREE.Group();
      holder.name = `buildings-${id}`;
      const instance = await buildRealBuildings(holder, ctx.buildingGeo, {
        lod2, shared, terrain: terrain?.flat ? null : terrain, observed, withInfoPanel: false, slice: createSlicer(8),
        context: { buildings: ctx.geo.buildings, roads: ctx.geo.roads },
        tex: near ? tex : false, doors: near,
        ...(near ? { entrances: ctx.entrances, venues: ctx.venues } : { entrances: null, venues: [] })
      });
      const current = tiles.get(id);
      if (!current || current.token !== token) { instance.dispose(); return false; } // removed while it was building
      current.instance = instance;
      root.add(holder);
      current.holder = holder;
      for (const bid of instance.byId.keys()) owner.set(bid, id);
      if (camera) instance.setCamera(camera);
      return true;
    },

    removeTile(id) {
      const t = tiles.get(id);
      if (!t) return false;
      tiles.delete(id);
      if (t.instance) {
        for (const bid of t.instance.byId.keys()) if (owner.get(bid) === id) owner.delete(bid);
        t.instance.dispose();
      }
      t.holder?.removeFromParent();
      return true;
    },

    has: (id) => !!tiles.get(id)?.instance,
    ringOf: (id) => tiles.get(id)?.ring ?? null,
    ids: () => [...tiles.keys()].filter((id) => tiles.get(id).instance),

    update(x, z, night = 0) {
      for (const { instance } of tiles.values()) instance?.update(x, z, night);
    },

    /** Nearest building under a normalised-device point over all tiles. */
    pick(ndcX, ndcY, cam = camera) {
      let best = null;
      for (const { instance } of tiles.values()) {
        const hit = instance?.pick(ndcX, ndcY, cam);
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    },

    showBuilding(id, isPinned = false, hit = null) {
      const t = tiles.get(owner.get(id));
      if (!t?.instance || !panel) return null;
      const info = t.instance.infoFor(id, hit);
      if (info) panel.show(info, isPinned);
      return info;
    },

    attach({ camera: cam, domElement }) {
      camera = cam;
      for (const { instance } of tiles.values()) instance?.setCamera(cam);
      if (typeof document === 'undefined' || !domElement) return;
      panel = createInfoPanel();
      let last = 0;
      let down = null;
      const toNdc = (e) => {
        const r = domElement.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
      };
      domElement.addEventListener('pointermove', (e) => {
        if (pinned || e.buttons) return;
        const now = performance.now();
        if (now - last < 80) return;
        last = now;
        const hit = api.pick(...toNdc(e));
        if (hit) api.showBuilding(hit.id, false, hit); else panel.hide();
      });
      domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
      domElement.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
        const hit = api.pick(...toNdc(e));
        if (hit && hit.id !== pinned) { pinned = hit.id; api.showBuilding(hit.id, true, hit); } else { pinned = null; if (!hit) panel.hide(); }
      });
    },

    get stats() { return totals(); },
    get heroGroups() { return [...tiles.values()].flatMap((t) => t.instance?.heroGroups || []); },
    get heroStatus() { return [...tiles.values()].flatMap((t) => t.instance?.heroStatus || []); },
    /** Every building of the resident tiles by id (a Map-like view). */
    byId: {
      get: (id) => tiles.get(owner.get(id))?.instance?.byId.get(id),
      has: (id) => owner.has(id),
      get size() { return owner.size; }
    },
    /** The photo managers of all tiles as one (counts only: the headless checks read `state`). */
    get texManager() {
      if (!tex) return null;
      const sum = (f) => [...tiles.values()].reduce((n, t) => n + (f(t.instance?.texManager?.state) || 0), 0);
      return {
        state: {
          enabled: [...tiles.values()].some((t) => t.instance?.texManager?.state.enabled),
          resident: { size: sum((s) => s?.resident.size) },
          loaded: sum((s) => s?.loaded), look: sum((s) => s?.look), raw: sum((s) => s?.raw), failed: { size: sum((s) => s?.failed.size) }
        }
      };
    },
    dispose() {
      for (const id of [...tiles.keys()]) api.removeTile(id);
      root.removeFromParent();
      for (const m of Object.values(shared)) m.dispose();
    }
  };
  return api;
}
