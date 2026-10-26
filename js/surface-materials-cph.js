// js/surface-materials-cph.js
// Procedural TSL ground materials for the Copenhagen twin (no textures, nothing downloaded):
//   kbh_fortov  Københavnerfortov: grey concrete slabs (50x50 or 62.5x62.5 cm, picked per pavement) in rows parallel to
//               the kerb, a line of small granite setts between every two slab rows, and a three-sett belt along the kerb
//   raadhus     Rådhusbelægning: 40x40 slabs in 3x3 groups framed by a line of setts
//   cobbles     brosten (staggered granite cobbles, ~14 cm)      setts   chaussésten (~10 cm)
//   asphalt     dense dark asphalt: aggregate grain, polished wheel tracks, patches; cycle tracks darker and cleaner
//   kerb        granite kerb stones with a joint every metre      paint/blue   worn white and Copenhagen-blue paint
// Pavement/ground meshes carry a `kuv` attribute (u along the street, v out from the kerb; see walk-space-cph.js) and a
// per-polygon `seed`. Road meshes carry kuv = (arc length, lateral offset) so lane wheel tracks line up.

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionWorld, normalWorldGeometry, fwidth, floor, fract, mod, min, max,
  mix, step, smoothstep, sin, dot, abs, length, pow, exp, clamp, context, metalness
} from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { poolLightAt } from './pool-light-cph.js';

export const ssrReflectionWeight = Fn((builder) => builder.context.wetSurfaceReflection ?? metalness);

export const srgb = (r, g, b) => {
  const c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return vec3(c.r, c.g, c.b);
};

const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const hash1D = Fn(([n]) => fract(sin(float(n).mul(127.1).add(311.7)).mul(43758.5453)));
export const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// colour of one granite sett/cobble from two hashes: blue-grey, grey, pink or dark, with per-stone brightness
const stoneColour = Fn(([h, h2]) => {
  let c = srgb(86, 91, 100);
  c = mix(c, srgb(112, 112, 114), step(0.3, h));
  c = mix(c, srgb(132, 110, 108), step(0.62, h));
  c = mix(c, srgb(64, 66, 72), step(0.84, h));
  return c.mul(h2.mul(0.34).add(0.83));
});

// slab colour (light warm grey, a few cooler or darker ones), 0..1 hashes per slab
const slabColour = Fn(([h, h2]) => {
  let c = mix(srgb(140, 137, 130), srgb(176, 172, 164), h);
  c = mix(c, srgb(124, 128, 132), step(0.78, h2).mul(0.8));
  c = mix(c, srgb(164, 152, 138), step(0.9, h).mul(0.6));
  return c;
});

// dirt, wear and speckle shared by the pavement materials; returns a brightness multiplier
const grime = Fn(([wp, fpWorld]) => {
  const large = noise2D(wp.mul(0.45)).mul(0.5).add(noise2D(wp.mul(2.7)).mul(0.5));
  const fine = float(1.0).sub(smoothstep(0.015, 0.09, fpWorld));
  const speck = noise2D(wp.mul(48.0)).sub(0.5).mul(0.1).mul(fine);
  return float(0.86).add(large.mul(0.22)).add(speck);
});

const roadWetness = () => clamp(cityUniforms.uRoadWetness, 0.0, 1.0);
const puddleField = (wp) => noise2D(wp.mul(0.12)).mul(0.65).add(noise2D(wp.mul(0.42)).mul(0.35));
const puddleMask = (wp) => {
  const wet = roadWetness();
  const onset = smoothstep(0.0, 0.2, wet);
  return smoothstep(float(0.84).sub(wet.mul(0.18)), float(0.90).sub(wet.mul(0.18)), puddleField(wp)).mul(onset);
};

export function wetFinish(colour, roughness, wp) {
  const wet = roadWetness();
  const puddle = puddleMask(wp);
  const dampRoughness = mix(roughness, float(0.15), wet);
  return vec4(colour.mul(float(1.0).sub(wet.mul(0.4))), mix(dampRoughness, float(0.02), puddle));
}

export const wetReflectionWeightAt = (wp) => roadWetness().mul(0.06).add(puddleMask(wp).mul(0.28));

// stone cell inside a sett/cobble field. `edgeM` = distance to the stone edge in metres
function stoneShade(edgeM, fp, gap) {
  const aa = max(fp, 0.002);
  return smoothstep(gap.sub(aa), gap.add(aa), edgeM);
}

// ---- Københavnerfortov -------------------------------------------------------------------------------------------
const fortov = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004).toVar();
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const s = mix(float(0.5), float(0.625), step(0.5, seed)).toVar(); // slab size for this pavement
  const belt = float(0.3);
  const vv = v.sub(belt);
  const period = s.mul(2.0).add(0.1);
  const m = mod(vv, period).toVar();
  const inBelt = float(1.0).sub(step(belt, v));
  const lineMask = step(s.mul(2.0), m).mul(float(1.0).sub(inBelt));
  const settMask = clamp(inBelt.add(lineMask), 0.0, 1.0);

  // slab: rows of 2 between sett lines
  const rowHi = step(s, m);
  const row = floor(vv.div(period)).mul(2.0).add(rowHi);
  const lv = m.sub(rowHi.mul(s));
  const col = floor(u.div(s));
  const lu = u.sub(col.mul(s));
  const cell = vec2(col, row);
  const h = hash2D(cell.add(vec2(seed.mul(37.0), 11.0)));
  const h2 = hash2D(cell.mul(1.7).add(vec2(5.3, seed.mul(9.0))));
  const edge = min(min(lu, s.sub(lu)), min(lv, s.sub(lv)));
  const jw = float(0.0045);
  const jointCov = float(1.0).sub(smoothstep(0.0, max(jw.mul(2.0), fp), edge)).mul(min(float(1.0), jw.mul(2.0).div(max(jw.mul(2.0), fp))));
  const bevel = float(1.0).sub(smoothstep(0.0, 0.02, edge).mul(0.0)).sub(float(1.0).sub(smoothstep(0.004, 0.022, edge)).mul(0.07));
  const slabBase = slabColour(h, h2).mul(float(0.95).add(noise2D(vec2(lu, lv).mul(5.0).add(cell.mul(3.1))).mul(0.1)));
  const slabAvg = srgb(150, 146, 139);
  let slab = mix(slabBase.mul(bevel), srgb(52, 50, 47), jointCov.mul(0.9));
  slab = mix(slab, slabAvg.mul(0.97), smoothstep(0.12, 0.5, fp));

  // setts: belt along the kerb (3 staggered rows) or the line between slab rows
  const beltRow = floor(v.div(0.1));
  const rowId = mix(float(10.0).add(floor(vv.div(period))), beltRow, inBelt);
  const rv = mix(m.sub(s.mul(2.0)).div(0.1), v.div(0.1), inBelt);
  const sx = u.div(0.1).add(mix(float(0.0), beltRow.mul(0.5), inBelt));
  const sc = vec2(floor(sx), rowId);
  const sh = hash2D(sc.add(vec2(3.7, seed.mul(5.0))));
  const sh2 = hash2D(sc.mul(2.3).add(vec2(8.1, 1.3)));
  const lx = fract(sx);
  const ly = fract(rv);
  const sEdge = min(min(lx, float(1.0).sub(lx)), min(ly, float(1.0).sub(ly))).mul(0.1);
  const stone = stoneShade(sEdge, fp, float(0.005));
  const dome = float(0.9).add(smoothstep(0.0, 0.02, sEdge).mul(0.12));
  let sett = mix(srgb(44, 40, 34), stoneColour(sh, sh2).mul(dome), stone);
  sett = mix(sett, srgb(98, 96, 98), smoothstep(0.03, 0.1, fp));

  const colour = mix(slab, sett, settMask).mul(grime(wp, fpw));
  const rough = mix(float(0.88), float(0.74), settMask);
  return wetFinish(colour, rough, wp);
});

// ---- Rådhusbelægning ---------------------------------------------------------------------------------------------
const raadhus = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004).toVar();
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const G = float(1.3);
  const gu = mod(u, G);
  const gv = mod(v, G);
  const gid = vec2(floor(u.div(G)), floor(v.div(G)));
  const isFrame = max(step(1.2, gu), step(1.2, gv));
  const iu = min(floor(gu.div(0.4)), float(2.0));
  const iv = min(floor(gv.div(0.4)), float(2.0));
  const lu = gu.sub(iu.mul(0.4));
  const lv = gv.sub(iv.mul(0.4));
  const cell = gid.mul(3.0).add(vec2(iu, iv));
  const h = hash2D(cell.add(vec2(seed.mul(13.0), 3.0)));
  const h2 = hash2D(cell.mul(1.3).add(vec2(2.2, seed.mul(7.0))));
  const edge = min(min(lu, float(0.4).sub(lu)), min(lv, float(0.4).sub(lv)));
  const jw = float(0.005);
  const jointCov = float(1.0).sub(smoothstep(0.0, max(jw.mul(2.0), fp), edge)).mul(min(float(1.0), jw.mul(2.0).div(max(jw.mul(2.0), fp))));
  let slab = mix(srgb(160, 157, 150), srgb(178, 175, 167), h);
  slab = mix(slab, srgb(140, 142, 144), step(0.82, h2).mul(0.7)).mul(float(0.95).add(noise2D(vec2(lu, lv).mul(6.0).add(cell)).mul(0.1)));
  slab = mix(slab, srgb(50, 48, 45), jointCov.mul(0.9));
  slab = mix(slab, srgb(160, 157, 150), smoothstep(0.12, 0.5, fp));
  const sc = floor(vec2(u, v).div(0.1));
  const lx = fract(u.div(0.1));
  const ly = fract(v.div(0.1));
  const sEdge = min(min(lx, float(1.0).sub(lx)), min(ly, float(1.0).sub(ly))).mul(0.1);
  let sett = mix(srgb(44, 40, 34), stoneColour(hash2D(sc.add(vec2(1.9, 7.7))), hash2D(sc.mul(2.1))), stoneShade(sEdge, fp, float(0.005)));
  sett = mix(sett, srgb(98, 96, 98), smoothstep(0.03, 0.1, fp));
  return wetFinish(mix(slab, sett, isFrame).mul(grime(wp, fpw)), mix(float(0.88), float(0.74), isFrame), wp);
});

// ---- cobbles and setts -------------------------------------------------------------------------------------------
function stoneField(size, gapFrac, tint) {
  return Fn(([u, v, seed, wp]) => {
    const fp = max(fwidth(u), fwidth(v)).max(0.0004);
    const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
    const row = floor(v.div(size));
    const x = u.div(size).add(hash1D(row.add(seed.mul(41.0))));
    const col = floor(x);
    const c = vec2(fract(x), fract(v.div(size))).mul(2.0).sub(1.0);
    const id = vec2(col, row);
    const h = hash2D(id.add(vec2(seed.mul(9.0), 4.0)));
    const h2 = hash2D(id.mul(1.9).add(vec2(6.0, 2.0)));
    // rounded stone: superellipse-ish distance, a little lopsided per stone
    const d = max(abs(c.x), abs(c.y)).mul(0.6).add(length(c).mul(0.4)).add(h2.sub(0.5).mul(0.06));
    const edgeM = float(1.0).sub(d).mul(size).mul(0.5);
    const gap = float(size).mul(gapFrac);
    const stone = stoneShade(edgeM, fp, gap);
    const shade = float(1.08).sub(d.mul(d).mul(0.3));
    let col3 = stoneColour(h, h2).mul(tint).mul(shade);
    col3 = mix(srgb(38, 34, 28), col3, stone);
    col3 = mix(col3, srgb(96, 93, 92).mul(tint), smoothstep(float(size).mul(0.35), float(size).mul(0.9), fp));
    return wetFinish(col3.mul(grime(wp, fpw)), mix(float(0.95), float(0.7), stone), wp);
  });
}

// ---- gravel and plain concrete -----------------------------------------------------------------------------------
/** Dry fine gravel by world position, shared by register polygons and the lake-path ground band. */
export const gravelRGB = Fn(([wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.01, 0.08, fpw));
  const g = noise2D(wp.mul(70.0)).mul(0.5).add(noise2D(wp.mul(16.0)).mul(0.5));
  const big = noise2D(wp.mul(0.7));
  return mix(srgb(142, 130, 110), srgb(168, 156, 134), big).mul(float(0.88).add(g.mul(0.24).mul(fine)));
});

const gravel = Fn(([u, v, seed, wp]) => wetFinish(gravelRGB(wp), float(0.98), wp));

const concrete = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004);
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const lu = mod(u, 1.0);
  const lv = mod(v, 1.0);
  const edge = min(min(lu, float(1.0).sub(lu)), min(lv, float(1.0).sub(lv)));
  const jointCov = float(1.0).sub(smoothstep(0.0, max(0.01, fp), edge)).mul(min(float(1.0), float(0.01).div(max(0.01, fp))));
  const c = mix(srgb(150, 148, 144), srgb(52, 50, 47), jointCov.mul(0.8));
  return vec4(c.mul(grime(wp, fpw)), 0.9);
});

// ---- asphalt -----------------------------------------------------------------------------------------------------
function asphaltFn({ base, tracks, patchRate, wear }) {
  return Fn(([u, v, seed, wp]) => {
    const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
    const fine = float(1.0).sub(smoothstep(0.012, 0.09, fpw));
    const mid = float(1.0).sub(smoothstep(0.1, 0.9, fpw));
    const grain = noise2D(wp.mul(55.0)).mul(0.5).mul(fine).add(noise2D(wp.mul(13.0)).mul(0.3).mul(mid)).add(noise2D(wp.mul(2.9)).mul(0.25));
    const speck = step(0.91, hash2D(floor(wp.mul(160.0)))).mul(fine).mul(0.32);
    // wheel tracks: lane centres sit on v = 1.5 + 3k, tracks 0.85 m either side
    const d = abs(fract(v.div(3.0)).sub(0.5)).mul(3.0);
    const tr = exp(pow(d.sub(0.85).div(0.3), 2.0).negate()).mul(wear).mul(tracks);
    const blotch = noise2D(vec2(u.mul(0.18), v.mul(0.9)));
    // patches: a few rectangular repairs with a hairline seam
    const pc = vec2(floor(u.div(9.0)), floor(v.div(6.0)));
    const pu = fract(u.div(9.0));
    const pv = fract(v.div(6.0));
    const patchOn = step(float(1.0).sub(patchRate), hash2D(pc.add(vec2(3.3, 1.1))));
    const inside = step(0.12, pu).mul(step(pu, 0.88)).mul(step(0.18, pv)).mul(step(pv, 0.82));
    const tone = mix(float(0.8), float(1.17), step(0.5, hash2D(pc.add(vec2(9.1, 4.7)))));
    let light = float(0.8).add(grain.mul(0.42)).add(speck).add(tr.mul(0.12)).add(blotch.sub(0.5).mul(0.08));
    light = light.mul(mix(float(1.0), tone, patchOn.mul(inside)));
    return wetFinish(base.mul(light), mix(float(0.93), float(0.78), tr.mul(0.6)), wp);
  });
}

const granite = Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.01, 0.08, fpw));
  const top = step(0.6, normalWorldGeometry.y);
  const spk = hash2D(floor(wp.mul(220.0)));
  const speckle = step(0.85, spk).mul(0.18).sub(step(spk, 0.1).mul(0.14)).mul(fine);
  const grain = noise2D(wp.mul(30.0)).mul(0.14).add(noise2D(wp.mul(5.0)).mul(0.12));
  const lu = fract(u);
  const joint = float(1.0).sub(smoothstep(0.0, 0.012, min(lu, float(1.0).sub(lu))));
  const c = mix(srgb(122, 120, 119), srgb(166, 164, 161), top).mul(float(0.9).add(grain).add(speckle));
  return vec4(c.mul(float(1.0).sub(joint.mul(0.45))), 0.78);
});

// ---- grass -------------------------------------------------------------------------------------------------------
// One colour field for the lawn: the ground polygons and the tufts of js/grass-cph.js both read it at the world position,
// so the blades grow out of ground of exactly their own colour. Mown parkland: large soft patches (sun, shade, wear), a
// slow dry-to-lush drift, broad mowing bands, a little clover.
export const grassColour = Fn(([wp]) => {
  const patch = noise2D(wp.mul(0.11)).mul(0.55).add(noise2D(wp.mul(0.43).add(vec2(9.1, 3.3))).mul(0.45));
  const lush = srgb(64, 98, 38);
  const mid = srgb(88, 120, 48);
  const dry = srgb(128, 134, 70);
  let c = mix(lush, mid, smoothstep(0.25, 0.6, patch));
  c = mix(c, dry, smoothstep(0.62, 0.9, noise2D(wp.mul(0.05).add(vec2(41.0, 7.0)))).mul(0.65));
  const band = sin(wp.x.mul(1.9).add(wp.y.mul(0.7)).add(noise2D(wp.mul(0.2)).mul(5.0))).mul(0.5).add(0.5);
  c = c.mul(float(0.94).add(band.mul(0.1)));
  const clover = smoothstep(0.7, 0.8, noise2D(wp.mul(0.9).add(vec2(2.0, 5.0))));
  return mix(c, srgb(78, 122, 62), clover.mul(0.35));
});

const grassGround = Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.02, 0.25, fpw)); // blade-scale grain fades out before it can shimmer
  const grain = noise2D(wp.mul(70.0)).sub(0.5).mul(0.2).add(noise2D(wp.mul(17.0)).sub(0.5).mul(0.14)).mul(fine);
  return vec4(grassColour(wp).mul(float(0.82).add(grain)), 0.96);
});

const paintFn = (colour, rough) => Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.02, 0.2, fpw));
  const worn = smoothstep(0.62, 0.8, noise2D(wp.mul(7.0)).mul(0.6).add(noise2D(wp.mul(35.0)).mul(0.4).mul(fine)));
  const c = mix(colour, srgb(66, 67, 70), worn.mul(0.5));
  return vec4(c.mul(float(0.94).add(noise2D(wp.mul(60.0)).mul(0.1).mul(fine))), rough);
});

export function createRoadSurfaceMaterials() {
  const kuv = attribute('kuv', 'vec2');
  const seed = attribute('seed', 'float');
  const wp = positionWorld.xz;
  const make = (fn, { withSeed = false, polygonOffset = 0, side = THREE.DoubleSide, wet = false } = {}) => {
    const out = fn(kuv.x, kuv.y, withSeed ? seed : float(0.25), wp);
    const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, side });
    mat.colorNode = out.xyz;
    mat.emissiveNode = out.xyz.mul(poolLightAt(positionWorld)); // street-light pools (js/pool-light-cph.js)
    mat.roughnessNode = out.w;
    if (wet) {
      // Keep wet SSR eligibility in material context so reflection passes can use an unnamed color target.
      // The main scene MRT reads this scalar; the material remains dielectric for lighting and reflection optics.
      mat.contextNode = context({
        wetSurfaceReflection: wetReflectionWeightAt(wp)
      });
    }
    if (polygonOffset) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = polygonOffset;
      mat.polygonOffsetUnits = polygonOffset;
    }
    return mat;
  };
  const road = asphaltFn({ base: srgb(60, 62, 66), tracks: 1, patchRate: 0.1, wear: 1 });
  const cyc = asphaltFn({ base: srgb(47, 48, 52), tracks: 0, patchRate: 0.04, wear: 0 });
  const white = paintFn(srgb(232, 232, 226), 0.62);
  const bluePaint = paintFn(srgb(14, 86, 164), 0.74);
  const redPaint = paintFn(srgb(139, 64, 47), 0.78);
  const yellowPaint = paintFn(srgb(194, 164, 73), 0.76);
  const pavement = (fn, options = {}) => make(fn, { withSeed: true, polygonOffset: -1, ...options });
  return {
    asphalt: make(road, { wet: true }),
    cycle: make(cyc, { wet: true }),
    kerb: make(granite),
    paint: make(white, { polygonOffset: -2 }),
    blue: make(bluePaint, { polygonOffset: -3 }),
    red: make(redPaint, { polygonOffset: -2 }),
    yellow: make(yellowPaint, { polygonOffset: -2 }),
    ground: {
      kbh_fortov: pavement(fortov, { wet: true }),
      raadhus: pavement(raadhus, { wet: true }),
      cobbles: pavement(stoneField(0.14, 0.07, vec3(1.0, 0.97, 0.92)), { wet: true }),
      setts: pavement(stoneField(0.1, 0.05, vec3(1.0)), { wet: true }),
      gravel: pavement(gravel, { wet: true }),
      grass: make(grassGround, { withSeed: true, polygonOffset: -2 }),
      other: pavement(concrete),
      asphalt_road: make(asphaltFn({ base: srgb(66, 67, 70), tracks: 0, patchRate: 0.05, wear: 0 }), { withSeed: true, polygonOffset: -1, wet: true })
    }
  };
}
