import * as THREE from 'three/webgpu';
import { createIrmaNeon } from './irma-neon.js';
import { irmaNeonArtwork } from './irma-neon-art.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial } from './tsl-materials.js';
import { attribute } from 'three/tsl';
import { createAccumulator, addBuilding, groundLow } from './building-geometry.js';
import { buildingSteps, ringCentre, wallArrays as wallTyped, roofArrays as roofTyped } from './building-compute.js';
import { describeAppearance, calibrationOn } from './appearance.js';
import { createPhotoMaterial } from './facade-photo-material.js';
import { WINDOW, FACADE_CORNER_PIER } from './facade-style.js';
import { PHOTO, selectPhotoSet, texRequested, lookFile } from './facade-lod.js';
import { createContext as createGroundContext } from './groundfloor.js';
import { createEntranceIndex, createDoorAccumulator, addDoors } from './entrances.js';
import { CPH_FRAME, toLocal } from './city-config.js';
import { disposeTree } from './dispose-tree.js';
import { nextFrame } from './yield-frame.js';
import { createHeroCache } from './hero-cache.js';

// js/buildings-real.js
// Copenhagen's real buildings (M2): every geodata building is extruded from its measured footprint (rings with holes)
// to its eave, walls carrying the per-vertex facade frame the wallAttr facade shaders read, merged into one mesh per
// quadtree cell. Hero buildings (docs/cph-geodata-schema.md `heroes`) load their glTF instead and skip the extrusion.
// Picking maps a ray hit back to its building through the index ranges recorded per mesh.

const HEROES_DIR = './data/heroes';
const STREAM_RADIUS = 2400; // cells further than this from the camera are hidden (the district is 1.5 km across)
const TEX_DIR = './data/tex';
const GROUNDFLOOR_URL = './data/cph-groundfloor.json';
const ENTRANCES_URL = './data/cph-entrances.json';
let lookSeen = false; // some look atlas has loaded this session: a later 404 is one building's miss, not a missing folder
const PHOTO_MAX_FAILURES = 3; // consecutive failed loads before photo mode switches itself off (no 404 spam)

/** The geometry of a wall mesh: the typed arrays of building-compute.js (used as they are; the facade frame, or a colour for a lite wall). */
function wallGeometry(wall) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(wall.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(wall.normal, 3));
  if (wall.color) {
    g.setAttribute('color', new THREE.BufferAttribute(wall.color, 3));
  } else {
    g.setAttribute('facadeUV', new THREE.BufferAttribute(wall.facadeUV, 2));
    g.setAttribute('facadeWall', new THREE.BufferAttribute(wall.facadeWall, 4));
    g.setAttribute('facadeBldg', new THREE.BufferAttribute(wall.facadeBldg, 4));
    g.setAttribute('facadeTone', new THREE.BufferAttribute(wall.facadeTone, 4));
    g.setAttribute('facadeWindow', new THREE.BufferAttribute(wall.facadeWindow, 4));
    g.setAttribute('facadeTop', new THREE.BufferAttribute(wall.facadeTop, 1));
  }
  g.setIndex(new THREE.BufferAttribute(wall.index, 1));
  g.computeBoundingSphere();
  return g;
}

function makeDoorMesh(doorAcc, material) {
  if (!doorAcc.index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(doorAcc.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(doorAcc.normal, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(doorAcc.color, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(doorAcc.index), 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'entrance-doors';
  return mesh;
}

function roofGeometry(roof) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(roof.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(roof.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(roof.color, 3));
  g.setAttribute('roofMat', new THREE.BufferAttribute(roof.mat, 2)); // roughness, metalness by roof type hint
  g.setIndex(new THREE.BufferAttribute(roof.index, 1));
  g.computeBoundingSphere();
  return g;
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

// A hero glTF is parsed once and cloned for every build of its tile (js/hero-cache.js); the clones share its geometries, materials and
// textures, which the cache owns (userData.cached)
const heroCache = createHeroCache((hero) => loadHero(hero));
const loadHeroCached = (hero) => heroCache.get(hero);

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
        info.appearance?.detail ? row('Detail', e(info.appearance.detail.text), 'inferred') : '',
        info.roofSource ? row('Roof geometry', e(info.roofSource), info.roofSource.startsWith('LoD2') ? 'measured' : 'inferred') : '',
        row('Wall', e(info.wallMaterial), c.wall_material),
        row('Facade', `floor ${e(f.floor_h)} m, bay ${e(f.bay_w)} m, ${e(f.ground_type)}`, c.facade ?? 'inferred'),
        info.doors ? row('Entrances', info.doors.source === 'dar' ? `${info.doors.count} from DAR adgangspunkt` : info.doors.source === 'heuristic' ? `${info.doors.count} street door${info.doors.count === 1 ? '' : 's'}, placed by heuristic` : 'none', info.doors.conf) : '',
        row('Record', e(info.conf)),
        `<div style="margin-top:6px;opacity:.55;font-size:10px;word-break:break-all">${e((info.src || []).join(', '))}</div>`
      ].join('');
      el.style.display = 'block';
    },
    hide() { el.style.display = 'none'; }
  };
}

// One photo atlas is handed to the GPU per animation frame: several decoded together would all be uploaded (and get their mipmaps) by
// the same render.
let uploadChain = Promise.resolve();
const uploadSlot = () => (uploadChain = uploadChain.then(nextFrame));

/**
 * Lazy photo walls (default on, `?tex=0` disables). Per building one small mesh (photo quads of the usable atlas strips on
 * the extruded wall, depth-biased instead of lifted) with its own atlas texture and photo material. Residency is the LOD
 * policy of js/facade-lod.js: the nearest PHOTO.budget buildings within PHOTO.residency metres of the camera; the material
 * fades each photo into the tone + procedural facade between PHOTO.near and PHOTO.far. The processed look atlas
 * (data/tex-look, RGBA with window and unobserved masks) is read first, the raw JPEG atlas as fallback. If neither folder
 * is present (both are gitignored) photo mode turns itself off quietly.
 */
function createTexManager(root, candidates, { fetchImpl = globalThis.fetch, budget = null } = {}) {
  const state = { enabled: true, probed: false, failures: 0, resident: new Map(), loading: new Set(), failed: new Set(), lastRun: 0, loaded: 0, look: 0, raw: 0 };
  const loader = typeof createImageBitmap === 'function';
  const byId = new Map(candidates.map((c) => [c.id, c]));

  async function fetchBitmap(file) {
    const response = await fetchImpl(`./data/${file}`);
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const blob = await response.blob();
    return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
  }

  async function atlasBitmap(c) {
    try {
      return { bitmap: await fetchBitmap(lookFile(c.walls.file)), hasMask: true };
    } catch (error) {
      // once look atlases have loaded, a missing one (the citywide atlases arrive piecemeal) is that building's miss alone: no second request
      if (state.look > 0 && error?.status === 404) throw error;
      return { bitmap: await fetchBitmap(c.walls.file), hasMask: false };
    }
  }

  async function load(c) {
    state.loading.add(c.id);
    try {
      const { bitmap, hasMask } = await atlasBitmap(c);
      await uploadSlot(); // one atlas reaches the GPU per frame: its upload and mipmaps are done by the render that first draws it
      if (state.disposed) { bitmap.close?.(); return; } // the tile went away while the atlas was loading
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 8;
      texture.flipY = false;
      texture.needsUpdate = true;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.walls.position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.walls.normal, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(c.walls.uv, 2));
      g.setAttribute('wallUV', new THREE.Float32BufferAttribute(c.walls.wallUV, 2));
      g.setIndex(c.walls.index);
      g.computeBoundingSphere();
      const material = createPhotoMaterial(texture, { hasMask, tone: c.tone, brick: c.brick, layout: c.layout });
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `wall-photos-${c.id}`;
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      mesh.raycast = () => {}; // picking uses the extruded walls underneath
      root.add(mesh);
      state.resident.set(c.id, { mesh, texture, material, bitmap, last: performance.now() });
      state.loaded++;
      if (hasMask) state.look++; else state.raw++;
      state.failures = 0;
    } catch (error) {
      state.failed.add(c.id);
      if (state.look > 0 && error?.status === 404) return; // an atlas not produced yet: this building keeps its tone facade
      if (++state.failures >= PHOTO_MAX_FAILURES) {
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
    disposeTree(r.mesh);
    r.material.dispose();
    r.texture.dispose();
    r.bitmap.close?.();
    state.resident.delete(id);
  }

  /**
   * Applies a residency plan: `want` (ids to hold, nearest first) and `inRange` (ids that may stay). With a shared `budget`
   * (js/buildings-stream.js createPhotoBudget) the plan is made over the candidates of every tile at once.
   */
  function applyPlan(want, inRange) {
    const wantSet = new Set(want);
    const total = () => (budget ? budget.held() : state.resident.size + state.loading.size);
    for (const id of [...state.resident.keys()]) if (!inRange.has(id)) evict(id);
    // Over budget: drop the residents that lost their slot to a nearer building
    for (const id of [...state.resident.keys()]) if (!wantSet.has(id) && total() > PHOTO.budget) evict(id);
    const todo = want.filter((id) => !state.resident.has(id) && !state.loading.has(id) && !state.failed.has(id)).map((id) => byId.get(id)).filter(Boolean);
    const run = async () => {
      if (!state.probed && todo.length) {
        state.probed = true;
        await load(todo.shift()); // the first atlas doubles as the presence probe
        if (!state.enabled) return;
      }
      const room = Math.max(0, PHOTO.concurrency - (budget ? budget.loading() : state.loading.size));
      for (const c of todo.slice(0, room)) if (state.enabled) load(c);
    };
    run();
  }

  /** Called every frame with the camera position; does its work at most every 350 ms. (A shared budget drives `applyPlan` itself.) */
  function update(x, z, now = performance.now()) {
    if (budget || !state.enabled || !loader || now - state.lastRun < 350) return;
    state.lastRun = now;
    const { want, inRange } = selectPhotoSet(candidates, x, z);
    applyPlan(want, inRange);
  }

  /** Evicts every resident photo (a tile going away); the manager is dead afterwards. */
  function dispose() {
    state.enabled = false;
    state.disposed = true;
    for (const id of [...state.resident.keys()]) evict(id);
  }

  return { state, update, applyPlan, candidates, loader, has: (id) => byId.has(id), evict, dispose, get active() { return state.resident.size; } };
}

/** Venues (data/cph-groundfloor.json, tools/cph-geodata/groundfloor.py); the file is optional: without it only BBR trade use gives shops. */
async function loadVenues(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(GROUNDFLOOR_URL);
    if (!response.ok) return [];
    return (await response.json()).venues || [];
  } catch {
    return [];
  }
}

/** Real entrances (data/cph-entrances.json, tools/cph-geodata/entrances.py); optional: without it every door is the heuristic one. */
async function loadEntrances(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(ENTRANCES_URL);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** The four materials every building cell shares (a streamed city builds them once, see buildRealBuildings `shared`). */
function createBuildingMaterials() {
  const masonry = createPreWarBuildingMaterial({ wallAttr: true, cornerPier: FACADE_CORNER_PIER, windowRatioY: WINDOW.ratioY, seed: 7.0 });
  const glass = createCurtainWallMaterial({ wallAttr: true, seed: 3.0 });
  const roofMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });
  roofMaterial.name = 'cph-roof';
  // Roughness / metalness by roof type hint (tagpap dark matte, tile, slate, metal, ...): per-vertex from the roof geometry
  roofMaterial.roughnessNode = attribute('roofMat', 'vec2').x;
  roofMaterial.metalnessNode = attribute('roofMat', 'vec2').y;
  const doorMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  doorMaterial.name = 'cph-entrance-doors';
  // the mid ring's walls: one tone per building, no facade shader (the roofs, LoD2 included, keep theirs)
  const liteWall = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  liteWall.name = 'cph-wall-lite';
  return { masonry, glass, roofMaterial, doorMaterial, liteWall };
}

/**
 * @param {object} opts
 *   shared    { masonry, glass, roofMaterial, doorMaterial } from createBuildingMaterials(): one set for all tiles of a streamed city
 *   context   { buildings, roads }: the tile and its neighbours (party walls, street-facing walls); `geo.buildings` are the ones to build
 *   doors     false: no entrance doors and no ground-floor venue / entrance data (the mid ring)
 *   slice     `await slice()` between quadtree cells: lets a streamed build share the main thread with the render loop (js/yield-frame.js)
 */
async function buildRealBuildings(scene, geo, { heroLoader = loadHeroCached, withInfoPanel = true, lod2 = null, tex = texRequested(), observed = true, terrain = null, venues = null, entrances = undefined, shared = null, context = null, doors: wantDoors = true, slice = null, lite = false, compute = null, photoBudget = null } = {}) {
  const buildings = geo.buildings || [];
  const heroIds = new Set((geo.heroes || []).map((h) => h.building_id));
  const byId = new Map(buildings.map((b) => [b.id, b]));

  const root = new THREE.Group();
  root.name = 'CopenhagenBuildings';
  scene.add(root);

  const { masonry, glass, roofMaterial, doorMaterial, liteWall } = shared || createBuildingMaterials();
  const wallMaterial = lite ? liteWall : masonry;

  // LoD2 roofs (tools/lod2): every building with a measured roofer record gets its pitched roof; the rest keep the flat
  // extrusion. The join is by building id, so the geodata compiler never needs to know about LoD2.
  const lod2Records = new Map();
  if (lod2) {
    // Records are fetched per owning tile on first use (loadLod2: 1 km binaries, tile store: one lod2.bin per tile), all in parallel.
    const wanted = buildings.filter((b) => !heroIds.has(b.id) && !b.footprintFix); // a footprint the street layout clipped no longer matches its roofer edges
    const recs = await Promise.all(wanted.map((b) => lod2.ready(b.id)));
    wanted.forEach((b, i) => { if (recs[i]) lod2Records.set(b.id, recs[i]); });
  }

  // The CPU half (quadtree cells, wall / roof arrays, placed doors, photo candidates) is pure data in, typed arrays out
  // (js/building-compute.js): `compute` runs it in a Web Worker (js/building-pool.js); without one it runs here, a few buildings at a
  // time between the `slice` waits.
  const wantEntrances = !lite && wantDoors ? (entrances === undefined ? await loadEntrances() : entrances) : null;
  const job = {
    buildings, heroIds: [...heroIds], observed, doors: wantDoors && !lite, lite, wantQuads: !lite && !!tex, calibration: calibrationOn(),
    // the neighbourhood the ground floor reads: footprints and the road lines only (the rest of a record stays here)
    context: lite ? null : {
      buildings: (context?.buildings || buildings).map((b) => ({ id: b.id, ring: b.ring, holes: b.holes })),
      roads: (context?.roads || geo.roads || []).map((r) => ({ pts: r.pts, width: r.width, class: r.class, name: r.name }))
    },
    venues: !lite && wantDoors ? venues ?? (await loadVenues()) : [], entrances: wantEntrances, lod2: lod2Records,
    lows: terrain && !terrain.flat ? new Map(buildings.map((b) => [b.id, groundLow(b, terrain)]).filter((e) => e[1] !== null)) : null
  };
  let result = compute ? await compute(job) : null;
  if (!result) {
    const gen = buildingSteps(job);
    for (;;) {
      const step = gen.next();
      if (step.done) { result = step.value; break; }
      if (slice) await slice();
    }
  }

  const doorInfo = new Map(result.doorInfo); // building id -> { source: 'dar' | 'heuristic' | 'none', count, conf } for the info panel
  const texCandidates = result.texCandidates;
  const leaves = [];
  const pickables = [];
  let doorCount = result.stats.doors;
  let triangles = result.stats.triangles;
  const heightAt = terrain && !terrain.flat ? (x, z) => terrain.heightAt(x, z) : null;

  for (const leaf of result.leaves) {
    if (slice) await slice();
    const group = new THREE.Group();
    group.name = 'buildings-cell';
    if (leaf.wall) {
      const wallMesh = new THREE.Mesh(wallGeometry(leaf.wall), wallMaterial);
      wallMesh.userData.ranges = leaf.wallRanges;
      wallMesh.castShadow = wallMesh.receiveShadow = true;
      wallMesh.name = 'walls';
      group.add(wallMesh);
      pickables.push(wallMesh);
    }
    if (leaf.roof) {
      const roofMesh = new THREE.Mesh(roofGeometry(leaf.roof), roofMaterial);
      roofMesh.userData.ranges = leaf.roofRanges;
      roofMesh.userData.detailRanges = leaf.detailParts;
      roofMesh.castShadow = roofMesh.receiveShadow = true;
      roofMesh.name = 'roofs';
      group.add(roofMesh);
      pickables.push(roofMesh);
    }
    if (leaf.doors.length) {
      // doors stand on the terrain at the door (the compute step has none): built here, from the placed doors
      const doorAcc = createDoorAccumulator();
      for (const d of leaf.doors) addDoors(doorAcc, d.doors, { ground: d.ground, heightAt });
      const doorMesh = makeDoorMesh(doorAcc, doorMaterial);
      if (doorMesh) group.add(doorMesh);
    }
    group.userData.centre = leaf.centre;
    group.userData.radius = leaf.radius;
    root.add(group);
    leaves.push(group);
  }
  if (result.glass) {
    const mesh = new THREE.Mesh(wallGeometry(result.glass.wall), glass);
    mesh.userData.ranges = result.glass.wallRanges;
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
        const acc = createAccumulator({ lite });
        const ground = lite ? null : createGroundContext({ roads: context?.roads || geo.roads || [], buildings: context?.buildings || buildings, venues: job.venues, entrances: wantEntrances ? createEntranceIndex(wantEntrances) : null });
        const added = addBuilding(acc, b, { ...(lite ? { lite: true } : { ground }), ...(terrain ? { terrain } : {}), ...(observed ? {} : { observed: false }) });
        if (added?.doorInfo) doorInfo.set(b.id, added.doorInfo);
        const heroDoors = createDoorAccumulator();
        if (wantDoors && added?.doors?.length) doorCount += addDoors(heroDoors, added.doors, { ground: b.ground, heightAt: terrain && !terrain.flat ? (x, z) => terrain.heightAt(x, z) : null });
        const group = new THREE.Group();
        const heroDoorMesh = makeDoorMesh(heroDoors, doorMaterial);
        if (heroDoorMesh) group.add(heroDoorMesh);
        const wm = new THREE.Mesh(wallGeometry(wallTyped(acc.wall)), wallMaterial);
        wm.userData.ranges = acc.wallRanges;
        const rm = new THREE.Mesh(roofGeometry(roofTyped(acc.roof)), roofMaterial);
        rm.userData.ranges = acc.roofRanges;
        rm.userData.detailRanges = acc.detailParts;
        rm.name = 'roofs';
        for (const m of [wm, rm]) { m.castShadow = m.receiveShadow = true; group.add(m); pickables.push(m); }
        root.add(group);
        leaves.push(Object.assign(group, {}));
        group.userData.centre = ringCentre(b.ring);
        group.userData.radius = 60;
      }
    }
  }));

  // the Irma sign only exists where its buildings are: a tile without them builds no neon materials
  const neon = irmaNeonArtwork().some((art) => byId.has(art.buildingId)) ? createIrmaNeon(root, byId, lod2Records) : { group: null, panels: [], update() {}, stats: { panels: 0 } };
  const texManager = tex ? createTexManager(root, texCandidates, { budget: photoBudget }) : null;
  photoBudget?.add(texManager);
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
      if (range) return { id: range.id, point: hit.point, distance: hit.distance, surface: rangeAt(hit.object.userData.detailRanges || [], hit.faceIndex) ? 'detail' : hit.object.name === 'roofs' ? 'roof' : 'wall' };
    }
    return null;
  }

  /** What the info panel shows for a building of this instance (null when it is not one of ours). */
  function infoFor(id, hit = null) {
    const b = byId.get(id);
    if (!b) return null;
    const info = describeBuilding(b, lod2?.entry(id));
    info.doors = doorInfo.get(id) || null;
    info.appearance = describeAppearance(b, hit?.surface || 'wall', hit?.point || null, { textured: !!texManager?.state.resident.has(id) });
    return info;
  }

  function showBuilding(id, isPinned = false, hit = null) {
    if (!panel) return null;
    const info = infoFor(id, hit);
    if (info) panel.show(info, isPinned);
    return info;
  }

  /** Frees the GPU side of this instance: geometries, the photo textures and (when not shared) the materials. */
  function dispose() {
    photoBudget?.remove(texManager);
    texManager?.dispose();
    // hero glTFs own their materials and textures (loadHero builds them per load)
    for (const g of heroGroups) {
      if (g.userData.cached) continue; // the hero cache owns these
      g.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) m[k]?.dispose?.();
        m.dispose();
      });
    }
    disposeTree(root);
    if (!shared) for (const m of [masonry, glass, roofMaterial, doorMaterial]) m.dispose();
    panel?.element.remove();
    root.clear();
    leaves.length = 0;
    pickables.length = 0;
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
    buildings: buildings.length - heroIds.size, heroes: heroStatus, cells: leaves.length, triangles, doors: doorCount, lod2: lod2Records.size, neon: neon.stats,
    meshes: pickables.length + heroGroups.reduce((n, g) => n + g.children[0].children.length, 0)
  };

  const setCamera = (cam) => { camera = cam; };

  return { group: root, leaves, update, pick, attach, setCamera, showBuilding, infoFor, dispose, stats, byId, heroGroups, heroStatus, texManager, neon };
}

export { buildRealBuildings, createBuildingMaterials, createInfoPanel, loadHero, loadHeroCached, heroCache, describeBuilding, rangeAt, mergeByMaterial };
