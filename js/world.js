import * as THREE from 'three/webgpu';
import { CPH_FRAME } from './city-config.js';
import { buildRealBuildings } from './buildings-real.js';
import { loadLod2 } from './lod2-geometry.js';
import { createTrafficSystem } from './traffic.js';
import { buildCphRoadSurfaces } from './road-surfaces-cph.js';
import { createCyclistSystem } from './cyclists.js';
import { buildSignalHeads } from './signal-heads-cph.js';
import { createWalkSpace } from './walk-space-cph.js';
import { buildLakes } from './water-cph.js';
import { setCalibration } from './appearance.js';
import { applySurfaceCuts } from './lakes-cph.js';
import { loadCphFurniture } from './street-furniture-data.js';
import { loadCphTerrain, createTerrain, buildTerrainMeshArrays } from './terrain-cph.js';
import { applyTerrainGround, applyStreets, loadCphStreets } from './layout-cph.js';
import { createStreetFurniture } from './street-furniture-cph.js';
import { createZoneMap } from './zones-cph.js';
import { placeFurniture } from './placement-cph.js';

// js/world.js
// The Copenhagen world: a ground plane in the Copenhagen frame (docs/cph-geodata-schema.md) plus data/cph-geodata.json,
// exposed as `world.geo` (and globalThis.CPH_GEO). Buildings, roads, traffic, pedestrians, cyclists and signals are
// built from the geodata when it is present; the engine boots to the bare ground plane without it.
// With `?debug=footprints` the geodata's buildings, water and parks are drawn as flat debug polygons.

const CPH_GEODATA_URL = './data/cph-geodata.json';
const CPH_SURFACES_URL = './data/cph-surfaces.json';
const CPH_LAKES_URL = './data/cph-lakes.json';

/** Optional ground-surface register and road markings (tools/cph-geodata/surfaces.py); null when absent. */
async function loadCphSurfaces(url = CPH_SURFACES_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-surfaces/') ? doc : null;
  } catch (error) {
    console.info('[cph] no surfaces loaded:', error?.message || error);
    return null;
  }
}

/** Optional lake document (tools/cph-geodata/lakes.py): lake outlines, bridge strips and surface cuts; null when absent. */
async function loadCphLakes(url = CPH_LAKES_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-lakes/') ? doc : null;
  } catch (error) {
    console.info('[cph] no lakes loaded:', error?.message || error);
    return null;
  }
}

/** Fetches the compiled geodata. Returns null when it is absent or unreadable: the engine boots without it. */
async function loadCphGeodata(url = CPH_GEODATA_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const geo = await response.json();
    if (!geo || typeof geo !== 'object' || !geo.version?.startsWith('cph-geodata/')) {
      console.warn('[cph] data/cph-geodata.json is not a cph-geodata document, ignoring it');
      return null;
    }
    const o = geo.frame?.origin;
    if (o && o.some((v, i) => Math.abs(v - CPH_FRAME.origin[i]) > 1e-6)) {
      console.warn('[cph] geodata frame origin differs from city-config.js', o, CPH_FRAME.origin);
    }
    return geo;
  } catch (error) {
    console.info('[cph] no geodata loaded:', error?.message || error);
    return null;
  }
}

function groundTexture() {
  const size = 256; // one 25 m tile: a faint 5 m grid with a stronger edge
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7a7e80';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  for (let i = 0; i < size; i += size / 5) {
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, size);
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(size, i + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const GROUND_SIZE = 8000;

function groundMaterial() {
  const texture = groundTexture();
  texture.repeat.set(GROUND_SIZE / 25, GROUND_SIZE / 25);
  return new THREE.MeshStandardNodeMaterial({ map: texture, roughness: 0.95, metalness: 0 });
}

function buildGround(scene, terrain = null) {
  const SIZE = GROUND_SIZE;
  let geometry = new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2);
  if (terrain && !terrain.flat) {
    // no lakes: the terrain mesh without cut cells
    const a = buildTerrainMeshArrays(terrain, { cut: { cell: 4, half: 750, skip: [], pieces: [] }, frame: [{ ring: [-4000, -4000, 4000, -4000, 4000, 4000, -4000, 4000], holes: [[-750, -750, 750, -750, 750, 750, -750, 750]] }], uvSize: SIZE });
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(a.index, 1));
  }
  const mesh = new THREE.Mesh(geometry, groundMaterial());
  mesh.name = 'CopenhagenGround';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

// Flat [x0, z0, x1, z1, ...] ring to a Shape in the XY plane that, after rotateX(-PI/2), lands on (x, z)
function ringToPath(ring, Path) {
  const path = new Path();
  for (let i = 0; i < ring.length; i += 2) {
    if (i === 0) path.moveTo(ring[i], -ring[i + 1]);
    else path.lineTo(ring[i], -ring[i + 1]);
  }
  return path;
}

function polygonMesh(items, color, y, name) {
  const geometries = [];
  for (const item of items) {
    if (!item.ring || item.ring.length < 6) continue;
    const shape = new THREE.Shape(ringToPath(item.ring, THREE.Path).getPoints());
    for (const hole of item.holes || []) {
      if (hole.length >= 6) shape.holes.push(new THREE.Path(ringToPath(hole, THREE.Path).getPoints()));
    }
    geometries.push(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
  }
  if (!geometries.length) return null;
  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicNodeMaterial({ color, side: THREE.DoubleSide }));
  mesh.position.y = y;
  mesh.name = name;
  mesh.frustumCulled = false;
  return mesh;
}

function mergeGeometries(geometries) {
  let vertices = 0;
  let indices = 0;
  for (const g of geometries) {
    vertices += g.attributes.position.count;
    indices += g.index.count;
  }
  const position = new Float32Array(vertices * 3);
  const index = new Uint32Array(indices);
  let vo = 0;
  let io = 0;
  for (const g of geometries) {
    const count = g.attributes.position.count;
    position.set(g.attributes.position.array, vo * 3);
    for (let i = 0; i < g.index.count; i++) index[io++] = g.index.array[i] + vo;
    vo += count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

function buildDebugFootprints(scene, geo) {
  const group = new THREE.Group();
  group.name = 'CopenhagenDebugFootprints';
  const layers = [
    [geo.parks, 0x4d7a45, 0.03, 'debug-parks'],
    [geo.water, 0x2f6f9f, 0.04, 'debug-water'],
    [geo.buildings, 0xc9b79c, 0.05, 'debug-buildings']
  ];
  for (const [items, color, y, name] of layers) {
    const mesh = polygonMesh(items || [], color, y, name);
    if (mesh) group.add(mesh);
  }
  scene.add(group);
  return group;
}

const nullTraffic = () => ({
  cars: [], buses: [], peds: [], network: null,
  update() {}
});

// Road surfaces, the drivable network, traffic, pedestrians, cyclists and signal heads from the geodata
async function buildCphTraffic(scene, geo, { markInit, surfacesDoc = null, terrain = null }) {
  const surfaces = await buildCphRoadSurfaces(scene, geo, { surfaces: surfacesDoc, terrain });
  markInit('roadSurfaces');
  const walk = createWalkSpace(geo);
  let cyclists = null;
  const bikeLaneNear = (x, z, r) => !!cyclists && cyclists.network.lanes.some((l) => l.src && nearLane(l, x, z, r));
  const traffic = createTrafficSystem(scene, geo.points?.signals || [], {
    roadGraph: geo.roadGraph,
    walkable: walk.walkable,
    onSidewalk: walk.onSidewalk,
    blockAt: walk.blockAt,
    groundHeight: surfaces.groundHeight,
    debug: (globalThis.__cphDebug = {}),
    // pedestrians walk outside the cycle track beside a carriageway
    extraOffset: (e, sign) => {
      const mx = e.sx + e.dx * e.len * 0.5 + e.rx * sign * (e.half + 1.4);
      const mz = e.sz + e.dz * e.len * 0.5 + e.rz * sign * (e.half + 1.4);
      return bikeLaneNear(mx, mz, 1.6) ? 2.4 : 0;
    }
  });
  markInit('traffic');
  const signalNodes = traffic.network.nodes.filter((n) => n.signal);
  cyclists = createCyclistSystem(scene, geo, signalNodes, { groundHeight: surfaces.groundHeight });
  markInit('cyclists');
  const heads = buildSignalHeads(scene, signalNodes, { groundHeight: surfaces.groundHeight });
  markInit('signalHeads');
  const trafficUpdate = traffic.update;
  traffic.update = (dt, elapsed, focusPos, playerEntity, activeMode, camera) => {
    trafficUpdate(dt, elapsed, focusPos, playerEntity, activeMode, camera);
    cyclists.update(dt, elapsed, focusPos || { x: 0, z: 0 }, null);
    heads.update(elapsed, focusPos);
  };
  Object.assign(traffic, { cyclists: cyclists.riders, cyclistSystem: cyclists, signalNodes });
  return { surfaces, traffic, heads };
}

// distance from (x, z) to a lane polyline <= r
function nearLane(lane, x, z, r) {
  const p = lane.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i];
    const dz = p[i + 3] - p[i + 1];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
    if (Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z) <= r) return true;
  }
  return false;
}

// Name of the nearest named street (roadGraph link) within 40 m, for the HUD location sign
function createLocator(geo) {
  const rg = geo?.roadGraph;
  if (!rg) return () => 'Copenhagen';
  const N = rg.nodes;
  const CELL = 64;
  const cells = new Map();
  const key = (ix, iz) => ix * 100003 + iz;
  for (const l of rg.links) {
    const name = rg.names[l[6]];
    if (!name) continue;
    const seg = [N[2 * l[0]], N[2 * l[0] + 1], N[2 * l[1]], N[2 * l[1] + 1], name];
    const x0 = Math.min(seg[0], seg[2]);
    const x1 = Math.max(seg[0], seg[2]);
    const z0 = Math.min(seg[1], seg[3]);
    const z1 = Math.max(seg[1], seg[3]);
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = key(ix, iz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(seg);
      }
    }
  }
  return (x, z) => {
    let best = 40;
    let name = '';
    for (let ix = Math.floor((x - 40) / CELL); ix <= Math.floor((x + 40) / CELL); ix++) {
      for (let iz = Math.floor((z - 40) / CELL); iz <= Math.floor((z + 40) / CELL); iz++) {
        for (const [ax, az, bx, bz, n] of cells.get(key(ix, iz)) || []) {
          const dx = bx - ax;
          const dz = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          if (d < best) {
            best = d;
            name = n;
          }
        }
      }
    }
    return name ? `Copenhagen · ${name}` : 'Copenhagen';
  };
}

async function buildWorld(scene, { markInit = () => {}, debug = '', geoUrl = CPH_GEODATA_URL, water = '' } = {}) {
  setCalibration(!debug.split(',').includes('nocal'));
  const geo = await loadCphGeodata(geoUrl);
  globalThis.CPH_GEO = geo;
  markInit(geo ? 'geodata' : 'geodata(absent)');

  // ONE ground height model (data/cph-terrain.json, DHM terrain): buildings, roads, pavements, lakes, furniture, cars and
  // pedestrians all take their ground from it. `?debug=flat` boots on the old flat plane (y = 0) for comparisons.
  const terrain = createTerrain(geo && !debug.split(',').includes('flat') ? await loadCphTerrain() : null);
  if (geo && !terrain.flat) applyTerrainGround(geo, terrain);
  globalThis.CPH_TERRAIN = terrain;
  // ONE street cross-section (data/cph-streets.json): measured carriageways, cycle strips, pavements. `?debug=nostreets` keeps
  // the OSM centrelines with their capped widths.
  const streetsStats = geo && !debug.split(',').includes('nostreets') ? applyStreets(geo, await loadCphStreets()) : null;
  if (streetsStats) markInit(`streets(${streetsStats.roads} roads, ${streetsStats.dropped} dropped, ${streetsStats.sidewalks} pavements)`);
  markInit(terrain.flat ? 'terrain(flat)' : `terrain(${terrain.doc.min}..${terrain.doc.max} m)`);

  // Lakes (the Soerne): the ground plane is cut open over the water, so the plain plane is only built without them
  const lakesDoc = geo && !debug.split(',').includes('nowater') ? await loadCphLakes() : null;
  let lakes = null;
  let ground;
  if (lakesDoc?.lakes?.length) {
    lakes = buildLakes(scene, lakesDoc, { groundMaterial: groundMaterial(), size: GROUND_SIZE, bbox: geo.frame?.bbox || CPH_FRAME.bbox, planar: water !== 'simple', terrain });
    scene.add(lakes.ground);
    ground = lakes.ground;
    markInit(`lakes(${lakes.stats.lakes})`);
  } else {
    ground = buildGround(scene, terrain);
  }
  markInit('ground');

  let debugFootprints = null;
  if (geo && debug.split(',').includes('footprints')) debugFootprints = buildDebugFootprints(scene, geo);

  // M2: real buildings from the geodata (extruded footprints with the per-vertex facade frame) plus the hero glTFs
  let buildings = null;
  if (geo?.buildings?.length && !debug.split(',').includes('nobuildings')) {
    // Optional LoD2 roofs (tools/lod2 -> data/lod2); `?debug=nolod2` keeps the flat extrusions for before/after shots
    const lod2 = debug.split(',').includes('nolod2') ? null : await loadLod2();
    buildings = await buildRealBuildings(scene, geo, { lod2, observed: !debug.split(',').includes('noobserved'), terrain: terrain.flat ? null : terrain });
    markInit(`buildings(${buildings.stats.buildings})`);
  }

  let traffic = null;
  let surfacesCut = null;
  if (geo?.roadGraph && !debug.split(',').includes('noroads')) {
    surfacesCut = applySurfaceCuts(await loadCphSurfaces(), lakesDoc?.surface_cuts);
    traffic = await buildCphTraffic(scene, geo, { markInit, surfacesDoc: surfacesCut, terrain });
  }

  // M4: street furniture (data/cph-furniture.json): trees, lamps, parked cars, bins, bollards, benches, racks, bus stops
  let furniture = null;
  if (geo && !debug.split(',').includes('nofurniture')) {
    const doc = await loadCphFurniture();
    if (doc) {
      // ONE spatial constraint map (footprints, water, the measured carriageway, cycle strips, pavements) places every item
      const zones = streetsStats && !debug.split(',').includes('noplace') ? createZoneMap({ geo, lakes: lakesDoc, surfaces: surfacesCut }) : null;
      furniture = createStreetFurniture(scene, doc, { groundHeight: traffic?.surfaces?.groundHeight || null, place: zones ? (d) => placeFurniture(d, { zones, geo }) : null });
      markInit(`furniture(${furniture.plan.trees.length} trees, ${furniture.plan.lamps.length} lamps, ${furniture.plan.cars.length} cars${furniture.plan.report ? `, ${furniture.plan.report.dropped.length} dropped` : ''})`);
    }
  }

  return {
    colliders: [],
    // the player's surroundings: buildings, lakes and street furniture stream in around the camera; `night` is the
    // lighting system's night factor (lamps switch on above ~0.1)
    update: (x, z, night = 0) => {
      buildings?.update(x, z);
      lakes?.update(x, z);
      furniture?.update(x, z, night);
    },
    furniture,
    audioSignals: [],
    locationLabel: createLocator(geo),
    trafficSystem: traffic ? traffic.traffic : nullTraffic(),
    cullingRoots: ['CopenhagenDebugFootprints'],
    roadSurfaces: traffic?.surfaces || null,
    groundHeight: traffic?.surfaces?.groundHeight || null,
    terrain,
    ground,
    debugFootprints,
    buildings,
    attach: (context) => { buildings?.attach(context); lakes?.attach(context); },
    lakes,
    geo
  };
}

export { CPH_GEODATA_URL, CPH_SURFACES_URL, CPH_LAKES_URL, loadCphGeodata, loadCphSurfaces, loadCphLakes, buildWorld };
