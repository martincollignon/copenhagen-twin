// js/lake-furniture-cph.js
// Pure: lake-path furniture aligned to the water (visual-refs §4, §8b, §1c): benches and rescue-ring posts face the water,
// the CitySwan-style bollard lights project their head over the path (away from the water). Uses the land-distance raster
// of the lakes (js/ground-field-cph.js lakeDistanceFrom): the direction to the water is the downhill of that field.

export const FACE_WATER_M = 9; // furniture closer than this to a wall belongs to the lake path

/** Unit (x, z) direction from (x, z) towards the nearest water, or null on water / far from it. */
export function towardWater(lakeDistance, x, z, within = FACE_WATER_M) {
  const d = lakeDistance(x, z);
  if (d > within) return null;
  const e = 0.9;
  const gx = lakeDistance(x + e, z) - lakeDistance(x - e, z);
  const gz = lakeDistance(x, z + e) - lakeDistance(x, z - e);
  const l = Math.hypot(gx, gz);
  return l < 1e-6 ? null : [-gx / l, -gz / l];
}

/** Model +z -> (sin yaw, cos yaw): the yaw that points the front along (dx, dz). */
export const yawToward = (dx, dz) => Math.atan2(dx, dz);

/**
 * Re-aims the lake-path items of a furniture plan in place: benches and rescue posts face the water, lake lights face the
 * path. Returns the counts. Items farther than FACE_WATER_M from a wall are untouched.
 */
export function alignLakeFurniture(plan, lakeDistance, { within = FACE_WATER_M } = {}) {
  const counts = { benches: 0, rescue: 0, lakeLights: 0 };
  if (!lakeDistance) return counts;
  const aim = (list, key, sign) => {
    for (const it of list || []) {
      const w = towardWater(lakeDistance, it.x, it.z, within);
      if (!w) continue;
      it.yaw = yawToward(w[0] * sign, w[1] * sign);
      it.alignedToWater = true;
      counts[key]++;
    }
  };
  aim(plan.benches, 'benches', 1);
  aim(plan.rescue, 'rescue', 1);
  aim(plan.lakeLights, 'lakeLights', -1);
  return counts;
}
