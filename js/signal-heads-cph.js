import * as THREE from 'three/webgpu';
import { vehiclePhase } from './signal-plan.js';

// js/signal-heads-cph.js
// A signal head on a pole at the stop line of every approach to a signalised junction (the junctions of the
// Copenhagen signal register matched to the road network). The lamp shows the car phase of the approach's road group
// (signal-plan.js): green, amber or red, so the junction reads the way traffic.js drives it.

const COLORS = { green: new THREE.Color(0x2ee66a), amber: new THREE.Color(0xffb020), red: new THREE.Color(0xff2a2a) };

export function buildSignalHeads(scene, signalNodes) {
  const approaches = [];
  for (const n of signalNodes) {
    for (const arm of n.arms || []) {
      const e = arm.in;
      if (!e || arm.lead !== arm) continue;
      const stopX = e.sx + e.dx * e.len;
      const stopZ = e.sz + e.dz * e.len;
      // on the kerb to the right of the approach
      const off = e.half + 0.9;
      approaches.push({ n, group: arm.group ?? 0, x: stopX + e.rx * off, z: stopZ + e.rz * off, yaw: Math.atan2(-e.dx, -e.dz) });
    }
  }
  const group = new THREE.Group();
  group.name = 'CopenhagenSignalHeads';
  const count = Math.max(1, approaches.length);
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.07, 3.6, 8).translate(0, 1.8, 0),
    new THREE.MeshStandardNodeMaterial({ color: 0x3b3f44, roughness: 0.6, metalness: 0.4 }), count);
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.95, 0.3).translate(0, 3.75, 0),
    new THREE.MeshStandardNodeMaterial({ color: 0x1c1e21, roughness: 0.5 }), count);
  const lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.11, 12).translate(0, 3.75, 0.152),
    new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  approaches.forEach((a, i) => {
    q.setFromAxisAngle(up, a.yaw);
    m.compose(new THREE.Vector3(a.x, 0.15, a.z), q, new THREE.Vector3(1, 1, 1));
    poles.setMatrixAt(i, m);
    boxes.setMatrixAt(i, m);
    lamps.setMatrixAt(i, m);
    lamps.setColorAt(i, COLORS.red);
  });
  for (const mesh of [poles, boxes, lamps]) {
    mesh.count = approaches.length;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh !== lamps;
  }
  group.add(poles, boxes, lamps);
  scene.add(group);

  let nextUpdate = 0;
  function update(elapsed) {
    if (elapsed < nextUpdate || !approaches.length) return;
    nextUpdate = elapsed + 0.25;
    approaches.forEach((a, i) => lamps.setColorAt(i, COLORS[vehiclePhase(a.n.sigOffset, a.group, elapsed)]));
    lamps.instanceColor.needsUpdate = true;
  }
  return { group, approaches, update };
}
