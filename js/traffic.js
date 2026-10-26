import * as THREE from 'three/webgpu';
import { CAR_BODY_TYPES, fleetRandom, fleetVehicle } from './vehicle-fleet.js';
import { buildRoadNetwork } from './road-network.js';
import { createPedestrianSystem } from './pedestrian-system.js';
import { signalOffset, vehiclePhase, walkPhase } from './signal-plan.js';
import { cityUniforms, createContactShadowMaterial, createCarFlareMaterial } from './tsl-materials.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import {
  BODY_SPECS,
  BUS_SPEC,
  BUS_LONG_SPEC,
  buildCarGeometry,
  buildCarProxyGeometry,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildLoftedBusBodyGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial
} from './actor-models.js';

// js/traffic.js
// Copenhagen traffic and pedestrians on the road graph road-network.js derives from the centreline graph:
// - 120 cars (European crossovers, hatchbacks, estates, vans and taxis) and 12 buses keep to their lanes and follow the vehicle
//   ahead (Intelligent Driver Model), change lanes to overtake or to reach a turn lane, turn into other streets,
//   stop for the signals at the junctions the register places (signal-plan.js), give way to oncoming traffic when
//   turning left, to the main road at unsignalized corners and to pedestrians on crosswalks, and never enter an
//   intersection they can't clear.
// - Pedestrians follow connected sidewalks, meet to talk, and cross signalized crosswalks on WALK.
// - Fixed-size local populations replenish distant roads and sidewalks in every direction, protecting the near view.
// - The player's vehicle or character pushes and is pushed by the traffic (SAT contact, impulses, sparks).

const NUM_CARS = 120;
const NUM_BUSES = 12;
const JAM_WAIT = 100; // s

// Intelligent Driver Model: max acceleration, comfortable braking, time headway, standstill gap; and the sideways
// acceleration drivers accept in bends, which sets how fast they take each turn or lane shift
const CAR_DRIVER = { a: 2.0, b: 3.0, T: 1.2, s0: 2.0, aLat: 3.5 };
const BUS_DRIVER = { a: 1.1, b: 2.5, T: 1.5, s0: 2.5, aLat: 2.0 };
const LOOKAHEAD = 70; // metres a driver looks ahead for vehicles, stop lines and signals

// Retire distant actors even when looking their way: keeping them indefinitely starves upcoming streets.
// Replacements may enter the far view, but nearby visible roads and sidewalks are protected from pop-in.
const VEHICLE_RADIUS = 380;
const NEAR_RADIUS = 350;
const VEHICLE_SPAWN_DISTANCE = 250;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// `options`: { roadGraph, walkable, onSidewalk, blockAt, extraOffset, debug } as road-network.js and the pedestrian
// system take them. Cars and buses drive on the signals' fixed-time plans (signal-plan.js) at the junctions the
// register places.
function createTrafficSystem(scene, signalIntersections, options = {}) {
  const group = new THREE.Group();
  group.name = 'TrafficAndPedestrians';
  let collisionListener = null;
  const collisionEvent = { a: null, b: null, kind: 'vehicle', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };

  function setCollisionListener(listener) {
    collisionListener = typeof listener === 'function' ? listener : null;
  }

  // Synchronous notification: listeners must copy any fields they retain. Normal points from b toward a.
  function reportCollision(a, b, x, y, z, nx, nz, speed) {
    if (!collisionListener || speed <= 0.5) return;
    collisionEvent.a = a; collisionEvent.b = b;
    collisionEvent.x = x; collisionEvent.y = y; collisionEvent.z = z;
    collisionEvent.nx = nx; collisionEvent.nz = nz; collisionEvent.speed = speed;
    collisionListener(collisionEvent);
  }

  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);
  const contactShadowMat = createContactShadowMaterial();

  // =========================================================================
  // 0. ROAD NETWORK
  // =========================================================================
  // Vehicles rest on the terrain (js/terrain-cph.js via the scene's ground model); 0 on the flat plane
  const groundAt = (x, z) => (options.groundHeight ? options.groundHeight.terrainAt(x, z) : 0);
  let network = null;
  let nodes = [];
  let edges = [];
  let connector = null;
  let curvePoint = null;

  // Where lane i of edge e meets a crosswalk, measured along the crosswalk: along its road's lateral axis
  const laneCoord = (e, i) => (e.sx + e.rx * e.lanes[i]) * e.clx + (e.sz + e.rz * e.lanes[i]) * e.clz;

  // The road network can be swapped while the system runs (setNetwork): a streamed city keeps the network of the region around the camera.
  function bindNetwork(net) {
    network = net;
    ({ nodes, edges, connector, curvePoint } = net);
    for (const n of nodes) {
      n.sigOffset = signalOffset(n.x, n.z);
      n.sideGroup = [];
      for (const a of n.arms || []) n.sideGroup[a.side] = a.group;
      n.box = new Array(n.groupCount).fill(0); // vehicles crossing it from each road (group: the widest road is 0)
      n.crossing = new Array(n.sideCount).fill(0); // vehicles crossing (or about to cross) the crosswalk on each side
      n.approach = new Array(n.sideCount).fill(null); // the edge arriving over each side's crosswalk
      n.road = new Array(n.sideCount).fill(null); // an edge arriving or leaving over each side's crosswalk: the road it spans
    }
    for (const e of edges) {
      e.occ = e.lanes.map(() => []); // vehicles in each lane, sorted by position
      // e.inSide / e.outSide: the crosswalks crossed on the way into e.to / out of e.from; e.axisIndex: its group at e.to;
      // e.opposite: the oncoming edge of its road there (road-network.js)
      e.to.approach[e.inSide] = e;
      e.to.road[e.inSide] = e.from.road[e.outSide] = e;
      e.through = 0; // vehicles from e crossing e.to straight on or to the right
      e.lefts = 0; // and to the left
    }
  }
  bindNetwork(options.network || buildRoadNetwork(signalIntersections, options));

  // Is the intersection box held by vehicles of any road but group g's?
  const boxBusy = (n, g) => {
    for (let k = 0; k < n.box.length; k++) if (k !== g && n.box[k] > 0) return true;
    return false;
  };

  // =========================================================================
  // 1. 3D LOFTED SEDANS & SUVS (120 VEHICLES)
  // =========================================================================
  function createVehicle(bus, half, halfWidth, axle, driver, v0) {
    return {
      bus, half, halfWidth, axle, driver, v0,
      edge: null, lane: 0, s: 0, speed: 0, acc: 0, gap: Infinity, leaderSpeed: 0,
      move: null, out: 0, conn: null, cs: 0, trail: null, commit: null, claimed: false, yielding: false, yieldAt: 0,
      wait: 0, laneTimer: Math.random() * 0.5,
      dl: 0, dlv: 0, blink: 0, blinkPhase: Math.random() * 0.8,
      x: 0, z: 0, prevX: 0, prevZ: 0, tx: 0, tz: 1, nose: 0, yaw: 0, yawRate: 0, steer: 0,
      pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, vx: 0, vz: 0, yawOffset: 0, yawVel: 0,
      pAhead: Infinity, pRight: 0, pSpeed: 0, wheelSpin: Math.random() * Math.PI * 2
    };
  }

  const wheelSpec = BODY_SPECS.crossoverEV;
  const carWheelLeftGeo = buildSteerableWheelGeo(wheelSpec, -1);
  const carWheelRightGeo = buildSteerableWheelGeo(wheelSpec, 1);
  const carWheelMat = createLoftedCarMaterial(wheelSpec, 0x777d81);
  const cars = [];
  const bodyCounts = Object.fromEntries(CAR_BODY_TYPES.map((kind) => [kind, 0]));
  for (let i = 0; i < NUM_CARS; i++) {
    const choice = fleetVehicle(fleetRandom(i, 0), fleetRandom(i, 1), fleetRandom(i, 2));
    const bodyType = choice.body;
    const spec = BODY_SPECS[bodyType];
    const col = new THREE.Color(choice.paint);
    const paint = [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)];
    const car = createVehicle(false, spec.length / 2, spec.width / 2, spec.wheelZ, CAR_DRIVER, 10 + (i % 5) * 0.9);
    Object.assign(car, { bodyType, paint, taxi: choice.taxi, massRatio: spec.massRatio });
    bodyCounts[bodyType]++;
    cars.push(car);
  }

  const bodies = {};
  for (const kind of CAR_BODY_TYPES) {
    const spec = BODY_SPECS[kind];
    const mat = createLoftedCarMaterial(spec);
    const n = Math.max(1, bodyCounts[kind]);
    const lodMesh = (g, lod) => {
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.name = `traffic-${kind}-${lod}`;
      return mesh;
    };
    bodies[kind] = { near: lodMesh(buildCarGeometry(spec, false), 'near'), far: lodMesh(buildCarProxyGeometry(spec), 'far') };
  }
  const bodyMeshes = Object.values(bodies).flatMap((b) => [b.near, b.far]);
  const carWheelLeftInst = new THREE.InstancedMesh(carWheelLeftGeo, carWheelMat, NUM_CARS * 2);
  const carWheelRightInst = new THREE.InstancedMesh(carWheelRightGeo, carWheelMat, NUM_CARS * 2);

  // 3D Collision Spark & Debris Particle Pool
  const MAX_SPARKS = 120;
  const sparkGeo = new THREE.BoxGeometry(0.038, 0.038, 0.26);
  const sparkMat = new THREE.MeshBasicNodeMaterial({ color: 0xffc438 });
  const sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  const sparks = [];
  let sparkCursor = 0;
  for (let s = 0; s < MAX_SPARKS; s++) {
    sparks.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.4 });
  }
  function spawnCollisionSparks(x, y, z, nx, nz, impactSpeed) {
    const count = Math.min(24, Math.max(8, Math.floor(impactSpeed * 1.4)));
    const tx = -nz;
    const tz = nx;
    for (let k = 0; k < count; k++) {
      const sp = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
      const spread = (Math.random() - 0.5) * 2.2;
      const outBoost = (0.3 + Math.random() * 0.9) * Math.min(14.0, impactSpeed * 0.65);
      const tanBoost = spread * Math.min(12.0, impactSpeed * 0.55);
      sp.x = x + (Math.random() - 0.5) * 0.35;
      sp.y = y + (Math.random() - 0.5) * 0.18;
      sp.z = z + (Math.random() - 0.5) * 0.35;
      sp.floor = groundAt(x, z);
      sp.vx = nx * outBoost + tx * tanBoost;
      sp.vy = 2.4 + Math.random() * 5.4;
      sp.vz = nz * outBoost + tz * tanBoost;
      sp.maxLife = 0.28 + Math.random() * 0.24;
      sp.life = sp.maxLife;
    }
  }

  const carShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_CARS);
  carShadowInst.renderOrder = 998;

  for (const { near, far } of Object.values(bodies)) {
    near.castShadow = true;
    near.receiveShadow = far.receiveShadow = true;
  }
  carWheelLeftInst.castShadow = carWheelLeftInst.receiveShadow = true;
  carWheelRightInst.castShadow = carWheelRightInst.receiveShadow = true;

  group.add(
    ...bodyMeshes,
    carWheelLeftInst,
    carWheelRightInst,
    sparkInst
  );

  // =========================================================================
  // 2. LOFTED CITY BUSES (12 BUSES)
  // =========================================================================
  const busSets = {};
  for (const spec of [BUS_SPEC, BUS_LONG_SPEC]) {
    const capacity = Math.ceil(NUM_BUSES / 2);
    const geo = buildLoftedBusBodyGeometry(spec);
    const states = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    geo.setAttribute('busState', states);
    const body = new THREE.InstancedMesh(geo, createLoftedBusMaterial(spec), capacity);
    body.name = spec.name;
    body.castShadow = body.receiveShadow = true;
    busSets[spec.name] = { body, states, count: 0 };
    group.add(body);
  }
  const busBodyMeshes = Object.values(busSets).map((b) => b.body);
  const busWheelMat = createBusWheelMaterial();
  const busWheelLeftInst = new THREE.InstancedMesh(buildBusWheelGeo(-1), busWheelMat, NUM_BUSES * 3);
  const busWheelRightInst = new THREE.InstancedMesh(buildBusWheelGeo(1), busWheelMat, NUM_BUSES * 3);
  const busShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_BUSES);
  busShadowInst.renderOrder = 998;
  busWheelLeftInst.castShadow = busWheelLeftInst.receiveShadow = true;
  busWheelRightInst.castShadow = busWheelRightInst.receiveShadow = true;

  const buses = [];
  for (let i = 0; i < NUM_BUSES; i++) {
    const spec = i % 2 ? BUS_LONG_SPEC : BUS_SPEC;
    const bus = createVehicle(true, spec.length / 2 + 0.2, spec.width / 2, spec.wheelZ, BUS_DRIVER, 8 + (i % 3));
    Object.assign(bus, { spec, massRatio: spec.massRatio });
    buses.push(bus);
  }
  const vehicles = [...cars, ...buses];
  group.add(busWheelLeftInst, busWheelRightInst);

  // =========================================================================
  // 3. PEDESTRIAN SYSTEM
  // =========================================================================
  const player = { active: false, entity: null, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1,
    halfW: 0.86, halfL: 2.18, push: 0.5 };
  const nearEdges = [];
  const nearSignals = [];
  const pedestrianSystem = createPedestrianSystem(network, {
    player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView, blockAt: options.blockAt, groundHeight: options.groundHeight
  });
  group.add(...pedestrianSystem.meshes);

  // Add vehicle contact shadows last + pre-allocated Clustered SpotLight / PointLight pools
  group.add(carShadowInst, busShadowInst);

  const HEADLIGHT_POOL_SIZE = 96;
  const MAX_LIGHT_DIST = 115;
  const MAX_LIGHT_DIST_SQ = MAX_LIGHT_DIST * MAX_LIGHT_DIST;
  const DUAL_BEAM_DIST_SQ = 96 * 96;
  const DUAL_BEAM_MAX_VEHICLES = 44;

  const trafficLightsGroup = new THREE.Group();
  trafficLightsGroup.name = 'TrafficClusteredLights';
  group.add(trafficLightsGroup);

  const headlightPool = [];
  for (let i = 0; i < HEADLIGHT_POOL_SIZE; i++) {
    const spot = createVehicleHeadlight();
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    trafficLightsGroup.add(spot, spot.target);
    headlightPool.push(spot);
  }

  // Nothing shows until it has been placed
  const carInstances = [...bodyMeshes, carWheelLeftInst, carWheelRightInst, carShadowInst];
  const busInstances = [...busBodyMeshes, busWheelLeftInst, busWheelRightInst, busShadowInst];
  for (const inst of [...carInstances, ...busInstances, sparkInst]) {
    inst.frustumCulled = false;
    for (let i = 0; i < inst.count; i++) inst.setMatrixAt(i, zero);
  }

  scene.add(group);

  // =========================================================================
  // 4. WHO IS WHERE: LANE OCCUPANCY, INTERSECTIONS, VIEW, PLAYER
  // =========================================================================
  let clock = 0;
  const phaseOf = (e) => vehiclePhase(e.to.sigOffset, e.axisIndex, clock);
  let focusX = 0;
  let focusZ = 140;

  // Lane lists hold pooled { v, s } entries sorted by position s along the lane, rebuilt every frame
  const pool = [];
  let poolUsed = 0;
  const filled = [];
  function occupy(list, v, s) {
    let o = pool[poolUsed++];
    if (!o) pool.push((o = { v: null, s: 0 }));
    o.v = v;
    o.s = s;
    if (!list.length) filled.push(list);
    list.push(o);
    for (let k = list.length - 1; k > 0 && list[k - 1].s > s; k--) {
      list[k] = list[k - 1];
      list[k - 1] = o;
    }
  }

  // Half way through a lane change a vehicle still occupies the lane it is leaving (-1 left, 1 right)
  function straddle(v) {
    if (v.conn) return 0;
    if (v.dl > 0.5 && v.lane + 1 < v.edge.lanes.length) return 1;
    if (v.dl < -0.5 && v.lane > 0) return -1;
    return 0;
  }

  // A vehicle crossing an intersection, or committed to crossing it, holds it against crossing traffic and
  // pedestrians on the crosswalks it passes, and its place in the lane it heads for. The counters it raises are reset
  // next frame for just the nodes and edges touched (a few hundred out of thousands)
  const touchedNodes = [];
  const touchedEdges = [];
  const touchNode = (n) => {
    if (!n.touched) {
      n.touched = true;
      touchedNodes.push(n);
    }
    return n;
  };
  const touchEdge = (e) => {
    if (!e.touched) {
      e.touched = true;
      touchedEdges.push(e);
    }
    return e;
  };
  function claim(v) {
    if (v.claimed) return;
    v.claimed = true;
    const e = v.edge;
    const f = v.move.to;
    touchNode(e.to).box[e.axisIndex]++;
    if (!v.conn || v.cs < v.half + 2.5) e.to.crossing[e.inSide]++; // until its tail is past the crosswalk on its way in
    if (v.move.turn !== 'L') touchEdge(e).through++;
    if (!v.yielding) cross(v);
    occupy(f.occ[v.out], v, v.conn ? v.cs - v.conn.len : v.s - e.len - connector(e, v.lane, f, v.out).len);
  }

  // ...and, unless still waiting inside to turn left, the oncoming lanes and the crosswalk on its way out
  function cross(v) {
    const e = v.edge;
    if (v.move.turn === 'L') touchEdge(e).lefts++;
    touchNode(e.to).crossing[v.move.to.outSide]++;
    v.yielding = false;
  }

  function buildOccupancy() {
    for (const list of filled) list.length = 0;
    filled.length = 0;
    poolUsed = 0;
    for (const n of touchedNodes) {
      n.box.fill(0);
      n.crossing.fill(0);
      n.touched = false;
    }
    touchedNodes.length = 0;
    for (const e of touchedEdges) {
      e.through = e.lefts = 0;
      e.touched = false;
    }
    touchedEdges.length = 0;
    for (const v of vehicles) v.claimed = false;
    for (const v of vehicles) {
      const e = v.edge;
      if (!e) continue;
      if (!v.conn) {
        occupy(e.occ[v.lane], v, v.s);
        const side = straddle(v);
        if (side) occupy(e.occ[v.lane + side], v, v.s);
        if (v.commit === e.to) claim(v);
        if (v.s < v.half) touchNode(e.from).crossing[e.outSide]++; // its tail still over the crosswalk behind it
      } else {
        claim(v);
        occupy(e.occ[v.lane], v, e.len + v.cs); // until it is out of the intersection, still ahead of those behind it
      }
    }
  }

  // The camera's view, for drawing and protecting nearby spawn locations
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  let hasView = false;
  let camX = 0;
  let camY = 10;
  let camZ = 140;
  let camFwdX = 0;
  let camFwdZ = 1;
  function updateView(camera) {
    hasView = !!camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    camX = camera.position.x;
    camY = camera.position.y;
    camZ = camera.position.z;
    const me = camera.matrixWorld.elements;
    camFwdX = -me[8];
    camFwdZ = -me[10];
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }
  // Could the camera see a sphere of radius r around ground point (x, z)? Side planes only: the near and far
  // planes depend on depth conventions, and the side planes alone already rule out everything behind the camera.
  function visible(x, z, r) {
    if (!hasView) return false;
    for (let k = 0; k < 4; k++) {
      const { normal, constant } = frustum.planes[k];
      if (normal.x * x + normal.y + normal.z * z + constant < -r) return false;
    }
    return true;
  }

  function nearView(x, z, radius, distance) {
    return hasView && Math.hypot(x - camX, camY, z - camZ) < distance && visible(x, z, radius);
  }

  // Edges and signalized intersections around the focus, to place vehicles and pedestrians on
  let nearX = Infinity;
  let nearZ = Infinity;
  function refreshNear() {
    if (Math.hypot(focusX - nearX, focusZ - nearZ) < 40) return;
    nearX = focusX;
    nearZ = focusZ;
    nearEdges.length = 0;
    nearSignals.length = 0;
    for (const e of edges) {
      const s = clamp((focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz, 0, e.len);
      const dx = e.sx + e.dx * s - focusX, dz = e.sz + e.dz * s - focusZ;
      if (dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearEdges.push(e);
    }
    for (const n of nodes) {
      const dx = n.x - focusX, dz = n.z - focusZ;
      if (n.signal && dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearSignals.push(n);
    }
  }

  // Where the player is relative to v: metres ahead, metres to the right, and how fast it moves v's way
  function relateToPlayer(v) {
    v.pAhead = Infinity;
    if (!player.active) return;
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (Math.abs(dx) > LOOKAHEAD + 10 || Math.abs(dz) > LOOKAHEAD + 10) return;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    v.pAhead = dx * fx + dz * fz;
    v.pRight = dz * fx - dx * fz;
    v.pSpeed = Math.max(0, player.vx * fx + player.vz * fz);
  }

  // Gap to the player if it is ahead in the lane whose centre is `off` metres to the right of v
  function playerGap(v, off) {
    if (v.pAhead < 0 || v.pAhead > LOOKAHEAD) return Infinity;
    if (Math.abs(v.pRight - off) > v.halfWidth + player.halfW + 0.4) return Infinity;
    return v.pAhead - v.half - player.halfL;
  }

  // =========================================================================
  // 5. DRIVING
  // =========================================================================
  // The lane nearest to `lane` that move m can be made from (m.out[i] is the lane lane i leads to, or -1)
  function nearestLane(m, lane) {
    let best = -1;
    for (let i = 0; i < m.out.length; i++) {
      if (m.out[i] >= 0 && (best < 0 || Math.abs(i - lane) < Math.abs(best - lane))) best = i;
    }
    return best;
  }

  // First vehicle ahead of position s in a lane list
  function ahead(list, s, v) {
    for (const o of list) if (o.s > s && o.v !== v) return o;
    return null;
  }

  // The front-most vehicle still approaching the end of a lane: not crossing at its end yet, though maybe still coming
  // out of the intersection at its start (at s < 0)
  function leadOf(list) {
    for (let k = list.length - 1; k >= 0; k--) if (!list[k].v.conn || list[k].s < 0) return list[k];
    return null;
  }

  // Intelligent Driver Model: acceleration on a free road, and the braking term for an obstacle `gap` metres
  // (bumper to bumper) ahead moving at `speed`
  const freeAcc = (v) => v.driver.a * (1 - (v.speed / v.v0) ** 4);
  function brake(v, gap, speed, s0 = v.driver.s0, T = v.driver.T) {
    const { a, b } = v.driver;
    const desired = s0 + Math.max(0, v.speed * T + (v.speed * (v.speed - speed)) / (2 * Math.sqrt(a * b)));
    return -a * (desired / Math.max(gap, 0.1)) ** 2;
  }
  // ...and for a line d metres ahead to stop s0 short of: no time gap to keep to a line
  const stopAt = (v, d, s0 = 1) => brake(v, d, 0, s0, 0);

  // Braking for the vehicle ahead of position s in a lane list; remembers the nearest one
  function follow(v, list, s) {
    const o = ahead(list, s, v);
    if (!o) return 0;
    const gap = o.s - o.v.half - s - v.half;
    if (gap > LOOKAHEAD) return 0;
    if (gap < v.gap) {
      v.gap = gap;
      v.leaderSpeed = o.v.speed;
    }
    return brake(v, gap, o.v.speed);
  }

  // Can v, d metres before a line, still stop at it braking no harder than its driver comfortably does?
  const canStopBefore = (v, d) => freeAcc(v) + stopAt(v, d) > -v.driver.b;

  // Braking for a red (or an amber with room to stop) at the end of edge f, `d` metres ahead
  function signalAhead(v, f, d) {
    if (!f.to.signal || d > LOOKAHEAD) return 0;
    const phase = phaseOf(f);
    if (phase === 'green' || (phase === 'amber' && !canStopBefore(v, d))) return 0;
    return stopAt(v, d);
  }

  // Mostly straight on, sometimes a turn (buses keep to wide roads). Routes don't follow the camera;
  // distant vehicles are recycled instead. With `fromLane`, only moves the current lane allows.
  const weights = [];
  function chooseMove(v, fromLane) {
    const e = v.edge;
    let total = 0;
    for (let k = 0; k < e.moves.length; k++) {
      const m = e.moves[k];
      let w = m.turn === 'S' ? (v.bus ? 8 : 3) : 1;
      if (v.bus && m.turn !== 'S' && m.to.lanes.length < 2) w *= 0.05;
      if (fromLane) {
        if (m.out[v.lane] < 0) w = 0;
      } else if (Math.abs(nearestLane(m, v.lane) - v.lane) * 22 > e.len - v.s) {
        w *= 0.02; // too little road left to change lanes for it
      }
      weights[k] = w;
      total += w;
    }
    let r = Math.random() * total;
    let pick = null;
    for (let k = 0; k < e.moves.length; k++) {
      if (weights[k] <= 0) continue;
      pick = e.moves[k];
      r -= weights[k];
      if (r < 0) break;
    }
    // No move from this lane (a lane the road graph couldn't lead anywhere): take any move, changing lanes for it
    if (!pick && fromLane) return chooseMove(v, false);
    return pick || e.moves[0] || null;
  }

  // Could the vehicle of lane entry o, approaching the end of edge a, still stop easily before its line? Vehicles
  // already standing can; drivers who have been waiting a while accept any gap it can still stop for comfortably.
  function canStop(o, a, impatient) {
    const sp = o.v.speed;
    if (sp < 0.5) return true;
    const d = a.len - o.s - o.v.half;
    return impatient ? canStopBefore(o.v, d) : d > (sp * sp) / 5 + sp + 3;
  }

  // A left turn waits for oncoming traffic going straight or right (approach o); vehicles not on o yet haven't picked
  // their way on, and at a red, only those already committed to crossing still come. Waiting at the line, v
  // also takes turns with those waiting at theirs: whoever has waited longer goes first, if it has room to go.
  function yieldOncoming(o, impatient, v = null) {
    if (!o) return false;
    if (o.through > 0) return true;
    const red = o.to.signal && phaseOf(o) === 'red';
    for (const list of o.occ) {
      const lead = leadOf(list);
      if (!lead || (lead.v.edge === o && lead.v.move?.turn === 'L')) continue;
      if (red) continue;
      if (!canStop(lead, o, impatient)) return true;
      const u = lead.v;
      const j = u.edge === o && u.move ? u.move.out[u.lane] : -1;
      if (v && v.wait > 0 && u.wait > v.wait && j >= 0 && o.len - lead.s - u.half < 2 && room(u.move.to, j, u)) return true;
    }
    return false;
  }

  // How far along curve c, out of two-way edge e, v can pull forward before its front corner reaches the
  // oncoming lanes (left of the centre line): where it waits for a gap to turn left
  const corner = { x: 0, z: 0, dx: 0, dz: 1 };
  function yieldPoint(v, c, e) {
    let cs = 0;
    for (; cs < c.len; cs += 0.5) {
      curvePoint(c, cs + v.half, corner);
      const x = corner.x + corner.dz * v.halfWidth;
      const z = corner.z - corner.dx * v.halfWidth;
      if ((x - e.x0) * e.rx + (z - e.z0) * e.rz < 0.3) break;
    }
    return cs - 0.5;
  }

  // At unsignalized corners, give way to the main road.
  function yieldToCrossTraffic(v, n) {
    for (const a of n.in) {
      if (n.signal ? a.axisIndex === v.edge.axisIndex : a.axisIndex !== 0) continue;
      for (const list of a.occ) {
        const lead = leadOf(list);
        if (lead && !canStop(lead, a, !n.signal && v.wait > 8)) return true;
      }
    }
    return false;
  }

  // Seconds v takes to cover dist metres from now, speeding up from rest if it has to
  const timeTo = (v, dist) => dist / Math.max(v.speed, Math.sqrt((v.driver.a * dist) / 2), 0.1);

  // Do people on crosswalk `side` have the WALK? On the parallel green of their road's right-of-way group.
  function walkOn(side, n = null) {
    return !!n && walkPhase(n.sigOffset, n.sideGroup[side] ?? 0, clock);
  }

  // May p step off the curb onto its crosswalk? On the WALK (early in the parallel traffic's green, so red for the
  // traffic arriving over it), once no vehicle is crossing it or committed to, and none is too close to stop
  function mayCross(p) {
    const n = p.node;
    if (!walkOn(p.side, n) || n.crossing[p.side] > 0) return false;
    const e = n.approach[p.side];
    if (!e) return true;
    for (const list of e.occ) {
      const lead = leadOf(list);
      if (lead && !canStop(lead, e, true)) return false;
    }
    return true;
  }

  // Will anyone on crosswalk `side` of n be within reach of the lane meeting it at `coord` between t0 and t1
  // seconds from now? Unless `onIt`, so is anyone waiting at the curb to step off, however far away: on the WALK, they
  // only wait for the vehicles already holding the crosswalk.
  function pedestrianOn(n, side, coord, t0, t1, onIt = false) {
    for (const p of n.walkers) {
      if (p.side !== side || (onIt && p.waiting)) continue;
      const toGo = (coord - p.coord) * p.dir; // metres p still has to walk to get there
      const avoiding = clock < p.avoidUntil;
      // Runners may enter a lane sooner, then slow or stop before clearing it.
      const fast = Math.max(p.speed, p.v, avoiding ? p.avoidSpeed : 0);
      const slow = Math.max(0.1, avoiding ? Math.min(p.speed, p.v, p.avoidSpeed) : p.speed);
      if (p.waiting || ((toGo + 2.6) / slow > t0 && (toGo - 2.6) / fast < t1)) return true;
    }
    return false;
  }

  // ...on the crosswalk v leaves the intersection over, while v, its front bumper d metres before it, passes? Once v
  // holds that crosswalk (it isn't waiting inside to turn), people at the curb wait for it.
  const pedsOut = (v, d) => d > 0 && pedestrianOn(v.edge.to, v.move.to.outSide, laneCoord(v.move.to, v.out), timeTo(v, d), timeTo(v, d + 3 + 2 * v.half), !v.yielding);

  // Must v, pulled into the intersection to turn, wait there: for people crossing its way out (`peds`) or, turning
  // left, for oncoming traffic?
  const holdsOn = (v, peds) => peds || (v.move.turn === 'L' && yieldOncoming(v.edge.opposite, false));

  // Of two vehicles on the same road headed for the same lane, the one whose front is nearer the line goes first (by
  // the front: a bus waiting at the line goes before the cars that pull up beside it)
  const precedence = (u, s) => s + u.half;

  // Would there be room for v in lane j of edge f if everyone headed there queued bumper to bumper behind its far
  // stop line? (An empty lane always has room, however short.) Vehicles take turns for it: whoever has waited longer
  // to go there from another side, or goes first from v's own road, counts as already in.
  function room(f, j, v) {
    let free = f.len - 1;
    for (const o of f.occ[j]) if (o.v !== v && o.s - o.v.half < f.len) free -= 2 * o.v.half + o.v.driver.s0;
    for (const a of f.from.in) {
      if (a.to.signal && phaseOf(a) !== 'green') continue; // waiting at a red: it can't take its turn now
      for (const list of a.occ) {
        const o = leadOf(list);
        if (!o || o.v.claimed || !o.v.move || o.v.move.to !== f || o.v.move.out[o.v.lane] !== j) continue;
        if (a === v.edge ? precedence(o.v, o.s) > precedence(v, v.s) : o.v.wait > v.wait) free -= 2 * o.v.half + o.v.driver.s0;
      }
    }
    return free >= Math.min(2 * v.half + 0.5, f.len - 1);
  }

  // Would v, crossing into lane j of f to arrive at position vs, come alongside another vehicle headed there, cut in
  // ahead of one closing in on it, or close in on one ahead in a lane beside (which it doesn't follow)? Turning buses
  // swing wide, so where a bus turns, the lanes either side count too, and for one turning beside v from v's road, so
  // does how far apart they start turning (the outer one has further to go: side by side on f may be one behind the
  // other at the line, and the other way round).
  function alongside(f, j, v, vs, turn) {
    for (let k = Math.max(0, j - 1); k <= Math.min(f.lanes.length - 1, j + 1); k++) {
      for (const o of f.occ[k]) {
        const swing = turn && (v.bus || o.v.bus);
        if (o.v === v || (k !== j && !swing)) continue;
        let lo = o.s - vs; // how far ahead of v o is
        let hi = lo;
        if (swing && o.v.edge === v.edge) {
          const atLine = (o.v.conn ? v.edge.len + o.v.cs : o.v.s) - v.s;
          lo = Math.min(lo, atLine);
          hi = Math.max(hi, atLine);
        }
        const closing = hi < 0 ? o.v.speed - v.speed : lo > 0 && k !== j ? v.speed - o.v.speed : 0;
        const w = o.v.half + v.half + 1 + 2 * Math.max(0, closing);
        if (lo < w && hi > -w) return true;
      }
    }
    return false;
  }

  // Is a bus at the line in the lane on the outside of v's turn? A bus starting to turn swings its tail out over it.
  function besideTail(v) {
    const e = v.edge;
    const k = v.lane + (v.move.turn === 'R' ? -1 : 1);
    const o = v.move.turn !== 'S' && k >= 0 && k < e.lanes.length ? leadOf(e.occ[k]) : null;
    return !!o && o.v.bus && o.v !== v && e.len - o.s - o.v.half < 2;
  }

  // The lead of another of v's lanes that goes first into lane j of f or, turning where a bus is involved, into a lane
  // beside it (turning buses swing wide): v falls in behind it. As an entry { v, s } of f's lane: where it would be on
  // f now.
  const merger = { v: null, s: 0 };
  function mergingAhead(v, f, j) {
    const e = v.edge;
    merger.v = null;
    for (let i = 0; i < e.lanes.length; i++) {
      const o = i === v.lane ? null : leadOf(e.occ[i]);
      if (!o || o.v === v || o.v.claimed || !o.v.move || o.v.move.to !== f || precedence(o.v, o.s) <= precedence(v, v.s)) continue;
      if (o.v.bus && besideTail(o.v)) continue; // it waits for the bus beside its tail
      const oj = o.v.move.out[o.v.lane];
      if (oj < 0 || (oj !== j && !(Math.abs(oj - j) === 1 && v.move.turn !== 'S' && (v.bus || o.v.bus)))) continue;
      const s = o.s - e.len - connector(e, o.v.lane, f, oj).len;
      if (!merger.v || s < merger.s) {
        merger.v = o.v;
        merger.s = s;
      }
    }
    return merger.v ? merger : null;
  }

  // May v, its front bumper d metres before the stop line, enter the intersection now? Sets the exit lane.
  // Once too close to stop, v is committed: it goes, and holds the intersection from then on.
  // v.why records which test in mayEnter said no (its number), for diagnosis
  function mayEnter(v, d) {
    const e = v.edge;
    const n = e.to;
    const phase = n.signal ? phaseOf(e) : 'green';
    // Could it still stop? For a light that isn't green, also by crawling up to it, closer than it stops for lines
    const stoppable = canStopBefore(v, d) || (phase !== 'green' && v.speed * v.speed < 2 * v.driver.b * d);
    if (stoppable) v.commit = null; // could stop after all: decide afresh
    if (v.commit === n) return true;
    if (v.move.out[v.lane] < 0) {
      // missed the lane for the planned move: go wherever this lane goes instead
      if (d > 12) return (v.why = 1, false);
      v.move = chooseMove(v, true);
    }
    const m = v.move;
    const f = m.to;
    const j = m.out[v.lane];
    if (!(j >= 0 && j < f.lanes.length)) {
      if (!mayEnter.warned) {
        mayEnter.warned = true;
        console.warn('[traffic] lane leads nowhere', { lane: v.lane, lanes: e.lanes.length, out: m.out.slice(), moves: e.moves.length, x: Math.round(v.x), z: Math.round(v.z) });
      }
      return (v.why = 2, false);
    }
    if (phase === 'red' || (phase === 'amber' && stoppable)) return (v.why = 0, false);
    if (boxBusy(n, e.axisIndex)) return (v.why = 3, false); // crossing traffic inside
    const lead = ahead(e.occ[v.lane], v.s, v);
    if (lead && lead.v.yielding) return (v.why = 4, false); // the vehicle ahead waits inside to turn: wait behind the line
    if (v.bus && besideTail(v)) return (v.why = 5, false); // its tail would swing out over that bus as it starts to turn
    // At a signal, the first in line to turn pulls into the intersection to wait there for the people crossing the
    // road it turns into (they walk on the same green): short of their crosswalk or, turning left across oncoming
    // traffic, short of the oncoming lanes until there is a gap. The light changing stops both for it at the latest.
    const c = connector(e, v.lane, f, j);
    const first = n.signal && m.turn !== 'S' && !lead;
    const across = m.turn === 'L' && !!e.opposite;
    const wait = first ? (across ? yieldPoint(v, c, e) : c.len - 3 - v.half) : -1; // < 0: no room inside to wait
    if (m.turn === 'L' ? across && wait < 0 && yieldOncoming(e.opposite, v.wait > 8, v) : e.opposite && e.opposite.lefts > 0) return (v.why = 6, false);
    if (!n.signal && e.axisIndex !== 0 && yieldToCrossTraffic(v, n)) return (v.why = 7, false);
    // nobody on the crosswalks while it passes over them, on the way in and on the way out, and a free place to
    // clear the intersection to, taking turns with lanes merging into it
    if (pedestrianOn(n, e.inSide, laneCoord(e, v.lane), 0, timeTo(v, d + 2.5 + 2 * v.half))) return (v.why = 8, false);
    if (wait < 0 && pedestrianOn(n, f.outSide, laneCoord(f, j), timeTo(v, d + c.len - 3), timeTo(v, d + c.len + 2 * v.half))) return (v.why = 9, false);
    const vs = v.s - e.len - c.len; // where on f it would be now
    if (!room(f, j, v) || alongside(f, j, v, vs, m.turn !== 'S') || mergingAhead(v, f, j)) return (v.why = 10, false);
    v.out = j;
    v.yielding = wait >= 0;
    v.yieldAt = wait;
    if (!stoppable) {
      v.commit = n;
      claim(v); // at once, so vehicles and pedestrians deciding later this frame know
    }
    return true;
  }

  // Overtake into an adjacent lane when it is clearly quicker (MOBIL), or work towards a lane the planned turn
  // can be made from; either only if neither v nor its new follower has to brake hard for it. Not while still
  // pulling out of an intersection, nor in the last 12 m before the next.
  function changeLanes(v) {
    const e = v.edge;
    if (!v.move || v.conn || v.commit || Math.abs(v.dl) > 0.5 || v.s < v.half || e.len - v.s - v.half < 12) return;
    let target = -1;
    if (v.move.out[v.lane] < 0) {
      const t = v.lane + Math.sign(nearestLane(v.move, v.lane) - v.lane);
      if (laneSafe(v, t, -4)) target = t;
    } else if (v.speed > 2) {
      let best = laneAcc(v, v.lane) + 0.6;
      for (let t = v.lane - 1; t <= v.lane + 1; t += 2) {
        if (t < 0 || t >= e.lanes.length || v.move.out[t] < 0 || !laneSafe(v, t, -3)) continue;
        const acc = laneAcc(v, t);
        if (acc > best) {
          best = acc;
          target = t;
        }
      }
    }
    if (target < 0) return;
    v.dl += e.lanes[v.lane] - e.lanes[target]; // same spot, now measured from the new lane's centre
    v.lane = target;
    v.trail = null;
  }

  // Can v move into lane t leaving itself and its new follower at least bSafe (negative) acceleration?
  function laneSafe(v, t, bSafe) {
    let lead = null;
    let back = null;
    for (const o of v.edge.occ[t]) {
      if (o.v === v) continue;
      if (o.s > v.s) {
        lead = o;
        break;
      }
      back = o;
    }
    if (lead) {
      const gap = lead.s - lead.v.half - v.s - v.half;
      if (gap < 1.5 || freeAcc(v) + brake(v, gap, lead.v.speed) < bSafe) return false;
    }
    if (back) {
      const f = back.v;
      const gap = v.s - v.half - back.s - f.half;
      if (gap < 1.5 || freeAcc(f) + brake(f, gap, v.speed) < bSafe) return false;
    }
    const off = v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl;
    const reach = v.half + player.halfL + 6;
    return !(Math.abs(v.pRight - off) < v.halfWidth + player.halfW + 0.4 && v.pAhead > -reach && v.pAhead < reach);
  }

  // Acceleration v would have in lane t behind the vehicle (or player) ahead there
  function laneAcc(v, t) {
    const o = ahead(v.edge.occ[t], v.s, v);
    let worst = o ? brake(v, o.s - o.v.half - v.s - v.half, o.v.speed) : 0;
    const pg = playerGap(v, v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl);
    if (pg < LOOKAHEAD) worst = Math.min(worst, brake(v, pg, v.pSpeed));
    return freeAcc(v) + worst;
  }

  // Fastest v can take curve c at without exceeding the sideways acceleration its driver accepts
  const bendSpeed = (v, c) => Math.sqrt(v.driver.aLat / Math.max(c.curv, 1e-3));

  // IDM acceleration for vehicles ahead in the lane (and, through the intersection, in the lane it leads to),
  // the stop line while v may not go, a red beyond, the player, and slowing down for turns and give-way lines
  function accelerate(v) {
    const e = v.edge;
    let worst = 0;
    let cap = Infinity;
    v.gap = Infinity;
    if (!v.conn) {
      worst = follow(v, e.occ[v.lane], v.s);
      const side = straddle(v);
      if (side) worst = Math.min(worst, follow(v, e.occ[v.lane + side], v.s));
      const d = e.len - v.s - v.half;
      if (d < LOOKAHEAD && v.move) {
        const go = mayEnter(v, d);
        const f = v.move.to;
        const j = v.move.out[v.lane];
        const c = j < 0 ? null : connector(e, v.lane, f, j);
        const vs = c ? v.s - e.len - c.len : 0; // position on f, measured from its start
        if (!go) {
          worst = Math.min(worst, stopAt(v, d));
        } else {
          worst = Math.min(worst, follow(v, f.occ[j], vs), signalAhead(v, f, f.len - vs - v.half));
          // pulling in to wait inside: slow down for that spot already if it will have to wait there
          if (v.yielding && holdsOn(v, pedsOut(v, d + c.len - 3))) worst = Math.min(worst, stopAt(v, d + v.half + v.yieldAt, 0.5));
        }
        // easing off to fall in behind a vehicle from another lane merging ahead into the same lane (unless committed:
        // then the others wait for v)
        const o = c && !v.claimed && mergingAhead(v, f, j);
        if (o) worst = Math.min(worst, Math.max(-v.driver.b, brake(v, o.s - o.v.half - vs - v.half, o.v.speed)));
        let vt = c ? bendSpeed(v, c) : Infinity;
        const cautious = !e.to.signal && e.axisIndex !== 0;
        if (cautious) vt = Math.min(vt, 5);
        cap = Math.sqrt(vt * vt + 5 * Math.max(0, d));
      }
    } else {
      const f = v.move.to;
      const vs = v.cs - v.conn.len;
      worst = Math.min(follow(v, f.occ[v.out], vs), follow(v, e.occ[v.lane], e.len + v.cs), signalAhead(v, f, f.len - vs - v.half));
      // someone crossing the way out: wait for them inside the intersection, short of the 2.5 m crosswalk
      const d = v.conn.len - 3 - v.cs - v.half;
      const peds = pedsOut(v, d);
      if (v.yielding && v.cs < v.yieldAt && holdsOn(v, peds)) {
        worst = Math.min(worst, stopAt(v, v.yieldAt - v.cs, 0.5)); // waiting inside to turn
      } else {
        if (v.yielding) cross(v);
        if (peds) worst = Math.min(worst, stopAt(v, d, 0.5));
      }
      cap = bendSpeed(v, v.conn);
    }
    const pg = playerGap(v, 0);
    if (pg < LOOKAHEAD) {
      worst = Math.min(worst, brake(v, pg, v.pSpeed));
      if (pg < v.gap) {
        v.gap = pg;
        v.leaderSpeed = v.pSpeed;
      }
    }
    const acc = Math.min(freeAcc(v) + worst, (cap - v.speed) * 2);
    v.acc = clamp(acc, -9, v.driver.a);
  }

  // Front bumper at the stop line: cross if allowed, or if going too fast to stop; otherwise wait there
  function enter(v) {
    const e = v.edge;
    if (!mayEnter(v, 0)) {
      const j = v.move.out[v.lane];
      if (v.speed < 4 || j < 0) {
        v.s = e.len - v.half;
        v.speed = 0;
        return;
      }
      v.out = j;
      v.yielding = false;
    }
    v.cs = v.s - e.len;
    v.conn = connector(e, v.lane, v.move.to, v.out);
    claim(v); // at once, so vehicles deciding later this frame know
  }

  let jamRetired = 0;
  function retire(v) {
    v.edge = null;
    v.move = null;
    v.speed = 0;
    v.conn = null;
  }

  // Swaps the road network (a streamed city re-centres it on the camera): everyone is taken off the old one and placed afresh
  // around the focus on the new one by the next updates.
  function setNetwork(net) {
    for (const v of vehicles) {
      retire(v);
      v.claimed = false;
      v.trail = null;
      v.commit = null;
      v.yielding = false;
    }
    bindNetwork(net);
    nearX = Infinity;
    nearZ = Infinity;
    nearEdges.length = 0;
    nearSignals.length = 0;
    pedestrianSystem.setNetwork(net);
  }

  function leave(v) {
    v.s = v.cs - v.conn.len;
    v.edge = v.move.to;
    v.lane = v.out;
    v.trail = v.conn; // the rear axle is still on it
    v.conn = null;
    v.commit = null;
    v.move = chooseMove(v, false);
  }

  function drive(v, dt) {
    v.laneTimer -= dt;
    if (v.laneTimer <= 0) {
      v.laneTimer = 0.4 + Math.random() * 0.3;
      changeLanes(v);
    }
    accelerate(v);
    const speed = v.speed;
    v.speed = Math.max(0, v.speed + v.acc * dt);
    let ds = v.speed * dt;
    if (ds > v.gap - 0.3) {
      // never into the vehicle ahead
      ds = Math.max(0, v.gap - 0.3);
      v.speed = Math.min(v.speed, v.leaderSpeed);
    }
    v.acc = Math.max(-9, (v.speed - speed) / dt); // as driven, for the body to pitch with: none standing still
    v.wait = v.speed < 0.5 ? v.wait + dt : 0;
    // Copenhagen's short junction-to-junction links gridlock when full: a vehicle held for JAM_WAIT seconds (out of sight,
    // else twice that) leaves the road and is placed afresh, as a driver turning off the map would
    if (v.wait > (hasView && visible(v.x, v.z, 8) ? 2 * JAM_WAIT : JAM_WAIT)) {
      jamRetired++;
      retire(v);
      return;
    }
    if (!v.conn) {
      v.s += ds;
      if (v.s + v.half >= v.edge.len) {
        if (v.move) enter(v);
        else retire(v); // a road that only leads out of the district: respawned elsewhere
      }
    } else {
      v.cs += ds;
      if (v.cs >= v.conn.len) leave(v);
    }
    // ease sideways onto the lane centre (after lane changes and knocks), steering the front bumper towards it so the
    // nose doesn't swing on into the next lane, and no faster than the wheels can steer it, though even stopped half
    // way into a lane change a driver edges over
    const maxLat = Math.min(1.7, 0.3 + (v.bus ? 0.1 : 0.22) * v.speed);
    const rate = Math.min(1.8, Math.max(v.speed, 1.5) / (v.axle + v.half));
    const target = clamp(-rate * v.dl, -maxLat, maxLat);
    v.dlv += clamp(target - v.dlv, -2.5 * dt, 2.5 * dt);
    v.dl += v.dlv * dt;
  }

  // Point and direction at distance c along v's path: its lane, the curve through the intersection, and the
  // lane after it (or, just out of an intersection, the curve it came along)
  function lanePoint(e, i, s, out) {
    out.x = e.sx + e.dx * s + e.rx * e.lanes[i];
    out.z = e.sz + e.dz * s + e.rz * e.lanes[i];
    out.dx = e.dx;
    out.dz = e.dz;
    return out;
  }
  function pathPoint(v, c, out) {
    const e = v.edge;
    if (v.conn) {
      if (c < 0) return lanePoint(e, v.lane, e.len + c, out);
      if (c > v.conn.len) return lanePoint(v.move.to, v.out, c - v.conn.len, out);
      return curvePoint(v.conn, c, out);
    }
    if (c < 0 && v.trail) return curvePoint(v.trail, v.trail.len + c, out);
    return lanePoint(e, v.lane, c, out);
  }

  // World position and heading from where v's axles are along its path: the rear axle dl to the right of it, and the
  // body turned `nose` to the right about the rear axle, into a lane change (so the rear axle never slides sideways)
  const front = { x: 0, z: 0, dx: 0, dz: 0 };
  const rear = { x: 0, z: 0, dx: 0, dz: 0 };
  function locate(v) {
    const c = v.conn ? v.cs : v.s;
    pathPoint(v, c + v.axle, front);
    pathPoint(v, c - v.axle, rear);
    const l = Math.hypot(front.x - rear.x, front.z - rear.z) || 1;
    v.tx = (front.x - rear.x) / l;
    v.tz = (front.z - rear.z) / l;
    v.nose = Math.atan2(v.dlv, Math.max(v.speed, 1.5));
    const off = v.dl + v.axle * Math.sin(v.nose);
    v.x = (front.x + rear.x) / 2 - v.tz * off;
    v.z = (front.z + rear.z) / 2 + v.tx * off;
  }

  // Move v along and across its path by (dx, dz), as far as the road allows
  function shove(v, dx, dz) {
    const along = dx * v.tx + dz * v.tz;
    if (v.conn) v.cs = clamp(v.cs + along, -v.half, v.conn.len - 0.01);
    else v.s = clamp(v.s + along, 0, v.edge.len - v.half);
    v.dl = clamp(v.dl + dz * v.tx - dx * v.tz, -2.5, 2.5);
    locate(v);
  }

  // Heading, steering, turn signals, and body pitch & roll from acceleration & turning
  function pose(v, dt) {
    const yaw = Math.atan2(v.tx, v.tz) - v.nose;
    let dYaw = yaw - v.yaw;
    dYaw -= Math.round(dYaw / (Math.PI * 2)) * Math.PI * 2;
    v.yaw = yaw;
    v.yawRate += (dYaw / dt - v.yawRate) * Math.min(1, dt * 8);
    const wheelbase = 2 * v.axle;
    const steer = clamp(Math.atan((wheelbase * v.yawRate) / Math.max(v.speed, 0.5)), -0.6, 0.6);
    v.steer += (steer - v.steer) * Math.min(1, dt * 10);

    const turn = v.move ? v.move.turn : 'S';
    if (Math.abs(v.dl) > 0.3 && Math.abs(v.dlv) > 0.05) v.blink = v.dl > 0 ? -1 : 1;
    else if (turn !== 'S' && (v.conn || v.edge.len - v.s < 35)) v.blink = turn === 'R' ? 1 : -1;
    else v.blink = 0;

    v.pitchVel += ((-0.008 * v.acc - v.pitch) * 68.0 - v.pitchVel * 10.8) * dt;
    v.pitch = clamp(v.pitch + v.pitchVel * dt, -0.22, 0.22);
    v.rollVel += ((0.01 * v.speed * v.yawRate - v.roll) * 68.0 - v.rollVel * 10.8) * dt;
    v.roll = clamp(v.roll + v.rollVel * dt, -0.26, 0.26);
    v.yawOffset += v.yawVel * dt;
    v.yawVel += (-v.yawOffset * 18.0 - v.yawVel * 6.8) * dt;
    v.yawOffset = clamp(v.yawOffset * Math.exp(-4.5 * dt), -0.85, 0.85);
  }

  // Knock velocity from collisions carries v along and across its path, and dies down
  function knock(v, dt) {
    if (v.vx === 0 && v.vz === 0) return;
    shove(v, v.vx * dt, v.vz * dt);
    const damp = Math.exp(-5.5 * dt);
    v.vx *= damp;
    v.vz *= damp;
    if (v.vx * v.vx + v.vz * v.vz < 1e-4) v.vx = v.vz = 0;
  }

  // A knocked vehicle shunts the vehicles it runs into
  function knockOn(v) {
    for (const o of vehicles) {
      if (o === v || !o.edge) continue;
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const dist = Math.hypot(dx, dz);
      if (dist > v.half + o.half || dist < 0.001) continue;
      if (Math.abs(dz * v.tx - dx * v.tz) > v.halfWidth + o.halfWidth) continue; // side by side
      const nx = dx / dist;
      const nz = dz / dist;
      const relVn = (v.vx - o.vx) * nx + (v.vz - o.vz) * nz;
      if (relVn <= 0.5) continue;
      const approachSpeed = (v.tx * v.speed + v.vx - o.tx * o.speed - o.vx) * nx
        + (v.tz * v.speed + v.vz - o.tz * o.speed - o.vz) * nz;
      reportCollision(o, v, (v.x + o.x) * 0.5, 0.56, (v.z + o.z) * 0.5, nx, nz, approachSpeed);
      const transfer = relVn * 0.68;
      o.vx += nx * transfer;
      o.vz += nz * transfer;
      v.vx -= nx * transfer * 0.45;
      v.vz -= nz * transfer * 0.45;
      const across = nz * o.tx - nx * o.tz; // hit from the side spins it
      const along = nx * o.tx + nz * o.tz;
      o.yawVel += across * Math.min(2.8, relVn * 0.22);
      o.rollVel += across * Math.min(8.0, relVn) * 0.18;
      o.pitchVel -= along * Math.min(8.0, relVn) * 0.14;
      if (relVn > 2.2) spawnCollisionSparks((v.x + o.x) * 0.5, 0.56, (v.z + o.z) * 0.5, nx, nz, relVn);
    }
  }

  // Physical 4-axis 2D SAT OBB test between a vehicle (half extents halfW x halfL, heading rotY) and the player.
  // Returns the minimum translation axis (pointing from the vehicle towards the player), or null if they don't overlap.
  const satHit = { nx: 0, nz: 0, pen: 0, localX: 0, localZ: 0, pSin: 0, pCos: 1 };
  function overlapWithPlayer(relX, relZ, rotY, halfW, halfL, pH, pHalfW, pHalfL) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const localX = relX * cosY - relZ * sinY;
    const localZ = relX * sinY + relZ * cosY;
    const pSin = Math.sin(pH);
    const pCos = Math.cos(pH);
    const pLocalX = relX * pCos - relZ * pSin;
    const pLocalZ = relX * pSin + relZ * pCos;
    const alignCos = Math.abs(Math.cos(pH - rotY));
    const alignSin = Math.abs(Math.sin(pH - rotY));

    const extX = halfW + pHalfW * alignCos + pHalfL * alignSin;
    const extZ = halfL + pHalfW * alignSin + pHalfL * alignCos;
    const pExtX = pHalfW + halfW * alignCos + halfL * alignSin;
    const pExtZ = pHalfL + halfW * alignSin + halfL * alignCos;

    const penX = extX - Math.abs(localX);
    const penZ = extZ - Math.abs(localZ);
    const pPenX = pExtX - Math.abs(pLocalX);
    const pPenZ = pExtZ - Math.abs(pLocalZ);
    if (!(penX > 0 && penZ > 0 && pPenX > 0 && pPenZ > 0)) return null;

    let nx, nz, pen;
    if (penX < penZ) {
      const signX = localX >= 0 ? 1 : -1;
      nx = cosY * signX;
      nz = -sinY * signX;
      pen = penX;
    } else {
      const signZ = localZ >= 0 ? 1 : -1;
      nx = sinY * signZ;
      nz = cosY * signZ;
      pen = penZ;
    }
    if (pPenX < pen) {
      const signPX = pLocalX >= 0 ? 1 : -1;
      nx = pCos * signPX;
      nz = -pSin * signPX;
      pen = pPenX;
    }
    if (pPenZ < pen) {
      const signPZ = pLocalZ >= 0 ? 1 : -1;
      nx = pSin * signPZ;
      nz = pCos * signPZ;
      pen = pPenZ;
    }

    satHit.nx = nx;
    satHit.nz = nz;
    satHit.pen = pen;
    satHit.localX = localX;
    satHit.localZ = localZ;
    satHit.pSin = pSin;
    satHit.pCos = pCos;
    return satHit;
  }

  // Player contact: push the player and the vehicle apart (a bus hardly moves) and trade momentum, with spin,
  // suspension kicks and sparks
  function collideWithPlayer(v, rotY, halfW, halfL) {
    const pe = player.entity;
    const relX = pe.position.x - v.x;
    const relZ = pe.position.z - v.z;
    if (Math.abs(relX) > halfL + 3 || Math.abs(relZ) > halfL + 3) return;
    const hit = overlapWithPlayer(relX, relZ, rotY, halfW, halfL, pe.heading || 0, player.halfW, player.halfL);
    if (!hit) return;
    const { nx, nz, pen, localX, localZ, pSin, pCos } = hit;
    const massRatio = v.massRatio * (1.0 - player.push) / 0.5;
    const pPush = 1.0 - massRatio;
    pe.position.x += nx * pen * pPush;
    pe.position.z += nz * pen * pPush;
    if (pe.mesh) pe.mesh.position.copy(pe.position);
    shove(v, -nx * pen * massRatio, -nz * pen * massRatio);

    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const pSpeed = pe.speed || 0;
    const pvx = pSin * pSpeed + (pe.vx || 0);
    const pvz = pCos * pSpeed + (pe.vz || 0);
    const cvx = v.tx * v.speed + v.vx;
    const cvz = v.tz * v.speed + v.vz;
    const approachSpeed = (pvx - cvx) * (-nx) + (pvz - cvz) * (-nz);
    if (approachSpeed <= 0) return;

    const jImpulse = (1.0 + 0.28) * approachSpeed;
    const cImpulse = v.bus ? approachSpeed * 0.22 : jImpulse * massRatio * 0.92;
    v.vx -= nx * cImpulse;
    v.vz -= nz * cImpulse;
    v.speed *= v.bus ? 0.55 : 0.35;

    const localNx = nx * cosY - nz * sinY;
    const localNz = nx * sinY + nz * cosY;
    if (!v.bus) {
      const torque = localZ * localNx - localX * localNz;
      v.yawVel -= torque * Math.min(4.2, approachSpeed * 0.26);
      v.yawOffset = clamp(v.yawOffset - torque * Math.min(0.35, approachSpeed * 0.025), -0.65, 0.65);
      v.pitchVel -= localNz * Math.min(12.0, approachSpeed) * 0.18;
      v.rollVel += localNx * Math.min(12.0, approachSpeed) * 0.24;
    }

    const contactLocalX = clamp(localX, -halfW, halfW);
    const contactLocalZ = clamp(localZ, -halfL, halfL);
    const contactX = v.x + contactLocalX * cosY + contactLocalZ * sinY;
    const contactZ = v.z - contactLocalX * sinY + contactLocalZ * cosY;
    if (pe.type !== 'person') reportCollision(pe, v, contactX, v.bus ? 0.65 : 0.58, contactZ, nx, nz, approachSpeed);

    if (typeof pe.speed === 'number') {
      const headOnDot = Math.abs(pSin * nx + pCos * nz);
      pe.speed *= 1.0 - (v.bus ? 0.68 : 0.50) * headOnDot;
      if (pe.type === 'car') {
        const pImpulse = v.bus ? approachSpeed * 0.65 : jImpulse * pPush * 0.48;
        pe.vx = (pe.vx || 0) + nx * pImpulse;
        pe.vz = (pe.vz || 0) + nz * pImpulse;
        const pLocalNx = nx * pCos - nz * pSin;
        const pLocalNz = nx * pSin + nz * pCos;
        if (!v.bus) {
          const pRelX = (contactX - pe.position.x) * pCos - (contactZ - pe.position.z) * pSin;
          const pRelZ = (contactX - pe.position.x) * pSin + (contactZ - pe.position.z) * pCos;
          const pTorque = pRelZ * pLocalNx - pRelX * pLocalNz;
          pe.angularVel = (pe.angularVel || 0) + pTorque * Math.min(3.0, approachSpeed * 0.18) * pPush;
        }
        const kick = Math.min(v.bus ? 16.0 : 14.0, approachSpeed);
        pe.pitchVel = (pe.pitchVel || 0) + pLocalNz * kick * (v.bus ? 0.22 : 0.18);
        pe.rollVel = (pe.rollVel || 0) - pLocalNx * kick * (v.bus ? 0.28 : 0.24);
        pe.heaveVel = (pe.heaveVel || 0) + Math.min(v.bus ? 1.6 : 1.4, approachSpeed * (v.bus ? 0.14 : 0.11));
      }
    }
    if (approachSpeed > 1.8) spawnCollisionSparks(contactX, v.bus ? 0.65 : 0.58, contactZ, nx, nz, approachSpeed);
  }

  // =========================================================================
  // 6. PLACING VEHICLES
  // =========================================================================
  // Room at s in a lane list: margin metres to the vehicles either side, and two seconds more for the one behind
  function laneClear(list, s, margin) {
    for (const o of list) if (Math.abs(o.s - s) < o.v.half + margin + (o.s < s ? 2 * o.v.speed : 0)) return false;
    return true;
  }

  function place(v, e, lane, s) {
    v.edge = e;
    v.lane = lane;
    v.s = s;
    v.conn = null;
    v.trail = null;
    v.commit = null;
    v.yielding = false;
    v.wait = 0;
    v.speed = v.v0 * 0.5;
    v.acc = 0;
    v.dl = v.dlv = 0;
    v.vx = v.vz = v.yawOffset = v.yawVel = v.pitch = v.pitchVel = v.roll = v.rollVel = 0;
    locate(v);
    v.prevX = v.x;
    v.prevZ = v.z;
    v.yaw = Math.atan2(v.tx, v.tz);
    v.yawRate = v.steer = 0;
    v.move = chooseMove(v, false);
    occupy(e.occ[lane], v, s);
  }

  // Put v in a free lane around the focus. Normal replenishment protects the near view; teleports can fill it.
  function spawnVehicle(v, rMin, rMax, protectView) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const e = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      if (!e || (v.bus && e.axis !== 'ave') || e.len < 2 * v.half + 10) continue;
      const lane = Math.floor(Math.random() * e.lanes.length);
      const along = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
      const minS = Math.max(v.half + 5, along - rMax);
      const maxS = Math.min(e.len - v.half - 5, along + rMax);
      if (minS > maxS) continue;
      const s = minS + Math.random() * (maxS - minS);
      const x = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const z = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, v.half + 4, VEHICLE_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 25) continue;
      if (!laneClear(e.occ[lane], s, v.half + 8)) continue;
      place(v, e, lane, s);
      return true;
    }
    return false;
  }

  // =========================================================================
  // 7. RENDERING
  // =========================================================================
  // Beyond CAR_PROXY_DISTANCE, cars use the ~500-triangle stand-in with built-in wheels instead of the full lofted
  // body + 4 separate wheel instances; vehicles outside the view frustum (with a margin for cast shadows and headlight
  // cones) are skipped altogether.
  const CAR_PROXY_DISTANCE = 90;
  const dirtyPaint = new Set();
  const dirtyState = new Set();
  const litVehicles = [];
  let litVehicleCount = 0;
  let wheelCars = 0;
  let visibleCars = 0;
  let visibleBuses = 0;
  let busAxles = 0;
  let updates = 0;

  function flagRange(attr, n) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * attr.itemSize);
    attr.needsUpdate = true;
  }

  // 3D spinning alloy wheels & tires (left & right, front & rear), exact 1:1 ground rolling, steering front wheels.
  // Shared wheels are modelled at baseRadius, then scaled to each body’s rolling radius.
  function placeWheels(v, i, rotY, roll, radius, halfTrack, halfBase, leftInst, rightInst, baseRadius = 0.37, axles = null) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const scale = radius / baseRadius;
    dummy.scale.set(scale, scale, scale);
    const count = axles ? axles.length : 2;
    for (let w = 0; w < count; w++) {
      const wz = axles ? axles[w] : w === 0 ? halfBase : -halfBase;
      dummy.rotation.set(v.wheelSpin + w * 0.55, rotY + (w === 0 ? v.steer : 0), roll, 'YXZ');
      dummy.position.set(v.x - halfTrack * cosY + wz * sinY, radius + groundAt(v.x, v.z), v.z + halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      leftInst.setMatrixAt(i + w, dummy.matrix);

      dummy.position.set(v.x + halfTrack * cosY + wz * sinY, radius + groundAt(v.x, v.z), v.z - halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      rightInst.setMatrixAt(i + w, dummy.matrix);
    }
  }

  // Lamp state for the car & bus materials: brake lights while slowing down or standing, the turn signal on the side
  // v is heading for (left = +x)
  function writeLampState(v, array, o) {
    const blinkOn = v.blink !== 0 && (clock + v.blinkPhase) % 0.8 <= 0.4;
    array[o] = v.acc < -0.8 || v.speed < 0.3 ? 1 : 0;
    array[o + 1] = blinkOn && v.blink < 0 ? 1 : 0;
    array[o + 2] = blinkOn && v.blink > 0 ? 1 : 0;
  }

  function renderCar(c) {
    const rotY = c.yaw + c.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const spec = BODY_SPECS[c.bodyType];
    const forwardDist = (c.x - c.prevX) * sinY + (c.z - c.prevZ) * cosY;
    const rawStep = forwardDist / spec.wheelRadius;
    c.wheelSpin = (c.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(c.x, c.z, 18)) return;

    const near = Math.hypot(c.x - focusX, c.z - focusZ) < CAR_PROXY_DISTANCE;
    const bodyInst = near ? bodies[c.bodyType].near : bodies[c.bodyType].far;
    const slot = bodyInst.count++;

    dummy.position.set(c.x, groundAt(c.x, c.z), c.z);
    dummy.rotation.set(c.pitch, rotY, c.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bodyInst.setMatrixAt(slot, dummy.matrix);

    const attrs = bodyInst.geometry.attributes;
    const paint = attrs.paintColor.array;
    const o3 = slot * 3;
    if (paint[o3] !== c.paint[0] || paint[o3 + 1] !== c.paint[1] || paint[o3 + 2] !== c.paint[2]) {
      paint[o3] = c.paint[0];
      paint[o3 + 1] = c.paint[1];
      paint[o3 + 2] = c.paint[2];
      dirtyPaint.add(bodyInst);
    }
    const state = attrs.carState.array;
    const o4 = slot * 4;
    const blinkOn = c.blink !== 0 && (clock + c.blinkPhase) % 0.8 <= 0.4;
    const b0 = c.acc < -0.8 || c.speed < 0.3 ? 1 : 0;
    const b1 = blinkOn && c.blink < 0 ? 1 : 0;
    const b2 = blinkOn && c.blink > 0 ? 1 : 0;
    const b3 = c.taxi ? 1 : 0;
    if (state[o4] !== b0 || state[o4 + 1] !== b1 || state[o4 + 2] !== b2 || state[o4 + 3] !== b3) {
      state[o4] = b0;
      state[o4 + 1] = b1;
      state[o4 + 2] = b2;
      state[o4 + 3] = b3;
      dirtyState.add(bodyInst);
    }

    // Soft Under-Car Contact Shadow (AO) stays flat on the asphalt
    const visIdx = visibleCars++;
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.position.set(c.x, 0.018 + groundAt(c.x, c.z), c.z);
    dummy.scale.set(spec.width + 0.3, 1.0, spec.length + 0.5);
    dummy.updateMatrix();
    carShadowInst.setMatrixAt(visIdx, dummy.matrix);

    const dxCam = c.x - camX;
    const dzCam = c.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        c._camDistSq = distSq;
        c._effDist = effDist;
        c._sinY = sinY;
        c._cosY = cosY;
        c._braking = b0;
        litVehicles[litVehicleCount++] = c;
      }
    }

    if (near) {
      placeWheels(c, wheelCars++ * 2, rotY, c.roll, spec.wheelRadius, spec.wheelX, spec.wheelZ, carWheelLeftInst, carWheelRightInst);
    }
  }

  function renderBus(b) {
    const spec = b.spec;
    const set = busSets[spec.name];
    const rotY = b.yaw + b.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const forwardDist = (b.x - b.prevX) * sinY + (b.z - b.prevZ) * cosY;
    const rawStep = forwardDist / spec.wheelRadius;
    b.wheelSpin = (b.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(b.x, b.z, 22)) return;

    const i = visibleBuses++;
    dummy.position.set(b.x, 0.018 + groundAt(b.x, b.z), b.z);
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.scale.set(spec.width + 0.32, 1.0, spec.length + 0.55);
    dummy.updateMatrix();
    busShadowInst.setMatrixAt(i, dummy.matrix);

    // Lofted Bus Body is defined in ground-relative Y (0.36m skirt to 3.0m roof crown)
    dummy.position.set(b.x, groundAt(b.x, b.z), b.z);
    dummy.rotation.set(b.pitch, rotY, b.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    const slot = set.count++;
    set.body.setMatrixAt(slot, dummy.matrix);
    writeLampState(b, set.states.array, slot * 4);

    const dxCam = b.x - camX;
    const dzCam = b.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        b._camDistSq = distSq;
        b._effDist = effDist;
        b._sinY = sinY;
        b._cosY = cosY;
        b._braking = b.acc < -0.8 || b.speed < 0.3 ? 1 : 0;
        litVehicles[litVehicleCount++] = b;
      }
    }

    placeWheels(b, busAxles, rotY, 0, spec.wheelRadius, spec.wheelX, spec.wheelZ, busWheelLeftInst, busWheelRightInst, spec.wheelRadius, spec.axles);
    busAxles += spec.axles ? spec.axles.length : 2;
  }

  function smoothDistFade(d, start, end) {
    const t = clamp((end - d) / (end - start), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function updateTrafficLights() {
    litVehicles.length = litVehicleCount;
    if (litVehicleCount > 1) {
      litVehicles.sort((a, b) => a._effDist - b._effDist);
    }

    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Front headlights are off during Midday (0.24) & Golden Hour (0.48); fade in smoothly for Dusk (1.25) & Night (1.55)
    const beamScale = clamp((glow - 0.60) * 1.45, 0.0, 1.28);
    const tailScale = clamp(0.18 + glow * 0.66, 0.24, 1.22);

    const maxDualVehicles = HEADLIGHT_POOL_SIZE >> 1;
    const vehCutoff = litVehicleCount > maxDualVehicles
      ? Math.min(MAX_LIGHT_DIST, litVehicles[maxDualVehicles]._effDist)
      : MAX_LIGHT_DIST;
    let spotUsed = 0;
    if (beamScale > 0.001) {
      for (let i = 0; i < litVehicleCount && spotUsed + 2 <= HEADLIGHT_POOL_SIZE; i++) {
        const v = litVehicles[i];
        const fade = smoothDistFade(v._effDist, vehCutoff * 0.62, vehCutoff);
        if (fade <= 0.001) continue;
        const spec = v.bus ? v.spec : BODY_SPECS[v.bodyType];
        const fullReach = HEADLIGHTS.distance;
        let maxReach = fullReach;
        if (player.active && v.pAhead > 0 && v.pAhead < 30) {
          const latWeight = smoothDistFade(Math.abs(v.pRight), 2.2, 5.5);
          const clampedReach = Math.max(4.5, v.pAhead - player.halfL - 1.5);
          maxReach = fullReach + (clampedReach - fullReach) * latWeight;
        }

        const baseInt = (v.bus ? HEADLIGHTS.busIntensity : HEADLIGHTS.intensity) * beamScale * fade;
        // Match the body instance, including suspension and impact rotation.
        dummy.position.set(v.x, groundAt(v.x, v.z), v.z);
        dummy.rotation.set(v.pitch, v.yaw + v.yawOffset, v.roll, 'YXZ');
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        for (let side = -1; side <= 1; side += 2) {
          const spot = headlightPool[spotUsed++];
          placeVehicleHeadlight(spot, spec, side, dummy.matrix);
          spot.distance = maxReach;
          spot.intensity = baseInt;
        }
      }
    }
    for (let i = spotUsed; i < HEADLIGHT_POOL_SIZE; i++) {
      const spot = headlightPool[i];
      spot.intensity = 0;
      spot.position.set(0, -1000, 0);
    }

  }

  function updateSparks(dt) {
    let count = 0;
    for (let s = 0; s < MAX_SPARKS; s++) {
      const sp = sparks[s];
      if (sp.life > 0) {
        sp.life -= dt;
        sp.vy -= 22.0 * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        sp.z += sp.vz * dt;
        const spGround = (sp.floor || 0) + 0.03; // terrain height at the impact
        if (sp.y < spGround) {
          sp.y = spGround;
          sp.vy = Math.abs(sp.vy) * 0.45;
          sp.vx *= 0.78;
          sp.vz *= 0.78;
        }
        const tLife = Math.max(0, sp.life / sp.maxLife);
        const spdXZ = Math.hypot(sp.vx, sp.vz) || 0.001;
        const yawSp = Math.atan2(sp.vx, sp.vz);
        const pitchSp = -Math.atan2(sp.vy, spdXZ);
        dummy.position.set(sp.x, sp.y, sp.z);
        dummy.rotation.set(pitchSp, yawSp, 0, 'YXZ');
        dummy.scale.set(tLife, tLife, Math.max(0.4, Math.min(2.2, spdXZ * 0.16)) * tLife);
        dummy.updateMatrix();
        sparkInst.setMatrixAt(count++, dummy.matrix);
      }
    }
    // Keep one degenerate instance for shader warm-up, then hide the empty pool and stop uploading it.
    sparkInst.visible = count > 0 || updates <= 2;
    if (count === 0 && updates <= 2) sparkInst.setMatrixAt(count++, zero);
    sparkInst.count = count;
    if (count > 0) flagRange(sparkInst.instanceMatrix, count);
  }

  // =========================================================================
  // 8. UPDATE
  // =========================================================================
  let lastFocusX = Infinity;
  let lastFocusZ = Infinity;
  let vehicleCursor = 0;

  function update(dt, elapsed, focusPos = null, playerEntity = null, activeMode = 'car', camera = null) {
    clock = elapsed;
    focusX = focusPos ? focusPos.x : 0;
    focusZ = focusPos ? focusPos.z : 140;
    // a jump of the camera (teleport, first frame): everything far away can be placed anywhere around it
    const jump = Math.hypot(focusX - lastFocusX, focusZ - lastFocusZ) > 140;
    lastFocusX = focusX;
    lastFocusZ = focusZ;
    refreshNear();
    updateView(camera);

    player.active = Boolean(playerEntity && activeMode !== 'helicopter' && playerEntity.position.y < 2.6);
    if (playerEntity) {
      const heading = playerEntity.heading || 0;
      const speed = playerEntity.speed || 0;
      player.entity = playerEntity;
      player.x = playerEntity.position.x;
      player.z = playerEntity.position.z;
      player.fx = Math.sin(heading);
      player.fz = Math.cos(heading);
      player.vx = player.fx * speed + (playerEntity.vx || 0);
      player.vz = player.fz * speed + (playerEntity.vz || 0);
    }
    const bicycle = activeMode === 'cyclist' || activeMode === 'cargobike';
    player.halfW = activeMode === 'cargobike' ? 0.4 : activeMode === 'cyclist' ? 0.35 : activeMode === 'person' ? 0.32 : (playerEntity?.bodySpec?.width || 1.72) / 2;
    player.halfL = activeMode === 'cargobike' ? 1.34 : activeMode === 'cyclist' ? 0.85 : activeMode === 'person' ? 0.32 : (playerEntity?.bodySpec?.length || 4.36) / 2;
    player.push = bicycle ? 0.82 : activeMode === 'person' ? 0.88 : 0.50;

    // 1. Cars & buses
    // Limit attempted placements, not just successes, and rotate through the pool so an awkward location
    // cannot monopolize a frame. Previous-frame lane lists protect spawn spacing; rebuild before driving.
    let budget = jump ? vehicles.length : 4;
    for (let scanned = 0; scanned < vehicles.length && budget > 0; scanned++) {
      const v = vehicles[vehicleCursor];
      vehicleCursor = (vehicleCursor + 1) % vehicles.length;
      const d = v.edge ? Math.hypot(v.x - focusX, v.z - focusZ) : Infinity;
      if (d <= (jump ? NEAR_RADIUS : VEHICLE_RADIUS)) continue;
      budget--;
      spawnVehicle(v, jump ? 0 : 100, NEAR_RADIUS, !jump);
    }
    buildOccupancy();
    for (const m of bodyMeshes) m.count = 0;
    litVehicleCount = 0;
    wheelCars = 0;
    visibleCars = 0;
    visibleBuses = 0;
    busAxles = 0;
    for (const set of Object.values(busSets)) set.count = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;

      v.prevX = v.x;
      v.prevZ = v.z;
      relateToPlayer(v);
      drive(v, dt);
      if (!v.edge) continue;
      locate(v);
      knock(v, dt);
      pose(v, dt);
      if (player.active) collideWithPlayer(v, v.yaw + v.yawOffset, v.halfWidth, v.half);
      if (v.vx * v.vx + v.vz * v.vz > 0.36) knockOn(v);

      if (v.bus) renderBus(v);
      else renderCar(v);
    }
    const hideEmpty = ++updates > 2;
    for (const m of bodyMeshes) {
      const n = m.count;
      m.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          m.setMatrixAt(0, zero);
          m.count = 1;
          flagRange(m.instanceMatrix, 1);
        }
        continue;
      }
      flagRange(m.instanceMatrix, n);
      if (dirtyPaint.has(m)) flagRange(m.geometry.attributes.paintColor, n);
      if (dirtyState.has(m)) flagRange(m.geometry.attributes.carState, n);
    }
    dirtyPaint.clear();
    dirtyState.clear();
    const syncInst = (inst, n) => {
      inst.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          inst.setMatrixAt(0, zero);
          inst.count = 1;
          flagRange(inst.instanceMatrix, 1);
        } else {
          inst.count = 0;
        }
        return;
      }
      inst.count = n;
      flagRange(inst.instanceMatrix, n);
    };
    syncInst(carWheelLeftInst, wheelCars * 2);
    syncInst(carWheelRightInst, wheelCars * 2);
    syncInst(carShadowInst, visibleCars);
    for (const set of Object.values(busSets)) {
      syncInst(set.body, set.count);
      if (set.count > 0) flagRange(set.states, set.count);
    }
    syncInst(busWheelLeftInst, busAxles);
    syncInst(busWheelRightInst, busAxles);
    syncInst(busShadowInst, visibleBuses);
    updateTrafficLights();

    // 2. Pedestrians
    pedestrianSystem.update(dt, elapsed, focusX, focusZ, jump, hasView, activeMode);

    // 3. Collision sparks, including the player's own impacts against buildings
    if (playerEntity && playerEntity.lastCollisionSpark) {
      const bs = playerEntity.lastCollisionSpark;
      spawnCollisionSparks(bs.x, bs.y, bs.z, bs.nx, bs.nz, bs.speed);
      playerEntity.lastCollisionSpark = null;
    }
    updateSparks(dt);
  }

  if (options.debug) Object.assign(options.debug, { room, alongside, mergingAhead, yieldOncoming, yieldToCrossTraffic, boxBusy, vehicles });
  return {
    group,
    update,
    setCollisionListener,
    cars,
    buses,
    peds: pedestrianSystem.peds,
    get network() { return network; },
    setNetwork,
    get jamRetired() { return jamRetired; }
  };
}


export { createTrafficSystem };
