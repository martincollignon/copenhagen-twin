// js/agent-region.js
// The agents of a streamed city (traffic, cyclists, pedestrians) live in a REGION around the camera, not on the whole city:
//   routing   the compact citywide road graph (data/city/roadgraph.json, graph only: nodes and links), cut to the links inside the
//             region. The road network (junctions, lanes, right of way) is derived from that sub-graph.
//   placement the detailed geometry of the near ring (the tiles' roads, cycle tracks and signals, street layout applied) of the same
//             region: the cyclists' lane graph (tracks on the right sides, contraflow, signals) and the signal junctions.
// The region is rebuilt when the camera has moved `drift` metres from its centre (never more often than every 1.5 s, unless the camera
// jumped out of it), in stages of one per frame (sub-graph, road network, lane graph, swap), and only once the roads of every tile it
// covers are in memory. Agents are taken off the old region at the swap and spawn again around the camera on the new one, so they
// exist within the near ring only. Pure (no three.js): runs in node.

import { distanceToRect } from './tile-rings.js';

/** Uniform grid of the links of a road graph by the cell of their midpoint. */
export function createLinkIndex(roadGraph, cell = 250) {
  const N = roadGraph.nodes;
  const cells = new Map();
  const key = (ix, iz) => ix * 65536 + iz;
  roadGraph.links.forEach((l, i) => {
    const mx = (N[2 * l[0]] + N[2 * l[1]]) / 2;
    const mz = (N[2 * l[0] + 1] + N[2 * l[1] + 1]) / 2;
    const k = key(Math.floor(mx / cell) + 8192, Math.floor(mz / cell) + 8192);
    const list = cells.get(k);
    if (list) list.push(i); else cells.set(k, [i]);
  });
  return {
    cell,
    /** Ids of the links whose midpoint lies within `r` of (x, z). */
    near(x, z, r) {
      const out = [];
      const x0 = Math.floor((x - r) / cell); const x1 = Math.floor((x + r) / cell);
      const z0 = Math.floor((z - r) / cell); const z1 = Math.floor((z + r) / cell);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          for (const i of cells.get(key(ix + 8192, iz + 8192)) || []) {
            const l = roadGraph.links[i];
            const mx = (N[2 * l[0]] + N[2 * l[1]]) / 2;
            const mz = (N[2 * l[0] + 1] + N[2 * l[1] + 1]) / 2;
            if (Math.hypot(mx - x, mz - z) <= r) out.push(i);
          }
        }
      }
      return out;
    }
  };
}

/** The part of a road graph inside the circle: { nodes, links, names, classes, layout } with its own node numbering. */
export function subGraph(roadGraph, linkIndex, x, z, r) {
  const ids = linkIndex.near(x, z, r).sort((a, b) => a - b);
  const map = new Map();
  const nodes = [];
  const links = [];
  const use = (i) => {
    let j = map.get(i);
    if (j === undefined) {
      j = nodes.length / 2;
      map.set(i, j);
      nodes.push(roadGraph.nodes[2 * i], roadGraph.nodes[2 * i + 1]);
    }
    return j;
  };
  for (const id of ids) {
    const l = roadGraph.links[id];
    const copy = l.slice();
    copy[0] = use(l[0]);
    copy[1] = use(l[1]);
    links.push(copy);
  }
  return { nodes, links, names: roadGraph.names, classes: roadGraph.classes, ...(roadGraph.layout ? { layout: roadGraph.layout } : {}) };
}

const flatBox = (flat) => {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] < x0) x0 = flat[i];
    if (flat[i] > x1) x1 = flat[i];
    if (flat[i + 1] < z0) z0 = flat[i + 1];
    if (flat[i + 1] > z1) z1 = flat[i + 1];
  }
  return [x0, z0, x1, z1];
};

/** True when a flat polyline's bounding box comes within `r` of (x, z). */
export const polylineNear = (flat, x, z, r) => !!flat && flat.length >= 4 && distanceToRect(x, z, flatBox(flat)) <= r;

/**
 * Spatial hash of the segments of bicycle lanes (a lane: { pts, src }): `near(x, z, r)` is true when a lane that comes from a real
 * track or path (it has a `src`) passes within r. Replaces a scan over every lane for every pavement the pedestrians route along.
 */
export function createLaneIndex(lanes, cell = 16) {
  const grid = new Map();
  const key = (ix, iz) => ix * 65536 + iz;
  for (const lane of lanes) {
    if (!lane.src) continue;
    const p = lane.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = Math.floor(Math.min(p[i], p[i + 2]) / cell); const x1 = Math.floor(Math.max(p[i], p[i + 2]) / cell);
      const z0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / cell); const z1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / cell);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = key(ix + 8192, iz + 8192);
          const list = grid.get(k);
          if (list) list.push(p, i); else grid.set(k, [p, i]);
        }
      }
    }
  }
  return {
    near(x, z, r) {
      const x0 = Math.floor((x - r) / cell); const x1 = Math.floor((x + r) / cell);
      const z0 = Math.floor((z - r) / cell); const z1 = Math.floor((z + r) / cell);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = grid.get(key(ix + 8192, iz + 8192));
          if (!list) continue;
          for (let q = 0; q < list.length; q += 2) {
            const p = list[q];
            const i = list[q + 1];
            const dx = p[i + 2] - p[i];
            const dz = p[i + 3] - p[i + 1];
            const l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
            if (Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z) <= r) return true;
          }
        }
      }
      return false;
    }
  };
}

/**
 * The region manager.
 * @param {object} o
 *   roadGraph   the citywide graph (street layout applied)
 *   tilesAround (x, z, r) => ids of the tiles within r metres (those that exist in the index)
 *   roadsOf     (id) => { roads, cycleTracks, signals } of a tile (js/tile-data.js)
 *   ready       (id) => the tile's roads are in memory
 *   stages      { network(sub, signals, ctx) => road network, cyclists(geo, ctx) => lane graph, apply(ctx) } the consumers; every one
 *               runs in a frame of its own
 */
export function createAgentRegion({ roadGraph, tilesAround, roadsOf, ready, stages, radius = 560, drift = 190, minInterval = 1500, now = () => performance.now() }) {
  const linkIndex = createLinkIndex(roadGraph);
  const stats = { builds: 0, links: 0, edges: 0, lanes: 0, signals: 0, tiles: 0, stageMs: { graph: 0, network: 0, cyclists: 0, apply: 0 }, maxStageMs: 0, waiting: 0, jumps: 0 };
  let region = null; // { cx, cz, radius, tiles }
  let job = null; // generator
  let lastBuild = -Infinity;
  const timed = (name, fn) => {
    const t0 = now();
    const r = fn();
    const ms = now() - t0;
    stats.stageMs[name] = ms;
    stats.maxStageMs = Math.max(stats.maxStageMs, ms);
    return r;
  };

  function* build(cx, cz, tiles) {
    const ctx = { cx, cz, radius, tiles };
    timed('graph', () => {
      ctx.graph = subGraph(roadGraph, linkIndex, cx, cz, radius);
      const roads = [];
      const cycleTracks = [];
      const signals = [];
      for (const id of tiles) {
        const t = roadsOf(id);
        for (const r of t.roads) if (polylineNear(r.pts, cx, cz, radius)) roads.push(r);
        for (const c of t.cycleTracks) if (polylineNear(c.pts, cx, cz, radius)) cycleTracks.push(c);
        for (const s of t.signals) if (Math.hypot(s.x - cx, s.z - cz) <= radius + 30) signals.push(s);
      }
      ctx.geo = { roads, cycleTracks, roadGraph: ctx.graph };
      ctx.signals = signals;
    });
    yield;
    ctx.network = timed('network', () => stages.network(ctx.graph, ctx.signals, ctx));
    yield;
    ctx.cyclists = timed('cyclists', () => stages.cyclists(ctx.geo, ctx));
    yield;
    timed('apply', () => stages.apply(ctx));
    region = { cx, cz, radius, tiles };
    stats.builds++;
    stats.links = ctx.graph.links.length;
    stats.edges = ctx.network?.edges?.length ?? 0;
    stats.lanes = ctx.cyclists?.lanes?.length ?? 0;
    stats.signals = ctx.signals.length;
    stats.tiles = tiles.length;
    lastBuild = now();
  }

  return {
    stats,
    get region() { return region; },
    get building() { return !!job; },
    /** Called every frame with the camera position; at most one stage of a rebuild runs per call. Returns true when the region changed. */
    update(x, z) {
      if (job) {
        const step = job.next();
        if (step.done) { job = null; return true; }
        return false;
      }
      const d = region ? Math.hypot(x - region.cx, z - region.cz) : Infinity;
      if (region && d < drift) return false;
      const jumped = !region || d > radius * 0.8;
      if (!jumped && now() - lastBuild < minInterval) return false;
      const tiles = tilesAround(x, z, radius + 60);
      if (!tiles.every(ready)) { stats.waiting++; return false; }
      if (jumped && region) stats.jumps++;
      job = build(x, z, tiles);
      return false;
    },
    /** Builds the region around (x, z) now, all stages (the boot). */
    buildNow(x, z) {
      const tiles = tilesAround(x, z, radius + 60);
      job = build(x, z, tiles);
      while (!job.next().done);
      job = null;
      return region;
    }
  };
}
