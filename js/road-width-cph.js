// js/road-width-cph.js
// The carriageway width the Copenhagen twin uses for a road. The compiler's `width` is a measured kerb-to-kerb (or
// facade-to-facade) spacing, inferred and clamped at 30 m, and it often includes parking, cycle tracks and pavement:
// 190 one-way roads read 30 m. Roads, kerbs, lane offsets, junction boxes and pavement lines all use the narrower of
// that and what the lanes need, so a 1-lane residential street is 6-7 m, not 30.

const EXTRA = { primary: 1.5, secondary: 1.5, residential: 3.6, service: 0.5, cycleway: 0 }; // parking, shoulder
export const LANE_WIDTH = 3.1;

/** @param road { width, lanesFwd, lanesBack, oneway, class } */
export function carriagewayWidth(road) {
  const lanes = Math.max(1, (road.lanesFwd ?? 1) + (road.oneway ? 0 : (road.lanesBack ?? 1)));
  return carriagewayFromLanes(road.width, lanes, road.class);
}

export function carriagewayFromLanes(width, lanes, cls) {
  const need = Math.max(1, lanes) * LANE_WIDTH + (EXTRA[cls] ?? 1);
  const w = width > 0 ? width : need;
  return Math.max(3.0, Math.min(w, need, 20));
}
