// js/tile-own.js
// Tile builds read a CONTEXT document (the tile and the tiles around it, so junctions, kerbs, party walls and zones come out
// the same as in the whole-district build) but may only EMIT geometry for the items the tile owns (ownership by centroid,
// tools/cph-geodata/tile_split.py). `doc.own = { <list name>: Set<item> }` marks the owned items; a document without `own`
// (the district build, tests) owns everything.

/** The items of `doc[key]` the build may emit. */
export function ownList(doc, key) {
  const list = doc?.[key] || [];
  const own = doc?.own?.[key];
  return own ? list.filter((item) => own.has(item)) : list;
}

/** True when `item` of list `key` may be emitted. */
export const isOwned = (doc, key, item) => !doc?.own?.[key] || doc.own[key].has(item);
