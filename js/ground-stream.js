import * as THREE from 'three/webgpu';
import { buildTerrainMeshArrays, buildTileGroundArrays, cutTouchesRegion, TERRAIN_MESH_DROP } from './terrain-cph.js';
import { getDataBbox } from './city-config.js';
import { disposeTree } from './dispose-tree.js';

// js/ground-stream.js
// The ground of the streamed city. The district's ground mesh (a 4 m grid cut open over the lakes, plus the frame polygon out
// to the horizon, js/terrain-cph.js buildTerrainMeshArrays) is cut into tiles: a tile mesh holds the grid cells whose centre lies
// in the tile (neighbouring tiles share their edge nodes, so there is no crack), 4 m cells in the near ring and where the lakes
// cut, 8 m cells in the mid ring. The frame polygon is built once. A tile of the index that is not resident gets a flat quad at
// the datum, so the ground outside the loaded rings stays sane (it also hides the lakes there: water is a global layer for now).
//
// `generic` (a citywide index, which reaches far beyond the district the cut grid was made for): every tile is meshed on the same
// lattice over its OWN bounds (cells outside the cut area are plain ground), there is no frame polygon and no datum stand-ins:
// the tiles that are not resident are the far layer's (js/far-lod.js).

export function createGroundLayer(scene, { terrain, material, size = 8000, tileBounds = new Map(), cut = terrain.doc?.cut, generic = false } = {}) {
  const group = new THREE.Group();
  group.name = 'CopenhagenGround';
  scene.add(group);
  const half = cut?.half ?? getDataBbox()[2];
  const area = [-half, -half, half, half];
  const tiles = new Map();
  const fallbacks = new Map();

  const toMesh = (a, name) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
    g.setIndex(new THREE.BufferAttribute(a.index, 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    g.computeBoundingSphere();
    return mesh;
  };

  // the frame: everything outside the compiled area, with the lake corridors left open
  const frame = generic ? null : toMesh(buildTerrainMeshArrays(terrain, { cut, frameOnly: true, uvSize: size }), 'ground-frame');
  if (frame) {
    frame.frustumCulled = false;
    group.add(frame);
  }

  // flat stand-ins for the tiles of the compiled area that are not resident
  for (const [id, b] of generic ? [] : tileBounds) {
    const x0 = Math.max(b[0], area[0]); const z0 = Math.max(b[1], area[1]);
    const x1 = Math.min(b[2], area[2]); const z1 = Math.min(b[3], area[3]);
    if (x1 <= x0 || z1 <= z0) continue;
    const y = -TERRAIN_MESH_DROP;
    const position = new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]);
    const quad = toMesh({
      position, normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uv: new Float32Array([x0, z0, x1, z0, x1, z1, x0, z1].map((v, i) => (i % 2 ? (size / 2 - v) / size : (v + size / 2) / size))),
      index: new Uint32Array([0, 2, 1, 0, 3, 2])
    }, `ground-datum-${id}`);
    group.add(quad);
    fallbacks.set(id, quad);
  }

  return {
    group,
    frame,
    stats: { tiles: 0, triangles: 0 },
    /** Builds (or rebuilds at the new fidelity) the ground of a tile. */
    addTile(id, bounds, { near = true, tileCut = null } = {}) {
      this.removeTile(id);
      if (generic) {
        // `tileCut`: the water cut of this tile (the `water` layer, tools/cph-geodata/city_water.py): meshed at the fine lattice
        const mesh = toMesh(buildTileGroundArrays(terrain, { cut, tileCut, region: bounds, step: near || tileCut || cutTouchesRegion(cut, bounds) ? 1 : 2, uvSize: size }), `ground-${id}`);
        group.add(mesh);
        tiles.set(id, mesh);
        this.stats.tiles = tiles.size;
        this.stats.triangles += mesh.geometry.index.count / 3;
        return;
      }
      const region = [Math.max(bounds[0], area[0]), Math.max(bounds[1], area[1]), Math.min(bounds[2], area[2]), Math.min(bounds[3], area[3])];
      if (region[2] <= region[0] || region[3] <= region[1]) return;
      const step = near || cutTouchesRegion(cut, region) ? 1 : 2;
      const mesh = toMesh(buildTerrainMeshArrays(terrain, { cut, region, step, uvSize: size }), `ground-${id}`);
      group.add(mesh);
      tiles.set(id, mesh);
      const fb = fallbacks.get(id);
      if (fb) fb.visible = false;
      this.stats.tiles = tiles.size;
      this.stats.triangles += mesh.geometry.index.count / 3;
    },
    removeTile(id) {
      const mesh = tiles.get(id);
      if (!mesh) return false;
      this.stats.triangles -= mesh.geometry.index.count / 3;
      disposeTree(mesh);
      tiles.delete(id);
      const fb = fallbacks.get(id);
      if (fb) fb.visible = true;
      this.stats.tiles = tiles.size;
      return true;
    },
    has: (id) => tiles.has(id)
  };
}
