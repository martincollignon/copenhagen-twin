// js/reflect-gate.js
// Pure helpers (no three.js) that decide whether the planar reflection pass is worth its frame cost (the pass renders the scene a second time):
// is any water inside the camera's side frustum planes? The near / far planes are left out on purpose (the engine may use a reversed depth
// range); water behind the camera or off to the side is never reflected into the picture.

/** M = P * V for column-major 4 x 4 arrays (three.js Matrix4.elements). */
function mul(p, v) {
  const m = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += p[k * 4 + r] * v[c * 4 + k];
      m[c * 4 + r] = s;
    }
  }
  return m;
}

/** The left, right, bottom and top frustum planes (normalised a, b, c, d; inside is a x + b y + c z + d >= 0) of a camera. */
export function sidePlanes(projection, viewInverse, out = new Float64Array(16)) {
  const m = mul(projection, viewInverse);
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const [r0, r1, r3] = [row(0), row(1), row(3)];
  const sets = [[r3, r0, 1], [r3, r0, -1], [r3, r1, 1], [r3, r1, -1]];
  sets.forEach(([w, a, sign], i) => {
    const p = [w[0] + sign * a[0], w[1] + sign * a[1], w[2] + sign * a[2], w[3] + sign * a[3]];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    for (let k = 0; k < 4; k++) out[i * 4 + k] = p[k] / len;
  });
  return out;
}

/** False when the box lies entirely outside one of the planes (grown by `margin` m). */
export function boxVisible(planes, min, max, margin = 0) {
  for (let i = 0; i < 4; i++) {
    const a = planes[i * 4]; const b = planes[i * 4 + 1]; const c = planes[i * 4 + 2]; const d = planes[i * 4 + 3];
    const x = a >= 0 ? max[0] : min[0];
    const y = b >= 0 ? max[1] : min[1];
    const z = c >= 0 ? max[2] : min[2];
    if (a * x + b * y + c * z + d < -margin) return false;
  }
  return true;
}

export function pointVisible(planes, x, y, z, margin = 0) {
  return boxVisible(planes, [x, y, z], [x, y, z], margin);
}
