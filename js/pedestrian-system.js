import { createPedestrianRoutes } from './pedestrian-routes.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';

// Local pedestrian population: connected walks, curb queues, conversations and player avoidance.
// Traffic supplies crossing permissions and view checks; this system owns the crowd and its animation.
const NUM_PEDS = 340;
const PED_RADIUS = 320;
const NEAR_RADIUS = 350;
const PED_SPAWN_DISTANCE = 150;
const PED_AVOID_INTERVAL = 0.12;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function createPedestrianSystem(network, { player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView, blockAt, groundHeight = null }) {
  let clock = 0;
  let focusX = 0, focusZ = 140;
  let hasView = false;
  let pedRange = 0;
  let pedCursor = 0;

  for (const n of network.nodes) {
    n.walkers = []; // pedestrians on its crosswalks
    n.curb = []; // pedestrians at or approaching its curbs
  }

  // One instanced draw per level of detail; every pedestrian has a PersonRig that plants its footsteps on the
  // sidewalk (no sliding), with their own build, height, sex, hair, clothes and gait
  const pedCrowd = new PersonCrowd(NUM_PEDS);
  const hash = (i, salt) => {
    const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const peds = [];
  for (let i = 0; i < NUM_PEDS; i++) {
    const female = hash(i, 1) < 0.48;
    const hairRoll = hash(i, 2);
    peds.push({
      placed: false,
      crossesStreets: i % 6 === 0, // some start near crossings; everyone can use them along their route
      x: 0,
      z: 0,
      prevX: 0,
      prevZ: 0,
      contactX: 0,
      contactZ: 0,
      ax: 0, // track: start, direction, length; position along it and walking direction
      az: 0,
      ux: 0,
      uz: 1,
      len: 1,
      t: 0,
      dir: 1,
      node: null, // the intersection of its crosswalk, which side of it, where along it
      side: 0,
      coord: 0,
      line: 0, // its line over the crosswalk, off the centre line
      waiting: false,
      speed: 1.22 + (i % 5) * 0.1 + hash(i, 3) * 0.08, // preferred walking speed
      v: 0, // current speed, easing up to it and down to stops
      pause: 0,
      route: null,
      nextRoute: null,
      nextLeg: 0,
      goalX: 0,
      goalZ: 0,
      goalTime: 0,
      restTime: 0,
      socialTime: 0,
      conversation: null,
      avoidUntil: 0,
      avoidCheck: 0,
      avoidSpeed: 0,
      avoidT: 0,
      resumeDir: 0,
      rig: new PersonRig({
        seed: i * 1.6180339 + 0.13,
        female,
        scale: (female ? 0.91 : 0.97) + hash(i, 4) * 0.1,
        girth: 0.9 + hash(i, 5) * 0.24,
        hair: female ? (hairRoll < 0.68 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
        armSwing: 0.75 + hash(i, 6) * 0.5,
        stride: 0.94 + hash(i, 7) * 0.12
      })
    });
  }

  const KERB = 1.6; // how far along a crosswalk track pedestrians wait to cross (the curb is 2 m along)
  const pedRoutes = createPedestrianRoutes(network, blockAt);
  const track = { ax: 0, az: 0, ux: 0, uz: 1, len: 1, node: null, side: 0, line: 0, route: null };

  function sidewalkTrack(e) {
    const choices = pedRoutes.along(e);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  function crosswalkTrack(n) {
    const choices = pedRoutes.across(n);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  // Who is at (or just past) the curbs of each intersection's crosswalks, for whoever comes up behind to queue
  const QUEUE_GAP = 0.62; // m from one person standing in a queue to the next
  const curbNodes = [];
  const curbProgress = (p) => (p.dir > 0 ? p.t : p.len - p.t); // m along its way over (the curb it waits at is KERB)
  function atCurb(p) {
    const crossing = !p.node && p.nextRoute?.find((leg, i) => i >= p.nextLeg && leg.track.node);
    const n = p.node || crossing?.track.node;
    if (!n || (p.node && curbProgress(p) > KERB + 0.5) || n.curb.includes(p)) return;
    if (!n.curb.length) curbNodes.push(n);
    n.curb.push(p);
  }
  function gatherCurbs() {
    for (const n of curbNodes) n.curb.length = 0;
    curbNodes.length = 0;
    for (const p of peds) if (p.placed) atCurb(p);
  }

  // Try crosswalks first for crossing pedestrians, then fall back to sidewalks if no suitable crossing fits.
  function spawnPed(p, rMin, rMax, protectView) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const crosswalk = p.crossesStreets && nearSignals.length > 0 && attempt < 5;
      const ok = crosswalk
        ? crosswalkTrack(nearSignals[Math.floor(Math.random() * nearSignals.length)])
        : nearEdges.length > 0 && sidewalkTrack(nearEdges[Math.floor(Math.random() * nearEdges.length)]);
      if (!ok) continue;
      const along = (focusX - track.ax) * track.ux + (focusZ - track.az) * track.uz;
      const minT = Math.max(0, along - rMax), maxT = Math.min(track.len, along + rMax);
      if (minT > maxT) continue;
      const t = crosswalk ? (Math.random() < 0.5 ? Math.random() * KERB : track.len - Math.random() * KERB) : minT + Math.random() * (maxT - minT);
      const x = track.ax + track.ux * t;
      const z = track.az + track.uz * t;
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, 2, PED_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 10) continue;
      if (crosswalk && track.node.curb.some((q) => Math.hypot(q.x - x, q.z - z) < QUEUE_GAP)) continue;
      if (p.conversation) endConversation(p.conversation);
      Object.assign(p, track);
      p.t = t;
      p.dir = t < track.len * 0.5 ? 1 : -1;
      p.x = x;
      p.z = z;
      p.prevX = x;
      p.prevZ = z;
      p.contactX = 0;
      p.contactZ = 0;
      p.v = crosswalk ? 0 : p.speed;
      p.pause = 0;
      p.avoidUntil = 0;
      p.resumeDir = 0;
      p.avoidCheck = clock + Math.random() * PED_AVOID_INTERVAL;
      p.nextRoute = null;
      p.nextLeg = 0;
      p.goalTime = 0;
      p.restTime = clock + 25 + Math.random() * 45;
      p.socialTime = clock + 5 + Math.random() * 15;
      p.rig.placed = false; // stands afresh where it now is
      p.placed = true;
      if (crosswalk) atCurb(p);
      return true;
    }
    return false;
  }

  // Continue through validated sidewalk corners. Crossing tracks retain their curb queues and right of way;
  // only a dead end needs a turnaround. Goals guide local choices without a city-wide path search.
  const PED_ACCEL = 1.3; // m/s^2 setting off
  const PED_BRAKE = 1.6; // m/s^2 easing to a stop
  const TURN_TIME = 0.85; // s turning round at the end of the track
  const PED_ESCAPE_SPEED = 3.4;
  const PED_ESCAPE_ACCEL = 5;
  const PED_ESCAPE_BRAKE = 6;
  const PED_LOOKAHEAD = 1.5;

  // Limit an escape to the current validated track, respecting curbs and people in either direction.
  // Only threatened pedestrians do this local scan, at most once every 120 ms.
  function escapeRoom(p, dir) {
    let room = dir > 0 ? p.len - p.t : p.t;
    const s = dir > 0 ? p.t : p.len - p.t;
    if (p.node && s <= KERB && !mayCross(p)) room = Math.min(room, KERB - s);
    for (const q of peds) {
      if (q === p || !q.placed) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const forward = (dx * p.ux + dz * p.uz) * dir;
      if (forward <= 0 || forward > Math.min(room + QUEUE_GAP, 6)) continue;
      const side = dx * p.uz - dz * p.ux;
      if (Math.abs(side) < QUEUE_GAP) room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - side * side)));
    }
    return room;
  }

  // Sweep the pedestrian against the player's oriented footprint. Short linear segments account for braking,
  // acceleration and track ends without missing fast vehicles between samples or allocating temporary vectors.
  function playerContactTime(p, speed, room, emergency = true) {
    const dir = speed < 0 ? -1 : speed > 0 ? 1 : p.dir;
    let v = dir === p.dir ? p.v * p.dir : 0;
    let moved = 0;
    const dx = p.x - player.x, dz = p.z - player.z;
    let x = dx * player.fz - dz * player.fx, z = dx * player.fx + dz * player.fz;
    const ux = p.ux * player.fz - p.uz * player.fx, uz = p.ux * player.fx + p.uz * player.fz;
    const vx = player.vx * player.fz - player.vz * player.fx, vz = player.vx * player.fx + player.vz * player.fz;
    const acceleration = emergency ? PED_ESCAPE_ACCEL : PED_ACCEL;
    const braking = emergency ? PED_ESCAPE_BRAKE : 2 * PED_BRAKE;
    const step = 0.25;
    for (let time = 0; time < PED_LOOKAHEAD; time += step) {
      const rate = Math.abs(speed) > Math.abs(v) ? acceleration : braking;
      const nextV = v + clamp(speed - v, -rate * step, rate * step);
      const distance = Math.min(room - moved, Math.abs((v + nextV) * 0.5 * step));
      moved += distance;
      const sx = ux * dir * distance - vx * step, sz = uz * dir * distance - vz * step;
      let enter = 0, exit = 1;
      for (let axis = 0; axis < 2; axis++) {
        const pos = axis ? z : x, delta = axis ? sz : sx;
        const extent = (axis ? player.halfL : player.halfW) + 0.45;
        if (Math.abs(delta) < 1e-6) {
          if (Math.abs(pos) > extent) { exit = -1; break; }
        } else {
          const a = (-extent - pos) / delta, b = (extent - pos) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter <= exit) return time + enter * step;
      x += sx; z += sz; v = nextV;
    }
    return Infinity;
  }

  function turnPed(p, dir) {
    p.dir = dir;
    p.v = 0;
    p.nextRoute = null;
    p.nextLeg = 0;
    p.waiting = false;
  }

  function avoidPlayer(p) {
    // A retreat is temporary: once clear, turn back toward the original destination instead of walking into
    // the people behind. Corner transitions below discard this old direction along with the escape boundary.
    if (p.resumeDir && (clock >= p.avoidUntil || !pedRange)) {
      if (p.dir !== p.resumeDir) {
        turnPed(p, p.resumeDir);
        p.pause = TURN_TIME;
      }
      p.resumeDir = 0;
      p.avoidCheck = 0;
    }
    if (!pedRange) { p.avoidUntil = 0; return; }
    const dx = p.x - player.x, dz = p.z - player.z;
    if (dx * dx + dz * dz > pedRange * pedRange || clock < p.avoidCheck) return;
    p.avoidCheck = clock + PED_AVOID_INTERVAL;
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    const normalSpeed = p.pause > 0 || p.conversation || p.waiting ? 0 : p.speed;
    const normalRoom = p.node && curbProgress(p) <= KERB && !mayCross(p) ? KERB - curbProgress(p) : ahead;
    const avoiding = clock < p.avoidUntil;
    const escapeAhead = Math.max(0, Math.min(ahead, (p.avoidT - p.t) * p.dir));
    if (playerContactTime(p, p.dir * normalSpeed, normalRoom, false) === Infinity
      && (!avoiding || playerContactTime(p, p.dir * p.avoidSpeed, escapeAhead) === Infinity)) return;

    const forward = escapeRoom(p, p.dir);
    const stop = playerContactTime(p, 0, forward);
    const inRoad = p.node && p.t > 2 && p.t < p.len - 2;
    let dir = p.dir, speed = 0, room = forward;
    if ((inRoad && player.vx * player.vx + player.vz * player.vz > 1) || stop !== Infinity) {
      speed = PED_ESCAPE_SPEED;
      let best = playerContactTime(p, dir * speed, forward);
      // Corner connectors need their pending route; only full sidewalk/crosswalk tracks can turn around.
      if (p.node || p.route?.edge) {
        const back = escapeRoom(p, -dir);
        const retreat = playerContactTime(p, -dir * speed, back);
        if (retreat > best + (avoiding ? 0.2 : 0)
          || (!avoiding && retreat === Infinity && inRoad && ahead > p.len * 0.5)) {
          dir = -dir; room = back; best = retreat;
        }
      }
      if (stop > best) { dir = p.dir; speed = 0; room = forward; }
    }
    if (p.conversation) endConversation(p.conversation);
    if (!p.resumeDir) p.resumeDir = p.dir;
    if (dir !== p.dir) turnPed(p, dir);
    p.pause = 0;
    p.avoidSpeed = speed;
    p.avoidT = p.t + dir * room;
    p.avoidUntil = clock + 0.6;
    p.restTime = Math.max(p.restTime, clock + 5);
    p.socialTime = Math.max(p.socialTime, clock + 5);
  }

  const walkedNodes = [];
  function walk(p, dt) {
    const avoiding = clock < p.avoidUntil;
    const brake = avoiding ? PED_ESCAPE_BRAKE : PED_BRAKE;
    if (p.pause > 0) p.pause = Math.max(0, p.pause - dt);
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    if (clock >= p.goalTime || Math.hypot(p.x - p.goalX, p.z - p.goalZ) < 25) {
      const destination = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      p.goalX = destination ? destination.sx + destination.dx * destination.len * 0.5 : p.x;
      p.goalZ = destination ? destination.sz + destination.dz * destination.len * 0.5 : p.z;
      p.goalTime = clock + 120 + Math.random() * 180;
    }
    if (!p.nextRoute && p.route && ahead < 4) {
      p.nextRoute = pedRoutes.next(p.route, p.dir, p.goalX, p.goalZ);
      p.nextLeg = 0;
      if (!p.node && p.nextRoute) atCurb(p);
    }
    if (!p.node && p.route?.edge && p.t > 6 && p.t < p.len - 6 && clock >= p.restTime) {
      p.pause = 1.5 + Math.random() * 3;
      p.restTime = clock + 35 + Math.random() * 55;
    }
    let vMax = avoiding ? p.avoidSpeed : p.pause > 0 || p.conversation ? 0 : p.speed;
    if (!p.nextRoute) vMax = Math.min(vMax, Math.sqrt(2 * brake * ahead));
    let room = Infinity;
    if (!p.node && p.nextRoute) {
      // A queue can reach back onto the sidewalk. Keep clear before entering its track, including short corner
      // segments; actual separation matters where the approach meets the crossing at an angle.
      const crossing = p.nextRoute.find((leg, i) => i >= p.nextLeg && leg.track.node);
      if (crossing) {
        const entranceX = crossing.track.ax + (crossing.dir < 0 ? crossing.track.ux * crossing.track.len : 0);
        const entranceZ = crossing.track.az + (crossing.dir < 0 ? crossing.track.uz * crossing.track.len : 0);
        let leader = null, nearest = Infinity;
        for (const q of crossing.track.node.curb) {
          const next = !q.node && q.nextRoute?.find((leg, i) => i >= q.nextLeg && leg.track.node);
          const queued = q.node ? q : next?.track;
          if (!queued || queued.node !== crossing.track.node || queued.side !== crossing.track.side || (q.node ? q.dir : next.dir) !== crossing.dir || Math.abs(queued.line - crossing.track.line) > 0.55) continue;
          const distance = Math.hypot(q.x - entranceX, q.z - entranceZ);
          if (!q.node && distance < nearest) { leader = q; nearest = distance; }
          if (q === p) continue;
          const dx = q.x - p.x, dz = q.z - p.z;
          const forward = (dx * p.ux + dz * p.uz) * p.dir;
          const lateral2 = Math.max(0, dx * dx + dz * dz - forward * forward);
          if (forward >= 0 && lateral2 < QUEUE_GAP * QUEUE_GAP) {
            room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - lateral2)));
          }
        }
        if (leader && leader !== p) {
          // The closest arrival merges first. Keep other approaches outside its remaining walking lines,
          // so perpendicular queues cannot trap each other at the entrance after WALK turns green.
          const yieldToLine = (line) => {
            const side = (p.x - line.ax) * line.uz - (p.z - line.az) * line.ux;
            const toward = (p.ux * line.uz - p.uz * line.ux) * p.dir;
            if (side * toward < 0) room = Math.min(room, Math.max(0, (Math.abs(side) - QUEUE_GAP - 0.01) / Math.abs(toward)));
          };
          yieldToLine(leader);
          for (let i = leader.nextLeg; i < leader.nextRoute.length; i++) {
            yieldToLine(leader.nextRoute[i].track);
            if (leader.nextRoute[i].track.node) break;
          }
        }
      }
    }
    if (p.node) {
      // room to walk before standing: up to the curb unless p may cross, and up to the back of whoever is ahead
      const s = curbProgress(p);
      room = s <= KERB && !mayCross(p) ? KERB - s : Infinity;
      for (const q of p.node.curb) {
        if (q === p || q.node !== p.node || q.side !== p.side || q.dir !== p.dir || Math.abs(q.line - p.line) > 0.55) continue;
        const gap = curbProgress(q) - s;
        if (gap > 0) room = Math.min(room, Math.max(0, gap - QUEUE_GAP));
      }
    }
    if (avoiding) room = Math.min(room, Math.max(0, (p.avoidT - p.t) * p.dir));
    vMax = Math.min(vMax, Math.sqrt(2 * brake * room));
    p.v += clamp(vMax - p.v, -(avoiding ? brake : 2 * brake) * dt, (avoiding ? PED_ESCAPE_ACCEL : PED_ACCEL) * dt);
    const movement = Math.min(p.v * dt, room);
    if (p.v * dt > room) p.v = 0;
    let t = p.t + p.dir * movement;
    const reachesCurb = !!p.node && curbProgress(p) <= KERB && (p.dir > 0 ? t : p.len - t) >= KERB - 1e-6;
    p.waiting = reachesCurb && !mayCross(p);
    if (p.waiting) {
      t = p.dir > 0 ? Math.min(t, KERB) : Math.max(t, p.len - KERB);
      p.v = 0;
    }
    if (p.dir > 0 ? t >= p.len : t <= 0) {
      t = p.dir > 0 ? p.len : 0;
      if (p.nextRoute) {
        p.avoidUntil = 0;
        p.resumeDir = 0;
        p.avoidCheck = 0;
        const leg = p.nextRoute[p.nextLeg++];
        Object.assign(p, leg.track);
        p.route = leg.track;
        p.dir = leg.dir;
        t = p.dir > 0 ? 0 : p.len;
        p.t = t;
        if (p.node) atCurb(p); // later arrivals this frame must see the newly occupied entrance
        if (p.nextLeg === p.nextRoute.length) p.nextRoute = null;
      } else if (!avoiding) {
        p.dir = -p.dir;
        p.v = 0;
        p.pause = TURN_TIME;
      }
    }
    p.t = t;
    p.x = p.ax + p.ux * t + p.contactX;
    p.z = p.az + p.uz * t + p.contactZ;
    if (p.node && ((t > KERB && t < p.len - KERB) || (p.waiting && walkOn(p.side, p.node)))) {
      p.coord = p.clx !== undefined ? p.x * p.clx + p.z * p.clz : p.side >= 2 ? p.x : p.z;
      if (!p.node.walkers.length) walkedNodes.push(p.node);
      p.node.walkers.push(p);
    }
  }

  function endConversation(conversation) {
    for (const p of [conversation.a, conversation.b]) {
      p.conversation = null;
      p.socialTime = clock + 30 + Math.random() * 60;
    }
    conversation.remaining = 0;
  }

  const meetingCells = new Map();
  let nextMeeting = 0;
  function meet(dt) {
    for (const p of peds) {
      const conversation = p.conversation;
      if (!conversation || conversation.a !== p) continue;
      conversation.remaining -= dt;
      if (conversation.remaining <= 0) endConversation(conversation);
    }
    if (clock < nextMeeting) return;
    nextMeeting = clock + 1;
    meetingCells.clear();
    for (const p of peds) {
      if (!p.placed || p.node || !p.route?.edge || p.conversation || clock < p.socialTime || p.t < 6 || p.t > p.len - 6) continue;
      const ix = Math.floor(p.x / 2), iz = Math.floor(p.z / 2);
      let partner = null;
      for (let dx = -1; dx <= 1 && !partner; dx++) {
        for (let dz = -1; dz <= 1 && !partner; dz++) {
          for (const q of meetingCells.get(`${ix + dx}:${iz + dz}`) || []) {
            const distance = Math.hypot(p.x - q.x, p.z - q.z);
            if (q.conversation || p.route.block !== q.route.block || distance < 0.75 || distance > 2 || Math.random() > 0.15) continue;
            partner = q;
            break;
          }
        }
      }
      if (partner) {
        p.conversation = partner.conversation = { a: p, b: partner, remaining: 6 + Math.random() * 6 };
        p.v = partner.v = 0;
      } else {
        const key = `${ix}:${iz}`;
        if (!meetingCells.has(key)) meetingCells.set(key, []);
        meetingCells.get(key).push(p);
      }
    }
  }

  // Walking surface around a pedestrian: sidewalks are 0.22 m above the road, and crosswalk tracks start and end
  // with 2 m of sidewalk (the rig steps down and up the curbs)
  const SIDEWALK_Y = 0.22;
  const CROSSWALK_Y = 0.012;
  function pedGround(p, x, z) {
    if (groundHeight) return groundHeight.heightAt(x, z); // the street surface model: pavement 0.20, carriageway 0.02
    if (!p.node) return SIDEWALK_Y;
    const t = (x - p.ax) * p.ux + (z - p.az) * p.uz;
    return t > 2 && t < p.len - 2 ? CROSSWALK_Y : SIDEWALK_Y;
  }

  // Every rig's gait advances every frame; only those the camera may see (or whose shadow it may see) solve their
  // bone transforms and are drawn, the far ones with the light LOD.
  function renderPed(p, dt) {
    const draw = !hasView || visible(p.x, p.z, 7);
    const partner = p.conversation && (p.conversation.a === p ? p.conversation.b : p.conversation.a);
    const heading = partner ? Math.atan2(partner.x - p.x, partner.z - p.z) : Math.atan2(p.ux * p.dir, p.uz * p.dir);
    p.rig.update(dt, p.x, p.z, heading, pedGround, p, 0, draw);
    if (!draw) return;
    pedCrowd.add(p.rig, Math.hypot(p.x - focusX, p.z - focusZ));
  }

  function simulate(dt, elapsed, x, z, jump, view, activeMode) {
    clock = elapsed;
    focusX = x;
    focusZ = z;
    hasView = view;
    pedRange = player.active && (activeMode === 'car' || activeMode === 'cyclist' || activeMode === 'cargobike') && player.entity.position.y > -1
      ? Math.hypot(player.vx, player.vz) * PED_LOOKAHEAD + player.halfL + 6 : 0;

    for (const n of walkedNodes) n.walkers.length = 0;
    walkedNodes.length = 0;
    let pedBudget = jump ? NUM_PEDS : 6;
    for (let scanned = 0; scanned < NUM_PEDS && pedBudget > 0; scanned++) {
      const p = peds[pedCursor];
      pedCursor = (pedCursor + 1) % NUM_PEDS;
      const d = p.placed ? Math.hypot(p.x - focusX, p.z - focusZ) : Infinity;
      if (d <= (jump ? NEAR_RADIUS : PED_RADIUS)) continue;
      pedBudget--;
      spawnPed(p, jump ? 0 : 60, jump ? NEAR_RADIUS : 280, !jump);
    }
    for (const p of peds) if (p.placed) avoidPlayer(p);
    meet(dt);
    gatherCurbs();
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (!p.placed) continue;
      p.prevX = p.x;
      p.prevZ = p.z;
      walk(p, dt);
    }
  }

  function render(dt) {
    pedCrowd.begin();
    for (const p of peds) if (p.placed) renderPed(p, dt);
    pedCrowd.end();
  }

  function update(dt, elapsed, x, z, jump, view, activeMode) {
    simulate(dt, elapsed, x, z, jump, view, activeMode);
    render(dt);
  }

  return { peds, meshes: pedCrowd.meshes, simulate, render, update };
}

export { createPedestrianSystem };
