import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, attribute, uv, texture, positionLocal, positionWorld, cameraPosition, normalize, dot, max, pow, mix, smoothstep, sin, time } from 'three/tsl';
import { REF_H, TREE_STYLES, hashString, hash2, mulberry32 } from './street-furniture-data.js';
import { OCTOBER_DAY, PHENOLOGY_SPREAD, treeSeason, treeLeafColour, treePhenologyOffset, treeGeometryDensity } from './tree-season.js';
import { cityUniforms } from './tsl-materials.js';
import { noise2D } from './surface-materials-cph.js';

// js/tree-geometry-cph.js
// Procedural trees of the Copenhagen twin, in the manner of ez-tree (https://github.com/dgreenheck/ez-tree, MIT) and the
// classic "branch skeleton + leaf-spray cards" instancing: every genus has a recursive branch skeleton (trunk with root
// flare, scaffold limbs, twigs) with leaf-spray cards at the twig tips, drawn from ONE leaf atlas that is painted at
// load (heart-shaped lime leaves, palmate horse-chestnut leaves, lobed plane / maple leaves, ...). Three levels of
// detail per genus, all instanced: near (full skeleton), mid (cluster cards + trunk), far (a painted cross billboard).
// The tree material sways in the wind (per-vertex amplitude `sway`) and lets sunlight through the leaves.
//   One interleaved vertex buffer plus two vec4 instance buffers for leaf colour, density and phenology.
// Licences: nothing downloaded; the algorithm is original, ez-tree is credited as the design reference only.

// Crown normalization slightly enlarges card edges again: 0.66 gives about 30%
// smaller final world-space sprays while preserving surveyed crown dimensions.
const LEAF_CARD_SCALE = 0.66;

export const ATLAS = Object.freeze({ cols: 4, rows: 2, size: 1024 });
/** Leaf-atlas cell per genus (0 heart, 1 palmate, 2 lobed, 3 ovate-serrate, 4 small ovate, 5 compound, 6 lanceolate, 7 needles). */
export const LEAF_CELL = { lime: 0, chestnut: 1, plane: 2, maple: 2, oak: 2, elm: 3, generic: 3, birch: 3, cherry: 4, hawthorn: 4, robinia: 5, ash: 5, willow: 6, poplar: 4, conifer: 7 };

/** Per-genus look: leaf spray size / count (reference tree, metres), lit leaf colour (sRGB), bark, limb habit. */
export const LOOK = {
  lime: { size: 1.0, cards: 360, leaf: [0.46, 0.62, 0.22], bark: [0.30, 0.26, 0.22], limbs: 9, up: 0.9, droop: 0.0, tips: 0.8, excurrent: true },
  chestnut: { size: 1.75, cards: 250, leaf: [0.30, 0.50, 0.16], bark: [0.27, 0.21, 0.17], limbs: 7, up: 0.35, droop: 0.28, tips: 0.9, excurrent: false },
  plane: { size: 1.5, cards: 260, leaf: [0.38, 0.54, 0.20], bark: [0.60, 0.56, 0.44], limbs: 7, up: 0.65, droop: 0.05, tips: 0.8, excurrent: false },
  elm: { size: 1.0, cards: 320, leaf: [0.34, 0.52, 0.18], bark: [0.28, 0.23, 0.19], limbs: 8, up: 1.05, droop: 0.1, tips: 0.85, excurrent: false },
  maple: { size: 1.35, cards: 280, leaf: [0.40, 0.56, 0.18], bark: [0.34, 0.30, 0.26], limbs: 8, up: 0.8, droop: 0.0, tips: 0.8, excurrent: false },
  cherry: { size: 0.95, cards: 260, leaf: [0.42, 0.56, 0.22], bark: [0.34, 0.20, 0.16], limbs: 7, up: 0.7, droop: 0.05, tips: 0.8, excurrent: false },
  oak: { size: 1.25, cards: 280, leaf: [0.28, 0.44, 0.14], bark: [0.25, 0.20, 0.16], limbs: 7, up: 0.45, droop: 0.12, tips: 0.9, excurrent: false },
  robinia: { size: 0.95, cards: 240, leaf: [0.44, 0.58, 0.24], bark: [0.30, 0.25, 0.20], limbs: 7, up: 0.9, droop: 0.0, tips: 0.8, excurrent: false },
  poplar: { size: 0.85, cards: 260, leaf: [0.34, 0.52, 0.18], bark: [0.34, 0.31, 0.27], limbs: 10, up: 1.25, droop: 0.0, tips: 0.8, excurrent: true },
  willow: { size: 1.1, cards: 240, leaf: [0.50, 0.62, 0.28], bark: [0.28, 0.24, 0.20], limbs: 7, up: 0.7, droop: 0.55, tips: 0.9, excurrent: false },
  ash: { size: 1.2, cards: 240, leaf: [0.38, 0.54, 0.20], bark: [0.36, 0.33, 0.29], limbs: 8, up: 0.85, droop: 0.0, tips: 0.8, excurrent: false },
  birch: { size: 0.85, cards: 240, leaf: [0.46, 0.62, 0.24], bark: [0.80, 0.78, 0.72], limbs: 9, up: 0.95, droop: 0.12, tips: 0.8, excurrent: true },
  hawthorn: { size: 0.85, cards: 200, leaf: [0.34, 0.52, 0.20], bark: [0.30, 0.25, 0.22], limbs: 7, up: 0.6, droop: 0.05, tips: 0.8, excurrent: false },
  conifer: { size: 1.0, cards: 280, leaf: [0.14, 0.30, 0.17], bark: [0.28, 0.22, 0.18], limbs: 12, up: 0.1, droop: 0.15, tips: 0.9, excurrent: true },
  generic: { size: 1.1, cards: 260, leaf: [0.38, 0.54, 0.20], bark: [0.30, 0.26, 0.22], limbs: 8, up: 0.8, droop: 0.0, tips: 0.8, excurrent: false }
};
export const lookOf = (genus) => LOOK[genus] || LOOK.generic;
export const styleOf = (genus) => TREE_STYLES[genus] || TREE_STYLES.generic;

/** Shared by all LODs; colours are decoded from sRGB exactly once before upload. */
export function treeInstanceSeason(genus, day, x, z, tint = 1) {
  const offset = treePhenologyOffset(x, z);
  const summer = lookOf(genus).leaf;
  const state = treeSeason(genus, day + offset, summer);
  const colour = d => rgbLin(treeLeafColour(genus, d, summer)).map(v => v * tint);
  return { ...state, offset,
    early: [...colour(day + offset - 3), state.density],
    late: [...colour(day + offset + 3), offset] };
}

export function attachTreeSeasonAttributes(geometry, capacity) {
  const early = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const late = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  geometry.setAttribute('leafEarly', early);
  geometry.setAttribute('leafLate', late);
  return { early, late };
}

const PROFILES = {
  ovoid: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.92 + 0.04))), 0.75) * (1.0 - 0.15 * t),
  round: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.94 + 0.03))), 0.6),
  columnar: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.96 + 0.02))), 0.45) * (0.75 + 0.25 * (1 - t)),
  vase: (t) => (0.35 + 0.65 * Math.pow(t, 0.8)) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.96 + 0.02)), 0.4),
  cone: (t) => Math.pow(1 - t, 0.9) * 1.0 + 0.04,
  weeping: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.96 + 0.02)), 0.5) * (1.1 - 0.35 * t)
};
export const crownProfile = (name) => PROFILES[name] || PROFILES.round;

// ----------------------------------------------------------------------------------------------- leaf atlas

const rgbLin = (srgb) => {
  const c = new THREE.Color().setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

/** Leaf data atlas: R = shading, G = per-blade autumn progression, A = silhouette. No sRGB decoding. */
function paintLeaf(ctx, kind, l, shade) {
  const w = l * 0.5;
  const hue = Math.floor(40 + hash2(l, shade, 47) * 175);
  ctx.fillStyle = `rgb(${shade},${hue},${shade})`;
  ctx.beginPath();
  if (kind === 'heart') { // lime: heart-shaped, asymmetric base, pointed tip
    ctx.moveTo(l, 0);
    ctx.bezierCurveTo(l * 0.8, -w * 0.9, l * 0.25, -w * 1.05, -l * 0.02, -w * 0.45);
    ctx.bezierCurveTo(-l * 0.12, -w * 0.1, -l * 0.08, w * 0.35, 0, w * 0.55);
    ctx.bezierCurveTo(l * 0.3, w * 1.0, l * 0.8, w * 0.85, l, 0);
  } else if (kind === 'ovate') { // elm / cherry / hawthorn: ovate, pointed
    ctx.moveTo(l, 0);
    ctx.bezierCurveTo(l * 0.75, -w * 0.95, l * 0.2, -w * 0.9, 0, -w * 0.12);
    ctx.lineTo(0, w * 0.14);
    ctx.bezierCurveTo(l * 0.2, w * 0.95, l * 0.75, w * 0.9, l, 0);
  } else if (kind === 'lance') { // willow, poplar
    ctx.moveTo(l, 0);
    ctx.bezierCurveTo(l * 0.7, -w * 0.5, l * 0.25, -w * 0.5, 0, 0);
    ctx.bezierCurveTo(l * 0.25, w * 0.5, l * 0.7, w * 0.5, l, 0);
  } else if (kind === 'leaflet') { // compound-leaf leaflet (obovate)
    ctx.ellipse(l * 0.5, 0, l * 0.5, w * 0.62, 0, 0, Math.PI * 2);
  } else if (kind === 'obovate') { // chestnut leaflet: widest beyond the middle, pointed tip
    ctx.moveTo(l, 0);
    ctx.bezierCurveTo(l * 0.95, -w * 0.9, l * 0.45, -w * 1.1, 0, -w * 0.1);
    ctx.lineTo(0, w * 0.1);
    ctx.bezierCurveTo(l * 0.45, w * 1.1, l * 0.95, w * 0.9, l, 0);
  } else if (kind === 'lobed') { // maple / plane: five-pointed lobed blade
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i / 5) * Math.PI * 2 + 0.0;
      pts.push([Math.cos(a) * l * 0.5, Math.sin(a) * l * 0.5, a]);
    }
    ctx.translate(l * 0.5, 0);
    for (let i = 0; i < 5; i++) {
      const a0 = -Math.PI / 2 + (i / 5) * Math.PI * 2;
      const a1 = -Math.PI / 2 + ((i + 0.5) / 5) * Math.PI * 2;
      const tip = [Math.cos(a0) * l * 0.5, Math.sin(a0) * l * 0.5];
      const notch = [Math.cos(a1) * l * 0.2, Math.sin(a1) * l * 0.2];
      if (i === 0) ctx.moveTo(tip[0], tip[1]); else ctx.lineTo(tip[0], tip[1]);
      ctx.lineTo(notch[0], notch[1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.translate(-l * 0.5, 0);
    return;
  } else {
    ctx.ellipse(l * 0.5, 0, l * 0.5, w * 0.7, 0, 0, Math.PI * 2);
  }
  ctx.closePath();
  ctx.fill();
  // midrib and lateral veins
  // Darker, later-coloured edges give the blade a dry curled rim.
  ctx.strokeStyle = `rgb(${Math.floor(shade * 0.70)},${Math.min(255, hue + 35)},${shade})`;
  ctx.lineWidth = Math.max(0.8, l * 0.035);
  ctx.stroke();
  ctx.strokeStyle = `rgba(${Math.max(40, shade - 55)},${hue},${shade},0.75)`;
  ctx.lineWidth = Math.max(0.8, l * 0.025);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(l * 0.95, 0);
  for (let k = 1; k <= 4; k++) {
    const x = l * (0.15 + k * 0.17);
    ctx.moveTo(x - l * 0.12, 0);
    ctx.lineTo(x + l * 0.05, -w * 0.62);
    ctx.moveTo(x - l * 0.12, 0);
    ctx.lineTo(x + l * 0.05, w * 0.62);
  }
  ctx.stroke();
}

/** Paints one spray card into the cell (cx, cy, size S): the leaves of a twig end. */
function paintSpray(ctx, cell, cx, cy, S, rng) {
  ctx.save();
  ctx.translate(cx + S / 2, cy + S * 0.94);
  const stem = (x0, y0, x1, y1, wd) => { ctx.strokeStyle = 'rgb(120,100,70)'; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  const leafAt = (x, y, ang, l, kind) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    paintLeaf(ctx, kind, l, Math.floor(170 + rng() * 85));
    ctx.restore();
  };
  const spray = (kind, n, l0, lj, spread) => {
    stem(0, 0, 0, -S * 0.62, S * 0.012);
    for (let i = 0; i < n; i++) {
      const t = 0.15 + 0.8 * (i / Math.max(1, n - 1));
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * S * 0.02 * rng();
      const y = -S * 0.7 * t - S * 0.05;
      const ang = -Math.PI / 2 + side * (0.5 + rng() * spread) + (rng() - 0.5) * 0.3;
      leafAt(x, y, ang, l0 * (1 - lj * rng()) * (1.08 - 0.5 * t * 0.5), kind);
    }
    leafAt(0, -S * 0.72, -Math.PI / 2 + (rng() - 0.5) * 0.4, l0 * 0.85, kind);
  };
  if (cell === 0) { spray('heart', 18, S * 0.30, 0.3, 0.95); }
  else if (cell === 1) { // three palmate leaves: seven obovate leaflets fanned from a petiole
    for (let k = 0; k < 3; k++) {
      const bx = (k - 1) * S * 0.3;
      const by = -S * (0.28 + 0.14 * (k % 2));
      stem(0, 0, bx, by, S * 0.015);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate((k - 1) * 0.45);
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i - 3) * 0.36;
        const l = S * (0.34 - Math.abs(i - 3) * 0.035);
        ctx.save();
        ctx.rotate(a);
        paintLeaf(ctx, 'obovate', l, Math.floor(175 + rng() * 80));
        ctx.restore();
      }
      ctx.restore();
    }
  } else if (cell === 2) { // lobed leaves
    stem(0, 0, 0, -S * 0.5, S * 0.012);
    for (let i = 0; i < 5; i++) {
      const bx = (rng() - 0.5) * S * 0.5;
      const by = -S * (0.18 + 0.15 * i * 0.9);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(-Math.PI / 2 + (rng() - 0.5) * 1.6);
      paintLeaf(ctx, 'lobed', S * 0.3, Math.floor(175 + rng() * 80));
      ctx.restore();
    }
  } else if (cell === 3) { spray('ovate', 16, S * 0.30, 0.3, 0.7); }
  else if (cell === 4) { spray('ovate', 20, S * 0.22, 0.3, 0.9); }
  else if (cell === 5) { // compound leaf: a rachis with paired leaflets
    for (let k = 0; k < 2; k++) {
      ctx.save();
      ctx.rotate((k - 0.5) * 0.7);
      stem(0, 0, 0, -S * 0.78, S * 0.012);
      for (let i = 0; i < 8; i++) {
        const y = -S * (0.12 + i * 0.085);
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(0, y);
          ctx.rotate(-Math.PI / 2 + side * 1.0);
          paintLeaf(ctx, 'leaflet', S * 0.17, Math.floor(175 + rng() * 80));
          ctx.restore();
        }
      }
      ctx.restore();
    }
  } else if (cell === 6) { spray('lance', 20, S * 0.32, 0.25, 0.55); }
  else { // needle sprig: fine radiating needles along a stem
    stem(0, 0, 0, -S * 0.8, S * 0.02);
    ctx.strokeStyle = 'rgb(215,215,215)';
    ctx.lineWidth = S * 0.012;
    for (let i = 0; i < 70; i++) {
      const y = -S * (0.05 + 0.75 * (i / 70));
      const side = i % 2 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(side * S * (0.2 + rng() * 0.12), y - S * (0.03 + rng() * 0.05));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The shared leaf atlas (ATLAS.cols x ATLAS.rows cells of a spray each, solid corner for bark), as a DataTexture with mips. */
export function createLeafAtlas() {
  const { cols, rows, size } = ATLAS;
  const W = size;
  const H = (size * rows) / cols;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);
  const S = W / cols;
  for (let c = 0; c < cols * rows; c++) {
    paintSpray(ctx, c, (c % cols) * S, Math.floor(c / cols) * S, S, mulberry32(9100 + c));
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(W - 10, H - 10, 10, 10); // the solid corner for bark and branches (uv 0.995, 0.995)
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) { d[i] = d[i + 1] = d[i + 2] = 225; d[i + 3] = 0; } // the colour under transparent pixels, so mips do not darken the edges
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ----------------------------------------------------------------------------------------------- geometry builder

class Builder {
  constructor() {
    this.position = [];
    this.normal = [];
    this.uv = [];
    this.color = [];
    this.sway = [];
    this.leafData = [];
    this.index = [];
    this.sprays = [];
  }

  vert(p, n, u, v, c, s0, s1, leaf = [-1, 0.5, 1, 0]) {
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.color.push(c[0], c[1], c[2]);
    this.sway.push(s0, s1);
    this.leafData.push(...leaf);
    return this.position.length / 3 - 1;
  }

  /** Tapered wood tube along a polyline of [x, y, z, radius] points. */
  wood(path, color, swayOf, seg = 5) {
    const SOLID = 0.995;
    const rings = [];
    for (let k = 0; k < path.length; k++) {
      const p = path[k];
      const a = path[Math.max(0, k - 1)];
      const b = path[Math.min(path.length - 1, k + 1)];
      const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const ref = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(t, ref).normalize();
      const w = new THREE.Vector3().crossVectors(t, u).normalize();
      const ring = [];
      const shade = 0.82 + 0.3 * ((k * 7 + path.length * 3) % 5) / 5;
      for (let s = 0; s < seg; s++) {
        const th = (s / seg) * Math.PI * 2;
        const n = u.clone().multiplyScalar(Math.cos(th)).add(w.clone().multiplyScalar(Math.sin(th)));
        const c = color.map((x) => x * (shade * (s % 2 ? 0.94 : 1.06)));
        ring.push(this.vert([p[0] + n.x * p[3], p[1] + n.y * p[3], p[2] + n.z * p[3]], [n.x, n.y, n.z], SOLID, SOLID, c, swayOf(p), 0));
      }
      rings.push(ring);
    }
    for (let k = 0; k + 1 < rings.length; k++) {
      for (let s = 0; s < seg; s++) {
        const a = rings[k][s];
        const b = rings[k][(s + 1) % seg];
        const c = rings[k + 1][(s + 1) % seg];
        const d = rings[k + 1][s];
        this.index.push(a, b, c, a, c, d);
      }
    }
  }

  /** A leaf-spray card centred on p, facing roughly n (blended with the outward direction), `size` metres. */
  card(p, face, outward, size, cell, color, swayAmp, rng) {
    const n = new THREE.Vector3(...face).multiplyScalar(0.55).add(new THREE.Vector3(...outward).multiplyScalar(0.45)).normalize();
    // the spray's stem end (bottom of the cell) points down-ish: the card's up axis is the world up projected onto its plane
    const ref = Math.abs(n.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ref, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const roll = (rng() - 0.5) * 1.9;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const ru = u.clone().multiplyScalar(cr).add(v.clone().multiplyScalar(sr));
    const rv = v.clone().multiplyScalar(cr).sub(u.clone().multiplyScalar(sr));
    const { cols, rows } = ATLAS;
    const u0 = (cell % cols) / cols + 0.003;
    const v0 = Math.floor(cell / cols) / rows + 0.003;
    const du = 1 / cols - 0.006;
    const dv = 1 / rows - 0.006;
    const h = size / 2;
    const corner = [[-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0], [-1, 1, 0, 0]];
    const out = [outward[0], outward[1], outward[2]];
    const rank = hash2(p[0] + p[1], p[2], this.sprays.length);
    const leaf = [rank, hash2(p[0], p[2], 123), color[0], 1];
    const ids = corner.map(([sx, sy, cu, cv]) => {
      const pos = [p[0] + ru.x * sx * h + rv.x * sy * h, p[1] + ru.y * sx * h + rv.y * sy * h, p[2] + ru.z * sx * h + rv.z * sy * h];
      // A shallow saddle folds the two triangles without adding vertices/triangles.
      const curl = sx * sy * size * 0.09;
      pos[0] += n.x * curl; pos[1] += n.y * curl; pos[2] += n.z * curl;
      // the stem end (bottom of the cell) sits on the twig: it sways less than the free tip
      const amp = swayAmp * (0.45 + 0.55 * (1 - cv));
      return this.vert(pos, [n.x * 0.6 + out[0] * 0.4, n.y * 0.6 + out[1] * 0.4, n.z * 0.6 + out[2] * 0.4], u0 + cu * du, v0 + cv * dv, color, amp, 0.035 + 0.03 * (1 - cv), leaf);
    });
    this.sprays.push({ start: this.index.length, rank });
    this.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }

  geometry({ radius = null, height = null, density = 1 } = {}) {
    // Measure the complete crown before shedding: autumn must not change the scale
    // of the retained branches. Normalise the card edges too, not just their centres.
    let extent = 0, top = 0;
    for (let i = 0; i < this.position.length; i += 3) {
      extent = Math.max(extent, Math.hypot(this.position[i], this.position[i + 2]));
      top = Math.max(top, this.position[i + 1]);
    }
    const sx = radius == null ? 1 : radius / extent;
    const sy = height == null ? 1 : height / top;
    const packed = new Float32Array(this.position.length / 3 * 17);
    for (let v = 0; v < packed.length / 17; v++) {
      const i = v * 3, j = v * 2;
      const normal = [this.normal[i] / sx, this.normal[i + 1] / sy, this.normal[i + 2] / sx];
      const length = Math.hypot(...normal) || 1;
      packed.set([this.position[i] * sx, this.position[i + 1] * sy, this.position[i + 2] * sx,
        ...normal.map(n => n / length), this.uv[j], this.uv[j + 1],
        ...this.color.slice(i, i + 3), this.sway[j], this.sway[j + 1], ...this.leafData.slice(v * 4, v * 4 + 4)], v * 17);
    }
    // One physical vertex buffer, instanceMatrix (conservatively four), and two
    // seasonal vec4 instance buffers: seven for colour and shadow pipelines.
    const buffer = new THREE.InterleavedBuffer(packed, 17);
    const g = new THREE.BufferGeometry();
    for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['uv', 2, 6], ['color', 3, 8], ['sway', 2, 11], ['leafData', 4, 13]]) {
      g.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, size, offset));
    }
    const dropped = new Set(this.sprays.filter(s => s.rank >= density).map(s => s.start));
    const index = this.index.filter((_, i) => !dropped.has(Math.floor(i / 6) * 6));
    g.setIndex(new THREE.Uint32BufferAttribute(index, 1));
    g.userData.fullTriangles = this.index.length / 3;
    g.userData.woodTriangles = this.index.length / 3 - this.sprays.length * 2;
    g.userData.leafCards = this.sprays.length - dropped.size;
    g.computeBoundingSphere();
    return g;
  }

}

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/** Skeleton of one genus: the limbs and twigs as polylines [x, y, z, r], plus the tips where leaf sprays attach. */
export function treeSkeleton(genus) {
  const style = styleOf(genus);
  const look = lookOf(genus);
  const rng = mulberry32(Math.floor(hashString(`tree:${genus}`) * 1e9));
  const H = REF_H;
  const Rr = style.width * H;
  const baseY = style.base * H;
  const topY = H * 0.98;
  const prof = crownProfile(style.profile);
  const lean = [(rng() - 0.5) * 0.25, (rng() - 0.5) * 0.25];
  const trunkR = 0.27 * (genus === 'plane' || genus === 'chestnut' ? 1.15 : 1);
  const limbs = [];
  const twigs = [];
  const tips = [];
  const leaderTop = look.excurrent ? topY * 0.95 : baseY + (topY - baseY) * 0.55;
  const leaderAt = (y) => [lean[0] * (y / H), y, lean[1] * (y / H)];
  // trunk: root flare, then the leader (excurrent species run to the top, the others fork into limbs)
  const trunk = [];
  const nT = 6;
  for (let k = 0; k <= nT; k++) {
    const y = (k / nT) * (look.excurrent ? leaderTop : baseY + (topY - baseY) * 0.35);
    const t = y / (baseY + 0.001);
    const r = look.excurrent ? trunkR * (1 - 0.82 * (y / leaderTop)) : trunkR * Math.max(0.5, 1 - 0.38 * Math.min(1, t));
    const flare = k === 0 ? 1.45 : k === 1 ? 1.12 : 1;
    const wobble = (rng() - 0.5) * 0.03 * y;
    const [lx, , lz] = leaderAt(y);
    trunk.push([lx + wobble, y, lz - wobble, Math.max(0.03, r * flare)]);
  }
  limbs.push({ path: trunk, kind: 'trunk' });
  const nb = look.limbs;
  for (let i = 0; i < nb; i++) {
    const t0 = 0.04 + 0.62 * (i / nb) + (rng() - 0.5) * 0.06;
    const y0 = baseY + t0 * (topY - baseY) * (look.excurrent ? 0.85 : 0.55);
    const at = leaderAt(Math.min(y0, trunk[trunk.length - 1][1]));
    const ang = i * 2.399 + rng() * 0.6;
    const dir = V3(Math.cos(ang), 0, Math.sin(ang));
    const tTip = Math.min(0.96, t0 + look.up * (0.2 + rng() * 0.2));
    const reach = prof(tTip) * Rr * (0.78 + rng() * 0.22);
    const tipY = baseY + tTip * (topY - baseY) + (genus === 'willow' || genus === 'chestnut' ? -look.droop * reach * 0.9 * (1 - t0) : 0);
    const a = V3(at[0], at[1], at[2]);
    const b = V3(at[0] + dir.x * reach, tipY, at[2] + dir.z * reach);
    // control point: leaves horizontally, bends up (or droops) towards the tip
    const c = V3(a.x + dir.x * reach * 0.55, a.y + (b.y - a.y) * 0.25 + look.droop * reach * 0.2, a.z + dir.z * reach * 0.55);
    const r0 = Math.max(0.05, trunkR * (0.34 - 0.2 * t0) * (look.excurrent ? 0.8 : 1.1));
    const path = [];
    const nSeg = 5;
    for (let k = 0; k <= nSeg; k++) {
      const s = k / nSeg;
      const x = (1 - s) * (1 - s) * a.x + 2 * (1 - s) * s * c.x + s * s * b.x;
      const y = (1 - s) * (1 - s) * a.y + 2 * (1 - s) * s * c.y + s * s * b.y;
      const z = (1 - s) * (1 - s) * a.z + 2 * (1 - s) * s * c.z + s * s * b.z;
      path.push([x, y, z, Math.max(0.018, r0 * (1 - 0.88 * s))]);
    }
    limbs.push({ path, kind: 'limb', dir: [dir.x, 0, dir.z] });
    tips.push({ p: path[nSeg], dir: [dir.x, 0.3, dir.z], big: true });
    // twigs along the outer two thirds: they carry the leaf sprays
    for (let k = 2; k <= nSeg; k++) {
      const n = k === nSeg ? 3 : 2;
      for (let m = 0; m < n; m++) {
        const base = path[k];
        const side = rng() * Math.PI * 2;
        const tw = V3(Math.cos(side) * 0.8 + dir.x * 0.5, 0.35 + rng() * 0.5, Math.sin(side) * 0.8 + dir.z * 0.5).normalize();
        const len = (0.55 + rng() * 0.85) * (1.2 - 0.15 * k * 0.5);
        const mid = [base[0] + tw.x * len * 0.5, base[1] + tw.y * len * 0.5 - look.droop * 0.12, base[2] + tw.z * len * 0.5];
        const end = [base[0] + tw.x * len, base[1] + tw.y * len - look.droop * 0.4 * len, base[2] + tw.z * len];
        twigs.push({ path: [[base[0], base[1], base[2], 0.03], [...mid, 0.022], [...end, 0.012]] });
        tips.push({ p: end, dir: [tw.x, tw.y * 0.6, tw.z], big: false });
      }
    }
  }
  return { limbs, twigs, tips, style, look, Rr, baseY, topY, prof, H };
}

/** Near-LOD tree for a genus (reference size, origin on the ground, +y up). */
export function buildNearTree(genus, day = OCTOBER_DAY, { variation = false } = {}) {
  const sk = treeSkeleton(genus);
  const { look, style, Rr, baseY, topY, prof } = sk;
  const season = treeSeason(genus, day, look.leaf);
  const rng = mulberry32(Math.floor(hashString(`near:${genus}`) * 1e9));
  const b = new Builder();
  const bark = rgbLin(look.bark);
  const sway = (p) => 0.012 * Math.pow(Math.max(0, p[1]) / sk.H, 2.2) * (1 + Math.hypot(p[0], p[2]) * 0.5);
  for (const l of sk.limbs) b.wood(l.path, bark, sway, l.kind === 'trunk' ? 8 : 5);
  const twigColour = bark.map((x, i) => x * 0.55 + rgbLin(look.leaf)[i] * 0.45 * 0.6); // twigs read as leafy shade, not as black wires
  for (const t of sk.twigs) b.wood(t.path, twigColour, sway, 3);
  const centre = [0, baseY + (topY - baseY) / 2, 0];
  const cardColour = (frac, h) => {
    const shade = 0.62 + 0.38 * (0.6 * frac + 0.4 * h) * (0.88 + rng() * 0.24);
    rng(); // retain the original placement sequence
    return [shade, shade, shade];
  };
  const target = Math.round(look.cards * 1.3 * (style.density || 1));
  let made = 0;
  const place = (p, dir, frac) => {
    const outv = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const ol = Math.hypot(...outv) || 1;
    const outward = [outv[0] / ol, outv[1] / ol, outv[2] / ol];
    const h = Math.min(1, Math.max(0, (p[1] - baseY) / (topY - baseY)));
    const j = [(rng() - 0.5) * 0.9, (rng() - 0.3) * 0.7, (rng() - 0.5) * 0.9];
    const face = new THREE.Vector3(dir[0] + j[0], dir[1] + j[1] + 0.25, dir[2] + j[2]).normalize();
    const s = look.size * LEAF_CARD_SCALE * (0.8 + rng() * 0.5);
    b.card([p[0] + j[0] * 0.15, p[1] + j[1] * 0.12, p[2] + j[2] * 0.15], [face.x, face.y, face.z], outward, s, LEAF_CELL[genus] ?? 3, cardColour(frac, h), 0.1 + 0.12 * h * h, rng);
    made++;
  };
  // sprays at twig tips (and several per limb tip), then fill the crown shell where the skeleton leaves gaps
  for (const t of sk.tips) {
    const k = t.big ? 3 : 2;
    for (let i = 0; i < k && made < target; i++) place([t.p[0] + (rng() - 0.5) * 0.7, t.p[1] + (rng() - 0.3) * 0.5, t.p[2] + (rng() - 0.5) * 0.7], t.dir, 0.9);
  }
  while (made < target) {
    const t = Math.pow(rng(), 0.85);
    const ang = rng() * Math.PI * 2;
    // a third of the fill sits deeper in the crown (darker, closes the see-through between the shell sprays)
    const frac = made % 3 === 0 ? 0.28 + 0.3 * rng() : 0.5 + 0.5 * Math.sqrt(rng());
    const r = prof(t) * Rr * frac;
    place([Math.cos(ang) * r, baseY + t * (topY - baseY), Math.sin(ang) * r], [Math.cos(ang), 0.3, Math.sin(ang)], frac);
  }
  return b.geometry({ radius: Rr, height: REF_H, density: variation ? treeGeometryDensity(genus, day) : season.density });
}

/** Mid-LOD crown: big leaf clusters on the crown shell (+ trunk and a few limb stubs). */
export function buildMidTree(genus, day = OCTOBER_DAY, { variation = false } = {}) {
  const sk = treeSkeleton(genus);
  const { look, style, Rr, baseY, topY, prof } = sk;
  const season = treeSeason(genus, day, look.leaf);
  const rng = mulberry32(Math.floor(hashString(`mid:${genus}`) * 1e9));
  const b = new Builder();
  const bark = rgbLin(look.bark);
  const sway = (p) => 0.01 * Math.pow(Math.max(0, p[1]) / sk.H, 2.2);
  b.wood(sk.limbs[0].path, bark, sway, 6);
  for (let i = 1; i < Math.min(5, sk.limbs.length); i++) b.wood(sk.limbs[i].path.slice(0, 4), bark, sway, 4);
  const centre = [0, baseY + (topY - baseY) / 2, 0];
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = Math.pow((i + rng()) / n, 0.9);
    const ang = i * 2.399 + rng() * 0.5;
    const frac = 0.55 + 0.45 * Math.sqrt(rng());
    const r = prof(t) * Rr * frac;
    const p = [Math.cos(ang) * r, baseY + t * (topY - baseY), Math.sin(ang) * r];
    const outv = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const ol = Math.hypot(...outv) || 1;
    const outward = [outv[0] / ol, outv[1] / ol, outv[2] / ol];
    const shade = 0.66 + 0.5 * (0.55 * frac + 0.45 * t) * (0.9 + rng() * 0.2);
    const c = [shade, shade, shade];
    b.card(p, outward, outward, look.size * LEAF_CARD_SCALE * 2.7 * (0.85 + rng() * 0.4), LEAF_CELL[genus] ?? 3, c, 0.12 + 0.12 * t * t, rng);
  }
  return b.geometry({ radius: Rr, height: REF_H, density: variation ? treeGeometryDensity(genus, day) : season.density });
}

// ----------------------------------------------------------------------------------------------- far billboards

export const BILL = Object.freeze({ cols: 5, rows: 15, w: 128, h: 192 });

/** Five phenology variants per genus, sharing one texture and one instanced draw per genus. */
export function createBillboardAtlas(genera, day = OCTOBER_DAY) {
  const { cols, rows, w, h } = BILL;
  const canvas = document.createElement('canvas');
  canvas.width = cols * w;
  canvas.height = rows * h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cellOf = new Map();
  genera.slice(0, rows).forEach((genus, row) => {
    cellOf.set(genus, row * cols);
    for (let variant = 0; variant < cols; variant++) {
      const idx = row * cols + variant;
      const individualDay = day - PHENOLOGY_SPREAD + variant * 6;
      const style = styleOf(genus);
      const look = lookOf(genus);
      const prof = crownProfile(style.profile);
      const rng = mulberry32(Math.floor(hashString(`bill:${genus}`) * 1e9));
      const ox = (idx % cols) * w;
      const oy = Math.floor(idx / cols) * h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, w, h);
      ctx.clip();
      const bark = look.bark.map((x) => Math.floor(x * 255 * 0.9));
      ctx.fillStyle = `rgb(${bark[0]},${bark[1]},${bark[2]})`;
      const baseFrac = style.base;
      const trunkTop = h * (1 - baseFrac * 0.98);
      ctx.fillRect(ox + w / 2 - 3, oy + trunkTop - 6, 6, h - trunkTop + 6);
      const crownTop = h * 0.02;
      const crownBot = h * (1 - baseFrac);
      const halfW = w * 0.47;
      // Keep the same genus skeleton visible when the distant crown loses its leaves.
      const sk = treeSkeleton(genus);
      ctx.strokeStyle = ctx.fillStyle;
      for (const limb of [...sk.limbs, ...sk.twigs]) {
        ctx.lineWidth = Math.max(0.6, limb.path[0][3] * w / sk.Rr);
        ctx.beginPath();
        limb.path.forEach(([x, y], i) => {
          const px = ox + w / 2 + x / sk.Rr * halfW;
          const py = oy + h * (1 - y / REF_H);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      const season = treeSeason(genus, individualDay, look.leaf);
      const N = 1100;
      for (let i = 0; i < N; i++) {
        const t = rng(); // 0 = crown bottom, 1 = top
        const rad = prof(t) * halfW * Math.sqrt(rng());
        const ang = rng() * Math.PI * 2;
        const x = w / 2 + Math.cos(ang) * rad;
        const y = crownBot - t * (crownBot - crownTop) + Math.sin(ang) * rad * 0.18;
        const lit = 0.62 + 0.5 * (0.5 * t + 0.5 * (Math.cos(ang) * 0.5 + 0.5)) * (0.85 + rng() * 0.3);
        const leaf = treeLeafColour(genus, individualDay + (hash2(i, row, 87) - 0.5) * 12, look.leaf);
        const c = [leaf[0] * lit, leaf[1] * lit, leaf[2] * lit].map((v) => Math.floor(Math.min(1, v) * 255));
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        const s = (1.8 + rng() * 2.5) * Math.sqrt(season.density);
        const rotation = rng() * 3;
        if (hash2(i, row, 719) >= season.density) continue;
        ctx.beginPath();
        ctx.ellipse(ox + x, oy + y, s, s * 0.8, rotation, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) { d[i] = d[i + 1] = d[i + 2] = 90; d[i + 3] = 0; } else d[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), canvas.width, canvas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, cellOf };
}

/** Cross billboard (two vertical quads, base on the ground, unit width and height) sampling one cell of the billboard atlas. */
export function buildBillboard(cell) {
  const { cols, rows } = BILL;
  const u0 = (cell % cols + 1 / BILL.w) / cols;
  const v0 = (Math.floor(cell / cols) + 1 / BILL.h) / rows;
  const du = (1 - 2 / BILL.w) / cols;
  const dv = (1 - 2 / BILL.h) / rows;
  const b = new Builder();
  const white = [1, 1, 1];
  for (const rot of [0, Math.PI / 2]) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const quad = [[-0.5, 0, 0, 1], [0.5, 0, 1, 1], [0.5, 1, 1, 0], [-0.5, 1, 0, 0]].map(([x, y, cu, cv]) => b.vert([x * c, y, -x * s], [-s, 0, -c], u0 + cu * du, v0 + cv * dv, white, 0.03 * y * y, 0.02));
    b.index.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
  }
  return b.geometry();
}

/** A ground-aligned palmate leaf spray; the mapped litter offsets stay in world space. */
export function buildTreeLitterGeometry() {
  const b = new Builder();
  for (const [x, z, u, v] of [[-0.5, -0.5, 0, 0], [-0.5, 0.5, 0, 1], [0.5, 0.5, 1, 1], [0.5, -0.5, 1, 0]]) {
    b.vert([x, 0, z], [0, 1, 0], 0.253 + u * 0.244, 0.003 + v * 0.494, [1, 1, 1], 0, 0);
  }
  b.index.push(0, 1, 2, 0, 2, 3);
  return b.geometry();
}

export function createTreeLitterMaterial(atlas) {
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 1, metalness: 0, alphaTest: 0.45, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const tex = texture(atlas, uv());
  material.colorNode = vec4(vec3(...rgbLin([0.40, 0.25, 0.10])).mul(tex.r), tex.a);
  return material;
}

// ----------------------------------------------------------------------------------------------- materials

export const treeUniforms = { wind: uniform(0.7) };

/** Alpha-tested leaves with per-instance phenology and per-blade hue variation. */
export function createTreeMaterial(map, { billboard = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: false, alphaTest: billboard ? 0.5 : 0.45, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  m.name = billboard ? 'cph-tree-billboard' : 'cph-tree';
  const swayAttr = attribute('sway', 'vec2');
  const gust = sin(time.mul(0.23)).mul(0.25).add(0.75);
  m.positionNode = Fn(() => {
    const p = positionLocal; // instanced already: world space (the furniture group sits at the origin)
    const phase = p.x.mul(0.13).add(p.z.mul(0.09));
    const t = time.mul(1.25).add(phase);
    const flutterT = time.mul(5.3).add(p.x.mul(1.9)).add(p.z.mul(1.3)).add(p.y.mul(2.3));
    const big = vec3(sin(t), 0.0, sin(t.mul(0.83).add(1.7))).mul(swayAttr.x).mul(gust).mul(treeUniforms.wind);
    const small = vec3(sin(flutterT), sin(flutterT.mul(1.31)).mul(0.5), sin(flutterT.mul(0.77).add(2.0))).mul(swayAttr.y).mul(treeUniforms.wind);
    return p.add(big).add(small);
  })();
  const early = attribute('leafEarly', 'vec4');
  const late = attribute('leafLate', 'vec4');
  const leaf = attribute('leafData', 'vec4');
  const variant = late.w.add(PHENOLOGY_SPREAD).div(6).round().clamp(0, BILL.cols - 1);
  const tex = texture(map, billboard ? uv().add(vec2(variant.div(BILL.cols), 0)) : uv());
  const isLeaf = billboard ? float(0) : leaf.w;
  const wp = positionWorld;
  // bark: furrows and mottling from world position (only where the atlas is the solid corner)
  const furrow = noise2D(vec2(wp.x.add(wp.z).mul(9.0), wp.y.mul(1.4)));
  const bark = float(0.78).add(furrow.mul(0.45));
  // The atlas is data, not RGB: its green channel varies each individual blade's
  // progress along the palette; its red channel supplies veins and curled rims.
  const leafAlbedo = mix(early.rgb, late.rgb, mix(leaf.y, tex.g, 0.65)).mul(tex.r).mul(leaf.z);
  const albedo = billboard ? tex.rgb : mix(attribute('color', 'vec3').mul(bark), leafAlbedo, isLeaf);
  const retained = billboard ? float(1) : mix(float(1), float(leaf.x.lessThan(early.w)), isLeaf);
  m.colorNode = vec4(albedo, tex.a.mul(retained));
  const nightK = smoothstep(0.4, 1.0, cityUniforms.uInteriorGlow);
  const day = float(1).sub(nightK);
  const toSun = normalize(cityUniforms.uSkySunDir);
  const V = normalize(cameraPosition.sub(positionWorld));
  m.emissiveNode = Fn(() => {
    const back = pow(max(dot(V, toSun.negate()), 0.0), 2.0);
    // Modest transmission preserves brown/olive shadows instead of washing them
    // into a peach glow. Distant painted trees have no blanket self-emission.
    return albedo.mul(isLeaf).mul(day).mul(float(0.025).add(back.mul(0.15)));
  })();
  return m;
}
