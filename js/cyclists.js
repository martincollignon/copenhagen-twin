import * as THREE from 'three/webgpu';
import { createContactShadowMaterial } from './tsl-materials.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { buildCyclistNetwork, createCyclists } from './cyclist-network.js';
import { signalOffset } from './signal-plan.js';

// js/cyclists.js
// The cyclists of the Copenhagen twin: cyclist-network.js simulates them on the cycle-track lanes (IDM car-following
// with bicycle parameters, red lights, the early bike green) and this draws them: the controllers.js bicycle (frame,
// wheels, cranks) with a skinned PersonRig on it, the same models as the player's cyclist. Bicycles beyond DRAW_RADIUS
// or outside the view are not drawn; their riders keep riding.

const NUM_CYCLISTS = 96;
const DRAW_RADIUS = 220;
const PALETTE = [0x1b1d21, 0x2d3a4a, 0x7a2f2b, 0x3d4a3a, 0xc9c6bd, 0x1f4e79, 0x575a5e, 0x8a6d3b];

function bikeMaterials() {
  const tire = new THREE.MeshStandardNodeMaterial({ color: 0x181a1e, roughness: 0.6 });
  const chrome = new THREE.MeshStandardNodeMaterial({ color: 0xe0e8f0, roughness: 0.16, metalness: 0.78 });
  const saddle = new THREE.MeshStandardNodeMaterial({ color: 0x1c2028, roughness: 0.55 });
  const helmet = new THREE.MeshStandardNodeMaterial({ color: 0xf4f7fb, emissive: 0x181c22, roughness: 0.22, metalness: 0.25 });
  const frames = PALETTE.map((c) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.4, metalness: 0.3 }));
  return { tire, chrome, saddle, helmet, frames };
}

function bikeGeometries() {
  const wheel = new THREE.TorusGeometry(0.35, 0.038, 12, 24).rotateY(Math.PI * 0.5);
  const rim = new THREE.TorusGeometry(0.31, 0.018, 8, 24).rotateY(Math.PI * 0.5);
  const crank = new THREE.BoxGeometry(0.016, 0.17, 0.03).translate(0, -0.085, 0);
  return {
    wheel,
    rim,
    crank,
    pedal: new THREE.BoxGeometry(0.09, 0.018, 0.07),
    topTube: new THREE.CylinderGeometry(0.022, 0.022, 0.72, 8),
    downTube: new THREE.CylinderGeometry(0.026, 0.026, 0.78, 8),
    seatTube: new THREE.CylinderGeometry(0.022, 0.022, 0.64, 8),
    fork: new THREE.CylinderGeometry(0.02, 0.016, 0.68, 8),
    bar: new THREE.CylinderGeometry(0.018, 0.018, 0.48, 8),
    saddle: new THREE.CapsuleGeometry(0.045, 0.16, 6, 8),
    helmet: new THREE.SphereGeometry(0.125, 12, 10),
    shadow: new THREE.PlaneGeometry(0.85, 2.25).rotateX(-Math.PI * 0.5)
  };
}

// One bicycle, the geometry of controllers.js createCyclistEntity() (facing +z, front wheel at z = +0.58)
function buildBike(geos, mats, frameMat, shadowMat) {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);
  const mesh = (g, m, x, y, z, rx = 0, rz = 0) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.rotation.set(rx, 0, rz);
    o.castShadow = true;
    lean.add(o);
    return o;
  };
  const front = mesh(geos.wheel, mats.tire, 0, 0.38, 0.58);
  const rear = mesh(geos.wheel, mats.tire, 0, 0.38, -0.58);
  front.add(new THREE.Mesh(geos.rim, mats.chrome));
  rear.add(new THREE.Mesh(geos.rim, mats.chrome));
  mesh(geos.topTube, frameMat, 0, 0.78, 0.04, Math.PI * 0.46);
  mesh(geos.downTube, frameMat, 0, 0.58, 0.16, Math.PI * 0.28);
  mesh(geos.seatTube, frameMat, 0, 0.66, -0.22, -0.22);
  const saddle = mesh(geos.saddle, mats.saddle, 0, 0.96, -0.28, Math.PI * 0.5);
  saddle.scale.set(1.15, 1, 0.55);
  mesh(geos.fork, mats.chrome, 0, 0.68, 0.48, -0.24);
  mesh(geos.bar, mats.chrome, 0, 0.98, 0.4, 0, Math.PI * 0.5);
  const bikeFrame = {
    seat: new THREE.Vector3(0, 0.98, -0.28),
    bars: new THREE.Vector3(0, 0.98, 0.4),
    gripHalf: 0.22,
    bracket: new THREE.Vector3(0, 0.34, -0.145),
    crankLength: 0.17
  };
  const crankPivot = new THREE.Group();
  crankPivot.position.copy(bikeFrame.bracket);
  for (const side of [1, -1]) {
    const arm = new THREE.Group();
    arm.rotation.x = side > 0 ? 0 : Math.PI;
    const crank = new THREE.Mesh(geos.crank, mats.chrome);
    crank.position.x = side * 0.065;
    const pedal = new THREE.Mesh(geos.pedal, mats.tire);
    pedal.position.set(side * 0.1, -0.17, 0);
    arm.add(crank, pedal);
    crankPivot.add(arm);
  }
  lean.add(crankPivot);
  const shadow = new THREE.Mesh(geos.shadow, shadowMat);
  shadow.position.y = 0.02;
  shadow.renderOrder = 998;
  root.add(shadow);
  root.visible = false;
  return { root, lean, front, rear, crankPivot, bikeFrame };
}

/**
 * @param scene   the three.js scene
 * @param geo     data/cph-geodata.json
 * @param signalNodes road-network.js nodes with `signal`: they give the cyclists' junction lights their offsets and arms
 */
export function createCyclistSystem(scene, geo, signalNodes = [], { groundHeight = null } = {}) {
  const network = buildCyclistNetwork(geo, signalNodes.map((n) => ({
    x: n.x, z: n.z, sigOffset: n.sigOffset ?? signalOffset(n.x, n.z), arms: n.arms
  })));
  const sim = createCyclists(network, { count: NUM_CYCLISTS });
  const group = new THREE.Group();
  group.name = 'CopenhagenCyclists';
  const geos = bikeGeometries();
  const mats = bikeMaterials();
  const shadowMat = createContactShadowMaterial();
  const crowd = new PersonCrowd(NUM_CYCLISTS, { farDistance: Infinity });
  const bikes = sim.riders.map((c, i) => {
    const b = buildBike(geos, mats, mats.frames[i % mats.frames.length], shadowMat);
    b.rig = new PersonRig({ seed: 40 + i * 1.7, scale: 0.94 + (i % 7) * 0.025, girth: 0.9 + (i % 5) * 0.06, hair: ((i * 37) % 100) / 100 });
    b.helmet = new THREE.Mesh(geos.helmet, mats.helmet);
    b.helmet.scale.set(0.95, 0.68, 1.28);
    b.helmet.visible = false;
    group.add(b.root, b.helmet);
    return b;
  });
  group.add(...crowd.meshes);
  scene.add(group);

  const q = new THREE.Quaternion();

  function update(dt, elapsed, focus, visible = null) {
    sim.update(dt, elapsed, focus, 300);
    crowd.begin();
    let drawn = 0;
    for (let i = 0; i < bikes.length; i++) {
      const c = sim.riders[i];
      const b = bikes[i];
      const show = c.placed && (!focus || Math.hypot(c.x - focus.x, c.z - focus.z) < DRAW_RADIUS) && (!visible || visible(c.x, c.z, 4));
      b.root.visible = show;
      b.helmet.visible = show;
      if (!show) continue;
      drawn++;
      b.root.position.set(c.x, groundHeight ? groundHeight.heightAt(c.x, c.z) : 0, c.z);
      b.root.rotation.set(0, c.yaw, 0);
      b.lean.rotation.z = c.lean;
      b.front.rotation.x = b.rear.rotation.x = c.pedal * 0.6;
      b.crankPivot.rotation.x = c.pedal;
      b.root.updateMatrixWorld(true);
      b.rig.ride(b.lean, c.pedal, b.bikeFrame);
      crowd.add(b.rig, 0);
      q.copy(b.rig.headQuaternion);
      b.helmet.quaternion.copy(q);
      b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(q).add(b.rig.headPosition);
    }
    crowd.end();
    return drawn;
  }

  return { group, network, sim, riders: sim.riders, update };
}
