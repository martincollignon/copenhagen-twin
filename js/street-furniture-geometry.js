import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { REF_H, TREE_STYLES, hashString, mulberry32 } from './street-furniture-data.js';

// js/street-furniture-geometry.js
// Geometry and textures of the street furniture (vertex-coloured, merged per model; origin on the ground, +z = front).
// Instance colour multiplies the vertex colour, so parts that should take the instance tint are white.

const _c = new THREE.Color();
const rgb = (hex) => {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
};
const rgbS = (srgb) => {
  _c.setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace);
  return [_c.r, _c.g, _c.b];
};

const SOLID_UV = [0.985, 0.985]; // the opaque corner of the leaf atlas: bark, core and props never get cut out

class Parts {
  constructor({ frameTint = false } = {}) {
    this.list = [];
    this.frameTint = frameTint;
  }

  /** Adds `geo` (any indexed/non-indexed geometry with position, normal, uv) after `matrix`, in one colour or per-vertex colours. */
  add(geo, color, matrix = null, { solidUv = false, frameTint = false } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    if (!g.attributes.color) {
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set(color, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    if (this.frameTint) {
      const tint = new Float32Array(n);
      if (frameTint) tint.fill(1);
      g.setAttribute('frameTint', new THREE.BufferAttribute(tint, 1));
    }
    if (solidUv) {
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) uv.set(SOLID_UV, i * 2);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color', 'frameTint'].includes(k)) g.deleteAttribute(k);
    this.list.push(g);
    return this;
  }

  box(w, h, d, x, y, z, hex, ry = 0, rx = 0, opts) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.BoxGeometry(w, h, d), typeof hex === 'number' ? rgb(hex) : hex, m, opts);
  }

  /** Cylinder with its base at y (not centred). */
  cyl(rTop, rBot, h, x, y, z, hex, seg = 10, opts) {
    const m = new THREE.Matrix4().makeTranslation(x, y + h / 2, z);
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), typeof hex === 'number' ? rgb(hex) : hex, m, opts);
  }

  sphere(r, x, y, z, hex, sx = 1, sy = 1, sz = 1, seg = 12, opts) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    return this.add(new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)), typeof hex === 'number' ? rgb(hex) : hex, m, opts);
  }

  torus(R, r, x, y, z, hex, rx = 0, ry = 0, rz = 0, seg = 16, opts) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.TorusGeometry(R, r, 6, seg), typeof hex === 'number' ? rgb(hex) : hex, m, opts);
  }

  /** Round tube from a to b (THREE.Vector3). */
  tube(a, b, r0, r1, hex, seg = 6, opts) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.CylinderGeometry(r1, r0, len, seg, 1), typeof hex === 'number' ? rgb(hex) : hex, m, opts);
  }

  build() {
    const g = mergeGeometries(this.list);
    this.list.forEach((p) => p.dispose());
    g.computeBoundingSphere();
    return g;
  }
}

// ----------------------------------------------------------------------------------------------- trees

const PROFILES = {
  ovoid: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.92 + 0.04))), 0.75) * (1.0 - 0.15 * t),
  round: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.94 + 0.03))), 0.6),
  columnar: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.96 + 0.02))), 0.45) * (0.75 + 0.25 * (1 - t)),
  vase: (t) => (0.35 + 0.65 * Math.pow(t, 0.8)) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.96 + 0.02)), 0.4),
  cone: (t) => Math.pow(1 - t, 0.9) * 1.0 + 0.04,
  weeping: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.96 + 0.02)), 0.5) * (1.1 - 0.35 * t)
};

export function crownProfile(name) {
  return PROFILES[name] || PROFILES.round;
}

/** The leaf-spray atlas: a cluster of overlapping leaves in white/grey (colour comes from the vertex colours), plus an
 * opaque corner for solid parts. */
export function createLeafTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(90210);
  const leaf = (x, y, a, l, w, shade) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, l, w, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,0.35)`;
    ctx.lineWidth = Math.max(1, w * 0.12);
    ctx.beginPath();
    ctx.moveTo(-l * 0.9, 0);
    ctx.lineTo(l * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  };
  const cx = size / 2;
  const cy = size / 2;
  for (let i = 0; i < 70; i++) {
    const r = Math.sqrt(rng()) * size * 0.42;
    const t = rng() * Math.PI * 2;
    const a = t + (rng() - 0.5) * 1.2;
    const shade = Math.floor(150 + rng() * 105);
    leaf(cx + Math.cos(t) * r, cy + Math.sin(t) * r, a, size * (0.07 + rng() * 0.05), size * (0.032 + rng() * 0.02), shade);
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(size - 8, size - 8, 8, 8); // the solid corner (uv 0.985, 0.985, v flipped by flipY below)
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.flipY = false; // v = 0.985 then hits the bottom-right rows we filled
  tex.needsUpdate = true;
  return tex;
}

/** Far-tree billboard texture: trunk and a ragged crown blob (white, the instance colour tints it). */
export function createBillboardTexture() {
  const w = 128;
  const h = 192;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(777);
  ctx.fillStyle = 'rgb(120,105,90)';
  ctx.fillRect(w / 2 - 3, h * 0.55, 6, h * 0.45);
  for (let i = 0; i < 520; i++) {
    const t = rng() * Math.PI * 2;
    const r = Math.sqrt(rng());
    const x = w / 2 + Math.cos(t) * r * w * 0.46;
    const y = h * 0.36 + Math.sin(t) * r * h * 0.3;
    const s = 4 + rng() * 5;
    const v = Math.floor(95 + 150 * (0.35 + 0.65 * (1 - (y / h - 0.1) * 1.4)) * (0.8 + rng() * 0.3));
    ctx.fillStyle = `rgb(${Math.min(255, v)},${Math.min(255, v)},${Math.min(255, v)})`;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** Near-LOD tree for a genus: trunk, leader, scaffold branches, a dark crown core and leaf-cluster cards (reference size). */
export function buildNearTree(genus) {
  const style = TREE_STYLES[genus] || TREE_STYLES.generic;
  const rng = mulberry32(Math.floor(hashString(genus) * 1e9));
  const parts = new Parts();
  const H = REF_H;
  const Rr = style.width * H;
  const baseY = style.base * H;
  const topY = H * 0.98;
  const ry = (topY - baseY) / 2;
  const cy = baseY + ry;
  const prof = crownProfile(style.profile);
  const bark = rgbS(style.bark);
  const leaf = style.leaf;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // trunk with a flared foot, then the leader through the crown
  parts.tube(V(0, -0.05, 0), V(0, baseY * 0.9, 0), 0.3, 0.17, bark, 8, { solidUv: true });
  parts.cyl(0.34, 0.42, 0.25, 0, 0, 0, bark, 8, { solidUv: true });
  parts.tube(V(0, baseY * 0.9, 0), V(0, topY * 0.93, 0), 0.17, 0.035, bark, 6, { solidUv: true });
  // scaffold branches from the trunk to points on the crown shell
  const nb = style.profile === 'cone' ? 6 : 9;
  const shellPoint = (t, ang, f = 1) => V(Math.cos(ang) * prof(t) * Rr * f, baseY + t * (topY - baseY), Math.sin(ang) * prof(t) * Rr * f);
  for (let i = 0; i < nb; i++) {
    const t0 = 0.05 + (i / nb) * 0.45;
    const ang = (i / nb) * Math.PI * 2 * 1.618 + rng();
    const from = V(0, baseY + t0 * (topY - baseY) * 0.5, 0);
    const to = shellPoint(Math.min(0.9, t0 + 0.2 + rng() * 0.25), ang, 0.62);
    parts.tube(from, to, 0.11, 0.035, bark, 5, { solidUv: true });
  }
  // dark core lathe so the crown reads as a mass between the cards
  const lathe = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    lathe.push(new THREE.Vector2(Math.max(0.02, prof(t) * Rr * 0.6), baseY + t * (topY - baseY)));
  }
  const core = rgbS([leaf[0] * 0.8, leaf[1] * 0.8, leaf[2] * 0.8]);
  parts.add(new THREE.LatheGeometry(lathe, 9), core, null, { solidUv: true });

  // leaf-cluster cards on and just inside the crown shell
  const cardCount = Math.round(style.cards * 1.1);
  const q = new THREE.Quaternion();
  const roll = new THREE.Quaternion();
  const mat = new THREE.Matrix4();
  const zAxis = V(0, 0, 1);
  for (let i = 0; i < cardCount; i++) {
    const t = Math.pow(rng(), 0.85);
    const ang = rng() * Math.PI * 2;
    const frac = 0.58 + 0.42 * Math.sqrt(rng());
    let pos = shellPoint(t, ang, frac);
    if (style.profile === 'weeping') pos.y -= (1 - t) * 0.0 + Math.pow(frac, 3) * 1.6 * rng();
    const centre = V(0, cy, 0);
    const out = pos.clone().sub(centre).normalize();
    const n = out.clone().multiplyScalar(0.7).add(V((rng() - 0.5) * 0.9, (rng() - 0.3) * 0.9, (rng() - 0.5) * 0.9)).normalize();
    q.setFromUnitVectors(zAxis, n);
    roll.setFromAxisAngle(zAxis, rng() * Math.PI * 2);
    q.multiply(roll);
    const size = style.card * 0.85 * (0.85 + rng() * 0.5);
    mat.compose(pos, q, V(size, size, size));
    const g = new THREE.PlaneGeometry(1, 1);
    g.applyMatrix4(mat);
    const normals = g.attributes.normal;
    const shade = (0.42 + 0.58 * (0.55 * frac + 0.45 * t)) * (0.85 + rng() * 0.3);
    const hueShift = 0.92 + rng() * 0.16;
    const col = rgbS([Math.min(1, leaf[0] * shade * hueShift * 1.1), Math.min(1, leaf[1] * shade), Math.min(1, leaf[2] * shade * hueShift)]);
    const colors = new Float32Array(12);
    for (let k = 0; k < 4; k++) {
      const nx = normals.getX(k) * 0.3 + out.x * 0.7;
      const ny = normals.getY(k) * 0.3 + out.y * 0.7;
      const nz = normals.getZ(k) * 0.3 + out.z * 0.7;
      const l = Math.hypot(nx, ny, nz) || 1;
      normals.setXYZ(k, nx / l, ny / l, nz / l);
      colors.set(col, k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.add(g, col);
  }
  return parts.build();
}

/** Mid-LOD crown: a lumpy ellipsoid (unit radii, centred), white with darker underside; the instance colour is the leaf colour. */
export function buildMidCrown() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const rng = mulberry32(4242);
  const cache = new Map();
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!cache.has(key)) cache.set(key, 0.84 + rng() * 0.3);
    const f = cache.get(key);
    p.setXYZ(i, x * f, y * f, z * f);
    const shade = 0.5 + 0.5 * (y * 0.5 + 0.5);
    colors.set([shade, shade, shade], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

export function buildMidTrunk() {
  return new THREE.CylinderGeometry(0.07, 0.11, 1, 5, 1).translate(0, 0.5, 0);
}

export function buildBillboard() {
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const b = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2);
  return mergeGeometries([a, b]);
}

// ----------------------------------------------------------------------------------------------- lamps

const POLE_GREY = 0x474a51; // RAL 7024 graphite grey
const HOUSING = 0x2a2d31;

export function buildPole() {
  return new THREE.CylinderGeometry(0.045, 0.075, 1, 10, 1).translate(0, 0.5, 0);
}

/** Pole foot: the fluted Københavner base, a plain collar for tube masts. */
export function buildPoleBase(kind) {
  const p = new Parts();
  if (kind === 'kbh') {
    p.cyl(0.115, 0.15, 1.15, 0, 0, 0, POLE_GREY, 12);
    p.cyl(0.165, 0.165, 0.07, 0, 1.12, 0, POLE_GREY, 12);
    p.cyl(0.13, 0.19, 0.12, 0, 0, 0, POLE_GREY, 12);
  } else if (kind === 'park') {
    p.cyl(0.075, 0.1, 0.5, 0, 0, 0, POLE_GREY, 10);
  } else {
    p.cyl(0.09, 0.11, 0.45, 0, 0, 0, POLE_GREY, 10);
    p.cyl(0.12, 0.12, 0.04, 0, 0.44, 0, POLE_GREY, 10);
  }
  return p.build();
}

/** Mast head at the pole top (origin): bracket arm towards +z and a cobra-head housing; the lens is separate. */
export function buildMastHead() {
  const p = new Parts();
  p.tube(new THREE.Vector3(0, 0.0, 0), new THREE.Vector3(0, 0.12, 0.55), 0.04, 0.03, POLE_GREY, 6);
  p.tube(new THREE.Vector3(0, 0.12, 0.55), new THREE.Vector3(0, 0.1, 0.95), 0.03, 0.03, POLE_GREY, 6);
  p.box(0.34, 0.1, 0.8, 0, 0.14, 1.1, HOUSING);
  p.sphere(0.17, 0, 0.14, 1.5, HOUSING, 1, 0.6, 0.9, 8);
  return p.build();
}

export function buildMastLens() {
  return new THREE.PlaneGeometry(0.26, 0.62).rotateX(Math.PI / 2).translate(0, 0.085, 1.1);
}

export function buildParkHead() {
  const g = new Parts();
  g.cyl(0.19, 0.12, 0.08, 0, 0, 0, HOUSING, 10);
  g.cyl(0.02, 0.2, 0.2, 0, 0.32, 0, HOUSING, 10);
  return g.build();
}

export function buildParkLens() {
  return new THREE.SphereGeometry(0.19, 10, 8).translate(0, 0.18, 0);
}

/** Wire-hung pendant (origin at the luminaire's lens plane): droppers up to the wire, a dished housing. */
export function buildPendant() {
  // 'Copenhagen lantern' (CGS441): bell-shaped shell, flat circular underside, 462 mm across, 363 mm high; fixed size
  const p = new Parts();
  p.cyl(0.012, 0.012, 0.7, -0.06, 0.2, 0, 0x202225, 4);
  p.cyl(0.012, 0.012, 0.7, 0.06, 0.2, 0, 0x202225, 4);
  p.cyl(0.05, 0.231, 0.34, 0, 0.0, 0, 0x8a8f93, 14);
  p.sphere(0.11, 0, 0.3, 0, 0x8a8f93, 1, 0.6, 1, 10);
  p.cyl(0.235, 0.235, 0.025, 0, -0.012, 0, 0x4b4f54, 14);
  return p.build();
}

export function buildPendantLens() {
  return new THREE.CircleGeometry(0.21, 14).rotateX(Math.PI / 2).translate(0, -0.026, 0);
}

export function buildWireSegment() {
  return new THREE.BoxGeometry(0.03, 0.03, 1).translate(0, 0, 0.5);
}

export function createPoolTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gr = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ----------------------------------------------------------------------------------------------- props

export function buildBin() {
  const p = new Parts();
  p.cyl(0.24, 0.22, 0.78, 0, 0.06, 0, [1, 1, 1], 14); // body: instance colour
  p.cyl(0.26, 0.26, 0.05, 0, 0.82, 0, 0x202325, 14);
  p.cyl(0.2, 0.2, 0.025, 0, 0.865, 0, 0x101214, 14);
  p.cyl(0.03, 0.03, 0.08, -0.14, 0, 0, 0x202325, 5);
  p.cyl(0.03, 0.03, 0.08, 0.14, 0, 0, 0x202325, 5);
  p.box(0.24, 0.06, 0.012, 0, 0.62, 0.235, 0x202325);
  return p.build();
}

export function buildWheelies() {
  const p = new Parts();
  const cols = [0x4d5356, 0x2e6a3d, 0x4d5356];
  cols.forEach((c, i) => {
    const x = (i - 1) * 0.68;
    p.box(0.56, 0.78, 0.66, x, 0.16 + 0.39, 0, c);
    p.box(0.6, 0.06, 0.72, x, 0.97, 0, i === 1 ? 0x2e6a3d : 0x1f2326);
    p.cyl(0.075, 0.075, 0.06, x - 0.26, 0.0, -0.22, 0x101214, 8);
    p.cyl(0.075, 0.075, 0.06, x + 0.26, 0.0, -0.22, 0x101214, 8);
  });
  return p.build();
}

export function buildGlassContainers() {
  const p = new Parts();
  const slate = 0x303941;
  const rib = 0x414a50;
  p.cyl(0.75, 0.75, 0.72, 0, 0, 0, slate, 36);
  p.cyl(0.43, 0.75, 0.18, 0, 0.72, 0, slate, 36);
  // Shallow ribs catch the daylight on the straight polyethylene wall.
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const r = 0.748;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    p.box(0.018, 0.7, 0.012, x, 0.36, z, i % 3 === 0 ? rib : slate, a);
  }
  p.cyl(0.43, 0.43, 0.17, 0, 0.9, 0, slate, 28);
  p.cyl(0.44, 0.44, 0.025, 0, 1.07, 0, 0x252d33, 28);
  // Two side-facing round inlets in the short lifting cap, with a small lifting loop above it.
  for (const side of [-1, 1]) {
    p.sphere(0.073, 0, 0.985, side * 0.431, 0x14191d, 1, 1, 0.08, 12);
    p.torus(0.077, 0.009, 0, 0.985, side * 0.436, 0x59636a, 0, 0, 0, 14);
  }
  p.torus(0.035, 0.008, 0, 1.12, 0, 0x59636a, 0, 0, 0, 10);
  // Small, worn light sticker field with a simple recycling mark.
  p.box(0.34, 0.25, 0.014, 0, 0.39, 0.748, 0xc8c6b9);
  p.tube(new THREE.Vector3(-0.075, 0.36, 0.762), new THREE.Vector3(0, 0.46, 0.762), 0.009, 0.009, 0x3e5046, 5);
  p.tube(new THREE.Vector3(0, 0.46, 0.762), new THREE.Vector3(0.075, 0.36, 0.762), 0.009, 0.009, 0x3e5046, 5);
  p.tube(new THREE.Vector3(0.075, 0.36, 0.762), new THREE.Vector3(-0.075, 0.36, 0.762), 0.009, 0.009, 0x3e5046, 5);
  return p.build();
}

export function buildBollardRound() {
  const p = new Parts();
  p.cyl(0.07, 0.075, 0.82, 0, 0, 0, [1, 1, 1], 10);
  p.sphere(0.075, 0, 0.82, 0, [1, 1, 1], 1, 0.7, 1, 8);
  p.cyl(0.078, 0.078, 0.025, 0, 0.62, 0, 0xd8d8d0, 10);
  return p.build();
}

export function buildBollardGranite() {
  const p = new Parts();
  p.box(0.3, 0.72, 0.3, 0, 0.36, 0, [1, 1, 1]);
  p.box(0.26, 0.05, 0.26, 0, 0.74, 0, [1, 1, 1]);
  return p.build();
}

export function buildBench() {
  const p = new Parts();
  const wood = 0x2f4a35; // RAL 6009 green boards
  const iron = 0x1c1e20;
  for (let i = 0; i < 4; i++) p.box(1.8, 0.035, 0.1, 0, 0.46, -0.16 + i * 0.12, wood);
  for (let i = 0; i < 3; i++) p.box(1.8, 0.1, 0.03, 0, 0.64 + i * 0.12, -0.25, wood, 0, -0.18);
  for (const x of [-0.82, 0.82]) {
    p.box(0.05, 0.46, 0.5, x, 0.23, -0.03, iron);
    p.box(0.05, 0.5, 0.05, x, 0.7, -0.26, iron, 0, -0.18);
    p.box(0.06, 0.05, 0.4, x, 0.6, -0.04, iron);
  }
  return p.build();
}

export function buildHoop() {
  const p = new Parts();
  const steel = 0x8e9396;
  p.cyl(0.015, 0.015, 0.74, 0, 0, -0.2, steel, 5);
  p.cyl(0.015, 0.015, 0.74, 0, 0, 0.2, steel, 5);
  p.box(0.03, 0.03, 0.43, 0, 0.75, 0, steel);
  return p.build();
}

/** City bicycles share saddle/grip anchors with cyclists.js; +z is forward, tyres sit at y = 0. */
export function buildBike(variant = 'city', { parked = true } = {}) {
  const p = new Parts({ frameTint: true });
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const cargo = variant === 'cargo-longjohn' || variant === 'cargo-trike';
  const trike = variant === 'cargo-trike';
  const metal = 0x858b8c;
  const dark = 0x25292c;
  const tube = (a, b, r = 0.016) => p.tube(a, b, r, r, [1, 1, 1], 4, { frameTint: true });
  const steel = (a, b, r = 0.011) => p.tube(a, b, r, r, metal, 4);
  const ring = (r, thickness, x, y, z, color, arc = Math.PI * 2, segments = 12) => {
    const g = new THREE.TorusGeometry(r, thickness, 4, segments, arc).rotateY(Math.PI / 2);
    p.add(g, rgb(color), new THREE.Matrix4().makeTranslation(x, y, z));
    g.dispose();
  };
  const wheels = trike ? [[0, -0.55, 0.32], [-0.4, 0.85, 0.29], [0.4, 0.85, 0.29]]
    : [[0, -0.55, 0.32], [0, cargo ? 1.5 : 0.55, cargo ? 0.26 : 0.32]];
  for (const [x, z, r] of wheels) {
    const y = r + 0.025;
    ring(r, 0.024, x, y, z, 0x16181a);
    ring(r - 0.025, 0.006, x, y, z, metal);
    ring(r + 0.035, 0.009, x, y, z, dark, Math.PI);
    // Three pairs of spokes suffice at street distance; no solid wheel discs.
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3;
      const dy = Math.sin(a) * (r - 0.03);
      const dz = Math.cos(a) * (r - 0.03);
      p.tube(V(x, y - dy, z - dz), V(x, y + dy, z + dz), 0.0025, 0.0025, metal, 3);
    }
  }
  const rear = V(0, 0.345, -0.55);
  const bb = V(0, 0.36, -0.02);
  const seat = V(0, 0.87, -0.2);
  const head = V(0, 0.99, 0.44);
  tube(rear, seat);
  tube(rear, bb);
  tube(bb, seat);
  if (variant === 'mens' || cargo) {
    tube(seat, head);
    tube(bb, head);
  } else {
    // The two low tubes leave the step-through opening clear.
    tube(seat, V(0, 0.43, 0.2));
    tube(V(0, 0.43, 0.2), head);
    tube(bb, V(0, 0.31, 0.2));
    tube(V(0, 0.31, 0.2), head);
  }
  if (cargo) {
    const end = trike ? 0.85 : 1.5;
    const steeringBase = V(0, 0.27, 0.3);
    tube(bb, steeringBase, 0.025);
    tube(steeringBase, V(0, 0.27, end), 0.025);
    tube(head, steeringBase, 0.022);
    if (trike) {
      tube(V(0, 0.27, end), V(0, 0.315, end), 0.025);
      steel(V(-0.4, 0.315, end), V(0.4, 0.315, end), 0.018);
    } else {
      tube(V(0, 0.27, end - 0.06), V(0, 0.54, end - 0.06), 0.022);
      steel(V(0, 0.54, end - 0.06), V(0, 0.285, end), 0.018);
    }
  } else {
    for (const x of [-0.035, 0.035]) steel(V(x, 0.99, 0.44), V(x, 0.345, 0.55), 0.013);
  }
  steel(seat, V(0, 0.94, -0.2), 0.014);
  p.box(0.2, 0.06, 0.27, 0, 0.96, -0.2, 0x202326);
  steel(head, V(0, 1.14, 0.42), 0.014);
  for (const side of [-1, 1]) {
    steel(V(0, 1.14, 0.42), V(side * 0.22, 1.14, 0.4));
    steel(V(side * 0.22, 1.14, 0.4), V(side * 0.25, 1.14, 0.24));
    p.tube(V(side * 0.25, 1.14, 0.29), V(side * 0.25, 1.14, 0.19), 0.018, 0.018, dark, 4);
  }
  p.box(0.05, 0.12, 0.48, 0.055, 0.36, -0.22, dark); // chain case
  // A small rear carrier sits above the mudguard, supported from the rear axle.
  p.box(0.27, 0.025, 0.4, 0, 0.76, -0.58, metal);
  for (const side of [-1, 1]) steel(V(side * 0.13, 0.76, -0.68), V(side * 0.035, 0.345, -0.55), 0.008);
  steel(V(0, 0.76, -0.38), seat, 0.008);
  if (parked) p.tube(V(0, 0.34, -0.06), V(-0.2, 0.02, -0.22), 0.009, 0.009, dark, 4);
  // Thin walls and an open top keep baskets/crates readable instead of solid cubes.
  const box = (w, h, d, y, z, color) => {
    p.box(w, 0.02, d, 0, y, z, color);
    for (const side of [-1, 1]) {
      p.box(0.018, h, d, side * (w - 0.018) / 2, y + h / 2, z, color);
      p.box(w, h, 0.018, 0, y + h / 2, z + side * (d - 0.018) / 2, color);
    }
  };
  if (cargo) {
    const w = trike ? 0.7 : 0.54;
    const d = trike ? 0.86 : 0.9;
    const z = trike ? 0.73 : 0.8;
    box(w, 0.43, d, 0.34, z, 0xa99b7d);
    // Black top rails and the low passenger bench of the Christiania box.
    for (const side of [-1, 1]) p.box(0.028, 0.025, d, side * w / 2, 0.77, z, dark);
    p.box(w, 0.025, 0.028, 0, 0.77, z - d / 2, dark);
    p.box(w, 0.025, 0.028, 0, 0.77, z + d / 2, dark);
    if (trike) p.box(0.64, 0.04, 0.24, 0, 0.55, z - 0.22, dark);
  } else if (variant === 'city-crate' || variant === 'mens') {
    box(0.36, 0.23, 0.38, 0.79, -0.6, 0x30373a);
  } else if (variant === 'city-childseat') {
    p.box(0.26, 0.05, 0.3, 0, 0.88, -0.58, 0x3c4649);
    p.box(0.27, 0.38, 0.06, 0, 1.07, -0.73, 0x3c4649);
    for (const side of [-1, 1]) {
      p.box(0.04, 0.16, 0.22, side * 0.14, 0.96, -0.57, dark);
      p.box(0.09, 0.04, 0.16, side * 0.16, 0.66, -0.38, dark);
    }
  } else {
    box(0.4, 0.23, 0.33, 0.9, 0.65, 0x6c6050);
    steel(V(0, 0.345, 0.55), V(0, 0.9, 0.65), 0.008);
    for (const x of [-0.15, -0.05, 0.05, 0.15]) p.box(0.008, 0.2, 0.006, x, 1.015, 0.818, 0x8c7c65);
  }
  return p.build();
}

/** Cheap silhouette between 40 m and the 120 m cull edge, retaining the moving rider's saddle/grip anchors. */
export function buildBikeProxy() {
  const p = new Parts({ frameTint: true });
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (const z of [-0.55, 0.55]) p.torus(0.32, 0.025, 0, 0.34, z, 0x25292b, 0, Math.PI / 2, 0, 7);
  p.tube(V(0, 0.34, -0.55), V(0, 0.94, -0.2), 0.025, 0.025, [1, 1, 1], 4, { frameTint: true });
  p.tube(V(0, 0.34, -0.55), V(0, 0.42, 0.04), 0.025, 0.025, [1, 1, 1], 4, { frameTint: true });
  p.tube(V(0, 0.42, 0.04), V(0, 0.94, -0.2), 0.025, 0.025, [1, 1, 1], 4, { frameTint: true });
  p.tube(V(0, 0.42, 0.04), V(0, 0.99, 0.44), 0.025, 0.025, [1, 1, 1], 4, { frameTint: true });
  p.tube(V(0, 0.34, 0.55), V(0, 1.14, 0.42), 0.025, 0.025, [1, 1, 1], 4, { frameTint: true });
  p.box(0.2, 0.06, 0.27, 0, 0.96, -0.2, 0x202326);
  p.box(0.5, 0.03, 0.15, 0, 1.14, 0.31, 0x858b8c);
  return p.build();
}

export function buildMeter() {
  const p = new Parts();
  p.box(0.42, 1.28, 0.28, 0, 0.64 + 0.1, 0, 0x21406a);
  p.box(0.32, 0.22, 0.02, 0, 1.12, 0.145, 0x9fc7d6);
  p.box(0.32, 0.12, 0.02, 0, 0.82, 0.145, 0x15161a);
  p.box(0.46, 0.06, 0.32, 0, 1.4, 0, 0x16294a);
  return p.build();
}

export function buildShelter() {
  const p = new Parts();
  const frame = 0x1d4f8f; // Movia blue
  const glass = 0xa6bcc4;
  for (const x of [-1.45, 1.45]) {
    p.box(0.06, 2.35, 0.06, x, 1.175, 0.7, frame);
    p.box(0.06, 2.35, 0.06, x, 1.175, -0.7, frame);
  }
  p.box(3.2, 0.08, 1.7, 0, 2.4, 0, frame, 0, 0.05);
  p.box(2.84, 1.6, 0.025, 0, 1.25, -0.7, glass);
  for (const x of [-1.45, 1.45]) p.box(0.025, 1.6, 1.34, x, 1.25, 0, glass);
  p.box(2.0, 0.04, 0.4, 0, 0.5, -0.42, 0x6d7276);
  p.box(2.0, 0.04, 0.05, 0, 0.78, -0.62, 0x6d7276);
  p.box(0.5, 0.75, 0.04, 1.1, 1.0, -0.66, 0xe0b92a); // route map
  return p.build();
}

export function buildFlag() {
  const p = new Parts();
  p.cyl(0.035, 0.04, 3.9, 0, 0, 0, 0x1d4f8f, 8);
  p.box(0.5, 0.5, 0.025, 0, 3.55, 0.03, 0xf0c514);
  p.box(0.3, 0.1, 0.03, 0, 3.65, 0.04, 0x1d2024);
  p.box(0.5, 0.34, 0.025, 0, 3.0, 0.03, 0xe8e8e2);
  return p.build();
}

export function buildCountdown() {
  const p = new Parts();
  p.box(0.62, 0.3, 0.1, 0, 2.55, 0.12, 0x15171a);
  p.box(0.54, 0.2, 0.012, 0, 2.55, 0.175, 0xff9d1c);
  return p.build();
}

export function buildRescuePost() {
  const p = new Parts();
  p.cyl(0.04, 0.045, 1.7, 0, 0, 0, 0xd7d7d0, 8);
  p.box(0.5, 0.5, 0.18, 0, 1.15, 0.06, 0xc8261e);
  p.torus(0.2, 0.06, 0, 1.15, 0.17, 0xf4f4ee, 0, 0, 0, 14);
  for (let i = 0; i < 4; i++) {
    const a = (i + 0.5) * (Math.PI / 2);
    p.box(0.1, 0.1, 0.13, Math.cos(a) * 0.2, 1.15 + Math.sin(a) * 0.2, 0.17, 0xc8261e, 0, 0);
  }
  p.box(0.2, 0.12, 0.02, 0, 1.58, 0.1, 0xf4f4ee);
  return p.build();
}

export function buildPlinth() {
  const p = new Parts();
  p.box(1.3, 0.12, 1.3, 0, 0.06, 0, 0x7a7872);
  p.box(1.0, 0.8, 1.0, 0, 0.52, 0, 0x8d8a84);
  p.box(1.12, 0.08, 1.12, 0, 0.96, 0, 0x7a7872);
  p.cyl(0.2, 0.26, 0.95, 0, 1.0, 0, 0x536a5a, 9);
  p.sphere(0.14, 0, 2.08, 0, 0x536a5a, 1, 1.1, 1, 8);
  p.cyl(0.05, 0.05, 0.6, -0.26, 1.35, 0, 0x536a5a, 5);
  p.cyl(0.05, 0.05, 0.6, 0.26, 1.35, 0, 0x536a5a, 5);
  return p.build();
}

/** CitySwan-style low lake-path light: a slim dark post with a projecting downlight head (about 1 m). */
export function buildLakePost() {
  const p = new Parts();
  p.cyl(0.045, 0.06, 0.98, 0, 0, 0, 0x2b2e33, 8);
  p.box(0.16, 0.05, 0.16, 0, 1.0, 0.04, 0x1d1f22);
  return p.build();
}
