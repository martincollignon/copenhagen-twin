# GoBoat riding and Islands Brygge pier

Choose **Boat [5] → GoBoat**, alongside **Swan pedal boat**, just as Cycle offers City bike and Cargo bike. The Boat button and gamepad mode cycling remember the subtype. W/S or the gamepad triggers control forward/reverse; A/D or the left stick steer. Top speed is 6 km/h, reverse is limited to about 3 km/h, and throttle release coasts to rest. There is no boost.

At the Islands Brygge boarding point, **E**, the contextual button, or gamepad **A** boards the boat. The same action steps onto the pier when the boat has returned to its departure area and slowed below 0.35 m/s. Reboarding preserves the boat position. Choosing Walk while out on the water returns the walker to the boarding pier. The skipper uses the existing character rig, with one hand on the tiller and one resting forward.

## City integration

GoBoat runs on the citywide streamed build (data/city/water.json, data/tiles/<id>/water.json, tools/cph-geodata/city_water.py).

- **Reach: the citywide water, resident from boot.** `main.js` hands `setGoBoatWorldData` the sea-level (`-6.84` local y) pieces of the citywide water header's `far` table (`goBoatWaterFromCity`). The header is already loaded for the water layer and the far ring, so there is no extra fetch, and what the boat can reach never depends on which tiles are streamed in. The pieces are clipped to the 500 m tiles and simplified by 2 m; the adapter removes the seams and keeps the component that holds the departure point: the inner harbour, Nyhavn, Christianshavns Kanal, Trangraven, Sydhavnen and the open sound. The water polygons run on under the bridges (Langebro, Lille Langebro, Knippelsbro, Inderhavnsbroen, the canal bridges), so the boat passes beneath them.
- **Quay: the drawn one where it is loaded.** The world reports the full-resolution water layer of every tile in the near and mid rings (`world.waterTiles`, `world.onWaterTile`); `setGoBoatDetailWater` feeds it to the navigation. Where every tile the hull circle touches has its layer, the boat collides with the drawn polygons (the quay walls of js/water-tiles-cph.js stand on their outline); elsewhere the 2 m-simplified water decides. Clip seams on the tile edges are not quay. If a tile arrives with the hull already inside its quay, the boat steps back onto open water (at most 8 m).
- **Pier and pavilion.** The pier is OSM way 297639626 and the pavilion OSM way 297639625 (amenity=boat_rental, name=GoBoat); the OSM centroid lands at local (1139, 1415). The floating spine lies on the harbour 15-20 m off the Islands Brygge quay, and the pavilion's landward edge is on the quay line. GeoDanmark maps the pavilion as three small buildings at the sea level (gdk:1205593464, gdk:1205593478, gdk:1233983966). `isGoBoatPierBuilding` (js/goboat-pier-data.js) drops them from the tile buildings (`createTileData({ dropBuilding })`), so the pier model is not covered by building boxes and does not become a building collider. No street furniture stands on the pier; the nearest bench and lamp are on the quay.
- **Moored boats.** Twenty-seven boats lie bow-in on both sides of the spine. Their hull footprints are navigation obstacles, and every corner is on the drawn water inside the quay.

The pier records are plain data in js/goboat-pier-data.js (no three.js), so the world and the tests can read them. Coordinates are metres, EPSG:25832 relative to the world origin `[723900, 6176500, 6.84]`; x is east, z is south. Additional verified piers can be supplied as records; no fictional GoBoat bases are included.

For another water source, call after creating its visible water surface:

```js
controllerManager.setGoBoatWorldData({
  water: renderedHarbourPolygons, // [{ ring: [x,z,...], holes: [[x,z,...]], level }]; level is local y
  frame: world.geo.frame,
  tileGrid: { tileOf, boundsOf }, // optional: enables setGoBoatDetailWater(id, payload)
  // Optional: pierRecords, using the same fields as GOBOAT_PIER_RECORDS.
});
```

Without the citywide water (the district fallback, `?debug=notiles`), only the rendered Søerne are passed and GoBoat stays disabled ("Harbour map not loaded").

The adapter splits polygon edges at intersections and removes interior seams, then uses exact distances to the remaining boundary, islands, pier and moored boat footprints. A conservative 2.7 m hull radius plus 0.12 m clearance keeps the whole boat off the land. Motion is substepped at 0.25 m. This models physical water access, not the operator's commercial route restrictions or harbour traffic rules. Bridge piers inside the water polygons are not obstacles.

## Reconstruction evidence and accuracy

Ten photographs were downloaded and inspected: aerial base layout; broadside hull; empty cockpit; overhead seating/table; family bow view; docked boats; terminal and motor row; bow-on view; canal broadside; and bow three-quarter view. Their verified image URLs are recorded in [the reference manifest](research/goboat-references.json). Local copies were kept only in the review workspace.

- The [official Copenhagen page](https://goboat.dk/en/copenhagen) establishes the Islands Brygge departure, electric picnic boat, and eight-person seating concept.
- The [official Captain’s Handbook](https://goboat-website-production.imgix.net/prod/sites/3/2023/07/05100544/GoBoat-Captains-HandBook-Islands-Brygge.pdf) shows the boat and tiller and describes timber tables/pier/pavilion and the solar roof.
- The [terminal design article](https://www.e-architect.com/copenhagen/goboat-on-islands-brygge) provides architectural context and timber references.
- The [pier footprint](https://www.openstreetmap.org/api/0.6/way/297639626/full) and [pavilion footprint](https://www.openstreetmap.org/api/0.6/way/297639625/full) were retrieved from OpenStreetMap and projected from WGS84 to EPSG:25832 using pyproj. © OpenStreetMap contributors, ODbL; derived footprint geometry retains that licence.

**Observed:** mapped dock and pavilion outlines, blue moulded hull and continuous benches, low stern/outboard, central timber tabletop, two longitudinal table legs, cupholders, rubbing strip, glass/dark timber pavilion with solar roof, and bow-in boats on both sides of the floating spine.

**Inferred:** 5 × 2 m hull dimensions, freeboard/draft, table and fitting dimensions, pavilion/deck elevations, materials and berth spacing. These are photo-based approximations, not a surveyed or manufacturer-CAD reconstruction. Twenty-seven moored boats represent a reduced fleet; their geometry is instanced. The mapped pier outline is newer than some reference photographs, so small end structures differ from the older aerial view. The playable boat launches just beyond the end of the fleet rather than occupying a static berth.

## Verification

```sh
node --test tests/*.cjs tests/*.mjs
# Uses the same locally cached Three version as the existing rendering audits:
node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/audit-goboat.mjs
```

Navigation tests cover absent water, shared/overlapping seams, disconnected collinear polygons, tiny islands, narrow quay intrusions, swept collision and throttle limits. tests/goboat-harbour.test.mjs runs against the real harbour (tests/fixtures/goboat-harbour.json: the sea-level `far` pieces of the inner-harbour tiles and the full water layers of the five tiles around the pier, Langebro and Christianshavn, from R2 v3): the boat reaches Langebro, Knippelsbro, Christianshavns Kanal and Nyhavn from the pier, stays off the land, keeps its hull clear of the drawn quay, and the moored boats float inside the quay bow-in. Controller tests cover availability, safe pier return, speed-gated disembarking, reboarding and saved walking positions.

A Playwright browser probe also exercised the actual Boat sub-selector, unavailable harbour state, boarding, driving, disembarking, subtype memory and swan regression without page errors. On the citywide build (`?data=<R2 v3>`) the probe teleports to Islands Brygge, selects Boat → GoBoat, drives under Langebro and back on the real harbour, and steps onto the pier, with no console errors.

The design scan flags existing Inter usage (suggests a distinctive face and a complementary font) and existing `padding`, `max-width` and `width` transitions (suggests transform/opacity). The GoBoat selector follows the existing bicycle selector; this change does not redesign the application’s typography or animations.
