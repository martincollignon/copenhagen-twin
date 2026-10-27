import * as THREE from 'three/webgpu';
import { mergeRigidMeshes } from './rigid-meshes.js';

// A metric, reference-based Copenhagen electric picnic boat. Local +Z points toward the bow; y=0 is the waterline.
export const GOBOAT_DIMENSIONS = Object.freeze({ length: 5.0, beam: 2.0, hullRadius: 2.7 });

const hullMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x123e60, roughness: 0.28, metalness: 0.16, clearcoat: 0.64, clearcoatRoughness: 0.22
});
const rubberMaterial = new THREE.MeshStandardMaterial({ color: 0x202a30, roughness: 0.65 });
const alloyMaterial = new THREE.MeshStandardMaterial({ color: 0x9da8ab, roughness: 0.32, metalness: 0.82 });
const motorMaterial = new THREE.MeshStandardMaterial({ color: 0x424b50, roughness: 0.4, metalness: 0.58 });
const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x172329, roughness: 0.54 });
// Repeating narrow timber slats with restrained longitudinal grain; no downloaded photo textures.
const timberPixels = new Uint8Array(128 * 256 * 4);
for (let z = 0; z < 256; z++) for (let x = 0; x < 128; x++) {
  const seam = x % 9 === 0 ? -24 : 0;
  const grain = Math.sin(x * 2.7 + Math.sin(z * 0.045) * 0.7) * 4 + Math.sin(x * 0.71 + z * 0.012) * 5;
  const i = (z * 128 + x) * 4;
  timberPixels.set([151 + seam + grain, 138 + seam + grain, 115 + seam + grain, 255], i);
}
const timberMap = new THREE.DataTexture(timberPixels, 128, 256, THREE.RGBAFormat);
timberMap.colorSpace = THREE.SRGBColorSpace;
timberMap.wrapS = timberMap.wrapT = THREE.RepeatWrapping;
timberMap.needsUpdate = true;
const tableMaterial = new THREE.MeshStandardMaterial({ map: timberMap, roughness: 0.78 });
const cupMaterial = new THREE.MeshStandardMaterial({ color: 0x11191d, roughness: 0.36, metalness: 0.18 });

const STATIONS = [
  [-2.48, 0.78, 0.17, 0], [-2.28, 0.91, 0.38, 0], [-1.86, 0.98, 0.69, 0],
  [-1.60, 1.00, 0.70, 0.60], [-0.82, 1.00, 0.70, 0.63], [0.12, 0.98, 0.70, 0.61],
  [0.88, 0.89, 0.70, 0.51], [1.38, 0.72, 0.70, 0.33], [1.70, 0.56, 0.70, 0],
  [2.08, 0.32, 0.69, 0], [2.48, 0.025, 0.68, 0]
];

function makeGeometry(positions, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hullGeometry() {
  const profile = new THREE.CatmullRomCurve3(STATIONS.map(([z, beam, top]) => new THREE.Vector3(beam, top, z)), false, 'centripetal');
  const rings = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    const p = profile.getPoint(t);
    const station = t * (STATIONS.length - 1), k = Math.min(STATIONS.length - 2, Math.floor(station));
    const f = station - k, ease = f * f * (3 - 2 * f);
    const opening = THREE.MathUtils.lerp(STATIONS[k][3], STATIONS[k + 1][3], ease);
    const beam = Math.max(0.025, p.x), top = p.y;
    const seat = Math.min(0.43, top - 0.04);
    const floorY = THREE.MathUtils.lerp(seat, 0.06, Math.min(1, opening / 0.15));
    const inner = Math.max(opening, beam - 0.09);
    const half = [
      [0, -0.26], [beam * 0.55, -0.24], [beam * 0.86, -0.12], [beam * 0.98, 0.08],
      [beam, top - 0.045], [beam - Math.min(0.035, beam * 0.2), top], [inner, top],
      [inner, seat + 0.025], [Math.min(inner, opening + 0.03), seat],
      [opening, seat - 0.025], [opening, floorY], [0, floorY]
    ];
    rings.push([...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])].map(([x, y]) => [x, y, p.z]));
  }
  const positions = rings.flat(2), indices = [], count = rings[0].length;
  for (let i = 1; i < rings.length; i++) {
    for (let j = 0; j < count; j++) {
      const a = (i - 1) * count + j, b = (i - 1) * count + (j + 1) % count;
      const c = i * count + j, d = i * count + (j + 1) % count;
      indices.push(a, b, c, b, d, c);
    }
  }
  for (const end of [0, rings.length - 1]) {
    const center = positions.length / 3;
    const ring = rings[end];
    positions.push(...[0, 1, 2].map((axis) => ring.reduce((sum, point) => sum + point[axis], 0) / count));
    for (let j = 0; j < count; j++) {
      const a = end * count + j, b = end * count + (j + 1) % count;
      indices.push(center, end === 0 ? b : a, end === 0 ? a : b);
    }
  }
  return makeGeometry(positions, indices);
}

function roundedPrism(width, length, height, radius) {
  const x0 = -width / 2, x1 = width / 2, z0 = -length / 2, z1 = length / 2;
  const r = Math.min(radius, width / 2, length / 2);
  const shape = new THREE.Shape();
  shape.moveTo(x0 + r, z0);
  shape.lineTo(x1 - r, z0); shape.quadraticCurveTo(x1, z0, x1, z0 + r);
  shape.lineTo(x1, z1 - r); shape.quadraticCurveTo(x1, z1, x1 - r, z1);
  shape.lineTo(x0 + r, z1); shape.quadraticCurveTo(x0, z1, x0, z1 - r);
  shape.lineTo(x0, z0 + r); shape.quadraticCurveTo(x0, z0, x0 + r, z0);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height, steps: 1, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.018, bevelThickness: 0.018
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function edgeGeometry() {
  const points = [];
  const half = STATIONS.map(([z, beam, top]) => new THREE.Vector3(beam * 0.94, top - 0.01, z));
  points.push(...half, ...half.slice(0, -1).reverse().map((p) => new THREE.Vector3(-p.x, p.y, p.z)));
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  return new THREE.TubeGeometry(curve, 256, 0.036, 8, true);
}

function metalTrimGeometry() {
  const points = [];
  const half = STATIONS.map(([z, beam, top]) => new THREE.Vector3(beam * 0.97, top + 0.015, z));
  points.push(...half, ...half.slice(0, -1).reverse().map((p) => new THREE.Vector3(-p.x, p.y, p.z)));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, true, 'centripetal'), 256, 0.010, 6, true);
}

const SHARED = {
  hull: hullGeometry(),
  rubber: edgeGeometry(),
  trim: metalTrimGeometry(),
  tableTop: roundedPrism(0.82, 1.50, 0.075, 0.12)
};

const textMaps = new Map();
function markingTexture(text, subtitle = '') {
  if (typeof document === 'undefined') return null;
  const key = `${text}:${subtitle}`;
  if (textMaps.has(key)) return textMaps.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '500 92px Arial, sans-serif';
  ctx.strokeStyle = 'rgba(247,249,247,.86)'; ctx.lineWidth = 3; ctx.strokeText(text, 384, 76);
  ctx.fillStyle = '#f4f6f4'; ctx.fillText(text, 384, 76);
  if (subtitle) {
    ctx.font = '600 30px Arial, sans-serif'; ctx.fillStyle = '#d5b77b';
    ctx.fillText(subtitle, 384, 151);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textMaps.set(key, texture);
  return texture;
}

function sideMarking(group, side, text, subtitle = '') {
  const map = markingTexture(text, subtitle);
  if (!map) return;
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.25, depthWrite: false, side: THREE.DoubleSide });
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(text === 'GOBOAT' ? 1.18 : 0.40, 0.30), material);
  mark.position.set(side * 1.015, 0.38, -0.55);
  mark.rotation.y = side * Math.PI / 2;
  group.add(mark);
}

function addBox(group, geometry, material, position, scale = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (scale) mesh.scale.set(...scale);
  group.add(mesh);
  return mesh;
}

function addCylinder(group, radiusTop, radiusBottom, height, material, position, radial = 12) {
  return addBox(group, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radial), material, position);
}

function buildTable(group, detailed) {
  // One thin slatted tabletop; its top is at y=.953 (including the bevel).
  addBox(group, SHARED.tableTop, tableMaterial, [0, 0.86, -0.02]);
  for (const z of [-0.52, 0.48]) {
    addCylinder(group, 0.032, 0.032, 0.79, alloyMaterial, [0, 0.465, z], 10);
    addCylinder(group, 0.09, 0.09, 0.014, alloyMaterial, [0, 0.075, z], 16);
  }
  if (!detailed) return;
  for (const x of [-0.27, 0.27]) for (const z of [-0.52, 0.48]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.007, 8, 20), alloyMaterial);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, 0.958, z);
    group.add(rim);
    addCylinder(group, 0.048, 0.048, 0.003, cupMaterial, [x, 0.956, z], 20);
  }
  const positions = [];
  for (let i = -6; i <= 6; i++) {
    const x = i * 0.055, inset = Math.abs(x) > 0.29 ? 0.045 : 0;
    positions.push(x, 0.955, -0.72 + inset, x, 0.955, 0.68 - inset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x403b34, transparent: true, opacity: 0.55 })));
}

function buildMotor(group, detailed) {
  addBox(group, new THREE.BoxGeometry(0.40, 0.31, 0.33), motorMaterial, [0, 0.27, -2.42]);
  addBox(group, new THREE.BoxGeometry(0.32, 0.24, 0.25), alloyMaterial, [0, 0.45, -2.42]);
  addBox(group, new THREE.BoxGeometry(0.14, 0.52, 0.14), darkMaterial, [0, -0.04, -2.43]);
  addCylinder(group, 0.11, 0.14, 0.13, darkMaterial, [0, -0.31, -2.43], 10);
  addBox(group, new THREE.BoxGeometry(0.55, 0.035, 0.06), rubberMaterial, [0.24, 0.60, -1.89]);
  if (detailed) {
    addBox(group, new THREE.BoxGeometry(0.06, 0.06, 0.36), alloyMaterial, [0, 0.60, -2.09]);
    addBox(group, new THREE.BoxGeometry(0.12, 0.10, 0.10), cupMaterial, [0.48, 0.61, -1.89]);
  }
}

/** Build the shared, low-poly molded hull used by the player and the static fleet. */
export function createGoBoat({ fleet = false, number = '08' } = {}) {
  const group = new THREE.Group();
  group.name = fleet ? 'MooredGoBoat' : 'PlayerGoBoat';
  group.userData.type = 'goboat';
  group.userData.dimensions = GOBOAT_DIMENSIONS;
  group.add(new THREE.Mesh(SHARED.hull, hullMaterial));
  group.add(new THREE.Mesh(SHARED.rubber, rubberMaterial));
  group.add(new THREE.Mesh(SHARED.trim, alloyMaterial));
  buildTable(group, !fleet);
  buildMotor(group, !fleet);

  if (!fleet) {
    for (const side of [-1, 1]) {
      sideMarking(group, side, 'GOBOAT', 'R E N T A L');
      for (const [z, x, y] of [[-1.86, 0.88, 0.73], [1.38, 0.62, 0.74]]) {
        addCylinder(group, 0.018, 0.025, 0.045, alloyMaterial, [side * x, y, z], 8);
        addBox(group, new THREE.BoxGeometry(0.14, 0.02, 0.025), alloyMaterial, [side * x, y + 0.025, z]);
      }
    }
    const bowNumber = markingTexture(number, '');
    if (bowNumber) {
      for (const side of [-1, 1]) {
        const label = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.19), new THREE.MeshBasicMaterial({ map: bowNumber, transparent: true, alphaTest: 0.25, depthWrite: false, side: THREE.DoubleSide }));
        label.position.set(side * 0.465, 0.45, 1.84);
        label.rotation.y = side * 0.92;
        group.add(label);
      }
    }
  }
  group.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = !fleet && !object.material?.transparent;
    object.receiveShadow = !fleet && !object.material?.transparent;
  });
  mergeRigidMeshes(group);
  return { group };
}
