// js/city-config.js
// City dispatcher. The engine core imports './city-config.js'; this resolves it to the Manhattan configuration
// (js/city-config-nyc.js, which pulls in the 1 MB nyc-geodata.js) with `?city=nyc`, or to the Copenhagen frame
// (js/city-config-cph.js) otherwise. Names missing from the Copenhagen config are undefined there: only
// Manhattan-only modules use them, and those are never loaded in Copenhagen mode.
import { IS_NYC } from './city.js';

const config = IS_NYC ? await import('./city-config-nyc.js') : await import('./city-config-cph.js');

export const AVENUES = config.AVENUES;
export const ALL_AVENUES = config.ALL_AVENUES;
export const CENTRAL_PARK_BOUNDS = config.CENTRAL_PARK_BOUNDS;
export const getIslandBoundsAtZ = config.getIslandBoundsAtZ;
export const MANHATTAN_COASTLINE = config.MANHATTAN_COASTLINE;
export const getBroadwayX = config.getBroadwayX;
export const BROADWAY_LINE = config.BROADWAY_LINE;
export const WATERFRONT_PIERS = config.WATERFRONT_PIERS;
export const ROOSEVELT_ISLAND_POLYGON = config.ROOSEVELT_ISLAND_POLYGON;
export const GOVERNORS_ISLAND_POLYGON = config.GOVERNORS_ISLAND_POLYGON;
export const NJ_SHORELINE_POLYGON = config.NJ_SHORELINE_POLYGON;
export const LONG_ISLAND_POLYGON = config.LONG_ISLAND_POLYGON;
export const LONG_ISLAND_POLYGONS = config.LONG_ISLAND_POLYGONS;
export const BROOKLYN_POLYGONS = config.BROOKLYN_POLYGONS;
export const QUEENS_POLYGONS = config.QUEENS_POLYGONS;
export const BRONX_POLYGONS = config.BRONX_POLYGONS;
export const WESTCHESTER_POLYGON = config.WESTCHESTER_POLYGON;
export const NASSAU_POLYGON = config.NASSAU_POLYGON;
export const UPPER_MANHATTAN_POLYGON = config.UPPER_MANHATTAN_POLYGON;
export const BRONX_POLYGON = config.BRONX_POLYGON;
export const STATEN_ISLAND_POLYGON = config.STATEN_ISLAND_POLYGON;
export const RANDALLS_ISLAND_POLYGON = config.RANDALLS_ISLAND_POLYGON;
export const LIBERTY_ISLAND_POLYGON = config.LIBERTY_ISLAND_POLYGON;
export const LIBERTY_STATUE_POS = config.LIBERTY_STATUE_POS;
export const ELLIS_ISLAND_POLYGON = config.ELLIS_ISLAND_POLYGON;
export const MILL_ROCK_POLYGON = config.MILL_ROCK_POLYGON;
export const EAST_RIVER_BRIDGES = config.EAST_RIVER_BRIDGES;
export const OUTER_BRIDGES = config.OUTER_BRIDGES;
export const STREETS = config.STREETS;
export const ALL_STREETS = config.ALL_STREETS;
export const ROADS = config.ROADS;
export const NYC_LANDMARKS = config.NYC_LANDMARKS;
export const LANDMARK_SITES = config.LANDMARK_SITES;
export const TELEPORT_LOCATIONS = config.TELEPORT_LOCATIONS;
export const ISLAND_BOUNDS = config.ISLAND_BOUNDS;
export const LANDMARK_BLOCKS = config.LANDMARK_BLOCKS;
export const BLOCKS = config.BLOCKS;
export const CUT_Z = config.CUT_Z;
export const SIGNAL_TIMING = config.SIGNAL_TIMING;
export const streetZ = config.streetZ;
export const avenueX = config.avenueX;
export const avenueNameAt = config.avenueNameAt;
export const districtAt = config.districtAt;
export const blockAt = config.blockAt;
export const blocksInRect = config.blocksInRect;
export const nearestRoads = config.nearestRoads;
export const getBlockBounds = config.getBlockBounds;
export const getLocationLabel = config.getLocationLabel;
export const fromOldFrame = config.fromOldFrame;
export const isTypingInField = config.isTypingInField;
export const signalPhase = config.signalPhase;
export const walkSignal = config.walkSignal;
