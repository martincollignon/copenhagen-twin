import { bodyContact, buildingContact, collisionBody } from './collision-shapes.js';

const CELL = 8;
const CELL_COORD_OFFSET = 32768;
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

function inverseMass(actor) {
  if (Number.isFinite(actor.inverseMass)) return Math.max(0, actor.inverseMass);
  const mass = Number.isFinite(actor.mass) ? actor.mass : 70;
  return 1 / Math.max(1, mass);
}

/**
 * Shared moving-body and static-solid contact stage. Actor records are stable adapters owned by their simulations;
 * a `move(dx,dz)` adapter must commit the correction back to its route or controller state.
 */
export function createCityCollisions({ staticIndex = null, groundHeight = null } = {}) {
  const cells = new Map();
  const cellPool = [];
  const pairKeys = new Set();
  const pairList = [];
  const staticCandidates = [];
  const contact = { nx: 0, nz: 0, depth: 0 };
  const pairContact = { nx: 0, nz: 0, depth: 0 };
  const savedA = new Float64Array(10);
  const savedB = new Float64Array(10);
  const va = { x: 0, z: 0 };
  const vb = { x: 0, z: 0 };
  const movedActors = [];
  let cellPoolUsed = 0;
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
    cellPoolUsed = 0;
    for (const list of cells.values()) list.length = 0;
    cells.clear();
    pairKeys.clear();
    pairList.length = 0;
  }

  function addCell(ix, iz, index) {
    const key = (ix >= -CELL_COORD_OFFSET && ix < CELL_COORD_OFFSET && iz >= -CELL_COORD_OFFSET && iz < CELL_COORD_OFFSET)
      ? (ix + CELL_COORD_OFFSET) * 65536 + iz + CELL_COORD_OFFSET
      : `${ix}:${iz}`;
    let list = cells.get(key);
    if (!list) {
      list = cellPool[cellPoolUsed] || (cellPool[cellPoolUsed] = []);
      list.length = 0;
      cellPoolUsed++;
      cells.set(key, list);
    }
    for (const other of list) {
      const lo = Math.min(index, other), hi = Math.max(index, other);
      const pair = lo * 65536 + hi;
      if (!pairKeys.has(pair)) {
        pairKeys.add(pair);
        pairList.push(pair);
      }
    }
    list.push(index);
  }

  function prepareActors(actors) {
    for (const actor of actors) {
      if (!actor || actor.active === false || actor.placed === false || !Number.isFinite(actor.x) || !Number.isFinite(actor.z)) continue;
      configureBody(actor);
      actor.y = groundAt(actor);
      const dx = Number.isFinite(actor.prevX) ? actor.x - actor.prevX : 0;
      const dz = Number.isFinite(actor.prevZ) ? actor.z - actor.prevZ : 0;
      const distance = Math.hypot(dx, dz);
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
        ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * Math.hypot(actor.hx, actor.hz) : 0;
      actor._sweep = distance >= 0.05 || angularTravel >= 0.05;
    }
  }

  function cellBounds(actor) {
    const offset = Math.abs(actor.offsetForward || 0);
    const radiusX = actor._sweep && actor.oriented ? Math.hypot(actor.hx, actor.hz) : actor.extX;
    const radiusZ = actor._sweep && actor.oriented ? Math.hypot(actor.hx, actor.hz) : actor.extZ;
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
    stats.candidatePairs = pairKeys.size;
  }

  function refreshSweepsAfterStatics(actors) {
    for (const actor of actors) {
      if (!actor || actor.active === false || actor.placed === false) continue;
      const dx = actor.x - actor.prevX, dz = actor.z - actor.prevZ;
      const distance = Math.hypot(dx, dz);
      if (actor._wasPlaced === false || actor.sweep === false || !Number.isFinite(distance) || distance >= MAX_SWEEP_TRAVEL) {
        actor.prevX = actor.x;
        actor.prevY = actor.y;
        actor.prevZ = actor.z;
        actor._sweep = false;
        continue;
      }
      const angularTravel = Number.isFinite(actor.prevHeading) && actor.oriented
        ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * Math.hypot(actor.hx, actor.hz) : 0;
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
    const ax = (a.oriented ? Math.hypot(a.hx, a.hz) : a.radius) + Math.abs(a.offsetForward || 0);
    const bx = (b.oriented ? Math.hypot(b.hx, b.hz) : b.radius) + Math.abs(b.offsetForward || 0);
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
    const rotationTravel = (actor) => actor.oriented && Number.isFinite(actor.prevHeading)
      ? Math.abs(headingDelta(actor.prevHeading, actor.heading)) * Math.hypot(actor.hx, actor.hz) : 0;
    const travel = Math.max(Math.hypot(daX, daZ), Math.hypot(dbX, dbZ), rotationTravel(a), rotationTravel(b));
    if (travel < 0.05) return false;
    const halfWidth = (actor) => actor.oriented ? Math.min(actor.hx, actor.hz) : actor.radius;
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
      const clip = (actor) => {
        const x = actor.prevX + (actor.x - actor.prevX) * toi;
        const z = actor.prevZ + (actor.z - actor.prevZ) * toi;
        translate(actor, x - actor.x, z - actor.z);
      };
      clip(a); clip(b);
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

  function solveStatics(actor) {
    if (!staticIndex || actor.active === false || actor.placed === false) return false;
    let moved = false;
    const reach = Math.max(actor.extX, actor.extZ) + Math.abs(actor.offsetForward || 0) + 0.5;
    for (let pass = 0; pass < 3; pass++) {
      stats.staticQueries++;
      const nearby = staticIndex.query(actor.x, actor.z, reach, staticCandidates);
      let hit = false;
      for (const collider of nearby) {
        if (!buildingContact(collider, actor.x, actor.y, actor.z, actor, contact)) continue;
        stats.staticContacts++;
        hit = moved = true;
        translate(actor, contact.nx * Math.min(contact.depth + 0.002, 24), contact.nz * Math.min(contact.depth + 0.002, 24));
        actorVelocity(actor, va);
        const incoming = va.x * contact.nx + va.z * contact.nz;
        if (incoming < 0) applyVelocity(actor, -incoming * contact.nx, -incoming * contact.nz);
        if (typeof actor.onStaticContact === 'function') actor.onStaticContact(collider, contact.nx, contact.nz, incoming);
      }
      if (!hit) break;
    }
    return moved;
  }

  function resolve(actors, { dt = 0 } = {}) {
    stats.candidatePairs = stats.contacts = stats.staticQueries = stats.staticContacts = 0;
    stats.broadphaseBuilds = stats.sweepQueries = stats.sweepSamples = 0;
    movedActors.length = 0;
    prepareActors(actors);
    for (const actor of actors) solveStatics(actor);
    refreshSweepsAfterStatics(actors);
    broadphase(actors);
    let maxCandidates = pairList.length;
    for (let pass = 0; pass < PAIR_PASSES; pass++) {
      let any = false;
      for (const key of pairList) {
        const i = Math.floor(key / 65536), j = key % 65536;
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
        maxCandidates = Math.max(maxCandidates, pairList.length);
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

  return { resolve, stats, movedActors };
}
