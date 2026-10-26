import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, uniform, attribute, positionWorld, cameraPosition, normalize, length, dot, pow, mix, clamp,
  smoothstep, sin, cos, time, texture, max, fract, floor, transformNormalToView, reflector, reflect, step, exp, NodeUpdateType
} from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { buildLakeArrays, groundWithHoles, shoreDistanceField, WATER } from './lakes-cph.js';
import { buildTerrainMeshArrays } from './terrain-cph.js';
import { applyGroundField } from './ground-shader-cph.js';
import { lakeDistanceFrom, groundField } from './ground-field-cph.js';
import { getDataBbox } from './city-config.js';

// js/water-cph.js
// The Soerne as water: sunken lake surface with TSL ripples, fresnel sky/planar reflection and a soft shoreline, held by
// granite lake walls and a coping (geometry and data in js/lakes-cph.js, tools/cph-geodata/lakes.py). The ground plane is
// cut open over the lakes so no ground shows through; bridges over water get a soffit and fascia.
//   ?water=simple   sky reflection only (no planar reflection pass)      ?debug=nowater   the old grey ground, no lakes

const BED = [0.038, 0.050, 0.042]; // linear equivalent of the observed sRGB (55, 63, 58) lake bed
const DEEP = [0.012, 0.020, 0.013]; // darker olive water after depth absorption
const WEED = [0.055, 0.066, 0.025]; // subdued yellow-green Elodea and algae mats
const SEA_BED = [0.032, 0.052, 0.058]; // the harbour and the sound (the generic water, `waterTint` 1): bluer grey-green, no weed
const SEA_DEEP = [0.009, 0.030, 0.043];
const ALGAE = [0.014, 0.020, 0.009];

const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3).sub(f.mul(2))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1, 0)));
  const c = hash2D(i.add(vec2(0, 1)));
  const d = hash2D(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// [direction (rad), wavelength (m), amplitude (m), speed (rad/s)]: short, sheltered Søerne ripples only
const WAVES = [
  [0.35, 1.35, 0.0048, 0.75], [1.90, 0.82, 0.0035, 1.05], [2.85, 0.54, 0.0022, 1.35],
  [4.40, 0.35, 0.0013, 1.8], [5.55, 0.24, 0.00075, 2.1]
];

function toGeometry(a, { uv = false, kind = false } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3));
  if (a.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(a.normal, 3));
  if (a.tint) g.setAttribute('waterTint', new THREE.Float32BufferAttribute(a.tint, 1));
  if (uv) g.setAttribute('wallUV', new THREE.Float32BufferAttribute(a.uv, 2));
  if (kind) g.setAttribute('wallKind', new THREE.Float32BufferAttribute(a.kind, 1));
  g.setIndex(a.index.length > 65535 ? new THREE.Uint32BufferAttribute(a.index, 1) : new THREE.Uint16BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Granite ashlar for the lake walls (kind 0), the coping ledge (1) and bridge concrete (2); wet and green near the water line. */
function createLakeWallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  m.name = 'cph-lake-wall';
  const wuv = attribute('wallUV', 'vec2');
  const kind = attribute('wallKind', 'float');
  const hash1 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  m.colorNode = Fn(() => {
    const COURSE = 0.34;
    const BLOCK = 0.95;
    const v = wuv.y;
    const row = floor(v.div(COURSE));
    const off = hash1(vec2(row, 3.1)).mul(BLOCK);
    const colx = floor(wuv.x.add(off).div(BLOCK));
    const id = hash1(vec2(colx, row));
    const bu = fract(wuv.x.add(off).div(BLOCK));
    const bv = fract(v.div(COURSE));
    const edge = smoothstep(0.0, 0.035, bu).mul(smoothstep(0.0, 0.035, float(1).sub(bu)))
      .mul(smoothstep(0.0, 0.06, bv)).mul(smoothstep(0.0, 0.06, float(1).sub(bv)));
    const stone = mix(vec3(0.305, 0.242, 0.171), vec3(0.429, 0.305, 0.205), id.mul(id));
    const grain = hash1(vec2(floor(wuv.x.mul(14.0)), floor(v.mul(14.0)))).mul(0.18).add(0.91);
    const wall = mix(vec3(0.05, 0.05, 0.05), stone.mul(grain), edge.mul(0.7).add(0.3));
    // A dark wet/algal band hugs the waterline and fades out within 0.25 m above it.
    const wet = float(1).sub(smoothstep(WATER.surfaceY, WATER.surfaceY + 0.25, wuv.y));
    const algae = smoothstep(WATER.surfaceY - 0.12, WATER.surfaceY, wuv.y)
      .mul(float(1).sub(smoothstep(WATER.surfaceY, WATER.surfaceY + 0.25, wuv.y))).mul(0.78);
    const wallWet = mix(mix(wall, wall.mul(0.48), wet), vec3(...ALGAE), algae);
    // coping: a lighter, smoother granite slab; its pattern runs along the edge
    const copeId = hash1(vec2(floor(wuv.x.div(1.4)), 7.7));
    const cope = mix(vec3(0.35, 0.28, 0.185), vec3(0.429, 0.305, 0.205), copeId).mul(grain);
    const concrete = vec3(0.16, 0.16, 0.165).mul(grain);
    const isCope = step(0.5, kind).mul(step(kind, 1.5));
    const isBank = step(2.5, kind);
    const isConcrete = step(1.5, kind).mul(float(1).sub(isBank));
    // natural lake bank (kind 3): grass above the splash zone, wet mud and reed stubble at the water line
    const n1 = fract(sin(dot(vec2(floor(wuv.x.mul(1.7)), floor(v.mul(2.3))), vec2(12.9, 78.2))).mul(43758.5));
    const grassC = mix(vec3(0.07, 0.12, 0.035), vec3(0.14, 0.2, 0.06), n1);
    const mud = mix(vec3(0.05, 0.04, 0.03), vec3(0.09, 0.075, 0.05), n1);
    const bank = mix(mud, grassC, smoothstep(-0.95, -0.35, v));
    return mix(mix(mix(wallWet, cope, isCope), concrete, isConcrete), bank, isBank);
  })();
  return m;
}

/** The sky colour seen in direction `r` from the live time-of-day uniforms (used when there is no planar reflection). */
const skyColourAt = (r) => {
  const up = clamp(r.y, 0.0, 1.0);
  const sky = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, pow(up, 0.55));
  const sunAmount = pow(max(dot(r, normalize(cityUniforms.uSkySunDir)), 0.0), 220.0);
  return sky.add(cityUniforms.uSunColor.mul(sunAmount.mul(1.5)));
};

/**
 * `window` (the streamed city's generic water, js/water-stream.js): { origin: uniform vec2, size: uniform float, reflLevel: uniform float, reflOn: uniform float }. The
 * shore-distance texture then covers a window that follows the camera instead of the district `bbox`, and the planar reflection (one plane at a
 * time, y = reflLevel) only paints water at that level; water at any other level reflects the sky.
 */
function createWaterMaterial({ sdf, bbox, planar, level = WATER.surfaceY, window = null }) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.045, metalness: 0, envMapIntensity: 0 });
  material.name = 'cph-water';
  const wp = positionWorld;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const V = toCam.div(max(dist, 0.001));

  // distance to the nearest wall: smooths the ripples and drives the shore colour
  let shore;
  if (window) {
    const wuv = vec2(wp.x.sub(window.origin.x), wp.z.sub(window.origin.y)).div(window.size);
    const inWindow = step(0.0, wuv.x).mul(step(wuv.x, 1.0)).mul(step(0.0, wuv.y)).mul(step(wuv.y, 1.0));
    shore = mix(float(WATER.shoreMax), texture(sdf, wuv).r.mul(WATER.shoreMax), inWindow); // beyond the window: open water
  } else {
    const [x0, z0, x1, z1] = bbox;
    shore = texture(sdf, vec2(wp.x.sub(x0).div(x1 - x0), wp.z.sub(z0).div(z1 - z0))).r.mul(WATER.shoreMax);
  }
  const calm = smoothstep(0.0, 3.0, shore).mul(0.7).add(0.3);

  // analytic wave slopes (sum of sines), fading out with distance so the far water does not shimmer
  let sx = float(0);
  let sz = float(0);
  for (const [dir, lambda, amp, speed] of WAVES) {
    const k = (2 * Math.PI) / lambda;
    const dx = Math.cos(dir);
    const dz = Math.sin(dir);
    const phase = wp.x.mul(dx * k).add(wp.z.mul(dz * k)).sub(time.mul(speed)).add(dir * 7.0);
    const resolved = clamp(float(lambda * 22.0).div(dist.add(1.0)), 0.0, 1.0);
    const slope = cos(phase).mul(amp * k).mul(resolved);
    sx = sx.add(slope.mul(dx));
    sz = sz.add(slope.mul(dz));
  }
  // Soften the short ripples where the water meets the wall.
  sx = sx.mul(calm);
  sz = sz.mul(calm);
  const N = normalize(vec3(sx.negate(), 1.0, sz.negate()));
  material.normalNode = transformNormalToView(N);

  const NdotV = max(dot(N, V), 0.0);
  const fresnel = clamp(float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5.0))), 0.0, 1.0);

  // The shallow bed is visible near the wall; depth absorption moves the body towards dark olive water farther out.
  // This body is emissive so a bright directional sun cannot wash it into grey diffuse colour.
  const depth = mix(float(0.25), float(2.4), smoothstep(1.0, 10.0, shore));
  const attenuation = float(1).sub(exp(depth.div(-1.2)));
  let body = mix(vec3(...BED), vec3(...DEEP), attenuation);
  // the streamed city's water carries `waterTint`: 1 at the sea level (harbour basins, canals, the sound), 0 for lakes and ponds
  const tint = window ? attribute('waterTint', 'float') : float(0);
  if (window) body = mix(body, mix(vec3(...SEA_BED), vec3(...SEA_DEEP), attenuation), tint);
  const weedField = noise2D(wp.xz.mul(0.035)).mul(0.7).add(noise2D(wp.xz.mul(0.11)).mul(0.3));
  const nearBank = float(1).sub(smoothstep(6.0, 18.0, shore));
  const weedMask = smoothstep(0.60, 0.76, weedField).mul(nearBank).mul(0.5).mul(float(1).sub(tint));
  body = mix(body, vec3(...WEED), weedMask);
  const nightDim = smoothstep(0.35, 1.55, cityUniforms.uInteriorGlow);
  const bodyLight = mix(float(1), float(0.22), nightDim);
  material.colorNode = vec3(0.0);
  material.roughnessNode = mix(float(0.045), float(0.58), weedMask);

  // reflection: planar (buildings, trees, bridge) or sky only; contact-darkened right at the wall
  const contact = smoothstep(0.0, 1.2, shore).mul(0.45).add(0.55);
  let reflection;
  let reflectorNode = null;
  if (planar) {
    reflectorNode = reflector({ resolutionScale: planar.resolutionScale ?? 0.4, bounces: false });
    reflectorNode.target.rotateX(-Math.PI / 2);
    reflectorNode.target.position.y = level;
    reflectorNode.uvNode = reflectorNode.uvNode.add(vec2(sx, sz).mul(0.06));
    reflection = reflectorNode.rgb;
    if (window) {
      const r = reflect(V.negate(), N);
      const sky = skyColourAt(normalize(vec3(r.x, max(r.y, 0.01), r.z)));
      reflection = mix(sky, reflection, float(1).sub(smoothstep(0.3, 0.9, wp.y.sub(window.reflLevel).abs())).mul(window.reflOn));
    }
  } else {
    const r = reflect(V.negate(), N);
    reflection = skyColourAt(normalize(vec3(r.x, max(r.y, 0.01), r.z)));
  }
  // foam-free but alive shoreline: a thin lighter band where the ripples lap the wall
  const lap = smoothstep(0.55, 0.0, shore).mul(sin(wp.x.mul(2.1).add(wp.z.mul(1.7)).sub(time.mul(1.6))).mul(0.5).add(0.5)).mul(0.035);
  const bodyContribution = body.mul(bodyLight).mul(float(1).sub(fresnel));
  const reflectionContribution = reflection.mul(fresnel).mul(contact).mul(0.87);
  material.emissiveNode = (globalThis.__waterDebug === 'refl' ? reflection.mul(0.87) : bodyContribution.add(reflectionContribution))
    .add(vec3(0.012, 0.016, 0.012).mul(lap));
  return { material, reflectorNode };
}


/**
 * The planar pass renders the scene from inside the main pass without the main pass' MRT: it must not re-render the shadow maps (they are
 * already current), and materials that only write MRT attachments (contact shadows, flares, steam: `mrtNode`) would compile to empty
 * fragment outputs, so they are hidden from the reflection. `hide()` lists the meshes (the lake walls) that are hidden during it too.
 */
function patchPlanarReflector(reflectorNode, scene, hide) {
  const base = reflectorNode.reflector;
  const original = base.updateBefore.bind(base);
  let shadows = [];
  let mrtOnly = [];
  let frame = 0;
  base.updateBefore = (f) => {
    if (frame++ % 90 === 0) {
      shadows = [];
      mrtOnly = [];
      scene.traverse((o) => {
        if (o.isLight && o.shadow) shadows.push(o.shadow);
        const m = o.isMesh || o.isSprite ? o.material : null;
        if (m && (Array.isArray(m) ? m.some((material) => material.mrtNode) : m.mrtNode)) mrtOnly.push(o);
      });
    }
    const saved = shadows.map((sh) => sh.autoUpdate);
    const visible = mrtOnly.map((o) => o.visible);
    shadows.forEach((sh) => { sh.autoUpdate = false; });
    mrtOnly.forEach((o) => { o.visible = false; });
    // The reflector's oblique near-plane clip assumes a conventional depth buffer: with reversed depth it clips the whole
    // scene away. Render without the clip (the only geometry below the water line is the lake walls, hidden here).
    const renderer = f.renderer;
    const mainProj = f.camera.projectionMatrix.elements;
    const hidden = hide().filter(Boolean);
    const wallVis = hidden.map((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    const render = renderer.render;
    renderer.render = function patched(sc, cam) {
      if (cam !== f.camera) for (const k of [2, 6, 10, 14]) cam.projectionMatrix.elements[k] = mainProj[k];
      return render.call(this, sc, cam);
    };
    try { original(f); } finally {
      renderer.render = render;
      hidden.forEach((o, i) => { o.visible = wallVis[i]; });
      shadows.forEach((sh, i) => { sh.autoUpdate = saved[i]; });
      mrtOnly.forEach((o, i) => { o.visible = visible[i]; });
    }
  };
}

/**
 * Builds the lakes into `scene`. Returns { group, ground, water, material, stats, update, attach, setPlanar }.
 * `ground` is the cut ground mesh (replaces the plain plane); `update(x, z)` gates the planar reflection pass.
 */
function buildLakes(scene, doc, { groundMaterial, size = 8000, bbox = getDataBbox(), planar = true, terrain = null, parks = null, modelBridge = () => false, skipGround = false, lakeField = false, hideDuringReflection = () => [] } = {}) {
  const arrays = buildLakeArrays(doc, { bbox, terrain, modelBridge });
  const group = new THREE.Group();
  group.name = 'CopenhagenLakes';

  // ground plane with the lakes cut out
  // (with terrain: the terrain mesh, whose cut cells follow the lake outlines; otherwise the flat plane)
  // (`skipGround`: the streamed city cuts the ground into tiles itself, js/ground-stream.js; this still applies the ground shader)
  const g = skipGround ? null : terrain && !terrain.flat ? buildTerrainMeshArrays(terrain, { uvSize: size }) : groundWithHoles(size, arrays.cutRings, arrays.islands);
  const groundGeometry = new THREE.BufferGeometry();
  if (g) {
    groundGeometry.setAttribute('position', new THREE.Float32BufferAttribute(g.position, 3));
    groundGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    groundGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.normal || Array.from(g.position, (_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    groundGeometry.setIndex(new THREE.Uint32BufferAttribute(g.index, 1));
  }
  // fine-gravel lake path + grass (js/ground-shader-cph.js); the same raster answers `lakeDistance` (tree species context)
  // (`lakeField`: the streamed city paints its ground with a window raster, js/water-stream.js; only the lake distance is made here)
  const groundFieldInfo = parks ? applyGroundField(groundMaterial, doc, parks, { bbox }) : lakeField ? { field: groundField(doc, [], { bbox }) } : null;
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = 'CopenhagenGround';
  ground.receiveShadow = true;
  ground.frustumCulled = false;

  // shore-distance field texture
  const field = shoreDistanceField(doc, { bbox });
  const sdf = new THREE.DataTexture(field.data, field.width, field.height, THREE.RedFormat, THREE.UnsignedByteType);
  sdf.magFilter = sdf.minFilter = THREE.LinearFilter;
  sdf.wrapS = sdf.wrapT = THREE.ClampToEdgeWrapping;
  sdf.generateMipmaps = false;
  sdf.needsUpdate = true;

  const { material, reflectorNode } = createWaterMaterial({ sdf, bbox, planar: planar ? { resolutionScale: 0.4 } : null, level: arrays.level });
  const water = new THREE.Mesh(toGeometry(arrays.surface), material);
  water.name = 'lake-water';
  water.receiveShadow = true;
  water.frustumCulled = false;
  water.raycast = () => {};
  group.add(water);
  let lakeWalls = null;
  if (reflectorNode) {
    group.add(reflectorNode.target);
    patchPlanarReflector(reflectorNode, scene, () => [lakeWalls, ...hideDuringReflection()]);
  }
  const wallMaterial = createLakeWallMaterial();
  const walls = new THREE.Mesh(toGeometry(arrays.walls, { uv: true, kind: true }), wallMaterial);
  walls.name = 'lake-walls';
  walls.receiveShadow = walls.castShadow = true;
  group.add(walls);
  lakeWalls = walls;
  if (arrays.soffit.index.length) {
    const soffit = new THREE.Mesh(toGeometry(arrays.soffit, { uv: true, kind: true }), wallMaterial);
    soffit.name = 'lake-bridge-soffit';
    soffit.receiveShadow = true;
    group.add(soffit);
  }
  scene.add(group);

  let camera = null;
  const state = { planar: !!reflectorNode, active: !!reflectorNode };
  const setPlanar = (on) => {
    if (!reflectorNode || state.active === on) return;
    state.active = on;
    reflectorNode.reflector.updateBeforeType = on ? NodeUpdateType.FRAME : NodeUpdateType.NONE;
  };
  return {
    group, ground, water, material, walls, field, state, setPlanar,
    lakeDistance: groundFieldInfo ? lakeDistanceFrom(groundFieldInfo.field) : null,
    stats: { ...arrays.stats, surfaceTriangles: arrays.surface.index.length / 3, groundTriangles: g ? g.index.length / 3 : 0 },
    level: arrays.level,
    attach: ({ camera: cam }) => { camera = cam; },
    // the reflection pass renders the whole scene again: skip it from high above or far from the lakes
    update: () => { if (camera) setPlanar(camera.position.y < 450 && camera.position.y > arrays.level + 0.2); }
  };
}

export { buildLakes, createWaterMaterial, createLakeWallMaterial, patchPlanarReflector, toGeometry };
