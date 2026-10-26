import * as THREE from 'three/webgpu';
import { createIrmaNeon } from './irma-neon.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Quadtree } from './quadtree.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial } from './tsl-materials.js';
import { attribute } from 'three/tsl';
import { createAccumulator, addBuilding } from './building-geometry.js';
import { describeAppearance, texturedWalls } from './appearance.js';
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
const TEX_DIR = './data/tex';
const TEX_RADIUS = 110; // buildings further than this from the camera keep tone + procedural windows
const TEX_MAX_BUILDINGS = 28; // texture budget: photo atlases resident at once (nearest first, LRU eviction)
const TEX_CONCURRENCY = 4;
const TEX_MAX_FAILURES = 3; // consecutive failed loads before photo mode switches itself off (no 404 spam)

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
  g.setAttribute('roofMat', new THREE.Float32BufferAttribute(roof.mat, 2)); // roughness, metalness by roof type hint
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

function describeBuilding(b, lod2Info = null) {
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
    roofSource: lod2Info?.conf === 'measured' ? `LoD2.2 from the ${lod2Info.scan_date} point cloud${lod2Info.roof_type ? ` (${lod2Info.roof_type})` : ''}` : (lod2Info?.reason ? `flat extrusion (${lod2Info.reason})` : null),
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
  const swatch = (rgb) => (Array.isArray(rgb) ? `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;border:1px solid rgba(255,255,255,.35);background:rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})"></span>` : '');
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
        info.appearance?.wall ? row('Wall colour', `${swatch(info.appearance.wall.tone)}${e(info.appearance.wall.text)}${info.appearance.wall.photo ? ' + photo' : ''}`, info.appearance.wall.kind === 'observed' ? 'measured' : info.appearance.wall.kind === 'prior' ? 'scaled' : 'inferred') : '',
        ...(info.appearance?.wall?.flags || []).map((t) => `<div style="padding:1px 0;color:#e7c27a;font-size:11px">${e(t)}</div>`),
        info.appearance?.roof ? row('Roof colour', `${swatch(info.appearance.roof.tone)}${e(info.appearance.roof.text)}`, info.appearance.roof.kind === 'observed' ? 'measured' : 'inferred') : '',
        info.roofSource ? row('Roof geometry', e(info.roofSource), info.roofSource.startsWith('LoD2') ? 'measured' : 'inferred') : '',
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

/** `?tex=1` (or `?debug=tex`): wall photos from data/tex for the buildings near the camera. */
function texRequested() {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  return q.get('tex') === '1' || (q.get('debug') || '').split(',').includes('tex');
}

/**
 * Lazy photo walls. Per building one small mesh (photo quads of the usable atlas strips, lifted 2.5 cm off the extruded
 * wall so they win the depth test) with its own atlas texture. Only the TEX_MAX_BUILDINGS nearest buildings within
 * TEX_RADIUS of the camera are resident (LRU); everything else keeps tone + procedural windows. The atlas folder is probed
 * once with the first atlas; if it is absent (data/tex is gitignored) photo mode turns itself off quietly.
 */
function createTexManager(root, candidates, { fetchImpl = globalThis.fetch } = {}) {
  const state = { enabled: true, probed: false, failures: 0, resident: new Map(), loading: new Set(), failed: new Set(), lastRun: 0, loaded: 0 };
  const loader = typeof createImageBitmap === 'function';

  async function fetchBitmap(file) {
    const response = await fetchImpl(`./data/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
  }

  async function load(c) {
    state.loading.add(c.id);
    try {
      const bitmap = await fetchBitmap(c.walls.file);
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 4;
      texture.flipY = false;
      texture.needsUpdate = true;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.walls.position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.walls.normal, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(c.walls.uv, 2));
      g.setIndex(c.walls.index);
      g.computeBoundingSphere();
      const material = new THREE.MeshStandardNodeMaterial({ map: texture, color: 0x8c8c8c, roughness: 0.9, metalness: 0.0 }) // photos already carry their sun: scaled down so the engine light does not double it;
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `wall-photos-${c.id}`;
      mesh.receiveShadow = true;
      mesh.raycast = () => {}; // picking uses the extruded walls underneath
      root.add(mesh);
      state.resident.set(c.id, { mesh, texture, material, bitmap, last: performance.now() });
      state.loaded++;
      state.failures = 0;
    } catch (error) {
      state.failed.add(c.id);
      if (++state.failures >= TEX_MAX_FAILURES) {
        state.enabled = false;
        console.info('[cph] wall photos unavailable (data/tex missing or unreadable); keeping tone + procedural facades:', error?.message || error);
      }
    } finally {
      state.loading.delete(c.id);
    }
  }

  function evict(id) {
    const r = state.resident.get(id);
    if (!r) return;
    root.remove(r.mesh);
    r.mesh.geometry.dispose();
    r.material.dispose();
    r.texture.dispose();
    r.bitmap.close?.();
    state.resident.delete(id);
  }

  /** Called every frame with the camera position; does its work at most every 350 ms. */
  function update(x, z, now = performance.now()) {
    if (!state.enabled || !loader || now - state.lastRun < 350) return;
    state.lastRun = now;
    const near = [];
    for (const c of candidates) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      if (d < TEX_RADIUS && !state.failed.has(c.id)) near.push([d, c]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const want = near.slice(0, TEX_MAX_BUILDINGS);
    const wantIds = new Set(want.map(([, c]) => c.id));
    for (const id of [...state.resident.keys()]) if (!wantIds.has(id) && !near.some(([, c]) => c.id === id)) evict(id);
    // Over budget: drop the farthest residents that are no longer wanted
    for (const id of [...state.resident.keys()]) if (!wantIds.has(id) && state.resident.size + state.loading.size > TEX_MAX_BUILDINGS) evict(id);
    const todo = want.filter(([, c]) => !state.resident.has(c.id) && !state.loading.has(c.id));
    const run = async () => {
      if (!state.probed && todo.length) {
        state.probed = true;
        await load(todo.shift()[1]); // the first atlas doubles as the presence probe
        if (!state.enabled) return;
      }
      for (const [, c] of todo.slice(0, Math.max(0, TEX_CONCURRENCY - state.loading.size))) if (state.enabled) load(c);
    };
    run();
  }

  return { state, update, evict, get active() { return state.resident.size; } };
}

async function buildRealBuildings(scene, geo, { heroLoader = loadHero, withInfoPanel = true, lod2 = null, tex = texRequested(), observed = true, terrain = null } = {}) {
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
  // Roughness / metalness by roof type hint (tagpap dark matte, tile, slate, metal, ...): per-vertex from the roof geometry
  roofMaterial.roughnessNode = attribute('roofMat', 'vec2').x;
  roofMaterial.metalnessNode = attribute('roofMat', 'vec2').y;

  const leaves = [];
  const pickables = [];
  const glassAcc = createAccumulator();
  let triangles = 0;
  const texCandidates = [];

  // LoD2 roofs (tools/lod2): every building with a measured roofer record gets its pitched roof; the rest keep the flat
  // extrusion. The join is by building id, so the geodata compiler never needs to know about LoD2.
  const lod2Records = new Map();
  if (lod2) {
    await lod2.prefetch();
    for (const b of buildings) {
      if (heroIds.has(b.id) || b.footprintFix) continue; // a footprint the street layout clipped no longer matches its roofer edges
      const rec = await lod2.ready(b.id);
      if (rec) lod2Records.set(b.id, rec);
    }
  }

  const leafNodes = collectLeaves(tree);
  for (const leaf of leafNodes) {
    const acc = createAccumulator();
    for (const { b } of leaf.items) {
      const glassy = b.wall_material === 'glas';
      const quads = tex && observed && !glassy && b.observed?.atlas?.walls?.length ? [] : null;
      const added = addBuilding(acc, b, { ...(glassy ? { wallAcc: glassAcc } : {}), ...(lod2Records.has(b.id) ? { lod2: lod2Records.get(b.id) } : {}), ...(quads ? { quads } : {}), ...(observed ? {} : { observed: false }), ...(terrain ? { terrain } : {}) });
      if (added) triangles += added.wallTriangles + added.roofTriangles;
      if (added && quads) {
        const walls = texturedWalls(b, quads, added.mapping);
        if (walls) { const [cx, cz] = ringCentre(b.ring); texCandidates.push({ id: b.id, cx, cz, walls }); }
      }
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
        addBuilding(acc, b, terrain ? { terrain } : {});
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

  const neon = createIrmaNeon(root, byId, lod2Records);
  const texManager = tex ? createTexManager(root, texCandidates) : null;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const panel = withInfoPanel && typeof document !== 'undefined' ? createInfoPanel() : null;
  let pinned = null;
  let camera = null;

  /** Hides cells beyond STREAM_RADIUS (cheap: a few dozen cells). Called every frame with the camera position. */
  function update(x, z, nightFactor = 0) {
    neon.update(nightFactor);
    if (texManager) texManager.update(camera ? camera.position.x : x, camera ? camera.position.z : z);
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
      if (range) return { id: range.id, point: hit.point, distance: hit.distance, surface: hit.object.name === 'roofs' ? 'roof' : 'wall' };
    }
    return null;
  }

  function showBuilding(id, isPinned = false, hit = null) {
    const b = byId.get(id);
    if (!b || !panel) return null;
    const info = describeBuilding(b, lod2?.entry(id));
    info.appearance = describeAppearance(b, hit?.surface || 'wall', hit?.point || null, { textured: !!texManager?.state.resident.has(id) });
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
      if (hit) showBuilding(hit.id, false, hit); else panel?.hide();
    });
    domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hit = pick(...toNdc(e));
      if (hit && hit.id !== pinned) { pinned = hit.id; showBuilding(hit.id, true, hit); } else { pinned = null; if (!hit) panel?.hide(); }
    });
  }

  const stats = {
    tex: texManager ? { candidates: texCandidates.length } : null,
    buildings: buildings.length - heroIds.size, heroes: heroStatus, cells: leaves.length, triangles, lod2: lod2Records.size, neon: neon.stats,
    meshes: pickables.length + heroGroups.reduce((n, g) => n + g.children[0].children.length, 0)
  };

  return { group: root, leaves, update, pick, attach, showBuilding, stats, byId, heroGroups, heroStatus, texManager, neon };
}

export { buildRealBuildings, loadHero, describeBuilding, rangeAt, mergeByMaterial };
