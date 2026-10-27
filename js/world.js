import * as THREE from 'three/webgpu';
import { CPH_FRAME, setCityBounds, getDataBbox } from './city-config.js';
import { buildRealBuildings } from './buildings-real.js';
import { loadLod2 } from './lod2-geometry.js';
import { createTrafficSystem } from './traffic.js';
import { buildCphRoadSurfaces } from './road-surfaces-cph.js';
import { createCyclistSystem } from './cyclists.js';
import { buildDirectionOverlay } from './direction-overlay.js';
import { buildSignalHeads } from './signal-heads-cph.js';
import { createWalkSpace } from './walk-space-cph.js';
import { buildLakes } from './water-cph.js';
import { buildBridgeDLB, filterDLBFurniture } from './bridge-dlb.js';
import { setCalibration } from './appearance.js';
import { applySurfaceCuts } from './lakes-cph.js';
import { loadCphFurniture } from './street-furniture-data.js';
import { loadCphTerrain, createTerrain, createStreamTerrain, FLAT_TERRAIN, buildTerrainMeshArrays } from './terrain-cph.js';
import { applyTerrainGround, applyStreets, loadCphStreets, mergeSurfaceCuts } from './layout-cph.js';
import { createStreetFurniture } from './street-furniture-cph.js';
import { createZoneMap } from './zones-cph.js';
import { placeFurniture } from './placement-cph.js';
import { createGrass } from './grass-cph.js';
import { openTileStore, createTileLod2, createFurnitureAssembler } from './tile-store.js';
import { createRoadSurfaceLayer } from './road-surfaces-cph.js';
import { createTiledHeightField } from './ground-height-cph.js';
import { createTiledLawnMask } from './grass-layout-cph.js';
import { tileOfLocal, tileBoundsLocal } from './tile-grid.js';
import { createBaseGeo, graphFixFits, createTileData } from './tile-data.js';
import { isGoBoatPierBuilding } from './goboat-pier-data.js';
import { createTileStreamer } from './tile-streamer.js';
import { streamConfig, extentOfTiles, distanceToRect } from './tile-rings.js';
import { createBuildingsLayer } from './buildings-stream.js';
import { createSlicer, nextFrame } from './yield-frame.js';
import { createGroundLayer } from './ground-stream.js';
import { createWaterLayer, reflectOptions } from './water-stream.js';
import { sidePlanes, pointVisible } from './reflect-gate.js';
import { createTilePool } from './tile-pool.js';
import { makeRoadJob } from './road-compute.js';
import { makeFurnitureJob } from './furniture-compute.js';
import { createAgentRegion, createLaneIndex } from './agent-region.js';
import { buildRoadNetwork, dropCoveredServiceLinks } from './road-network.js';
import { buildCyclistNetworkFor } from './cyclists.js';
import { loadFarLayer } from './far-lod.js';
import { applyPlainGround } from './ground-shader-cph.js';
import { BODY_SPECS } from './actor-models.js';
import { createCityCollisions, createCollisionActor } from './city-collisions.js';
import { buildStaticColliders, createStaticIndex, createTiledStaticIndex } from './static-colliders.js';

// js/world.js
// The Copenhagen world: a ground plane in the Copenhagen frame (docs/cph-geodata-schema.md) plus data/cph-geodata.json,
// exposed as `world.geo` (and globalThis.CPH_GEO). Buildings, roads, traffic, pedestrians, cyclists and signals are
// built from the geodata when it is present; the engine boots to the bare ground plane without it.
// With `?debug=footprints` the geodata's buildings, water and parks are drawn as flat debug polygons.

const CPH_GEODATA_URL = './data/cph-geodata.json';
const CPH_SURFACES_URL = './data/cph-surfaces.json';
const CPH_LAKES_URL = './data/cph-lakes.json';
const CPH_VEGETATION_URL = './data/cph-vegetation.json';
const COLLIDING_PLAYER_MODES = new Set(['person', 'car', 'cyclist', 'cargobike', 'helicopter']);

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

/** Optional measured lawns and planting (tools/cph-geodata/vegetation.py: CIR NDVI + DHM point cloud); null when absent. */
async function loadCphVegetation(url = CPH_VEGETATION_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-vegetation/') ? doc : null;
  } catch (error) {
    console.info('[cph] no vegetation loaded:', error?.message || error);
    return null;
  }
}

/** The vegetation polygons appended to the surface register, where they draw as `grass` ground (nothing when either is absent). */
function withVegetation(surfacesDoc, vegetation) {
  if (!surfacesDoc || !vegetation?.surfaces?.length) return surfacesDoc;
  return { ...surfacesDoc, surfaces: [...surfacesDoc.surfaces, ...vegetation.surfaces] };
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

/** Opens the tile store (data/tiles/index.json); null when it is absent or unreadable: the engine then loads the monolithic files. */
async function openStore(baseUrl) {
  try {
    return await openTileStore(baseUrl ? { baseUrl } : {});
  } catch (error) {
    console.warn('[cph] tiles unreadable, falling back to the monolithic files:', error?.message || error);
    return null;
  }
}

function checkGeodata(geo) {
  const o = geo?.frame?.origin;
  if (o && o.some((v, i) => Math.abs(v - CPH_FRAME.origin[i]) > 1e-6)) console.warn('[cph] geodata frame origin differs from city-config.js', o, CPH_FRAME.origin);
  return geo;
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
// the planar reflection of the streamed city draws the tiles within `reflectOpts.range` (1100 m, `?reflect=dN`) of the camera (and no far ring)

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
    const [fx0, fz0, fx1, fz1] = getDataBbox();
    const a = buildTerrainMeshArrays(terrain, { cut: { cell: 4, half: fx1, skip: [], pieces: [] }, frame: [{ ring: [-4000, -4000, 4000, -4000, 4000, 4000, -4000, 4000], holes: [[fx0, fz0, fx1, fz0, fx1, fz1, fx0, fz1]] }], uvSize: SIZE });
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

/**
 * The shared collision phase of a traffic system (js/traffic.js setCollisionPhase): the cyclists step and join the cars, buses,
 * pedestrians and the active player, the player's parked vehicles and idle characters (controllerManager.entities) join as well, and
 * one js/city-collisions.js stage resolves them against each other and the static colliders. Used by the district and the streamed city.
 */
function attachCollisionPhase(traffic, cyclists, { stage = null } = {}) {
  let collisionStage = stage;
  let controllerManager = null;
  const inactivePlayerActors = [];
  const playerActorByEntity = new WeakMap();

  const playerActor = (entity, mode) => {
    let actor = playerActorByEntity.get(entity);
    if (!actor) {
      actor = createCollisionActor({
        entity, kind: 'player', mode, radius: 0.32, mass: 72,
        x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: false,
        getVelocity(out) {
          const heading = entity.heading || 0, speed = entity.speed || 0;
          out.x = Math.sin(heading) * speed + (entity.vx || 0);
          out.z = Math.cos(heading) * speed + (entity.vz || 0);
          return out;
        },
        applyVelocity(dx, dz) {
          const heading = entity.heading || 0;
          const vx = Math.sin(heading) * (entity.speed || 0) + (entity.vx || 0) + dx;
          const vz = Math.cos(heading) * (entity.speed || 0) + (entity.vz || 0) + dz;
          const speed = vx * Math.sin(heading) + vz * Math.cos(heading);
          entity.speed = speed;
          if (entity.type === 'car') {
            entity.vx = vx - Math.sin(heading) * speed;
            entity.vz = vz - Math.cos(heading) * speed;
          }
        },
        move(dx, dz) {
          entity.position.x += dx;
          entity.position.z += dz;
          entity.mesh?.position?.copy(entity.position);
          return entity.position;
        }
      });
      playerActorByEntity.set(entity, actor);
    }
    actor.entity = entity;
    actor.kind = 'player';
    actor.mode = mode;
    actor.spec = entity.bodySpec || null;
    actor.bodyTop = mode === 'helicopter' ? 3.2 : mode === 'car' ? entity.bodySpec?.height || 1.8 : 1.9;
    actor.bodyBottom = mode === 'helicopter' ? -0.25 : 0;
    actor.radius = mode === 'helicopter' ? 4.5 : mode === 'cargobike' ? 0.4 : mode === 'cyclist' ? 0.38 : mode === 'car' ? (entity.bodySpec?.width || 1.72) / 2 : mode === 'person' ? 0.48 : 0.32;
    actor.mass = mode === 'helicopter' ? 2200 : mode === 'car' ? 1250 : mode === 'cargobike' ? 135 : mode === 'cyclist' ? 95 : 72;
    actor.x = entity.position.x; actor.y = entity.position.y; actor.z = entity.position.z;
    actor.heading = entity.heading || 0;
    actor.placed = true;
    return actor;
  };

  traffic.setCollisionPhase((actors, frame) => {
    cyclists.simulate(frame.dt, frame.elapsed, frame.focusPos || { x: 0, z: 0 }, null);
    cyclists.syncCollisionActors();
    for (const actor of cyclists.collisionActors) actors.push(actor);
    inactivePlayerActors.length = 0;
    if (controllerManager) {
      for (const [mode, entity] of Object.entries(controllerManager.entities || {})) {
        if (!COLLIDING_PLAYER_MODES.has(mode) || (controllerManager.activeMode === 'swanboat' && mode === 'person')) continue;
        if (entity === frame.playerEntity || entity.mesh?.visible === false) continue;
        inactivePlayerActors.push(playerActor(entity, mode));
      }
      for (const actor of inactivePlayerActors) actors.push(actor);
    }
    const result = collisionStage?.resolve(actors, { dt: frame.dt });
    if (result?.movedActors.some((actor) => actor.kind === 'player')) {
      for (const actor of result.movedActors) {
        if (actor.kind !== 'player') continue;
        actor.entity.mesh?.position?.copy(actor.entity.position);
      }
      controllerManager?.poseCharacters?.(0);
    }
  });

  return {
    setStage(next) { collisionStage = next; },
    attachControllerManager(manager) { controllerManager = manager || null; }
  };
}

// Road surfaces, the drivable network, traffic, pedestrians, cyclists and signal heads from the geodata
async function buildCphTraffic(scene, geo, { markInit, surfacesDoc = null, lakesDoc = null, terrain = null, debug = '', roadSurfaces = null, walk = null }) {
  // streamed city: the road-surface layer (per tile) and the walk space (footprints per tile) are made by the caller
  const surfaces = roadSurfaces || await buildCphRoadSurfaces(scene, geo, { surfaces: surfacesDoc, terrain });
  markInit('roadSurfaces');
  walk ||= createWalkSpace(geo, lakesDoc);
  let cyclists = null;
  const bikeLaneNear = (x, z, r) => !!cyclists && cyclists.network.lanes.some((l) => l.src && nearLane(l, x, z, r));
  let lineStage = null; // the collision stage, once the world has it: walking lines step round the furniture it knows
  const traffic = createTrafficSystem(scene, geo.points?.signals || [], {
    obstruction: (ax, az, bx, bz) => lineStage ? lineStage.obstructedLength(ax, az, bx, bz) : 0,
    // no vehicle drives a service lane through a footprint (a gateway the twin draws as solid wall)
    roadGraph: dropCoveredServiceLinks(geo.roadGraph, walk.inBuilding),
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
  // `?debug=oneway`: arrows for the direction of cars and bicycles (direction-overlay.js)
  if (debug.split(',').includes('oneway')) markInit(`directions(${JSON.stringify(buildDirectionOverlay(scene, geo, cyclists.network, surfaces.groundHeight).counts)})`);
  const heads = buildSignalHeads(scene, signalNodes, { groundHeight: surfaces.groundHeight });
  markInit('signalHeads');
  const collide = attachCollisionPhase(traffic, cyclists);

  const trafficUpdate = traffic.update;
  traffic.update = (dt, elapsed, focusPos, playerEntity, activeMode, camera) => {
    trafficUpdate(dt, elapsed, focusPos, playerEntity, activeMode, camera);
    cyclists.render();
    heads.update(elapsed, focusPos);
  };
  Object.assign(traffic, {
    cyclists: cyclists.riders,
    cyclistSystem: cyclists,
    signalNodes,
    setCollisionStage: (stage) => { lineStage = stage || null; collide.setStage(stage); },
    attachControllerManager: collide.attachControllerManager
  });
  return { surfaces, traffic, heads, walk };
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

async function buildWorld(scene, { markInit = () => {}, debug = '', geoUrl = CPH_GEODATA_URL, water = '', treeDate, stream = null, start = null, tilesUrl = null, adoptMesh = null } = {}) {
  setCalibration(!debug.split(',').includes('nocal'));
  // Tiled layers (data/tiles/index.json, tools/cph-geodata/tile_split.py) when they exist: the tile streamer keeps the tiles around
  // the camera resident (buildStreamedWorld). `?debug=notiles` (and a custom geodata URL) load the monolithic data/cph-*.json
  // instead: the whole district is built once, as before.
  const store = debug.split(',').includes('notiles') || geoUrl !== CPH_GEODATA_URL ? null : await openStore(tilesUrl);
  if (store) return buildStreamedWorld(scene, store, { markInit, debug, water, treeDate, stream, start, adoptMesh });
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
  const furnitureDoc = geo ? await loadCphFurniture() : null;
  let bridgeDLB = null;
  if (lakesDoc?.lakes?.length && !debug.split(',').includes('nobridge')) {
    bridgeDLB = buildBridgeDLB(scene, geo, lakesDoc, { terrain, furnitureDoc });
    if (bridgeDLB) markInit(`dlb(${bridgeDLB.lamps.count} lamps, ${bridgeDLB.layout.arches.length} arches)`);
  }
  let lakes = null;
  let ground;
  if (lakesDoc?.lakes?.length) {
    lakes = buildLakes(scene, lakesDoc, { groundMaterial: groundMaterial(), size: GROUND_SIZE, bbox: geo.frame?.bbox || CPH_FRAME.bbox, planar: water !== 'simple', terrain,
      parks: geo.parks || [], modelBridge: (bridge) => bridgeDLB?.layout.bridgeId === bridge.id });
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
    buildings = await buildRealBuildings(scene, geo, { lod2, ...(debug.split(',').includes('nodoors') ? { entrances: null } : {}), observed: !debug.split(',').includes('noobserved'), terrain: terrain.flat ? null : terrain });
    markInit(`buildings(${buildings.stats.buildings})`);
  }

  let traffic = null;
  let surfacesCut = null;
  let vegetation = null;
  let grass = null;
  if (geo?.roadGraph && !debug.split(',').includes('noroads')) {
    vegetation = debug.split(',').includes('nograss') ? null : await loadCphVegetation();
    surfacesCut = applySurfaceCuts(withVegetation(await loadCphSurfaces(), vegetation), mergeSurfaceCuts(lakesDoc?.surface_cuts, geo.surfaceCuts));
    traffic = await buildCphTraffic(scene, geo, { markInit, surfacesDoc: surfacesCut, lakesDoc, terrain, debug });
  }

  // grass tufts on the measured lawns near the camera (one draw call); `?debug=nograss` keeps the plain ground
  if (vegetation?.surfaces?.length) {
    grass = createGrass(scene, vegetation, { terrain: terrain.flat ? null : terrain });
    markInit(`grass(${vegetation.stats?.lawn_m2 ?? '?'} m2 lawn)`);
  }

  // M4: street furniture (data/cph-furniture.json): trees, lamps, parked cars, bins, bollards, benches, racks, bus stops
  let furniture = null;
  if (geo && !debug.split(',').includes('nofurniture')) {
    const doc = furnitureDoc && bridgeDLB ? filterDLBFurniture(furnitureDoc, bridgeDLB.layout) : furnitureDoc;
    if (doc) {
      // ONE spatial constraint map (footprints, water, the measured carriageway, cycle strips, pavements) places every item
      const zones = streetsStats && !debug.split(',').includes('noplace') ? createZoneMap({ geo, lakes: lakesDoc, surfaces: surfacesCut }) : null;
      furniture = createStreetFurniture(scene, doc, { treeDate, groundHeight: traffic?.surfaces?.groundHeight || null, place: zones ? (d) => placeFurniture(d, { zones, geo }) : null, lakeDistance: lakes?.lakeDistance || null });
      markInit(`furniture(${furniture.plan.trees.length} trees, ${furniture.plan.lamps.length} lamps, ${furniture.plan.cars.length} cars${furniture.plan.report ? `, ${furniture.plan.report.dropped.length} dropped` : ''})`);
    }
  }

  const noBuildings = debug.split(',').includes('nobuildings');
  const collisionGeo = noBuildings && geo ? { ...geo, buildings: [] } : geo;
  const groundHeight = traffic?.surfaces?.groundHeight || null;
  const colliders = buildStaticColliders(collisionGeo, {
    furniturePlan: furniture?.plan || null,
    carSpecs: BODY_SPECS,
    groundHeight: groundHeight || (terrain.flat ? null : terrain)
  });
  const collisionStage = createCityCollisions({ staticIndex: createStaticIndex(colliders), groundHeight });
  traffic?.traffic.setCollisionStage(collisionStage);
  traffic?.traffic.setSpawnClear?.((x, z, heading, spec) => collisionStage.clearOfStatics(x, z, { heading, mode: 'car', spec }));

  return {
    colliders,
    // the player's surroundings: buildings, lakes and street furniture stream in around the camera; `night` is the
    // lighting system's night factor (lamps switch on above ~0.1)
    update: (x, z, night = 0) => {
      buildings?.update(x, z, night);
      lakes?.update(x, z);
      grass?.update(x, z);
      furniture?.update(x, z, night);
      bridgeDLB?.update(night);
    },
    bridgeDLB,
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
    attach: (context) => {
      traffic?.traffic.attachControllerManager(context?.controllerManager || null);
      buildings?.attach(context);
      lakes?.attach(context);
    },
    collisions: collisionStage,
    lakes,
    lakeData: lakesDoc,
    grass,
    geo
  };
}

// ------------------------------------------------------------------------------------------------ streamed city

const ringsBbox = (rings) => {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
    }
  }
  return Number.isFinite(x0) ? [x0, z0, x1, z1] : null;
};

/**
 * The city from the tile store, kept resident around the camera by the tile streamer (js/tile-streamer.js).
 *   global (built once at boot):  the road graph, the lakes that have the district's water treatment (a level in the terrain header: the
 *                                 Soerne) and the DLB bridge, the shared materials
 *   streamed per tile:            terrain heights, ground mesh (cut under the water), generic water (surface, quay walls, banks), road surfaces + the ground-height chunk, buildings (facades,
 *                                 LoD2, doors in the near ring), street furniture and trees, the lawn mask of the grass,
 *                                 the footprints pedestrians cannot walk through, the tile's roads and street layout
 *   regional (agent-region.js):   traffic, cyclists and pedestrians run on the road graph and the near-ring roads of a region around
 *                                 the camera, rebuilt as the camera moves
 *   far (far-lod.js):             block meshes for every tile that is not resident, the sea out to the horizon
 */
async function buildStreamedWorld(scene, store, { markInit, debug, water, treeDate, stream, start, adoptMesh = null }) {
  const flags = new Set(debug.split(','));
  const reflectOpts = reflectOptions();
  const city = await store.loadCity();
  const ids = store.ids;
  const index = store.index;
  markInit(`tiles(${ids.length})`);

  // the playable extent follows the index; the compiled data's own frame is what the water and the rasters are cut to
  setCityBounds(extentOfTiles(ids), { frame: index.frame?.bbox || undefined });
  const cutHalf = city.meta.terrain?.cut?.half ?? 750;
  // a citywide index reaches far beyond the area the lake cut grid and the ground field were made for (the district)
  const citywide = (index.frame?.bbox?.[2] ?? cutHalf) > cutHalf + 1 || (index.frame?.bbox?.[0] ?? -cutHalf) < -cutHalf - 1;

  // road graph (every tile's roads, pavements and cycle tracks stream with the tile): the street layout's graph fixes are the ones that
  // belong to THIS graph (data/city/streets.json refers to the district's numbering, tile_streets.py renumbers it)
  const legacyFix = city.streets?.graph && graphFixFits(city.streets.graph, city.roadGraph) ? city.streets.graph : null;
  if (city.streets?.graph && !legacyFix) console.info('[cph] data/city/streets.json numbers another road graph: its graph fixes are skipped (tools/cph-geodata/tile_streets.py renumbers them)');
  const { geo } = createBaseGeo(city.meta, city.roadGraph, flags.has('nostreets') ? null : city.streetsGraph || legacyFix);
  checkGeodata(geo);
  globalThis.CPH_GEO = geo;
  markInit(`geodata(${geo.roadGraph.links.length} links)`);

  // The generic water (data/city/water.json, tools/cph-geodata/city_water.py): bodies come per tile; the Soerne are the district's hand-made lakes
  // (`override`: the lake document of data/cph-lakes.json, unclipped, with the levels and deck heights the terrain header would carry)
  const cityWater = city.water && !flags.has('nowater') ? city.water : null;
  const override = cityWater?.override?.lakes?.length ? cityWater.override : null;
  const terrainHeader = city.meta.terrain && override
    ? { ...city.meta.terrain, lakes: [...(city.meta.terrain.lakes || []), ...(override.terrain?.lakes || [])], ponds: [...(city.meta.terrain.ponds || []), ...(override.terrain?.ponds || [])], bridges: [...(city.meta.terrain.bridges || []), ...(override.terrain?.bridges || [])] }
    : city.meta.terrain;
  const terrain = terrainHeader && !flags.has('flat') ? createStreamTerrain(terrainHeader) : FLAT_TERRAIN;
  const lod2 = city.meta.lod2 && !flags.has('nolod2') ? createTileLod2(city.meta, store.fetchBin) : null;
  const streets = flags.has('nostreets') ? null : city.streets;
  const data = createTileData({ index, meta: city.meta, streets, lakes: city.lakes, geo, terrain, lod2, dropBuilding: isGoBoatPierBuilding });
  globalThis.CPH_TERRAIN = terrain;

  // Lakes with a level in the terrain header get the district's water (walls, coping, the shore field, reflections); they are global:
  // their rims are baked into the water meshes, so the terrain under them is loaded once and pinned, and the furniture of the tiles
  // under the bridges feeds the DLB model. With data/city/water.json these are the Soerne (`override`) and every other water body is the generic
  // water of the tiles (js/water-stream.js); without it every other lake, pond and the harbour is the far layer's flat water (js/far-lod.js).
  const hasLevel = (kind, id) => terrain.flat || (kind === 'lake' ? terrain.lakeLevel(id) : kind === 'pond' ? terrain.pondLevel(id) : terrain.deckHeight(id)) != null;
  const lakeSource = override || city.lakes;
  const lakesDoc = lakeSource && !flags.has('nowater') ? {
    ...lakeSource,
    lakes: (lakeSource.lakes || []).filter((l) => hasLevel('lake', l.id)),
    ponds: (lakeSource.ponds || []).filter((l) => hasLevel('pond', l.id)),
    bridges: (lakeSource.bridges || []).filter((b) => hasLevel('bridge', b.id))
  } : null;
  const hasLakes = !!lakesDoc?.lakes?.length;
  const waterDoc = !flags.has('nowater') ? city.lakes : null; // every lake, pond and bridge strip: where nothing may stand or walk
  let dlbFurniture = null;
  if (hasLakes && !terrain.flat) {
    const bb = ringsBbox([...(lakesDoc.lakes || []), ...(lakesDoc.ponds || []), ...(lakesDoc.bridges || [])].map((l) => l.ring));
    if (bb) {
      const pinned = store.tilesForLocalBbox(bb, 25);
      await Promise.all(pinned.map(async (id) => data.setLayer(id, 'terrain', await store.fetchLayer(id, 'terrain'), { pin: true })));
      markInit(`terrain(${pinned.length} pinned)`);
    }
  }
  if (hasLakes && !flags.has('nobridge') && !flags.has('nofurniture')) {
    const bridges = (lakesDoc.bridges || []).map((b) => ringsBbox([b.ring])).filter(Boolean);
    const dlbTiles = new Set(bridges.flatMap((bb) => store.tilesForLocalBbox(bb, 10)));
    const asm = createFurnitureAssembler(city.meta);
    await Promise.all([...dlbTiles].map(async (id) => asm.addTile(await store.fetchLayer(id, 'furniture'))));
    dlbFurniture = asm.doc();
  }
  markInit(terrain.flat ? 'terrain(flat)' : `terrain(${city.meta.terrain.min}..${city.meta.terrain.max} m)`);

  let bridgeDLB = null;
  if (hasLakes && !flags.has('nobridge')) {
    bridgeDLB = buildBridgeDLB(scene, geo, lakesDoc, { terrain, furnitureDoc: dlbFurniture });
    if (bridgeDLB) markInit(`dlb(${bridgeDLB.lamps.count} lamps, ${bridgeDLB.layout.arches.length} arches)`);
  }

  // water (global) and the ground material the tiles share
  // (with the generic water layer the ground shader reads a window raster that follows the camera: grass in the parks everywhere, the gravel path
  // along the Soerne; js/water-stream.js. Without it: the district's static field over the lakes, plain stone elsewhere)
  const sharedGround = cityWater ? new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 }) : hasLakes ? groundMaterial() : applyPlainGround(new THREE.MeshStandardNodeMaterial());
  let lakes = null;
  if (hasLakes) {
    // the shore fields are rasters over the data frame: for a citywide index, over the lakes only (padded), not over 18 km of city
    const lakeBox = ringsBbox([...lakesDoc.lakes, ...(lakesDoc.ponds || []), ...(lakesDoc.bridges || [])].map((l) => l.ring));
    const frame = getDataBbox();
    const waterBox = citywide && lakeBox ? [lakeBox[0] - 120, lakeBox[1] - 120, lakeBox[2] + 120, lakeBox[3] + 120] : frame;
    lakes = buildLakes(scene, lakesDoc, { groundMaterial: sharedGround, size: GROUND_SIZE, bbox: waterBox, planar: water !== 'simple', terrain,
      parks: cityWater ? null : [], lakeField: !!cityWater, hideDuringReflection: () => (cityWater ? reflectionCull() : []), modelBridge: (bridge) => bridgeDLB?.layout.bridgeId === bridge.id, skipGround: true });
    markInit(`lakes(${lakes.stats.lakes})`);
  }
  const tileBoundsMap = new Map(ids.map((id) => [id, index.tiles[id].local]));
  const ground = createGroundLayer(scene, { terrain, material: sharedGround, size: GROUND_SIZE, tileBounds: tileBoundsMap, cut: city.meta.terrain?.cut, generic: citywide });
  markInit('ground');
  // generic water: harbour, canals, lakes, ponds (surface + shore walls per tile), the window rasters of the ground and the water shader
  // (the planar reflection pass renders the scene again: it leaves out the far ring and the tiles beyond REFLECT_RANGE of the camera, see reflectionCull)
  let cullRefs = { far: null, buildings: null, roads: null, camera: null };
  const boundsOfTile = new Map();
  // small things that add draw calls but nothing to a reflection at 25 % scale: people, cyclists and cars, grass tufts, street furniture other than
  // trees and lamp poles (`?reflect=nosmall` keeps them)
  const SMALL = /^(bollards|bins|bin-stands|glass-containers|benches|bike-|bikes-|parking-meters|bus-|rescue-posts|lake-posts|monuments|lamp-wires|lamp-pendants|tree-litter|PeopleNear|PeopleFar)/;
  let smallRefs = [];
  let smallAge = Infinity;
  const smallThings = () => {
    if (!reflectOpts.small) return [];
    if (smallAge++ >= 90) {
      smallAge = 0;
      smallRefs = [];
      scene.traverse((o) => {
        if (o.name === 'CopenhagenCyclists' || o.name === 'TrafficAndPedestrians' || o.name === 'grass-tufts' || SMALL.test(o.name)) smallRefs.push(o);
      });
    }
    return smallRefs;
  };
  const reflectionCull = () => {
    const out = [cullRefs.far?.group, ...smallThings()];
    const cam = cullRefs.camera;
    if (cam) {
      for (const root of [cullRefs.buildings?.group, cullRefs.roads?.group]) {
        for (const child of root?.children || []) {
          const id = /(\d+_\d+)$/.exec(child.name)?.[1];
          if (!id) continue;
          let b = boundsOfTile.get(id);
          if (!b) boundsOfTile.set(id, (b = tileBoundsLocal(id)));
          if (distanceToRect(cam.position.x, cam.position.z, b) > reflectOpts.range) out.push(child);
        }
      }
    }
    return out;
  };
  const waterLayer = cityWater
    ? createWaterLayer(scene, {
      header: cityWater, groundMaterial: sharedGround, planar: water !== 'simple',
      lakeRings: (lakesDoc?.lakes || []).flatMap((l) => [l.ring, ...(l.holes || [])]),
      hideDuringReflection: () => [lakes?.walls, ...reflectionCull()]
    })
    : null;
  if (waterLayer) markInit(`water(${cityWater.stats?.bodies ?? '?'} bodies, ${cityWater.stats?.quay_km ?? '?'} km quay)`);

  // the CPU halves of the buildings and the road surfaces run in Web Workers (`?debug=noworker`: on the main thread, in slices)
  const pool = flags.has('noworker') ? null : createTilePool();

  // the layers the streamer fills
  const layers = [];
  layers.push({ name: 'ground', rings: ['near', 'mid'], fidelity: true, add: (ctx, ring) => ground.addTile(ctx.id, ctx.bounds, { near: ring === 'near', tileCut: waterLayer ? ctx.water?.cut || null : null }), remove: (id) => ground.removeTile(id) });
  if (waterLayer) layers.push(waterLayer.layer);
  // the full-resolution water layers of the resident tiles, for the GoBoat's quay collision (main.js; js/goboat-navigation.js setDetailWater)
  const waterTiles = new Map();
  const waterWatchers = new Set();
  if (waterLayer) {
    layers.push({
      name: 'water-watch', rings: ['near', 'mid'],
      add: (ctx) => { const w = ctx.water; if (!w) return; waterTiles.set(ctx.id, w); for (const fn of waterWatchers) fn(ctx.id, w); },
      remove: (id) => { if (waterTiles.delete(id)) for (const fn of waterWatchers) fn(id, null); }
    });
  }

  const tiledHeight = createTiledHeightField(terrain.flat ? null : terrain, tileOfLocal);
  let roads = null;
  let walk = null;
  if (!flags.has('noroads')) {
    roads = await createRoadSurfaceLayer(scene, { terrain: terrain.flat ? null : terrain, tiledHeight });
    walk = createWalkSpace(geo, waterDoc);
    layers.push({
      name: 'roads', rings: ['near', 'mid'], fidelity: true,
      add: async (ctx, ring) => {
        const near = ring === 'near';
        const computed = pool ? await pool.run('roads', makeRoadJob(ctx, { near, terrain })) : null;
        return roads.addTile(ctx.id, ctx.geo, near ? ctx.surfaces : null, { bounds: ctx.bounds, near, slice: createSlicer(8), computed });
      },
      remove: (id) => roads.removeTile(id)
    });
    layers.push({ name: 'walk', rings: ['near', 'mid'], add: (ctx) => walk.addBuildings(ctx.id, ctx.ownBuildings), remove: (id) => walk.removeBuildings(id) });
  }

  // static colliders (js/static-colliders.js) per near tile: its own buildings here, its placed furniture with the furniture layer below. The
  // agent region (<= 560 m) lies inside the near ring, so every actor and the player meet the solids around them.
  const staticIndex = createTiledStaticIndex();
  const colliderGround = terrain.flat ? null : terrain;
  if (!flags.has('nobuildings')) {
    layers.push({
      name: 'colliders', rings: ['near'],
      add: (ctx) => staticIndex.set(`b:${ctx.id}`, buildStaticColliders({ buildings: ctx.ownBuildings }, { groundHeight: colliderGround })),
      remove: (id) => staticIndex.remove(`b:${id}`)
    });
  }

  let buildings = null;
  if (!flags.has('nobuildings')) {
    buildings = createBuildingsLayer(scene, { terrain: terrain.flat ? null : terrain, lod2, observed: !flags.has('noobserved'), pool, lite: !flags.has('nolite') });
    layers.push({ name: 'buildings', rings: ['near', 'mid'], fidelity: true, add: (ctx, ring) => buildings.addTile(ctx.id, ctx, ring), remove: (id) => buildings.removeTile(id) });
  }

  let grass = null;
  if (roads && !flags.has('nograss') && city.meta.vegetation) {
    const mask = createTiledLawnMask(tileOfLocal);
    grass = createGrass(scene, null, { terrain: terrain.flat ? null : terrain, mask });
    layers.push({
      name: 'grass', rings: ['near'],
      add: (ctx) => { mask.addTile(ctx.id, ctx.lawns, ctx.bounds); grass.invalidate(); },
      remove: (id) => { mask.removeTile(id); grass.invalidate(); }
    });
  }

  let furniture = null;
  if (roads && !flags.has('nofurniture') && city.meta.furniture) {
    furniture = createStreetFurniture(scene, null, { streaming: true, treeDate, groundHeight: tiledHeight, lakeDistance: lakes?.lakeDistance || null, adoptMesh });
    const zonesOn = !flags.has('noplace');
    const M = 30;
    layers.push({
      name: 'furniture', rings: ['near'],
      add: async (ctx) => {
        const own = ctx.furniture;
        if (!own) return;
        const doc = bridgeDLB ? filterDLBFurniture(own, bridgeDLB.layout) : own;
        // ONE spatial constraint map per tile (+ a margin): footprints, water, carriageways, cycle strips, pavements; the items are placed against it
        let place = null;
        if (zonesOn) {
          const placed = pool ? await pool.run('furniture', makeFurnitureJob(ctx, { doc, water: waterDoc, margin: M })) : null;
          if (placed) {
            place = () => placed;
          } else {
            const zones = createZoneMap({ geo: ctx.geo, lakes: waterDoc, surfaces: ctx.surfaces, bbox: [ctx.bounds[0] - M, ctx.bounds[1] - M, ctx.bounds[2] + M, ctx.bounds[3] + M] });
            await nextFrame(); // the zone raster and the placement are two slices of work
            place = (d) => placeFurniture(d, { zones, geo: ctx.geo });
          }
        }
        furniture.addTile(ctx.id, doc, { place });
        staticIndex.set(`f:${ctx.id}`, buildStaticColliders(null, { furniturePlan: furniture.tilePlan(ctx.id), carSpecs: BODY_SPECS, groundHeight: tiledHeight }));
      },
      remove: (id) => { furniture.removeTile(id); staticIndex.remove(`f:${id}`); }
    });
  }

  // with the CPU halves in workers two tiles build at once: one waits for its worker while the main thread makes the other's meshes
  const cfg = streamConfig({ ...(stream || {}), maxBuilds: pool ? 2 : 1 });
  const streamer = createTileStreamer({ store, data, layers, cfg });
  const origin = start || { x: 0, z: 0 };
  await streamer.settle(origin.x, origin.z);
  markInit(`stream(${streamer.snapshot().resident.near} near, ${streamer.snapshot().resident.mid} mid)`);
  waterLayer?.flush(origin.x, origin.z); // the first frame already has the grass and the shore field

  // the far ring: block meshes for the tiles that are not resident, the harbour and the sea (`?far=0` off; `?far` forces it on a district index)
  let far = null;
  if ((citywide || flags.has('far')) && !flags.has('nofar') && !(new URLSearchParams(globalThis.location?.search).get('far') === '0')) {
    const skipWater = new Set([...(lakesDoc?.lakes || []), ...(lakesDoc?.ponds || [])].map((l) => l.id));
    far = await loadFarLayer(scene, store, {
      isResident: (id) => streamer.isBuilt(id), skipWater,
      // the generic water's far pieces ride with their tiles and use its water material, so the harbour reads as one water out to the horizon
      ...(waterLayer ? { waterTiles: cityWater.far, waterMaterial: waterLayer.material } : {})
    });
    if (far) { far.flush(origin.x, origin.z, 40); markInit(`far(${store.post.far.tiles} tiles, ${(far.stats.bytes / 1e6).toFixed(1)} MB, ${far.stats.builds} built)`); }
  }

  const collisionStage = createCityCollisions({ staticIndex, groundHeight: roads ? tiledHeight : null });
  let collide = null; // the traffic system's collision phase (made with the traffic, on the first agent region)
  let controllerManager = null;

  // agents: traffic, cyclists, pedestrians and signal heads on the region around the camera
  let agents = null;
  let traffic = null;
  if (roads && !flags.has('noroads')) {
    let cyclists = null;
    let heads = null;
    let laneIndex = null;
    const bikeLaneNear = (x, z, r) => !!laneIndex && laneIndex.near(x, z, r);
    const networkOptions = {
      walkable: walk.walkable, onSidewalk: walk.onSidewalk, blockAt: walk.blockAt,
      // walking lines step round the near tiles' furniture (bike racks, trees, benches)
      obstruction: (ax, az, bx, bz) => collisionStage.obstructedLength(ax, az, bx, bz),
      // pedestrians walk outside the cycle track beside a carriageway
      extraOffset: (e, sign) => {
        const mx = e.sx + e.dx * e.len * 0.5 + e.rx * sign * (e.half + 1.4);
        const mz = e.sz + e.dz * e.len * 0.5 + e.rz * sign * (e.half + 1.4);
        return bikeLaneNear(mx, mz, 1.6) ? 2.4 : 0;
      }
    };
    const tileIdsAround = (x, z, r) => store.tilesForLocalBbox([x - r, z - r, x + r, z + r]).filter((id) => distanceToRect(x, z, index.tiles[id].local) <= r);
    // the region must lie inside the rings that keep the roads layers: its tiles (radius + 60 m) are within the mid radius
    const radius = Math.max(250, Math.min(560, cfg.mid - 100));
    const region = createAgentRegion({
      radius, drift: Math.round(radius * 0.34),
      roadGraph: geo.roadGraph,
      tilesAround: tileIdsAround,
      roadsOf: (id) => data.roadsOf(id),
      ready: (id) => data.has(id, 'roads') && data.has(id, 'streets'),
      stages: {
        network: (sub, signals) => buildRoadNetwork(signals, { roadGraph: dropCoveredServiceLinks(sub, walk.inBuilding), ...networkOptions }),
        cyclists: (g, ctx) => buildCyclistNetworkFor(g, ctx.network.nodes.filter((n) => n.signal)),
        apply: (ctx) => {
          const signalNodes = ctx.network.nodes.filter((n) => n.signal);
          laneIndex = createLaneIndex(ctx.cyclists.lanes);
          if (!traffic) {
            const system = createTrafficSystem(scene, [], { network: ctx.network, groundHeight: tiledHeight, debug: (globalThis.__cphDebug = {}), ...networkOptions });
            cyclists = createCyclistSystem(scene, null, signalNodes, { groundHeight: tiledHeight, network: ctx.cyclists });
            heads = buildSignalHeads(scene, signalNodes, { groundHeight: tiledHeight });
            // one collision stage for cars, buses, pedestrians, cyclists and the player against the near tiles' solids (as the district)
            const cyclistsNow = cyclists;
            collide = attachCollisionPhase(system, cyclistsNow, { stage: collisionStage });
            system.setSpawnClear((x, z, heading, spec) => collisionStage.clearOfStatics(x, z, { heading, mode: 'car', spec }));
            collide.attachControllerManager(controllerManager);
            const trafficUpdate = system.update;
            system.update = (dt, elapsed, focusPos, playerEntity, activeMode, camera) => {
              trafficUpdate(dt, elapsed, focusPos, playerEntity, activeMode, camera);
              cyclistsNow.render();
              heads.update(elapsed, focusPos);
            };
            traffic = system;
          } else {
            traffic.setNetwork(ctx.network);
            cyclists.setNetwork(ctx.cyclists);
            heads.setNodes(signalNodes);
          }
          Object.assign(traffic, { cyclists: cyclists.riders, cyclistSystem: cyclists, signalNodes, setCollisionStage: collide.setStage, attachControllerManager: collide.attachControllerManager });
        }
      }
    });
    agents = region;
    region.buildNow(origin.x, origin.z);
    markInit(`agents(${region.stats.links} links, ${region.stats.edges} edges, ${region.stats.lanes} bike lanes, ${region.stats.signals} signals)`);
  }

  let camera = null;
  cullRefs = { far, buildings, roads, get camera() { return camera; } };
  // the Soerne's reflection runs when the camera is near the water itself, not near the bounding box of the lakes
  const lakePts = [];
  for (const l of lakesDoc?.lakes || []) for (let i = 0; i < l.ring.length; i += 8) lakePts.push(l.ring[i], l.ring[i + 1]);
  const lakeDistance = (x, z) => { let d = Infinity; for (let i = 0; i < lakePts.length; i += 2) d = Math.min(d, Math.hypot(lakePts[i] - x, lakePts[i + 1] - z)); return d; };
  // the Soerne's reflection only when some lake outline (every 4th vertex) is inside the camera's side frustum, 30 m margin
  const lakePlanes = new Float64Array(16);
  const lakeInView = (cam, level) => {
    cam.updateMatrixWorld?.();
    sidePlanes(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, lakePlanes);
    for (let i = 0; i < lakePts.length; i += 2) if (pointVisible(lakePlanes, lakePts[i], level, lakePts[i + 1], 30)) return true;
    return false;
  };
  let lakeDistAt = -Infinity;
  let lakeDist = Infinity;
  return {
    get colliders() { return staticIndex.all(); }, // the resident tiles' solids right now (checks and tools; js/controllers.js queries staticIndex)
    staticIndex, // js/controllers.js queries it instead of `colliders` (they come and go with the tiles)
    collisions: collisionStage,
    update: (x, z, night = 0) => {
      streamer.update(x, z);
      agents?.update(x, z);
      far?.update(x, z);
      buildings?.update(x, z, night);
      if (waterLayer && lakes) {
        // two planar reflectors never run together: the Soerne's, or the generic water's, whichever is nearer
        const camY = camera ? camera.position.y : 0;
        const now = performance.now();
        if (now - lakeDistAt > 250) { lakeDistAt = now; lakeDist = lakeDistance(x, z); }
        const dl = lakeDist;
        const near = waterLayer.nearest(x, z);
        let lakesWant = dl < 300 && camY < 450 && camY > lakes.level + 0.2;
        if (lakesWant && reflectOpts.gate && camera) lakesWant = lakeInView(camera, lakes.level);
        const lakesFirst = lakesWant && dl <= near.distance;
        lakes.setPlanar(lakesFirst && water !== 'simple');
        waterLayer.update(x, z, { allow: !lakesFirst });
      } else {
        lakes?.update(x, z);
        waterLayer?.update(x, z);
      }
      grass?.update(x, z);
      furniture?.update(x, z, night);
      bridgeDLB?.update(night);
    },
    bridgeDLB,
    furniture,
    audioSignals: [],
    locationLabel: createLocator(geo),
    trafficSystem: traffic || nullTraffic(),
    cullingRoots: ['CopenhagenDebugFootprints'],
    roadSurfaces: roads,
    groundHeight: roads ? tiledHeight : null,
    terrain,
    ground: ground.group,
    groundLayer: ground,
    debugFootprints: null,
    buildings,
    attach: (context) => {
      camera = context.camera;
      controllerManager = context?.controllerManager || null;
      collide?.attachControllerManager(controllerManager);
      buildings?.attach(context);
      lakes?.attach(context);
      waterLayer?.attach(context);
    },
    lakes,
    waterLayer,
    cityWater,
    /** The water layers (data/tiles/<id>/water.json) of the tiles in the near and mid rings, by tile id. */
    waterTiles,
    /** fn(id, payload | null) whenever a tile's water layer arrives or leaves; returns the unsubscribe. */
    onWaterTile: (fn) => { waterWatchers.add(fn); return () => waterWatchers.delete(fn); },
    lakeData: hasLakes ? lakesDoc : null,
    grass,
    geo,
    stream: streamer,
    tileData: data,
    far,
    agents,
    pool,
    /** True when the tile index has a tile at this local point (the citywide teleport presets use it). */
    tileExists: (x, z) => !!index.tiles[tileOfLocal(x, z)]
  };
}

export { CPH_GEODATA_URL, CPH_SURFACES_URL, CPH_LAKES_URL, CPH_VEGETATION_URL, loadCphGeodata, loadCphSurfaces, loadCphLakes, loadCphVegetation, buildWorld };
