import * as THREE from 'three/webgpu';
import { CAR_BODY_TYPES } from './vehicle-fleet.js';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, createLoftedCarMaterial } from './actor-models.js';
import {
  TREE_STYLES, buildFurniturePlan, composeYaw, composeYawPitch, indexItems, planCounts
} from './street-furniture-data.js';
import * as G from './street-furniture-geometry.js';
import * as T from './tree-geometry-cph.js';
import { resolveGenus } from './tree-species-cph.js';
import { alignLakeFurniture } from './lake-furniture-cph.js';
import { buildPoolWindow, encodePoolWindow, haloSize, lampPhotometry, realIntensity, selectRealLights } from './night-lights-cph.js';
import { POOL, poolUniforms, setPoolWindow } from './pool-light-cph.js';
import { Fn, attribute, cameraPosition, cross, float, length, mix, normalize, positionLocal, smoothstep, uniform, uv, vec3, vec4, exp, abs } from 'three/tsl';

// js/street-furniture-cph.js
// The Copenhagen street furniture (data/cph-furniture.json, see street-furniture-data.js): trees by genus with three
// levels of detail, Københavnermast / tube / park poles and wire-hung luminaires on catenaries that glow at night with a
// ground light pool and a few real lights near the camera, parked cars filling the bays, bins, bollards, benches, bike
// racks with bikes, parking meters, bus-stop equipment, rescue posts and monuments with labels.
//
// Everything is instanced. Each category lives in a quadtree; every few metres of camera travel the items around the
// camera are written into per-LOD InstancedMeshes (dynamic counts), at the ground height computed once at load.

const TREE_NEAR = 34;
const TREE_MID = 200;
const TREE_FAR = 950;
const CAR_NEAR = 40;
const CAR_FAR = 300;
const MOVE_EPS = 3;
const MAX_LIGHTS = 8;
const WARM_FRAMES = 4; // while the shaders warm up, every mesh draws a degenerate instance so its pipeline compiles

const lin = (srgb) => new THREE.Color().setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace);

/** One InstancedMesh with a write cursor. `paint` (cars): the geometry carries instanced paintColor/carState attributes. */
class MeshSet {
  constructor(name, geometry, material, capacity, { colored = false, tinted = false, cast = false, receive = true, paint = false, parent = null } = {}) {
    this.name = name;
    this.capacity = Math.max(1, capacity);
    this.paint = paint;
    this.tinted = tinted;
    if (paint) {
      geometry.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3));
      geometry.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4));
    }
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.name = name;
    this.mesh.castShadow = cast;
    this.mesh.receiveShadow = receive;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    if (colored) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    }
    this.colors = this.mesh.instanceColor ? this.mesh.instanceColor.array : null;
    if (tinted) {
      geometry.setAttribute('bikePaint', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3));
      this.tints = geometry.attributes.bikePaint.array;
    } else this.tints = null;
    this.matrices = this.mesh.instanceMatrix.array;
    this.n = 0;
    if (parent) parent.add(this.mesh);
  }

  begin() {
    this.n = 0;
  }

  full() {
    return this.n >= this.capacity;
  }

  /** Reserves a slot and writes translate * rotateY * scale; returns the slot (or -1 when full). */
  put(x, y, z, yaw, sx = 1, sy = 1, sz = 1, color = null, paint = null, lean = 0) {
    if (this.n >= this.capacity) return -1;
    const i = this.n++;
    if (lean) {
      const o = i * 16;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const cl = Math.cos(lean);
      const sl = Math.sin(lean);
      this.matrices[o] = c * cl * sx; this.matrices[o + 1] = sl * sx; this.matrices[o + 2] = -s * cl * sx; this.matrices[o + 3] = 0;
      this.matrices[o + 4] = -c * sl * sy; this.matrices[o + 5] = cl * sy; this.matrices[o + 6] = s * sl * sy; this.matrices[o + 7] = 0;
      this.matrices[o + 8] = s * sz; this.matrices[o + 9] = 0; this.matrices[o + 10] = c * sz; this.matrices[o + 11] = 0;
      this.matrices[o + 12] = x; this.matrices[o + 13] = y; this.matrices[o + 14] = z; this.matrices[o + 15] = 1;
    } else composeYaw(this.matrices, i * 16, x, y, z, yaw, sx, sy, sz);
    if (color && this.colors) this.colors.set(color, i * 3);
    if (color && this.tints) this.tints.set(color, i * 3);
    if (paint) this.mesh.geometry.attributes.paintColor.array.set(paint, i * 3);
    return i;
  }

  putPitch(x, y, z, yaw, pitch, sx, sy, sz) {
    if (this.n >= this.capacity) return -1;
    const i = this.n++;
    composeYawPitch(this.matrices, i * 16, x, y, z, yaw, pitch, sx, sy, sz);
    return i;
  }

  end(warm) {
    if (this.n === 0 && warm) {
      composeYaw(this.matrices, 0, 0, -50, 0, 0, 0.001, 0.001, 0.001);
      this.mesh.count = 1;
    } else {
      this.mesh.count = this.n;
    }
    this.mesh.visible = this.mesh.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.colors && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.tints) this.mesh.geometry.attributes.bikePaint.needsUpdate = true;
    if (this.paint) {
      this.mesh.geometry.attributes.paintColor.needsUpdate = true;
      this.mesh.geometry.attributes.carState.needsUpdate = true;
    }
  }
}

const std = (opts = {}) => new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15, ...opts });
const bikeMaterial = () => {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: false, roughness: 0.74, metalness: 0.12 });
  const base = attribute('color', 'vec3');
  const tint = attribute('bikePaint', 'vec3');
  const mask = attribute('frameTint', 'float');
  mat.colorNode = base.mul(mix(vec3(1), tint, mask));
  return mat;
};

function textSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(18,20,22,0.72)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 504, 80, 14);
  ctx.fill();
  ctx.fillStyle = '#f3efe6';
  ctx.font = '600 38px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.length > 28 ? `${text.slice(0, 27)}…` : text, 256, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.6, 0.675, 1);
  return sprite;
}

export function createStreetFurniture(scene, doc, { groundHeight = null, seed = 1, place = null, lakeDistance = null } = {}) {
  // untyped laser-detected crowns get a context genus (Soerne avenues: lime / horse chestnut), js/tree-species-cph.js
  const plan = buildFurniturePlan(doc, groundHeight, { seed, place, resolveTree: (t) => resolveGenus(t, { lakeDistance }) });
  alignLakeFurniture(plan, lakeDistance); // benches / rescue posts face the water, lake lights project over the path
  const group = new THREE.Group();
  group.name = 'CopenhagenStreetFurniture';
  scene.add(group);
  const sets = [];
  const mk = (name, geo, mat, cap, opts) => {
    const s = new MeshSet(name, geo, mat, cap, { ...opts, parent: group });
    sets.push(s);
    return s;
  };
  const count = (n, cap) => Math.max(1, Math.min(n, cap));

  // ------------------------------------------------------------------------------------------- trees
  const atlas = T.createLeafAtlas();
  const treeMat = T.createTreeMaterial(atlas);
  const byGenus = new Map();
  for (const t of plan.trees) {
    if (!byGenus.has(t.genus)) byGenus.set(t.genus, []);
    byGenus.get(t.genus).push(t);
  }
  const bill = T.createBillboardAtlas([...byGenus.keys()]);
  const billMat = T.createTreeMaterial(bill.texture, { billboard: true });
  const treeNear = new Map();
  const treeMid = new Map();
  const treeFar = new Map();
  for (const [genus, list] of byGenus) {
    treeNear.set(genus, mk(`trees-near-${genus}`, T.buildNearTree(genus), treeMat, count(list.length, 260), { colored: true, cast: false }));
    treeMid.set(genus, mk(`trees-mid-${genus}`, T.buildMidTree(genus), treeMat, count(list.length, 900), { colored: true, cast: false }));
    treeFar.set(genus, mk(`trees-far-${genus}`, T.buildBillboard(bill.cellOf.get(genus)), billMat, count(list.length, 4000), { colored: true, receive: false }));
  }
  // crowns cast their shadow from a cheap blob (leaf cards in the shadow pass cost more than the whole scene)
  const shadowOnly = std({ roughness: 1, metalness: 0 });
  shadowOnly.colorWrite = false;
  shadowOnly.depthWrite = false;
  const treeShadow = mk('trees-shadow', G.buildMidCrown(), shadowOnly, count(plan.trees.length, 600), { cast: true, receive: false });

  // ------------------------------------------------------------------------------------------- lamps
  const metal = std({ roughness: 0.45, metalness: 0.55 });
  const lensMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const masts = plan.lamps.filter((l) => l.mount === 'mast');
  const wires = plan.lamps.filter((l) => l.mount === 'wire');
  const nMast = (kind) => masts.filter((l) => l.pole === kind).length;
  const pole = mk('lamp-poles', G.buildPole(), metal, count(masts.length + 100, 800), { cast: true, colored: false });
  const poleBase = {
    kbh: mk('lamp-base-kbh', G.buildPoleBase('kbh'), metal, count(nMast('kbh'), 200), { cast: true }),
    tube: mk('lamp-base-tube', G.buildPoleBase('tube'), metal, count(nMast('tube') + 100, 600), { cast: true }),
    park: mk('lamp-base-park', G.buildPoleBase('park'), metal, count(nMast('park'), 200), { cast: true })
  };
  const mastHead = mk('lamp-heads', G.buildMastHead(), metal, count(masts.length, 700), { cast: true });
  const mastLens = mk('lamp-lens-mast', G.buildMastLens(), lensMat, count(masts.length, 700), { colored: true, receive: false });
  const parkHead = mk('lamp-heads-park', G.buildParkHead(), metal, count(nMast('park'), 200), { cast: true });
  const parkLens = mk('lamp-lens-park', G.buildParkLens(), lensMat, count(nMast('park'), 200), { colored: true, receive: false });
  const pendant = mk('lamp-pendants', G.buildPendant(), metal, count(wires.length, 800), { cast: true });
  const pendantLens = mk('lamp-lens-wire', G.buildPendantLens(), lensMat, count(wires.length + plan.lakeLights.length, 800), { colored: true, receive: false });
  const wireSeg = mk('lamp-wires', G.buildWireSegment(), std({ roughness: 0.6, metalness: 0.5 }), 5000, {});
  wireSeg.mesh.material.vertexColors = false;
  wireSeg.mesh.material.color.setHex(0x23262a);
  // glare halos on the lanterns: camera-facing additive quads, sized by distance, switched with the night factor
  const haloOn = uniform(0);
  const haloCap = count(plan.lamps.length + plan.lakeLights.length, 1100);
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  haloGeo.setAttribute('haloPos', new THREE.InstancedBufferAttribute(new Float32Array(haloCap * 4), 4));
  haloGeo.setAttribute('haloCol', new THREE.InstancedBufferAttribute(new Float32Array(haloCap * 3), 3));
  const haloMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  haloMat.positionNode = Fn(() => {
    const hp = attribute('haloPos', 'vec4');
    const toCam = normalize(cameraPosition.sub(hp.xyz));
    const right = normalize(cross(vec3(0, 1, 0), toCam));
    const up = cross(toCam, right);
    return hp.xyz.add(right.mul(positionLocal.x).mul(hp.w)).add(up.mul(positionLocal.y).mul(hp.w));
  })();
  haloMat.colorNode = Fn(() => {
    const hp = attribute('haloPos', 'vec4');
    const p = uv().sub(0.5).mul(2.0);
    const r = length(p);
    const core = exp(r.mul(r).mul(-26.0));
    const glow = exp(r.mul(-3.2)).mul(smoothstep(1.0, 0.55, r));
    const star = exp(abs(p.y).mul(-38.0)).mul(exp(abs(p.x).mul(-2.4))).add(exp(abs(p.x).mul(-38.0)).mul(exp(abs(p.y).mul(-2.4)))).mul(0.22);
    const dist = length(cameraPosition.sub(hp.xyz));
    return attribute('haloCol', 'vec3').mul(core.mul(1.6).add(glow.mul(0.5)).add(star)).mul(haloOn).mul(smoothstep(1.5, 5.0, dist));
  })();
  const halos = new THREE.InstancedMesh(haloGeo, haloMat, haloCap);
  halos.name = 'lamp-halos';
  halos.frustumCulled = false;
  halos.renderOrder = 6;
  halos.count = 0;
  for (let i = 0; i < haloCap; i++) new THREE.Matrix4().toArray(halos.instanceMatrix.array, i * 16);
  group.add(halos);
  let haloN = 0;
  const putHalo = (x, y, z, size, c, gain = 1) => {
    if (haloN >= haloCap) return;
    haloGeo.attributes.haloPos.array.set([x, y, z, size], haloN * 4);
    haloGeo.attributes.haloCol.array.set([c.r * gain, c.g * gain, c.b * gain], haloN * 3);
    haloN++;
  };
  const poolBytes = new Uint8Array(POOL.size * POOL.size * 4);
  let poolData = null;
  // lake lights as lamp-like items for the pool raster
  const lakeLamps = plan.lakeLights.map((l) => ({ x: l.x, z: l.z, y: l.y, lampY: l.y + 1, light: 'led', led: true, cct: 3000, watt: 12, kind: 'lake', color: l.color }));

  // real lights near the camera (a fixed pool: the light count must not change, it would recompile every shader)
  const lights = [];
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffd9a0, 0, 18, 2);
    l.visible = true;
    group.add(l);
    lights.push(l);
  }

  // ------------------------------------------------------------------------------------------- cars
  const carSets = {};
  for (const body of CAR_BODY_TYPES) {
    const spec = { ...BODY_SPECS[body], taxiSign: false };
    const mat = createLoftedCarMaterial(spec);
    const n = plan.cars.filter((c) => c.body === body).length;
    carSets[body] = {
      near: mk(`parked-${body}-near`, buildCarGeometry(spec, true), mat, count(n, 450), { cast: true, paint: true }),
      far: mk(`parked-${body}-far`, buildCarProxyGeometry(spec), mat, count(n, 1600), { paint: true })
    };
  }

  // ------------------------------------------------------------------------------------------- props
  const bollardRound = mk('bollards-round', G.buildBollardRound(), std({ roughness: 0.5, metalness: 0.6 }), count(plan.bollards.length, 500), { colored: true, cast: true });
  const bollardGranite = mk('bollards-granite', G.buildBollardGranite(), std({ roughness: 0.9, metalness: 0 }), count(plan.bollards.length, 300), { colored: true, cast: true });
  const bins = mk('bins', G.buildBin(), std({ roughness: 0.6, metalness: 0.3 }), count(plan.bins.length, 700), { colored: true, cast: true });
  const wheelies = mk('bin-stands', G.buildWheelies(), std({ roughness: 0.8, metalness: 0 }), count(plan.stands.length, 800), { cast: true });
  const glass = mk('glass-containers', G.buildGlassContainers(), std({ roughness: 0.6, metalness: 0.1 }), count(plan.glass.length, 40), { cast: true });
  const benches = mk('benches', G.buildBench(), std({ roughness: 0.75, metalness: 0.1 }), count(plan.benches.length, 1000), { cast: true });
  const hoops = mk('bike-hoops', G.buildHoop(), std({ roughness: 0.4, metalness: 0.8 }), count(plan.hoops.length, 1800), { cast: false });
  const bikeVariants = ['city', 'mens', 'city-crate', 'city-childseat', 'cargo-longjohn', 'cargo-trike'];
  const bikeMat = bikeMaterial();
  const bikesNear = Object.fromEntries(bikeVariants.map((variant) => [variant, mk(
    `bikes-${variant}-near`, G.buildBike(variant), bikeMat, count(plan.bikes.length, 1500), { tinted: true, cast: true }
  )]));
  const bikesFar = mk('bikes-proxy-far', G.buildBikeProxy(), bikeMat, count(plan.bikes.length, 4500), { tinted: true, cast: false });
  const meters = mk('parking-meters', G.buildMeter(), std({ roughness: 0.5, metalness: 0.3 }), count(plan.meters.length, 100), { cast: true });
  const flags = mk('bus-flags', G.buildFlag(), std({ roughness: 0.5, metalness: 0.3 }), count(plan.flags.length, 100), { cast: true });
  const shelters = mk('bus-shelters', G.buildShelter(), std({ roughness: 0.35, metalness: 0.4 }), count(plan.shelters.length, 100), { cast: true });
  const countdowns = mk('bus-countdowns', G.buildCountdown(), std({ roughness: 0.4, metalness: 0.2 }), count(plan.countdowns.length, 100), {});
  const rescue = mk('rescue-posts', G.buildRescuePost(), std({ roughness: 0.5, metalness: 0.2 }), count(plan.rescue.length, 60), { cast: true });
  const lakePosts = mk('lake-posts', G.buildLakePost(), std({ roughness: 0.5, metalness: 0.5 }), count(plan.lakeLights.length, 200), { cast: true });
  const plinths = mk('monuments', G.buildPlinth(), std({ roughness: 0.8, metalness: 0.1 }), count(plan.monuments.length, 200), { cast: true });

  // ------------------------------------------------------------------------------------------- indexes and update
  const trees = indexItems(plan.trees);
  const lampIndex = indexItems(plan.lamps);
  const carIndex = indexItems(plan.cars);
  const small = {
    meters: indexItems(plan.meters), bins: indexItems(plan.bins), stands: indexItems(plan.stands), glass: indexItems(plan.glass),
    bollards: indexItems(plan.bollards), benches: indexItems(plan.benches), hoops: indexItems(plan.hoops), bikes: indexItems(plan.bikes),
    flags: indexItems(plan.flags), shelters: indexItems(plan.shelters), countdowns: indexItems(plan.countdowns),
    rescue: indexItems(plan.rescue), lakeLights: indexItems(plan.lakeLights), monuments: indexItems(plan.monuments)
  };

  const BIN_COLOURS = [lin([0.17, 0.30, 0.22]), lin([0.30, 0.32, 0.33])];
  const BOLLARD_COLOURS = { galvanised: lin([0.62, 0.65, 0.67]), granite: lin([0.5, 0.49, 0.47]), other: lin([0.34, 0.36, 0.37]) };
  const BOLLARD_GREEN = lin([0.14, 0.26, 0.18]);
  const BOLLARD_GREY = lin([0.42, 0.44, 0.45]);
  const BIKE_COLOURS = [0x16181a, 0x25282b, 0x191b20, 0x25313d, 0x26352c, 0x505e57, 0x9caeae, 0xb6b3a4, 0xc1bda9, 0xa35d38].map((c) => new THREE.Color(c));
  const colorArr = (c, k = 1) => [c.r * k, c.g * k, c.b * k];

  const labelPool = [];
  const labelFor = new Map();
  const state = {
    x: Infinity, z: Infinity, on: 0, warm: WARM_FRAMES, frames: 0, lastOn: -1, nightFactor: 0,
    stats: { rebuilds: 0, rebuildMs: 0 }, camera: { x: 0, y: 2, z: 0 }
  };
  const seen = new Set();
  const nearLamps = [];
  const allLamps = plan.lamps.concat(lakeLamps);

  function rebuild(cx, cz) {
    const t0 = performance.now();
    const warm = state.warm > 0;
    for (const s of sets) s.begin();
    haloN = 0;
    const on = state.on;

    // trees: skeleton + leaf sprays near, leaf clusters mid, painted billboards far
    for (const t of trees.queryRange(cx, cz, TREE_FAR)) {
      const d = Math.hypot(t.x - cx, t.z - cz);
      const tint = [t.tint, t.tint, t.tint];
      if (d <= TREE_NEAR) {
        treeNear.get(t.genus).put(t.x, t.y, t.z, t.yaw, t.sxz, t.sy, t.sxz, tint);
        if (d <= 90) treeShadow.put(t.x, t.y + t.crown.cy, t.z, t.yaw, t.crown.rx * 0.9, t.crown.ry * 0.9, t.crown.rx * 0.9);
      } else if (d <= TREE_MID) {
        treeMid.get(t.genus).put(t.x, t.y, t.z, t.yaw, t.sxz, t.sy, t.sxz, tint);
        if (d <= 90) treeShadow.put(t.x, t.y + t.crown.cy, t.z, t.yaw, t.crown.rx * 0.9, t.crown.ry * 0.9, t.crown.rx * 0.9);
      } else {
        treeFar.get(t.genus).put(t.x, t.y, t.z, t.yaw, t.crownR * 2.3, t.height * 1.02, t.crownR * 2.3, tint);
      }
    }

    // lamps
    seen.clear();
    nearLamps.length = 0;
    for (const l of lampIndex.queryRange(cx, cz, 240)) {
      const d = Math.hypot(l.x - cx, l.z - cz);
      if (l.mount === 'mast') {
        if (l.pole === 'park') {
          pole.put(l.x, l.y, l.z, 0, 1, Math.max(1, l.poleH - 0.1), 1);
          poleBase.park.put(l.x, l.y, l.z, 0);
          parkHead.put(l.x, l.lampY - 0.1, l.z, 0);
          parkLens.put(l.x, l.lampY - 0.1, l.z, 0, 1, 1, 1, colorArr(lin(l.color), 1));
        } else {
          pole.put(l.x, l.y, l.z, 0, 1, l.poleH, 1);
          poleBase[l.pole === 'kbh' ? 'kbh' : 'tube'].put(l.x, l.y, l.z, 0);
          mastHead.put(l.x, l.lampY, l.z, l.yaw);
          mastLens.put(l.x, l.lampY, l.z, l.yaw, 1, 1, 1, colorArr(lin(l.color), 1));
        }
      } else if (l.wire) {
        pendant.put(l.x, l.lampY, l.z, 0);
        pendantLens.put(l.x, l.lampY, l.z, 0, 1, 1, 1, colorArr(lin(l.color), 1));
        if (d < 190) {
          const key = `${l.wire.pts[0]},${l.wire.pts[2]}`;
          if (!seen.has(key)) {
            seen.add(key);
            const p = l.wire.pts;
            for (let i = 0; i + 5 < p.length; i += 3) {
              const dx = p[i + 3] - p[i];
              const dy = p[i + 4] - p[i + 1];
              const dz = p[i + 5] - p[i + 2];
              const horiz = Math.hypot(dx, dz);
              wireSeg.putPitch(p[i], p[i + 1], p[i + 2], Math.atan2(dx, dz), -Math.atan2(dy, horiz), 1, 1, Math.hypot(dx, dy, dz));
            }
          }
        }
      } else {
        // a wire lamp without wire geometry (no span found): stand it on a tube pole instead of hanging it in the air
        pole.put(l.x, l.y, l.z, 0, 1, 6.2, 1);
        poleBase.tube.put(l.x, l.y, l.z, 0);
        pendant.put(l.x, l.y + 6.5, l.z, 0);
        pendantLens.put(l.x, l.y + 6.5, l.z, 0, 1, 1, 1, colorArr(lin(l.color), 1));
      }
      if (on > 0.01 && d < 170) {
        const photo = l.photo || (l.photo = lampPhotometry(l));
        putHalo(l.x, l.lampY - 0.12, l.z, haloSize(photo, d), lin(l.color), 0.9 + photo.lumens / 20000);
        nearLamps.push(l);
      }
    }

    // parked cars
    for (const c of carIndex.queryRange(cx, cz, CAR_FAR)) {
      const d = Math.hypot(c.x - cx, c.z - cz);
      const set = carSets[c.body][d <= CAR_NEAR ? 'near' : 'far'];
      set.put(c.x, c.y, c.z, c.yaw, 1, 1, 1, null, colorArr(lin(c.paint), c.shade));
    }

    // props
    for (const b of small.bollards.queryRange(cx, cz, 110)) {
      if (b.material === 'granite') bollardGranite.put(b.x, b.y, b.z, 0, 1, 1, 1, colorArr(BOLLARD_COLOURS.granite));
      else bollardRound.put(b.x, b.y, b.z, 0, 1, 1, 1, colorArr(b.colour === 'green' ? BOLLARD_GREEN : b.colour === 'grey' ? BOLLARD_GREY : BOLLARD_COLOURS[b.material] || BOLLARD_COLOURS.other));
    }
    for (const b of small.bins.queryRange(cx, cz, 110)) bins.put(b.x, b.y, b.z, b.yaw, 1, 1, 1, colorArr(BIN_COLOURS[(Math.abs(Math.round(b.x * 7 + b.z * 13)) % 3) === 0 ? 1 : 0]));
    for (const b of small.stands.queryRange(cx, cz, 50)) wheelies.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.glass.queryRange(cx, cz, 140)) glass.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.benches.queryRange(cx, cz, 110)) benches.put(b.x, b.y, b.z, b.yaw, (b.length || 1.8) / 1.8, 1, 1);
    for (const b of small.hoops.queryRange(cx, cz, 60)) hoops.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.bikes.queryRange(cx, cz, 120)) {
      const d = Math.hypot(b.x - cx, b.z - cz);
      if (d > 120) continue;
      const color = colorArr(BIKE_COLOURS[b.hue % BIKE_COLOURS.length]);
      const variant = bikesNear[b.variant] ? b.variant : 'city';
      const set = d <= 40 ? bikesNear[variant] : bikesFar;
      set.put(b.x, b.y, b.z, b.yaw, b.size || 1, b.size || 1, b.size || 1, color, null, b.lean || 0);
    }
    for (const b of small.meters.queryRange(cx, cz, 110)) meters.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.flags.queryRange(cx, cz, 220)) flags.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.shelters.queryRange(cx, cz, 240)) shelters.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.countdowns.queryRange(cx, cz, 120)) countdowns.put(b.x, b.y, b.z, b.yaw);
    for (const b of small.rescue.queryRange(cx, cz, 200)) rescue.put(b.x, b.y, b.z, b.yaw);
    for (const m of small.monuments.queryRange(cx, cz, 300)) plinths.put(m.x, m.y, m.z, 0);
    for (const l of small.lakeLights.queryRange(cx, cz, 160)) {
      lakePosts.put(l.x, l.y, l.z, 0);
      pendantLens.put(l.x, l.y + 0.97, l.z, 0, 0.3, 1, 0.3, colorArr(lin(l.color), 1));
      if (on > 0.01) putHalo(l.x, l.y + 0.97, l.z, 0.35 + Math.hypot(l.x - cx, l.z - cz) * 0.012, lin(l.color), 0.5);
    }

    for (const s of sets) s.end(warm);
    halos.count = haloN;
    halos.visible = haloN > 0;
    haloGeo.attributes.haloPos.needsUpdate = true;
    haloGeo.attributes.haloCol.needsUpdate = true;
    if (on > 0.01) {
      // clustered pools: every lantern around the camera splatted into one illuminance raster (js/night-lights-cph.js)
      poolData = buildPoolWindow(allLamps, cx, cz, { size: POOL.size, cell: POOL.cell, target: poolData?.data });
      setPoolWindow(poolData, encodePoolWindow(poolData, { maxLux: POOL.maxLux, out: poolBytes }));
    }
    state.stats.rebuilds++;
    state.stats.rebuildMs = performance.now() - t0;
    assignLights(cx, cz);
  }

  function assignLights(cx, cz) {
    const chosen = state.on < 0.01 ? [] : selectRealLights(nearLamps, cx, cz, MAX_LIGHTS);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = chosen[i];
      const light = lights[i];
      if (!l) {
        light.intensity = 0;
        light.userData.base = 0;
        continue;
      }
      light.position.set(l.x, l.lampY - 0.3, l.z);
      light.color.copy(lin(l.color));
      light.userData.base = realIntensity(l.photo);
      light.intensity = light.userData.base * state.on;
    }
  }

  function updateLabels(cx, cz) {
    const wanted = [];
    for (const m of small.monuments.queryRange(cx, cz, 45)) {
      if (m.name) wanted.push(m);
    }
    for (const sprite of labelPool) sprite.visible = false;
    wanted.slice(0, 6).forEach((m, i) => {
      let sprite = labelFor.get(m.name);
      if (!sprite) {
        sprite = textSprite(m.name);
        labelFor.set(m.name, sprite);
        group.add(sprite);
        labelPool.push(sprite);
      }
      sprite.position.set(m.x, m.y + 2.9, m.z);
      sprite.visible = true;
    });
  }

  function setNight(nightFactor) {
    state.nightFactor = nightFactor;
    const on = Math.min(1, Math.max(0, (nightFactor - 0.1) / 0.4));
    state.on = on * on * (3 - 2 * on);
  }

  function applyNight() {
    lensMat.color.setScalar(0.42 + state.on * 9);
    poolUniforms.on.value = state.on;
    haloOn.value = state.on;
    for (const l of lights) if (l.userData.base) l.intensity = l.userData.base * state.on;
  }

  /** Per frame: (camera x, z, the lighting system's night factor). Rebuilds the instance sets after a few metres of travel. */
  function update(x, z, nightFactor = state.nightFactor) {
    const before = state.on;
    setNight(nightFactor);
    const moved = Math.hypot(x - state.x, z - state.z);
    const nightChanged = Math.abs(state.on - before) > 0.004 || (state.on > 0 && before === 0) || (state.on === 0 && before > 0);
    if (state.frames === 0 || moved > MOVE_EPS || nightChanged || state.warm > 0) {
      rebuild(x, z);
      state.x = x;
      state.z = z;
      updateLabels(x, z);
    }
    if (state.warm > 0) state.warm--;
    state.frames++;
    applyNight();
  }

  return {
    group,
    plan,
    update,
    counts: planCounts(plan),
    sets,
    get stats() {
      return {
        ...state.stats,
        meshes: sets.filter((s) => s.mesh.visible).length,
        instances: sets.reduce((a, s) => a + s.mesh.count, 0),
        night: state.on
      };
    },
    /** For headless checks: instance counts per mesh. */
    meshCounts: () => Object.fromEntries(sets.map((s) => [s.name, s.mesh.count]))
  };
}
