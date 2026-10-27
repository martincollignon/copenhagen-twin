// tools/collision-probe.js: the browser half of `tools/check-collisions.py --survey` and its city cases. Evaluated in a page booted with
// ?hooks; installs globalThis.__collisionProbe. Not loaded by the app.
//
// The probe stops the animation loop and steps the real systems itself (controllers, camera, traffic with its collision phase,
// world streaming) at a fixed dt, so a spot is measured on the same simulated time in every run. Rendering is skipped.
(() => {
  const twin = globalThis.__twin;
  if (!twin) throw new Error('window.__twin was not exposed by ?hooks');
  const world = twin.world, controller = twin.controllerManager, cameras = twin.cameraSystem;
  const stage = world.collisions, traffic = world.trafficSystem;
  const index = world.staticIndex || null;
  let elapsed = 1000;
  let frozen = false;
  let shapes = null;
  const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));
  const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] : 0;
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
    return { n: sorted.length, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0, mean };
  };

  function freeze() {
    if (frozen) return;
    twin.renderer.setAnimationLoop(null);
    frozen = true;
  }

  function step(dt) {
    elapsed += dt;
    controller.update(dt, elapsed);
    cameras.update(dt, elapsed);
    traffic.update(dt, elapsed, cameras.currentPos, controller.getActiveEntity(), controller.activeMode, cameras.camera);
    world.update(cameras.currentPos.x, cameras.currentPos.z, 0);
  }

  const colliders = () => world.staticIndex ? world.staticIndex.all() : (world.colliders || []);
  const query = (x, z, r, out = []) => {
    if (index) return index.query(x, z, r, out);
    out.length = 0;
    for (const c of world.colliders || []) if (!(c.maxX < x - r || c.minX > x + r || c.maxZ < z - r || c.minZ > z + r)) out.push(c);
    return out;
  };

  /** Teleports the player (mode) to a spot, streams the tiles and the agent region in, then warms the agents for `warm` ticks. */
  async function goto({ x, z, heading = 0, mode = 'person', warm = 600, dt = 1 / 60 }) {
    freeze();
    shapes ||= await import('/js/collision-shapes.js');
    controller.setMode(mode, { preserveSwanPosition: true });
    controller.teleportActiveTo(x, z, heading);
    cameras.resetForTeleport?.();
    const t0 = performance.now();
    for (let i = 0; i < 4000; i++) {
      step(dt);
      if (i % 4 === 0) await yieldNow();
      if (world.stream && i % 20 === 0) await world.stream.settle(x, z, { timeout: 120000 });
      const region = world.agents?.region;
      const centred = !world.agents || (region && Math.hypot(region.cx - x, region.cz - z) < 200 && !world.agents.building);
      if (centred && i > 30) break;
    }
    // the colliders of the destination arrived after the first placement: place the player again against them
    controller.teleportActiveTo(x, z, heading);
    cameras.resetForTeleport?.();
    for (let i = 0; i < warm; i++) {
      step(dt);
      if (i % 30 === 0) await yieldNow();
    }
    const player = controller.getActiveEntity().position;
    return { streamMs: performance.now() - t0, player: { x: player.x, z: player.z }, region: world.agents?.region ? { cx: world.agents.region.cx, cz: world.agents.region.cz } : null };
  }

  const kindOf = (a) => a.kind === 'player'
    ? (a.entity === controller.getActiveEntity() ? `player-${a.mode}` : 'parked-player')
    : a.kind === 'cyclist' ? (a.mode === 'cargobike' ? 'cargobike' : 'cyclist') : a.kind;
  const classOf = (c) => c.type;
  const groupOf = (c) => c.type === 'building' ? 'building' : c.type === 'parked-car' ? 'parked-car' : 'furniture';
  const agentGroup = (kind) => kind.startsWith('player') ? 'player' : kind === 'parked-player' ? 'parked-player' : 'agent';
  const routePoint = (a) => {
    const e = a.entity;
    if ((a.kind === 'pedestrian' || a.kind === 'cyclist') && e && Number.isFinite(e.contactX)) return { x: a.x - e.contactX, z: a.z - e.contactZ };
    return null;
  };
  const centre = (c) => c.obb ? { x: c.obb.cx, z: c.obb.cz } : { x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2 };

  /**
   * Counts contacts per class pair and per-agent outcomes over `ticks` fixed steps: pushed off route, stuck, jittering, spawned inside
   * solids, and how often an agent's route point itself lies in a solid (the data, not the physics).
   */
  async function measure({ ticks = 600, dt = 1 / 60, stuckSeconds = 3, offRoute = 1, routeEvery = 10 } = {}) {
    freeze();
    shapes ||= await import('/js/collision-shapes.js');
    const staticHits = {}, pairHits = {}, staticByGroup = {}, agentFrames = {}, spawnInside = {}, routeInside = {}, routeSamples = {};
    const perCollider = new Map();
    // contact depth buckets (m): grazing touches vs real overlaps
    const EDGES = [0.01, 0.05, 0.2, Infinity];
    const depthStatic = [0, 0, 0, 0], depthPair = [0, 0, 0, 0];
    const pedPairs = {};
    const bucket = (h, d) => { for (let i = 0; i < EDGES.length; i++) if (d < EDGES[i]) { h[i]++; return; } };
    const state = new Map();
    let spawns = 0;
    const st = (a) => {
      let s = state.get(a);
      if (!s) state.set(a, (s = { kind: kindOf(a), frames: 0, staticFrames: 0, pairFrames: 0, streak: 0, maxStreak: 0, sx: 0, sz: 0,
        transitions: 0, reversals: 0, lastNx: 0, lastNz: 0, lastHitTick: -99, maxOffset: 0, stuck: false, spawnHits: 0,
        hit: false, pairHit: false, lastX: NaN, lastZ: NaN, spawn: false, routeIn: 0, routeTests: 0, classes: {} }));
      return s;
    };
    let tick = 0;
    stage.setObserver({
      static(actor, collider, contact) {
        const s = st(actor);
        const cls = classOf(collider);
        const key = `${s.kind}|${cls}`;
        staticHits[key] = (staticHits[key] || 0) + 1;
        bucket(depthStatic, contact.depth);
        const gkey = `${agentGroup(s.kind)}|${groupOf(collider)}`;
        staticByGroup[gkey] = (staticByGroup[gkey] || 0) + 1;
        s.classes[cls] = (s.classes[cls] || 0) + 1;
        if (s.spawn) {
          s.spawn = false;
          spawnInside[`${s.kind}|${cls}`] = (spawnInside[`${s.kind}|${cls}`] || 0) + 1;
        }
        if (!s.hit && tick - s.lastHitTick <= 3 && s.lastNx * contact.nx + s.lastNz * contact.nz < -0.5) s.reversals++;
        s.hit = true;
        s.lastNx = contact.nx; s.lastNz = contact.nz; s.lastHitTick = tick;
        let pc = perCollider.get(collider);
        if (!pc) perCollider.set(collider, (pc = { hits: 0, actors: new Set(), depth: 0 }));
        pc.hits++; pc.actors.add(actor); pc.depth = Math.max(pc.depth, contact.depth);
      },
      pair(a, b, contact) {
        const ka = st(a).kind, kb = st(b).kind;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        pairHits[key] = (pairHits[key] || 0) + 1;
        bucket(depthPair, contact.depth);
        st(a).pairHit = true; st(b).pairHit = true;
        if (a.kind === 'pedestrian' && b.kind === 'pedestrian') {
          const p = a.entity, q = b.entity;
          const why = p.conversation && p.conversation === q.conversation ? 'conversation'
            : p.node || q.node ? 'crossing'
              : (p.v < 0.05 || q.v < 0.05) ? 'one-standing'
                : p.ux * q.ux + p.uz * q.uz > 0.7 ? (p.dir === q.dir ? 'same-way' : 'head-on')
                  : p.ux * q.ux + p.uz * q.uz < -0.7 ? (p.dir === q.dir ? 'head-on' : 'same-way') : 'crossing-paths';
          pedPairs[why] = (pedPairs[why] || 0) + 1;
        }
      }
    });
    const original = stage.resolve;
    const times = [];
    const actorCounts = [];
    const tmp = { nx: 0, nz: 0, depth: 0 };
    const near = [];
    stage.resolve = (actors, options) => {
      for (const a of actors) {
        if (!a || a.placed === false || a.active === false) continue;
        const s = st(a);
        const jumped = Number.isFinite(s.lastX) && Math.hypot(a.x - s.lastX, a.z - s.lastZ) > 8;
        s.spawn = a._wasPlaced === false || jumped;
        if (s.spawn) spawns++;
        s.hit = false; s.pairHit = false;
      }
      const t0 = performance.now();
      const result = original(actors, options);
      times.push(performance.now() - t0);
      let placed = 0;
      for (const a of actors) {
        if (!a || a.placed === false || a.active === false) continue;
        placed++;
        const s = st(a);
        s.spawn = false;
        s.frames++;
        agentFrames[s.kind] = (agentFrames[s.kind] || 0) + 1;
        if (s.pairHit) s.pairFrames++;
        if (s.hit) {
          s.staticFrames++;
          if (s.streak === 0) { s.transitions++; s.sx = a.x; s.sz = a.z; }
          s.streak++;
          s.maxStreak = Math.max(s.maxStreak, s.streak);
          if (!s.stuck && s.streak * dt >= stuckSeconds && Math.hypot(a.x - s.sx, a.z - s.sz) < 0.5) s.stuck = true;
        } else s.streak = 0;
        const e = a.entity;
        if (e && Number.isFinite(e.contactX)) s.maxOffset = Math.max(s.maxOffset, Math.hypot(e.contactX, e.contactZ));
        s.lastX = a.x; s.lastZ = a.z;
        if (tick % routeEvery === 0) {
          const rp = routePoint(a);
          if (rp) {
            s.routeTests++;
            routeSamples[s.kind] = (routeSamples[s.kind] || 0) + 1;
            let inside = null;
            for (const c of query(rp.x, rp.z, 3, near)) {
              if (shapes.buildingContact(c, rp.x, a.y, rp.z, a, tmp)) { inside = c; break; }
            }
            if (inside) {
              s.routeIn++;
              const lane = a.kind === 'cyclist' && a.entity?.lane?.kind ? `:${a.entity.lane.kind}` : '';
              const key = `${s.kind}${lane}|${classOf(inside)}`;
              routeInside[key] = (routeInside[key] || 0) + 1;
            }
          }
        }
      }
      actorCounts.push(placed);
      return result;
    };
    try {
      for (tick = 0; tick < ticks; tick++) {
        step(dt);
        if (tick % 60 === 59) await yieldNow();
      }
    } finally {
      stage.resolve = original;
      stage.setObserver(null);
    }
    const agents = [...state.values()];
    const byKind = {};
    for (const s of agents) {
      if (!s.frames) continue;
      const k = (byKind[s.kind] ||= { actors: 0, frames: 0, staticFrames: 0, pairFrames: 0, withStatic: 0, offRoute: 0, stuck: 0, jitter: 0,
        persistent: 0, routeIn: 0, routeTests: 0 });
      k.actors++; k.frames += s.frames; k.staticFrames += s.staticFrames; k.pairFrames += s.pairFrames;
      if (s.staticFrames) k.withStatic++;
      if (s.maxOffset > offRoute) k.offRoute++;
      if (s.stuck) k.stuck++;
      // jitter: the contact keeps switching on and off (>= 1 per 2 s) or the push keeps reversing
      if (s.transitions >= Math.max(4, ticks * dt / 2) || s.reversals >= 3) k.jitter++;
      if (s.staticFrames >= 0.5 * s.frames && s.frames >= 60) k.persistent++;
      k.routeIn += s.routeIn; k.routeTests += s.routeTests;
    }
    const staticTotal = Object.values(staticHits).reduce((a, b) => a + b, 0);
    const pairTotal = Object.values(pairHits).reduce((a, b) => a + b, 0);
    const frames = Object.values(agentFrames).reduce((a, b) => a + b, 0);
    const agentOnly = (o) => Object.entries(o).filter(([k]) => !k.startsWith('player') && !k.startsWith('parked-player')).reduce((a, [, v]) => a + v, 0);
    const agentFramesOnly = agentOnly(agentFrames);
    const topColliders = [...perCollider.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, 20).map(([c, v]) => {
      const p = centre(c);
      return { id: c.id, type: c.type, x: +p.x.toFixed(2), z: +p.z.toFixed(2), hits: v.hits, actors: v.actors.size, maxDepth: +v.depth.toFixed(3) };
    });
    const worst = agents.filter((s) => s.frames).sort((a, b) => b.staticFrames - a.staticFrames).slice(0, 12).map((s) => ({
      kind: s.kind, frames: s.frames, staticFrames: s.staticFrames, maxStreak: s.maxStreak, transitions: s.transitions, reversals: s.reversals,
      maxOffset: +s.maxOffset.toFixed(2), stuck: s.stuck, routeIn: s.routeIn, routeTests: s.routeTests, classes: s.classes,
      at: { x: +s.lastX.toFixed(1), z: +s.lastZ.toFixed(1) } }));
    const timing = summary(times);
    return {
      ticks, dt, spawns, depthBuckets: { edges: ['<0.01', '<0.05', '<0.2', '>=0.2'], static: depthStatic, pair: depthPair }, staticHits, pairHits, pedPairs, staticByGroup, spawnInside, routeInside, routeSamples, agentFrames, byKind,
      totals: {
        staticContacts: staticTotal, pairContacts: pairTotal, agentFrames: frames,
        agentStaticPerAgentFrame: agentFramesOnly ? agentOnly(staticHits) / agentFramesOnly : 0,
        agentPairPerAgentFrame: agentFramesOnly ? Object.entries(pairHits).filter(([k]) => !k.includes('player')).reduce((a, [, v]) => a + v, 0) / agentFramesOnly : 0,
        contactsPerFrame: (staticTotal + pairTotal) / ticks,
        placedMedian: summary(actorCounts).median
      },
      resolveMs: timing,
      topColliders, worst
    };
  }

  /** Collision CPU per frame only (no observer): the stage's resolve time and its per-placed-agent share. */
  async function perf({ ticks = 600, dt = 1 / 60 } = {}) {
    freeze();
    const original = stage.resolve;
    const times = [], placed = [], queries = [], pairs = [];
    stage.resolve = (actors, options) => {
      const t0 = performance.now();
      const result = original(actors, options);
      times.push(performance.now() - t0);
      let n = 0;
      for (const a of actors) if (a && a.placed !== false && a.active !== false) n++;
      placed.push(n);
      queries.push(stage.stats.staticQueries);
      pairs.push(stage.stats.candidatePairs);
      return result;
    };
    try {
      for (let i = 0; i < ticks; i++) {
        step(dt);
        if (i % 60 === 59) await yieldNow();
      }
    } finally {
      stage.resolve = original;
    }
    const t = summary(times), n = summary(placed);
    return { resolveMs: t, placed: n, usPerAgent: n.median ? t.median * 1000 / n.median : 0, staticQueries: summary(queries), candidatePairs: summary(pairs) };
  }

  /** Steps `ticks` frames with nothing attached (the Python side samples the heap around it). */
  async function run({ ticks = 120, dt = 1 / 60 } = {}) {
    freeze();
    for (let i = 0; i < ticks; i++) {
      step(dt);
      if (i % 60 === 59) await yieldNow();
    }
    return { ticks };
  }

  /** The resident solids around a spot by type, and duplicates across tile parts (same type and centre within 2 cm). */
  function census({ x, z, radius = 150 }) {
    const all = colliders();
    const near = {}, dupes = {};
    const seen = new Map();
    for (const c of all) {
      const p = centre(c);
      if (Math.hypot(p.x - x, p.z - z) <= radius) near[c.type] = (near[c.type] || 0) + 1;
      const key = c.type === 'building' ? `${c.id}` : `${c.type}:${Math.round(p.x * 50)}:${Math.round(p.z * 50)}:${Math.round((c.minY || 0) * 50)}`;
      if (seen.has(key)) dupes[c.type] = (dupes[c.type] || 0) + 1;
      else seen.set(key, c);
    }
    return { resident: all.length, parts: index?.parts ?? null, near, dupes };
  }

  // ------------------------------------------------------------------------------------------------ city player cases
  const MODE_BODY = {
    person: { radius: 0.48, distance: 5, seconds: 5 },
    cyclist: { radius: 0.38, distance: 8, seconds: 5 },
    car: { radius: 0.9, distance: 10, seconds: 4 }
  };
  const bodyFor = (mode, heading, margin = 0) => {
    const entity = controller.entities[mode];
    const radius = mode === 'car' ? (entity?.bodySpec?.width || 1.72) / 2 : MODE_BODY[mode].radius;
    return shapes.collisionBody(mode, radius, heading, margin, mode === 'car' ? entity?.bodySpec : null);
  };
  const POINT = { oriented: false, sin: 0, cos: 1, offsetForward: 0, radius: 0.02, extX: 0.02, extZ: 0.02, bottom: 0, top: 1.9 };
  const groundY = (x, z) => world.groundHeight?.heightAt?.(x, z) ?? 0;
  const tmpContact = { nx: 0, nz: 0, depth: 0 };
  const hits = (c, x, z, body) => shapes.buildingContact(c, x, groundY(x, z), z, body, tmpContact) ? tmpContact.depth : 0;
  /** True when a body of `mode` can travel a -> b touching no solid but `except` (sampled every 0.25 m, with `margin`). */
  function pathClear(mode, a, b, heading, except = null, margin = 0.15) {
    const body = bodyFor(mode, heading, margin);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const near = query((a.x + b.x) / 2, (a.z + b.z) / 2, len / 2 + 4, []);
    for (let s = 0; s <= len; s += 0.25) {
      const x = a.x + (b.x - a.x) * s / len, z = a.z + (b.z - a.z) * s / len;
      for (const c of near) if (c !== except && hits(c, x, z, body) > 0) return false;
    }
    return true;
  }
  function place(mode, x, z, heading) {
    controller.setMode(mode, { preserveSwanPosition: true });
    controller.teleportActiveTo(x, z, heading);
    const e = controller.getActiveEntity();
    e.speed = 0;
    return Math.hypot(e.position.x - x, e.position.z - z) < 0.3 && Math.abs(Math.atan2(Math.sin(e.heading - heading), Math.cos(e.heading - heading))) < 0.05;
  }
  async function drive(seconds, dt, each) {
    controller.setTouchInput('forward', 1);
    try {
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        step(dt);
        each(controller.getActiveEntity());
        if (i % 30 === 29) await yieldNow();
      }
    } finally {
      controller.clearTouchInput();
      controller.resetInput();
    }
  }
  /** Approach fixtures for a target class near a spot: { collider, start, heading, surface } with a clear run-up. */
  function approaches(spot, mode, type) {
    const { distance } = MODE_BODY[mode];
    const near = query(spot.x, spot.z, 90, []).filter((c) => type === 'building' ? c.type === 'building'
      : type === 'pole' ? ['lamp', 'bollard', 'tree', 'bus-flag'].includes(c.type) && c.shape === 'circle'
        : c.type === 'parked-car');
    near.sort((p, q) => Math.hypot(centre(p).x - spot.x, centre(p).z - spot.z) - Math.hypot(centre(q).x - spot.x, centre(q).z - spot.z));
    const out = [];
    for (const c of near.slice(0, 24)) {
      const dirs = [];
      if (c.type === 'building') {
        for (const e of c.boundaryEdges || []) {
          if (Math.hypot(e.bx - e.ax, e.bz - e.az) < 6) continue;
          dirs.push({ nx: e.nx, nz: e.nz, sx: (e.ax + e.bx) / 2, sz: (e.az + e.bz) / 2 });
        }
      } else {
        const p = centre(c);
        for (let k = 0; k < 8; k++) dirs.push({ nx: Math.sin(k * Math.PI / 4), nz: Math.cos(k * Math.PI / 4), sx: p.x, sz: p.z });
      }
      for (const d of dirs) {
        const reachOut = c.type === 'building' ? 0 : Math.max(c.maxX - c.minX, c.maxZ - c.minZ) / 2;
        const start = { x: d.sx + d.nx * (distance + reachOut), z: d.sz + d.nz * (distance + reachOut) };
        const heading = Math.atan2(-d.nx, -d.nz);
        const stop = { x: d.sx + d.nx * (reachOut + 1.4), z: d.sz + d.nz * (reachOut + 1.4) };
        if (!pathClear(mode, start, stop, heading, c)) continue;
        out.push({ collider: c, start, heading, surface: { x: d.sx + d.nx * reachOut, z: d.sz + d.nz * reachOut }, nx: d.nx, nz: d.nz, reachOut });
        if (out.length >= 3) return out;
        break;
      }
    }
    return out;
  }

  /**
   * The player against the solids of a streamed city at `spots`: walking, cycling and driving straight at a building wall, a pole and a
   * parked car must stop at them (no overlap deeper than 6 cm, never through); driving along a clear stretch of street must not snag on
   * anything (no static contact); and the solids must be the drawn ones (no pole for a lamp hanging from its wire, no district list).
   */
  async function cityCases({ spots, dt = 1 / 60, modes = ['person', 'cyclist', 'car'] }) {
    freeze();
    shapes ||= await import('/js/collision-shapes.js');
    const cases = [];
    const add = (name, pass, detail = {}) => cases.push({ name, pass: Boolean(pass), ...detail });
    add('streamed city: the controllers query the resident tile solids only', controller.staticIndex === world.staticIndex && !(controller.colliders?.length),
      { controllerColliders: controller.colliders?.length ?? null });
    for (const spot of spots) {
      await goto({ ...spot, mode: 'person', warm: 90, dt });
      // the lamp solids are the drawn poles (js/street-furniture-cph.js): a mast, or a wire lamp without its wire on a tube pole, is
      // solid; a lamp hanging from its wire is not. Over every resident tile, both ways.
      const plan = world.furniture?.plan?.lamps || [];
      const keyOf = (x, z) => `${Math.round(x * 100)}:${Math.round(z * 100)}`;
      const byPos = new Map(plan.map((l) => [keyOf(l.x, l.z), l]));
      const lampColliders = colliders().filter((c) => c.type === 'lamp');
      const solidAt = new Set(lampColliders.map((c) => keyOf(c.obb.cx, c.obb.cz)));
      const undrawn = lampColliders.filter((c) => { const l = byPos.get(keyOf(c.obb.cx, c.obb.cz)); return !l || (l.mount !== 'mast' && l.wire); });
      const poles = plan.filter((l) => l.mount === 'mast' || !l.wire);
      const unsolid = poles.filter((l) => !solidAt.has(keyOf(l.x, l.z)));
      add(`${spot.name}: lamp solids are exactly the drawn poles`, undrawn.length === 0 && unsolid.length === 0,
        { lampColliders: lampColliders.length, drawnPoles: poles.length, hanging: plan.length - poles.length,
          collidersWithoutPole: undrawn.slice(0, 5).map((c) => c.id), polesWithoutCollider: unsolid.length,
          bracketPoles: poles.filter((l) => l.mount !== 'mast').length });
      for (const mode of modes) {
        for (const type of ['building', 'pole', 'parked-car']) {
          const name = `${spot.name}: ${mode} stops at a ${type}`;
          const fixtures = approaches(spot, mode, type);
          if (!fixtures.length) { add(name, type !== 'building', { skipped: 'no clear run-up near the spot', distance: null }); continue; }
          let result = null;
          for (const f of fixtures) {
            if (!place(mode, f.start.x, f.start.z, f.heading)) continue;
            let maxDepth = 0, closest = Infinity, crossed = false;
            await drive(MODE_BODY[mode].seconds, dt, (e) => {
              const depth = hits(f.collider, e.position.x, e.position.z, bodyFor(mode, e.heading));
              maxDepth = Math.max(maxDepth, depth);
              const along = (e.position.x - f.surface.x) * f.nx + (e.position.z - f.surface.z) * f.nz; // > 0 on the run-up side
              closest = Math.min(closest, along);
              // through it: the body's centre inside the solid (sliding round a corner and past is not)
              if (hits(f.collider, e.position.x, e.position.z, POINT) > 0) crossed = true;
            });
            const body = bodyFor(mode, 0);
            const reached = closest < Math.max(body.hx, body.hz, body.radius) + 0.6;
            result = { collider: f.collider.id, maxDepth: +maxDepth.toFixed(3), closest: +closest.toFixed(2), reached, crossed };
            if (reached) break;
          }
          if (!result) { add(name, type !== 'building', { skipped: 'teleport moved the start' }); continue; }
          add(name, result.reached && !result.crossed && result.maxDepth < 0.06, result);
        }
        // a clear straight stretch from the spot (either way along the street, or a few metres to the side): no snag
        const name = `${spot.name}: ${mode} runs a clear stretch without a static contact`;
        const length = mode === 'person' ? 12 : 30;
        let run = null;
        outer: for (const side of [0, 2, -2, 4, -4, 6, -6]) {
          for (const turn of [0, Math.PI]) {
            const h = spot.heading + turn;
            const rx = Math.cos(h), rz = -Math.sin(h);
            const a = { x: spot.x + rx * side, z: spot.z + rz * side };
            const b = { x: a.x + Math.sin(h) * length, z: a.z + Math.cos(h) * length };
            if (pathClear(mode, a, b, h, null, 0.4)) { run = { a, b, h }; break outer; }
          }
        }
        if (!run || !place(mode, run.a.x, run.a.z, run.h)) { add(name, true, { skipped: 'no clear stretch' }); continue; }
        let staticHits = 0;
        const kinds = {};
        stage.setObserver({ static(actor, c) { if (actor.kind === 'player' && actor.entity === controller.getActiveEntity()) { staticHits++; kinds[c.type] = (kinds[c.type] || 0) + 1; } }, pair() {} });
        const resolveBefore = controller.resolveHorizontalCollision;
        let controllerPushes = 0;
        controller.resolveHorizontalCollision = function (pos, ...rest) {
          const x = pos.x, z = pos.z;
          const r = resolveBefore.call(this, pos, ...rest);
          if (Math.hypot(pos.x - x, pos.z - z) > 1e-6) controllerPushes++;
          return r;
        };
        let lateral = 0, progress = 0;
        try {
          await drive(mode === 'person' ? 4 : 3, dt, (e) => {
            const dx = e.position.x - run.a.x, dz = e.position.z - run.a.z;
            const along = dx * Math.sin(run.h) + dz * Math.cos(run.h);
            if (along > length) return;
            progress = Math.max(progress, along);
            lateral = Math.max(lateral, Math.abs(dx * Math.cos(run.h) - dz * Math.sin(run.h)));
          });
        } finally {
          stage.setObserver(null);
          controller.resolveHorizontalCollision = resolveBefore;
        }
        add(name, staticHits === 0 && controllerPushes === 0 && progress > 3, { staticHits, kinds, controllerPushes, progress: +progress.toFixed(2), lateral: +lateral.toFixed(2) });
      }
    }
    return cases;
  }

  globalThis.__collisionProbe = { goto, measure, perf, run, census, cityCases, step, freeze, get shapes() { return shapes; } };
  return true;
})();
