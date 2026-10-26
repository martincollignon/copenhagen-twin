import * as THREE from 'three/webgpu';
import { createIrmaNeon } from './irma-neon.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Quadtree } from './quadtree.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial } from './tsl-materials.js';
import { attribute } from 'three/tsl';
import { createAccumulator, addBuilding } from './building-geometry.js';
import { describeAppearance, texturedWalls } from './appearance.js';
import { createPhotoMaterial } from './facade-photo-material.js';
import { WINDOW, FACADE_CORNER_PIER } from './facade-style.js';
import { PHOTO, selectPhotoSet, texRequested, lookFile, estimateTextureBytes } from './facade-lod.js';
import { createContext as createGroundContext } from './groundfloor.js';
import { createEntranceIndex, createDoorAccumulator, addDoors } from './entrances.js';
import { CPH_FRAME, toLocal } from './city-config.js';
import { batchBuildingCells, updateBuildingCellVisibility } from './building-batches.js';

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
const GROUNDFLOOR_URL = './data/cph-groundfloor.json';
const ENTRANCES_URL = './data/cph-entrances.json';
const PHOTO_MAX_FAILURES = 3; // consecutive failed loads before photo mode switches itself off (no 404 spam)

function toBufferGeometry(wall) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(wall.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(wall.normal, 3));
  g.setAttribute('facadeUV', new THREE.Float32BufferAttribute(wall.facadeUV, 2));
  g.setAttribute('facadeWall', new THREE.Float32BufferAttribute(wall.facadeWall, 4));
  g.setAttribute('facadeBldg', new THREE.Float32BufferAttribute(wall.facadeBldg, 4));
  g.setAttribute('facadeTone', new THREE.Float32BufferAttribute(wall.facadeTone, 4));
  g.setAttribute('facadeWindow', new THREE.Float32BufferAttribute(wall.facadeWindow, 4));
  g.setAttribute('facadeTop', new THREE.Float32BufferAttribute(wall.facadeTop, 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(wall.index), 1));
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

/**
 * Lazy photo walls (default on, `?tex=0` disables). Per building one small mesh (photo quads of the usable atlas strips on
 * the extruded wall, depth-biased instead of lifted) with its own atlas texture and photo material. Residency is the LOD
 * policy of js/facade-lod.js: the nearest buildings within PHOTO.residency metres, bounded by both count and decoded
 * texture bytes; texture resolution follows camera distance. The material fades each photo into the tone + procedural
 * facade between PHOTO.near and PHOTO.far. The processed look atlas
 * (data/tex-look, RGBA with window and unobserved masks) is read first, the raw JPEG atlas as fallback. If neither folder
 * is present (both are gitignored) photo mode turns itself off quietly.
 */
function createTexManager(root, candidates, { fetchImpl = globalThis.fetch } = {}) {
  const state = {
    enabled: true, probed: false, failures: 0, resident: new Map(), loading: new Map(), failed: new Set(), failedTiers: new Map(),
    desiredQuality: new Map(), lastRun: 0, loaded: 0, look: 0, raw: 0, peakReservedBytes: 0
  };
  const loader = typeof createImageBitmap === 'function';
  const byId = new Map(candidates.map((c) => [c.id, c]));

  async function fetchBlob(file, signal) {
    const url = `./data/${file}`;
    const response = signal ? await fetchImpl(url, { signal }) : await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }

  async function atlasBitmap(c, maxDimension, signal) {
    const [width, height] = c.walls.size || [];
    const scale = width > 0 && height > 0
      ? Math.min(1, maxDimension / Math.max(width, height))
      : 1;
    const bitmapOptions = { imageOrientation: 'none', premultiplyAlpha: 'none' };
    if (scale < 1) {
      bitmapOptions.resizeWidth = Math.max(1, Math.floor(width * scale));
      bitmapOptions.resizeHeight = Math.max(1, Math.floor(height * scale));
      bitmapOptions.resizeQuality = 'high';
    }
    try {
      const blob = await fetchBlob(lookFile(c.walls.file), signal);
      return { bitmap: await createImageBitmap(blob, bitmapOptions), hasMask: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      const blob = await fetchBlob(c.walls.file, signal);
      return { bitmap: await createImageBitmap(blob, bitmapOptions), hasMask: false };
    }
  }

  function makeResident(c, bitmap, hasMask, quality, existingGeometry = null) {
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.flipY = false;
    texture.needsUpdate = true;
    const g = existingGeometry || new THREE.BufferGeometry();
    if (!existingGeometry) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.walls.position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.walls.normal, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(c.walls.uv, 2));
      g.setAttribute('wallUV', new THREE.Float32BufferAttribute(c.walls.wallUV, 2));
      g.setIndex(c.walls.index);
      g.computeBoundingSphere();
    }
    const material = createPhotoMaterial(texture, { hasMask, tone: c.tone, brick: c.brick, layout: c.layout });
    const mesh = new THREE.Mesh(g, material);
    mesh.name = `wall-photos-${c.id}`;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.raycast = () => {}; // picking uses the extruded walls underneath
    return {
      mesh, texture, material, bitmap, tier: quality.tier, width: bitmap.width, height: bitmap.height,
      bytes: estimateTextureBytes(c.walls.size, quality.maxDimension)
    };
  }

  function disposeResident(r, { disposeGeometry = true } = {}) {
    root.remove(r.mesh);
    if (disposeGeometry) r.mesh.geometry.dispose();
    r.material.dispose();
    r.texture.dispose();
    r.bitmap.close?.();
  }

  function evict(id) {
    const r = state.resident.get(id);
    if (!r) return;
    disposeResident(r);
    state.resident.delete(id);
  }

  function usedBytes() {
    let total = 0;
    for (const r of state.resident.values()) total += r.bytes;
    for (const job of state.loading.values()) total += job.bytes;
    return total;
  }

  function memorySnapshot() {
    let residentBytes = 0;
    let pendingBytes = 0;
    for (const r of state.resident.values()) residentBytes += r.bytes;
    for (const job of state.loading.values()) pendingBytes += job.bytes;
    return {
      residentBytes,
      pendingBytes,
      reservedBytes: residentBytes + pendingBytes,
      peakReservedBytes: state.peakReservedBytes,
      budgetBytes: PHOTO.maxResidentBytes,
      residentCount: state.resident.size,
      pendingCount: state.loading.size
    };
  }

  /** Free the farthest selected resident walls first before reserving a new GPU allocation. */
  function makeRoom(bytes, protectedId, want) {
    const order = new Map(want.map((id, index) => [id, index]));
    const fartherFirst = [...state.resident.keys()]
      .filter((id) => id !== protectedId)
      .sort((a, b) => (order.get(b) ?? Infinity) - (order.get(a) ?? Infinity));
    let total = usedBytes() + bytes;
    const protectedBytes = state.resident.get(protectedId)?.bytes || 0;
    let pendingBytes = 0;
    for (const [id, job] of state.loading) if (id !== protectedId) pendingBytes += job.bytes;
    // If the target and non-evictable in-flight requests alone cannot fit, preserve the current scene as-is.
    if (protectedBytes + pendingBytes + bytes > PHOTO.maxResidentBytes) return false;
    for (const id of fartherFirst) {
      if (total <= PHOTO.maxResidentBytes) break;
      const r = state.resident.get(id);
      if (!r) continue;
      evict(id);
      total -= r.bytes;
    }
    return total <= PHOTO.maxResidentBytes;
  }

  async function load(c, quality) {
    const job = {
      tier: quality.tier, width: quality.width, height: quality.height, bytes: quality.bytes,
      replacement: state.resident.has(c.id), controller: typeof AbortController === 'function' ? new AbortController() : null
    };
    state.loading.set(c.id, job);
    state.peakReservedBytes = Math.max(state.peakReservedBytes, usedBytes());
    let bitmap = null;
    try {
      const { bitmap: loadedBitmap, hasMask } = await atlasBitmap(c, quality.maxDimension, job.controller?.signal);
      bitmap = loadedBitmap;
      const currentQuality = state.desiredQuality.get(c.id);
      if (state.loading.get(c.id) !== job || !currentQuality || currentQuality.width !== job.width || currentQuality.height !== job.height || !state.enabled) {
        bitmap.close?.();
        bitmap = null;
        return;
      }

      const previous = state.resident.get(c.id);
      const next = makeResident(c, bitmap, hasMask, quality, previous?.mesh.geometry || null);
      bitmap = null; // ownership moved into `next`
      if (previous) disposeResident(previous, { disposeGeometry: false });
      root.add(next.mesh);
      state.resident.set(c.id, next);
      state.failedTiers.delete(c.id);
      state.loaded++;
      if (hasMask) state.look++; else state.raw++;
      state.failures = 0;
    } catch (error) {
      bitmap?.close?.();
      if (job.controller?.signal.aborted) {
        // Camera movement made this request stale; the next update schedules the newly selected atlas tier.
      } else if (!job.replacement) {
        state.failed.add(c.id);
        if (++state.failures >= PHOTO_MAX_FAILURES) {
          state.enabled = false;
          console.info('[cph] wall photos unavailable (data/tex missing or unreadable); keeping tone + procedural facades:', error?.message || error);
        }
      } else state.failedTiers.set(c.id, quality.tier);
    } finally {
      if (state.loading.get(c.id) === job) state.loading.delete(c.id);
    }
  }

  /** Called every frame with the camera position; does its work at most every 350 ms. */
  function update(x, z, now = performance.now()) {
    if (!state.enabled || !loader || now - state.lastRun < 350) return;
    state.lastRun = now;
    const currentTiers = new Map([...state.resident].map(([id, r]) => [id, r.tier]));
    for (const [id, job] of state.loading) if (!currentTiers.has(id)) currentTiers.set(id, job.tier);
    const { want, qualityById } = selectPhotoSet(candidates, x, z, PHOTO, currentTiers);
    state.desiredQuality = qualityById;
    for (const [id, job] of state.loading) {
      const quality = qualityById.get(id);
      if (!quality || quality.width !== job.width || quality.height !== job.height) job.controller?.abort();
    }
    const wantSet = new Set(want);
    for (const id of [...state.resident.keys()]) if (!wantSet.has(id)) evict(id);
    for (const id of want) {
      const resident = state.resident.get(id);
      const quality = qualityById.get(id);
      if (resident && quality && resident.width === quality.width && resident.height === quality.height) resident.tier = quality.tier;
    }

    // Keep one resident atlas visible while a quality replacement loads. If camera motion supersedes an in-flight
    // request, load() discards its bitmap before installation.
    const replacementId = want.find((id) => {
      const resident = state.resident.get(id);
      const quality = qualityById.get(id);
      return resident && quality && (resident.width !== quality.width || resident.height !== quality.height) && state.failedTiers.get(id) !== quality.tier;
    });
    if (replacementId && state.loading.size === 0) {
      const candidate = byId.get(replacementId);
      const quality = qualityById.get(replacementId);
      if (candidate && quality.width > 0 && quality.height > 0 && makeRoom(quality.bytes, replacementId, want)) void load(candidate, quality);
      return;
    }

    // The first atlas doubles as the presence probe, preserving the existing quiet fallback when photo data is absent.
    const todo = want.filter((id) => !state.resident.has(id) && !state.loading.has(id) && !state.failed.has(id));
    if (!state.probed && todo.length) {
      state.probed = true;
      const id = todo[0];
      const quality = qualityById.get(id);
      if (quality && quality.width > 0 && quality.height > 0 && makeRoom(quality.bytes, id, want)) void load(byId.get(id), quality);
      return;
    }
    for (const id of todo) {
      if (state.loading.size >= PHOTO.concurrency) break;
      const quality = qualityById.get(id);
      if (quality && quality.width > 0 && quality.height > 0 && makeRoom(quality.bytes, id, want)) void load(byId.get(id), quality);
    }
  }

  return { state, update, evict, get active() { return state.resident.size; }, get memory() { return memorySnapshot(); } };
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

async function buildRealBuildings(scene, geo, { heroLoader = loadHero, withInfoPanel = true, lod2 = null, tex = texRequested(), observed = true, terrain = null, venues = null, entrances = undefined } = {}) {
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

  const masonry = createPreWarBuildingMaterial({ wallAttr: true, cornerPier: FACADE_CORNER_PIER, windowRatioY: WINDOW.ratioY, seed: 7.0 });
  const glass = createCurtainWallMaterial({ wallAttr: true, seed: 3.0 });
  const roofMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });
  roofMaterial.name = 'cph-roof';
  // Roughness / metalness by roof type hint (tagpap dark matte, tile, slate, metal, ...): per-vertex from the roof geometry
  roofMaterial.roughnessNode = attribute('roofMat', 'vec2').x;
  roofMaterial.metalnessNode = attribute('roofMat', 'vec2').y;

  // Ground-floor kinds per wall: street side from the road network, party walls from neighbouring footprints, shops from venue data
  const entranceDoc = entrances === undefined ? await loadEntrances() : entrances;
  const ground = createGroundContext({ roads: geo.roads || [], buildings, venues: venues ?? (await loadVenues()), entrances: entranceDoc ? createEntranceIndex(entranceDoc) : null });
  let doorCount = 0;
  const doorInfo = new Map(); // building id -> { source: 'dar' | 'heuristic' | 'none', count, conf } for the info panel
  const doorMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  doorMaterial.name = 'cph-entrance-doors';
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
    const doorAcc = createDoorAccumulator();
    for (const { b } of leaf.items) {
      const glassy = b.wall_material === 'glas';
      const quads = tex && observed && !glassy && b.observed?.atlas?.walls?.length ? [] : null;
      const added = addBuilding(acc, b, { ground, ...(glassy ? { wallAcc: glassAcc } : {}), ...(lod2Records.has(b.id) ? { lod2: lod2Records.get(b.id) } : {}), ...(quads ? { quads } : {}), ...(observed ? {} : { observed: false }), ...(terrain ? { terrain } : {}) });
      if (added) triangles += added.wallTriangles + added.roofTriangles;
      if (added?.doorInfo) doorInfo.set(b.id, added.doorInfo);
      if (added?.doors?.length) doorCount += addDoors(doorAcc, added.doors, { ground: b.ground, heightAt: terrain && !terrain.flat ? (x, z) => terrain.heightAt(x, z) : null });
      if (added && quads) {
        const walls = texturedWalls(b, quads, added.mapping);
        if (walls) {
          const [cx, cz] = ringCentre(b.ring);
          texCandidates.push({ id: b.id, cx, cz, walls, tone: added.mapping.buildingTone, brick: added.style.mat === 0, layout: added.layout });
        }
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
      roofMesh.userData.detailRanges = acc.detailParts;
      roofMesh.castShadow = roofMesh.receiveShadow = true;
      roofMesh.name = 'roofs';
      group.add(roofMesh);
      pickables.push(roofMesh);
    }
    const doorMesh = makeDoorMesh(doorAcc, doorMaterial);
    if (doorMesh) group.add(doorMesh);
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
        const added = addBuilding(acc, b, { ground, ...(terrain ? { terrain } : {}) });
        if (added?.doorInfo) doorInfo.set(b.id, added.doorInfo);
        const heroDoors = createDoorAccumulator();
        if (added?.doors?.length) doorCount += addDoors(heroDoors, added.doors, { ground: b.ground, heightAt: terrain && !terrain.flat ? (x, z) => terrain.heightAt(x, z) : null });
        const group = new THREE.Group();
        const heroDoorMesh = makeDoorMesh(heroDoors, doorMaterial);
        if (heroDoorMesh) group.add(heroDoorMesh);
        const wm = new THREE.Mesh(toBufferGeometry(acc.wall), masonry);
        wm.userData.ranges = acc.wallRanges;
        const rm = new THREE.Mesh(roofGeometry(acc.roof), roofMaterial);
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

  batchBuildingCells(root, leaves, pickables);

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
      updateBuildingCellVisibility(g, Math.hypot(dx, dz) - g.userData.radius < STREAM_RADIUS);
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

  function showBuilding(id, isPinned = false, hit = null) {
    const b = byId.get(id);
    if (!b || !panel) return null;
    const info = describeBuilding(b, lod2?.entry(id));
    info.doors = doorInfo.get(id) || null;
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

  let meshCount = 0;
  root.traverse((object) => { if (object.isMesh) meshCount++; });
  const stats = {
    tex: texManager ? { candidates: texCandidates.length } : null,
    buildings: buildings.length - heroIds.size, heroes: heroStatus, cells: leaves.length, triangles, doors: doorCount, lod2: lod2Records.size, neon: neon.stats,
    meshes: meshCount
  };

  return { group: root, leaves, update, pick, attach, showBuilding, stats, byId, heroGroups, heroStatus, texManager, neon };
}

export { buildRealBuildings, loadHero, describeBuilding, rangeAt, mergeByMaterial };
