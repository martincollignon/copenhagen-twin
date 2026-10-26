// js/city-config.js
// Copenhagen spatial configuration: the local frame, the playable bounds and the teleport presets the engine core
// (controllers, cameras, materials, gamepad) relies on. The frame follows docs/cph-geodata-schema.md.
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

/** EPSG:25832 (E, N, DVR90 height) to the local frame. */
export function toLocal(e, n, h = CPH_FRAME.origin[2]) {
  return { x: e - CPH_FRAME.origin[0], y: h - CPH_FRAME.origin[2], z: -(n - CPH_FRAME.origin[1]) };
}

/** Local frame to EPSG:25832 (E, N, DVR90 height). */
export function toEtrs(x, z, y = 0) {
  return { e: x + CPH_FRAME.origin[0], n: CPH_FRAME.origin[1] - z, h: y + CPH_FRAME.origin[2] };
}

// The playable area. Players may roam a margin beyond it (controllers.js clamps to these bounds). It starts as the
// district frame and is replaced by the extent of the tile index (setCityBounds, called by world.js) so the clamp
// follows the data: the object is mutated in place, every importer sees the new values.
const ISLAND_BOUNDS = { minX: BX0, maxX: BX1, minZ: BZ0, maxZ: BZ1, sidewalkHeight: 0.15, waterLevel: -2.2 };
const getIslandBoundsAtZ = () => ({ westX: ISLAND_BOUNDS.minX, eastX: ISLAND_BOUNDS.maxX });

const checkBbox = (bbox) => {
  const [x0, z0, x1, z1] = bbox;
  if (![x0, z0, x1, z1].every(Number.isFinite) || x1 <= x0 || z1 <= z0) throw new Error(`bad bounds ${bbox}`);
  return [x0, z0, x1, z1];
};

// The extent of the COMPILED data (tile index `frame.bbox`; the district frame until a tile index says otherwise). Water, the
// ground field, placement zones and the lawn mask are rasters / outlines over it, and a lake that reaches its edge is continued
// beyond it, so they take it from here instead of hardcoding the district.
let dataBbox = [...CPH_FRAME.bbox];
export const getDataBbox = () => dataBbox;

/**
 * Sets the playable / loaded extent [minX, minZ, maxX, maxZ] in the local frame (the union of the tile index), and optionally
 * the extent of the compiled data (`frame`).
 */
export function setCityBounds(bbox, { frame = null } = {}) {
  const [x0, z0, x1, z1] = checkBbox(bbox);
  Object.assign(ISLAND_BOUNDS, { minX: x0, minZ: z0, maxX: x1, maxZ: z1 });
  if (frame) dataBbox = checkBbox(frame);
  return ISLAND_BOUNDS;
}

/** The current playable / loaded extent as [minX, minZ, maxX, maxZ]. */
export const getCityBounds = () => [ISLAND_BOUNDS.minX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.maxZ];

// Teleport presets (local frame; positions and headings taken from the roadGraph centrelines of the named streets,
// heading = direction of travel along the street: forward is (sin h, cos h)). The scenic cameras (cameras.js) frame
// the same places.
const TELEPORT_LOCATIONS = {
  ns37: { name: 'Nørre Søgade 37', sub: 'Søerne · start', x: 0, z: 0, heading: Math.PI },
  dlb: { name: 'Dronning Louises Bro', sub: 'Søerne · Sankt Jørgens Sø', x: 97, z: -476.7, heading: -2.12 },
  peblinge: { name: 'Peblinge Sø', sub: 'Peblinge Dossering', x: -76.8, z: -320, heading: -0.45 },
  nbro: { name: 'Nørrebrogade', sub: 'Nørrebro · cycle street', x: -147.3, z: -620.1, heading: -2.1 },
  blaag: { name: 'Blågårds Plads', sub: 'Nørrebro · square', x: -314.6, z: -448, heading: 1.04 }
};

function isTypingInField(event) {
  const target = event?.target;
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

export {
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  TELEPORT_LOCATIONS,
  isTypingInField
};
