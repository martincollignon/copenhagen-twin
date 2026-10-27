import { bodyContact, buildingContact, collisionBody } from './collision-shapes.js';

const CELL = 8;
// Math.hypot is a builtin call that TurboFan does not inline (its numbers get boxed): the plain square root is inlined
const hypot = (a, b) => Math.sqrt(a * a + b * b);
// static candidates are fetched once per actor per resolve with this much slack, and reused while the body stays inside it
const STATIC_CACHE_PAD = 1.5;
const EPSILON = 1e-7;
const MAX_SWEEP_TRAVEL = 8;
const SWEEP_LIMIT = 48;
const PAIR_PASSES = 4;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const headingDelta = (from, to) => {
  let delta = to - from;
  delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
  return delta;
};

function updateBodyHeading(actor, heading) {
  if (actor._configuredHeading === heading) return;
  actor.heading = heading;
  actor.sin = Math.sin(heading);
  actor.cos = Math.cos(heading);
  actor.extX = actor.oriented
    ? Math.abs(actor.cos) * actor.hx + Math.abs(actor.sin) * actor.hz
    : actor.radius;
  actor.extZ = actor.oriented
    ? Math.abs(actor.sin) * actor.hx + Math.abs(actor.cos) * actor.hz
    : actor.radius;
  actor._configuredHeading = heading;
}

function configureBody(actor) {
  if (!actor._bodyReady || actor._bodyMode !== actor.mode || actor._bodySpec !== actor.spec || actor._bodyRadius !== actor.radius) {
    actor._configuredHeading = NaN;
    Object.assign(actor, collisionBody(actor.mode || 'person', actor.radius || 0.3, actor.heading || 0, 0, actor.spec || null));
    const overrides = actor.bodyShapeOverrides;
    if (overrides) {
      if (Number.isFinite(overrides.hx)) actor.hx = overrides.hx;
      if (Number.isFinite(overrides.hz)) actor.hz = overrides.hz;
      if (Number.isFinite(overrides.offsetForward)) actor.offsetForward = overrides.offsetForward;
    }
    actor._bodyReady = true;
    actor._bodyMode = actor.mode;
    actor._bodySpec = actor.spec;
    actor._bodyRadius = actor.radius;
  } else {
    const overrides = actor.bodyShapeOverrides;
    if (overrides) {
      if (Number.isFinite(overrides.hx)) actor.hx = overrides.hx;
      if (Number.isFinite(overrides.hz)) actor.hz = overrides.hz;
      if (Number.isFinite(overrides.offsetForward)) actor.offsetForward = overrides.offsetForward;
    }
  }
  actor.bottom = Number.isFinite(actor.bodyBottom) ? actor.bodyBottom : actor.mode === 'helicopter' ? -0.25 : 0;
  if (Number.isFinite(actor.bodyTop)) actor.top = actor.bodyTop;
  else if (actor.mode === 'car' && Number.isFinite(actor.spec?.height)) actor.top = actor.spec.height;
  updateBodyHeading(actor, Number.isFinite(actor.heading) ? actor.heading : 0);
}

function actorVelocity(actor, out) {
  if (typeof actor.getVelocity === 'function') {
    const velocity = actor.getVelocity(out);
    out.x = velocity?.x ?? velocity?.vx ?? 0;
    out.z = velocity?.z ?? velocity?.vz ?? 0;
  } else {
    out.x = actor.vx || 0;
    out.z = actor.vz || 0;
  }
  return out;
}

function applyVelocity(actor, dx, dz) {
  if (typeof actor.applyVelocity === 'function') actor.applyVelocity(dx, dz);
  else {
    actor.vx = (actor.vx || 0) + dx;
    actor.vz = (actor.vz || 0) + dz;
  }
}

function translate(actor, dx, dz) {
  if (Math.abs(dx) + Math.abs(dz) < EPSILON) return false;
  const oldHeading = actor.heading;
  if (typeof actor.move === 'function') {
    const actual = actor.move(dx, dz);
    if (actual && Number.isFinite(actual.x) && Number.isFinite(actual.z)) {
      actor.x = actual.x;
      actor.z = actual.z;
    } else {
      actor.x += dx;
      actor.z += dz;
    }
  } else {
    actor.x += dx;
    actor.z += dz;
  }
  if (actor.heading !== oldHeading) configureBody(actor);
  actor._moved = true;
  return true;
}

const rotationTravel = (actor) => actor.oriented && Number.isFinite(actor.prevHeading)
  ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * hypot(actor.hx, actor.hz) : 0;
const halfWidth = (actor) => actor.oriented ? Math.min(actor.hx, actor.hz) : actor.radius;

function clipTo(actor, toi) {
  const x = actor.prevX + (actor.x - actor.prevX) * toi;
  const z = actor.prevZ + (actor.z - actor.prevZ) * toi;
  translate(actor, x - actor.x, z - actor.z);
}

function inverseMass(actor) {
  if (Number.isFinite(actor.inverseMass)) return Math.max(0, actor.inverseMass);
  const mass = Number.isFinite(actor.mass) ? actor.mass : 70;
  return 1 / Math.max(1, mass);
}

/**
 * A collision actor record with every field the stage reads or writes, in one fixed order. The simulations' adapters (js/traffic.js,
 * js/cyclists.js, js/world.js) all come from here, so they share one hidden class: the stage's per-frame loads and stores stay
 * monomorphic and keep their numbers unboxed (with five adapter shapes every numeric store went through a megamorphic stub that
 * allocated a heap number, about a megabyte a frame citywide). `init` sets the adapter's own fields and methods.
 */
export function createCollisionActor(init = {}) {
  const actor = {
    entity: null, kind: '', mode: 'person', spec: null, radius: 0.3, mass: 70.5, inverseMass: NaN, collisionIndex: NaN,
    bodyTop: NaN, bodyBottom: NaN, bodyShapeOverrides: null,
    x: 0.5, y: 0.5, z: 0.5, prevX: 0.5, prevY: 0.5, prevZ: 0.5, heading: 0.5, prevHeading: 0.5,
    placed: true, active: true, sweep: true, _wasPlaced: false,
    getVelocity: null, applyVelocity: null, move: null, onContact: null, onStaticContact: null,
    car: false, oriented: false, sin: 0.5, cos: 0.5, hx: 0.5, hz: 0.5, offsetForward: 0.5, extX: 0.5, extZ: 0.5, bottom: 0.5, top: 0.5,
    _bodyReady: false, _bodyMode: '', _bodySpec: null, _bodyRadius: 0.5, _configuredHeading: 0.5,
    _cellIX0: 0, _cellIX1: 0, _cellIZ0: 0, _cellIZ1: 0, _insertedIX0: 0, _insertedIX1: 0, _insertedIZ0: 0, _insertedIZ1: 0,
    _sweep: false, _moved: false,
    _staticList: [], _staticStamp: -1, _staticVersion: -1, _staticX: 0.5, _staticZ: 0.5, _staticR: 0.5,
    _clearX: 0.5, _clearY: 0.5, _clearZ: 0.5, _clearHeading: 0.5, _clearVersion: -1, _clearExtX: 0.5, _clearExtZ: 0.5,
    _clearTop: 0.5, _clearBottom: 0.5
  };
  // the placeholders above make the numeric fields doubles; now the real starting state
  actor.mass = 70; actor.x = actor.y = actor.z = actor.prevX = actor.prevY = actor.prevZ = 0;
  actor.heading = actor.prevHeading = 0; actor._clearX = NaN; actor._bodyRadius = NaN; actor._configuredHeading = NaN;
  for (const key of Object.keys(init)) {
    if (!(key in actor)) throw new Error(`createCollisionActor: unknown field ${key}`);
    actor[key] = init[key];
  }
  return actor;
}

/**
 * Shared moving-body and static-solid contact stage. Actor records are stable adapters owned by their simulations;
 * a `move(dx,dz)` adapter must commit the correction back to its route or controller state.
 */
export function createCityCollisions({ staticIndex = null, groundHeight = null } = {}) {
  // Broad phase without per-frame garbage: the grid cells touched this frame live in an open-addressing table (stamped, so it is
  // never cleared), each cell a list of entries in insertion order, and the candidate pairs in a stamped set plus a list; all typed
  // arrays reused from frame to frame (a Map and a Set cleared and refilled every frame regrew their tables each time).
  let cellBits = 12, cellCap = 1 << cellBits;
  let cellKeys = new Int32Array(cellCap), cellStamps = new Uint32Array(cellCap);
  let cellFirst = new Int32Array(cellCap), cellLast = new Int32Array(cellCap);
  let cellUsed = 0;
  let pairBits = 12, pairCap = 1 << pairBits;
  let pairKeyTable = new Int32Array(pairCap), pairStamps = new Uint32Array(pairCap);
  let pairUsed = 0;
  let entryActor = new Int32Array(2048), entryNext = new Int32Array(2048), entryCount = 0;
  let pairList = new Int32Array(2048), pairCount = 0;
  let gridStamp = 0, gridOverflow = false;
  const staticCandidates = [];
  const contact = { nx: 0, nz: 0, depth: 0 };
  const pairContact = { nx: 0, nz: 0, depth: 0 };
  const savedA = new Float64Array(10);
  const savedB = new Float64Array(10);
  const va = { x: 0, z: 0 };
  const vb = { x: 0, z: 0 };
  const movedActors = [];
  // optional probe (tools/check-collisions.py --survey): observer.static(actor, collider, contact) and observer.pair(a, b, contact)
  let observer = null;
  let resolveStamp = 0;
  let indexVersion = 0;
  const stats = { candidatePairs: 0, contacts: 0, staticQueries: 0, staticContacts: 0,
    broadphaseBuilds: 0, sweepQueries: 0, sweepSamples: 0 };

  const groundAt = (actor) => {
    if (Number.isFinite(actor.y)) return actor.y;
    if (typeof groundHeight === 'function') return groundHeight(actor.x, actor.z) || 0;
    if (groundHeight?.heightAt) return groundHeight.heightAt(actor.x, actor.z) || 0;
    if (groundHeight?.terrainAt) return groundHeight.terrainAt(actor.x, actor.z) || 0;
    return 0;
  };

  function resetGrid() {
    gridStamp = (gridStamp + 1) >>> 0;
    if (gridStamp === 0) { cellStamps.fill(0); pairStamps.fill(0); gridStamp = 1; }
    cellUsed = pairUsed = entryCount = pairCount = 0;
    gridOverflow = false;
  }

  function growTables() {
    cellBits++; cellCap = 1 << cellBits;
    cellKeys = new Int32Array(cellCap); cellStamps = new Uint32Array(cellCap);
    cellFirst = new Int32Array(cellCap); cellLast = new Int32Array(cellCap);
    pairBits++; pairCap = 1 << pairBits;
    pairKeyTable = new Int32Array(pairCap); pairStamps = new Uint32Array(pairCap);
    gridStamp = 0;
  }

  function addPair(lo, hi) {
    const pair = lo * 65536 + hi;
    const mask = pairCap - 1;
    let h = Math.imul(pair, 0x9E3779B1) >>> (32 - pairBits);
    while (pairStamps[h] === gridStamp) {
      if (pairKeyTable[h] === pair) return;
      h = (h + 1) & mask;
    }
    pairStamps[h] = gridStamp; pairKeyTable[h] = pair;
    if (++pairUsed * 2 > pairCap) gridOverflow = true;
    if (pairCount === pairList.length) { const grown = new Int32Array(pairCount * 2); grown.set(pairList); pairList = grown; }
    pairList[pairCount++] = pair;
  }

  function addCell(ix, iz, index) {
    // 15 bits per axis keep the key a small integer; an 8 m grid wraps after 262 km, and an aliased cell only adds candidate pairs
    // that the exact test rejects
    const key = ((ix & 0x7fff) << 15) | (iz & 0x7fff);
    const mask = cellCap - 1;
    let h = Math.imul(key, 0x85EBCA6B) >>> (32 - cellBits);
    while (cellStamps[h] === gridStamp && cellKeys[h] !== key) h = (h + 1) & mask;
    if (cellStamps[h] !== gridStamp) {
      cellStamps[h] = gridStamp; cellKeys[h] = key; cellFirst[h] = -1; cellLast[h] = -1;
      if (++cellUsed * 2 > cellCap) gridOverflow = true;
    }
    for (let e = cellFirst[h]; e >= 0; e = entryNext[e]) {
      const other = entryActor[e];
      if (other !== index) addPair(other < index ? other : index, other < index ? index : other);
    }
    if (entryCount === entryActor.length) {
      const actorsGrown = new Int32Array(entryCount * 2); actorsGrown.set(entryActor); entryActor = actorsGrown;
      const nextGrown = new Int32Array(entryCount * 2); nextGrown.set(entryNext); entryNext = nextGrown;
    }
    const entry = entryCount++;
    entryActor[entry] = index; entryNext[entry] = -1;
    if (cellLast[h] >= 0) entryNext[cellLast[h]] = entry; else cellFirst[h] = entry;
    cellLast[h] = entry;
  }

  function prepareActors(actors) {
    for (const actor of actors) {
      if (!actor || actor.active === false || actor.placed === false || !Number.isFinite(actor.x) || !Number.isFinite(actor.z)) continue;
      configureBody(actor);
      actor.y = groundAt(actor);
      const dx = Number.isFinite(actor.prevX) ? actor.x - actor.prevX : 0;
      const dz = Number.isFinite(actor.prevZ) ? actor.z - actor.prevZ : 0;
      const distance = hypot(dx, dz);
      const canSweep = actor.sweep !== false && actor._wasPlaced !== false
        && Number.isFinite(actor.prevX) && Number.isFinite(actor.prevZ) && distance < MAX_SWEEP_TRAVEL;
      if (!canSweep) {
        actor.prevX = actor.x;
        actor.prevZ = actor.z;
        actor.prevY = actor.y;
        actor._sweep = false;
        continue;
      }
      const angularTravel = Number.isFinite(actor.prevHeading) && actor.oriented
        ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * hypot(actor.hx, actor.hz) : 0;
      actor._sweep = distance >= 0.05 || angularTravel >= 0.05;
    }
  }

  function cellBounds(actor) {
    const offset = Math.abs(actor.offsetForward || 0);
    const radiusX = actor._sweep && actor.oriented ? hypot(actor.hx, actor.hz) : actor.extX;
    const radiusZ = actor._sweep && actor.oriented ? hypot(actor.hx, actor.hz) : actor.extZ;
    const minX = Math.min(actor.x, actor.prevX) - radiusX - offset;
    const maxX = Math.max(actor.x, actor.prevX) + radiusX + offset;
    const minZ = Math.min(actor.z, actor.prevZ) - radiusZ - offset;
    const maxZ = Math.max(actor.z, actor.prevZ) + radiusZ + offset;
    actor._cellIX0 = Math.floor(minX / CELL);
    actor._cellIX1 = Math.floor(maxX / CELL);
    actor._cellIZ0 = Math.floor(minZ / CELL);
    actor._cellIZ1 = Math.floor(maxZ / CELL);
  }

  function broadphase(actors) {
    resetGrid();
    fillGrid(actors);
    while (gridOverflow) { growTables(); resetGrid(); fillGrid(actors); } // a busier frame than the tables were sized for
    stats.candidatePairs = pairCount;
  }

  function fillGrid(actors) {
    stats.broadphaseBuilds++;
    for (let index = 0; index < actors.length; index++) {
      const actor = actors[index];
      if (!actor || actor.active === false || actor.placed === false || !Number.isFinite(actor.x) || !Number.isFinite(actor.z)) continue;
      cellBounds(actor);
      actor._insertedIX0 = actor._cellIX0; actor._insertedIX1 = actor._cellIX1;
      actor._insertedIZ0 = actor._cellIZ0; actor._insertedIZ1 = actor._cellIZ1;
      for (let ix = actor._cellIX0; ix <= actor._cellIX1; ix++) {
        for (let iz = actor._cellIZ0; iz <= actor._cellIZ1; iz++) addCell(ix, iz, index);
      }
    }
  }

  function refreshSweepsAfterStatics(actors) {
    for (const actor of actors) {
      if (!actor || actor.active === false || actor.placed === false) continue;
      const dx = actor.x - actor.prevX, dz = actor.z - actor.prevZ;
      const distance = hypot(dx, dz);
      if (actor._wasPlaced === false || actor.sweep === false || !Number.isFinite(distance) || distance >= MAX_SWEEP_TRAVEL) {
        actor.prevX = actor.x;
        actor.prevY = actor.y;
        actor.prevZ = actor.z;
        actor._sweep = false;
        continue;
      }
      const angularTravel = Number.isFinite(actor.prevHeading) && actor.oriented
        ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * hypot(actor.hx, actor.hz) : 0;
      actor._sweep = distance >= 0.05 || angularTravel >= 0.05;
    }
  }

  function needsBroadphaseRebuild(actors) {
    for (const actor of actors) {
      if (!actor?._moved || actor.active === false || actor.placed === false) continue;
      cellBounds(actor);
      if (actor._cellIX0 < actor._insertedIX0 || actor._cellIX1 > actor._insertedIX1
        || actor._cellIZ0 < actor._insertedIZ0 || actor._cellIZ1 > actor._insertedIZ1) return true;
    }
    return false;
  }

  function savePose(actor, saved) {
    saved[0] = actor.x; saved[1] = actor.y; saved[2] = actor.z; saved[3] = actor.heading;
    saved[4] = actor.sin; saved[5] = actor.cos; saved[6] = actor.hx; saved[7] = actor.hz;
    saved[8] = actor.extX; saved[9] = actor.extZ;
  }

  function setInterpolatedPose(actor, saved, t) {
    const prevY = Number.isFinite(actor.prevY) ? actor.prevY : saved[1];
    actor.x = actor.prevX + (saved[0] - actor.prevX) * t;
    actor.y = prevY + (saved[1] - prevY) * t;
    actor.z = actor.prevZ + (saved[2] - actor.prevZ) * t;
    const heading = Number.isFinite(actor.prevHeading) && Number.isFinite(saved[3])
      ? actor.prevHeading + headingDelta(actor.prevHeading, saved[3]) * t : saved[3];
    updateBodyHeading(actor, heading);
  }

  function restorePose(actor, saved) {
    actor.x = saved[0]; actor.y = saved[1]; actor.z = saved[2]; actor.heading = saved[3];
    actor.sin = saved[4]; actor.cos = saved[5]; actor.hx = saved[6]; actor.hz = saved[7];
    actor.extX = saved[8]; actor.extZ = saved[9]; actor._configuredHeading = saved[3];
  }

  function contactAt(a, b, t, out) {
    stats.sweepSamples++;
    savePose(a, savedA);
    savePose(b, savedB);
    setInterpolatedPose(a, savedA, t);
    setInterpolatedPose(b, savedB, t);
    const hit = bodyContact(a, b, out);
    restorePose(a, savedA);
    restorePose(b, savedB);
    return hit;
  }

  function endpointMayOverlap(a, b) {
    if (a.y + a.bottom >= b.y + b.top || a.y + a.top <= b.y + b.bottom) return false;
    const acx = a.x + a.sin * (a.offsetForward || 0);
    const acz = a.z + a.cos * (a.offsetForward || 0);
    const bcx = b.x + b.sin * (b.offsetForward || 0);
    const bcz = b.z + b.cos * (b.offsetForward || 0);
    return Math.abs(acx - bcx) <= a.extX + b.extX && Math.abs(acz - bcz) <= a.extZ + b.extZ;
  }

  function sweptEnvelopeMayOverlap(a, b) {
    const ax = (a.oriented ? hypot(a.hx, a.hz) : a.radius) + Math.abs(a.offsetForward || 0);
    const bx = (b.oriented ? hypot(b.hx, b.hz) : b.radius) + Math.abs(b.offsetForward || 0);
    const aMinX = Math.min(a.prevX, a.x) - ax, aMaxX = Math.max(a.prevX, a.x) + ax;
    const bMinX = Math.min(b.prevX, b.x) - bx, bMaxX = Math.max(b.prevX, b.x) + bx;
    if (aMinX > bMaxX || bMinX > aMaxX) return false;
    const aMinZ = Math.min(a.prevZ, a.z) - ax, aMaxZ = Math.max(a.prevZ, a.z) + ax;
    const bMinZ = Math.min(b.prevZ, b.z) - bx, bMaxZ = Math.max(b.prevZ, b.z) + bx;
    return aMinZ <= bMaxZ && bMinZ <= aMaxZ;
  }

  function sweptContact(a, b, out) {
    if (!a._sweep && !b._sweep) return false;
    stats.sweepQueries++;
    if (!sweptEnvelopeMayOverlap(a, b)) return false;
    const daX = a.x - a.prevX, daZ = a.z - a.prevZ;
    const dbX = b.x - b.prevX, dbZ = b.z - b.prevZ;
    const travel = Math.max(hypot(daX, daZ), hypot(dbX, dbZ), rotationTravel(a), rotationTravel(b));
    if (travel < 0.05) return false;
    const minFootprint = Math.max(0.16, Math.min(halfWidth(a), halfWidth(b)));
    const steps = clamp(Math.ceil(travel / (minFootprint * 0.35)), 8, SWEEP_LIMIT);
    let previous = 0;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      if (!contactAt(a, b, t, out)) { previous = t; continue; }
      let low = previous, high = t;
      for (let i = 0; i < 7; i++) {
        const mid = (low + high) * 0.5;
        if (contactAt(a, b, mid, out)) high = mid;
        else low = mid;
      }
      const toi = Math.min(1, high + 0.001);
      clipTo(a, toi); clipTo(b, toi);
      return true;
    }
    return false;
  }

  function removeIncomingVelocity(a, b, nx, nz) {
    actorVelocity(a, va);
    actorVelocity(b, vb);
    const relative = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
    if (!(relative < 0)) return Math.max(0, -relative);
    const ia = inverseMass(a), ib = inverseMass(b), sum = ia + ib;
    if (sum <= 0) return -relative;
    const impulse = -relative / sum;
    applyVelocity(a, nx * impulse * ia, nz * impulse * ia);
    applyVelocity(b, -nx * impulse * ib, -nz * impulse * ib);
    return -relative;
  }

  function solvePair(a, b) {
    if (!bodyContact(a, b, pairContact)) return false;
    stats.contacts++;
    if (observer) observer.pair(a, b, pairContact);
    const nx = pairContact.nx, nz = pairContact.nz;
    const targetDepth = Math.min(pairContact.depth + 0.005, 2.5);
    const invA = inverseMass(a), invB = inverseMass(b), total = invA + invB;
    if (total > 0) {
      const shareA = targetDepth * invA / total;
      const shareB = targetDepth * invB / total;
      const startAX = a.x, startAZ = a.z, startBX = b.x, startBZ = b.z;
      translate(a, nx * shareA, nz * shareA);
      translate(b, -nx * shareB, -nz * shareB);
      solveStatics(a);
      solveStatics(b);

      // If a wall or road limit blocked one body’s share, transfer that displacement to the body that still has room.
      const movedA = Math.max(0, (a.x - startAX) * nx + (a.z - startAZ) * nz);
      const movedB = Math.max(0, (startBX - b.x) * nx + (startBZ - b.z) * nz);
      const blockedA = Math.max(0, shareA - movedA);
      const blockedB = Math.max(0, shareB - movedB);
      if (blockedA > EPSILON) {
        translate(b, -nx * blockedA, -nz * blockedA);
        solveStatics(b);
      }
      if (blockedB > EPSILON) {
        translate(a, nx * blockedB, nz * blockedB);
        solveStatics(a);
      }

      // Bounded fallback handles route clamps or two partial static corrections without pushing through a wall.
      for (let attempt = 0; attempt < 2 && bodyContact(a, b, pairContact); attempt++) {
        const remaining = Math.min(pairContact.depth + 0.005, 2.5);
        translate(a, nx * remaining, nz * remaining);
        solveStatics(a);
        if (!bodyContact(a, b, pairContact)) break;
        const rest = Math.min(pairContact.depth + 0.005, 2.5);
        translate(b, -nx * rest, -nz * rest);
        solveStatics(b);
      }
    }
    const impact = removeIncomingVelocity(a, b, nx, nz);
    if (typeof a.onContact === 'function') a.onContact(b, nx, nz, impact);
    if (typeof b.onContact === 'function') b.onContact(a, -nx, -nz, impact);
    return true;
  }

  // The static candidates around an actor: one index query per actor per resolve (with STATIC_CACHE_PAD of slack), reused by the
  // later passes and the pair corrections while the body's reach stays inside the fetched square.
  function staticsNear(actor, reach) {
    let list = actor._staticList;
    if (!list) list = actor._staticList = [];
    if (actor._staticStamp === resolveStamp && actor._staticVersion === indexVersion
      && Math.abs(actor.x - actor._staticX) + reach <= actor._staticR && Math.abs(actor.z - actor._staticZ) + reach <= actor._staticR) return list;
    stats.staticQueries++;
    const r = reach + STATIC_CACHE_PAD;
    staticIndex.query(actor.x, actor.z, r, list);
    actor._staticStamp = resolveStamp; actor._staticVersion = indexVersion;
    actor._staticX = actor.x; actor._staticZ = actor.z; actor._staticR = r;
    return list;
  }

  function solveStatics(actor) {
    if (!staticIndex || actor.active === false || actor.placed === false) return false;
    let moved = false;
    for (let pass = 0; pass < 3; pass++) {
      const reach = Math.max(actor.extX, actor.extZ) + Math.abs(actor.offsetForward || 0) + 0.5;
      const nearby = staticsNear(actor, reach);
      let hit = false;
      // buildingContact's own first rejections, inline: most candidates end here without a call (whose numbers would be boxed)
      let off = actor.offsetForward || 0;
      let cx = actor.x + actor.sin * off, cz = actor.z + actor.cos * off;
      const low = actor.y + actor.bottom, high = actor.y + actor.top;
      for (let i = 0; i < nearby.length; i++) {
        const collider = nearby[i];
        if (low >= collider.maxY || high <= (collider.minY ?? 0)) continue;
        if (cx + actor.extX <= collider.minX || cx - actor.extX >= collider.maxX
          || cz + actor.extZ <= collider.minZ || cz - actor.extZ >= collider.maxZ) continue;
        if (!buildingContact(collider, actor.x, actor.y, actor.z, actor, contact)) continue;
        stats.staticContacts++;
        if (observer) observer.static(actor, collider, contact);
        hit = moved = true;
        translate(actor, contact.nx * Math.min(contact.depth + 0.002, 24), contact.nz * Math.min(contact.depth + 0.002, 24));
        off = actor.offsetForward || 0; // the body moved (and may have turned): later candidates are tested where it now is
        cx = actor.x + actor.sin * off; cz = actor.z + actor.cos * off;
        actorVelocity(actor, va);
        const incoming = va.x * contact.nx + va.z * contact.nz;
        if (incoming < 0) applyVelocity(actor, -incoming * contact.nx, -incoming * contact.nz);
        if (typeof actor.onStaticContact === 'function') actor.onStaticContact(collider, contact.nx, contact.nz, incoming, contact.depth);
      }
      if (!hit) {
        // proven clear of every solid at this exact pose: an actor still here next frame skips its first static pass
        actor._clearX = actor.x; actor._clearZ = actor.z; actor._clearY = actor.y; actor._clearHeading = actor.heading;
        actor._clearVersion = indexVersion; actor._clearExtX = actor.extX; actor._clearExtZ = actor.extZ;
        actor._clearTop = actor.top; actor._clearBottom = actor.bottom;
        return moved;
      }
    }
    actor._clearX = NaN;
    return moved;
  }

  /** True when the actor rests exactly where the previous resolve proved it clear of solids, and the solids did not change. */
  const restingClear = (actor) => actor._clearX === actor.x && actor._clearZ === actor.z && actor._clearY === actor.y
    && actor._clearHeading === actor.heading && actor._clearVersion === indexVersion
    && actor._clearExtX === actor.extX && actor._clearExtZ === actor.extZ
    && actor._clearTop === actor.top && actor._clearBottom === actor.bottom;

  function resolve(actors, { dt = 0 } = {}) {
    stats.candidatePairs = stats.contacts = stats.staticQueries = stats.staticContacts = 0;
    stats.broadphaseBuilds = stats.sweepQueries = stats.sweepSamples = 0;
    movedActors.length = 0;
    resolveStamp++;
    indexVersion = staticIndex && Number.isFinite(staticIndex.version) ? staticIndex.version : 0;
    stats.restingSkips = 0;
    prepareActors(actors);
    for (const actor of actors) {
      if (!actor || actor.active === false || actor.placed === false || !Number.isFinite(actor.x) || !Number.isFinite(actor.z)) continue;
      if (restingClear(actor)) { stats.restingSkips++; continue; }
      solveStatics(actor);
    }
    refreshSweepsAfterStatics(actors);
    broadphase(actors);
    let maxCandidates = pairCount;
    for (let pass = 0; pass < PAIR_PASSES; pass++) {
      let any = false;
      for (let p = 0; p < pairCount; p++) {
        const key = pairList[p];
        const i = key >>> 16, j = key & 0xffff;
        const a = actors[i], b = actors[j];
        if (!a || !b || a.active === false || b.active === false || a.placed === false || b.placed === false) continue;
        const endpointHit = endpointMayOverlap(a, b) && bodyContact(a, b, contact);
        let pairHit = false;
        if (!endpointHit && pass === 0 && sweptContact(a, b, contact)) {
          pairHit = solvePair(a, b);
        } else if (endpointHit) {
          pairHit = solvePair(a, b);
        }
        any = pairHit || any;
      }
      if (!any) break;
      if (pass + 1 < PAIR_PASSES && needsBroadphaseRebuild(actors)) {
        broadphase(actors);
        maxCandidates = Math.max(maxCandidates, pairCount);
      }
    }
    stats.candidatePairs = maxCandidates;
    for (const actor of actors) {
      if (actor?._moved) {
        movedActors.push(actor);
        actor._moved = false;
      }
      if (actor && Number.isFinite(actor.x) && Number.isFinite(actor.z)) {
        actor.prevX = actor.x;
        actor.prevZ = actor.z;
        actor.prevY = actor.y;
        actor.prevHeading = actor.heading;
        actor._sweep = false;
      }
      if (actor) actor._wasPlaced = actor.placed !== false;
    }
    stats.dt = Number.isFinite(dt) ? dt : 0;
    return { movedActors, stats };
  }

  const spawnCandidates = [];
  /**
   * True when a body of `mode` placed at (x, z) facing `heading` overlaps no static solid (with `margin` m to spare): the spawn test
   * of the simulations, so a vehicle never appears inside a parked car or a wall.
   */
  function clearOfStatics(x, z, { heading = 0, mode = 'person', radius = 0.3, spec = null, y = null, margin = 0.1 } = {}) {
    if (!staticIndex) return true;
    const body = collisionBody(mode, radius, heading, margin, spec);
    const ground = Number.isFinite(y) ? y : groundAt({ x, z, y: NaN });
    const reach = Math.max(body.extX, body.extZ) + Math.abs(body.offsetForward || 0) + 0.5;
    const nearby = staticIndex.query(x, z, reach, spawnCandidates);
    for (let i = 0; i < nearby.length; i++) if (buildingContact(nearby[i], x, ground, z, body, null)) return false;
    return true;
  }

  const lineCandidates = [];
  const lineBody = collisionBody('person', 0.36, 0);
  const probe = { x: 0, z: 0, y: NaN };
  /**
   * Metres of the walking line a-b (sampled every `step` m) where a person (0.31 m body + 5 cm) would touch a static solid: the
   * pedestrian routes (js/pedestrian-routes.js) move a line that runs through bike racks, trees or benches to a clearer one.
   */
  function obstructedLength(ax, az, bx, bz, step = 1) {
    if (!staticIndex) return 0;
    const len = hypot(bx - ax, bz - az);
    const nearby = staticIndex.query((ax + bx) / 2, (az + bz) / 2, len / 2 + 1, lineCandidates);
    if (!nearby.length) return 0;
    const reach = lineBody.radius;
    let blocked = 0;
    for (let s = 0; s <= len; s += step) {
      const t = len > 0 ? s / len : 0;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      probe.x = x; probe.z = z;
      const y = groundAt(probe);
      for (let i = 0; i < nearby.length; i++) {
        const c = nearby[i];
        if (c.maxX < x - reach || c.minX > x + reach || c.maxZ < z - reach || c.minZ > z + reach) continue;
        if (buildingContact(c, x, y, z, lineBody, null)) { blocked += step; break; }
      }
    }
    return blocked;
  }

  return { resolve, stats, movedActors, clearOfStatics, obstructedLength, setObserver(next) { observer = next || null; } };
}
