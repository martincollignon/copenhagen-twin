import * as THREE from 'three/webgpu';
import { buildRealBuildings, createBuildingMaterials, createInfoPanel } from './buildings-real.js';
import { texRequested, createPhotoBudget } from './facade-lod.js';
import { createSharedSlicer } from './yield-frame.js';
import { createOverrideBudget, createOverrideBudgetLease, overridesMode } from './detail-overrides.js';

// js/buildings-stream.js
// The buildings of the streamed city: one buildRealBuildings() instance per tile (its own quadtree cells, photo manager and
// geometries), sharing one set of materials, behind the same interface the district build has (update / pick / attach /
// showBuilding / stats / byId / texManager), so main.js and the headless checks do not know the difference.
// A near tile builds with facade photos and entrance doors; a mid tile (buildings only) without them. A tile that moves between
// the two is rebuilt. removeTile() disposes the geometries and the photo textures; the materials live as long as the layer.
// Detail overrides (js/detail-overrides.js): a near tile builds its `overrides` layer's meshes in place of the generated buildings they cover,
// within one texture budget over every tile (nearest first); a mid tile never loads them (the generated building with its measured tones),
// so the swap happens with the near / mid rebuild that already swaps the photo walls. A tile removed while its overrides load aborts them.

export function createBuildingsLayer(scene, { terrain = null, lod2 = null, observed = true, tex = texRequested(), pool = null, lite = true } = {}) {
  const root = new THREE.Group();
  root.name = 'CopenhagenBuildings';
  scene.add(root);
  const shared = createBuildingMaterials();
  const slice = createSharedSlicer(5);
  const photoBudget = tex ? createPhotoBudget() : null; // one residency plan for the photo walls of every tile
  const ovMode = overridesMode();
  const overrideBudget = ovMode === 'off' ? null : createOverrideBudget();
  const tiles = new Map(); // id -> { active: { instance, holder, ring, overrideLease } | null, pending: build | null }
  let pendingBuilds = 0;
  let disposed = false;
  let resourcesDisposed = false;
  let camera = null;
  let pinned = null;
  let panel = null;
  const owner = new Map(); // building id -> tile id (for the panel)

  const activeTiles = () => [...tiles.values()].filter((tile) => tile.active);
  const releaseLayerResources = () => {
    if (!disposed || pendingBuilds || resourcesDisposed) return;
    resourcesDisposed = true;
    for (const material of Object.values(shared)) material.dispose();
  };
  const removeOwners = (id, instance) => {
    for (const bid of instance?.byId.keys() || []) if (owner.get(bid) === id) owner.delete(bid);
  };
  const disposeActive = (id, active) => {
    if (!active) return;
    removeOwners(id, active.instance);
    active.instance.dispose();
    active.overrideLease?.releaseAll();
    active.holder.removeFromParent();
  };

  const totals = () => {
    const resident = activeTiles();
    const t = { buildings: 0, cells: 0, triangles: 0, doors: 0, lod2: 0, meshes: 0, tiles: resident.length, heroes: [] };
    const neon = { panels: 0 };
    const overrides = { mode: ovMode, shown: 0, failed: 0, refused: 0, details: 0, textureBytes: 0, errors: [], budget: overrideBudget?.memory() || null };
    let candidates = 0;
    for (const { active: { instance } } of resident) {
      const s = instance.stats;
      for (const k of ['buildings', 'cells', 'triangles', 'doors', 'lod2', 'meshes']) t[k] += s[k] || 0;
      for (const k of ['shown', 'failed', 'refused', 'details', 'textureBytes']) overrides[k] += s.overrides?.[k] || 0;
      overrides.errors.push(...(s.overrides?.errors || []));
      t.heroes.push(...(s.heroes || []));
      neon.panels += s.neon?.panels || 0;
      candidates += s.tex?.candidates || 0;
    }
    return { ...t, neon, overrides, tex: tex ? { candidates } : null };
  };

  const api = {
    group: root,
    /**
     * @param {string} id tile id
     * @param {object} ctx tileContext (js/tile-data.js)
     * @param {'near'|'mid'} ring
     */
    async addTile(id, ctx, ring) {
      if (disposed) return false;
      let state = tiles.get(id);
      if (!state) tiles.set(id, state = { active: null, pending: null });
      if (state.pending) state.pending.controller?.abort();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const pending = { ring, controller, overrideLease: overrideBudget ? createOverrideBudgetLease(overrideBudget) : null, transferred: false };
      state.pending = pending;
      const near = ring === 'near';
      const ovLayer = near && overrideBudget ? ctx.overrides : null;
      const holder = new THREE.Group();
      holder.name = `buildings-${id}`;
      pendingBuilds++;
      try {
        let instance;
        try {
          instance = await buildRealBuildings(holder, ctx.buildingGeo, {
            lod2, shared, terrain: terrain?.flat ? null : terrain, observed, withInfoPanel: false, slice, lite: lite && !near, photoBudget, compute: pool ? (job) => pool.run('buildings', job) : null,
            context: { buildings: ctx.geo.buildings, roads: ctx.geo.roads },
            tex: near ? tex : false, doors: near, signal: controller?.signal || null,
            overrides: ovLayer ? { layer: ovLayer, budget: pending.overrideLease, mode: ovMode, signal: controller?.signal || null, camera: () => (camera ? { x: camera.position.x, z: camera.position.z } : null) } : null,
            ...(near ? { entrances: ctx.entrances, venues: ctx.venues } : { entrances: null, venues: [] })
          });
        } catch (error) {
          const current = tiles.get(id);
          if (disposed || current !== state || state.pending !== pending || controller?.signal.aborted) return false;
          state.pending = null;
          if (!state.active) tiles.delete(id);
          throw error;
        }

        if (disposed || tiles.get(id) !== state || state.pending !== pending || controller?.signal.aborted) {
          instance.dispose();
          holder.removeFromParent();
          return false;
        }

        const old = state.active;
        root.add(holder);
        removeOwners(id, old?.instance);
        state.active = { instance, holder, ring, overrideLease: pending.overrideLease };
        pending.transferred = true;
        state.pending = null;
        for (const bid of instance.byId.keys()) owner.set(bid, id);
        if (camera) instance.setCamera(camera);
        if (old) {
          old.instance.dispose();
          old.overrideLease?.releaseAll();
          old.holder.removeFromParent();
        }
        return true;
      } finally {
        if (!pending.transferred) pending.overrideLease?.releaseAll();
        pendingBuilds--;
        releaseLayerResources();
      }
    },

    removeTile(id) {
      const state = tiles.get(id);
      if (!state) return false;
      tiles.delete(id);
      state.pending?.controller?.abort(); // abort superseded and removed builds, including their override loads
      state.pending = null;
      disposeActive(id, state.active);
      return true;
    },

    has: (id) => !!tiles.get(id)?.active,
    ringOf: (id) => tiles.get(id)?.active?.ring ?? null,
    ids: () => [...tiles.entries()].filter(([, state]) => state.active).map(([id]) => id),

    update(x, z, night = 0) {
      for (const { active } of tiles.values()) active?.instance.update(x, z, night);
      photoBudget?.update(camera ? camera.position.x : x, camera ? camera.position.z : z, performance.now(), camera?.position.y);
    },

    /** Nearest building under a normalised-device point over all tiles. */
    pick(ndcX, ndcY, cam = camera) {
      let best = null;
      for (const { active } of tiles.values()) {
        const instance = active?.instance;
        const hit = instance?.pick(ndcX, ndcY, cam);
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    },

    showBuilding(id, isPinned = false, hit = null) {
      const active = tiles.get(owner.get(id))?.active;
      if (!active || !panel) return null;
      const info = active.instance.infoFor(id, hit);
      if (info) panel.show(info, isPinned);
      return info;
    },

    attach({ camera: cam, domElement }) {
      camera = cam;
      for (const { active } of tiles.values()) active?.instance.setCamera(cam);
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
    get photoBudget() { return photoBudget; },
    get heroGroups() { return activeTiles().flatMap(({ active }) => active.instance.heroGroups || []); },
    get heroStatus() { return activeTiles().flatMap(({ active }) => active.instance.heroStatus || []); },
    /** The override meshes shown in the resident tiles (js/detail-overrides.js), and their texture budget. */
    get overrideGroups() { return activeTiles().flatMap(({ active }) => active.instance.overrideGroups || []); },
    get overrideBudget() { return overrideBudget; },
    overrideIds: () => activeTiles().flatMap(({ active }) => active.instance.overrideIds?.() || []),
    /** Every building of the resident tiles by id (a Map-like view). */
    byId: {
      get: (id) => tiles.get(owner.get(id))?.active?.instance.byId.get(id),
      has: (id) => owner.has(id),
      get size() { return owner.size; }
    },
    /** The photo managers of all tiles as one (counts only: the headless checks read `state`). */
    get texManager() {
      if (!tex) return null;
      const sum = (f) => activeTiles().reduce((n, { active }) => n + (f(active.instance?.texManager?.state) || 0), 0);
      return {
        state: {
          enabled: activeTiles().some(({ active }) => active.instance?.texManager?.state.enabled),
          resident: { size: sum((s) => s?.resident.size) },
          loaded: sum((s) => s?.loaded), look: sum((s) => s?.look), raw: sum((s) => s?.raw), failed: { size: sum((s) => s?.failed.size) }
        },
        /** The shared budget's texture estimate over every tile (the same snapshot a district manager reports). */
        get memory() { return photoBudget.memory(); }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, state] of tiles) {
        state.pending?.controller?.abort();
        state.pending = null;
        disposeActive(id, state.active);
      }
      tiles.clear();
      root.removeFromParent();
      releaseLayerResources();
    }
  };
  return api;
}
