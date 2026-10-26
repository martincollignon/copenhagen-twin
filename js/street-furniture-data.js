// js/street-furniture-data.js
// Street furniture of the Copenhagen twin, as pure data (no three.js, headless-testable): maps data/cph-furniture.json
// (tools/cph-geodata/furniture.py) to placed items with a ground height, derives the parked cars, bikes, bus-stop
// parts and wire spans, and indexes everything in quadtrees for the radius queries js/street-furniture-cph.js runs.
// Frame: x east, z south, y up. `yaw` is the direction an item faces: model +z -> (sin yaw, cos yaw), i.e. rotation.y.

import { Quadtree } from './quadtree.js';
import { fleetVehicle } from './vehicle-fleet.js';

export const FURNITURE_URL = './data/cph-furniture.json';

/** Fetches the compiled furniture. Null when absent or unreadable: the twin then boots without street furniture. */
export async function loadCphFurniture(url = FURNITURE_URL, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return null;
    const doc = await response.json();
    return doc?.version?.startsWith('cph-furniture/') ? doc : null;
  } catch (error) {
    console.info('[cph] no street furniture loaded:', error?.message || error);
    return null;
  }
}

// ----------------------------------------------------------------------------------------------- deterministic noise

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable [0, 1) hash of a position (or any pair of numbers) and a salt. */
export function hash2(x, z, salt = 0) {
  let h = Math.imul(Math.round(x * 100) | 0, 374761393) ^ Math.imul(Math.round(z * 100) | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// ----------------------------------------------------------------------------------------------- matrices

/** Writes a column-major 4x4 for translate(x, y, z) * rotateY(yaw) * scale(sx, sy, sz) at arr[o..o+15]. */
export function composeYaw(arr, o, x, y, z, yaw, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  arr[o] = c * sx; arr[o + 1] = 0; arr[o + 2] = -s * sx; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = s * sz; arr[o + 9] = 0; arr[o + 10] = c * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

/** translate * rotateY(yaw) * rotateX(pitch) * scale: a model whose +z axis runs along (sin yaw cos p, -sin p, cos yaw cos p). */
export function composeYawPitch(arr, o, x, y, z, yaw, pitch, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  arr[o] = c * sx; arr[o + 1] = 0; arr[o + 2] = -s * sx; arr[o + 3] = 0;
  arr[o + 4] = s * sp * sy; arr[o + 5] = cp * sy; arr[o + 6] = c * sp * sy; arr[o + 7] = 0;
  arr[o + 8] = s * cp * sz; arr[o + 9] = -sp * sz; arr[o + 10] = c * cp * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

// ----------------------------------------------------------------------------------------------- trees

// Reference tree is REF_H tall; instances scale to the real height (y) and crown radius (xz).
export const REF_H = 12;

/**
 * Per genus family: where the crown starts (fraction of height), its profile, the crown radius of the reference tree as
 * a fraction of its height, leaf and bark colours (sRGB 0-1), leaf-card density/size and drooping.
 * Profiles: ovoid, round, columnar, vase, cone, weeping.
 */
export const TREE_STYLES = {
  lime: { profile: 'ovoid', base: 0.28, width: 0.34, leaf: [0.22, 0.42, 0.13], bark: [0.30, 0.26, 0.22], cards: 210, card: 1.15, density: 1.0 },
  chestnut: { profile: 'round', base: 0.24, width: 0.4, leaf: [0.16, 0.36, 0.10], bark: [0.27, 0.21, 0.17], cards: 200, card: 1.45, density: 1.1 },
  elm: { profile: 'vase', base: 0.32, width: 0.36, leaf: [0.20, 0.40, 0.12], bark: [0.28, 0.23, 0.19], cards: 190, card: 1.1, density: 0.95 },
  maple: { profile: 'round', base: 0.3, width: 0.34, leaf: [0.26, 0.44, 0.14], bark: [0.33, 0.29, 0.25], cards: 190, card: 1.2, density: 1.0 },
  cherry: { profile: 'round', base: 0.3, width: 0.36, leaf: [0.34, 0.50, 0.18], bark: [0.30, 0.18, 0.15], cards: 150, card: 1.0, density: 0.9 },
  plane: { profile: 'round', base: 0.34, width: 0.38, leaf: [0.24, 0.40, 0.14], bark: [0.56, 0.52, 0.42], cards: 200, card: 1.5, density: 1.0 },
  oak: { profile: 'round', base: 0.3, width: 0.42, leaf: [0.18, 0.34, 0.10], bark: [0.25, 0.20, 0.16], cards: 220, card: 1.2, density: 1.05 },
  robinia: { profile: 'ovoid', base: 0.34, width: 0.3, leaf: [0.35, 0.50, 0.20], bark: [0.30, 0.25, 0.20], cards: 160, card: 0.95, density: 0.8 },
  poplar: { profile: 'columnar', base: 0.12, width: 0.14, leaf: [0.24, 0.42, 0.15], bark: [0.34, 0.31, 0.27], cards: 150, card: 1.0, density: 1.0 },
  willow: { profile: 'weeping', base: 0.2, width: 0.42, leaf: [0.40, 0.52, 0.22], bark: [0.28, 0.24, 0.20], cards: 180, card: 1.1, density: 0.9 },
  ash: { profile: 'ovoid', base: 0.32, width: 0.3, leaf: [0.25, 0.42, 0.16], bark: [0.36, 0.33, 0.29], cards: 160, card: 1.1, density: 0.85 },
  birch: { profile: 'ovoid', base: 0.28, width: 0.24, leaf: [0.36, 0.52, 0.20], bark: [0.80, 0.78, 0.72], cards: 140, card: 0.9, density: 0.8 },
  hawthorn: { profile: 'round', base: 0.26, width: 0.4, leaf: [0.24, 0.42, 0.16], bark: [0.30, 0.25, 0.22], cards: 130, card: 0.9, density: 0.9 },
  conifer: { profile: 'cone', base: 0.1, width: 0.2, leaf: [0.10, 0.25, 0.14], bark: [0.28, 0.22, 0.18], cards: 170, card: 1.0, density: 1.0 },
  generic: { profile: 'round', base: 0.3, width: 0.35, leaf: [0.23, 0.41, 0.14], bark: [0.30, 0.26, 0.22], cards: 180, card: 1.1, density: 1.0 }
};

export const treeStyle = (genus) => TREE_STYLES[genus] || TREE_STYLES.generic;

/** Height and crown radius are independent measurements, including low, broad crowns. */
export function treeDimensions(tree) {
  const height = Number.isFinite(tree.height) && tree.height > 0 ? Math.max(2, Math.min(40, tree.height)) : 8;
  const crownRadius = Number.isFinite(tree.crown_radius) && tree.crown_radius > 0
    ? Math.max(0.5, Math.min(30, tree.crown_radius)) : height * 0.35;
  return { height, crownRadius };
}

/** Crown geometry of one real tree in metres: where it starts, its centre and radii. */
export function crownOf(height, crownRadius, style) {
  const base = Math.min(height * 0.65, Math.max(0.5, height * style.base));
  const top = height * 0.98;
  const ry = Math.max(0.1, (top - base) / 2);
  return { base, cy: base + ry, ry, rx: crownRadius };
}

export function mapTrees(trees, groundHeight, { resolve = null } = {}) {
  const out = [];
  for (const t of trees || []) {
    // `resolve(tree) -> { genus, source }` gives the laser-detected crowns without a species a context default (tree-species-cph.js)
    const r = resolve ? resolve(t) : null;
    const genus = r ? r.genus : t.genus;
    const style = treeStyle(genus);
    const { height: h, crownRadius: rx } = treeDimensions(t);
    const y = groundHeight ? groundHeight.heightAt(t.x, t.z) : 0;
    const j = hash2(t.x, t.z, 7);
    const crown = crownOf(h, rx, style);
    out.push({
      cx: t.x, cz: t.z, x: t.x, y, z: t.z, genus: genus in TREE_STYLES ? genus : 'generic', genusSource: r ? r.source : 'recorded', species: t.species ?? null, height: h, crownR: rx, crown,
      // reference-tree scale: y by height, xz by crown width against the reference crown
      sy: h / REF_H, sxz: rx / (style.width * REF_H),
      baselineGenus: (resolve ? resolve({ ...t, ...(t.canopy_original || {}) }).genus : t.genus) || 'generic',
      canopyAdded: !!t.canopy_added, litterPoints: t.litter_points || [], litterOrigin: t.litter_origin || [t.x, t.z],
      yaw: j * Math.PI * 2, tint: 0.88 + hash2(t.x, t.z, 11) * 0.24, age: t.age ?? null
    });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- lamps

/** Blackbody-ish sRGB colour (0-1) of a lamp colour temperature (K): 2000 sodium amber ... 4000 neutral white. */
export function lightColor(cct) {
  const t = Math.max(1800, Math.min(6500, cct || 3000)) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708 * Math.log(t) - 161.1196;
  } else {
    r = 329.6987 * (t - 60) ** -0.1332;
    g = 288.1222 * (t - 60) ** -0.0755;
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177 * Math.log(t - 10) - 305.0448;
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}

export function lightClass(cct) {
  return cct <= 2300 ? 'sodium' : cct <= 3300 ? 'warm' : 'neutral';
}

export const WIRE_ANCHOR_Y = 8.9; // facade anchor height: ~8 m at the lamp after the sag (visual-refs 1a: centre 8 m, spans 25-35 m)
export const WIRE_SAG_RATIO = 0.03; // sag / span

/**
 * A wire span as a parabola from facade anchor A to B with the lamp hanging at its parameter `t` (0..1). Returns the
 * polyline (x, y, z triplets, y above ground = `base`), and the lamp's world position.
 */
export function wireSpan(span, lamp, base, segments = 10, endGround = null, anchorH = null) {
  const [ax, az, bx, bz] = span;
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const t = Math.max(0.08, Math.min(0.92, ((lamp.x - ax) * (bx - ax) + (lamp.z - az) * (bz - az)) / (len * len)));
  // each anchor hangs WIRE_ANCHOR_Y over the ground at ITS facade (the street rises and falls: js/terrain-cph.js)
  const hA = (endGround ? endGround[0] - base : 0) + (anchorH ? anchorH[0] : WIRE_ANCHOR_Y) + (hash2(ax, az, 3) - 0.5) * 0.6;
  const hB = (endGround ? endGround[1] - base : 0) + (anchorH ? anchorH[1] : WIRE_ANCHOR_Y) + (hash2(bx, bz, 3) - 0.5) * 0.6;
  const sag = Math.max(0.25, len * WIRE_SAG_RATIO);
  const yAt = (u) => hA + (hB - hA) * u - 4 * sag * u * (1 - u);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    pts.push(ax + (bx - ax) * u, base + yAt(u), az + (bz - az) * u);
  }
  const wy = yAt(t);
  return { pts, t, len, lampX: ax + (bx - ax) * t, lampZ: az + (bz - az) * t, lampY: base + wy - 0.55, wireY: base + wy };
}

export function mapLamps(lamps, groundHeight) {
  const out = [];
  for (const l of lamps || []) {
    const y = groundHeight ? groundHeight.heightAt(l.x, l.z) : 0;
    const cct = l.cct || 3000;
    const item = {
      cx: l.x, cz: l.z, x: l.x, y, z: l.z, mount: l.mount, pole: l.pole, poleH: l.pole_h || 0, arm: l.arm || null,
      yaw: l.yaw || 0, light: l.light, led: !!l.led, cct, watt: l.watt || 0, color: lightColor(cct), cls: lightClass(cct),
      poolR: l.mount === 'wire' ? 5.5 + Math.min(3, (l.watt || 70) / 60) : 4 + Math.min(5, (l.pole_h || 5) * 0.55),
      wire: null
    };
    if (l.mount === 'wire' && l.span) {
      const w = wireSpan(l.span, l, y, 10, groundHeight ? [groundHeight.heightAt(l.span[0], l.span[1]), groundHeight.heightAt(l.span[2], l.span[3])] : null, l.anchor_h || null);
      item.wire = w;
      item.x = w.lampX;
      item.z = w.lampZ;
      item.cx = w.lampX;
      item.cz = w.lampZ;
      item.lampY = w.lampY;
    } else if (l.mount === 'wire') {
      // no wire geometry: a luminaire on a short bracket arm at 6 m, so it is still lit and visible
      item.lampY = y + 6;
      item.bracket = true;
    } else {
      item.lampY = y + item.poleH;
    }
    out.push(item);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- parking and bikes

export const CAR_DENSITY = [0.70, 0.85];

/** Occupancy of a block: a stable value inside CAR_DENSITY from a 60 m cell. */
export function blockDensity(x, z, seed = 1) {
  const [lo, hi] = CAR_DENSITY;
  return lo + (hi - lo) * hash2(Math.floor(x / 60), Math.floor(z / 60), seed);
}

/** Parked cars filling the bays, deterministic for a seed. Row cars keep one direction per kerb line, with exceptions. */
export function parkedCars(bays, groundHeight, seed = 1) {
  const out = [];
  for (const b of bays || []) {
    if (hash2(b.x, b.z, seed * 31 + 1) >= blockDensity(b.x, b.z, seed)) continue;
    const j = (k) => hash2(b.x, b.z, seed * 31 + k);
    const lineFlip = hashString(b.src?.[0] || '') > 0.5;
    let yaw = b.yaw;
    if (b.kind === 'par') {
      const flip = j(2) < 0.1 ? !lineFlip : lineFlip;
      yaw += flip ? Math.PI : 0;
      yaw += (j(3) - 0.5) * 0.05;
    } else {
      yaw += (j(3) - 0.5) * 0.08;
    }
    // a little slack along the row (parallel bays only: the other bays' row direction is not the car's axis)
    const along = b.kind === 'par' ? (j(4) - 0.5) * 0.5 : 0;
    const x = b.x + Math.sin(b.yaw) * along;
    const z = b.z + Math.cos(b.yaw) * along;
    const y = groundHeight ? groundHeight.heightAt(x, z) : 0;
    const choice = fleetVehicle(j(5), j(6), j(8), true);
    const rgb = [16, 8, 0].map((shift) => ((choice.paint >>> shift) & 255) / 255);
    out.push({
      cx: x, cz: z, x, y, z, yaw, body: choice.body, paint: rgb,
      shade: 0.92 + j(7) * 0.16
    });
  }
  return out;
}

export const RACK_SLOT = 0.5; // m between two bikes in a rack
export const RACK_MAX_SLOTS = 48;

/** Rack hoops (one per two slots) and the bikes standing in them, as items along each rack row. */
export function rackItems(racks, groundHeight, seed = 1) {
  const hoops = [];
  const bikes = [];
  for (const r of racks || []) {
    const slots = Math.max(2, Math.min(RACK_MAX_SLOTS, r.capacity || 6));
    const dx = Math.sin(r.yaw);
    const dz = Math.cos(r.yaw);
    const n = slots;
    const fill = r.shopping ? 0.84 + 0.14 * hash2(r.x, r.z, seed + 91) : 0.4;
    const occupied = Math.round(n * fill);
    const chosenSlots = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => hash2(r.x + a * RACK_SLOT, r.z, seed + 93) - hash2(r.x + b * RACK_SLOT, r.z, seed + 93))
      .slice(0, occupied);
    const parked = new Set(chosenSlots);
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * RACK_SLOT;
      const x = r.x + dx * o;
      const z = r.z + dz * o;
      const y = groundHeight ? groundHeight.heightAt(x, z) : 0;
      if (i % 2 === 0) hoops.push({ cx: x, cz: z, x, y, z, yaw: r.yaw });
      if (parked.has(i)) {
        const style = hash2(x, z, seed + 111);
        // The prechecked rack envelope is a regular city bicycle; long cargo forms are
        // reserved for facade parking where their full, larger footprint is validated.
        const variant = style < 0.16 ? 'mens'
          : style < 0.36 ? 'city-crate'
            : style < 0.52 ? 'city-childseat'
              : 'city';
        bikes.push({
          cx: x, cz: z, x, y, z, yaw: r.yaw + Math.PI / 2 + (hash2(x, z, seed + 95) - 0.5) * 0.12,
          hue: Math.floor(hash2(x, z, seed + 97) * 10), size: 0.94 + hash2(x, z, seed + 99) * 0.12,
          variant, lean: hash2(x, z, seed + 101) < 0.28 ? (hash2(x, z, seed + 103) - 0.5) * 0.2 : 0
        });
      }
    }
  }
  return { hoops, bikes };
}

// ----------------------------------------------------------------------------------------------- bus stops

/** Per Movia stop: flag pole at the stop, shelter, bench, bin and countdown display as separate placed parts. */
export function busStopParts(stops, groundHeight) {
  const parts = { flags: [], shelters: [], benches: [], bins: [], countdowns: [] };
  const gy = (x, z) => (groundHeight ? groundHeight.heightAt(x, z) : 0);
  for (const s of stops || []) {
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    const [tx, tz] = s.tangent || [fz, -fx];
    const put = (list, x, z, yaw, extra = {}) => list.push({ cx: x, cz: z, x, y: gy(x, z), z, yaw, ...extra });
    put(parts.flags, s.x, s.z, s.yaw, { name: s.name });
    if (s.shelter) {
      // behind the kerb line, along the stop, back to the building, glass facing the carriageway (or where the placer found room)
      const [sx, sz] = s.shelterAt || [s.x - fx * 0.9 + tx * 2.2, s.z - fz * 0.9 + tz * 2.2];
      put(parts.shelters, sx, sz, s.yaw, { bench: s.bench });
    } else if (s.bench) {
      const [bx, bz] = s.benchAt || [s.x - fx * 0.9 + tx * 1.6, s.z - fz * 0.9 + tz * 1.6];
      put(parts.benches, bx, bz, s.yaw, { length: 1.8 });
    }
    if (s.bin) {
      const [nx, nz] = s.binAt || [s.x - fx * 0.5 - tx * 1.1, s.z - fz * 0.5 - tz * 1.1];
      put(parts.bins, nx, nz, s.yaw, { kind: 'litter', model: 'bus stop' });
    }
    if (s.countdown) put(parts.countdowns, s.x, s.z, s.yaw);
  }
  return parts;
}

// ----------------------------------------------------------------------------------------------- the plan

const place_ = (items, groundHeight) =>
  (items || []).map((i) => ({ ...i, cx: i.x, cz: i.z, y: groundHeight ? groundHeight.heightAt(i.x, i.z) : 0 }));

/** All placed furniture of the document, with ground heights. */
export function buildFurniturePlan(doc, groundHeight = null, { seed = 1, place = null, resolveTree = null } = {}) {
  // `place(doc)` re-places the items against the street layout (js/placement-cph.js placeFurniture); its report rides along
  let report = null;
  if (place) {
    const placed = place(doc);
    doc = placed.doc;
    report = placed.report;
  }
  const stops = busStopParts(doc.busStops, groundHeight);
  const racks = rackItems(doc.bikeRacks, groundHeight, seed);
  const freeBikes = place_(doc.streetBikes, groundHeight);
  const benches = place_(doc.benches, groundHeight).concat(stops.benches);
  const bins = place_(doc.bins, groundHeight).concat(stops.bins);
  const plan = {
    trees: mapTrees(doc.trees, groundHeight, { resolve: resolveTree }),
    lamps: mapLamps(doc.lamps, groundHeight),
    cars: parkedCars(doc.parkingBays, groundHeight, seed),
    meters: place_(doc.parkMeters, groundHeight),
    bins,
    glass: place_(doc.glassContainers, groundHeight),
    stands: place_(doc.binStands, groundHeight),
    bollards: place_(doc.bollards, groundHeight),
    benches,
    hoops: racks.hoops,
    freeBikes,
    bikes: racks.bikes.concat(freeBikes),
    flags: stops.flags,
    shelters: stops.shelters,
    countdowns: stops.countdowns,
    rescue: place_(doc.rescuePosts, groundHeight),
    lakeLights: (doc.lakeLights || []).map((l) => ({ cx: l.x, cz: l.z, x: l.x, z: l.z, y: groundHeight ? groundHeight.heightAt(l.x, l.z) : 0, color: lightColor(l.cct), poolR: 4 })),
    monuments: place_(doc.monuments, groundHeight)
  };
  if (report) Object.defineProperty(plan, 'report', { value: report, enumerable: false });
  Object.defineProperty(plan, 'placedDoc', { value: doc, enumerable: false }); // the document the plan was built from (after placement)
  return plan;
}

export const FURNITURE_BOUNDS = { minX: -820, maxX: 820, minZ: -820, maxZ: 820 };

export function indexItems(items) {
  const qt = new Quadtree({ ...FURNITURE_BOUNDS }, 12, 8);
  for (const it of items) qt.insert(it);
  return qt;
}

/** Counts per category, for the info panel and the headless checks. */
export function planCounts(plan) {
  return Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
}
