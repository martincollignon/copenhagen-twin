import * as THREE from 'three/webgpu';
import { CPH_FRAME } from './city-config-cph.js';

// js/world-cph.js
// The Copenhagen world for M0: an empty ground plane in the Copenhagen frame (docs/cph-geodata-schema.md) plus an
// optional load of data/cph-geodata.json, exposed as `world.geo` (and globalThis.CPH_GEO) for the later milestones.
// Traffic, pedestrians, signals and the map are inert null objects until M3 puts a Copenhagen road network behind them.
// With `?debug=footprints` the geodata's buildings, water and parks are drawn as flat debug polygons.

const CPH_GEODATA_URL = './data/cph-geodata.json';

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
      console.warn('[cph] geodata frame origin differs from city-config-cph.js', o, CPH_FRAME.origin);
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

function buildGround(scene) {
  const SIZE = 8000;
  const texture = groundTexture();
  texture.repeat.set(SIZE / 25, SIZE / 25);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ map: texture, roughness: 0.95, metalness: 0 })
  );
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

const nullMap = () => ({
  waypoint: null,
  isFullMapOpen: false,
  update() {},
  toggleFullMap() {},
  resizeFullCanvas() {},
  renderFullMap() {}
});

async function buildCphWorld(scene, { markInit = () => {}, debug = '', geoUrl = CPH_GEODATA_URL } = {}) {
  const ground = buildGround(scene);
  markInit('ground');

  const geo = await loadCphGeodata(geoUrl);
  globalThis.CPH_GEO = geo;
  markInit(geo ? 'geodata' : 'geodata(absent)');

  let debugFootprints = null;
  if (geo && debug.split(',').includes('footprints')) debugFootprints = buildDebugFootprints(scene, geo);

  return {
    colliders: [],
    boroughs: {},
    cityBlocks: { update() {}, allBlocks: [], colliders: [] },
    streetDetails: { audioSignals: [], signalClock: { value: 0 }, footprints: [], signalIntersections: [], update() {} },
    trafficSystem: nullTraffic(),
    highwayTraffic: { cars: [], update() {} },
    cullingRoots: ['CopenhagenDebugFootprints'],
    ground,
    debugFootprints,
    geo,
    createMapSystem: nullMap
  };
}

export { CPH_GEODATA_URL, loadCphGeodata, buildCphWorld };
