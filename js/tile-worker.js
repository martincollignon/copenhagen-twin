// js/tile-worker.js
// Web Worker: the CPU halves of a tile's layers off the main thread. One message in per job ({ id, kind, job }), one out ({ id, result }
// with its typed arrays transferred, or { id, error }). Kinds: 'buildings' (js/building-compute.js), 'roads' (js/road-compute.js), 'furniture' (js/furniture-compute.js).
// Started by js/tile-pool.js.
import { computeBuildings, transferablesOf } from './building-compute.js';
import { computeRoadSurfaces } from './road-compute.js';
import { computeFurniturePlacement } from './furniture-compute.js';

const KINDS = { buildings: computeBuildings, roads: computeRoadSurfaces, furniture: computeFurniturePlacement };

self.onmessage = (event) => {
  const { id, kind, job } = event.data;
  try {
    const result = KINDS[kind](job);
    self.postMessage({ id, result }, transferablesOf(result));
  } catch (error) {
    self.postMessage({ id, error: String(error?.stack || error) });
  }
};
