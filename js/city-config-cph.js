// js/city-config-cph.js
// Copenhagen spatial configuration (M0: an empty ground plane in the Copenhagen frame). It exports the subset of the
// js/city-config-nyc.js interface the engine core (controllers, cameras, materials, audio, gamepad) relies on, with
// neutral values. The frame follows docs/cph-geodata-schema.md.
//
// Local frame: 1 unit = 1 m, x = east, z = south (north = -z), y up. Source CRS EPSG:25832, vertical DVR90.
//   x = E - origin[0];  z = -(N - origin[1]);  y = DVR90 - origin[2]

export const CPH_FRAME = Object.freeze({
  epsg: 25832,
  vertical: 'DVR90',
  origin: Object.freeze([723900.0, 6176500.0, 6.84]), // near Norre Sogade 37
  axes: 'x=east, z=south, y=up',
  bbox: Object.freeze([-750, -750, 750, 750]) // [minX, minZ, maxX, maxZ]
});

const [BX0, BZ0, BX1, BZ1] = CPH_FRAME.bbox;
const FAR = 1e7;

/** EPSG:25832 (E, N, DVR90 height) to the local frame. */
export function toLocal(e, n, h = CPH_FRAME.origin[2]) {
  return { x: e - CPH_FRAME.origin[0], y: h - CPH_FRAME.origin[2], z: -(n - CPH_FRAME.origin[1]) };
}

/** Local frame to EPSG:25832 (E, N, DVR90 height). */
export function toEtrs(x, z, y = 0) {
  return { e: x + CPH_FRAME.origin[0], n: CPH_FRAME.origin[1] - z, h: y + CPH_FRAME.origin[2] };
}

// The playable district. Players may roam a margin beyond it (controllers.js clamps to these bounds).
const ISLAND_BOUNDS = { minX: BX0, maxX: BX1, minZ: BZ0, maxZ: BZ1, sidewalkHeight: 0.15, waterLevel: -2.2 };
const getIslandBoundsAtZ = () => ({ westX: BX0, eastX: BX1 });

// No park with raised ground, no harbour: neutral values for the Manhattan-derived shader inputs
const CENTRAL_PARK_BOUNDS = { minX: FAR, maxX: FAR + 1, minZ: FAR, maxZ: FAR + 1 };
const NJ_SHORELINE_POLYGON = [];
const LONG_ISLAND_POLYGONS = [];

const ROADS = [];
const NYC_LANDMARKS = [];
const BLOCKS = [];
const TELEPORT_LOCATIONS = {
  origin: { x: 0, z: 0, heading: Math.PI } // Norre Sogade 37, looking south
};
const SIGNAL_TIMING = { cycle: 60, avenueRed: 30, walk: 20 };

const streetZ = () => 0;
const blockAt = () => null;
const nearestRoads = () => [];
const signalPhase = () => 'green';
const walkSignal = () => false;

function getLocationLabel(x, z) {
  return `Copenhagen · E ${Math.round(x)} S ${Math.round(z)}`;
}

function isTypingInField(event) {
  const target = event?.target;
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

export {
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  CENTRAL_PARK_BOUNDS,
  NJ_SHORELINE_POLYGON,
  LONG_ISLAND_POLYGONS,
  ROADS,
  NYC_LANDMARKS,
  BLOCKS,
  TELEPORT_LOCATIONS,
  SIGNAL_TIMING,
  streetZ,
  blockAt,
  nearestRoads,
  signalPhase,
  walkSignal,
  getLocationLabel,
  isTypingInField
};
