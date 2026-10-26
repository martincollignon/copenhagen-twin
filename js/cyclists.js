import * as THREE from 'three/webgpu';
import { attribute, mix, vec3 } from 'three/tsl';
import { createContactShadowMaterial } from './tsl-materials.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { buildCyclistNetwork, createCyclists } from './cyclist-network.js';
import { signalOffset } from './signal-plan.js';
import { cyclistAppearance } from './cyclist-appearance.js';
import { buildBike, buildBikeProxy } from './street-furniture-geometry.js';

// Cyclist simulation and rider animation keep running independently of the instanced bike batches.
// Near bikes share the parked city/cargo models; distant bikes use one inexpensive silhouette.
const NUM_CYCLISTS = 96;
const NEAR_RADIUS = 40;
const DRAW_RADIUS = 120;
const VARIANTS = ['city', 'mens', 'city-crate', 'city-childseat', 'cargo-longjohn', 'cargo-trike'];

function bikeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.74, metalness: 0.12 });
  mat.colorNode = attribute('color', 'vec3').mul(mix(vec3(1), attribute('bikePaint', 'vec3'), attribute('frameTint', 'float')));
  return mat;
}

/** Fixed-capacity batch with no per-frame mesh allocation. Frame paint leaves tyres and accessories untinted. */
function batch(group, name, geometry, material, { framePaint = false, colored = false, cast = true } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, NUM_CYCLISTS);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (framePaint) geometry.setAttribute('bikePaint', new THREE.InstancedBufferAttribute(new Float32Array(NUM_CYCLISTS * 3), 3));
  if (colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NUM_CYCLISTS * 3), 3);
  group.add(mesh);
  let count = 0;
  return {
    mesh,
    begin() { count = 0; },
    put(matrix, color = null) {
      if (count >= NUM_CYCLISTS) return;
      mesh.setMatrixAt(count, matrix);
      if (color && framePaint) color.toArray(geometry.attributes.bikePaint.array, count * 3);
      if (color && colored) mesh.setColorAt(count, color);
      count++;
    },
    end() {
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (framePaint) geometry.attributes.bikePaint.needsUpdate = true;
      if (colored) mesh.instanceColor.needsUpdate = true;
    }
  };
}

/** The lane graph of `geo` (roads, cycle tracks) with the bike lights of the signalised junctions in `signalNodes`. */
export function buildCyclistNetworkFor(geo, signalNodes = []) {
  return buildCyclistNetwork(geo, signalNodes.map((n) => ({
    x: n.x, z: n.z, sigOffset: n.sigOffset ?? signalOffset(n.x, n.z), arms: n.arms
  })));
}

/**
 * @param scene the three.js scene
 * @param geo data/cph-geodata.json
 * @param signalNodes road-network nodes with signals, which supply the cycle lights' offsets and arms
 */
export function createCyclistSystem(scene, geo, signalNodes = [], { groundHeight = null, network: prebuilt = null } = {}) {
  let network = prebuilt || buildCyclistNetworkFor(geo, signalNodes);
  const sim = createCyclists(network, { count: NUM_CYCLISTS });
  const group = new THREE.Group();
  group.name = 'CopenhagenCyclists';
  const frameMat = bikeMaterial();
  const near = Object.fromEntries(VARIANTS.map((v) => [v, batch(group, `cyclist-${v}`, buildBike(v, { parked: false }), frameMat, { framePaint: true })]));
  const far = batch(group, 'cyclist-proxy', buildBikeProxy(), frameMat, { framePaint: true, cast: false });
  const helmets = batch(group, 'cyclist-helmets', new THREE.SphereGeometry(0.125, 10, 8),
    new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 }), { colored: true });
  const shadows = batch(group, 'cyclist-contact-shadows', new THREE.PlaneGeometry(0.85, 2.25).rotateX(-Math.PI / 2),
    createContactShadowMaterial(), { cast: false });
  shadows.mesh.renderOrder = 998;
  const crankMat = new THREE.MeshStandardNodeMaterial({ color: 0x737a7c, roughness: 0.65, metalness: 0.3 });
  const cranks = [1, -1].map((side) => batch(group, `cyclist-crank-${side}`,
    new THREE.BoxGeometry(0.016, 0.17, 0.03).translate(side * 0.065, -0.085, 0), crankMat));
  const pedals = [1, -1].map((side) => batch(group, `cyclist-pedal-${side}`,
    new THREE.BoxGeometry(0.09, 0.018, 0.07).translate(side * 0.1, 0, 0), crankMat));
  const batches = [...Object.values(near), far, helmets, shadows, ...cranks, ...pedals];
  const crowd = new PersonCrowd(NUM_CYCLISTS, { farDistance: 65 });
  group.add(...crowd.meshes);
  scene.add(group);

  const ridePose = {
    seat: new THREE.Vector3(0, 0.99, -0.2), bars: new THREE.Vector3(0, 1.12, 0.31), gripHalf: 0.25,
    bracket: new THREE.Vector3(0, 0.36, -0.02), crankLength: 0.17, torsoLean: 0.3
  };
  const bikes = sim.riders.map((c, i) => {
    const look = cyclistAppearance(i);
    const root = new THREE.Group();
    const lean = new THREE.Group();
    root.add(lean);
    return {
      root, lean, look, paint: new THREE.Color(look.frameColour), helmetPaint: new THREE.Color(look.helmetColour),
      rig: new PersonRig({ seed: 40 + i * 1.7, scale: 0.94 + (i % 7) * 0.025, girth: 0.9 + (i % 5) * 0.06, hair: ((i * 37) % 100) / 100 })
    };
  });
  const matrix = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const rotation = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);

  function update(dt, elapsed, focus, visible = null) {
    sim.update(dt, elapsed, focus, 300);
    crowd.begin();
    for (const b of batches) b.begin();
    let drawn = 0;
    for (let i = 0; i < bikes.length; i++) {
      const c = sim.riders[i];
      const b = bikes[i];
      const distance = focus ? Math.hypot(c.x - focus.x, c.z - focus.z) : 0;
      if (!c.placed || distance > DRAW_RADIUS || (visible && !visible(c.x, c.z, 4))) continue;
      drawn++;
      const y = groundHeight ? groundHeight.heightAt(c.x, c.z) : 0;
      b.root.position.set(c.x, y, c.z);
      b.root.rotation.set(0, c.yaw, 0);
      b.lean.rotation.z = b.look.variant === 'cargo-trike' ? c.lean * 0.2 : c.lean;
      b.root.updateMatrixWorld(true);
      (distance <= NEAR_RADIUS ? near[b.look.variant] : far).put(b.lean.matrixWorld, b.paint);
      b.rig.ride(b.lean, c.pedal, ridePose);
      crowd.add(b.rig, distance);
      if (b.look.helmet) {
        pos.set(0, 0.175, -0.012).applyQuaternion(b.rig.headQuaternion).add(b.rig.headPosition);
        matrix.compose(pos, b.rig.headQuaternion, scale.set(0.95, 0.68, 1.28));
        helmets.put(matrix, b.helmetPaint);
      }
      if (distance <= NEAR_RADIUS) {
        local.compose(pos.set(0, 0.02, b.look.cargo ? 0.3 : 0), identity, scale.set(1, 1, b.look.cargo ? 1.35 : 1));
        shadows.put(matrix.multiplyMatrices(b.root.matrixWorld, local));
        for (let side = 0; side < 2; side++) {
          const phase = c.pedal + side * Math.PI;
          rotation.setFromAxisAngle(xAxis, phase);
          local.compose(ridePose.bracket, rotation, scale.set(1, 1, 1));
          cranks[side].put(matrix.multiplyMatrices(b.lean.matrixWorld, local));
          pos.set(0, ridePose.bracket.y - Math.cos(phase) * 0.17, ridePose.bracket.z - Math.sin(phase) * 0.17);
          local.compose(pos, identity, scale);
          pedals[side].put(matrix.multiplyMatrices(b.lean.matrixWorld, local));
        }
      }
    }
    crowd.end();
    for (const b of batches) b.end();
    return drawn;
  }

  /** Swaps the lane graph (see createCyclists); the riders are placed afresh. */
  function setNetwork(next) {
    network = next;
    sim.setNetwork(next);
  }

  return { group, get network() { return network; }, sim, riders: sim.riders, update, setNetwork };
}
