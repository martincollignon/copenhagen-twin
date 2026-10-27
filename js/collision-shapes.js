// Pure collision shapes shared by the static world and moving actors.
import { pointInRing } from './polygon-cph.js';

const EPSILON = 1e-10;
// Math.hypot is a builtin call that TurboFan does not inline (its numbers get boxed): the plain square root is inlined
const hypot = (a, b) => Math.sqrt(a * a + b * b);

export function collisionBody(mode, radius, heading, margin = 0, spec = null) {
  const car = mode === 'car';
  const cargoBike = mode === 'cargobike';
  const bicycle = mode === 'cyclist';
  const oriented = car || cargoBike || bicycle;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = (car ? (spec?.width || 1.72) / 2 : cargoBike ? 0.38 : bicycle ? 0.34 : radius) + margin;
  const hz = (car ? (spec?.length || 4.36) / 2 : cargoBike ? 1.34 : bicycle ? 0.95 : radius) + margin;
  return {
    car, oriented, sin, cos, hx, hz, radius: radius + margin,
    offsetForward: cargoBike ? -0.06 : 0,
    extX: oriented ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: oriented ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? (Number.isFinite(spec?.height) && spec.height > 0 ? spec.height : 1.8) : 1.9
  };
}

function setContact(contact, nx, nz, depth) {
  if (contact) {
    contact.nx = nx;
    contact.nz = nz;
    contact.depth = depth;
  }
  return true;
}

function rectangularContact(c, x, z, body, contact) {
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
      if (overlap <= 1e-9) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = hypot(qx, qz);
    if (distance >= body.radius - 1e-9) return false;
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
  return setContact(contact, nx * cs + nz * sn, -nx * sn + nz * cs, depth);
}

const pointInPolygon = (collider, x, z) => {
  if (!collider.ring || !pointInRing(collider.ring, x, z)) return false;
  const holes = collider.holes;
  if (holes) for (let h = 0; h < holes.length; h++) if (pointInRing(holes[h], x, z)) return false;
  return true;
};

function ringsOf(collider) {
  return [collider.ring, ...(collider.holes || [])];
}

function ringDistance2(ring, x, z, best) {
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const qx = x - (ax + dx * t), qz = z - (az + dz * t);
    const distance2 = qx * qx + qz * qz;
    if (distance2 < best) best = distance2;
  }
  return best;
}

/** Squared distance from (x, z) to the nearest outline or hole edge (Infinity without one). */
function boundaryDistance2(collider, x, z) {
  let best = Infinity;
  if (collider.ring) best = ringDistance2(collider.ring, x, z, best);
  const holes = collider.holes;
  if (holes) for (let h = 0; h < holes.length; h++) best = ringDistance2(holes[h], x, z, best);
  return best;
}

function bodyCorners(x, z, body) {
  if (!body.oriented) return null;
  const rx = body.cos, rz = -body.sin, fx = body.sin, fz = body.cos;
  return [
    [x + rx * body.hx + fx * body.hz, z + rz * body.hx + fz * body.hz],
    [x - rx * body.hx + fx * body.hz, z - rz * body.hx + fz * body.hz],
    [x - rx * body.hx - fx * body.hz, z - rz * body.hx - fz * body.hz],
    [x + rx * body.hx - fx * body.hz, z + rz * body.hx - fz * body.hz]
  ];
}

function pointInBody(px, pz, x, z, body) {
  if (!body.oriented) return hypot(px - x, pz - z) <= body.radius;
  const dx = px - x, dz = pz - z;
  const lx = dx * body.cos - dz * body.sin;
  const lz = dx * body.sin + dz * body.cos;
  return Math.abs(lx) <= body.hx + 1e-9 && Math.abs(lz) <= body.hz + 1e-9;
}

function segmentIntersects(ax, az, bx, bz, cx, cz, dx, dz) {
  const cross = (x1, z1, x2, z2) => x1 * z2 - z1 * x2;
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = cross(rx, rz, sx, sz);
  if (Math.abs(den) < 1e-10) return false;
  const qx = cx - ax, qz = cz - az;
  const t = cross(qx, qz, sx, sz) / den;
  const u = cross(qx, qz, rx, rz) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

function polygonOverlapsBody(collider, x, z, body) {
  if (!body.oriented) {
    if (pointInPolygon(collider, x, z)) return true;
    return boundaryDistance2(collider, x, z) < body.radius * body.radius - 1e-12;
  }
  const { pts, idx } = collider.triangles || {};
  if (pts && idx) {
    const sin = body.sin ?? body.sinHeading ?? Math.sin(body.heading || 0);
    const cos = body.cos ?? body.cosHeading ?? Math.cos(body.heading || 0);
    for (let i = 0; i < idx.length; i += 3) {
      let overlaps = true;
      const i0 = idx[i] * 2, i1 = idx[i + 1] * 2, i2 = idx[i + 2] * 2;
      const x0 = pts[i0], z0 = pts[i0 + 1];
      const x1 = pts[i1], z1 = pts[i1 + 1];
      const x2 = pts[i2], z2 = pts[i2 + 1];
      for (let axisIndex = 0; axisIndex < 5; axisIndex++) {
        let ax, az;
        if (axisIndex === 0) { ax = cos; az = -sin; }
        else if (axisIndex === 1) { ax = sin; az = cos; }
        else {
          let ex, ez, fx, fz;
          if (axisIndex === 2) { ex = x0; ez = z0; fx = x1; fz = z1; }
          else if (axisIndex === 3) { ex = x1; ez = z1; fx = x2; fz = z2; }
          else { ex = x2; ez = z2; fx = x0; fz = z0; }
          const dx = fx - ex, dz = fz - ez, len = hypot(dx, dz) || 1;
          ax = -dz / len; az = dx / len;
        }
        const p0 = x0 * ax + z0 * az;
        const p1 = x1 * ax + z1 * az;
        const p2 = x2 * ax + z2 * az;
        const triMin = Math.min(p0, p1, p2), triMax = Math.max(p0, p1, p2);
        const center = x * ax + z * az;
        const extent = body.hx * Math.abs(ax * cos - az * sin) + body.hz * Math.abs(ax * sin + az * cos);
        if (triMax <= center - extent || triMin >= center + extent) { overlaps = false; break; }
      }
      if (overlaps) return true;
    }
    return false;
  }
  // Hand-authored polygon test fixtures may omit cached triangles; boundary intersection still stays exact.
  const corners = bodyCorners(x, z, body);
  if (corners.some(([px, pz]) => pointInPolygon(collider, px, pz))) return true;
  for (const ring of ringsOf(collider)) for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    if (pointInBody(ring[i], ring[i + 1], x, z, body)) return true;
    for (let k = 0; k < corners.length; k++) {
      const next = (k + 1) % corners.length;
      if (segmentIntersects(corners[k][0], corners[k][1], corners[next][0], corners[next][1], ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

function shapeSupport(body, nx, nz) {
  if (!body.oriented) return body.radius;
  const rx = body.cos, rz = -body.sin, fx = body.sin, fz = body.cos;
  return body.hx * Math.abs(nx * rx + nz * rz) + body.hz * Math.abs(nx * fx + nz * fz);
}

// polygonContact's candidate separations, reused across calls (single-threaded: no call nests inside another)
let candNx = new Float64Array(64), candNz = new Float64Array(64), candDepth = new Float64Array(64);
let candOrder = new Int32Array(64);
let candCount = 0;
// the order of the original sort: depth, then the normal's x, then its z
const candidateBefore = (a, b) => candDepth[a] < candDepth[b]
  || (candDepth[a] === candDepth[b] && (candNx[a] < candNx[b] || (candNx[a] === candNx[b] && candNz[a] < candNz[b])));

function addCandidate(nx, nz, depth) {
  const len = hypot(nx, nz);
  if (len < EPSILON || !(depth > 0) || !Number.isFinite(depth)) return;
  nx /= len; nz /= len;
  for (let i = 0; i < candCount; i++) {
    if (candNx[i] * nx + candNz[i] * nz > 0.99999 && Math.abs(candDepth[i] - depth) < 1e-7) return;
  }
  if (candCount === candNx.length) {
    const grow = (a) => { const b = new Float64Array(a.length * 2); b.set(a); return b; };
    candNx = grow(candNx); candNz = grow(candNz); candDepth = grow(candDepth);
    candOrder = new Int32Array(candNx.length);
  }
  candNx[candCount] = nx; candNz[candCount] = nz; candDepth[candCount] = depth;
  candCount++;
}

function polygonContact(collider, x, z, body, contact) {
  if (!polygonOverlapsBody(collider, x, z, body)) return false;
  const inside = pointInPolygon(collider, x, z);
  candCount = 0;
  const edges = collider.boundaryEdges;
  if (edges) {
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      const signed = (x - edge.ax) * edge.nx + (z - edge.az) * edge.nz;
      addCandidate(edge.nx, edge.nz, shapeSupport(body, edge.nx, edge.nz) - signed + 1e-7);
    }
  }
  // Corner axes supplement face normals. They are based on the actual vertex and the complete body support,
  // then accepted only when the translated footprint clears the full polygon.
  const vertices = collider.boundaryVertices;
  if (vertices) {
    for (let v = 0; v < vertices.length; v++) {
      const vertex = vertices[v];
      const dx = x - vertex.x, dz = z - vertex.z;
      const distance = hypot(dx, dz);
      if (distance <= EPSILON) continue;
      if (!body.oriented && !inside && distance >= body.radius) continue;
      const nx = inside ? -dx / distance : dx / distance;
      const nz = inside ? -dz / distance : dz / distance;
      const signed = dx * nx + dz * nz;
      addCandidate(nx, nz, shapeSupport(body, nx, nz) - signed + 1e-7);
    }
  }
  const count = candCount;
  for (let i = 0; i < count; i++) candOrder[i] = i;
  for (let i = 1; i < count; i++) { // stable insertion sort, as Array#sort was
    const v = candOrder[i];
    let j = i - 1;
    while (j >= 0 && candidateBefore(v, candOrder[j])) { candOrder[j + 1] = candOrder[j]; j--; }
    candOrder[j + 1] = v;
  }
  let bestNx = 0, bestNz = 0, bestDepth = Infinity, found = false;
  const escapeBound = Math.max(64, hypot(collider.maxX - collider.minX, collider.maxZ - collider.minZ)
    + 2 * Math.max(body.extX, body.extZ) + 1);
  for (let k = 0; k < count; k++) {
    const c = candOrder[k];
    const nx = candNx[c], nz = candNz[c], depth = candDepth[c];
    if (found && depth >= bestDepth) break;
    if (!polygonOverlapsBody(collider, x + nx * depth, z + nz * depth, body)) {
      bestNx = nx; bestNz = nz; bestDepth = depth; found = true;
      continue;
    }
    // Concave footprints can still occupy the other side of an elbow. Extend along this external direction and
    // validate the whole footprint at every candidate; triangulation seams never become collision planes. Search
    // only as far as any already-valid correction would require, then choose the shortest fully clear result.
    for (let extra = 0.25; extra <= escapeBound && (!found || depth + extra < bestDepth); extra += 0.25) {
      const extended = depth + extra;
      if (!polygonOverlapsBody(collider, x + nx * extended, z + nz * extended, body)) {
        bestNx = nx; bestNz = nz; bestDepth = extended; found = true;
        break;
      }
    }
  }
  return found ? setContact(contact, bestNx, bestNz, bestDepth) : false;
}

/**
 * Contact between a player/actor footprint and a static collider. The normal points out of the solid and the
 * depth is the translation needed to separate the footprint. `collider` may be an OBB, legacy AABB or polygon.
 */
export function buildingContact(collider, x, y, z, body, contact) {
  if (y + body.bottom >= collider.maxY || y + body.top <= (collider.minY ?? 0)) return false;
  const offsetX = body.sin * (body.offsetForward || 0), offsetZ = body.cos * (body.offsetForward || 0);
  const centerX = x + offsetX, centerZ = z + offsetZ;
  if (centerX + body.extX <= collider.minX || centerX - body.extX >= collider.maxX
    || centerZ + body.extZ <= collider.minZ || centerZ - body.extZ >= collider.maxZ) return false;
  if (collider.ring?.length >= 6) return polygonContact(collider, centerX, centerZ, body, contact);
  if (collider.shape === 'circle') {
    if (body.oriented) {
      if (!circleBoxContact(collider, body, contact, collider.obb.cx, collider.obb.cz, centerX, centerZ)) return false;
      if (contact) { contact.nx = -contact.nx; contact.nz = -contact.nz; }
      return true;
    }
    const dx = centerX - collider.obb.cx, dz = centerZ - collider.obb.cz;
    const distance = hypot(dx, dz);
    const depth = body.radius + collider.radius - distance;
    if (depth <= 1e-9) return false;
    return setContact(contact, distance > EPSILON ? dx / distance : 1, distance > EPSILON ? dz / distance : 0, depth);
  }
  return rectangularContact(collider, centerX, centerZ, body, contact);
}

const bodyProjection = (body, ax, az, sin, cos) => body.oriented
  ? body.hx * Math.abs(ax * cos - az * sin) + body.hz * Math.abs(ax * sin + az * cos)
  : body.radius;

function circleBoxContact(circle, box, contact, circleX = circle.x, circleZ = circle.z, boxX = box.x, boxZ = box.z) {
  const sin = box.sin ?? box.sinHeading ?? Math.sin(box.heading || 0);
  const cos = box.cos ?? box.cosHeading ?? Math.cos(box.heading || 0);
  const dx = circleX - boxX, dz = circleZ - boxZ;
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const cx = Math.max(-box.hx, Math.min(box.hx, lx));
  const cz = Math.max(-box.hz, Math.min(box.hz, lz));
  const qx = boxX + cos * cx + sin * cz;
  const qz = boxZ - sin * cx + cos * cz;
  let nx = circleX - qx, nz = circleZ - qz;
  let distance = hypot(nx, nz);
  if (distance >= circle.radius - 1e-9) return false;
  let depth;
  if (distance > EPSILON) {
    nx /= distance; nz /= distance;
    depth = circle.radius - distance;
  } else {
    const dxFace = box.hx - Math.abs(lx), dzFace = box.hz - Math.abs(lz);
    if (dxFace <= dzFace) {
      const sign = lx <= 0 ? -1 : 1;
      nx = cos * sign; nz = -sin * sign;
      depth = circle.radius + dxFace;
    } else {
      const sign = lz <= 0 ? -1 : 1;
      nx = sin * sign; nz = cos * sign;
      depth = circle.radius + dzFace;
    }
  }
  return setContact(contact, nx, nz, depth);
}

/** Contact between two actor descriptors `{x,y,z,...collisionBody}`. The normal points from B toward A. */
export function bodyContact(a, b, out) {
  const aBottom = a.y + (a.bottom ?? 0), aTop = a.y + (a.top ?? 1.9);
  const bBottom = b.y + (b.bottom ?? 0), bTop = b.y + (b.top ?? 1.9);
  if (aBottom >= bTop || aTop <= bBottom) return false;
  const ax = a.x + (a.sin ?? 0) * (a.offsetForward || 0);
  const az = a.z + (a.cos ?? 1) * (a.offsetForward || 0);
  const bx = b.x + (b.sin ?? 0) * (b.offsetForward || 0);
  const bz = b.z + (b.cos ?? 1) * (b.offsetForward || 0);
  if (Math.abs(ax - bx) > a.extX + b.extX || Math.abs(az - bz) > a.extZ + b.extZ) return false;

  if (!a.oriented && !b.oriented) {
    const dx = ax - bx, dz = az - bz;
    const distance = hypot(dx, dz);
    const overlap = a.radius + b.radius - distance;
    if (overlap <= 1e-9) return false;
    if (distance > EPSILON) return setContact(out, dx / distance, dz / distance, overlap);
    return setContact(out, 1, 0, overlap);
  }
  if (!a.oriented && b.oriented) return circleBoxContact(a, b, out, ax, az, bx, bz);
  if (a.oriented && !b.oriented) {
    if (!circleBoxContact(b, a, out, bx, bz, ax, az)) return false;
    if (out) { out.nx = -out.nx; out.nz = -out.nz; }
    return true;
  }
  const aSin = a.sin ?? a.sinHeading ?? Math.sin(a.heading || 0);
  const aCos = a.cos ?? a.cosHeading ?? Math.cos(a.heading || 0);
  const bSin = b.sin ?? b.sinHeading ?? Math.sin(b.heading || 0);
  const bCos = b.cos ?? b.cosHeading ?? Math.cos(b.heading || 0);
  let depth = Infinity, nx = 0, nz = 0;
  for (let axisIndex = 0; axisIndex < 4; axisIndex++) {
    let axisX, axisZ;
    if (axisIndex === 0) { axisX = aCos; axisZ = -aSin; }
    else if (axisIndex === 1) { axisX = aSin; axisZ = aCos; }
    else if (axisIndex === 2) { axisX = bCos; axisZ = -bSin; }
    else { axisX = bSin; axisZ = bCos; }
    const overlap = bodyProjection(a, axisX, axisZ, aSin, aCos)
      + bodyProjection(b, axisX, axisZ, bSin, bCos) - Math.abs((ax - bx) * axisX + (az - bz) * axisZ);
    if (overlap <= 1e-9) return false;
    if (overlap < depth) {
      depth = overlap;
      const d = (ax - bx) * axisX + (az - bz) * axisZ;
      const sign = Math.abs(d) > EPSILON ? Math.sign(d) : (axisX > EPSILON || (Math.abs(axisX) <= EPSILON && axisZ >= 0) ? 1 : -1);
      nx = axisX * sign; nz = axisZ * sign;
    }
  }
  return setContact(out, nx, nz, depth);
}
