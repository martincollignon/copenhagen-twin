import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Quadtree } from './quadtree.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial } from './tsl-materials.js';
import { createAccumulator, addBuilding } from './building-geometry.js';
import { CPH_FRAME, toLocal } from './city-config.js';

// js/buildings-real.js
// Copenhagen's real buildings (M2): every geodata building is extruded from its measured footprint (rings with holes)
// to its eave, walls carrying the per-vertex facade frame the wallAttr facade shaders read, merged into one mesh per
// quadtree cell. Hero buildings (docs/cph-geodata-schema.md `heroes`) load their glTF instead and skip the extrusion.
// Picking maps a ray hit back to its building through the index ranges recorded per mesh.

const HEROES_DIR = './data/heroes';
const STREAM_RADIUS = 2400; // cells further than this from the camera are hidden (the district is 1.5 km across)
const LEAF_CAPACITY = 48;
const LEAF_DEPTH = 5;

function toBufferGeometry(wall) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(wall.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(wall.normal, 3));
  g.setAttribute('facadeUV', new THREE.Float32BufferAttribute(wall.facadeUV, 2));
  g.setAttribute('facadeWall', new THREE.Float32BufferAttribute(wall.facadeWall, 4));
  g.setAttribute('facadeBldg', new THREE.Float32BufferAttribute(wall.facadeBldg, 4));
  g.setAttribute('facadeTone', new THREE.Float32BufferAttribute(wall.facadeTone, 4));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(wall.index), 1));
  g.computeBoundingSphere();
  return g;
}

function roofGeometry(roof) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(roof.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(roof.normal, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(roof.color, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(roof.index), 1));
  g.computeBoundingSphere();
  return g;
}

function ringCentre(ring) {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / n, z / n];
}

function collectLeaves(node, out = []) {
  if (!node.divided) {
    if (node.items.length) out.push(node);
    return out;
  }
  for (const child of [node.nw, node.ne, node.sw, node.se]) collectLeaves(child, out);
  return out;
}

/** Index ranges -> building id for a triangle hit. `ranges` are sorted by `start`. */
function rangeAt(ranges, triangle) {
  const index = triangle * 3;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index < ranges[mid].start) hi = mid - 1;
    else if (index >= ranges[mid].end) lo = mid + 1;
    else return ranges[mid];
  }
  return null;
}

/** Merges every mesh of a glTF scene into one mesh per material (7 draw calls instead of 1476). */
function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(o.matrixWorld);
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!groups.has(material)) groups.set(material, []);
    groups.get(material).push(g);
  });
  const merged = new THREE.Group();
  for (const [material, geometries] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `hero-${material.name || 'material'}`;
    merged.add(mesh);
    geometries.forEach((g) => g.dispose());
  }
  return merged;
}

/** Loads one hero glb and places it in the Copenhagen frame from its building.json `frame.origin` (EPSG:25832 + DVR90). */
async function loadHero(hero, { fetchImpl = globalThis.fetch } = {}) {
  const dir = `${HEROES_DIR}/${String(hero.building_id).replace(/[^\w.-]+/g, '_')}`;
  let origin = null;
  try {
    const response = await fetchImpl(`${dir}/building.json`);
    if (response.ok) origin = (await response.json())?.frame?.origin ?? null;
  } catch { /* falls back to the glb's own extras below */ }
  const gltf = await new GLTFLoader().loadAsync(`${dir}/building.glb`);
  origin ??= gltf.asset?.extras?.origin ?? gltf.parser?.json?.asset?.extras?.origin;
  if (!origin) throw new Error(`hero ${hero.building_id}: no frame origin in building.json or the glb`);
  const local = toLocal(origin[0], origin[1], origin[2]);
  // The glTF is ENU, z up (x east, y north, z up) around its own origin: (x, y, z) -> three (x, z, -y), then translate.
  const inner = mergeByMaterial(gltf.scene);
  inner.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(inner);
  group.position.set(local.x, local.y, local.z);
  group.name = `Hero-${hero.building_id}`;
  group.userData.buildingId = hero.building_id;
  group.userData.hero = hero;
  return group;
}

function describeBuilding(b) {
  const metres = (v) => `${v.toFixed(1)} m`;
  const f = b.facade || {};
  const conf = b.conf_fields || {};
  return {
    id: b.id,
    bbr: b.bbr_id,
    use: b.use,
    year: b.year,
    storeys: b.storeys,
    height: Number.isFinite(b.eave) ? b.eave - b.ground : null,
    eave: b.eave,
    ridge: b.ridge,
    roof: b.roof,
    wallMaterial: b.wall_material,
    roofMaterial: b.roof_material,
    facade: f,
    conf: b.conf,
    confFields: conf,
    src: b.src,
    heightText: Number.isFinite(b.eave) ? `${metres(b.eave - b.ground)} to eave${b.ridge > b.eave + 0.3 ? `, ${metres(b.ridge - b.ground)} to ridge` : ''}` : 'unknown'
  };
}

/**
 * Info panel: hover shows a building, click pins it. Every inferred field is labelled as such, and the facade
 * defaults are flagged `inferred` unless the compiler marked them measured (NS37 heroes).
 */
function createInfoPanel() {
  const el = document.createElement('aside');
  el.id = 'building-info';
  el.setAttribute('aria-live', 'polite');
  el.style.cssText = [
    'position:fixed', 'left:16px', 'bottom:16px', 'z-index:20', 'width:300px', 'max-height:60vh', 'overflow:auto',
    'padding:12px 14px', 'border-radius:10px', 'background:rgba(18,20,22,0.82)', 'color:#e8e6e1', 'backdrop-filter:blur(8px)',
    'font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif', 'pointer-events:none', 'display:none',
    'font-variant-numeric:tabular-nums'
  ].join(';');
  document.body.appendChild(el);
  const tag = (text, kind) => `<span style="padding:0 5px;border-radius:4px;margin-left:6px;font-size:10px;letter-spacing:.04em;text-transform:uppercase;background:${kind === 'measured' ? '#2f6f4f' : kind === 'inferred' ? '#7a5a1c' : '#3b4a66'};color:#fff">${text}</span>`;
  const row = (label, value, conf) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0;border-top:1px solid rgba(255,255,255,0.07)"><span style="opacity:.65">${label}</span><span style="text-align:right">${value}${conf ? tag(conf, conf) : ''}</span></div>`;
  const e = (v) => (v === null || v === undefined || v === '' ? '<span style="opacity:.5">unknown</span>' : String(v).replace(/[<>&]/g, ''));
  return {
    element: el,
    show(info, pinned) {
      const c = info.confFields;
      const f = info.facade;
      el.innerHTML = [
        `<div style="font-weight:600;font-size:13px;margin-bottom:4px">${e(info.id)}${pinned ? tag('pinned', '') : ''}</div>`,
        row('BBR id', e(info.bbr)),
        row('Use code', e(info.use), c.use),
        row('Year', e(info.year), c.year),
        row('Storeys', e(info.storeys), c.storeys),
        row('Height', e(info.heightText), c.eave),
        row('Roof', `${e(info.roof)} / ${e(info.roofMaterial)}`, c.roof),
        row('Wall', e(info.wallMaterial), c.wall_material),
        row('Facade', `floor ${e(f.floor_h)} m, bay ${e(f.bay_w)} m, ${e(f.ground_type)}`, c.facade ?? 'inferred'),
        row('Record', e(info.conf)),
        `<div style="margin-top:6px;opacity:.55;font-size:10px;word-break:break-all">${e((info.src || []).join(', '))}</div>`
      ].join('');
      el.style.display = 'block';
    },
    hide() { el.style.display = 'none'; }
  };
}

async function buildRealBuildings(scene, geo, { heroLoader = loadHero, withInfoPanel = true } = {}) {
  const buildings = geo.buildings || [];
  const heroIds = new Set((geo.heroes || []).map((h) => h.building_id));
  const byId = new Map(buildings.map((b) => [b.id, b]));

  const root = new THREE.Group();
  root.name = 'CopenhagenBuildings';
  scene.add(root);

  const [x0, z0, x1, z1] = CPH_FRAME.bbox;
  const tree = new Quadtree({ minX: x0 - 50, maxX: x1 + 50, minZ: z0 - 50, maxZ: z1 + 50 }, LEAF_CAPACITY, LEAF_DEPTH);
  for (const b of buildings) {
    if (heroIds.has(b.id) || !b.ring || b.ring.length < 6) continue;
    const [cx, cz] = ringCentre(b.ring);
    tree.insert({ cx, cz, b });
  }

  const masonry = createPreWarBuildingMaterial({ wallAttr: true, cornerPier: 0.9, windowRatioY: 0.55, seed: 7.0 });
  const glass = createCurtainWallMaterial({ wallAttr: true, seed: 3.0 });
  const roofMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });
  roofMaterial.name = 'cph-roof';

  const leaves = [];
  const pickables = [];
  const glassAcc = createAccumulator();
  let triangles = 0;

  const leafNodes = collectLeaves(tree);
  for (const leaf of leafNodes) {
    const acc = createAccumulator();
    for (const { b } of leaf.items) {
      const glassy = b.wall_material === 'glas';
      const added = addBuilding(acc, b, glassy ? { wallAcc: glassAcc } : {});
      if (added) triangles += added.wallTriangles + added.roofTriangles;
    }
    const group = new THREE.Group();
    group.name = 'buildings-cell';
    if (acc.wall.index.length) {
      const wallMesh = new THREE.Mesh(toBufferGeometry(acc.wall), masonry);
      wallMesh.userData.ranges = acc.wallRanges.filter((r) => r.end > r.start);
      wallMesh.castShadow = wallMesh.receiveShadow = true;
      wallMesh.name = 'walls';
      group.add(wallMesh);
      pickables.push(wallMesh);
    }
    if (acc.roof.index.length) {
      const roofMesh = new THREE.Mesh(roofGeometry(acc.roof), roofMaterial);
      roofMesh.userData.ranges = acc.roofRanges.filter((r) => r.end > r.start);
      roofMesh.castShadow = roofMesh.receiveShadow = true;
      roofMesh.name = 'roofs';
      group.add(roofMesh);
      pickables.push(roofMesh);
    }
    const bounds = leaf.bounds;
    group.userData.centre = [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2];
    group.userData.radius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
    root.add(group);
    leaves.push(group);
  }
  if (glassAcc.wall.index.length) {
    const mesh = new THREE.Mesh(toBufferGeometry(glassAcc.wall), glass);
    mesh.userData.ranges = glassAcc.wallRanges.filter((r) => r.end > r.start);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'glass-walls';
    root.add(mesh);
    pickables.push(mesh);
  }

  const heroGroups = [];
  const heroStatus = [];
  await Promise.all((geo.heroes || []).map(async (hero) => {
    try {
      const group = await heroLoader(hero);
      root.add(group);
      heroGroups.push(group);
      heroStatus.push({ id: hero.building_id, loaded: true, position: group.position.toArray() });
    } catch (error) {
      console.warn(`[cph] hero ${hero.building_id} not loaded (run tools/link-heroes.sh); extruding its footprint instead:`, error?.message || error);
      heroStatus.push({ id: hero.building_id, loaded: false, error: String(error?.message || error) });
      const b = byId.get(hero.building_id);
      if (b) heroIds.delete(hero.building_id);
      if (b) {
        const acc = createAccumulator();
        addBuilding(acc, b);
        const group = new THREE.Group();
        const wm = new THREE.Mesh(toBufferGeometry(acc.wall), masonry);
        wm.userData.ranges = acc.wallRanges;
        const rm = new THREE.Mesh(roofGeometry(acc.roof), roofMaterial);
        rm.userData.ranges = acc.roofRanges;
        for (const m of [wm, rm]) { m.castShadow = m.receiveShadow = true; group.add(m); pickables.push(m); }
        root.add(group);
        leaves.push(Object.assign(group, {}));
        group.userData.centre = ringCentre(b.ring);
        group.userData.radius = 60;
      }
    }
  }));

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const panel = withInfoPanel && typeof document !== 'undefined' ? createInfoPanel() : null;
  let pinned = null;
  let camera = null;

  /** Hides cells beyond STREAM_RADIUS (cheap: a few dozen cells). Called every frame with the camera position. */
  function update(x, z) {
    for (const g of leaves) {
      const dx = g.userData.centre[0] - x;
      const dz = g.userData.centre[1] - z;
      g.visible = Math.hypot(dx, dz) - g.userData.radius < STREAM_RADIUS;
    }
  }

  /** Building id under a normalised-device point, or null. */
  function pick(ndcX, ndcY, cam = camera) {
    if (!cam) return null;
    ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(ndc, cam);
    const targets = [...pickables.filter((m) => m.parent?.visible !== false), ...heroGroups];
    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData.buildingId) o = o.parent;
      if (o?.userData.buildingId) return { id: o.userData.buildingId, point: hit.point, distance: hit.distance };
      const range = hit.object.userData.ranges && rangeAt(hit.object.userData.ranges, hit.faceIndex);
      if (range) return { id: range.id, point: hit.point, distance: hit.distance };
    }
    return null;
  }

  function showBuilding(id, isPinned = false) {
    const b = byId.get(id);
    if (!b || !panel) return null;
    const info = describeBuilding(b);
    panel.show(info, isPinned);
    return info;
  }

  /** Wires hover (throttled) and click-to-pin on the canvas. Dragging (orbit) does not pin. */
  function attach({ camera: cam, domElement }) {
    camera = cam;
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
      const hit = pick(...toNdc(e));
      if (hit) showBuilding(hit.id); else panel?.hide();
    });
    domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hit = pick(...toNdc(e));
      if (hit && hit.id !== pinned) { pinned = hit.id; showBuilding(hit.id, true); } else { pinned = null; if (!hit) panel?.hide(); }
    });
  }

  const stats = {
    buildings: buildings.length - heroIds.size, heroes: heroStatus, cells: leaves.length, triangles,
    meshes: pickables.length + heroGroups.reduce((n, g) => n + g.children[0].children.length, 0)
  };

  return { group: root, leaves, update, pick, attach, showBuilding, stats, byId, heroGroups, heroStatus };
}

export { buildRealBuildings, loadHero, describeBuilding, rangeAt, mergeByMaterial };
