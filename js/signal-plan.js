// js/signal-plan.js
// Fixed-time signal plans for the Copenhagen junctions (v1): two phases per 60 s cycle, no actuation.
//
//   t (s)      0 ........ 24 25 26 27 ........ 30 ........ 54 55 56 57 ... 60
//   slot 0     GREEN       amber    red         red          red
//   slot 1     red         red      red         GREEN        amber   red
//
// Slot 0 is the junction's main road (road-network.js group 0), slot 1 every other road. Cyclists get an early
// green: their lights turn green BIKE_LEAD seconds before the cars' and turn red when the cars' amber starts, so they
// clear the junction before turning cars come through. Pedestrians cross a road on the green of the other slot
// (parallel traffic), starting with it and finishing WALK_CLEAR seconds before it ends.
//
// Pure functions of (junction offset, slot or road group, time): nothing to keep in sync between the car, pedestrian
// and cyclist simulations.

export const CYCLE = 60;
export const GREEN = 24;
export const AMBER = 3;
export const BIKE_LEAD = 4;
export const WALK_CLEAR = 7;
const SLOT_START = [0, 30];

/** A deterministic 0..CYCLE offset for the junction at (x, z), so neighbouring junctions are not in lockstep. */
export function signalOffset(x, z) {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * CYCLE;
}

const slotOf = (group) => (group > 0 ? 1 : 0);

// seconds into the slot's cycle (0 = its green starts)
function local(offset, group, t) {
  const u = (((t + offset - SLOT_START[slotOf(group)]) % CYCLE) + CYCLE) % CYCLE;
  return u;
}

/** 'green' | 'amber' | 'red' for vehicles of a road group. */
export function vehiclePhase(offset, group, t) {
  const u = local(offset, group, t);
  if (u < GREEN) return 'green';
  if (u < GREEN + AMBER) return 'amber';
  return 'red';
}

/** 'green' | 'red' for cyclists riding with a road group's traffic (early green, red from the cars' amber). */
export function bikePhase(offset, group, t) {
  const u = local(offset, group, t);
  return u < GREEN || u >= CYCLE - BIKE_LEAD ? 'green' : 'red';
}

/** May pedestrians be on the crosswalk over a road of `group`? (Green for the other slot.) */
export function walkPhase(offset, group, t) {
  const u = local(offset, 1 - slotOf(group), t);
  return u < GREEN - WALK_CLEAR;
}

/** A two-arm signalised crossing carries no side road: cars of group 0 are red while pedestrians walk. */
export const crossingPhase = (offset, t) => (local(offset, 1, t) < GREEN ? 'red' : 'green');
