// js/entrances.js
// Building entrances from real address data (data/cph-entrances.json, tools/cph-geodata/entrances.py): DAR husnummer
// `adgangspunkt` snapped to a wall. Pure (no three.js):
//   createEntranceIndex(doc)            entries per building id, ready for the ground-floor classifier and the door builder
//   placeDoors(b, rings, entries)       each entry on the nearest *cleaned* wall edge: { edgeNo, x, z, nx, nz, tx, tz, ... }
//   addDoors(acc, doors, opts)          door geometry (leaf, frame, step, canopy) into a vertex-coloured accumulator
// A building with at least one usable entry gets doors only there (the facade shader's heuristic street door is switched
// off for it, js/groundfloor.js); a building without data keeps the heuristic and is labelled inferred in the info panel.

const MAX_DOOR_SNAP = 6; // m: DAR places the point 2-5 m inside the footprint; beyond this the wall is not credible
const DEDUPE = 0.9; // m: husnumre 9A/9B often share one adgangspunkt: one door
const END_MARGIN = 0.75; // m of wall kept free on both sides of the door centre
const MIN_WALL_FOR_DOOR = 2 * END_MARGIN;

const DOOR_W = 1.0;
const DOOR_H = 2.15;
const FRAME_W = 0.12;
const FRAME_D = 0.1;
const LEAF_D = 0.05;
const STEP_H = 0.14;
const STEP_D = 0.32;
const CANOPY_W = 1.7;
const CANOPY_D = 0.55;
const CANOPY_T = 0.1;
const CANOPY_Y = 2.55;

// sRGB paint of the leaf (hashed per entrance), linear frame / step / canopy tones
const LEAF_PAINT = [[0.11, 0.105, 0.1], [0.3, 0.1, 0.07], [0.12, 0.2, 0.15], [0.4, 0.27, 0.15], [0.16, 0.19, 0.26], [0.22, 0.22, 0.22]];
const FRAME_TONE = [0.5, 0.48, 0.44];
const STEP_TONE = [0.46, 0.45, 0.43];
const CANOPY_TONE = [0.2, 0.21, 0.22];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Entries usable as doors: a wall within MAX_DOOR_SNAP, one per ~DEDUPE m. -> Map(buildingId -> entries[]). */
function createEntranceIndex(doc) {
  const byBuilding = new Map();
  for (const e of doc?.entrances || []) {
    if (!(e.d <= MAX_DOOR_SNAP)) continue;
    let list = byBuilding.get(e.bid);
    if (!list) byBuilding.set(e.bid, (list = []));
    const dup = list.find((o) => Math.hypot(o.sx - e.sx, o.sz - e.sz) < DEDUPE);
    if (dup) { dup.texts.push(e.text); continue; }
    list.push({ ...e, texts: [e.text] });
  }
  return byBuilding;
}

function closestOnSegment(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return [x0 + dx * t, z0 + dz * t, t];
}

/**
 * Doors of one building on its cleaned edges. `rings` is addBuilding's [outer, ...holes] ([[x, z], ...] per ring), so
 * `edgeNo` counts exactly like addBuilding/classifyWalls. The door centre is the entry's snapped point re-projected on
 * the cleaned edge and kept END_MARGIN away from the wall ends; walls shorter than MIN_WALL_FOR_DOOR carry none.
 */
function placeDoors(b, rings, entries) {
  const doors = [];
  for (const e of entries || []) {
    let best = null;
    let edgeNo = -1;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        edgeNo++;
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < MIN_WALL_FOR_DOOR) continue;
        const [cx, cz] = closestOnSegment(e.x, e.z, p[0], p[1], q[0], q[1]);
        const d = Math.hypot(cx - e.x, cz - e.z);
        if (!best || d < best.d) best = { d, edgeNo, p, q, len };
      }
    }
    if (!best || best.d > MAX_DOOR_SNAP + 1) continue;
    const { p, q, len } = best;
    const tx = (q[0] - p[0]) / len, tz = (q[1] - p[1]) / len;
    const along = Math.max(END_MARGIN, Math.min(len - END_MARGIN, (e.x - p[0]) * tx + (e.z - p[1]) * tz));
    if (doors.some((o) => o.edgeNo === best.edgeNo && Math.abs(o.along - along) < DEDUPE)) continue;
    doors.push({
      id: e.id, text: e.texts ? e.texts.join('/') : e.text, conf: e.conf, d: e.d, edgeNo: best.edgeNo, along, wallLen: len,
      x: p[0] + tx * along, z: p[1] + tz * along, tx, tz, nx: -tz, nz: tx
    });
  }
  return doors;
}

/** Axis-aligned-in-wall-frame box: centre at wall position (u along, w out), y0..y1; pushes 6 faces (12 triangles). */
function pushBox(acc, door, u, w, y0, wu, ww, y1, colour) {
  const { x, z, tx, tz, nx, nz } = door;
  const hu = wu / 2, hw = ww / 2;
  const P = (du, dw, y) => [x + tx * (u + du) + nx * (w + dw), y, z + tz * (u + du) + nz * (w + dw)];
  const c = [P(-hu, -hw, y0), P(hu, -hw, y0), P(hu, hw, y0), P(-hu, hw, y0), P(-hu, -hw, y1), P(hu, -hw, y1), P(hu, hw, y1), P(-hu, hw, y1)];
  const faces = [
    [[3, 2, 6, 7], [nx, 0, nz]], // front (away from the wall)
    [[1, 0, 4, 5], [-nx, 0, -nz]], // back
    [[2, 1, 5, 6], [tx, 0, tz]], // right
    [[0, 3, 7, 4], [-tx, 0, -tz]], // left
    [[4, 5, 6, 7], [0, 1, 0]], // top
    [[0, 1, 2, 3], [0, -1, 0]] // bottom
  ];
  for (const [ids, n] of faces) {
    const base = acc.position.length / 3;
    for (const i of ids) {
      acc.position.push(...c[i]);
      acc.normal.push(...n);
      acc.color.push(...colour);
    }
    acc.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function createDoorAccumulator() {
  return { position: [], normal: [], color: [], index: [] };
}

const hashOf = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Appends one door: opaque leaf in a frame (jambs + lintel proud of the wall), a concrete step and a small canopy.
 * `baseY` is the ground height at the door. Wall-frame coordinates: u along the wall, w out of it (outward normal).
 */
function addDoor(acc, door, baseY) {
  const paint = LEAF_PAINT[hashOf(String(door.id)) % LEAF_PAINT.length].map(srgbToLinear);
  const y0 = baseY + STEP_H;
  // step: wider than the frame, in front of it
  pushBox(acc, door, 0, STEP_D / 2, baseY, DOOR_W + 2 * FRAME_W + 0.3, STEP_D, y0, STEP_TONE);
  // leaf (slightly inside the frame plane) and frame
  pushBox(acc, door, 0, LEAF_D / 2, y0, DOOR_W, LEAF_D, y0 + DOOR_H, paint);
  pushBox(acc, door, -(DOOR_W + FRAME_W) / 2, FRAME_D / 2, y0, FRAME_W, FRAME_D, y0 + DOOR_H + FRAME_W, FRAME_TONE);
  pushBox(acc, door, (DOOR_W + FRAME_W) / 2, FRAME_D / 2, y0, FRAME_W, FRAME_D, y0 + DOOR_H + FRAME_W, FRAME_TONE);
  pushBox(acc, door, 0, FRAME_D / 2, y0 + DOOR_H, DOOR_W, FRAME_D, y0 + DOOR_H + FRAME_W, FRAME_TONE);
  // handle bar
  pushBox(acc, door, DOOR_W / 2 - 0.14, LEAF_D + 0.03, y0 + 1.0, 0.04, 0.06, y0 + 1.12, [0.55, 0.53, 0.5]);
  // canopy on two short brackets' worth of slab
  pushBox(acc, door, 0, CANOPY_D / 2, y0 + CANOPY_Y - CANOPY_T, CANOPY_W, CANOPY_D, y0 + CANOPY_Y, CANOPY_TONE);
}

/** Adds every door; `heightAt(x, z)` gives the terrain height at the door (default: the building's ground). */
function addDoors(acc, doors, { ground = 0, heightAt = null } = {}) {
  for (const door of doors) {
    const baseY = heightAt ? heightAt(door.x + door.nx * 0.3, door.z + door.nz * 0.3) : ground;
    addDoor(acc, door, baseY);
  }
  return doors.length;
}

export { MAX_DOOR_SNAP, DOOR_W, DOOR_H, createEntranceIndex, placeDoors, createDoorAccumulator, addDoor, addDoors };
