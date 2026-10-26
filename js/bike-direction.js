// js/bike-direction.js
// Which way cars and bicycles may travel along a road of data/cph-geodata.json (tools/cph-geodata/bikedir.py writes it).
// Pure, no three.js: the cyclist network, the road surfaces (contraflow paint) and the audit all read directions here.
//
// A road's `pts` run with its traffic (oneway=-1 ways are re-oriented by the compiler), so `carDir` is "fwd" (one-way) or
// "both"; "none" on paths. `bike` = { left, right, carriageway, contraflow, contraKind, ... } where left/right are the
// directions a cycle lane/track on that side of the pts direction is ridden in ("fwd" | "back" | "both" | "none") and
// `carriageway` is who may ride the street itself. Roads compiled before the field existed fall back to the same
// right-hand-traffic convention the compiler uses.

/** @returns {'fwd'|'both'|'none'} the direction cars travel along road.pts */
export function carDirection(road) {
  if (road.carDir) return road.carDir;
  if (road.class === 'cycleway' || road.class === 'footway') return 'none';
  return road.oneway ? 'fwd' : 'both';
}

/** Direction a cycle track on `side` (+1 right of the pts direction, -1 left) is ridden in: "fwd" | "back" | "both". */
export function stripDirection(road, side) {
  const d = road.bike?.[side > 0 ? 'right' : 'left'];
  if (d && d !== 'none') return d;
  if (carDirection(road) === 'fwd') return 'fwd';
  return side > 0 ? 'fwd' : 'back';
}

/** Bicycles may ride this carriageway in these directions: "fwd" | "back" | "both" | "none" (a path's own direction on cycleways). */
export function bikeCarriageway(road) {
  if (road.bike?.carriageway) return road.bike.carriageway;
  if (road.class === 'cycleway') return 'both';
  return carDirection(road) === 'fwd' ? 'fwd' : 'both';
}

/** True when bicycles may go against the cars of a one-way street (a contraflow lane, track, or shared). */
export const hasContraflow = (road) => !!road.bike?.contraflow && carDirection(road) === 'fwd';

/** Bicycles are banned from this road's carriageway (bicycle=no / use_sidepath). */
export const bikeBanned = (road) => !!road.bike?.ban;

/** Which of the two ways a set of strips [{ side }] covers: { fwd, back } */
export function stripCoverage(road, strips) {
  const cov = { fwd: false, back: false };
  for (const sp of strips) {
    const d = stripDirection(road, sp.side);
    if (d === 'fwd' || d === 'both') cov.fwd = true;
    if (d === 'back' || d === 'both') cov.back = true;
  }
  return cov;
}

/** The direction (+1 with the road's pts, -1 against) a lane polyline runs, from its geometry at its middle: the road's
 * own segment nearest to it. Independent of how the lane was built, so the audit can check the construction. */
export function alongRoad(roadPts, lanePts) {
  const mid = (lanePts.length / 4 | 0) * 2;
  const x = lanePts[mid];
  const z = lanePts[mid + 1];
  const tx = lanePts[Math.min(mid + 2, lanePts.length - 2)] - lanePts[Math.max(mid - 2, 0)];
  const tz = lanePts[Math.min(mid + 3, lanePts.length - 1)] - lanePts[Math.max(mid - 1, 1)];
  let best = Infinity;
  let dot = 0;
  let side = 0;
  for (let i = 0; i + 3 < roadPts.length; i += 2) {
    const dx = roadPts[i + 2] - roadPts[i];
    const dz = roadPts[i + 3] - roadPts[i + 1];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - roadPts[i]) * dx + (z - roadPts[i + 1]) * dz) / l2));
    const d = Math.hypot(roadPts[i] + dx * t - x, roadPts[i + 1] + dz * t - z);
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2);
      dot = (tx * dx + tz * dz) / l;
      side = ((x - roadPts[i]) * -dz + (z - roadPts[i + 1]) * dx) / l; // + right of the road
    }
  }
  return { along: dot >= 0 ? 1 : -1, side, dist: best };
}
