import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, uniform, attribute, positionWorld, cameraPosition, normalize, length, dot, pow, mix, clamp,
  smoothstep, sin, cos, time, texture, max, fract, floor, transformNormalToView, reflector, reflect, step, NodeUpdateType
} from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { buildLakeArrays, groundWithHoles, shoreDistanceField, WATER } from './lakes-cph.js';

// js/water-cph.js
// The Soerne as water: sunken lake surface with TSL ripples, fresnel sky/planar reflection and a soft shoreline, held by
// granite lake walls and a coping (geometry and data in js/lakes-cph.js, tools/cph-geodata/lakes.py). The ground plane is
// cut open over the lakes so no ground shows through; bridges over water get a soffit and fascia.
//   ?water=simple   sky reflection only (no planar reflection pass)      ?debug=nowater   the old grey ground, no lakes

const DEEP = [0.010, 0.040, 0.040]; // linear: dark green-blue Soerne water
const SHALLOW = [0.045, 0.085, 0.060]; // algae-green rim
const ALGAE = [0.020, 0.045, 0.022];

// [direction (rad), wavelength (m), amplitude (m), speed (rad/s)]: a gentle wind chop with long swell
const WAVES = [
  [0.35, 9.0, 0.022, 0.85], [1.90, 3.7, 0.013, 1.15], [2.85, 1.7, 0.0075, 1.5],
  [4.40, 0.9, 0.0042, 1.9], [5.55, 0.48, 0.0026, 2.3], [0.95, 0.26, 0.0014, 2.8]
];

function toGeometry(a, { uv = false, kind = false } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3));
  if (a.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(a.normal, 3));
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
    const stone = mix(vec3(0.15, 0.15, 0.155), vec3(0.34, 0.325, 0.31), id.mul(id));
    const grain = hash1(vec2(floor(wuv.x.mul(14.0)), floor(v.mul(14.0)))).mul(0.18).add(0.91);
    const wall = mix(vec3(0.05, 0.05, 0.05), stone.mul(grain), edge.mul(0.7).add(0.3));
    // wet, dark and green in the splash zone at the water line (-0.8 m); the wall below it is under water
    const wet = smoothstep(-0.2, -0.78, wuv.y);
    const slime = smoothstep(-0.55, -0.82, wuv.y).mul(0.75);
    const wallWet = mix(mix(wall, wall.mul(0.45), wet), vec3(...ALGAE), slime);
    // coping: a lighter, smoother granite slab; its pattern runs along the edge
    const copeId = hash1(vec2(floor(wuv.x.div(1.4)), 7.7));
    const cope = mix(vec3(0.30, 0.29, 0.28), vec3(0.42, 0.40, 0.38), copeId).mul(grain);
    const concrete = vec3(0.16, 0.16, 0.165).mul(grain);
    const isCope = step(0.5, kind).mul(step(kind, 1.5));
    const isConcrete = step(1.5, kind);
    return mix(mix(wallWet, cope, isCope), concrete, isConcrete);
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

function createWaterMaterial({ sdf, bbox, planar }) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.045, metalness: 0, envMapIntensity: 1.0 });
  material.name = 'cph-water';
  const wp = positionWorld;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const V = toCam.div(max(dist, 0.001));

  // distance to the nearest wall: smooths the ripples and drives the shore colour
  const [x0, z0, x1, z1] = bbox;
  const sdfUv = vec2(wp.x.sub(x0).div(x1 - x0), wp.z.sub(z0).div(z1 - z0));
  const shore = texture(sdf, sdfUv).r.mul(WATER.shoreMax);
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
  // a slow second-scale cross swell so the pattern never lines up
  sx = sx.mul(calm);
  sz = sz.mul(calm);
  const N = normalize(vec3(sx.negate(), 1.0, sz.negate()));
  material.normalNode = transformNormalToView(N);

  const NdotV = max(dot(N, V), 0.0);
  const fresnel = clamp(float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5.0))), 0.0, 1.0);

  // body colour: murky green-blue, lighter and greener towards the wall (shallow rim)
  const rim = float(1).sub(smoothstep(0.0, 3.5, shore));
  material.colorNode = mix(vec3(...DEEP), vec3(...SHALLOW), rim);

  // reflection: planar (buildings, trees, bridge) or sky only; contact-darkened right at the wall
  const contact = smoothstep(0.0, 1.2, shore).mul(0.45).add(0.55);
  let reflection;
  let reflectorNode = null;
  if (planar) {
    reflectorNode = reflector({ resolutionScale: planar.resolutionScale ?? 0.5, bounces: false });
    reflectorNode.target.rotateX(-Math.PI / 2);
    reflectorNode.target.position.y = WATER.surfaceY;
    reflectorNode.uvNode = reflectorNode.uvNode.add(vec2(sx, sz).mul(0.06));
    reflection = reflectorNode.rgb;
  } else {
    const r = reflect(V.negate(), N);
    reflection = skyColourAt(normalize(vec3(r.x, max(r.y, 0.01), r.z)));
  }
  // foam-free but alive shoreline: a thin lighter band where the ripples lap the wall
  const lap = smoothstep(0.55, 0.0, shore).mul(sin(wp.x.mul(2.1).add(wp.z.mul(1.7)).sub(time.mul(1.6))).mul(0.5).add(0.5)).mul(0.035);
  material.emissiveNode = (globalThis.__waterDebug === 'refl' ? reflection : reflection.mul(fresnel).mul(contact)).add(vec3(0.05, 0.075, 0.06).mul(lap));
  return { material, reflectorNode };
}

/**
 * Builds the lakes into `scene`. Returns { group, ground, water, material, stats, update, attach, setPlanar }.
 * `ground` is the cut ground mesh (replaces the plain plane); `update(x, z)` gates the planar reflection pass.
 */
function buildLakes(scene, doc, { groundMaterial, size = 8000, bbox = [-750, -750, 750, 750], planar = true } = {}) {
  const arrays = buildLakeArrays(doc, { bbox });
  const group = new THREE.Group();
  group.name = 'CopenhagenLakes';

  // ground plane with the lakes cut out
  const g = groundWithHoles(size, arrays.cutRings, arrays.islands);
  const groundGeometry = new THREE.BufferGeometry();
  groundGeometry.setAttribute('position', new THREE.Float32BufferAttribute(g.position, 3));
  groundGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
  groundGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.position.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  groundGeometry.setIndex(new THREE.Uint32BufferAttribute(g.index, 1));
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

  const { material, reflectorNode } = createWaterMaterial({ sdf, bbox, planar: planar ? { resolutionScale: 0.5 } : null });
  const water = new THREE.Mesh(toGeometry(arrays.surface), material);
  water.name = 'lake-water';
  water.receiveShadow = true;
  water.frustumCulled = false;
  water.raycast = () => {};
  group.add(water);
  let lakeWalls = null;
  if (reflectorNode) {
    group.add(reflectorNode.target);
    // The planar pass renders the scene from inside the main pass without the main pass' MRT: it must not re-render the
    // shadow maps (they are already current), and materials that only write MRT attachments (contact shadows, flares,
    // steam: `mrtNode`) would compile to empty fragment outputs, so they are hidden from the reflection.
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
          if (m && (Array.isArray(m) ? m.some((x) => x.mrtNode) : m.mrtNode)) mrtOnly.push(o);
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
      const wallVis = lakeWalls.visible;
      lakeWalls.visible = false;
      const render = renderer.render;
      renderer.render = function patched(sc, cam) {
        if (cam !== f.camera) for (const k of [2, 6, 10, 14]) cam.projectionMatrix.elements[k] = mainProj[k];
        return render.call(this, sc, cam);
      };
      try { original(f); } finally {
        renderer.render = render;
        lakeWalls.visible = wallVis;
        shadows.forEach((sh, i) => { sh.autoUpdate = saved[i]; });
        mrtOnly.forEach((o, i) => { o.visible = visible[i]; });
      }
    };
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
    stats: { ...arrays.stats, surfaceTriangles: arrays.surface.index.length / 3, groundTriangles: g.index.length / 3 },
    attach: ({ camera: cam }) => { camera = cam; },
    // the reflection pass renders the whole scene again: skip it from high above or far from the lakes
    update: () => { if (camera) setPlanar(camera.position.y < 450 && camera.position.y > WATER.surfaceY + 0.2); }
  };
}

export { buildLakes, createWaterMaterial, createLakeWallMaterial };
