import * as THREE from 'three/webgpu';
import { uniform, NodeUpdateType } from 'three/tsl';
import { createWaterMaterial, createLakeWallMaterial, patchPlanarReflector, toGeometry } from './water-cph.js';
import { applyGroundWindow } from './ground-shader-cph.js';
import { buildTileWaterArrays, shoreWindow, groundWindow, windowOrigin } from './water-tiles-cph.js';
import { tileBoundsLocal } from './tile-grid.js';
import { disposeTree } from './dispose-tree.js';

// js/water-stream.js
// The generic water of the streamed city (milestone C4): every harbour basin, canal, lake and pond that is not one of the Soerne. The `water`
// layer of a tile (data/tiles/<id>/water.json, tools/cph-geodata/city_water.py, js/water-tiles-cph.js) becomes one water-surface mesh and one
// shore-wall mesh (granite quay + coping, or a grassed bank) per tile, built with the tile and removed with it, all sharing ONE water material and
// ONE wall material. The ground is cut open under the water by the ground layer (js/ground-stream.js reads the same payload).
//
// Shore field and ground raster follow the camera: the water shader's soft shoreline and the ground shader's grass / lake path read 1024 x 1024
// window rasters (js/water-tiles-cph.js) re-made when the camera has moved 384 m or a tile came or went. The shoreline field is rasterised from the
// far-ring water pieces of the city header (`water.far`, every tile, always available), the green mask from the resident tiles' `green` polygons.
//
// Reflections: ONE planar reflector for all generic water, at the level of the water nearest to the camera (every other level reflects the sky
// instead, see createWaterMaterial `window`); it only runs when water of this layer is within PLANAR_RANGE m of a camera below PLANAR_CEILING m,
// `?water=simple` never. The Soerne (js/water-cph.js buildLakes) have their own reflector; the world arbitrates (one at a time).

const WINDOW_N = 1024;
const WINDOW_CELL = 1.5;
const WINDOW_SIZE = WINDOW_N * WINDOW_CELL; // 1536 m
const MOVE_REBUILD = 384; // m the camera may move from the window centre before the rasters are made again
const REBUILD_INTERVAL = 350; // ms: tiles streaming in make the rasters dirty; this debounces them
export const PLANAR_RANGE = 260;
export const PLANAR_CEILING = 220;

/**
 * @param {THREE.Scene} scene
 * @param {object} o
 *   header          data/city/water.json (far pieces per tile, sea level)
 *   groundMaterial  the shared ground material (gets the window grass / path shader)
 *   lakeRings       flat rings of the hand-made lakes (the Soerne's gravel path)
 *   planar          false for `?water=simple`
 *   hideDuringReflection  () => Object3D[] meshes to hide while the reflection is rendered (the Soerne's walls)
 */
export function createWaterLayer(scene, { header, groundMaterial, lakeRings = [], planar = true, hideDuringReflection = () => [] } = {}) {
  const group = new THREE.Group();
  group.name = 'CopenhagenStreamWater';
  scene.add(group);
  const wallsRoot = new THREE.Group();
  wallsRoot.name = 'stream-water-walls';
  group.add(wallsRoot);
  const sea = header?.sea ?? -6.84;

  // window rasters
  const origin = uniform(new THREE.Vector2(-1e6, -1e6));
  const sizeU = uniform(WINDOW_SIZE);
  const reflLevel = uniform(sea);
  const reflOn = uniform(0);
  const sdfTex = new THREE.DataTexture(new Uint8Array(WINDOW_N * WINDOW_N), WINDOW_N, WINDOW_N, THREE.RedFormat, THREE.UnsignedByteType);
  sdfTex.magFilter = sdfTex.minFilter = THREE.LinearFilter;
  sdfTex.wrapS = sdfTex.wrapT = THREE.ClampToEdgeWrapping;
  sdfTex.generateMipmaps = false;
  sdfTex.needsUpdate = true;
  const { material, reflectorNode } = createWaterMaterial({
    sdf: sdfTex, planar: planar ? { resolutionScale: 0.35 } : null, level: sea,
    window: { origin, size: sizeU, reflLevel, reflOn }
  });
  material.name = 'cph-water-stream';
  const wallMaterial = createLakeWallMaterial();
  wallMaterial.name = 'cph-water-stream-wall';
  const groundWin = groundMaterial ? applyGroundWindow(groundMaterial, { n: WINDOW_N, size: WINDOW_SIZE }) : null;
  if (reflectorNode) {
    group.add(reflectorNode.target);
    patchPlanarReflector(reflectorNode, scene, () => [wallsRoot, ...hideDuringReflection()]);
  }

  // the far-ring pieces per tile: [tile id, bounds, pieces]
  const farTiles = Object.entries(header?.far || {}).map(([id, pieces]) => ({ id, b: tileBoundsLocal(id), pieces }));

  const tiles = new Map(); // id -> { holder, surface, walls, pts, level, green, triangles }
  // (the reflector starts enabled, like the Soerne's: a render target that is not updated before its first use can be destroyed by the warm-up resize; the
  // first update() switches it off until water is near)
  const stats = { tiles: 0, triangles: 0, wallTriangles: 0, builds: 0, buildMs: 0, maxBuildMs: 0, windowBuilds: 0, windowMs: 0, planar: !!reflectorNode };
  let dirty = true;
  let win = { x: -1e9, z: -1e9 };
  let staged = null; // the second half of a window rebuild (the ground raster), done in the next update() so one frame never pays for both
  const touchesWindow = (id) => {
    const b = tileBoundsLocal(id);
    return !(b[2] < win.x - WINDOW_SIZE / 2 || b[0] > win.x + WINDOW_SIZE / 2 || b[3] < win.z - WINDOW_SIZE / 2 || b[1] > win.z + WINDOW_SIZE / 2);
  };
  let lastBuild = -Infinity;
  let camera = null;
  let wantPlanar = true;

  function addTile(ctx) {
    const payload = ctx.water;
    if (!payload) return;
    const t0 = performance.now();
    const arrays = buildTileWaterArrays(payload);
    const holder = new THREE.Group();
    holder.name = `water-${ctx.id}`;
    let surface = null;
    let walls = null;
    if (arrays.surface.index.length) {
      surface = new THREE.Mesh(toGeometry(arrays.surface), material);
      surface.name = 'stream-water';
      surface.receiveShadow = true;
      surface.raycast = () => {};
      holder.add(surface);
    }
    group.add(holder);
    if (arrays.walls.index.length) {
      walls = new THREE.Mesh(toGeometry(arrays.walls, { uv: true, kind: true }), wallMaterial);
      walls.name = 'stream-water-walls';
      walls.receiveShadow = walls.castShadow = true;
      wallsRoot.add(walls);
    }
    // every 4th shore vertex: the distance to the nearest water and its level, for the reflection arbiter
    const pts = [];
    for (const body of payload.bodies || []) {
      if (body.pond) continue;
      for (const poly of body.polys || []) for (let i = 0; i < poly.ring.length; i += 8) pts.push(poly.ring[i], poly.ring[i + 1], body.level);
    }
    const green = [];
    for (const g of payload.green || []) green.push(g.ring, ...(g.holes || []));
    const rec = { holder, surface, walls, pts, green, triangles: arrays.stats.triangles + arrays.stats.wallTriangles };
    tiles.set(ctx.id, rec);
    stats.tiles = tiles.size;
    stats.triangles += rec.triangles;
    stats.builds++;
    const ms = performance.now() - t0;
    stats.buildMs += ms;
    stats.maxBuildMs = Math.max(stats.maxBuildMs, ms);
    if (green.length && touchesWindow(ctx.id)) dirty = true;
  }

  function removeTile(id) {
    const rec = tiles.get(id);
    if (!rec) return;
    disposeTree(rec.holder);
    if (rec.walls) disposeTree(rec.walls);
    stats.triangles -= rec.triangles;
    tiles.delete(id);
    stats.tiles = tiles.size;
    if (rec.green.length && touchesWindow(id)) dirty = true;
  }

  /** Stage 1: the shore field of the water shader. Stage 2 (next call): the ground raster (grass, lake path). */
  function rebuildWindow(x, z) {
    const t0 = performance.now();
    const [x0, z0] = windowOrigin(x, z, WINDOW_SIZE, 32);
    const x1 = x0 + WINDOW_SIZE;
    const z1 = z0 + WINDOW_SIZE;
    // water polygons: the far-ring pieces of every tile the window touches
    const waterRings = [];
    for (const t of farTiles) {
      if (t.b[2] < x0 || t.b[0] > x1 || t.b[3] < z0 || t.b[1] > z1) continue;
      for (const pc of t.pieces) for (const q of pc.p) waterRings.push(q.ring, ...(q.holes || []));
    }
    const sh = shoreWindow(waterRings, { x0, z0, cell: WINDOW_CELL, n: WINDOW_N });
    sdfTex.image.data.set(sh.data);
    sdfTex.needsUpdate = true;
    origin.value.set(x0, z0);
    sizeU.value = WINDOW_SIZE;
    win = { x: x0 + WINDOW_SIZE / 2, z: z0 + WINDOW_SIZE / 2 };
    dirty = false;
    staged = groundWin ? { x0, z0, waterRings } : null;
    stats.windowBuilds++;
    stats.windowMs = performance.now() - t0;
  }

  function stageGround() {
    const t0 = performance.now();
    const { x0, z0, waterRings } = staged;
    staged = null;
    const greenRings = [];
    for (const rec of tiles.values()) for (const r of rec.green) greenRings.push(r);
    const gw = groundWindow({ lakeRings, greenRings, waterRings }, { x0, z0, cell: WINDOW_CELL, n: WINDOW_N });
    groundWin.update(x0, z0, gw.data, WINDOW_SIZE);
    stats.windowMs += performance.now() - t0;
  }

  /** Distance (m) from (x, z) to the nearest resident generic water vertex, and that water's level; Infinity when none. */
  function nearest(x, z) {
    let best = Infinity;
    let level = sea;
    for (const rec of tiles.values()) {
      const p = rec.pts;
      for (let i = 0; i < p.length; i += 3) {
        const d = Math.hypot(p[i] - x, p[i + 1] - z);
        if (d < best) { best = d; level = p[i + 2]; }
      }
    }
    return { distance: best, level };
  }

  const setPlanar = (on) => {
    if (!reflectorNode || stats.planar === on) return;
    stats.planar = on;
    reflOn.value = on ? 1 : 0;
    reflectorNode.reflector.updateBeforeType = on ? NodeUpdateType.FRAME : NodeUpdateType.NONE;
  };

  let lastNear = { distance: Infinity, level: sea };
  let lastNearAt = -Infinity;

  return {
    group, material, wallMaterial, stats, tiles,
    layer: { name: 'water', rings: ['near', 'mid'], add: (ctx) => addTile(ctx), remove: (id) => removeTile(id) },
    attach: ({ camera: cam }) => { camera = cam; },
    /** Distance and level of the nearest generic water (cached 250 ms). */
    nearest(x, z, now = performance.now()) {
      if (now - lastNearAt > 250) { lastNear = nearest(x, z); lastNearAt = now; }
      return lastNear;
    },
    setPlanar,
    /** `allow` false: another reflector owns the frame (the world arbitrates between the Soerne and this layer). */
    update(x, z, { now = performance.now(), allow = true } = {}) {
      if (staged) stageGround();
      else if (dirty && now - lastBuild > REBUILD_INTERVAL && tiles.size) { lastBuild = now; rebuildWindow(x, z); }
      else if (Math.hypot(x - win.x, z - win.z) > MOVE_REBUILD && now - lastBuild > REBUILD_INTERVAL) { lastBuild = now; rebuildWindow(x, z); }
      if (!reflectorNode) return;
      const n = this.nearest(x, z, now);
      const camY = camera ? camera.position.y : 0;
      const on = allow && wantPlanar && n.distance < PLANAR_RANGE && camY < PLANAR_CEILING && camY > n.level + 0.2;
      if (on) {
        reflLevel.value = n.level;
        reflectorNode.target.position.y = n.level;
      }
      setPlanar(on);
    },
    /** Rebuilds the window rasters now (boot, tests). */
    flush(x, z) { rebuildWindow(x, z); if (staged) stageGround(); lastBuild = performance.now(); },
    /** `?water=simple` style switch at run time. */
    allowPlanar(on) { wantPlanar = on; },
    dispose() { for (const id of [...tiles.keys()]) removeTile(id); disposeTree(group, { materials: false }); }
  };
}
