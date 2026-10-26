import * as THREE from 'three/webgpu';

const white = new THREE.MeshPhysicalMaterial({ color: 0xf3f2ec, roughness: 0.29, metalness: 0.02, clearcoat: 0.6, clearcoatRoughness: 0.24 });
const black = new THREE.MeshStandardMaterial({ color: 0x171919, roughness: 0.4 });
const orange = new THREE.MeshPhysicalMaterial({ color: 0xf08a24, roughness: 0.35, clearcoat: 0.35 });
const seatWhite = new THREE.MeshStandardMaterial({ color: 0xdeddd5, roughness: 0.55 });

// +Z is the bow. Longitudinal sections: z, half beam, sheer height, cockpit half width.
// The sheer dips beside the riders and sweeps up into the bow and low rounded stern.
const SECTIONS = [
  [-1.50, 0.012, 0.15, 0], [-1.38, 0.34, 0.26, 0], [-1.12, 0.59, 0.44, 0],
  [-0.87, 0.70, 0.49, 0.30], [-0.58, 0.75, 0.40, 0.55], [-0.16, 0.77, 0.34, 0.59],
  [0.27, 0.74, 0.37, 0.56], [0.58, 0.66, 0.48, 0.42], [0.83, 0.54, 0.60, 0],
  [1.06, 0.40, 0.55, 0], [1.32, 0.23, 0.29, 0], [1.50, 0.012, 0.15, 0]
];

function geometry(positions, indices) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

// Closed cross-sections use a wrapped index, not duplicate seam vertices: their normals agree at the seam.
function loft(rings) {
  const positions = rings.flat(2), indices = [];
  const count = rings[0].length;
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
    positions.push(...[0, 1, 2].map((axis) => ring.reduce((sum, p) => sum + p[axis], 0) / count));
    for (let j = 0; j < count; j++) {
      const a = end * count + j, b = end * count + (j + 1) % count;
      indices.push(center, end === 0 ? b : a, end === 0 ? a : b);
    }
  }
  return geometry(positions, indices);
}

function bodyGeometry() {
  const profile = new THREE.CatmullRomCurve3(SECTIONS.map(([z, w, y]) => new THREE.Vector3(z, w, y)), false, 'centripetal');
  // Match the spline's station parameter. Smoothstep keeps the closed bow/stern decks flat across the centre.
  const rings = Array.from({ length: 45 }, (_, i) => {
    const t = i / 44, p = profile.getPoint(t);
    const section = t * (SECTIONS.length - 1), k = Math.min(SECTIONS.length - 2, Math.floor(section));
    const f = section - k, ease = f * f * (3 - 2 * f);
    const opening = THREE.MathUtils.lerp(SECTIONS[k][3], SECTIONS[k + 1][3], ease);
    const w = Math.max(0.012, p.y), y = p.z;
    const floor = THREE.MathUtils.lerp(y - 0.045, 0.035, Math.min(1, opening / 0.22));
    // One moulded surface: underside, rounded exterior, rolled gunwale, inner wall and cockpit floor.
    const half = [
      [0, -0.16], [w * 0.40, -0.15], [w * 0.78, -0.10], [w * 0.95, 0.01],
      [w, 0.13], [w * 0.99, 0.13 + (y - 0.13) * 0.38],
      [w * 0.95, 0.13 + (y - 0.13) * 0.79], [w * 0.88, y - 0.005],
      [Math.max(opening + 0.025, w * 0.74), y], [opening, y - 0.035],
      [opening * 0.97, floor + (y - 0.035 - floor) * 0.48], [opening * 0.92, floor], [0, floor]
    ];
    return [...half, ...half.slice(1, -1).reverse().map(([x, h]) => [-x, h])].map(([x, h]) => [x, h, p.x]);
  });
  return loft(rings);
}

function flangeGeometry() {
  // A genuinely horizontal shelf (not a round tube) overhangs the hull all the way round.
  const contour = new THREE.CatmullRomCurve3([
    ...SECTIONS.map(([z, w]) => new THREE.Vector3(w, 0, z)),
    ...SECTIONS.slice().reverse().map(([z, w]) => new THREE.Vector3(-w, 0, z))
  ], true, 'centripetal');
  const positions = [], indices = [], n = 80;
  for (let i = 0; i < n; i++) {
    const p = contour.getPoint(i / n);
    for (const [scale, y] of [[0.98, 0.105], [1.045, 0.105], [1.045, 0.145], [0.98, 0.145]]) {
      positions.push(p.x * scale, y, p.z * scale);
    }
  }
  // Separate horizontal/vertical face vertices preserve the crisp rubbing-lip edge.
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
    const a = i * 4 + j, b = ((i + 1) % n) * 4 + j;
    const c = i * 4 + (j + 1) % 4, d = ((i + 1) % n) * 4 + (j + 1) % 4;
    indices.push(a, c, b, c, d, b);
  }
  const result = geometry(positions, indices).toNonIndexed();
  result.computeVertexNormals();
  return result;
}

function neckGeometry() {
  // The broad foot is buried in the bow deck. The lower neck sweeps aft, the upper neck curls forward.
  const controls = [
    [0, 0.38, 1.02, 0.255], [0, 0.63, 0.97, 0.225], [0, 0.92, 0.75, 0.17],
    [0, 1.19, 0.57, 0.13], [0, 1.48, 0.62, 0.112], [0, 1.70, 0.82, 0.117],
    [0, 1.75, 1.02, 0.13], [0, 1.71, 1.14, 0.115]
  ];
  const path = new THREE.CatmullRomCurve3(controls.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
  const rings = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32, center = path.getPoint(t), tangent = path.getTangent(t);
    const u = t * (controls.length - 1), k = Math.min(controls.length - 2, Math.floor(u));
    const f = u - k, radius = THREE.MathUtils.lerp(controls[k][3], controls[k + 1][3], f * f * (3 - 2 * f));
    // Planar centreline: +X and tangent cross +X form a stable, untwisted radial frame.
    const normal = new THREE.Vector3(0, tangent.z, -tangent.y);
    return Array.from({ length: 16 }, (_, j) => {
      const a = j * Math.PI * 2 / 16;
      return [radius * Math.cos(a), center.y + normal.y * radius * Math.sin(a), center.z + normal.z * radius * Math.sin(a)];
    });
  });
  return loft(rings);
}

function beakGeometry() {
  // Broad at the mask, tapering in width and depth to a softly downturned wedge tip.
  return loft([
    [[0.092, 1.72, 1.22], [-0.092, 1.72, 1.22], [-0.082, 1.62, 1.22], [0.082, 1.62, 1.22]],
    [[0.075, 1.69, 1.36], [-0.075, 1.69, 1.36], [-0.069, 1.60, 1.36], [0.069, 1.60, 1.36]],
    [[0.018, 1.60, 1.55], [-0.018, 1.60, 1.55], [-0.016, 1.58, 1.55], [0.016, 1.58, 1.55]]
  ]);
}

// Built once. Fleet instances share every static geometry and material.
let shared;
function sharedGeometry() {
  return shared ??= {
    body: bodyGeometry(), flange: flangeGeometry(), neck: neckGeometry(), beak: beakGeometry(),
    sphere: new THREE.SphereGeometry(1, 20, 12), mask: new THREE.SphereGeometry(1, 12, 8),
    eye: new THREE.SphereGeometry(1, 8, 5),
    seat: new THREE.BoxGeometry(0.47, 0.055, 0.36), rudder: new THREE.BoxGeometry(0.035, 0.31, 0.22)
  };
}

export function createSwanBoat() {
  const group = new THREE.Group();
  group.name = 'SwanPedalBoat';
  const geo = sharedGeometry();
  const add = (name, shape, material, position = [0, 0, 0], scale = [1, 1, 1]) => {
    const mesh = new THREE.Mesh(shape, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  add('MouldedShell', geo.body, white);
  add('WaterlineFlange', geo.flange, white);
  add('SweptNeck', geo.neck, white);
  add('Head', geo.sphere, white, [0, 1.733, 1.055], [0.147, 0.135, 0.205]);
  add('FacialMask', geo.mask, black, [0, 1.689, 1.213], [0.113, 0.087, 0.08]);
  add('BeakKnob', geo.eye, black, [0, 1.744, 1.245], [0.06, 0.047, 0.05]);
  add('OrangeBeak', geo.beak, orange);
  for (const side of [-1, 1]) {
    const mask = add('EyeMask', geo.mask, black, [side * 0.128, 1.727, 1.135], [0.018, 0.034, 0.105]);
    mask.rotation.y = side * 0.28;
    add('Eye', geo.eye, black, [side * 0.145, 1.746, 1.095], [0.016, 0.016, 0.016]);
    add('RecessedSeat', geo.seat, seatWhite, [side * 0.29, 0.225, -0.39]);
  }
  add('BowRudder', geo.rudder, black, [0, -0.10, 1.24]);
  // Keep the drivetrain pivots for signed speed/teleport state; the real mechanism is enclosed under the deck.
  const pedals = new THREE.Group(), paddleWheel = new THREE.Group();
  pedals.name = 'EnclosedPedalCrank';
  paddleWheel.name = 'EnclosedDrive';
  group.add(pedals, paddleWheel);
  return { group, pedals, paddleWheel };
}
