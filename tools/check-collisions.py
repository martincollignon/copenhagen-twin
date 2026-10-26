#!/usr/bin/env python3
"""Run focused actor-collision regressions in the real WebGPU app.

Usage: python tools/check-collisions.py [--root PATH] [--out report.json] [--seed N]

The app is served from an ephemeral localhost port. Playwright and a Chromium build
with WebGPU support must already be installed; this script adds no dependencies.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import functools
import http.server
import json
import pathlib
import platform
import shutil
import threading

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright


DEFAULT_ROOT = pathlib.Path(__file__).resolve().parents[1]
READY_TIMEOUT_MS = 180_000
SEED_DEFAULT = 20261026


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=DEFAULT_ROOT,
        help=f"app root to serve (default: {DEFAULT_ROOT})",
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        help="write the full JSON report here; parent directories are created",
    )
    parser.add_argument("--seed", type=int, default=SEED_DEFAULT, help="deterministic Math.random seed")
    parser.add_argument(
        "--browser-path",
        type=pathlib.Path,
        help="use this Chrome/Chromium executable instead of Playwright's bundled browser",
    )
    parser.add_argument("--perf", action="store_true", help="measure normal traffic.update collision-stage overhead")
    parser.add_argument("--perf-ticks", type=int, default=120, help="measured ticks per phase (minimum 120; default: 120)")
    parser.add_argument("--profile", action="store_true", help="capture a Chrome V8 CPU profile of collision-enabled traffic updates")
    parser.add_argument("--profile-ticks", type=int, default=120, help="profiled ticks (minimum 120; default: 120)")
    parser.add_argument("--profile-out", type=pathlib.Path, help="raw Chrome CPU profile JSON path")
    args = parser.parse_args()
    if args.perf_ticks < 120:
        parser.error("--perf-ticks must be at least 120")
    if args.profile_ticks < 120:
        parser.error("--profile-ticks must be at least 120")
    if args.perf and args.profile:
        parser.error("--perf and --profile cannot be combined")
    return args


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def browser_args() -> list[str]:
    args = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
    system = platform.system()
    if system == "Darwin":
        args.append("--use-angle=metal")
    elif system == "Linux":
        args.extend(["--enable-features=Vulkan", "--use-angle=vulkan"])
    return args


def installed_chromium(playwright: object, requested: pathlib.Path | None) -> pathlib.Path | None:
    if requested:
        path = requested.expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"browser executable does not exist: {path}")
        return path
    bundled = pathlib.Path(playwright.chromium.executable_path)  # type: ignore[attr-defined]
    if bundled.is_file():
        return None
    candidates = [
        pathlib.Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        pathlib.Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        pathlib.Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        located = shutil.which(name)
        if located:
            candidates.append(pathlib.Path(located))
    return next((path for path in candidates if path.is_file()), None)


def deterministic_init(seed: int) -> str:
    return f"""
      (() => {{
        let state = {seed & 0xFFFFFFFF} >>> 0;
        Math.random = () => {{
          state = (state + 0x6D2B79F5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }};
      }})();
    """


SCENARIOS = r"""
async () => {
  const twin = globalThis.__twin;
  if (!twin) throw new Error('window.__twin was not exposed by ?hooks');
  const controller = twin.controllerManager;
  const traffic = twin.world.trafficSystem;
  if (!controller || typeof controller.resolveHorizontalCollision !== 'function') {
    throw new Error('controllerManager.resolveHorizontalCollision is unavailable');
  }
  if (!traffic || typeof traffic.update !== 'function') {
    throw new Error('world.trafficSystem.update is unavailable');
  }
  twin.renderer.setAnimationLoop(null);

  const cases = [];
  const errors = [];
  const groundAt = (x, z) => twin.world.groundHeight?.heightAt(x, z) ?? 0;
  const active = (mode) => {
    controller.setMode(mode, { preserveSwanPosition: true });
    const entity = controller.getActiveEntity();
    // Inactive controller entities are valid collision actors in the app. Move their parked test copies far
    // outside the fixture area so they cannot accidentally satisfy or spoil a pair regression.
    let parked = 0;
    for (const other of Object.values(controller.entities || {})) {
      if (other === entity || !other?.position?.set) continue;
      const x = 100000 + parked * 100;
      const z = 100000 + parked * 100;
      other.position.set(x, 0, z);
      other.mesh?.position?.copy?.(other.position);
      parked++;
    }
    return entity;
  };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const add = (name, ok, detail = {}) => cases.push({ name, pass: Boolean(ok), ...detail });
  const finiteXZ = (o) => Number.isFinite(o?.x) && Number.isFinite(o?.z);
  const insideRing = (ring, x, z) => {
    let yes = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
      if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) yes = !yes;
    }
    return yes;
  };
  const insideBuilding = (b, x, z) => insideRing(b.ring, x, z)
    && !(b.holes || []).some((hole) => insideRing(hole, x, z));
  const setGroundPosition = (entity, x, z) => entity.position.set(x, groundAt(x, z), z);
  const updateTraffic = (entity, mode, elapsed = 120) => traffic.update(
    0,
    elapsed,
    { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    entity,
    mode,
    twin.cameraSystem?.camera || null
  );
  const meshPositionError = (entity) => {
    const p = entity?.mesh?.position;
    return p ? distance(entity.position, p) : null;
  };
  const collisionStats = () => ({ ...(twin.world.collisions?.stats || {}) });
  const cyclistRenderPositionError = (cyclist) => {
    const group = traffic.cyclistSystem?.group;
    if (!group || !twin.THREE) return null;
    const matrix = new twin.THREE.Matrix4();
    let best = Infinity;
    group.traverse((mesh) => {
      if (!mesh.isInstancedMesh || !(mesh.name.startsWith('cyclist-') && !mesh.name.includes('helmet')
        && !mesh.name.includes('shadow') && !mesh.name.includes('crank') && !mesh.name.includes('pedal'))) return;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        const e = matrix.elements;
        best = Math.min(best, Math.hypot(e[12] - cyclist.x, e[14] - cyclist.z));
      }
    });
    return Number.isFinite(best) ? best : null;
  };
  const buildingHasBodyContact = async (x, y, z, heading) => {
    if (!globalThis.__collisionShapeHelpersAvailable) return null;
    const shapes = await import('/js/collision-shapes.js');
    const colliders = twin.world.colliders || [];
    const body = shapes.collisionBody('person', 0.32, heading || 0);
    const contact = { nx: 0, nz: 0, depth: 0 };
    return colliders.some((c) => c.type === 'building'
      && shapes.buildingContact(c, x, y, z, body, contact));
  };
  const bodyContactDetail = async (a, b) => {
    if (!globalThis.__collisionShapeHelpersAvailable) return null;
    if (!a || !b) return null;
    const shapes = await import('/js/collision-shapes.js');
    const contact = { nx: 0, nz: 0, depth: 0 };
    const overlap = shapes.bodyContact(a, b, contact);
    const summary = (actor) => ({
      kind: actor.kind, mode: actor.mode, x: actor.x, y: actor.y, z: actor.z,
      prevX: actor.prevX, prevZ: actor.prevZ, heading: actor.heading, radius: actor.radius,
      hx: actor.hx, hz: actor.hz, extX: actor.extX, extZ: actor.extZ,
      top: actor.top, bottom: actor.bottom, bodyTop: actor.bodyTop, bodyBottom: actor.bodyBottom,
      placed: actor.placed, wasPlaced: actor._wasPlaced, sweep: actor._sweep,
      entityId: actor.entity?.id ?? actor.entity?.edge?.id ?? null,
      spec: actor.spec ? { width: actor.spec.width, length: actor.spec.length, height: actor.spec.height } : null
    });
    return { overlap, contact: overlap ? { nx: contact.nx, nz: contact.nz, depth: contact.depth } : null,
      a: summary(a), b: summary(b) };
  };

  // Static building regression: exercise the controller entry point against a real geodata footprint.
  try {
    const player = active('person');
    const candidates = (twin.world.geo?.buildings || []).filter((b) => b.ring?.length >= 6);
    let fixture = null;
    for (const building of candidates) {
      const n = building.ring.length / 2;
      const x = building.ring.filter((_, i) => i % 2 === 0).reduce((sum, v) => sum + v, 0) / n;
      const z = building.ring.filter((_, i) => i % 2 === 1).reduce((sum, v) => sum + v, 0) / n;
      if (Math.hypot(x, z) <= 180 && insideBuilding(building, x, z)) {
        fixture = { building, x, z };
        break;
      }
    }
    if (!fixture) throw new Error('could not find an interior point in a real building footprint within 180 m');
    setGroundPosition(player, fixture.x, fixture.z);
    controller.resolveHorizontalCollision(player.position, 0.32, null, player);
    controller.update(0, 120);
    const building = fixture.building;
    const stillInside = insideBuilding(building, player.position.x, player.position.z);
    const bodyContact = await buildingHasBodyContact(player.position.x, player.position.y, player.position.z, player.heading);
    const meshError = meshPositionError(player);
    add('person exits real building footprint', !stillInside && bodyContact === false && finiteXZ(player.position)
      && meshError !== null && meshError < 1e-4, {
      buildingId: building.id,
      colliderCount: (twin.world.colliders || []).length,
      controllerResolved: controller._lastHorizontalCollisionResolved ?? null,
      insideAfter: stillInside,
      bodyContactAfter: bodyContact,
      position: { x: player.position.x, y: player.position.y, z: player.position.z },
      meshPositionError: meshError
    });
  } catch (error) {
    add('person exits real building footprint', false, { error: String(error) });
  }

  // Dynamic person/bicycle regression. The NPC's real lane update runs before the player is placed on it.
  try {
    const player = active('person');
    const focus = twin.cameraSystem?.currentPos || player.position;
    const cyclist = (traffic.cyclists || []).find((r) => r.placed && Number.isFinite(r.x) && Number.isFinite(r.z)
      && distance(r, player.position) > 10 && distance(r, focus) < 120
      && (traffic.cars || []).every((car) => !car.edge || distance(r, car) > 12)
      && (traffic.cyclists || []).every((other) => other === r || !other.placed || distance(r, other) > 2.5)
      && (traffic.peds || []).every((other) => !other.placed || distance(r, other) > 2.5));
    if (!cyclist) throw new Error('no placed NPC cyclist is available');
    cyclist.speed = 0;
    setGroundPosition(player, cyclist.x, cyclist.z);
    const start = distance(player.position, cyclist);
    updateTraffic(player, 'person');
    const finalDistance = distance(player.position, cyclist);
    const meshError = meshPositionError(player);
    let retained = true;
    for (let i = 0; i < 3; i++) {
      updateTraffic(player, 'person', 120 + i);
      retained = retained && distance(player.position, cyclist) >= 0.64;
    }
    const finalMeshError = meshPositionError(player);
    const cyclistMeshError = cyclistRenderPositionError(cyclist);
    const playerActor = (traffic.collisionActors || []).find((actor) => actor.entity === player);
    const cyclistActor = (traffic.collisionActors || []).find((actor) => actor.entity === cyclist);
    const bodyContactAfter = await bodyContactDetail(playerActor, cyclistActor);
    add('person separates from NPC bicycle at dt=0', start < 0.05 && finalDistance >= 0.64 && bodyContactAfter?.overlap === false
      && retained && finiteXZ(player.position) && finalMeshError !== null && finalMeshError < 1e-4
      && cyclistMeshError !== null && cyclistMeshError < 1e-3, {
      cyclistId: cyclist.id,
      startDistance: start,
      distanceAfter: finalDistance,
      distanceAfterRepeatedUpdates: distance(player.position, cyclist),
      bodyContactAfter,
      finitePosition: finiteXZ(player.position),
      meshPositionError: finalMeshError,
      cyclistMeshPositionError: cyclistMeshError,
      retainedSeparation: retained,
      collisionStats: collisionStats()
    });
  } catch (error) {
    add('person separates from NPC bicycle at dt=0', false, { error: String(error) });
  }

  // Dynamic person/pedestrian regression. Choose an isolated route-local pedestrian near the live simulation focus.
  try {
    const player = active('person');
    const focus = twin.cameraSystem?.currentPos || player.position;
    const ped = (traffic.peds || []).find((p) => p.placed && Number.isFinite(p.x) && Number.isFinite(p.z)
      && distance(p, player.position) > 10 && distance(p, focus) < 120
      && (traffic.cars || []).every((car) => !car.edge || distance(p, car) > 12)
      && (traffic.peds || []).every((other) => other === p || !other.placed || distance(p, other) > 1.5)
      && (traffic.cyclists || []).every((other) => !other.placed || distance(p, other) > 2.5));
    if (!ped) throw new Error('no placed NPC pedestrian is available');
    ped.v = 0;
    setGroundPosition(player, ped.x, ped.z);
    const start = distance(player.position, ped);
    updateTraffic(player, 'person');
    const finalDistance = distance(player.position, ped);
    let retained = true;
    for (let i = 0; i < 3; i++) {
      updateTraffic(player, 'person', 120 + i);
      retained = retained && distance(player.position, ped) >= 0.58;
    }
    const meshError = meshPositionError(player);
    const playerActor = (traffic.collisionActors || []).find((actor) => actor.entity === player);
    const pedestrianActor = (traffic.collisionActors || []).find((actor) => actor.entity === ped);
    const bodyContactAfter = await bodyContactDetail(playerActor, pedestrianActor);
    add('person separates from NPC pedestrian at dt=0', start < 0.05 && finalDistance >= 0.58
      && retained && bodyContactAfter?.overlap === false && finiteXZ(player.position)
      && meshError !== null && meshError < 1e-4, {
      pedestrianId: ped.id,
      startDistance: start,
      distanceAfter: finalDistance,
      distanceAfterRepeatedUpdates: distance(player.position, ped),
      bodyContactAfter,
      finitePosition: finiteXZ(player.position),
      meshPositionError: meshError,
      retainedSeparation: retained,
      collisionStats: collisionStats()
    });
  } catch (error) {
    add('person separates from NPC pedestrian at dt=0', false, { error: String(error) });
  }

  // An active bicycle against a real NPC car uses route-local traffic state and the public traffic update.
  try {
    const player = active('cyclist');
    const focus = twin.cameraSystem?.currentPos || player.position;
    const cars = (traffic.cars || []).filter((v) => v.edge && Number.isFinite(v.x) && Number.isFinite(v.z));
    const car = cars.find((v) => distance(v, player.position) > 10 && distance(v, focus) < 120
      && cars.every((other) => other === v || distance(v, other) > 10)
      && (traffic.cyclists || []).every((other) => !other.placed || distance(v, other) > 3)
      && (traffic.peds || []).every((other) => !other.placed || distance(v, other) > 3));
    if (!car) throw new Error('no isolated, route-backed NPC car is available');
    car.speed = 0;
    const vehicleBefore = { x: car.x, z: car.z, s: car.s, edgeId: car.edge?.id ?? null, speed: car.speed };
    setGroundPosition(player, car.x, car.z);
    const start = distance(player.position, car);
    updateTraffic(player, 'cyclist');
    const finalDistance = distance(player.position, car);
    const meshError = meshPositionError(player);
    const playerActor = (traffic.collisionActors || []).find((actor) => actor.entity === player);
    const carActor = (traffic.collisionActors || []).find((actor) => actor.entity === car);
    const bodyContactAfter = await bodyContactDetail(playerActor, carActor);
    const yawDelta = car.yaw + car.yawOffset - carActor?.heading;
    const carYawError = Math.abs(Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta)));
    add('active bicycle separates from NPC car at dt=0', start < 0.05 && finalDistance >= 1.0 && bodyContactAfter?.overlap === false
      && finiteXZ(player.position) && meshError !== null && meshError < 1e-4 && carYawError < 1e-6, {
      carId: car.id ?? car.edge?.id ?? null,
      startDistance: start,
      distanceAfter: finalDistance,
      bodyContactAfter,
      vehicleBefore,
      vehicleAfter: { x: car.x, z: car.z, s: car.s, edgeId: car.edge?.id ?? null, speed: car.speed },
      carYawError,
      playerAfter: { x: player.position.x, y: player.position.y, z: player.position.z },
      finitePosition: finiteXZ(player.position),
      meshPositionError: meshError,
      collisionStats: collisionStats()
    });
  } catch (error) {
    add('active bicycle separates from NPC car at dt=0', false, { error: String(error) });
  }

  // High-speed sweep through a thin, actual static collider (bollard/lamp/pole).
  try {
    const player = active('person');
    const colliders = twin.world.colliders || [];
    const body = { oriented: false, sin: 0, cos: 1, offsetForward: 0,
      radius: 0.48, extX: 0.48, extZ: 0.48, bottom: 0, top: 1.9 };
    const thin = colliders.filter((c) => ['bollard', 'lamp', 'bike-rack', 'bus-flag', 'lake-light'].includes(c.type)
      && c.shape === 'circle' && Number.isFinite(c.radius) && c.radius <= 0.2 && (c.maxY - c.minY) >= 0.55);
    const fixture = thin.flatMap((collider) => {
      const x = collider.obb.cx, z = collider.obb.cz, y = groundAt(x, z);
      return [[1, 0], [0, 1]].map(([dx, dz]) => {
        const start = { x: x - dx * 2.5, z: z - dz * 2.5 };
        const end = { x: x + dx * 2.5, z: z + dz * 2.5 };
        if (!controller.horizontalPositionClear(start.x, y, start.z, body, 1.0)
          || !controller.horizontalPositionClear(end.x, y, end.z, body, 1.0)) return null;
        const candidates = controller.horizontalCandidates(start.x, start.z, end.x, end.z, 1.0)
          .filter((candidate) => candidate !== collider);
        let clearPath = true;
        for (let i = 0; i <= 50; i++) {
          const f = i / 50;
          if (controller.horizontalContactAt(start.x + (end.x - start.x) * f, y,
            start.z + (end.z - start.z) * f, body, candidates)) { clearPath = false; break; }
        }
        const stop = { x: x - dx * (collider.radius + 0.48 + 0.08), z: z - dz * (collider.radius + 0.48 + 0.08) };
        const stopClear = !controller.horizontalContactAt(stop.x, y, stop.z, body, candidates);
        return clearPath && stopClear ? { collider, x, z, y, dx, dz, start, end } : null;
      });
    }).find(Boolean);
    if (!fixture) throw new Error('no thin static collider has clear endpoints and an unobstructed swept path');
    const { collider, x, z, y, dx, dz, start, end } = fixture;
    player.position.set(end.x, y, end.z);
    controller.resolveHorizontalCollision(player.position, 0.48, null, player, start);
    const stoppedBySweep = (player.position.x - x) * dx + (player.position.z - z) * dz < -(collider.radius + 0.4);
    const targetContactBeforeSync = controller.horizontalContactAt(player.position.x, player.position.y, player.position.z, body, [collider]);
    controller.update(0, 120);
    const stoppedBeforeCollider = (player.position.x - x) * dx + (player.position.z - z) * dz < -(collider.radius + 0.4);
    const clear = controller.horizontalPositionClear(player.position.x, player.position.y, player.position.z, body, 1.0);
    const targetContact = controller.horizontalContactAt(player.position.x, player.position.y, player.position.z, body, [collider]);
    const crossed = (player.position.x - x) * dx + (player.position.z - z) * dz > collider.radius + 0.4;
    add('person sweep stops at thin static collider', finiteXZ(player.position) && clear && stoppedBeforeCollider && !crossed, {
      colliderId: collider.id,
      colliderType: collider.type,
      colliderRadius: collider.radius,
      start,
      requestedEnd: end,
      resolved: { x: player.position.x, y: player.position.y, z: player.position.z },
      stoppedBySweep,
      targetContactBeforeSync: Boolean(targetContactBeforeSync),
      clearAfter: clear,
      targetContactAfter: Boolean(targetContact),
      crossedObstacle: crossed
    });
  } catch (error) {
    add('person sweep stops at thin static collider', false, { error: String(error) });
  }

  return { cases, errors };
}
"""


PERFORMANCE_SCENARIO = r"""
async ({ ticks }) => {
  const twin = globalThis.__twin;
  const traffic = twin?.world?.trafficSystem;
  const stage = twin?.world?.collisions;
  const controller = twin?.controllerManager;
  if (!twin || !traffic || typeof traffic.update !== 'function') throw new Error('live world traffic API is unavailable');
  if (typeof traffic.setCollisionStage !== 'function') throw new Error('world traffic collision-stage seam is unavailable');
  if (!stage || typeof stage.resolve !== 'function') throw new Error('world collision stage is unavailable');
  twin.renderer.setAnimationLoop(null);

  const player = controller.getActiveEntity();
  const mode = controller.activeMode;
  const camera = twin.cameraSystem?.camera || null;
  const focus = twin.cameraSystem?.currentPos || player.position;
  const dt = 1 / 60;
  let elapsed = 1000;
  const stageStats = () => ({ ...(stage.stats || {}) });
  const actorCounts = () => {
    const actors = traffic.collisionActors || [];
    return {
      collisionActors: actors.length,
      placedCollisionActors: actors.reduce((count, actor) => count + (actor.placed !== false ? 1 : 0), 0),
      cars: (traffic.cars || []).reduce((count, car) => count + (car.edge ? 1 : 0), 0),
      buses: (traffic.buses || []).reduce((count, bus) => count + (bus.edge ? 1 : 0), 0),
      pedestrians: (traffic.peds || []).reduce((count, ped) => count + (ped.placed ? 1 : 0), 0),
      cyclists: (traffic.cyclistSystem?.riders || []).reduce((count, rider) => count + (rider.placed ? 1 : 0), 0)
    };
  };
  const run = (enabled, count) => {
    traffic.setCollisionStage(enabled ? stage : null);
    const times = [];
    const stats = [];
    let counts = null;
    for (let i = 0; i < count; i++) {
      elapsed += dt;
      const start = performance.now();
      traffic.update(dt, elapsed, focus, player, mode, camera);
      times.push(performance.now() - start);
      counts = actorCounts();
      if (enabled) stats.push(stageStats());
    }
    return { times, stats, counts };
  };
  const quantile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  };
  const timingSummary = (values) => ({
    count: values.length,
    medianMs: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / (values.length || 1)
  });
  const statsSummary = (records, key) => {
    const values = records.map((record) => Number(record[key]) || 0);
    return { median: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(0, ...values) };
  };
  try {
    run(true, 45); // let route placement, batches and the collision index reach steady state
    const before = run(true, ticks);
    const offWarm = run(false, 30);
    const disabledStatsBefore = stageStats();
    const disabled = run(false, ticks);
    const disabledStatsAfter = stageStats();
    run(true, 30); // paired enabled samples on both sides of the disabled phase
    const after = run(true, ticks);
    const normalTimes = [...before.times, ...after.times];
    const stats = [...before.stats, ...after.stats];
    const normal = timingSummary(normalTimes);
    const noCollisionStage = timingSummary(disabled.times);
    return {
      ok: normal.count >= 2 * ticks && noCollisionStage.count >= ticks,
      phase: 'warm public traffic.update; app animation loop paused; render batching remains enabled',
      activeMode: mode,
      ticksPerMeasuredPhase: ticks,
      warmTicks: 45,
      reenabledWarmTicks: 30,
      normal: {
        ...normal,
        firstSegment: { ...timingSummary(before.times), timingSamplesMs: before.times },
        secondSegment: { ...timingSummary(after.times), timingSamplesMs: after.times }
      },
      collisionStageDisabled: { ...noCollisionStage, timingSamplesMs: disabled.times },
      estimatedCollisionStageOverheadMs: {
        median: normal.medianMs - noCollisionStage.medianMs,
        p95: normal.p95Ms - noCollisionStage.p95Ms,
        medianOf60HzBudgetPercent: (normal.medianMs - noCollisionStage.medianMs) / (1000 / 60) * 100,
        p95Of60HzBudgetPercent: (normal.p95Ms - noCollisionStage.p95Ms) / (1000 / 60) * 100
      },
      actorCounts: after.counts,
      resolverStats: {
        candidatePairs: statsSummary(stats, 'candidatePairs'),
        contacts: statsSummary(stats, 'contacts'),
        staticQueries: statsSummary(stats, 'staticQueries'),
        staticContacts: statsSummary(stats, 'staticContacts'),
        final: stageStats()
      },
      disabledStageStatsUnchanged: JSON.stringify(disabledStatsBefore) === JSON.stringify(disabledStatsAfter),
      disabledWarmTicks: offWarm.times.length,
      stageRestored: true
    };
  } finally {
    traffic.setCollisionStage(stage);
  }
}
"""


PROFILE_SCENARIO = r"""
async ({ ticks }) => {
  const twin = globalThis.__twin;
  const traffic = twin?.world?.trafficSystem;
  const stage = twin?.world?.collisions;
  const controller = twin?.controllerManager;
  if (!twin || !traffic || typeof traffic.update !== 'function') throw new Error('live world traffic API is unavailable');
  if (!stage || typeof stage.resolve !== 'function') throw new Error('world collision stage is unavailable');
  if (typeof traffic.setCollisionStage !== 'function') throw new Error('world traffic collision-stage seam is unavailable');
  twin.renderer.setAnimationLoop(null);
  traffic.setCollisionStage(stage);

  const player = controller.getActiveEntity();
  const mode = controller.activeMode;
  const camera = twin.cameraSystem?.camera || null;
  const focus = twin.cameraSystem?.currentPos || player.position;
  const dt = 1 / 60;
  let elapsed = 2000;
  const update = () => {
    elapsed += dt;
    traffic.update(dt, elapsed, focus, player, mode, camera);
  };
  for (let i = 0; i < 30; i++) update(); // warm the real scene and collision index before the measured window
  const times = [];
  for (let i = 0; i < ticks; i++) {
    const start = performance.now();
    update();
    times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  const stats = { ...(stage.stats || {}) };
  const actors = traffic.collisionActors || [];
  return {
    measuredTicks: times.length,
    warmTicks: 30,
    activeMode: mode,
    trafficUpdateMedianMs: quantile(0.5),
    trafficUpdateP95Ms: quantile(0.95),
    trafficUpdateMeanMs: times.reduce((sum, value) => sum + value, 0) / (times.length || 1),
    resolverStats: stats,
    actorCounts: {
      collisionActors: actors.length,
      placedCollisionActors: actors.reduce((count, actor) => count + (actor.placed !== false ? 1 : 0), 0),
      cars: (traffic.cars || []).reduce((count, car) => count + (car.edge ? 1 : 0), 0),
      buses: (traffic.buses || []).reduce((count, bus) => count + (bus.edge ? 1 : 0), 0),
      pedestrians: (traffic.peds || []).reduce((count, ped) => count + (ped.placed ? 1 : 0), 0),
      cyclists: (traffic.cyclistSystem?.riders || []).reduce((count, rider) => count + (rider.placed ? 1 : 0), 0)
    },
    timingSamplesMs: times
  };
}
"""


def summarize_v8_profile(profile: dict[str, object]) -> dict[str, object]:
    nodes = profile.get("nodes") or []
    samples = profile.get("samples") or []
    deltas = profile.get("timeDeltas") or []
    by_id = {node["id"]: node.get("callFrame", {}) for node in nodes}
    grouped: dict[tuple[str, str, int, int], list[int]] = defaultdict(lambda: [0, 0])
    for index, node_id in enumerate(samples):
        frame = by_id.get(node_id, {})
        url = frame.get("url") or "<native>"
        name = frame.get("functionName") or "(anonymous)"
        line = int(frame.get("lineNumber", -1)) + 1
        column = int(frame.get("columnNumber", -1)) + 1
        item = grouped[(name, url, line, column)]
        item[0] += 1
        if index < len(deltas):
            item[1] += int(deltas[index])
    total_us = sum(int(value) for value in deltas)
    functions = []
    for (name, url, line, column), (count, self_us) in grouped.items():
        functions.append({
            "function": name,
            "url": url,
            "line": line,
            "column": column,
            "selfSamples": count,
            "selfMs": self_us / 1000,
            "selfTimePercent": (self_us / total_us * 100) if total_us else 0,
        })
    functions.sort(key=lambda item: item["selfMs"], reverse=True)
    return {
        "profileDurationMs": max(0, int(profile.get("endTime", 0)) - int(profile.get("startTime", 0))) / 1000,
        "sampleCount": len(samples),
        "sampledTimeMs": total_us / 1000,
        "topSelfSampledFunctions": functions[:30],
    }


def main() -> int:
    args = parse_args()
    if args.profile:
        artifact_dir = pathlib.Path(__file__).resolve().parents[2]
        args.profile_out = args.profile_out or artifact_dir / "collision-cpu-profile.json"
        args.out = args.out or artifact_dir / "collision-cpu-profile-summary.json"
    root = args.root.expanduser().resolve()
    index = root / "index.html"
    if not index.is_file():
        report = {
            "root": str(root),
            "seed": args.seed,
            "cases": [],
            "browserErrors": [f"app root has no index.html: {root}"],
        }
        return finish(report, args.out)

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(root))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_port
    report: dict[str, object] = {
        "root": str(root),
        "seed": args.seed,
        "url": f"http://127.0.0.1:{port}/index.html?hooks",
        "browserArgs": browser_args(),
        "cases": [],
        "browserErrors": [],
        "gpuErrors": [],
        "ignored404": [],
    }
    browser = None
    try:
        with sync_playwright() as playwright:
            executable = installed_chromium(playwright, args.browser_path)
            if executable:
                report["browserExecutable"] = str(executable)
            browser = playwright.chromium.launch(
                executable_path=str(executable) if executable else None,
                args=browser_args(),
                headless=True,
            )
            page = browser.new_page(viewport={"width": 960, "height": 600})
            browser_errors: list[str] = report["browserErrors"]  # type: ignore[assignment]
            gpu_errors: list[str] = report["gpuErrors"]  # type: ignore[assignment]
            ignored_404: list[str] = report["ignored404"]  # type: ignore[assignment]

            page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: browser_errors.append(f"console: {message.text}")
                if message.type == "error"
                else None,
            )
            page.on("requestfailed", lambda request: browser_errors.append(
                f"requestfailed: {request.url}: {request.failure}"
            ))

            def response_status(response: object) -> None:
                status = response.status  # type: ignore[attr-defined]
                if status < 400:
                    return
                url = response.url  # type: ignore[attr-defined]
                if status == 404 and url.split("?", 1)[0].endswith("/favicon.ico"):
                    ignored_404.append(url)
                    return
                browser_errors.append(f"HTTP {status}: {url}")

            page.on("response", response_status)
            page.add_init_script(
                f"globalThis.__collisionShapeHelpersAvailable = {str((root / 'js/collision-shapes.js').is_file()).lower()};\n"
                + deterministic_init(args.seed)
            )
            page.goto(str(report["url"]), wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_function(
                "globalThis.__twin && document.querySelector('#loading-overlay')?.classList.contains('hidden')",
                timeout=READY_TIMEOUT_MS,
            )
            page.wait_for_timeout(2_000)

            gpu_info = page.evaluate("""async () => {
              const gpu = navigator.gpu;
              if (!gpu) return { available: false, reason: 'navigator.gpu is unavailable' };
              const adapter = await gpu.requestAdapter();
              if (!adapter) return { available: false, reason: 'requestAdapter returned null' };
              const renderer = globalThis.__twin?.renderer;
              const device = renderer?.backend?.device || null;
              const errors = [];
              if (device?.addEventListener) {
                device.addEventListener('uncapturederror', (event) => errors.push(String(event.error || event.message || event)));
              }
              globalThis.__collisionGpuErrors = errors;
              return {
                available: true,
                adapter: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device } : null,
                rendererBackend: renderer?.backend?.constructor?.name || null,
                deviceListenerAttached: Boolean(device?.addEventListener)
              };
            }""")
            report["gpu"] = gpu_info
            if not gpu_info.get("available"):
                browser_errors.append(f"WebGPU unavailable: {gpu_info.get('reason')}")
            else:
                try:
                    if args.perf:
                        report["performance"] = page.evaluate(PERFORMANCE_SCENARIO, {"ticks": args.perf_ticks})
                    elif args.profile:
                        cdp = page.context.new_cdp_session(page)
                        cdp.send("Profiler.enable")
                        cdp.send("Profiler.setSamplingInterval", {"interval": 1000})
                        cdp.send("Profiler.start")
                        try:
                            profile_run = page.evaluate(PROFILE_SCENARIO, {"ticks": args.profile_ticks})
                        finally:
                            stopped = cdp.send("Profiler.stop")
                            cdp.send("Profiler.disable")
                            cdp.detach()
                        raw_profile = stopped.get("profile")
                        if not raw_profile:
                            raise RuntimeError("Chrome Profiler.stop returned no V8 profile")
                        profile_path = args.profile_out.expanduser().resolve()
                        profile_path.parent.mkdir(parents=True, exist_ok=True)
                        profile_path.write_text(json.dumps(raw_profile), encoding="utf-8")
                        report["profileSummary"] = {
                            **profile_run,
                            "v8Profile": summarize_v8_profile(raw_profile),
                            "samplingIntervalUs": 1000,
                            "rawProfilePath": str(profile_path),
                        }
                    else:
                        result = page.evaluate(SCENARIOS)
                        report["cases"] = result["cases"]
                        report["browserSideErrors"] = result["errors"]
                    page.wait_for_timeout(100)
                    gpu_errors.extend(page.evaluate("globalThis.__collisionGpuErrors || []"))
                except PlaywrightError as error:
                    browser_errors.append(f"scenario evaluation failed: {error}")
    except Exception as error:  # retain a JSON report for launch, readiness and GPU failures too
        browser_errors = report["browserErrors"]  # type: ignore[assignment]
        browser_errors.append(f"browser harness: {type(error).__name__}: {error}")
    finally:
        # sync_playwright owns the browser lifetime and closes it as its context exits.
        server.shutdown()
        server.server_close()

    # The renderer may dispatch validation errors after evaluate() returns.
    # Device errors collected during the pass are sampled once more above; console errors remain fatal.
    return finish(report, args.out)


def finish(report: dict[str, object], out: pathlib.Path | None) -> int:
    profile = report.get("profileSummary")
    if profile:
        v8 = profile["v8Profile"]
        counts = profile["actorCounts"]
        stats = profile["resolverStats"]
        print(
            "PROFILE collision-enabled traffic.update: "
            f"ticks={profile['measuredTicks']} warm={profile['warmTicks']} "
            f"median={profile['trafficUpdateMedianMs']:.3f} ms p95={profile['trafficUpdateP95Ms']:.3f} ms"
        )
        print(
            f"PROFILE V8 samples={v8['sampleCount']} sampled={v8['sampledTimeMs']:.1f} ms; "
            f"actors={counts['placedCollisionActors']}/{counts['collisionActors']} placed, "
            f"candidatePairs={stats.get('candidatePairs', 0)}, contacts={stats.get('contacts', 0)}, "
            f"staticQueries={stats.get('staticQueries', 0)}"
        )
        for item in v8["topSelfSampledFunctions"][:15]:
            print(
                f"HOT {item['selfMs']:.1f} ms {item['selfSamples']} samples "
                f"{item['function']} {item['url']}:{item['line']}"
            )
        print(f"PROFILE RAW {profile['rawProfilePath']}")
        browser_errors = report.get("browserErrors") or []
        gpu_errors = report.get("gpuErrors") or []
        for error in browser_errors:
            print(f"FAIL browser: {error}")
        for error in gpu_errors:
            print(f"FAIL GPU validation: {error}")
        if out:
            destination = out.expanduser().resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(f"JSON {destination}")
        return 0 if profile.get("measuredTicks", 0) >= 120 and v8.get("sampleCount", 0) > 0 and not browser_errors and not gpu_errors else 1

    performance = report.get("performance")
    if performance:
        normal = performance["normal"]
        disabled = performance["collisionStageDisabled"]
        overhead = performance["estimatedCollisionStageOverheadMs"]
        counts = performance["actorCounts"]
        resolver = performance["resolverStats"]
        print(
            "PERF traffic.update collision stage on: "
            f"n={normal['count']} median={normal['medianMs']:.3f} ms p95={normal['p95Ms']:.3f} ms"
        )
        print(
            "PERF collision stage off: "
            f"n={disabled['count']} median={disabled['medianMs']:.3f} ms p95={disabled['p95Ms']:.3f} ms"
        )
        print(
            "PERF estimated stage overhead: "
            f"median={overhead['median']:.3f} ms ({overhead['medianOf60HzBudgetPercent']:.1f}% of 16.67 ms), "
            f"p95={overhead['p95']:.3f} ms ({overhead['p95Of60HzBudgetPercent']:.1f}%)"
        )
        print(
            "PERF actors: "
            f"{counts['placedCollisionActors']}/{counts['collisionActors']} placed, "
            f"cars={counts['cars']} buses={counts['buses']} peds={counts['pedestrians']} cyclists={counts['cyclists']}; "
            f"candidatePairs median/p95={resolver['candidatePairs']['median']}/{resolver['candidatePairs']['p95']}, "
            f"staticQueries median/p95={resolver['staticQueries']['median']}/{resolver['staticQueries']['p95']}"
        )
        browser_errors = report.get("browserErrors") or []
        gpu_errors = report.get("gpuErrors") or []
        for error in browser_errors:
            print(f"FAIL browser: {error}")
        for error in gpu_errors:
            print(f"FAIL GPU validation: {error}")
        if out:
            destination = out.expanduser().resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(f"JSON {destination}")
        return 0 if performance.get("ok") and performance.get("disabledStageStatsUnchanged") and not browser_errors and not gpu_errors else 1

    cases = report.get("cases") or []
    browser_errors = report.get("browserErrors") or []
    gpu_errors = report.get("gpuErrors") or []
    passed = sum(1 for case in cases if case.get("pass"))
    total = len(cases)
    for case in cases:
        state = "PASS" if case.get("pass") else "FAIL"
        suffix = case.get("error") or case.get("distanceAfter")
        if suffix is None:
            suffix = case.get("insideAfter")
        tail = f" ({suffix})" if suffix is not None else ""
        print(f"{state} {case.get('name', 'unnamed case')}{tail}")
    for error in browser_errors:
        print(f"FAIL browser: {error}")
    for error in gpu_errors:
        print(f"FAIL GPU validation: {error}")
    print(f"RESULT {passed}/{total} collision cases passed; {len(browser_errors)} browser errors; {len(gpu_errors)} GPU validation errors")
    if out:
        destination = out.expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"JSON {destination}")
    return 0 if total > 0 and passed == total and not browser_errors and not gpu_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
