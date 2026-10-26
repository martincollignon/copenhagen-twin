import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { farTileArrays, farGroundArrays, farWaterArrays, FAR_COLORS } from './far-lod-geometry.js';
import { disposeTree } from './dispose-tree.js';

// js/far-lod.js
// The far ring (docs/citywide-plan.md, C5): everything beyond the tiles the streamer keeps resident. One compact citywide layer
// (data/city/far.bin + far.json, tools/cph-geodata/far_lod.py) is loaded once; per tile it becomes two cheap meshes (merged
// prisms for the buildings, a 16 x 16 ground grid) built when the tile comes within `range` of the camera and hidden while the
// tile is resident near or mid. Beside them: the city's water polygons (lakes, ponds, the harbour) at their levels and one sea
// plane out to the horizon.
//
// The far materials are plain vertex-coloured standard materials (no shadows, no facade shader, no textures); a tile build is a
// few ms (farTileArrays) and one per frame at most, nearest first.

const FAR_RANGE = 9000; // tiles beyond this are not built (the city is 18 km across: the horizon is fogged anyway)
const SEA_SIZE = 90000;

function toGeometry(a) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  if (a.normal) g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 4, true));
  if (a.color) g.setAttribute('color', new THREE.BufferAttribute(a.color, 4, true));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  return g;
}

function farMaterial(name, { roughness = 0.94 } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
  m.name = name;
  m.colorNode = attribute('color', 'vec4').xyz.pow(2.2); // sRGB bytes
  return m;
}

/**
 * @param {THREE.Scene} scene
 * @param {object} o
 *   header   far.json (tile table, water, sea level)
 *   buffer   far.bin
 *   bounds   Map tileId -> local bounds [xmin, zmin, xmax, zmax]
 *   isResident  (id) => the streamer has the tile built (near or mid): its far mesh is hidden
 *   skipWater   Set of lake ids another layer draws (the lake machinery of the district)
 *   range    metres around the camera to keep far tiles for
 */
export function createFarLayer(scene, { header, buffer, bounds, isResident = () => false, skipWater = new Set(), range = FAR_RANGE, water = true } = {}) {
  const group = new THREE.Group();
  group.name = 'CopenhagenFar';
  scene.add(group);
  const sea = header.sea ?? -6.84;
  const buildingMaterial = farMaterial('far-buildings');
  const groundMaterial = farMaterial('far-ground', { roughness: 1 });
  const tiles = new Map(); // id -> { ground, buildings, distance }
  const stats = { tiles: 0, visible: 0, triangles: 0, buildMs: 0, maxBuildMs: 0, builds: 0, bytes: buffer.byteLength, water: 0 };
  let lastRun = -Infinity;
  const ids = Object.keys(header.tiles).filter((id) => bounds.has(id));

  // Pipelines for the two materials are compiled behind the loading screen (main.js precompileShaders walks the scene): a tile built
  // later, with the camera already flying, must not stall on a shader compile.
  const warm = (material, name) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -2000, 0, 0.01, -2000, 0, 0, -2000, 0.01]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]), 4, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(12).fill(128), 4, true));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const m = new THREE.Mesh(g, material);
    m.name = `far-warm-${name}`;
    m.frustumCulled = false;
    group.add(m);
  };
  warm(buildingMaterial, 'buildings');
  warm(groundMaterial, 'ground');

  // water: the polygons of the city's lakes and the harbour, and the sea out to the horizon
  let waterMesh = null;
  let seaMesh = null;
  const waterMaterial = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(FAR_COLORS.water[0] / 255, FAR_COLORS.water[1] / 255, FAR_COLORS.water[2] / 255).convertSRGBToLinear(), roughness: 0.16, metalness: 0 });
  waterMaterial.name = 'far-water';
  if (water) {
    const polys = (header.water || []).filter((w) => !skipWater.has(w.id));
    const wa = farWaterArrays(polys);
    if (wa.index.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(wa.position, 3));
      g.setIndex(new THREE.BufferAttribute(wa.index, 1));
      g.computeVertexNormals();
      // the level is per polygon (y of its vertices); normals face up whatever the winding says
      const n = g.attributes.normal;
      for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
      waterMesh = new THREE.Mesh(g, waterMaterial);
      waterMesh.name = 'far-water';
      waterMesh.frustumCulled = false;
      waterMesh.raycast = () => {};
      group.add(waterMesh);
      stats.water = polys.length;
    }
    const sg = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE).rotateX(-Math.PI / 2);
    seaMesh = new THREE.Mesh(sg, waterMaterial);
    seaMesh.position.y = sea - 0.1;
    seaMesh.name = 'far-sea';
    seaMesh.frustumCulled = false;
    seaMesh.raycast = () => {};
    group.add(seaMesh);
  }

  function buildTile(id) {
    const t0 = performance.now();
    const entry = header.tiles[id];
    const b = bounds.get(id);
    const holder = new THREE.Group();
    holder.name = `far-${id}`;
    holder.position.set(b[0], 0, b[1]);
    const ga = farGroundArrays(buffer, entry.off, b, sea);
    const ground = new THREE.Mesh(toGeometry(ga), groundMaterial);
    ground.position.y = -0.9; // under the resident ground at the tile's edge, so no crack opens between the two
    ground.name = 'far-ground';
    holder.add(ground);
    let tri = ga.index.length / 3;
    let buildings = null;
    if (entry.n > 0) {
      const ba = farTileArrays(buffer, entry.off, entry.len);
      if (ba.index.length) {
        buildings = new THREE.Mesh(toGeometry(ba), buildingMaterial);
        buildings.name = 'far-buildings';
        holder.add(buildings);
        tri += ba.triangles;
      }
    }
    group.add(holder);
    const ms = performance.now() - t0;
    stats.buildMs += ms;
    stats.maxBuildMs = Math.max(stats.maxBuildMs, ms);
    stats.builds++;
    stats.triangles += tri;
    return { holder, triangles: tri };
  }

  function removeTile(id) {
    const t = tiles.get(id);
    if (!t) return;
    stats.triangles -= t.triangles;
    disposeTree(t.holder);
    tiles.delete(id);
  }

  // the wanted tiles, nearest first: re-planned every 200 ms, built within a few ms per frame
  let queue = [];
  function plan(x, z) {
    const want = [];
    for (const id of ids) {
      const b = bounds.get(id);
      const d = Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]));
      if (d <= range) want.push([d, id]);
      else if (tiles.has(id) && d > range * 1.15) removeTile(id);
    }
    want.sort((p, q) => p[0] - q[0]);
    queue = want.map((w) => w[1]);
  }

  return {
    group,
    stats,
    /**
     * Called every frame with the camera position (local frame). Plans every 200 ms; builds queued tiles for at most `budgetMs` per
     * call (one tile at least), skipping the resident ones; shows a far tile only while its tile is not resident.
     */
    update(x, z, { budgetMs = 4, now = performance.now() } = {}) {
      if (now - lastRun >= 200) { lastRun = now; plan(x, z); }
      const t0 = performance.now();
      let built = 0;
      for (const id of queue) {
        if (tiles.has(id) || isResident(id)) continue;
        tiles.set(id, buildTile(id));
        built++;
        if (performance.now() - t0 >= budgetMs) break;
      }
      let visible = 0;
      for (const [id, t] of tiles) {
        const resident = isResident(id);
        t.holder.visible = !resident;
        if (!resident) visible++;
      }
      stats.tiles = tiles.size;
      stats.visible = visible;
      return built;
    },
    /** Builds the `max` nearest wanted tiles at once (the boot, tests). */
    flush(x, z, max = Infinity) {
      plan(x, z);
      let n = 0;
      for (const id of queue) {
        if (n >= max) break;
        if (tiles.has(id) || isResident(id)) continue;
        tiles.set(id, buildTile(id));
        n++;
      }
      return n;
    },
    has: (id) => tiles.has(id),
    dispose() {
      for (const id of [...tiles.keys()]) removeTile(id);
      disposeTree(group, { materials: true });
    }
  };
}

/** Loads the far layer a store's post-process manifest names; null when there is none. */
export async function loadFarLayer(scene, store, opts = {}) {
  const far = store?.post?.far;
  if (!far) return null;
  try {
    const [header, buffer] = await Promise.all([store.fetchCityJson(far.header), store.fetchCityBin(far.bin)]);
    if (!header?.version?.startsWith('cph-far/')) return null;
    const bounds = new Map(store.ids.map((id) => [id, store.index.tiles[id].local]));
    return createFarLayer(scene, { header, buffer, bounds, ...opts });
  } catch (error) {
    console.info('[cph] no far layer:', error?.message || error);
    return null;
  }
}
