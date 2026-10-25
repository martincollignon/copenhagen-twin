import { buildCityGrid } from './city-grid.js';
import { buildBoroughs } from './boroughs.js';
import { buildLandmarks } from './landmarks.js';
import { buildCityBlocks } from './buildings.js';
import { buildStreetDetails } from './street-details.js';
import { createTrafficSystem, createHighwayTraffic } from './traffic.js';
import { buildRoadPaint } from './road-paint.js';
import { NYCMapSystem } from './nyc-map.js';
import { GEO } from './nyc-geodata.js';

// js/world-nyc.js
// The original slop-newyork world: Manhattan grid, boroughs, landmarks, synthetic lot buildings, street details,
// traffic and the NYC map. Loaded by main.js only with `?city=nyc`; Copenhagen mode (js/world-cph.js) never imports
// any of these modules, so none of the 1 MB Manhattan geodata is fetched there.

export function buildNycWorld(scene, { markInit = () => {} } = {}) {
  // Build Manhattan Geography, Iconic Landmarks, Blocks, Street Details & Traffic
  const cityGrid = buildCityGrid(scene);
  markInit('cityGrid');
  const boroughs = buildBoroughs(scene, { sidewalks: cityGrid.sidewalks });
  markInit('boroughs');
  const { colliders: landmarkColliders } = buildLandmarks(scene);
  markInit('landmarks');
  const cityBlocks = buildCityBlocks(scene);
  markInit('blocks');
  const colliders = [...landmarkColliders, ...cityBlocks.colliders, ...boroughs.colliders, ...(cityGrid.colliders || [])];

  const streetDetails = buildStreetDetails(scene);
  markInit('streetDetails');
  // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they stay
  // inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them.
  // Elevated building sections that clear even a bus don't obstruct ground traffic.
  const trafficSystem = createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...colliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5)
  ], streetDetails.signalIntersections, { geo: GEO });
  markInit('traffic');
  const highwayTraffic = createHighwayTraffic(scene, cityGrid.highwayLanes);
  buildRoadPaint(scene, trafficSystem.network);
  markInit('roadPaint');

  return {
    colliders,
    boroughs,
    cityBlocks,
    streetDetails,
    trafficSystem,
    highwayTraffic,
    cullingRoots: ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs'],
    geo: null,
    createMapSystem: (options) => new NYCMapSystem({ ...options, allBlocks: cityBlocks.allBlocks })
  };
}
