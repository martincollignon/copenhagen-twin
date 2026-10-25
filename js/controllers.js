import * as THREE from 'three/webgpu';
import { ISLAND_BOUNDS, getIslandBoundsAtZ, isTypingInField, TELEPORT_LOCATIONS } from './city-config.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';

// js/controllers.js
// Sculpted, non-blocky GTA 6-style 3D models, animations, and physics controllers
// for Third-Person Navigation:
// 1. Person (Skinned Pedestrian: planted-footstep IK walk/run/jump, see pedestrians.js)
// 2. Car (Aerodynamic Sculpted Hatchback with Sloped Windshield & Clearcoat)
// 3. City Bike and Long-John Cargo Bike (Procedural Frames with Skinned Riders)
// 4. Helicopter (Sightseeing Twin-Turbine Chopper)

// Spawn at Nørre Søgade 37 (the frame origin); the vehicles are staggered around it
const SPAWN_Z = TELEPORT_LOCATIONS.ns37.z;
const groundCollider = { type: 'ground' };

const CAR_DRIVE = {
  speed: 23.5, boostSpeed: 36, reverseSpeed: 10.5, acceleration: 4.5, boostAcceleration: 5.25,
  powerSpeed: 12.5, // Above 45 km/h, engine power limits acceleration.
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9
};
const BICYCLE_DRIVE = {
  speed: 25 / 3.6, boostSpeed: 30 / 3.6, reverseSpeed: 4.5, acceleration: 9, boostAcceleration: 13.5,
  rolling: 0.08, drag: 0.004, coast: 0.2, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};
const CARGO_BICYCLE_DRIVE = { ...BICYCLE_DRIVE, speed: 25 / 3.6, boostSpeed: 30 / 3.6 };

function driveSpeed(speed, throttle, boost, dt, drive) {
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : boost ? drive.boostSpeed : drive.speed;
  let acceleration = boost ? drive.boostAcceleration : drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  // Releasing boost removes the extra power; existing momentum decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

function addBikeBeam(parent, start, end, startRadius, endRadius, material, radialSegments = 10) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const axis = b.clone().sub(a);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(endRadius, startRadius, axis.length(), radialSegments),
    material
  );
  beam.position.copy(a).add(b).multiplyScalar(0.5);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
  parent.add(beam);
  return beam;
}

function alignBikeLink(link, start, end) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const axis = b.clone().sub(a);
  link.position.copy(a).add(b).multiplyScalar(0.5);
  link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
  link.scale.y = axis.length();
}

function createCargoRailGeometry(side) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * 0.033, 0.31, -0.49),
    new THREE.Vector3(side * 0.105, 0.27, -0.30),
    new THREE.Vector3(side * 0.208, 0.25, -0.075),
    new THREE.Vector3(side * 0.208, 0.25, 0.25),
    new THREE.Vector3(side * 0.208, 0.25, 0.49),
    new THREE.Vector3(side * 0.177, 0.31, 0.595),
    new THREE.Vector3(side * 0.094, 0.48, 0.69),
    new THREE.Vector3(side * 0.025, 0.61, 0.745)
  ], false, 'centripetal');
  const positions = [], indices = [];
  const rings = 80, segments = 20;
  for (let i = 0; i <= rings; i++) {
    const center = curve.getPoint(i / rings);
    const tangent = curve.getTangent(i / rings).normalize();
    const across = new THREE.Vector3(1, 0, 0).addScaledVector(tangent, -tangent.x).normalize();
    const up = new THREE.Vector3().crossVectors(tangent, across).normalize();
    for (let j = 0; j < segments; j++) {
      const a = j / segments * Math.PI * 2;
      const c = Math.cos(a), t = Math.sin(a);
      const x = Math.sign(c) * Math.pow(Math.abs(c), 0.35) * 0.020;
      const y = Math.sign(t) * Math.pow(Math.abs(t), 0.35) * 0.037;
      const point = center.clone().addScaledVector(across, x).addScaledVector(up, y);
      positions.push(point.x, point.y, point.z);
      if (i) {
        const prev = (i - 1) * segments + j, next = (j + 1) % segments;
        indices.push(prev, (i - 1) * segments + next, i * segments + j,
          (i - 1) * segments + next, i * segments + next, i * segments + j);
      }
    }
  }
  for (const ring of [0, rings]) {
    const center = curve.getPoint(ring / rings);
    const index = positions.length / 3;
    positions.push(center.x, center.y, center.z);
    for (let j = 0; j < segments; j++) {
      const a = ring * segments + j, b = ring * segments + (j + 1) % segments;
      indices.push(index, ring === 0 ? b : a, ring === 0 ? a : b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBikeSpokeGeometry(radius) {
  const positions = [];
  const indices = [];
  const spokeRadius = 0.00135;
  const sides = 6;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 16; i++) {
      const startAngle = i * Math.PI / 8;
      const endAngle = startAngle + (i % 2 === 0 ? Math.PI / 8 : -Math.PI / 8);
      const start = [side * 0.024, Math.cos(startAngle) * 0.044, Math.sin(startAngle) * 0.044];
      const end = [side * 0.008, Math.cos(endAngle) * (radius - 0.047), Math.sin(endAngle) * (radius - 0.047)];
      const axis = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
      const length = Math.hypot(...axis) || 1;
      const around = [0, axis[2] / length, -axis[1] / length];
      const base = positions.length / 3;
      for (const point of [start, end]) {
        for (let j = 0; j < sides; j++) {
          const angle = j * Math.PI * 2 / sides;
          positions.push(
            point[0] + Math.cos(angle) * spokeRadius,
            point[1] + Math.sin(angle) * around[1] * spokeRadius,
            point[2] + Math.sin(angle) * around[2] * spokeRadius
          );
        }
      }
      for (let j = 0; j < sides; j++) {
        const next = (j + 1) % sides;
        const a = base + j, b = base + next, c = base + sides + j, d = base + sides + next;
        indices.push(a, c, b, b, c, d);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBikeFenderGeometry(radius, width = 0.047, startAngle = 0, endAngle = Math.PI) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const segments = 28;
  const outerRadius = radius + 0.014;
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + i / segments * (endAngle - startAngle);
    const y = Math.sin(angle) * outerRadius;
    const z = Math.cos(angle) * outerRadius;
    positions.push(-width * 0.5, y, z, width * 0.5, y, z);
    uvs.push(0, i / segments, 1, i / segments);
    if (i === 0) continue;
    const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function roundedBikeShape(width, height, radius) {
  const x = width * 0.5, y = height * 0.5, r = Math.min(radius, x, y);
  const shape = new THREE.Shape();
  shape.moveTo(-x + r, -y);
  shape.lineTo(x - r, -y);
  shape.quadraticCurveTo(x, -y, x, -y + r);
  shape.lineTo(x, y - r);
  shape.quadraticCurveTo(x, y, x - r, y);
  shape.lineTo(-x + r, y);
  shape.quadraticCurveTo(-x, y, -x, y - r);
  shape.lineTo(-x, -y + r);
  shape.quadraticCurveTo(-x, -y, -x + r, -y);
  return shape;
}

function addBikeCable(parent, points, material, radius = 0.0032) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, radius, 5, false), material);
  parent.add(cable);
  return cable;
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const cargoBike = mode === 'cargobike';
  const oriented = car || cargoBike;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = (car ? 0.86 : cargoBike ? 0.38 : radius) + margin;
  const hz = (car ? 2.18 : cargoBike ? 1.34 : radius) + margin;
  return {
    car, oriented, sin, cos, hx, hz, radius: radius + margin,
    extX: oriented ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: oriented ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// Shared by movement and teleport clearance. World bounds reject distant boxes cheaply; the narrow phase
// uses a circle for walking/city cycling/flying and separating axes for cars and the long cargo bike.
function buildingContact(c, x, y, z, body, contact) {
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.oriented) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createLicensePlateTexture() {
  // Danish-style plate: white with a red border and a made-up registration
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#c8102e';
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, 244, 116);
  ctx.fillStyle = '#17212c';
  ctx.font = '900 44px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('XA 10 001', 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'cargobike' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      cargobike: this.createCargoBikeEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC'],
      boost: ['ShiftLeft', 'ShiftRight']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = 1;
    } else if (this.activeMode === 'cyclist' || this.activeMode === 'cargobike') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
      if (ent.frontSteerPivot) ent.frontSteerPivot.rotation.y = 0;
      if (ent.handlebarPivot) ent.handlebarPivot.rotation.y = 0;
      if (ent.bikeFrame) ent.bikeFrame.steerAngle = 0;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : this.activeMode === 'cargobike' ? 1.4 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body bounds, including car corners, bicycle wheels, the cargo frame and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], cargobike: [1.4, 1.9], helicopter: [6.2, 3.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + margin, pz));
      px = Math.max(ISLAND_BOUNDS.minX - margin, Math.min(ISLAND_BOUNDS.maxX + margin, px));
      if (!heli && getIslandBoundsAtZ) {
        const shore = getIslandBoundsAtZ(pz);
        const west = shore.westX + 8, east = shore.eastX - 8;
        if (west > east) return null;
        px = Math.max(west, Math.min(east, px));
      }
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(ISLAND_BOUNDS.minX, Math.min(ISLAND_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(ISLAND_BOUNDS.minZ + 30, Math.min(ISLAND_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      mesh: root,
      crowd,
      rig,
      position: new THREE.Vector3(-11.6, ISLAND_BOUNDS.sidewalkHeight, SPAWN_Z + 12),
      heading: 0,
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED SCULPTED HATCHBACK)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS.sedan;
    const carLoftMat = createLoftedCarMaterial(spec, 0x1d3b6c);

    // 1. 3D Lofted Body + Curved Windscreens + Crowned Roof + Side Mirrors
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, carLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Danish-style license plates on the bumpers
    const plateTex = createLicensePlateTexture();
    const plateMat = new THREE.MeshStandardNodeMaterial({ map: plateTex, roughness: 0.28 });
    const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), plateMat);
    rearPlate.position.set(0, spec.plates[1], spec.zRear - 0.006);
    chassisPivot.add(rearPlate);

    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), plateMat);
    frontPlate.position.set(0, spec.plates[0], spec.zFront + 0.006);
    chassisPivot.add(frontPlate);

    // 3b. Brake lights, CHMSL & turn signals are lit by the car material from its carState uniform (see updateCar)
    const carState = carLoftMat.userData.carState;

    // 4. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, carLoftMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront });
    }

    // 5. Soft Under-Car Contact Shadow (AO) + Clustered Dual LED Headlight SpotLights & Rear Brake PointLight
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);

    return {
      type: 'car',
      label: 'Car',
      mesh: root,
      chassisPivot,
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(3.6, 0.0, SPAWN_Z + 12),
      heading: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'City bike',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: new THREE.Vector3(5.2, 0.0, SPAWN_Z - 8),
      heading: 0,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      standAmount: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  createCargoBikeEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCargoBike';
    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = new THREE.MeshPhysicalNodeMaterial({
      color: 0xffd000, roughness: 0.27, metalness: 0.14, clearcoat: 0.68, clearcoatRoughness: 0.22
    });
    const alloyMat = new THREE.MeshStandardNodeMaterial({ color: 0xbfc4c6, roughness: 0.3, metalness: 0.82 });
    const brightMetalMat = new THREE.MeshStandardNodeMaterial({ color: 0xe0e2df, roughness: 0.24, metalness: 0.88 });
    const darkMetalMat = new THREE.MeshStandardNodeMaterial({ color: 0x25282b, roughness: 0.42, metalness: 0.58 });
    const blackMat = new THREE.MeshStandardNodeMaterial({ color: 0x17191b, roughness: 0.68, metalness: 0.08 });
    const rubberMat = new THREE.MeshStandardNodeMaterial({ color: 0x111315, roughness: 0.9, metalness: 0.01 });
    const gripMat = new THREE.MeshStandardNodeMaterial({ color: 0x171819, roughness: 0.83 });
    const fenderMat = new THREE.MeshStandardNodeMaterial({ color: 0x1b1d20, roughness: 0.28, metalness: 0.25, side: THREE.DoubleSide });
    const spokeMat = new THREE.MeshStandardNodeMaterial({ color: 0xc2c7ca, roughness: 0.36, metalness: 0.85 });
    const rotorMat = new THREE.MeshStandardNodeMaterial({ color: 0xc3c9cc, roughness: 0.35, metalness: 0.45, side: THREE.DoubleSide });
    const helmetMat = new THREE.MeshStandardNodeMaterial({ color: 0xf4f1e9, roughness: 0.32, metalness: 0.06 });

    // The frame is calibrated to a 2.43 m overall length.
    const frontWheelRadius = 0.248;
    const rearWheelRadius = 0.332;
    const frontAxle = [0, frontWheelRadius, 0.925];
    const rearAxle = [0, rearWheelRadius, -0.92];
    const deckStart = -0.04;
    const deckEnd = 0.63;
    const deckCenter = (deckStart + deckEnd) * 0.5;
    const deckWidth = 0.40;

    // Fine non-slip texture for the open load surface.
    const deckCanvas = document.createElement('canvas');
    deckCanvas.width = deckCanvas.height = 256;
    const deckContext = deckCanvas.getContext('2d');
    deckContext.fillStyle = '#292c30';
    deckContext.fillRect(0, 0, 256, 256);
    deckContext.strokeStyle = 'rgba(210,216,218,.13)';
    deckContext.lineWidth = 1;
    for (let y = 0; y <= 256; y += 16) {
      deckContext.beginPath(); deckContext.moveTo(0, y); deckContext.lineTo(256, y); deckContext.stroke();
    }
    let noiseSeed = 37;
    const deckRandom = () => ((noiseSeed = (noiseSeed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 1100; i++) {
      deckContext.fillStyle = `rgba(225,230,231,${0.025 + deckRandom() * 0.065})`;
      deckContext.fillRect(deckRandom() * 256, deckRandom() * 256, 1 + deckRandom() * 2, 1);
    }
    const deckTexture = new THREE.CanvasTexture(deckCanvas);
    deckTexture.colorSpace = THREE.SRGBColorSpace;
    deckTexture.wrapS = deckTexture.wrapT = THREE.RepeatWrapping;
    const deckMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, map: deckTexture, roughness: 0.94, metalness: 0.02 });

    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(createCargoRailGeometry(side), frameMat);
      rail.castShadow = rail.receiveShadow = true;
      leanPivot.add(rail);
    }

    // The load board fits between the rails; low-profile tie downs stay flush with the deck.
    const deckShape = roundedBikeShape(deckWidth, deckEnd - deckStart, 0.025);
    const deckGeometry = new THREE.ExtrudeGeometry(deckShape, {
      depth: 0.018, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 2, curveSegments: 8
    });
    deckGeometry.rotateX(-Math.PI * 0.5);
    const deck = new THREE.Mesh(deckGeometry, deckMat);
    deck.position.set(0, 0.25, deckCenter);
    deck.receiveShadow = true;
    leanPivot.add(deck);
    const tieDownGeo = new THREE.TorusGeometry(0.018, 0.0028, 5, 16);
    tieDownGeo.rotateX(Math.PI * 0.5);
    for (const x of [-0.16, 0.16]) {
      for (const z of [0.01, 0.29, 0.58]) {
        const loop = new THREE.Mesh(tieDownGeo, brightMetalMat);
        loop.position.set(x, 0.274, z);
        leanPivot.add(loop);
      }
    }
    const deckBoltGeo = new THREE.SphereGeometry(0.005, 8, 6);
    for (const side of [-1, 1]) {
      for (const z of [0.02, 0.57]) {
        const bolt = new THREE.Mesh(deckBoltGeo, brightMetalMat);
        bolt.position.set(side * 0.222, 0.255, z);
        bolt.scale.set(1.1, 0.8, 0.8);
        leanPivot.add(bolt);
      }
    }

    // Bottom bracket, paired chain stays, paired seat stays, and a proper sloping seat tube.
    const bracket = [0, 0.279, -0.542];
    const seatJunction = [0, 0.685, -0.663];
    for (const side of [-1, 1]) {
      addBikeBeam(leanPivot, [side * 0.08, 0.279, -0.542], [side * 0.055, rearAxle[1], rearAxle[2]], 0.017, 0.013, frameMat, 12);
      addBikeBeam(leanPivot, [side * 0.055, rearAxle[1], rearAxle[2]], [side * 0.06, seatJunction[1], seatJunction[2]], 0.012, 0.014, frameMat, 10);
    }
    addBikeBeam(leanPivot, bracket, seatJunction, 0.022, 0.020, frameMat, 16);

    // Curved rear cargo braces converge at the steering-column crown.
    for (const side of [-1, 1]) {
      const brace = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.202, 0.275, -0.055),
        new THREE.Vector3(side * 0.202, 0.55, -0.075),
        new THREE.Vector3(side * 0.18, 0.625, -0.09),
        new THREE.Vector3(side * 0.08, 0.715, -0.115),
        new THREE.Vector3(0, 0.744, -0.115)
      ]);
      leanPivot.add(new THREE.Mesh(new THREE.TubeGeometry(brace, 28, 0.016, 12, false), frameMat));
    }
    addBikeBeam(leanPivot, [0, 0.245, -0.115], [0, 0.80, -0.115], 0.026, 0.024, frameMat, 18);
    const topTube = addBikeBeam(leanPivot, [0, 0.685, -0.663], [0, 0.744, -0.115], 0.023, 0.027, frameMat, 18);
    topTube.scale.x = 0.84;

    // Thin infill follows the nose between the converging beams.
    const noseVertices = [];
    const noseIndices = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const z = 0.51 + t * 0.22;
      const y = 0.268 + t * 0.33;
      const halfWidth = 0.188 * (1 - t) + 0.025 * t;
      noseVertices.push(-halfWidth, y, z, halfWidth, y, z);
      if (i) { const a = (i - 1) * 2; noseIndices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const noseGeometry = new THREE.BufferGeometry();
    noseGeometry.setAttribute('position', new THREE.Float32BufferAttribute(noseVertices, 3));
    noseGeometry.setIndex(noseIndices);
    noseGeometry.computeVertexNormals();
    const noseMat = blackMat.clone();
    noseMat.side = THREE.DoubleSide;
    leanPivot.add(new THREE.Mesh(noseGeometry, noseMat));

    // Seatpost, clamp, underside rails and a shaped padded saddle.
    addBikeBeam(leanPivot, [0, 0.685, -0.663], [0, 0.985, -0.712], 0.027, 0.022, darkMetalMat, 12);
    const postClamp = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.005, 6, 18), alloyMat);
    postClamp.rotation.x = Math.PI * 0.5;
    postClamp.position.set(0, 0.755, -0.674);
    leanPivot.add(postClamp);
    const saddleShape = new THREE.Shape();
    saddleShape.moveTo(0, -0.15);
    saddleShape.bezierCurveTo(-0.04, -0.14, -0.058, -0.09, -0.063, -0.02);
    saddleShape.bezierCurveTo(-0.12, 0.005, -0.13, 0.09, -0.105, 0.135);
    saddleShape.bezierCurveTo(-0.07, 0.18, 0.07, 0.18, 0.105, 0.135);
    saddleShape.bezierCurveTo(0.13, 0.09, 0.12, 0.005, 0.063, -0.02);
    saddleShape.bezierCurveTo(0.058, -0.09, 0.04, -0.14, 0, -0.15);
    saddleShape.closePath();
    const saddleGeometry = new THREE.ExtrudeGeometry(saddleShape, {
      depth: 0.018, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.010, bevelSegments: 4, curveSegments: 10
    });
    saddleGeometry.scale(0.61, 0.78, 1);
    saddleGeometry.rotateX(-Math.PI * 0.5);
    const saddle = new THREE.Mesh(saddleGeometry, blackMat);
    saddle.position.set(0, 0.982, -0.712);
    saddle.castShadow = true;
    leanPivot.add(saddle);
    for (const side of [-1, 1]) {
      addBikeBeam(leanPivot, [side * 0.018, 0.965, -0.712], [side * 0.045, 0.96, -0.64], 0.004, 0.004, alloyMat, 6);
    }

    // Tall narrow battery pack tucked just behind the front column.
    const batteryShape = roundedBikeShape(0.115, 0.33, 0.035);
    const batteryGeometry = new THREE.ExtrudeGeometry(batteryShape, {
      depth: 0.085, bevelEnabled: true, bevelThickness: 0.009, bevelSize: 0.01, bevelSegments: 3, curveSegments: 8
    });
    batteryGeometry.translate(0, 0, -0.0425);
    const battery = new THREE.Mesh(batteryGeometry, new THREE.MeshStandardNodeMaterial({ color: 0x202326, roughness: 0.56, metalness: 0.2 }));
    battery.position.set(0, 0.49, -0.175);
    battery.castShadow = true;
    leanPivot.add(battery);
    const batterySeam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.008, 0.092), darkMetalMat);
    batterySeam.position.set(0, 0.50, -0.175);
    leanPivot.add(batterySeam);

    // Front steering axis is at the raised nose; the small wheel trails from the swept fork.
    const frontSteerPivot = new THREE.Group();
    frontSteerPivot.position.set(0, 0.60, 0.77);
    leanPivot.add(frontSteerPivot);
    addBikeBeam(leanPivot, [0, 0.52, 0.765], [0, 0.65, 0.72], 0.028, 0.028, frameMat, 18);
    addBikeBeam(leanPivot, [0, 0.65, 0.72], [0, 0.66, 0.717], 0.028, 0.028, blackMat, 18);
    const frontWheel = new THREE.Group();
    frontWheel.position.set(0, frontAxle[1] - 0.60, frontAxle[2] - 0.77);
    frontSteerPivot.add(frontWheel);
    const rearWheel = new THREE.Group();
    rearWheel.position.set(...rearAxle);
    leanPivot.add(rearWheel);

    const buildWheel = (wheel, radius) => {
      const tireGeometry = new THREE.TorusGeometry(radius - 0.024, 0.024, 14, 64);
      tireGeometry.rotateY(Math.PI * 0.5);
      const tire = new THREE.Mesh(tireGeometry, rubberMat);
      tire.castShadow = true;
      wheel.add(tire);
      const sidewallGeometry = new THREE.TorusGeometry(radius - 0.026, 0.0015, 5, 64);
      sidewallGeometry.rotateY(Math.PI * 0.5);
      for (const side of [-1, 1]) {
        const stripe = new THREE.Mesh(sidewallGeometry, darkMetalMat);
        stripe.position.x = side * 0.021;
        wheel.add(stripe);
      }
      const rimGeometry = new THREE.TorusGeometry(radius - 0.052, 0.007, 7, 64);
      rimGeometry.rotateY(Math.PI * 0.5);
      wheel.add(new THREE.Mesh(rimGeometry, blackMat));
      const beadGeometry = new THREE.TorusGeometry(radius - 0.031, 0.0015, 5, 64);
      beadGeometry.rotateY(Math.PI * 0.5);
      for (const side of [-1, 1]) {
        const bead = new THREE.Mesh(beadGeometry, alloyMat);
        bead.position.x = side * 0.021;
        wheel.add(bead);
      }
      wheel.add(new THREE.Mesh(createBikeSpokeGeometry(radius), spokeMat));
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.12, 16), darkMetalMat);
      hub.rotation.z = -Math.PI * 0.5;
      wheel.add(hub);
      for (const side of [-1, 1]) {
        const endCap = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, 0.018, 12), alloyMat);
        endCap.rotation.z = -Math.PI * 0.5;
        endCap.position.x = side * 0.066;
        wheel.add(endCap);
      }
      const rotorShape = new THREE.Shape();
      rotorShape.absarc(0, 0, 0.09, 0, Math.PI * 2, false);
      const centerHole = new THREE.Path();
      centerHole.absarc(0, 0, 0.066, 0, Math.PI * 2, true);
      rotorShape.holes.push(centerHole);
      for (let i = 0; i < 24; i++) {
        const a = i * Math.PI / 12;
        const hole = new THREE.Path();
        hole.absarc(Math.cos(a) * 0.078, Math.sin(a) * 0.078, 0.0038, 0, Math.PI * 2, true);
        rotorShape.holes.push(hole);
      }
      const rotor = new THREE.Mesh(new THREE.ShapeGeometry(rotorShape, 48), rotorMat);
      rotor.rotation.y = Math.PI * 0.5;
      rotor.position.x = -0.055;
      wheel.add(rotor);
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        addBikeBeam(wheel, [-0.055, Math.cos(a) * 0.019, Math.sin(a) * 0.019],
          [-0.055, Math.cos(a + 0.3) * 0.069, Math.sin(a + 0.3) * 0.069], 0.0038, 0.0045, brightMetalMat, 6);
      }
    };
    buildWheel(frontWheel, frontWheelRadius);
    buildWheel(rearWheel, rearWheelRadius);

    // Broad sheet fenders follow each wheel's upper half and stay clear of the rotating tyre.
    const rearFender = new THREE.Mesh(createBikeFenderGeometry(rearWheelRadius), fenderMat);
    rearFender.position.copy(rearWheel.position);
    rearFender.receiveShadow = true;
    leanPivot.add(rearFender);
    const frontFender = new THREE.Mesh(createBikeFenderGeometry(frontWheelRadius, 0.047, 1.25, 3.12), fenderMat);
    frontFender.position.copy(frontWheel.position);
    frontFender.receiveShadow = true;
    frontSteerPivot.add(frontFender);
    for (const side of [-1, 1]) {
      addBikeBeam(leanPivot, [side * 0.045, rearAxle[1], rearAxle[2]],
        [side * 0.024, rearAxle[1] + 0.02, rearAxle[2] - rearWheelRadius - 0.012], 0.002, 0.002, alloyMat, 6);
      addBikeBeam(frontSteerPivot, [side * 0.045, frontWheel.position.y, frontWheel.position.z],
        [side * 0.024, frontWheel.position.y + 0.02, frontWheel.position.z - frontWheelRadius - 0.012], 0.002, 0.002, alloyMat, 6);
    }

    // Curved tapered fork blades and short forged dropouts.
    for (const side of [-1, 1]) {
      const forkCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.045, -0.055, 0.008), new THREE.Vector3(side * 0.053, -0.16, 0.055),
        new THREE.Vector3(side * 0.062, -0.28, 0.115), new THREE.Vector3(side * 0.066, -0.352, 0.155)
      ]);
      frontSteerPivot.add(new THREE.Mesh(new THREE.TubeGeometry(forkCurve, 24, 0.014, 14, false), frameMat));
      addBikeBeam(frontSteerPivot, [side * 0.066, -0.352, 0.155], [side * 0.066, -0.36, 0.155], 0.022, 0.023, darkMetalMat, 8);
    }

    // This small bridge welds the wide deck rail nose into the center head tube.
    addBikeBeam(frontSteerPivot, [-0.045, -0.055, 0.008], [0.045, -0.055, 0.008], 0.015, 0.015, frameMat, 12);

    // Front and rear brake calipers are mounted to the fork/stay while the rotors turn with the wheels.
    const frontCaliper = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.085, 0.06), blackMat);
    frontCaliper.scale.setScalar(0.7);
    frontCaliper.position.set(-0.065, -0.287, 0.11);
    frontSteerPivot.add(frontCaliper);
    const rearCaliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.055), blackMat);
    rearCaliper.scale.setScalar(0.7);
    rearCaliper.position.set(-0.065, 0.394, -0.87);
    leanPivot.add(rearCaliper);

    // 183 mm chainring and 225 mm largest cassette sprocket, traced independently
    // from the rear tyre. The chain engages a small cassette sprocket, not its outer guard.
    const crankLength = 0.17;
    const crankPivot = new THREE.Group();
    crankPivot.position.set(...bracket);
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, 0.0915, 0, Math.PI * 2, false);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const hole = new THREE.Path();
      hole.absarc(Math.cos(a) * 0.055, Math.sin(a) * 0.055, 0.024, 0, Math.PI * 2, true);
      ringShape.holes.push(hole);
    }
    const ringGeometry = new THREE.ExtrudeGeometry(ringShape, { depth: 0.005, bevelEnabled: true, bevelSize: 0.001, bevelThickness: 0.001, bevelSegments: 2, curveSegments: 24 });
    ringGeometry.rotateY(Math.PI / 2);
    const chainring = new THREE.Mesh(ringGeometry, blackMat);
    chainring.position.x = 0.085;
    crankPivot.add(chainring);
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.004, 0.006, 0.004), darkMetalMat, 44);
    const toothTransform = new THREE.Object3D();
    for (let i = 0; i < 44; i++) {
      const a = i / 44 * Math.PI * 2;
      toothTransform.position.set(0.088, Math.cos(a) * 0.091, Math.sin(a) * 0.091);
      toothTransform.rotation.x = a;
      toothTransform.updateMatrix();
      teeth.setMatrixAt(i, toothTransform.matrix);
    }
    crankPivot.add(teeth);
    const crankGeo = new THREE.BoxGeometry(0.025, crankLength, 0.025).translate(0, -crankLength / 2, 0);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, darkMetalMat);
      crank.position.x = side * 0.106;
      arm.add(crank);
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.018, 0.062), blackMat);
      pedal.position.set(side * 0.14, -crankLength, 0);
      arm.add(pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);
    const motorShape = roundedBikeShape(0.20, 0.13, 0.04);
    const motorGeometry = new THREE.ExtrudeGeometry(motorShape, { depth: 0.10, bevelEnabled: true, bevelThickness: 0.009, bevelSize: 0.009, bevelSegments: 3, curveSegments: 12 });
    motorGeometry.translate(0, 0, -0.05);
    motorGeometry.rotateY(Math.PI / 2);
    const motor = new THREE.Mesh(motorGeometry, darkMetalMat);
    motor.position.set(0, 0.28, -0.50);
    leanPivot.add(motor);
    const cassetteSpokes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0015, 1, 0.004), rotorMat, 55);
    const cassetteTransform = new THREE.Object3D();
    for (let i = 0; i < 11; i++) {
      const radius = 0.038 + i * 0.0075;
      const shape = new THREE.Shape();
      const toothCount = 13 + i * 3;
      for (let j = 0; j < toothCount * 4; j++) {
        const a = j / (toothCount * 4) * Math.PI * 2;
        const r = j % 4 === 1 || j % 4 === 2 ? radius : radius - 0.003;
        if (j === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      shape.closePath();
      const axleHole = new THREE.Path();
      axleHole.absarc(0, 0, radius - 0.007, 0, Math.PI * 2, true);
      shape.holes.push(axleHole);
      const cog = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.0015, bevelEnabled: false, curveSegments: 10 }), rotorMat);
      cog.rotation.y = Math.PI / 2;
      cog.position.x = 0.092 - i * 0.0035;
      rearWheel.add(cog);
      for (let j = 0; j < 5; j++) {
        const a = j * Math.PI * 2 / 5;
        const inner = 0.017, outer = radius - 0.004;
        cassetteTransform.position.set(0.092 - i * 0.0035, Math.cos(a) * (inner + outer) / 2, Math.sin(a) * (inner + outer) / 2);
        cassetteTransform.rotation.set(a, 0, 0);
        cassetteTransform.scale.set(1, outer - inner, 1);
        cassetteTransform.updateMatrix();
        cassetteSpokes.setMatrixAt(i * 5 + j, cassetteTransform.matrix);
      }
    }
    rearWheel.add(cassetteSpokes);
    const derailleur = new THREE.Group();
    derailleur.position.x = 0.10;
    leanPivot.add(derailleur);
    addBikeBeam(derailleur, [0, 0.332, -0.92], [0.01, 0.25, -0.95], 0.019, 0.015, blackMat, 10);
    addBikeBeam(derailleur, [0.01, 0.25, -0.95], [0.01, 0.219, -0.966], 0.017, 0.014, blackMat, 10);
    for (const side of [-1, 1]) {
      addBikeBeam(derailleur, [side * 0.007, 0.219, -0.966], [side * 0.007, 0.146, -1.021], 0.008, 0.008, darkMetalMat, 8);
    }
    for (const [y, z] of [[0.219, -0.966], [0.146, -1.021]]) {
      const jockey = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, 0.012, 12), blackMat);
      jockey.rotation.z = Math.PI / 2;
      jockey.position.set(0, y, z);
      derailleur.add(jockey);
      const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), alloyMat);
      bolt.position.set(0.009, y, z);
      derailleur.add(bolt);
    }
    const chainPoints = [
      [0.088, 0.3705, -0.542], [0.092, 0.370, -0.92],
      [0.092, 0.358, -0.948], [0.092, 0.332, -0.958], [0.096, 0.300, -0.944],
      [0.10, 0.24, -0.946], [0.10, 0.219, -0.943], [0.10, 0.198, -0.962],
      [0.10, 0.165, -1.038], [0.10, 0.146, -1.044], [0.10, 0.126, -1.033],
      [0.10, 0.123, -1.021], [0.088, 0.1875, -0.542]
    ];
    for (let i = 1; i <= 20; i++) {
      const a = -Math.PI / 2 + i / 20 * Math.PI;
      chainPoints.push([0.088, 0.279 + Math.sin(a) * 0.0915, -0.542 + Math.cos(a) * 0.0915]);
    }
    const chainPath = new THREE.CurvePath();
    for (let i = 1; i < chainPoints.length; i++) {
      chainPath.add(new THREE.LineCurve3(new THREE.Vector3(...chainPoints[i - 1]), new THREE.Vector3(...chainPoints[i])));
    }
    leanPivot.add(new THREE.Mesh(new THREE.TubeGeometry(chainPath, 180, 0.0031, 5, false), brightMetalMat));

    // Folded twin kickstand tucks under the frame.
    const standPivot = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 10), darkMetalMat);
    standPivot.rotation.x = Math.PI * 0.5;
    standPivot.position.set(0, 0.18, -0.02);
    leanPivot.add(standPivot);
    for (const side of [-1, 1]) {
      addBikeBeam(leanPivot, [side * 0.025, 0.19, -0.02], [side * 0.12, 0.15, -0.24], 0.012, 0.01, darkMetalMat, 8);
      const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.045, 4, 8), blackMat);
      foot.rotation.z = Math.PI * 0.5;
      foot.position.set(side * 0.12, 0.15, -0.24);
      leanPivot.add(foot);
    }

    // Upright riser and swept-back cockpit with rubber grips, brake levers, bell and a small unbranded display.
    const handlebarPivot = new THREE.Group();
    handlebarPivot.position.set(0, 0.80, -0.115);
    leanPivot.add(handlebarPivot);
    const handlebarRiser = addBikeBeam(handlebarPivot, [0, 0, 0], [0, 0.15, 0.02], 0.021, 0.019, darkMetalMat, 16);
    const stemFace = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.055, 0.035), darkMetalMat);
    stemFace.position.set(0, 0.27, 0.06);
    handlebarPivot.add(stemFace);
    for (const side of [-1, 1]) {
      for (const y of [0.255, 0.285]) {
        const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), brightMetalMat);
        bolt.position.set(side * 0.021, y, 0.083);
        handlebarPivot.add(bolt);
      }
    }
    const barCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.34, 0.29, 0.00), new THREE.Vector3(-0.25, 0.29, 0.045),
      new THREE.Vector3(-0.13, 0.305, 0.065), new THREE.Vector3(0, 0.31, 0.07),
      new THREE.Vector3(0.13, 0.305, 0.065), new THREE.Vector3(0.25, 0.29, 0.045),
      new THREE.Vector3(0.34, 0.29, 0.00)
    ]);
    handlebarPivot.add(new THREE.Mesh(new THREE.TubeGeometry(barCurve, 36, 0.012, 8, false), darkMetalMat));
    for (const side of [-1, 1]) {
      addBikeBeam(handlebarPivot, [side * 0.255, 0.29, 0.04], [side * 0.34, 0.29, 0.00], 0.023, 0.024, gripMat, 10);
      const endCap = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.012, 12), blackMat);
      endCap.rotation.z = Math.PI * 0.5;
      endCap.position.set(side * 0.343, 0.29, 0);
      handlebarPivot.add(endCap);
      const clamp = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 6, 16), alloyMat);
      clamp.rotation.y = Math.PI * 0.5;
      clamp.position.set(side * 0.205, 0.29, 0.05);
      handlebarPivot.add(clamp);
      addBikeBeam(handlebarPivot, [side * 0.20, 0.285, 0.03], [side * 0.26, 0.225, -0.06], 0.008, 0.006, blackMat, 8);
      const brakeHousing = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.045, 0.055), blackMat);
      brakeHousing.position.set(side * 0.23, 0.29, 0.015);
      handlebarPivot.add(brakeHousing);
    }
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.023, 0.016, 16), alloyMat);
    bell.position.set(-0.11, 0.325, 0.065);
    handlebarPivot.add(bell);
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 160;
    screenCanvas.height = 104;
    const screenContext = screenCanvas.getContext('2d');
    screenContext.fillStyle = '#11191a';
    screenContext.fillRect(0, 0, 160, 104);
    screenContext.strokeStyle = '#586162';
    screenContext.lineWidth = 4;
    screenContext.strokeRect(3, 3, 154, 98);
    screenContext.fillStyle = '#c7e5d0';
    screenContext.font = 'bold 41px ui-monospace, monospace';
    screenContext.fillText('0.0', 17, 65);
    screenContext.font = 'bold 14px ui-monospace, monospace';
    screenContext.fillText('km/h', 96, 64);
    screenContext.strokeStyle = '#c7e5d0';
    screenContext.lineWidth = 3;
    screenContext.strokeRect(118, 18, 25, 12);
    screenContext.fillRect(143, 21, 4, 6);
    screenContext.fillRect(122, 21, 15, 6);
    const screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    const screenHousing = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.085, 0.025), blackMat);
    screenHousing.scale.setScalar(0.62);
    screenHousing.rotation.x = -0.85;
    screenHousing.position.set(0.10, 0.31, 0.005);
    handlebarPivot.add(screenHousing);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.108, 0.068), new THREE.MeshBasicNodeMaterial({ map: screenTexture, toneMapped: false }));
    screen.scale.setScalar(0.62);
    screen.rotation.set(-0.85, Math.PI, 0);
    screen.position.set(0.10, 0.317, -0.002);
    handlebarPivot.add(screen);

    for (const part of handlebarPivot.children) if (part !== handlebarRiser) part.position.y -= 0.13;

    // The steering rod links the rear crank to the fork arm and is repositioned as both pivots turn.
    addBikeBeam(handlebarPivot, [0, -0.53, 0], [0.18, -0.53, 0], 0.011, 0.01, darkMetalMat, 8);
    addBikeBeam(frontSteerPivot, [0, -0.21, 0], [0.13, -0.21, 0], 0.011, 0.01, darkMetalMat, 8);
    const steeringLinkage = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 8), darkMetalMat);
    alignBikeLink(steeringLinkage, [0.18, 0.27, -0.115], [0.13, 0.39, 0.77]);
    leanPivot.add(steeringLinkage);
    for (const [x, y, z] of [[0.18, 0.27, -0.115], [0.13, 0.39, 0.77]]) {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.021, 9, 7), alloyMat);
      joint.position.set(x, y, z);
      leanPivot.add(joint);
    }

    const cockpitCableMat = new THREE.MeshStandardNodeMaterial({ color: 0x17191a, roughness: 0.68 });
    addBikeCable(leanPivot, [[-0.21, 0.96, -0.10], [-0.18, 0.90, 0.03], [-0.10, 0.82, 0.08], [-0.035, 0.75, -0.075], [-0.035, 0.30, -0.075], [-0.20, 0.23, 0.15], [-0.20, 0.23, 0.52], [-0.08, 0.38, 0.80]], cockpitCableMat, 0.0022);
    addBikeCable(leanPivot, [[0.22, 0.96, -0.10], [0.20, 0.88, 0.04], [0.10, 0.78, 0.07], [0.035, 0.72, -0.115], [0.035, 0.68, -0.50], [0.045, 0.60, -0.68], [-0.06, 0.394, -0.87]], cockpitCableMat, 0.0022);

    // The e-bike front light and rear safety light are attached to the fork and fender support.
    addBikeBeam(frontSteerPivot, [0, 0.015, 0.015], [0, 0, 0.085], 0.005, 0.005, blackMat, 8);
    const frontLampShell = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.042, 0.075, 16), darkMetalMat);
    frontLampShell.rotation.x = Math.PI * 0.5;
    frontLampShell.scale.setScalar(0.66);
    frontLampShell.position.set(0, 0, 0.085);
    frontSteerPivot.add(frontLampShell);
    const frontLampLens = new THREE.Mesh(new THREE.SphereGeometry(0.031, 14, 10), new THREE.MeshBasicNodeMaterial({ color: 0xf5f1d9 }));
    frontLampLens.scale.set(0.66, 0.53, 0.28);
    frontLampLens.position.set(0, 0, 0.11);
    frontSteerPivot.add(frontLampLens);
    const headLight = new THREE.SpotLight(0xfff8e8, 0, 20, 0.30, 0.72, 1.25);
    headLight.position.set(0, 0, 0.11);
    headLight.target.position.set(0, -0.55, 7.5);
    frontSteerPivot.add(headLight, headLight.target);
    addBikeBeam(leanPivot, [0, 0.44, -1.22], [0, 0.43, -1.29], 0.007, 0.006, darkMetalMat, 6);
    const tailLed = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.028, 4, 8), new THREE.MeshBasicNodeMaterial({ color: 0xff2830 }));
    tailLed.rotation.x = Math.PI * 0.5;
    tailLed.position.set(0, 0.43, -1.30);
    leanPivot.add(tailLed);

    // The existing skinned rider rests on the saddle with both hands on swept grips and both feet on the cranks.
    const bikeFrame = {
      seat: new THREE.Vector3(0, 1.0, -0.712),
      bars: new THREE.Vector3(0, 0.96, -0.045),
      steerPivot: new THREE.Vector3(0, 0.80, -0.115),
      steerAngle: 0,
      gripHalf: 0.28,
      pedalHalf: 0.14,
      lean: 0.60,
      bracket: new THREE.Vector3(...bracket),
      crankLength
    };
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 35, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Group();
    const helmetShell = new THREE.Mesh(new THREE.SphereGeometry(0.127, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.68), helmetMat);
    helmetShell.scale.set(0.98, 0.76, 1.26);
    helmet.add(helmetShell);
    for (const x of [-0.035, 0, 0.035]) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.044), blackMat);
      vent.position.set(x, 0.096 - Math.abs(x) * 0.12, 0.006);
      vent.rotation.x = -0.22;
      helmet.add(vent);
    }
    addBikeBeam(helmet, [-0.095, -0.045, 0.01], [0, -0.105, -0.035], 0.006, 0.006, blackMat, 6);
    addBikeBeam(helmet, [0, -0.105, -0.035], [0.095, -0.045, 0.01], 0.006, 0.006, blackMat, 6);
    const helmetBuckle = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.015, 0.012), alloyMat);
    helmetBuckle.position.set(0, -0.112, -0.035);
    helmet.add(helmetBuckle);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(1.0, 2.5);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);
    this.scene.add(root);

    return {
      type: 'cargobike', label: 'Cargo bike', mesh: root, leanPivot, frontSteerPivot, handlebarPivot, steeringLinkage,
      linkageRearPivot: [0, 0.80, -0.115], linkageRearLocal: [0.18, -0.53, 0],
      linkageFrontPivot: [0, 0.60, 0.77], linkageFrontLocal: [0.13, -0.21, 0],
      frontWheel, rearWheel, frontWheelRadius, rearWheelRadius, crankPivot, pedals, bikeFrame, riderCrowd, riderRig,
      helmet, headLight,
      position: new THREE.Vector3(5.2, 0.0, SPAWN_Z - 12), heading: 0, speed: 0, leanAngle: 0, pedalPhase: 0, standAmount: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.62, 0), chaseDistance: 6.2, chaseHeight: 2.35
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: 'Sightseeing Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(-110, 96, SPAWN_Z - 60),
      heading: 0.62,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // The ground is flat; the raised kerbs and sidewalks are the geometry's own (the person walks at street level)
  getGroundHeight(x, z, mode = 'person') {
    return 0.0;
  }

  // The colliders whose bounds come within `r` of (x, z), in their original order. They never move, so they are
  // bucketed once into 48 m cells (tens of thousands of buildings: testing them all every frame cost ~0.5 ms)
  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed island (the helicopter may roam out over the harbour & the boroughs)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(ISLAND_BOUNDS.minX - m, Math.min(ISLAND_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + m, pos.z));
    if (this.activeMode !== 'helicopter' && getIslandBoundsAtZ) {
      const shore = getIslandBoundsAtZ(pos.z);
      const minShoreX = shore.westX + 8.0;
      const maxShoreX = shore.eastX - 8.0;
      if (pos.x < minShoreX) {
        pos.x = minShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      } else if (pos.x > maxShoreX) {
        pos.x = maxShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const body = collisionBody(this.activeMode, radius, entity?.heading || 0);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = body.oriented
            ? Math.abs(nx * cos - nz * sin) * body.hx + Math.abs(nx * sin + nz * cos) * body.hz
            : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity?.type === 'car') {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt) {
    const p = this.entities.person;
    const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person');
    p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();

    for (const mode of ['cyclist', 'cargobike']) {
      const bike = this.entities[mode];
      if (this.activeMode !== mode) {
        bike.standAmount += (0 - bike.standAmount) * Math.min(1, dt * 3);
        bike.bikeFrame.upright = bike.standAmount;
      }
      bike.riderRig.ride(bike.leanPivot, bike.pedalPhase, bike.bikeFrame);
      bike.riderCrowd.begin();
      bike.riderCrowd.add(bike.riderRig, 0);
      bike.riderCrowd.end();
      bike.helmet.quaternion.copy(bike.riderRig.headQuaternion);
      bike.helmet.position.set(0, 0.175, -0.012).applyQuaternion(bike.helmet.quaternion).add(bike.riderRig.headPosition);
    }
  }

  update(dt, elapsed) {
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else {
      // Keep the sidewalk pedestrian walking naturally when not actively controlled
      const p = this.entities.person;
      const walkSpeed = 1.48;
      p.speed = walkSpeed;
      p.position.x += Math.sin(p.heading) * walkSpeed * dt;
      p.position.z += Math.cos(p.heading) * walkSpeed * dt;
      if (p.position.z < -340) p.heading = 0;
      else if (p.position.z > 340) p.heading = Math.PI;
    }

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, this.entities.cyclist, 'cyclist');
    } else if (this.activeMode === 'cargobike') {
      this.updateCyclist(dt, this.entities.cargobike, 'cargobike');
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    for (const mode of ['cyclist', 'cargobike']) {
      const bike = this.entities[mode];
      if (bike.headLight) bike.headLight.intensity = this.activeMode === mode ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    const maxWalk = this.keys.boost ? 8.2 : 4.4;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxWalk * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxWalk * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    p.speed += (targetSpeed - p.speed) * Math.min(1, dt * 10);

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  updateCar(dt) {
    const c = this.entities.car;
    const maxSpeed = this.keys.boost ? CAR_DRIVE.boostSpeed : CAR_DRIVE.speed;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;
    const previousSpeed = c.speed;
    c.speed = driveSpeed(c.speed, throttle, this.keys.boost, dt, CAR_DRIVE);
    const acceleration = dt > 0 ? (c.speed - previousSpeed) / dt : 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    c.steerAngle += (steerInput * 0.52 - c.steerAngle) * Math.min(1, dt * 10);

    if (Math.abs(c.speed) > 0.2) {
      const dirSign = c.speed >= 0 ? 1 : -1;
      const speedFactor = Math.min(1.0, Math.abs(c.speed) / 8.0);
      c.heading += c.steerAngle * 2.4 * speedFactor * dirSign * dt;
    }

    // Integrate collision yaw spin & lateral tire slip velocity with asphalt grip damping
    const tireGripDamp = Math.exp(-dt * 6.8);
    c.heading += c.angularVel * dt;
    c.angularVel *= Math.exp(-dt * 7.8);

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.position.x += (Math.sin(c.heading) * c.speed + c.vx) * dt;
    c.position.z += (Math.cos(c.heading) * c.speed + c.vz) * dt;
    c.vx *= tireGripDamp;
    c.vz *= tireGripDamp;

    this.resolveHorizontalCollision(c.position, 1.35, c);
    c.position.y = this.getGroundHeight(c.position.x, c.position.z, 'car');

    // 3-DOF Spring-Damper Chassis Suspension (Pitch, Roll & Vertical Heave)
    const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026;
    const targetRoll = -c.steerAngle * (c.speed / maxSpeed) * 0.092;
    const springK = 68.0;
    const dampC = 11.2;
    c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * springK - c.pitchVel * dampC) * dt;
    c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * springK - c.rollVel * dampC) * dt;
    c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * dt));
    c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * dt));

    c.heaveVel += (-c.heaveY * 85.0 - c.heaveVel * 12.0) * dt;
    c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * dt));
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking || (c.speed === 0 && !throttle) ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt, b = this.entities.cyclist, mode = 'cyclist') {

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    const drive = mode === 'cargobike' ? CARGO_BICYCLE_DRIVE : BICYCLE_DRIVE;
    const previousSpeed = b.speed;
    const nextSpeed = driveSpeed(b.speed, throttle, this.keys.boost, dt, drive);
    b.speed = mode === 'cargobike'
      ? Math.max(-drive.reverseSpeed, Math.min(drive.boostSpeed, nextSpeed))
      : nextSpeed;

    const standing = throttle > 0 && b.speed >= 0 && b.speed > previousSpeed + 0.002;
    const targetUpright = standing ? 1 : 0;
    b.standAmount += (targetUpright - b.standAmount) * Math.min(1, dt * (standing ? 5 : 3));
    b.bikeFrame.upright = b.standAmount;

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, mode === 'cargobike' ? 1.4 : 0.65, null, b);
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, mode);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const distance = b.speed * dt;
    const rearRadius = b.rearWheelRadius || 0.35;
    const frontRadius = b.frontWheelRadius || 0.35;
    const rearWheelDelta = distance / rearRadius;
    b.frontWheel.rotation.x += distance / frontRadius;
    b.rearWheel.rotation.x += rearWheelDelta;
    const steering = turnInput * 0.34;
    if (b.frontSteerPivot) b.frontSteerPivot.rotation.y = steering;
    if (b.handlebarPivot) b.handlebarPivot.rotation.y = steering;
    if (b.bikeFrame?.steerPivot) b.bikeFrame.steerAngle = steering;
    if (b.steeringLinkage && b.linkageRearPivot && b.linkageFrontPivot) {
      const sin = Math.sin(steering), cos = Math.cos(steering);
      const rotateAnchor = (pivot, local) => [
        pivot[0] + local[0] * cos + local[2] * sin,
        pivot[1] + local[1],
        pivot[2] - local[0] * sin + local[2] * cos
      ];
      alignBikeLink(
        b.steeringLinkage,
        rotateAnchor(b.linkageRearPivot, b.linkageRearLocal),
        rotateAnchor(b.linkageFrontPivot, b.linkageFrontLocal)
      );
    }

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && rearWheelDelta > 0) b.pedalPhase += rearWheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = this.keys.boost ? 52.0 : 32.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    if (h.position.y < 0.25) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, 0.25, h.position.z, 0, 1, 0, -h.verticalSpeed);
    }
    h.position.y = Math.max(0.25, Math.min(380, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
