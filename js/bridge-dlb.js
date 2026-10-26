import * as THREE from 'three/webgpu';
import { attribute, positionWorld, vec3, fract, sin, dot, mix, step } from 'three/tsl';
import { createLakeWallMaterial } from './water-cph.js';
import { WATER } from './lakes-cph.js';
import { buildBridgeDLBGeometry } from './bridge-dlb-geometry.js';

const standard = (options) => new THREE.MeshStandardNodeMaterial(options);

function geometryFromPart(part, { waterY = null, axis = [1, 0] } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.position, 3));
  if (waterY != null) {
    const uv = [];
    for (let i = 0; i < part.position.length; i += 3) {
      uv.push(part.position[i] * axis[0] + part.position[i + 2] * axis[1], part.position[i + 1] - waterY + WATER.surfaceY);
    }
    geometry.setAttribute('wallUV', new THREE.Float32BufferAttribute(uv, 2));
  } else if (part.uv.length) geometry.setAttribute('wallUV', new THREE.Float32BufferAttribute(part.uv, 2));
  if (part.kind.length) geometry.setAttribute('wallKind', new THREE.Float32BufferAttribute(part.kind, 1));
  if (part.index.length) geometry.setIndex(part.index.length > 65535
    ? new THREE.Uint32BufferAttribute(part.index, 1)
    : new THREE.Uint16BufferAttribute(part.index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function addPart(group, name, part, material, { cast = true, receive = true, waterY = null, axis } = {}) {
  if (!part?.index?.length) return null;
  const mesh = new THREE.Mesh(geometryFromPart(part, { waterY, axis }), material);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  group.add(mesh);
  return mesh;
}

function lampPositions(layout) {
  if (layout.heritageLamps.length === 8) {
    return layout.heritageLamps.map((lamp) => ({ x: lamp.x, z: lamp.z, yaw: lamp.yaw || 0 }));
  }
  return layout.lampStations.flatMap((s) => layout.lampSides.map((t) => {
    const x = layout.axis[0] * s + layout.normal[0] * t;
    const z = layout.axis[1] * s + layout.normal[1] * t;
    return { x, z, yaw: Math.atan2(layout.axis[0], layout.axis[1]) };
  }));
}

function addHeritageLamps(group, layout) {
  const anchors = lampPositions(layout);
  const stone = standard({ color: 0x625c52, roughness: 0.82, metalness: 0.05 });
  const bronze = standard({ color: 0x694128, roughness: 0.48, metalness: 0.62 });
  const green = standard({ color: 0x365c49, roughness: 0.52, metalness: 0.60 });
  const glass = standard({ color: 0xfff3d6, emissive: 0xffc76e, emissiveIntensity: 0.02, roughness: 0.18, metalness: 0.03 });

  const batches = [];
  const temp = new THREE.Object3D();
  const shaft = new THREE.CylinderGeometry(0.10, 0.14, 1.85, 48, 1);
  const shaftPositions = shaft.attributes.position;
  for (let i = 0; i < shaftPositions.count; i++) {
    const x = shaftPositions.getX(i); const z = shaftPositions.getZ(i);
    const scale = 1 + 0.09 * Math.cos(12 * Math.atan2(z, x));
    shaftPositions.setX(i, x * scale); shaftPositions.setZ(i, z * scale);
  }
  shaftPositions.needsUpdate = true;
  shaft.computeVertexNormals();
  const crossbar = new THREE.CylinderGeometry(0.035, 0.035, 0.90, 8).rotateZ(Math.PI / 2);
  const parts = [
    ['lamp-pedestals', new THREE.BoxGeometry(0.58, 0.25, 0.58), stone, [0, 0.125, 0], [1, 1, 1]],
    ['lamp-plinths', new THREE.CylinderGeometry(0.26, 0.40, 0.64, 4).rotateY(Math.PI / 4), bronze, [0, 0.57, 0], [1, 1, 1]],
    ['lamp-urn-bases', new THREE.SphereGeometry(0.22, 16, 10), bronze, [0, 1.0, 0], [1, 1.1, 1]],
    ['lamp-shafts-fluted', shaft, bronze, [0, 2.055, 0], [1, 1, 1]],
    ['lamp-collars', new THREE.CylinderGeometry(0.22, 0.18, 0.16, 16), bronze, [0, 3.02, 0], [1, 1, 1]],
    ['lamp-crossbars', crossbar, bronze, [0, 3.25, 0], [1, 1, 1]],
    ['lamp-globes', new THREE.SphereGeometry(0.38, 20, 14), glass, [0, 3.72, 0], [1, 1, 1]],
    ['lamp-finials', new THREE.ConeGeometry(0.075, 0.30, 8), green, [0, 4.22, 0], [1, 1, 1]]
  ];
  for (const [name, geometry, material, local, scale] of parts) {
    const mesh = new THREE.InstancedMesh(geometry, material, anchors.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const yaw = anchor.yaw || 0;
      const lx = local[0] * Math.cos(yaw) + local[2] * Math.sin(yaw);
      const lz = -local[0] * Math.sin(yaw) + local[2] * Math.cos(yaw);
      temp.position.set(anchor.x + lx, layout.parapetTopY + local[1], anchor.z + lz);
      temp.rotation.set(0, yaw, 0);
      temp.scale.set(scale[0], scale[1], scale[2]);
      temp.updateMatrix();
      mesh.setMatrixAt(i, temp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    batches.push(mesh);
  }

  // A spherical glass globe sits inside five curved green ribs and a separate
  // equatorial band, matching the cage silhouette in the heritage lamp photo.
  const ribPoints = [];
  for (let i = 0; i <= 12; i++) {
    const phi = 0.10 + (Math.PI - 0.20) * i / 12;
    ribPoints.push(new THREE.Vector3(0.43 * Math.sin(phi), 0.44 * Math.cos(phi), 0));
  }
  const ribCurve = new THREE.CatmullRomCurve3(ribPoints);
  const ribGeometry = new THREE.TubeGeometry(ribCurve, 20, 0.012, 5, false);
  const ribs = new THREE.InstancedMesh(ribGeometry, green, anchors.length * 5);
  ribs.name = 'lamp-cage-meridian-ribs';
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    for (let r = 0; r < 5; r++) {
      const yaw = (anchor.yaw || 0) + r * Math.PI * 2 / 5;
      temp.position.set(anchor.x, layout.parapetTopY + 3.72, anchor.z);
      temp.rotation.set(0, yaw, 0);
      temp.scale.setScalar(1);
      temp.updateMatrix();
      ribs.setMatrixAt(i * 5 + r, temp.matrix);
    }
  }
  ribs.instanceMatrix.needsUpdate = true;
  group.add(ribs);
  batches.push(ribs);
  const bandGeometry = new THREE.TorusGeometry(0.43, 0.022, 6, 32).rotateX(Math.PI / 2);
  const bands = new THREE.InstancedMesh(bandGeometry, green, anchors.length);
  bands.name = 'lamp-cage-equatorial-bands';
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    temp.position.set(anchor.x, layout.parapetTopY + 3.72, anchor.z);
    temp.rotation.set(0, anchor.yaw || 0, 0);
    temp.scale.setScalar(1);
    temp.updateMatrix();
    bands.setMatrixAt(i, temp.matrix);
  }
  bands.instanceMatrix.needsUpdate = true;
  group.add(bands);
  batches.push(bands);

  const lights = anchors.map((anchor) => {
    const yaw = anchor.yaw || 0;
    const lx = 0.15 * Math.sin(yaw);
    const lz = 0.15 * Math.cos(yaw);
    const light = new THREE.PointLight(0xffd69a, 0, 9, 2);
    light.name = 'dlb-heritage-lamp-light';
    light.position.set(anchor.x + lx, layout.parapetTopY + 3.72, anchor.z + lz);
    light.distance = 12;
    group.add(light);
    return light;
  });

  return {
    count: anchors.length,
    setNight(night) {
      const n = THREE.MathUtils.clamp(Number(night) || 0, 0, 1);
      glass.emissiveIntensity = 0.02 + 1.6 * n;
      lights.forEach((light) => { light.intensity = 22 * n; });
    },
    batches,
    lights
  };
}

/** Builds the modeled Dronning Louises Bro while preserving the existing road/deck surfaces. */
export function buildBridgeDLB(scene, geo, lakesDoc, { terrain = null, furnitureDoc = null } = {}) {
  const built = buildBridgeDLBGeometry(geo, lakesDoc, { terrain, furnitureDoc });
  if (!built) return null;

  const group = new THREE.Group();
  group.name = 'CopenhagenDLB';
  group.userData.dlbMetadata = built.metadata;
  group.userData.bridgeId = built.layout.bridgeId;
  group.userData.openings = built.openings;

  const granite = createLakeWallMaterial();
  granite.side = THREE.DoubleSide;
  // Voussoirs have radial joints in geometry; horizontal ashlar seams belong only
  // on the spandrels and approaches. Both share fine procedural granite grain.
  const grain = fract(sin(dot(positionWorld.mul(65), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const ringStone = vec3(0.29, 0.28, 0.26).mul(grain.mul(0.14).add(0.93));
  granite.colorNode = mix(granite.colorNode, ringStone, step(2.5, attribute('wallKind', 'float')));
  addPart(group, 'dlb-granite-causeway-and-arches', built.parts.granite, granite, { waterY: built.layout.waterY, axis: built.layout.axis });
  addPart(group, 'dlb-radial-mortar-joints', built.parts.mortar,
    standard({ color: 0x282622, roughness: 0.96, metalness: 0, side: THREE.DoubleSide }), { cast: false });
  addPart(group, 'dlb-cast-iron-rails-and-fittings', built.parts.iron,
    standard({ color: 0x202522, roughness: 0.42, metalness: 0.66 }), { receive: false });
  addPart(group, 'dlb-green-painted-benches', built.parts.wood,
    standard({ color: 0x315641, roughness: 0.72, metalness: 0.04 }), { receive: true });
  addPart(group, 'dlb-white-end-flagpoles', built.parts.fabric,
    standard({ color: 0xf2eee2, roughness: 0.84, metalness: 0, side: THREE.DoubleSide }), { cast: false, receive: false });

  const lamps = addHeritageLamps(group, built.layout);
  group.userData.lampCount = lamps.count;
  scene.add(group);
  const update = (night = 0) => lamps.setNight(night);
  update(0);
  return {
    group,
    update,
    layout: built.layout,
    geometry: built,
    metadata: built.metadata,
    bridgeIds: [built.layout.bridgeId],
    lamps
  };
}

export { filterDLBFurniture } from './bridge-dlb-geometry.js';
