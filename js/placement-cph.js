// js/placement-cph.js
// The constraint placer of the Copenhagen twin (pure, headless-testable). The street furniture data (tools/cph-geodata/furniture.py)
// is point data from many registers; none of them knows where the carriageway really is. This module re-places every item
// against the ONE street layout (js/zones-cph.js: footprints, water, the measured carriageway, the moving-traffic corridor, cycle
// strips, pavements) so that
//   * parked cars stand in the parking lane of the real carriageway, parallel to the kerb (perpendicular / angled where the
//     bay is), never in a moving lane, on a cycle strip, a pavement or a building, never on another car;
//   * trees, lamp masts, benches, bins, bollards, meters, stands, glass containers, rescue posts and monuments stand on the
//     pavement / open ground only, never on top of each other, trees keep their trunk off the facade and their crown inside it;
//   * wire lamps hang from anchors that sit on real facades (or become masts); a span never crosses a building;
//   * bike racks are clipped rows of at most 6 m; bus shelters stand on the pavement side of the stop.
// An item that cannot be placed is moved the shortest way that works, or dropped; everything dropped or moved is in the report.
// Frame: x east, z south; `yaw` is the direction an item faces: model +z -> (sin yaw, cos yaw).

import { carriagewayWidth, movingHalfWidth, VEHICLE_HALF } from './road-width-cph.js';
import { hash2, treeDimensions } from './street-furniture-data.js';

const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const CAR = { w: 1.95, d: 4.7, slack: 0.3 }; // the parked-car box (a sedan is 1.9 x 4.6, an SUV 1.95 x 4.7; +0.3 m of slack along the row)
const MARGIN = 0.5; // m added to a prop's footprint when it is tested against the (0.5 m) zone raster
const BUS_HALF = 1.32; // m: half a bus (2.55 m) and a few cm
const BUS_STREETS = new Set(['primary', 'secondary']);
const KERB_GAP = 0.12; // m between a parked car's side and the carriageway edge
const LANE_GAP = 0.05;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const SHOPPING_STREETS = new Set(['norrebrogade', 'blagardsgade', 'ravnsborggade', 'elmegade', 'faelledvej', 'sankt hans torv']);
const streetKey = (name = '') => name.toLowerCase().replaceAll('ø', 'o').replaceAll('æ', 'ae')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ oriented boxes
export function obb(x, z, yaw, w, d, offZ = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // axes: local x = (c, -s), local z = (s, c)
  return { x: x + offZ * s, z: z + offZ * c, hx: w / 2, hz: d / 2, ax: [c, -s], az: [s, c], r: Math.hypot(w, d) / 2 };
}

/** True when two oriented boxes overlap (separating axis test) by more than `margin` metres on every axis (negative margin: touching counts). */
export function obbOverlap(a, b, margin = 0) {
  if (Math.hypot(a.x - b.x, a.z - b.z) > a.r + b.r) return false;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const axis of [a.ax, a.az, b.ax, b.az]) {
    const ra = a.hx * Math.abs(a.ax[0] * axis[0] + a.ax[1] * axis[1]) + a.hz * Math.abs(a.az[0] * axis[0] + a.az[1] * axis[1]);
    const rb = b.hx * Math.abs(b.ax[0] * axis[0] + b.ax[1] * axis[1]) + b.hz * Math.abs(b.az[0] * axis[0] + b.az[1] * axis[1]);
    if (Math.abs(dx * axis[0] + dz * axis[1]) >= ra + rb - margin) return false;
  }
  return true;
}

function createObstacleIndex(cell = 8) {
  const hash = new Map();
  const key = (i, j) => i * 100003 + j;
  return {
    add(o, tag) {
      const rec = { o, tag };
      for (let i = Math.floor((o.x - o.r) / cell); i <= Math.floor((o.x + o.r) / cell); i++) {
        for (let j = Math.floor((o.z - o.r) / cell); j <= Math.floor((o.z + o.r) / cell); j++) {
          const k = key(i, j);
          if (!hash.has(k)) hash.set(k, []);
          hash.get(k).push(rec);
        }
      }
      return rec;
    },
    /** First placed box that overlaps `o`, or null. `skip(tag)` leaves boxes out. */
    hit(o, margin = 0, skip = null) {
      for (let i = Math.floor((o.x - o.r) / cell); i <= Math.floor((o.x + o.r) / cell); i++) {
        for (let j = Math.floor((o.z - o.r) / cell); j <= Math.floor((o.z + o.r) / cell); j++) {
          for (const rec of hash.get(key(i, j)) || []) if ((!skip || !skip(rec.tag)) && obbOverlap(o, rec.o, margin)) return rec;
        }
      }
      return null;
    }
  };
}

// ------------------------------------------------------------------------------------------------ roads and facades
/** Segment hash over the vehicular carriageways: nearest(x, z) -> the segment, its tangent, signed lateral offset, half width, lanes. */
export function createRoadIndex(geo, cell = 24) {
  const hash = new Map();
  const roads = [];
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.pts.length < 4 || r.drop) continue;
    // a parked car keeps clear of the widest vehicle that drives past it: buses run on the primary and secondary streets
    // (js/traffic.js keeps them to the 'ave' edges), 2.55 m wide where the moving strip is sized for a 1.9 m car
    const hw = carriagewayWidth(r) / 2;
    const mv = Math.min(hw, movingHalfWidth(r) + (BUS_STREETS.has(r.class) ? BUS_HALF - VEHICLE_HALF : 0));
    const rec = { r, hw, mv };
    roads.push(rec);
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i];
      const az = r.pts[i + 1];
      const bx = r.pts[i + 2];
      const bz = r.pts[i + 3];
      for (let ix = Math.floor((Math.min(ax, bx) - 12) / cell); ix <= Math.floor((Math.max(ax, bx) + 12) / cell); ix++) {
        for (let iz = Math.floor((Math.min(az, bz) - 12) / cell); iz <= Math.floor((Math.max(az, bz) + 12) / cell); iz++) {
          const k = ix * 100003 + iz;
          if (!hash.has(k)) hash.set(k, []);
          hash.get(k).push([rec, i]);
        }
      }
    }
  }
  return {
    roads,
    nearest(x, z, maxD = 14) {
      let best = null;
      for (const [rec, i] of hash.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []) {
        const p = rec.r.pts;
        const ax = p[i];
        const az = p[i + 1];
        const dx = p[i + 2] - ax;
        const dz = p[i + 3] - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d <= maxD && (!best || d < best.dist)) {
          const len = Math.sqrt(l2);
          const tx = dx / len;
          const tz = dz / len;
          // right of travel positive, as the surfaces' ribbons
          const lat = (x - ax) * -tz + (z - az) * tx;
          best = { rec, seg: i / 2, dist: d, tx, tz, lat, hw: rec.hw, mv: rec.mv, t };
        }
      }
      return best;
    }
  };
}

/** Segment hash over the building walls: nearest(x, z, r) -> { d, x, z (the foot point), nx, nz (outward normal), b (the building) }. */
export function createFacadeIndex(geo, cell = 16) {
  const hash = new Map();
  const segs = [];
  for (const b of geo.buildings || []) {
    const rings = [b.ring, ...(b.holes || [])];
    rings.forEach((r, ri) => {
      if (!r || r.length < 6) return;
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const s = { ax: r[2 * i], az: r[2 * i + 1], bx: r[2 * j], bz: r[2 * j + 1], b, hole: ri > 0 };
        const k0 = segs.push(s) - 1;
        for (let ix = Math.floor((Math.min(s.ax, s.bx) - 1) / cell); ix <= Math.floor((Math.max(s.ax, s.bx) + 1) / cell); ix++) {
          for (let iz = Math.floor((Math.min(s.az, s.bz) - 1) / cell); iz <= Math.floor((Math.max(s.az, s.bz) + 1) / cell); iz++) {
            const key = ix * 100003 + iz;
            if (!hash.has(key)) hash.set(key, []);
            hash.get(key).push(k0);
          }
        }
      }
    });
  }
  return {
    segments: segs,
    nearest(x, z, maxR = 8, accept = null) {
      let best = null;
      const rr = Math.ceil(maxR / cell);
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      const seen = new Set();
      for (let ix = cx - rr; ix <= cx + rr; ix++) {
        for (let iz = cz - rr; iz <= cz + rr; iz++) {
          for (const k of hash.get(ix * 100003 + iz) || []) {
            if (seen.has(k)) continue;
            seen.add(k);
            const s = segs[k];
            if (accept && !accept(s.b)) continue;
            const dx = s.bx - s.ax;
            const dz = s.bz - s.az;
            const l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
            const fx = s.ax + dx * t;
            const fz = s.az + dz * t;
            const d = Math.hypot(fx - x, fz - z);
            if (d <= maxR && (!best || d < best.d)) {
              const len = Math.sqrt(l2);
              best = { d, x: fx, z: fz, nx: dz / len, nz: -dx / len, b: s.b, hole: s.hole, seg: s };
            }
          }
        }
      }
      return best;
    },
    /** True when the open segment a-b passes through a building (shrunk by `inset`): sampled every 0.5 m. */
    crosses(ax, az, bx, bz, flagsAt, Zb, from = 1.0, to = 1.0) {
      const L = Math.hypot(bx - ax, bz - az);
      let run = 0;
      for (let s = from; s <= L - to; s += 0.5) {
        const f = flagsAt(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L);
        run = f & Zb ? run + 0.5 : 0;
        if (run >= 1.0) return true;
      }
      return false;
    }
  };
}

// ------------------------------------------------------------------------------------------------ the placer
const FOOT = {
  bins: [0.52, 0.52], binStands: [1.9, 0.72], glassContainers: [1.55, 1.55], benches: [1.8, 0.55], parkMeters: [0.46, 0.32], bollards: [0.3, 0.3],
  rescuePosts: [0.5, 0.2], monuments: [1.3, 1.3]
};
// how far (m) each kind may be moved to stand on walkable ground, and how much of its footprint may stay on solid ground
const SNAP = { bins: 2.5, binStands: 2.5, glassContainers: 3.0, benches: 2.5, parkMeters: 2.0, bollards: 1.5, rescuePosts: 2.0, monuments: 3.0 };

/**
 * @param {object} doc data/cph-furniture.json
 * @param {{ zones: object, geo: object, seed?: number }} ctx zones = createZoneMap, geo = layout-applied geodata
 * @returns {{ doc: object, report: { counts: object, dropped: object[], moved: object[], notes: object } }}
 */
export function placeFurniture(doc, { zones, geo }) {
  const { Z } = zones;
  const out = { ...doc };
  const obst = createObstacleIndex();
  const roads = createRoadIndex(geo);
  const facades = createFacadeIndex(geo);
  const counts = {};
  const dropped = [];
  const moved = [];
  const bump = (cat, key) => { counts[cat] ??= {}; counts[cat][key] = (counts[cat][key] || 0) + 1; };
  const drop = (cat, reason, it) => { bump(cat, `dropped:${reason}`); dropped.push({ cat, reason, x: +it.x.toFixed(1), z: +it.z.toFixed(1) }); };
  const note = (cat, reason, it, d) => { bump(cat, `moved:${reason}`); if (d > 1.0) moved.push({ cat, reason, x: +it.x.toFixed(1), z: +it.z.toFixed(1), d: +d.toFixed(1) }); };
  const solidAt = (x, z) => (zones.flagsAt(x, z) & (Z.BUILDING | Z.WATER | Z.ROAD | Z.CYCLE)) !== 0;

  // ---------------------------------------------------------------------------------------- 1. parked cars
  const bays = [];
  for (const b of doc.parkingBays || []) {
    const road = roads.nearest(b.x, b.z, 14);
    if (!road) { drop('cars', 'no-road', b); continue; }
    const absLat = Math.abs(road.lat);
    if (absLat > road.hw + 2.5) { drop('cars', 'off-carriageway', b); continue; }
    const side = road.lat >= 0 ? 1 : -1;
    const yawRoad = Math.atan2(road.tx, road.tz);
    const mv = road.mv;
    // the pose in the road's own frame: u along the road, lateral l (right positive)
    const rel = wrap(b.yaw - yawRoad);
    // the bay's angle against the road, snapped to the nearest of parallel / 45 / perpendicular (either sense)
    // (the bay's kind decides the family: parallel, perpendicular or 45 degrees; the sense follows the register's yaw)
    const snaps = b.kind === 'par' ? [0, Math.PI]
      : b.kind === 'perp' ? [Math.PI / 2, -Math.PI / 2]
        : b.kind === 'ang' ? [Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4]
          : [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, -Math.PI / 4, -Math.PI / 2, (-3 * Math.PI) / 4];
    let yaw = yawRoad;
    let best = 9;
    for (const a of snaps) { const d = Math.abs(wrap(rel - a)); if (d < best) { best = d; yaw = yawRoad + a; } }
    const along = Math.abs(Math.sin(wrap(yaw - yawRoad))); // 0 parallel .. 1 perpendicular: how much of the car's length points across the road
    const half = (CAR.d / 2) * along + (CAR.w / 2) * (1 - along); // half extent across the road
    const latMin = mv + half + LANE_GAP; // nearest the centreline: clear of the moving corridor
    const latMax = road.hw - half - KERB_GAP; // farthest: flush with the carriageway edge
    if (latMax < latMin - 1e-6) { drop('cars', 'no-room', b); continue; }
    // a car stands against the kerb on the side its bay lies on (nearest to the bay, but between the limits)
    const lat = side * Math.min(latMax, Math.max(latMin, absLat));
    bays.push({ b, road, yaw: wrap(yaw), lat, side, latMin, latMax, yawRoad });
  }
  // deterministic order: along the street, so the first car of a row keeps its place
  bays.sort((p, q) => p.b.x - q.b.x || p.b.z - q.b.z);
  const placedBays = [];
  for (const c of bays) {
    const { b, road } = c;
    // pose from (u, lat): foot point of the bay on the segment + lateral offset
    const p = road.rec.r.pts;
    const i = road.seg * 2;
    const ax = p[i];
    const az = p[i + 1];
    const dx = p[i + 2] - ax;
    const dz = p[i + 3] - az;
    const len = Math.hypot(dx, dz) || 1;
    const u0 = Math.max(0, Math.min(len, (b.x - ax) * (dx / len) + (b.z - az) * (dz / len)));
    let ok = null;
    for (const du of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
      const u = u0 + du;
      const x = ax + (dx / len) * u + -(dz / len) * c.lat;
      const z = az + (dz / len) * u + (dx / len) * c.lat;
      const box = obb(x, z, c.yaw, CAR.w, CAR.d + CAR.slack);
      const cov = zones.cover(x, z, c.yaw, CAR.w, CAR.d);
      // in the parking lane: on asphalt, not in the moving corridor, not on a strip, not on the pavement, not in a building
      if (cov.road < 0.97 || cov.moving > 0.02 || cov.cycle > 0.02 || cov.building > 0 || cov.water > 0 || cov.pavement > 0.05) continue;
      if (obst.hit(box)) continue;
      ok = { x, z, box, du };
      break;
    }
    if (!ok) { drop('cars', 'blocked', b); continue; }
    obst.add(ok.box, 'car');
    placedBays.push({ ...b, x: +ok.x.toFixed(2), z: +ok.z.toFixed(2), yaw: +c.yaw.toFixed(3) });
    const d = Math.hypot(ok.x - b.x, ok.z - b.z);
    if (d > 0.05) note('cars', 'aligned', b, d);
    bump('cars', 'kept');
  }
  out.parkingBays = placedBays;

  // ---------------------------------------------------------------------------------------- helpers for small props
  /** Snap a point item to walkable ground: the nearest spot within maxR where the footprint is walkable and free. */
  function snapItem(cat, it, w, d, maxR, { tol = 0, yawOf = null, tag = cat, clearFacade = 0, register = true } = {}) {
    const yaw = it.yaw || 0;
    const test = (x, z) => {
      if (zones.cover(x, z, yaw, w + MARGIN, d + MARGIN).solid > tol) return false; // the raster is 0.5 m: keep clear of its edges
      if (clearFacade) { const f = facades.nearest(x, z, clearFacade); if (f && f.d < clearFacade) return false; }
      return !obst.hit(obb(x, z, yaw, w, d), 0.0);
    };
    const hit = zones.nearest(it.x, it.z, test, maxR);
    if (!hit) return null;
    const next = { ...it, x: +hit.x.toFixed(2), z: +hit.z.toFixed(2) };
    if (yawOf) next.yaw = yawOf(next);
    if (register) obst.add(obb(next.x, next.z, yaw, w, d), tag);
    if (hit.d > 0.05) note(cat, 'snapped', it, hit.d);
    else bump(cat, 'kept');
    return next;
  }

  // ---------------------------------------------------------------------------------------- 2. bus stops
  const stops = [];
  for (const s of doc.busStops || []) {
    // the flag pole stands on the pavement side: snap it off the carriageway / cycle strip; the stop faces the carriageway
    const flag = zones.nearest(s.x, s.z, (x, z) => zones.cover(x, z, 0, 0.3 + MARGIN, 0.3 + MARGIN).solid === 0 && !obst.hit(obb(x, z, 0, 0.3, 0.3)), 4.0);
    if (!flag) { drop('busStops', 'no-pavement', s); continue; }
    // direction to the carriageway edge: from the flag towards the nearest road centreline
    const road = roads.nearest(flag.x, flag.z, 25);
    let yaw = s.yaw;
    let tangent = s.tangent || [Math.cos(s.yaw), -Math.sin(s.yaw)];
    if (road) {
      const lat = road.lat;
      // the carriageway lies towards the centreline: direction -sign(lat) * right normal
      const rx = -road.tz;
      const rz = road.tx;
      const toward = lat >= 0 ? [-rx, -rz] : [rx, rz];
      yaw = Math.atan2(toward[0], toward[1]);
      tangent = [road.tx, road.tz];
    }
    const base = { ...s, x: +flag.x.toFixed(2), z: +flag.z.toFixed(2), yaw: +yaw.toFixed(3), tangent: tangent.map((v) => +v.toFixed(3)) };
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const [tx, tz] = tangent;
    // the shelter (3.2 x 1.7 m, behind the kerb line, glass facing the carriageway): the nearest free spot along the stop
    if (s.shelter) {
      let spot = null;
      outer: for (const back of [0.9, 1.6, 2.4]) {
        for (const along of [2.2, -2.2, 3.4, -3.4, 4.6, -4.6, 1.2, -1.2, 0]) {
          const x = base.x - fx * back + tx * along;
          const z = base.z - fz * back + tz * along;
          if (zones.cover(x, z, yaw, 3.2 + MARGIN, 1.7 + MARGIN).solid > 0) continue;
          if (obst.hit(obb(x, z, yaw, 3.2, 1.7))) continue;
          spot = { x, z, back, along };
          break outer;
        }
      }
      if (spot) {
        base.shelterAt = [+spot.x.toFixed(2), +spot.z.toFixed(2)];
        obst.add(obb(spot.x, spot.z, yaw, 3.2, 1.7), 'shelter');
        bump('shelters', 'kept');
      } else {
        base.shelter = false;
        bump('shelters', 'dropped:no-room');
        dropped.push({ cat: 'shelters', reason: 'no-room', x: +s.x.toFixed(1), z: +s.z.toFixed(1) });
      }
    }
    obst.add(obb(base.x, base.z, 0, 0.3, 0.3), 'flag');
    // the stop's bench (1.8 x 0.55 m) and bin, beside the flag: the nearest free spot within 1.5 m of where the parts go
    if (!s.shelter && s.bench) {
      const spot = zones.nearest(base.x - fx * 0.9 + tx * 1.6, base.z - fz * 0.9 + tz * 1.6, (x, z) => zones.cover(x, z, yaw, 1.8 + MARGIN, 0.55 + MARGIN).solid === 0 && !obst.hit(obb(x, z, yaw, 1.8, 0.55)), 1.5);
      if (spot) { base.benchAt = [+spot.x.toFixed(2), +spot.z.toFixed(2)]; obst.add(obb(spot.x, spot.z, yaw, 1.8, 0.55), 'bench'); } else { base.bench = false; bump('busStops', 'bench-dropped'); }
    }
    if (s.bin) {
      const spot = zones.nearest(base.x - fx * 0.5 - tx * 1.1, base.z - fz * 0.5 - tz * 1.1, (x, z) => zones.cover(x, z, yaw, 0.52 + MARGIN, 0.52 + MARGIN).solid === 0 && !obst.hit(obb(x, z, yaw, 0.52, 0.52)), 1.5);
      if (spot) { base.binAt = [+spot.x.toFixed(2), +spot.z.toFixed(2)]; obst.add(obb(spot.x, spot.z, yaw, 0.52, 0.52), 'bin'); } else { base.bin = false; bump('busStops', 'bin-dropped'); }
    }
    bump('busStops', 'kept');
    stops.push(base);
  }
  out.busStops = stops;

  // ---------------------------------------------------------------------------------------- 3. monuments, then the pavement props
  out.monuments = (doc.monuments || []).map((m) => snapItem('monuments', m, ...FOOT.monuments, SNAP.monuments, { tol: 0.1 }) ?? (drop('monuments', 'no-ground', m), null)).filter(Boolean);

  // ---------------------------------------------------------------------------------------- 4. trees
  const trees = [];
  for (const t of doc.trees || []) {
    const { height: h, crownRadius: rx } = treeDimensions(t);
    const base = Math.max(1.4, h * 0.3);
    const test = (x, z) => {
      if (zones.cover(x, z, 0, 0.4 + MARGIN, 0.4 + MARGIN).solid > 0) return false; // a trunk must clear the kerb and the quay
      const f = facades.nearest(x, z, 0.7);
      if (f && f.d < 0.6) return false;
      return !obst.hit(obb(x, z, 0, 0.6, 0.6));
    };
    const spot = zones.nearest(t.x, t.z, test, 3.0);
    if (!spot) {
      const f0 = zones.flagsAt(t.x, t.z);
      drop('trees', f0 & Z.WATER ? 'in-water' : f0 & Z.BUILDING ? 'in-building' : 'no-ground', t);
      continue;
    }
    // the crown may reach 0.9 m into a facade whose eave is above the crown base; further in, it is trimmed (and noted)
    let crown = rx;
    const f = facades.nearest(spot.x, spot.z, rx + 1, (b) => (b.eave ?? 0) - (b.ground ?? 0) > base);
    if (f && !f.hole && rx - f.d > 0.9) crown = Math.max(1.0, f.d + 0.9);
    const next = { ...t, x: +spot.x.toFixed(2), z: +spot.z.toFixed(2) };
    if (crown < rx - 1e-6) { next.crown_radius = +crown.toFixed(2); next.crown_conf = 'trimmed'; bump('trees', 'crown-trimmed'); }
    if (spot.d > 0.05) note('trees', 'snapped', t, spot.d);
    else bump('trees', 'kept');
    obst.add(obb(spot.x, spot.z, 0, 0.6, 0.6), 'tree');
    trees.push(next);
  }
  out.trees = trees;

  // ---------------------------------------------------------------------------------------- 5. lamps
  const lamps = [];
  const carry = (b) => Math.min(8.9, (b.eave ?? 0) - (b.ground ?? 0) - 0.6); // how high a cable can hang on this facade (8.9 m at most)
  const tall = (b) => carry(b) >= 5.8; // a facade that can carry a cable
  // march from the lamp along (dx, dz) to the first building: the cable end sits 5 cm in front of that facade
  const rayToFacade = (x, z, dx, dz, maxD = 32) => {
    for (let sd = 0.5; sd <= maxD; sd += 0.25) {
      if (!(zones.flagsAt(x + dx * sd, z + dz * sd) & Z.BUILDING)) continue;
      let lo = sd - 0.25;
      let hi = sd;
      for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (zones.flagsAt(x + dx * m, z + dz * m) & Z.BUILDING) hi = m; else lo = m; }
      const px = x + dx * (lo - 0.05);
      const pz = z + dz * (lo - 0.05);
      const f = facades.nearest(x + dx * hi, z + dz * hi, 1.0);
      if (!f || !tall(f.b)) return null;
      return { s: lo - 0.05, x: px, z: pz, b: f.b, h: carry(f.b) };
    }
    return null;
  };
  const mastNear = (l, why) => {
    const road = roads.nearest(l.x, l.z, 20);
    const reach = road ? Math.min(14, road.hw + 3.5) : 4;
    const m = snapItem('lamps', { ...l, mount: 'mast', pole: 'tube', pole_h: 6.2, arm: null, span: undefined, light: l.light }, 0.4, 0.4, reach, { tag: 'lamp' });
    if (m) { lamps.push(m); bump('lamps', 'wire-to-mast'); } else drop('lamps', why, l);
  };
  for (const l of doc.lamps || []) {
    if (l.mount === 'wire' && l.span) {
      // A wire lamp hangs from a cable ACROSS the street, facade to facade (the surveyed 2018 line runs along the street between
      // lamps: it is the feed route, not the span). The cable goes along the street's right normal through the lamp; its ends are
      // the first facades met each way, 5 cm in front of the plaster.
      const road = roads.nearest(l.x, l.z, 25);
      let dx;
      let dz;
      if (road) { dx = -road.tz; dz = road.tx; } else { dx = l.span[3] - l.span[1]; dz = -(l.span[2] - l.span[0]); const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n; }
      const inBuilding = !!(zones.flagsAt(l.x, l.z) & Z.BUILDING);
      const A = inBuilding ? null : rayToFacade(l.x, l.z, -dx, -dz);
      const B = inBuilding ? null : rayToFacade(l.x, l.z, dx, dz);
      const total = A && B ? A.s + B.s : 0;
      if (A && B && total >= 8 && total <= 45 && A.s / total >= 0.1 && A.s / total <= 0.9) {
        const span = [+A.x.toFixed(2), +A.z.toFixed(2), +B.x.toFixed(2), +B.z.toFixed(2)];
        // a lamp hangs near the middle of its cable: one pulled towards a facade by the register's position goes back to 0.3 .. 0.7
        const t = Math.max(0.3, Math.min(0.7, A.s / total));
        const x = span[0] + (span[2] - span[0]) * t;
        const z = span[1] + (span[3] - span[1]) * t;
        lamps.push({ ...l, span, anchor_h: [+A.h.toFixed(2), +B.h.toFixed(2)], x: +x.toFixed(2), z: +z.toFixed(2) });
        bump('lamps', 'wire-anchored');
        continue;
      }
      bump('lamps', !A || !B ? 'wire-open-side' : total < 8 ? 'wire-too-short' : total > 45 ? 'wire-too-long' : 'wire-off-centre'); // why it became a mast
      mastNear(l, 'wire-no-anchor');
      continue;
    }
    if (l.mount === 'wire') { mastNear(l, 'wire-no-anchor'); continue; }
    const m = snapItem('lamps', l, 0.4, 0.4, 3.0, { tag: 'lamp' });
    if (m) lamps.push(m); else drop('lamps', 'no-ground', l);
  }
  out.lamps = lamps;

  // ---------------------------------------------------------------------------------------- 6. the other pavement props
  for (const key of ['benches', 'bins', 'binStands', 'glassContainers', 'parkMeters', 'bollards', 'rescuePosts']) {
    const [w, d] = key === 'benches' ? [1.8, 0.55] : FOOT[key];
    const list = [];
    for (const it of doc[key] || []) {
      const ww = key === 'benches' ? (it.length || 1.8) : w;
      const next = snapItem(key, it, ww, d, SNAP[key], { tol: key === 'glassContainers' || key === 'binStands' ? 0.05 : 0 });
      if (next) list.push(next);
      else drop(key, 'no-ground', it);
    }
    out[key] = list;
  }

  // ---------------------------------------------------------------------------------------- 7. bike racks: clipped rows
  const racks = [];
  const SLOT = 0.5;
  const ROW_MAX = 12; // slots: 6 m
  for (const r of doc.bikeRacks || []) {
    const n = Math.max(2, Math.min(48, r.capacity || 6));
    const ux = Math.sin(r.yaw);
    const uz = Math.cos(r.yaw);
    // try the record's own line, then shifted sideways (perpendicular) by up to 2.5 m: the first shift with a usable row wins
    let rows = null;
    for (const shift of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5]) {
      const ox = r.x + uz * shift;
      const oz = r.z - ux * shift;
      const valid = [];
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * SLOT;
        const x = ox + ux * o;
        const z = oz + uz * o;
        // the bike standing in its hoop: 0.5 m wide, 1.75 m long across the row
        valid.push(zones.cover(x, z, r.yaw + Math.PI / 2, 0.5 + MARGIN, 1.75 + MARGIN).solid === 0 && !obst.hit(obb(x, z, r.yaw + Math.PI / 2, 0.5, 1.75)));
      }
      const runs = [];
      let s0 = -1;
      for (let i = 0; i <= n; i++) {
        if (i < n && valid[i]) { if (s0 < 0) s0 = i; } else if (s0 >= 0) { if (i - s0 >= 2) runs.push([s0, i]); s0 = -1; }
      }
      const total = runs.reduce((a, [p, q]) => a + q - p, 0);
      if (total >= Math.min(n, 4) * 0.6 && total >= 2) { rows = { ox, oz, runs, shift, total }; break; }
    }
    if (!rows) { drop('bikeRacks', 'no-ground', r); continue; }
    let kept = 0;
    for (const [p, q] of rows.runs) {
      for (let a = p; a < q; a += ROW_MAX) {
        const b = Math.min(q, a + ROW_MAX);
        if (b - a < 2) continue;
        const mid = ((a + b - 1) / 2 - (n - 1) / 2) * SLOT;
        const cap = b - a;
        const x = rows.ox + ux * mid;
        const z = rows.oz + uz * mid;
        const nearbyRoad = roads.nearest(x, z, 20);
        const streetName = nearbyRoad?.rec.r.name || '';
        racks.push({ ...r, x: +x.toFixed(2), z: +z.toFixed(2), capacity: cap, streetName, shopping: SHOPPING_STREETS.has(streetKey(streetName)) });
        for (let i = a; i < b; i++) {
          const o = (i - (n - 1) / 2) * SLOT;
          obst.add(obb(rows.ox + ux * o, rows.oz + uz * o, r.yaw + Math.PI / 2, 0.5, 1.75), 'rack');
        }
        kept += cap;
      }
    }
    bump('bikeRacks', kept === n ? 'kept' : 'clipped');
    if (rows.shift) note('bikeRacks', 'shifted', r, Math.abs(rows.shift));
  }
  out.bikeRacks = racks;

  // ---------------------------------------------------------------------------------------- 8. facade-parked bicycles
  // A bicycle stands nose-out from the facade. Its full measured envelope is tested on the pavement, then a clear
  // 0.8 m walking strip is reserved between the front wheel and the cycle track/kerb.
  const streetBikes = [];
  const allFacades = facades.segments;
  for (let si = 0; si < allFacades.length; si++) {
    const s = allFacades[si];
    if (s.hole) continue;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const length = Math.hypot(dx, dz);
    if (length < 3.2) continue;
    const tx = dx / length;
    const tz = dz / length;
    const mx = (s.ax + s.bx) * 0.5;
    const mz = (s.az + s.bz) * 0.5;
    const midRoad = roads.nearest(mx, mz, 24);
    const streetName = midRoad?.rec.r.name || '';
    const shopping = SHOPPING_STREETS.has(streetKey(streetName));
    // On non-shopping frontages only occasional short rows are represented.
    if (!midRoad || (!shopping && hash2(mx, mz, si + 801) > 0.3)) continue;
    const slots = Math.max(1, Math.floor(length / 0.82));
    const phase = Math.floor(hash2(mx, mz, si + 811) * 5);
    for (let i = 0; i < slots; i++) {
      const active = shopping ? ((i + phase) % 5 < 3) : ((i + phase) % 5 < 2);
      if (!active) continue;
      const t = (i + 0.5) / slots;
      const px = s.ax + dx * t;
      const pz = s.az + dz * t;
      const road = roads.nearest(px, pz, 24);
      if (!road || streetKey(road.rec.r.name || '') !== streetKey(streetName)) continue;
      const side = Math.sign(road.lat) || 1;
      const nx = road.tz * side;
      const nz = -road.tx * side;
      const roll = hash2(px, pz, 821);
      const cargoCandidate = (i + phase) % 20 === 0;
      const cargoVariant = hash2(px, pz, 835) < 0.5 ? 'cargo-longjohn' : 'cargo-trike';
      const variant = cargoCandidate ? cargoVariant
          : roll < 0.16 ? 'mens'
            : roll < 0.39 ? 'city-crate'
              : roll < 0.52 ? 'city-childseat'
                : 'city';
      const size = 0.95 + hash2(px, pz, 823) * 0.1;
      const yawJitter = (hash2(px, pz, 827) - 0.5) * (16 * Math.PI / 180);
      const yaw = Math.atan2(nx, nz) + yawJitter;
      const lean = hash2(px, pz, 829) < 0.3 ? (hash2(px, pz, 831) - 0.5) * 0.16 : 0;
      const isLongjohn = variant === 'cargo-longjohn';
      const isTrike = variant === 'cargo-trike';
      const bikeHeight = variant === 'city-childseat' ? 1.26 : 1.158;
      const width = (isTrike ? 0.86 : isLongjohn ? 0.58 : 0.54) * size + 2 * Math.abs(Math.sin(lean)) * bikeHeight * size;
      const depth = (isLongjohn ? 2.74 : isTrike ? 2.12 : 1.84) * size;
      const offset = (isLongjohn ? 0.445 : isTrike ? 0.135 : 0) * size;
      const rootD = 1.02;
      const bx = px + nx * rootD;
      const bz = pz + nz * rootD;
      const footprint = obb(bx, bz, yaw, width, depth, offset);
      const coverage = zones.cover(bx, bz, yaw, width + 0.16, depth + 0.16, offset);
      if (coverage.solid > 0 || coverage.pavement + coverage.plaza < 0.92) continue;
      const clearance = obb(bx, bz, yaw, 1.2, 0.8, offset + depth / 2 + 0.46);
      const walk = zones.cover(clearance.x, clearance.z, yaw, 1.2, 0.8);
      if (walk.solid > 0 || walk.pavement + walk.plaza < 0.92) continue;
      // A prior walking strip blocks parked bikes. Strips can join each other, but must not
      // overlap furniture or another bike, so ignore only the walkway tags during this check.
      if (obst.hit(footprint) || obst.hit(clearance, 0, (tag) => tag === 'bike-walkway')) continue;
      obst.add(footprint, 'street-bike');
      obst.add(clearance, 'bike-walkway');
      const y = zones.heightAt ? zones.heightAt(bx, bz) : 0;
      const bike = {
        cx: bx, cz: bz, x: bx, y, z: bz, yaw,
        variant, hue: Math.floor(hash2(px, pz, 833) * 10), size, lean,
        shoppingStreet: shopping ? streetName : null,
        footprintW: width, footprintD: depth, footprintOffset: offset,
        walkingLine: { x: clearance.x, z: clearance.z, width: 1.2, depth: 0.8 }
      };
      streetBikes.push(bike);
    }
  }
  out.streetBikes = streetBikes;

  return { doc: out, report: { counts, dropped, moved } };
}
