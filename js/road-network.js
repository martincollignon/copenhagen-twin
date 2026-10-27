import { carriagewayFromLanes } from './road-width-cph.js';

// js/road-network.js
// Drivable road graph from the Copenhagen centreline graph (data/cph-geodata.json roadGraph): junctions, directed
// edges with their lanes, intersection arms and right of way, and the lane-to-lane curves used to drive straight
// through junctions or turn.
//
// Conventions: north = -z, east = +x. Every directed edge has a unit direction (dx, dz) and a right normal
// (rx, rz) = (-dz, dx). Lanes are lateral offsets to the right of the centreline, sorted left to right.

const CROSSWALK = 2.5; // depth between an intersection box and its stop lines

function buildRoadNetwork(signalIntersections = [], options = {}) {
  // `options.roadGraph` is the roadGraph of data/cph-geodata.json; the roads themselves are the truth, so no obstacle
  // rectangle blocks a lane. `options.walkable` / `options.onSidewalk` come from walk-space-cph.js.
  let nodes = [];

  // 4. Streets from the centreline graph: chained through vertices where just two similar vehicular links meet, into
  //    the junction-to-junction links with inner points. A junction is a node; a street's bends get shape nodes, so
  //    every edge stays straight.
  const genRuns = centrelineStreets();
  function centrelineStreets() {
    const RG = cphCentrelines(options.roadGraph);
    const runs = [];
    if (!RG) return runs;
    const pos = [];
    for (let i = 0; i < RG.nodes.length; i += 2) pos.push({ x: RG.nodes[i], z: RG.nodes[i + 1] });
    const links = [];
    for (const [a, b, ni, w, lanes, dir, inner, extra] of RG.links) {
      const pts = [pos[a]];
      for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
      pts.push(pos[b]);
      let len = 0;
      for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      links.push({ a, b, name: RG.names[ni], w, lanes, dir, pts, len, chain: extra });
    }
    // Junctions a few metres apart (divided roads, offset corners) are one: collapse links under 14 m
    const parent = pos.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const l of links) if (l.len < 14) parent[find(l.a)] = find(l.b);
    const sum = new Map();
    const counted = new Set();
    for (const l of links) {
      for (const i of [l.a, l.b]) {
        if (counted.has(i)) continue;
        counted.add(i);
        const r = find(i);
        const s = sum.get(r) || { x: 0, z: 0, n: 0 };
        s.x += pos[i].x;
        s.z += pos[i].z;
        s.n++;
        sum.set(r, s);
      }
    }
    const junctions = new Map();
    function junction(r) {
      if (junctions.has(r)) return junctions.get(r);
      const s = sum.get(r);
      const node = { x: s.x / s.n, z: s.z / s.n, hx: 0, hz: 0, signal: false, in: [], out: [], general: true };
      nodes.push(node);
      junctions.set(r, node);
      return node;
    }
    const lanesOf = (l) => cphLanes(l);
    const DEG = Math.PI / 180;
    for (const l of links) {
      const A = junction(find(l.a));
      const B = junction(find(l.b));
      if (A === B) continue;
      const pts = [{ x: A.x, z: A.z }, ...l.pts.slice(1, -1), { x: B.x, z: B.z }];
      // stations along it: the ends and every bend over 12° at least 15 m from the last station and from the far end
      const stations = [A];
      let last = pts[0];
      let rest = l.len;
      for (let k = 1; k < pts.length - 1; k++) {
        const p1 = pts[k];
        const p2 = pts[k + 1];
        const d0 = Math.hypot(p1.x - last.x, p1.z - last.z);
        rest -= Math.hypot(p1.x - pts[k - 1].x, p1.z - pts[k - 1].z);
        let turn = Math.abs(Math.atan2(p2.z - p1.z, p2.x - p1.x) - Math.atan2(p1.z - last.z, p1.x - last.x));
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < 12 * DEG || d0 < 15 || rest < 15) continue;
        const s = { x: p1.x, z: p1.z, hx: 0, hz: 0, signal: false, in: [], out: [], general: true, shape: true };
        nodes.push(s);
        stations.push(s);
        last = p1;
      }
      stations.push(B);
      const lanes = lanesOf(l);
      for (let k = 0; k + 1 < stations.length; k++) runs.push({ from: stations[k], to: stations[k + 1], chain: l.chain, ...lanes });
    }
    console.info(`[roads] centreline streets: ${links.length} links not on the grid, ${runs.length} straight runs`);
    return runs;
  }

  // 5. Directed edges between intersections
  let edges = [];
  // Centreline streets: any direction; the roads themselves are the truth, so no obstacle blocks a lane
  function addEdgeGeneral(from, to, axis, lanes, half, divided, chain) {
    const x0 = from.x;
    const z0 = from.z;
    const span = Math.hypot(to.x - x0, to.z - z0);
    if (span < 8) return;
    const dx = (to.x - x0) / span;
    const dz = (to.z - z0) / span;
    const open = lanes.slice();
    if (!open.length) return;
    edges.push({ from, to, axis, x0, z0, dx, dz, rx: -dz, rz: dx, span, half, lanes: open.sort((p, q) => p - q), moves: [], general: true, cand: lanes, divided: !!divided, chain });
  }
  // A divided road drawn as two one-way roadways between the same two junctions (most of the Bowery) runs both ways
  // along one centreline here: each way keeps to the right of it, as on a two-way street, and the road is as wide as
  // both roadways
  const travel = (r) => (r.fwd.length ? [r.from, r.to] : [r.to, r.from]);
  const oneWays = new Map(); // node -> next node -> the one-way run from one to the other
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length) continue;
    const [a, b] = travel(r);
    if (!oneWays.has(a)) oneWays.set(a, new Map());
    oneWays.get(a).set(b, r);
  }
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length || r.divided) continue;
    const [a, b] = travel(r);
    const o = oneWays.has(b) && oneWays.get(b).get(a);
    if (!o || o.divided) continue;
    for (const q of [r, o]) {
      const lanes = q.fwd.length ? q.fwd : q.back;
      const right = lanes.map((x) => x - lanes[0] + 1.8); // as on a two-way street, from 1.8 m right of the centreline
      if (q.fwd.length) q.fwd = right;
      else q.back = right;
      q.divided = true;
    }
    r.half = o.half = r.half + o.half;
    if (r.half >= 7.25) r.axis = o.axis = 'ave'; // as wide as a major road (see lanesOf)
  }
  for (const r of genRuns) {
    if (r.fwd.length) addEdgeGeneral(r.from, r.to, r.axis, r.fwd, r.half, r.divided, r.chain);
    if (r.back.length) addEdgeGeneral(r.to, r.from, r.axis, r.back, r.half, r.divided, r.chain);
  }
  // Two edges from one node to the same next one (a service road whose ends were drawn onto its main road's junctions)
  // would drive through each other: keep the grid's, else the one with the most lanes
  const keptEdge = new Map();
  const edgeRank = (e) => e.lanes.length * 10 + e.half / 100;
  for (const e of edges) {
    let to = keptEdge.get(e.from);
    if (!to) keptEdge.set(e.from, (to = new Map()));
    const o = to.get(e.to);
    if (!o || edgeRank(e) > edgeRank(o)) to.set(e.to, e);
  }
  edges = edges.filter((e) => keptEdge.get(e.from).get(e.to) === e);
  // ...and where only some of the junctions on both sides of its median became one (Pike St), the stretches of its two
  // roadways that run on top of each other the same way
  {
    const oneWay = edges.filter((e) => e.general && !e.divided && e.cand[0] <= 0); // lanes about its centreline
    const cells = new Map(); // 16 m cells -> the one-way edges passing within 4 m
    oneWay.forEach((e, i) => {
      e.oneWay = i;
      for (let t = 0; t <= e.span; t += 8) {
        const x = e.x0 + e.dx * t;
        const z = e.z0 + e.dz * t;
        for (let ix = Math.floor((x - 4) / 16); ix <= Math.floor((x + 4) / 16); ix++) {
          for (let iz = Math.floor((z - 4) / 16); iz <= Math.floor((z + 4) / 16); iz++) {
            const k = (ix + 4096) * 8192 + (iz + 4096);
            const list = cells.get(k);
            if (!list) cells.set(k, [e]);
            else if (list[list.length - 1] !== e) list.push(e);
          }
        }
      }
    });
    // metres of e along f whose lanes come within 3 m of f's (e's right is f's left)
    const onTop = (e, f) => {
      let hits = 0;
      for (let t = 0; t <= e.span; t += 2) {
        const px = e.x0 + e.dx * t - f.x0;
        const pz = e.z0 + e.dz * t - f.z0;
        const u = px * f.dx + pz * f.dz;
        if (u < 0 || u > f.span) continue;
        const side = px * f.rx + pz * f.rz;
        if (e.lanes.some((a) => f.lanes.some((b) => Math.abs(side - a - b) < 3))) hits += 2;
      }
      return hits;
    };
    const partner = new Map(); // edge -> half width of the widest roadway running the other way on top of it
    const tested = new Set();
    for (const list of cells.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const e = list[i];
          const f = list[j];
          if (e.dx * f.dx + e.dz * f.dz > -0.94) continue; // the other way, within 20°
          const key = Math.min(e.oneWay, f.oneWay) * 65536 + Math.max(e.oneWay, f.oneWay);
          if (tested.has(key)) continue;
          tested.add(key);
          if (Math.max(onTop(e, f), onTop(f, e)) < 6) continue;
          partner.set(e, Math.max(partner.get(e) || 0, f.half));
          partner.set(f, Math.max(partner.get(f) || 0, e.half));
        }
      }
    }
    for (const [e, other] of partner) {
      e.lanes = e.cand.map((o) => o - e.cand[0] + 1.8);
      e.half += other;
      if (e.half >= 7.25) e.axis = 'ave'; // as wide as a major road (see lanesOf)
      e.divided = true;
    }
    edges = edges.filter((e) => e.lanes.length);
  }
  // Edges no vehicle could both reach and leave (dead ends, and roads reached only from them) are dropped once the
  // moves are known (7.); know them already, so that no road keeps clear of a dead one merging with it or forking off it
  {
    const outsOf = new Map();
    for (const e of edges) {
      if (!outsOf.has(e.from)) outsOf.set(e.from, []);
      outsOf.get(e.from).push(e);
    }
    const live = largestComponent(edges, (e) => (outsOf.get(e.to) || []).filter((f) => f.to !== e.from && e.dx * f.dx + e.dz * f.dz >= -0.5));
    for (const e of edges) e.live = live.has(e);
  }
  const liveArm = (a) => !!((a.in && a.in.live) || (a.out && a.out.live));

  // The roads meeting at each node ("arms": one per direction a road leaves it in), from the edges into and out of it:
  // { ux, uz } (unit, away from the node), half (the widest roadway's half width), ave (a major road's), and its edge
  // `in` and edge `out`, if any. The two ways of a two-way street share an arm, and so do the two one-way roadways of a
  // divided road (within 20° of each other); a second road arriving or leaving within 20° of another (where streets
  // merge or fork) gets an arm of its own. With `only`, for just the nodes in that set.
  function computeArms(list, only = null) {
    for (const n of only || nodes) n.arms = [];
    const ends = new Map(); // node -> the edge ends there, in the order the edges come
    list.forEach((e, i) => {
      for (const [n, role, ux, uz] of [[e.from, 'out', e.dx, e.dz], [e.to, 'in', -e.dx, -e.dz]]) {
        if (only && !only.has(n)) continue;
        if (role === 'out') e.outArm = null;
        else e.inArm = null;
        if (!ends.has(n)) ends.set(n, []);
        ends.get(n).push({ e, role, ux, uz, order: 2 * i + (role === 'in' ? 1 : 0) });
      }
    });
    const armed = (q) => (q.role === 'out' ? q.e.outArm : q.e.inArm);
    for (const [n, at] of ends) {
      // arms in the order of their first edge end, each pointing along it
      const newArm = (q) => {
        const a = { ux: q.ux, uz: q.uz, half: 0, ave: false, in: null, out: null, order: q.order };
        n.arms.push(a);
        return a;
      };
      const join = (a, q) => {
        a[q.role] = q.e;
        if (q.role === 'out') q.e.outArm = a;
        else q.e.inArm = a;
        a.half = Math.max(a.half, q.e.half);
        a.ave = a.ave || q.e.axis === 'ave';
        a.order = Math.min(a.order, q.order);
      };
      // both ways of a two-way street
      for (const q of at) {
        if (q.role !== 'out') continue;
        const r = at.find((p) => p.role === 'in' && p.e.from === q.e.to);
        if (!r) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // one-way roadways within 20°, one each way: a divided road's, the best aligned first
      const pairs = [];
      for (const q of at) {
        if (q.role !== 'out' || armed(q)) continue;
        for (const r of at) {
          const d = q.ux * r.ux + q.uz * r.uz;
          if (r.role === 'in' && !armed(r) && d > 0.94) pairs.push([d, q, r]);
        }
      }
      pairs.sort((p, q) => q[0] - p[0]);
      for (const [, q, r] of pairs) {
        if (armed(q) || armed(r)) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // and every other road alone
      for (const q of at) if (!armed(q)) join(newArm(q), q);
      n.arms.sort((a, b) => a.order - b.order);
      // an arm within 20° of an earlier one (where roads merge or fork) crosses the other roads as one with it (its
      // lead), as wide as the widest of them
      for (const a of n.arms) {
        a.lead = n.arms.find((b) => b.lead === b && b.ux * a.ux + b.uz * a.uz > 0.94) || a;
        a.lead.wide = Math.max(a.lead === a ? 0 : a.lead.wide, a.half);
      }
    }
  }
  computeArms(edges);
  // A centreline node where just one road goes on, bending less than 35°, is a shape node: no corner to stop at (nor a
  // fork: a road splitting in two live ones within 20°)
  const bends = (n) => {
    const leads = n.arms.filter((a) => a.lead === a);
    const forks = leads.some((l) => n.arms.filter((a) => a.lead === l && liveArm(a)).length > 1);
    return leads.length === 2 && leads[0].ux * leads[1].ux + leads[0].uz * leads[1].uz < -0.82 && !forks;
  };
  for (const n of nodes) if (!n.shape && bends(n)) n.shape = true;
  // Where two roads leave a node within 20° of each other (they merge or fork there), how far out every lane of one
  // first keeps 3 m (a car's width and some) from every lane of the other
  const lanesOut = (a, r, out) => {
    out.length = 0;
    for (const e of [a.in, a.out]) {
      if (!e || !e.live) continue;
      const t = e === a.out ? r : e.span - r; // r from its start leaving, r before its end arriving
      for (const o of e.lanes) out.push(e.x0 + e.dx * t + e.rx * o, e.z0 + e.dz * t + e.rz * o);
    }
    return out;
  };
  const lanesA = [];
  const lanesB = [];
  function apart(a, b) {
    for (let r = 2; r < 45; r++) {
      lanesOut(a, r, lanesA);
      lanesOut(b, r, lanesB);
      let near = Infinity;
      for (let i = 0; i < lanesA.length; i += 2) {
        for (let j = 0; j < lanesB.length; j += 2) near = Math.min(near, Math.hypot(lanesA[i] - lanesB[j], lanesA[i + 1] - lanesB[j + 1]));
      }
      if (near >= 3) return r;
    }
    return 45;
  }
  // How far before node n an edge arriving along `arm` stops: clear of every road crossing it (at whatever angle: its
  // curb corner reaches past the crossing road's far side by half its own width over the tangent) plus the crosswalk,
  // and clear of the lanes of a road merging with it or forking off it
  const goesOn = (p, q) => p.ux * q.ux + p.uz * q.uz < 0 && Math.abs(p.ux * q.uz - p.uz * q.ux) < 0.26; // q within 15° of straight on from p
  function stopBack(n, arm) {
    if (n.shape) return 1;
    const a = arm.lead;
    let ext = 0;
    let fork = 0;
    for (const b of n.arms) {
      if (b === arm) continue;
      if (b.lead === a) {
        if (liveArm(arm) && liveArm(b)) fork = Math.max(fork, apart(arm, b) + 1); // side by side rather than across
        continue;
      }
      if (b.lead !== b) continue; // crossing as one with its lead
      // the same road going on (into either of two roads forking there, or out of either of two merging)
      if (n.arms.some((p) => p.lead === a && n.arms.some((q) => q.lead === b && goesOn(p, q)))) continue;
      const cos = a.ux * b.ux + a.uz * b.uz;
      const sin = Math.abs(a.ux * b.uz - a.uz * b.ux);
      ext = Math.max(ext, (b.wide + a.wide * Math.abs(cos)) / sin);
    }
    return Math.max(ext > 0 ? Math.min(ext, 20) + CROSSWALK : 2, fork);
  }
  // Edges run between stop lines: past the roads crossing them and their crosswalks at both ends. On a short link
  // between acute corners the two pull in together, keeping at least 10 m (or half the link) to queue on.
  function place(e) {
    let b0 = stopBack(e.from, e.outArm);
    let b1 = stopBack(e.to, e.inArm);
    const keep = Math.min(10, e.span * 0.5);
    e.squeezed = false;
    if (e.span - b0 - b1 < keep) {
      const k = (e.span - keep) / (b0 + b1);
      b0 *= k;
      b1 *= k;
      e.squeezed = !e.to.shape; // its stop line closer to the roads crossing ahead than they need (see the end of 6.)
    }
    e.sx = e.x0 + e.dx * b0;
    e.sz = e.z0 + e.dz * b0;
    e.len = e.span - b0 - b1;
  }
  for (const e of edges) place(e);
  const placed = edges; // (see 7.)
  const genCreated = edges.filter((e) => e.general).length;
  edges = edges.filter((e) => e.len > 4);

  // Paint describes the physical streets, including dead ends and roads AI traffic cannot circulate through.
  // Snapshot their geometry before routing moves stop lines, drops edges and renumbers the surviving junctions.
  const paintNodes = new Map(nodes.map((n, id) => [n, { id, x: n.x, z: n.z, shape: n.shape }]));
  const paintEdges = edges.map(({ from, to, axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes }) => ({
    from: paintNodes.get(from), to: paintNodes.get(to), axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes
  }));

  // 6. Movements at each intersection (no U-turns) and the lane each lane leads to, along obstacle-free curves:
  //    straight on, lane i keeps to lane i + k ahead, k chosen to use as many lanes there as possible with the least
  //    sideways shift; turns go from the lane nearest the turn into the lane nearest it. Lanes left with no way on
  //    (where the road ends or narrows) turn alongside the turn lane, or merge. Across the road, lanes always run
  //    left turns, straight on, right turns, into lanes in the same order, so no two paths from one approach cross.
  const lateral = (e, i) => e.x0 * e.rx + e.z0 * e.rz + e.lanes[i];
  const ORDER = { L: 0, S: 1, R: 2 };
  function inOrder(e, m, i, j) {
    for (const o of e.moves) {
      for (let k = 0; k < e.lanes.length; k++) {
        if (k === i || o.out[k] < 0) continue;
        // o from k is right of m from i: by its kind of turn, then (two of a kind, where a road forks) by how far right
        // it bends
        const right = ORDER[o.turn] - ORDER[m.turn] || (o === m ? o.out[k] - j : Math.sign(o.cross - m.cross));
        if (k < i ? right > 0 : right < 0) return false;
      }
    }
    return true;
  }
  function nearestLane(e, i, f) {
    let j = 0;
    for (let k = 1; k < f.lanes.length; k++) {
      if (Math.abs(lateral(f, k) - lateral(e, i)) < Math.abs(lateral(f, j) - lateral(e, i))) j = k;
    }
    return j;
  }
  // Let lane i of e make move m into lane j of its edge (clamped to the lanes there), if the way is clear
  function link(e, m, i, j) {
    j = Math.max(0, Math.min(m.to.lanes.length - 1, j));
    if (m.out[i] < 0 && inOrder(e, m, i, j)) m.out[i] = j;
    return m.out[i] >= 0;
  }
  function serveEveryLane(e) {
    const n = e.lanes.length;
    for (let i = 0; i < n; i++) {
      if (e.moves.some((m) => m.out[i] >= 0)) continue;
      const turnLane = (m, k) => link(e, m, i, m.turn === 'L' ? k : m.to.lanes.length - 1 - k);
      const side = (m) => (m.turn === 'L' ? i : n - 1 - i); // lanes between i and the turn's side of the road
      e.moves.some((m) => m.turn !== 'S' && side(m) <= (n - 1) / 2 && turnLane(m, side(m))) ||
        e.moves.some((m) => m.turn === 'S' && link(e, m, i, nearestLane(e, i, m.to))) ||
        e.moves.some((m) => m.turn !== 'S' && turnLane(m, side(m))) ||
        e.moves.some((m) => m.to.lanes.some((_, j) => link(e, m, i, j)));
    }
    e.moves = e.moves.filter((m) => m.out.some((j) => j >= 0));
  }
  for (const e of edges) e.from.out.push(e);
  for (const e of edges) {
    const n = e.lanes.length;
    for (const f of e.to.out) {
      if (f.to === e.from || e.dx * f.dx + e.dz * f.dz < -0.5) continue;
      const cross = e.dx * f.dz - e.dz * f.dx;
      e.moves.push({ to: f, turn: cross > 0.5 ? 'R' : cross < -0.5 ? 'L' : 'S', cross, out: new Array(n).fill(-1) });
    }
    // A dead end (Copenhagen's many cul-de-sacs and clipped ends) turns traffic round onto the way back instead of
    // trapping it
    if (!e.moves.length) {
      const back = e.to.out.find((f) => f.to === e.from);
      if (back) e.moves.push({ to: back, turn: 'L', cross: 0, uTurn: true, out: new Array(n).fill(-1) });
    }
    // the straightest first: where a road forks, the branch going most nearly straight on keeps most of its lanes
    const ahead = (m) => e.dx * m.to.dx + e.dz * m.to.dz;
    for (const m of e.moves.slice().sort((p, q) => ahead(q) - ahead(p))) {
      const f = m.to;
      if (m.turn === 'L') link(e, m, 0, 0);
      else if (m.turn === 'R') link(e, m, n - 1, f.lanes.length - 1);
      else {
        let best = 0;
        let bestScore = -Infinity;
        for (let k = 1 - n; k < f.lanes.length; k++) {
          const used = new Set();
          let score = 0;
          for (let i = 0; i < n; i++) {
            const j = Math.max(0, Math.min(f.lanes.length - 1, i + k));
            used.add(j);
            score -= Math.abs(lateral(f, j) - lateral(e, i));
          }
          score += 100 * used.size;
          if (score > bestScore) {
            bestScore = score;
            best = k;
          }
        }
        for (let i = 0; i < n; i++) link(e, m, i, i + best);
      }
    }
    serveEveryLane(e);
  }

  // Sides & right-of-way groups of node n's arms (see 9.)
  function sidesAndGroups(n) {
    const arms = n.arms;
    let next = 4;
    for (const a of arms) a.side = -1;
    for (const a of arms) if (a.side < 0) a.side = next++;
    n.sideCount = Math.max(4, next);
    // roads: arms paired with the one most nearly opposite (beyond 145°), the likeliest pairs first: the straightest,
    // and of two about as straight, the one about as wide (a side street merging into a road nearly head on doesn't
    // take over the road's other side)
    const pairs = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const d = arms[i].ux * arms[j].ux + arms[i].uz * arms[j].uz;
        if (d < -0.82) pairs.push([d + 0.02 * Math.abs(arms[i].half - arms[j].half), arms[i], arms[j]]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const mates = new Map();
    for (const [, a, b] of pairs) {
      if (mates.has(a) || mates.has(b)) continue;
      mates.set(a, b);
      mates.set(b, a);
    }
    const roads = [];
    const done = new Set();
    for (const a of arms) {
      if (done.has(a)) continue;
      done.add(a);
      const mate = mates.get(a);
      if (mate) done.add(mate);
      const members = mate ? [a, mate] : [a];
      roads.push({ members, group: -1, rank: Math.max(...members.map((m) => (m.ave ? 100 : 0) + m.half)) });
    }
    let groups = 0;
    roads.sort((p, q) => q.rank - p.rank);
    for (const r of roads) if (r.group < 0) r.group = groups++;
    for (const r of roads) for (const m of r.members) m.group = r.group;
    n.groupCount = Math.max(2, groups);
  }

  // A short link squeezed between two corners may leave its stop line inside the road crossing ahead, where whoever
  // waits on it stands in the way of the traffic crossing there (of other roads, which share the junction with it).
  // Where the link comes off a bend (a shape node: nothing crosses there), its stop line goes back as far as that
  // takes, as long as a car waiting there still stands on the link (not around the bend, in the way of the next);
  // a link that can't keep clear even so is dropped.
  const inOf = new Map();
  for (const e of edges) {
    if (!inOf.has(e.to)) inOf.set(e.to, []);
    inOf.get(e.to).push(e);
  }
  const HALF_CAR = 2.3;
  const HALF_WIDE = 0.95;
  const pathPt = { x: 0, z: 0, dx: 0, dz: 1 };
  function inTheWay(e) {
    const n = e.to;
    sidesAndGroups(n);
    // a car standing at each of its lanes' stop line
    const cars = e.lanes.map((o) => [e.sx + e.dx * (e.len - HALF_CAR) + e.rx * o, e.sz + e.dz * (e.len - HALF_CAR) + e.rz * o]);
    for (const o of inOf.get(n)) {
      if (o === e || o.inArm.group === e.inArm.group) continue;
      for (const m of o.moves) {
        for (let i = 0; i < o.lanes.length; i++) {
          if (m.out[i] < 0) continue;
          const c = makeCurve(o, i, m.to, m.out[i]);
          for (let s = 0; s <= c.len; s += 1) {
            curvePoint(c, s, pathPt);
            for (const [cx, cz] of cars) {
              const dx = pathPt.x - cx;
              const dz = pathPt.z - cz;
              if (dx * dx + dz * dz > 36) continue;
              // how deep a car on the path overlaps it (separating axes)
              let depth = Infinity;
              for (const [ax, az] of [[e.dx, e.dz], [e.rx, e.rz], [pathPt.dx, pathPt.dz], [-pathPt.dz, pathPt.dx]]) {
                const ra = HALF_CAR * Math.abs(e.dx * ax + e.dz * az) + HALF_WIDE * Math.abs(e.rx * ax + e.rz * az);
                const rb = HALF_CAR * Math.abs(pathPt.dx * ax + pathPt.dz * az) + HALF_WIDE * Math.abs(pathPt.dz * ax - pathPt.dx * az);
                depth = Math.min(depth, ra + rb - Math.abs(dx * ax + dz * az));
              }
              if (depth > 0.25) return true;
            }
          }
        }
      }
    }
    return false;
  }
  const inTheWayOut = new Set();
  for (const e of edges) {
    if (!e.squeezed || !e.from.shape || !inTheWay(e)) continue;
    while (e.len > 6 && inTheWay(e)) e.len = Math.max(5.5, e.len - 1);
    if (inTheWay(e)) inTheWayOut.add(e); // even so
  }
  if (inTheWayOut.size) {
    edges = edges.filter((e) => !inTheWayOut.has(e));
    for (const e of edges) e.moves = e.moves.filter((m) => !inTheWayOut.has(m.to));
  }

  // 7. Keep the largest strongly connected set of edges so no vehicle can ever reach a dead end
  edges.forEach((e, i) => (e.id = i));
  const visited = new Uint8Array(edges.length);
  const order = [];
  for (const root of edges) {
    if (visited[root.id]) continue;
    visited[root.id] = 1;
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const e = top[0];
      if (top[1] < e.moves.length) {
        const f = e.moves[top[1]++].to;
        if (!visited[f.id]) {
          visited[f.id] = 1;
          stack.push([f, 0]);
        }
      } else {
        order.push(e);
        stack.pop();
      }
    }
  }
  const incoming = edges.map(() => []);
  for (const e of edges) for (const m of e.moves) incoming[m.to.id].push(e);
  const comp = new Int32Array(edges.length).fill(-1);
  let bestComp = -1;
  let bestSize = 0;
  for (let k = order.length - 1, c = 0; k >= 0; k--) {
    if (comp[order[k].id] >= 0) continue;
    const stack = [order[k]];
    comp[order[k].id] = c;
    let size = 0;
    while (stack.length) {
      const e = stack.pop();
      size++;
      for (const p of incoming[e.id]) {
        if (comp[p.id] < 0) {
          comp[p.id] = c;
          stack.push(p);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = c;
    }
    c++;
  }
  if (options.debug) {
    const sizes = new Map();
    for (const e of edges) sizes.set(comp[e.id], (sizes.get(comp[e.id]) || 0) + 1);
    options.debug.sccSizes = [...sizes.values()].sort((a, b) => b - a).slice(0, 12);
    options.debug.sccCount = sizes.size;
    options.debug.edgesBefore = edges.slice();
    options.debug.comp = comp;
    options.debug.bestComp = bestComp;
  }
  // Copenhagen keeps what only leads into or out of the main set too (one-way slip roads and stubs, roads cut by the
  // district's edge): vehicles start on the ones nothing leads to, and are taken off the ones that lead nowhere
  const keep = new Uint8Array(edges.length);
  {
    const mark = (starts, next) => {
      const stack = starts.slice();
      for (const e of stack) keep[e.id] = 1;
      while (stack.length) {
        for (const f of next(stack.pop())) {
          if (!keep[f.id]) {
            keep[f.id] = 1;
            stack.push(f);
          }
        }
      }
    };
    const main = edges.filter((e) => comp[e.id] === bestComp);
    mark(main, (e) => e.moves.map((m) => m.to));
    mark(main, (e) => incoming[e.id]);
    for (const e of edges) if (comp[e.id] === bestComp) keep[e.id] = 1;
  }
  const genShortKept = edges.filter((e) => e.general).length;
  const genLost = edges.filter((e) => e.general && !keep[e.id]);
  edges = edges.filter((e) => keep[e.id]);
  // Roads kept clear of a road merging with them or forking off them that is gone now (too short, or no way on from it
  // after all) get their stop lines placed again without it
  const kept = new Set(edges);
  const dropped = placed.filter((e) => e.live && !kept.has(e));
  if (dropped.length) {
    const redo = new Set();
    for (const e of dropped) {
      e.live = false;
      redo.add(e.from).add(e.to);
    }
    computeArms(placed, redo);
    for (const n of redo) if (!n.shape && bends(n)) n.shape = true;
    for (const e of edges) if (redo.has(e.from) || redo.has(e.to)) place(e);
  }
  console.info(`[roads] centreline edges: ${genCreated} with clear lanes, ${genShortKept} long enough, ${genShortKept - genLost.length} connected`);
  for (const e of edges) {
    e.moves = e.moves.filter((m) => keep[m.to.id]);
    serveEveryLane(e);
    // Lanes still leading nowhere (every curve out of them grazes a curb or obstacle): send them on to the nearest lane
    // of the straightest move anyway, so every lane always has a way on
    for (let i = 0; i < e.lanes.length; i++) {
      if (!e.moves.length || e.moves.some((m) => m.out[i] >= 0)) continue;
      const m = e.moves.find((q) => q.turn === 'S') || e.moves[0];
      m.out[i] = nearestLane(e, i, m.to);
    }
  }
  edges.forEach((e, i) => (e.id = i));

  for (const n of nodes) n.in = n.out = null;
  for (const e of edges) {
    (e.from.out || (e.from.out = [])).push(e);
    (e.to.in || (e.to.in = [])).push(e);
  }
  nodes = nodes.filter((n) => n.in || n.out);
  for (const n of nodes) {
    n.in = n.in || [];
    n.out = n.out || [];
  }
  nodes.forEach((n, i) => (n.id = i));

  // 9. Sides & right of way at each node, for traffic.js. Its arms are its sides (one crosswalk and approach each): a
  //    grid intersection keeps east 0, west 1, south 2, north 3, any other arm counts from 4. The arms of one road (on
  //    opposite sides) form a group: vehicles of different groups never share the intersection box, and group 0 has
  //    the right of way at unsignalised corners (and the avenue phase at signals): the avenue on the grid (north-south
  //    arms 0, east-west 1), the widest road at a centreline junction.
  computeArms(edges);
  for (const n of nodes) sidesAndGroups(n);
  // Copenhagen: each register signal belongs to the nearest real junction (three or more roads) within 25 m
  let signalsMatched = 0;
  {
    for (const s of signalIntersections) {
      let best = null;
      let bd = options.signalRadius ?? 25;
      for (const n of nodes) {
        if (n.shape || n.arms.filter((a) => a.lead === a).length < 3) continue;
        const d = Math.hypot(n.x - s.x, n.z - s.z);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      if (best) {
        if (!best.signal) signalsMatched++;
        best.signal = true;
      }
    }
  }
  for (const e of edges) {
    e.inSide = e.inArm.side; // the side of e.to it arrives over
    e.outSide = e.outArm.side; // the side of e.from it leaves over
    e.axisIndex = e.inArm.group; // its right-of-way group at e.to
    // lateral axis of its road, the same both ways (+x across north-south roads, +z across east-west ones)
    const flip = e.rx < -1e-6 || (Math.abs(e.rx) <= 1e-6 && e.rz < 0);
    e.clx = flip ? -e.rx : e.rx;
    e.clz = flip ? -e.rz : e.rz;
  }
  for (const e of edges) {
    e.opposite = e.to.in.find((o) => o !== e && o.axisIndex === e.axisIndex && o.dx * e.dx + o.dz * e.dz < -0.7) || null;
  }

  // Lane-to-lane curves are built on first use and cached
  const curves = new Map();
  function connector(e, i, f, j) {
    const k = ((e.id * 8 + i) * 16384 + f.id) * 8 + j;
    let c = curves.get(k);
    if (!c) curves.set(k, (c = makeCurve(e, i, f, j)));
    return c;
  }

  const stats = cphStats(options.roadGraph, edges, nodes, signalIntersections.length, signalsMatched);
  return {
    nodes, edges, paintEdges, connector, curvePoint, stats,
    extraOffset: options.extraOffset || null,
    obstruction: options.obstruction || null,
    walkable: options.walkable,
    onSidewalk: options.onSidewalk,
    isRoadClear: () => true
  };
}

// ---- Copenhagen centreline graph --------------------------------------------------------------------------------
// data/cph-geodata.json roadGraph: links [a, b, lanesFwd, lanesBack, width, speedKmh, nameIdx, classIdx, ...] run
// between consecutive OSM vertices. For the generic centreline code (section 4b) they are chained through vertices where
// just two similar vehicular links meet, into the junction-to-junction links with inner points it expects:
// [a, b, nameIdx, width, lanes, dir, inner, chainId].
const CPH_VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);
const CPH_LANE = 3.0;
// (carriagewayFromLanes: the data's width is a clamped kerb-to-kerb spacing, see road-width-cph.js)

function cphVehicularLinks(rg) {
  const out = [];
  rg.links.forEach((l, id) => {
    if (CPH_VEHICULAR.has(rg.classes[l[7]]) && l[0] !== l[1] && l[2] + l[3] > 0) out.push({ id, l });
  });
  return out;
}

function cphCentrelines(rg) {
  if (!rg) return null;
  const links = cphVehicularLinks(rg);
  const at = new Map(); // node -> [{ id, l, out }]
  const add = (n, rec) => {
    if (!at.has(n)) at.set(n, []);
    at.get(n).push(rec);
  };
  for (const { id, l } of links) {
    add(l[0], { id, l, from: l[0], to: l[1], along: l[2], against: l[3] });
    add(l[1], { id, l, from: l[1], to: l[0], along: l[3], against: l[2] });
  }
  // lanes in a link's own direction of travel `along` and against it
  const same = (p, q) => p.l[6] === q.l[6] && p.l[7] === q.l[7] && Math.abs(p.l[4] - q.l[4]) < 1.5;
  const through = (n, p) => {
    const here = at.get(n);
    if (!here || here.length !== 2) return null;
    const q = here[0].id === p.id ? here[1] : here[0];
    // q oriented to continue p: leaves n
    const next = q.from === n ? q : { id: q.id, l: q.l, from: n, to: q.from, along: q.against, against: q.along };
    const cur = p.from === n ? { ...p, from: p.to, to: p.from, along: p.against, against: p.along } : p;
    return cur.along === next.along && cur.against === next.against && same(p, q) ? next : null;
  };
  const used = new Set();
  const pos = (i) => [rg.nodes[2 * i], rg.nodes[2 * i + 1]];
  const out = [];
  let chainId = 0;
  function run(start) {
    const first = start;
    const inner = [];
    const members = [first.id];
    used.add(first.id);
    let cur = first;
    for (;;) {
      const n = cur.to;
      const next = through(n, cur);
      if (!next || used.has(next.id)) break;
      used.add(next.id);
      members.push(next.id);
      inner.push(...pos(n));
      cur = next;
    }
    const w = first.l[4];
    const cls = rg.classes[first.l[7]];
    out.push({ a: first.from, b: cur.to, ni: first.l[6], w, along: first.along, against: first.against, inner, cls, chain: { id: chainId++, links: members.length, measured: rg.layout === 'cph-streets/1' } });
  }
  // start every chain at a vertex that is not a through vertex, then close up whatever rings remain
  for (const [n, recs] of at) {
    for (const r of recs) {
      if (used.has(r.id)) continue;
      const cont = recs.length === 2 ? through(n, r.from === n ? { id: r.id, l: r.l, from: r.to, to: r.from, along: r.against, against: r.along } : r) : null;
      if (!cont) run(r.from === n ? r : { id: r.id, l: r.l, from: n, to: r.from, along: r.against, against: r.along });
    }
  }
  for (const [n, recs] of at) {
    for (const r of recs) if (!used.has(r.id)) run(r.from === n ? r : { id: r.id, l: r.l, from: n, to: r.from, along: r.against, against: r.along });
  }
  // A loop (a courtyard lane returning to its own junction) is split at its middle vertex, so it has two ends
  const nodes = Array.from(rg.nodes);
  for (const c of out.slice()) {
    if (c.a !== c.b || c.inner.length < 4) continue;
    const m = (c.inner.length / 4 | 0) * 2; // the middle inner vertex
    const id = nodes.length / 2;
    nodes.push(c.inner[m], c.inner[m + 1]);
    const tail = { ...c, a: id, inner: c.inner.slice(m + 2), chain: { ...c.chain, links: 0 } };
    c.b = id;
    c.inner = c.inner.slice(0, m);
    out.push(tail);
  }
  return {
    nodes,
    names: rg.names,
    links: out.map((c) => [c.a, c.b, c.ni, c.w, Math.max(c.along, c.against), c.along && c.against ? 0 : c.along ? 1 : -1, c.inner,
      { ...c.chain, cls: c.cls, along: c.along, against: c.against }])
  };
}

// Lanes and widths of one chained link: CPH_LANE wide, one-way lanes centred on the centreline, two-way ones from half a
// lane right of it
function cphLanes(l) {
  const info = l.chain;
  const major = info.cls === 'primary' || info.cls === 'secondary';
  const oneWay = (n) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * CPH_LANE);
  const twoWay = (n) => Array.from({ length: n }, (_, i) => CPH_LANE / 2 + i * CPH_LANE);
  const nf = Math.min(4, info.along);
  const nb = Math.min(4, info.against);
  // a measured link width (street layout: the survey's kerb-to-kerb carriageway) is used as it is; the legacy data width is
  // a clamped spacing and is capped by what the lanes need
  const width = info.measured ? Math.max(3, Math.min(l.w, 30)) : carriagewayFromLanes(l.w, info.along + (l.dir === 0 ? info.against : 0), info.cls);
  if (l.dir !== 0) {
    const lanes = oneWay(l.dir > 0 ? nf : nb);
    return { half: Math.max(width / 2, lanes.length * CPH_LANE / 2), axis: major ? 'ave' : 'st', fwd: l.dir > 0 ? lanes : [], back: l.dir < 0 ? lanes : [] };
  }
  const half = Math.max(width / 2, Math.max(nf, nb) * CPH_LANE);
  return { half, axis: major ? 'ave' : 'st', fwd: twoWay(nf), back: twoWay(nb) };
}

// How much of the vehicular graph the network drives: the share of graph links whose chain kept at least one edge
function cphStats(rg, edges, nodes, signals, matched) {
  const links = cphVehicularLinks(rg);
  const centrelines = cphCentrelines(rg);
  const kept = new Set(edges.map((e) => e.chain?.id));
  // links shorter than 14 m are folded into their junction: usable when a driven junction stands there
  const driven = nodes.filter((n) => !n.shape);
  const nearJunction = (i) => driven.some((n) => Math.hypot(n.x - rg.nodes[2 * i], n.z - rg.nodes[2 * i + 1]) < 20);
  let usable = 0;
  let total = 0;
  for (const link of centrelines.links) {
    const info = link[7];
    total += info.links;
    let length = 0;
    let px = rg.nodes[2 * link[0]];
    let pz = rg.nodes[2 * link[0] + 1];
    const inner = link[6];
    for (let k = 0; k <= inner.length; k += 2) {
      const x = k < inner.length ? inner[k] : rg.nodes[2 * link[1]];
      const z = k < inner.length ? inner[k + 1] : rg.nodes[2 * link[1] + 1];
      length += Math.hypot(x - px, z - pz);
      px = x;
      pz = z;
    }
    if (kept.has(info.id) || (length < 14 && nearJunction(link[0]))) usable += info.links;
  }
  return { vehicularLinks: links.length, chains: centrelines.links.length, linkTotal: total, linkUsable: usable, usableShare: usable / Math.max(1, total), signals, signalsMatched: matched };
}

// The largest strongly connected set of `list` (a Set), going on from item e to the items next(e)
function largestComponent(list, next) {
  const index = new Map(list.map((e, i) => [e, i]));
  const succ = list.map((e) => next(e).map((f) => index.get(f)).filter((j) => j !== undefined));
  const pred = list.map(() => []);
  succ.forEach((s, i) => {
    for (const j of s) pred[j].push(i);
  });
  // Kosaraju: finishing order going forwards, then components going backwards from the last finished
  const visited = new Uint8Array(list.length);
  const order = [];
  for (let root = 0; root < list.length; root++) {
    if (visited[root]) continue;
    visited[root] = 1;
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] < succ[top[0]].length) {
        const j = succ[top[0]][top[1]++];
        if (!visited[j]) {
          visited[j] = 1;
          stack.push([j, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Int32Array(list.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  for (let k = order.length - 1, c = 0; k >= 0; k--) {
    if (comp[order[k]] >= 0) continue;
    const stack = [order[k]];
    comp[order[k]] = c;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (const p of pred[i]) {
        if (comp[p] < 0) {
          comp[p] = c;
          stack.push(p);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  return new Set(list.filter((_, i) => comp[i] === best));
}

// Cubic Bézier from the end of lane i on edge e to the start of lane j on edge f: a quarter-circle-like
// arc around the corner for turns, an S-bend for straight lane shifts. Includes an arc-length table and
// the sharpest curvature along it (1 / tightest radius).
function makeCurve(e, i, f, j) {
  const x0 = e.sx + e.dx * e.len + e.rx * e.lanes[i];
  const z0 = e.sz + e.dz * e.len + e.rz * e.lanes[i];
  const x3 = f.sx + f.rx * f.lanes[j];
  const z3 = f.sz + f.rz * f.lanes[j];
  const cross = e.dx * f.dz - e.dz * f.dx;
  let k0;
  let k3;
  if (e.dx * f.dx + e.dz * f.dz < -0.9) {
    k0 = k3 = Math.max(4, Math.hypot(x3 - x0, z3 - z0) * 1.5); // a U-turn bulges out ahead
  } else if (Math.abs(cross) < 0.5) {
    k0 = k3 = Math.hypot(x3 - x0, z3 - z0) / 3;
  } else {
    const t = ((x3 - x0) * f.dz - (z3 - z0) * f.dx) / cross;
    k0 = 0.552 * Math.abs(t);
    k3 = 0.552 * Math.hypot(x3 - (x0 + e.dx * t), z3 - (z0 + e.dz * t));
  }
  const c = {
    x0, z0, x3, z3,
    x1: x0 + e.dx * k0, z1: z0 + e.dz * k0,
    x2: x3 - f.dx * k3, z2: z3 - f.dz * k3,
    lut: new Float32Array(17),
    len: 0,
    curv: 0
  };
  let px = x0;
  let pz = z0;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * x3;
    const z = u * u * u * z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * z3;
    c.len += Math.hypot(x - px, z - pz);
    c.lut[k] = c.len;
    px = x;
    pz = z;
    const dx = 3 * u * u * (c.x1 - x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (x3 - c.x2);
    const dz = 3 * u * u * (c.z1 - z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (z3 - c.z2);
    const ddx = 6 * u * (c.x2 - 2 * c.x1 + x0) + 6 * t * (x3 - 2 * c.x2 + c.x1);
    const ddz = 6 * u * (c.z2 - 2 * c.z1 + z0) + 6 * t * (z3 - 2 * c.z2 + c.z1);
    c.curv = Math.max(c.curv, Math.abs(dx * ddz - dz * ddx) / Math.max(1e-6, Math.hypot(dx, dz) ** 3));
  }
  return c;
}

// Position and unit tangent at arc length s along a curve
function curvePoint(c, s, out) {
  let k = 1;
  while (k < 16 && c.lut[k] < s) k++;
  const s0 = c.lut[k - 1];
  const s1 = c.lut[k];
  const t = (k - 1 + Math.min(1, Math.max(0, (s - s0) / (s1 - s0 || 1)))) / 16;
  const u = 1 - t;
  out.x = u * u * u * c.x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x3;
  out.z = u * u * u * c.z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * c.z3;
  const dx = 3 * u * u * (c.x1 - c.x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (c.x3 - c.x2);
  const dz = 3 * u * u * (c.z1 - c.z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (c.z3 - c.z2);
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l;
  out.dz = dz / l;
  return out;
}

/**
 * The road graph without the service links whose driven strip runs through a building: a gateway, a covered yard lane or a passage
 * narrower than its lanes, which the footprints close
 * (the twin draws the building solid there), so a vehicle on it would stand in the walls and its collision body would push against
 * them forever. `inBuilding(x, z)` is js/walk-space-cph.js's footprint test. Streets of the other classes are kept as they are.
 */
function dropCoveredServiceLinks(rg, inBuilding) {
  if (!rg || typeof inBuilding !== 'function') return rg;
  const service = rg.classes.indexOf('service');
  if (service < 0) return rg;
  // the strip a car sweeps on the link: a one-way lane is centred (0.95 m half car + 0.1), two-way lanes sit 1.5 m either side
  const through = (l) => {
    const ax = rg.nodes[2 * l[0]], az = rg.nodes[2 * l[0] + 1], bx = rg.nodes[2 * l[1]], bz = rg.nodes[2 * l[1] + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (!(len > 0)) return false;
    const half = l[2] > 0 && l[3] > 0 ? CPH_LANE / 2 + 1.05 : 1.05;
    const rx = -(bz - az) / len, rz = (bx - ax) / len;
    let run = 0;
    for (let s = 0; s <= len; s += 0.5) {
      const x = ax + (bx - ax) * s / len, z = az + (bz - az) * s / len;
      const walled = inBuilding(x, z) || inBuilding(x + rx * half, z + rz * half) || inBuilding(x - rx * half, z - rz * half);
      run = walled ? run + 0.5 : 0;
      if (run >= 1) return true;
    }
    return false;
  };
  const links = rg.links.filter((l) => l[7] !== service || !through(l));
  return links.length === rg.links.length ? rg : { ...rg, links };
}

export { buildRoadNetwork, CROSSWALK, cphCentrelines, dropCoveredServiceLinks };
