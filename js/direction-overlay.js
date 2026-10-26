import * as THREE from 'three/webgpu';
import { carDirection } from './bike-direction.js';

// js/direction-overlay.js
// `?debug=oneway`: arrows on the ground showing which way things may travel. Orange: cars on a one-way street (two-way
// streets get none). Cyan: a cycle track or path lane, in the direction its riders go; magenta: a contraflow lane (riders
// against the cars); green: the shared lane with the cars on a contraflow street. Flat triangles, drawn over everything.

const COLOURS = { car: 0xff8a00, track: 0x00d0ff, path: 0x4d7cff, contra: 0xff2fb4, shared: 0x32e36b };
const VEHICULAR = new Set(['primary', 'secondary', 'residential', 'service']);

function arrowAt(out, x, z, dx, dz, y, len, wid) {
  const nx = -dz;
  const nz = dx;
  const tip = [x + dx * len * 0.6, z + dz * len * 0.6];
  const bl = [x - dx * len * 0.4 + nx * wid, z - dz * len * 0.4 + nz * wid];
  const br = [x - dx * len * 0.4 - nx * wid, z - dz * len * 0.4 - nz * wid];
  const notch = [x - dx * len * 0.1, z - dz * len * 0.1];
  out.push(tip[0], y, tip[1], bl[0], y, bl[1], notch[0], y, notch[1], tip[0], y, tip[1], notch[0], y, notch[1], br[0], y, br[1]);
}

function along(pts, every, fn) {
  let carry = every * 0.5;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const az = pts[i + 1];
    const L = Math.hypot(pts[i + 2] - ax, pts[i + 3] - az);
    if (L < 1e-6) continue;
    const ux = (pts[i + 2] - ax) / L;
    const uz = (pts[i + 3] - az) / L;
    for (let s = carry; s < L; s += every) fn(ax + ux * s, az + uz * s, ux, uz);
    carry = (carry + Math.ceil((L - carry) / every) * every) - L;
    if (carry < 0 || !Number.isFinite(carry)) carry = every * 0.5;
  }
}

/**
 * @param scene
 * @param geo data/cph-geodata.json (after applyStreets)
 * @param cyclistNetwork cyclist-network.js network
 * @param groundHeight { heightAt(x, z) }
 */
export function buildDirectionOverlay(scene, geo, cyclistNetwork, groundHeight) {
  const buckets = Object.fromEntries(Object.keys(COLOURS).map((k) => [k, []]));
  const h = (x, z) => (groundHeight ? groundHeight.heightAt(x, z) : 0);
  for (const r of geo.roads || []) {
    if (!VEHICULAR.has(r.class) || !r.pts || r.drop || carDirection(r) !== 'fwd') continue;
    along(r.pts, 22, (x, z, ux, uz) => arrowAt(buckets.car, x, z, ux, uz, h(x, z) + 1.4, 7, 1.6));
  }
  for (const l of cyclistNetwork.lanes) {
    const kind = buckets[l.kind] ? l.kind : 'track';
    along(l.pts, 14, (x, z, ux, uz) => arrowAt(buckets[kind], x, z, ux, uz, h(x, z) + (kind === 'track' || kind === 'path' ? 1.9 : 2.2), 4.2, 0.9));
  }
  const group = new THREE.Group();
  group.name = 'DirectionOverlay';
  for (const [kind, pos] of Object.entries(buckets)) {
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    const m = new THREE.MeshBasicNodeMaterial({ color: COLOURS[kind], side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = `dir-${kind}`;
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  scene.add(group);
  return { group, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length / 18])) };
}
