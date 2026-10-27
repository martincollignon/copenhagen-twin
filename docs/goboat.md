# GoBoat riding and Islands Brygge pier

Choose **Boat [5] → GoBoat**, alongside **Swan pedal boat**, just as Cycle offers City bike and Cargo bike. The Boat button and gamepad mode cycling remember the subtype. W/S or the gamepad triggers control forward/reverse; A/D or the left stick steer. Top speed is 6 km/h, reverse is limited to about 3 km/h, and throttle release coasts to rest. There is no boost.

At the Islands Brygge boarding point, **E**, the contextual button, or gamepad **A** boards the boat. The same action steps onto the pier when the boat has returned to its departure area and slowed below 0.35 m/s. Reboarding preserves the boat position. Choosing Walk while out on the water returns the walker to the boarding pier. The skipper uses the existing character rig, with one hand on the tiller and one resting forward.

## City expansion integration

The current small Søerne map has no harbour. GoBoat remains disabled, titled “Harbour map not loaded”; no boats or pier are drawn on missing water. No generated city data, terrain, water rendering or map bounds were changed for this feature.

`main.js` passes the **rendered** `world.lakeData.lakes` collection to `controllerManager.setGoBoatWorldData()` only when `world.lakes` exists. If the city expansion continues using that renderer and supplies harbour polygons at Islands Brygge, initialization is automatic. The array name `lakes` does not exclude harbour water.

For a separate harbour renderer, call after creating its visible water surface:

```js
controllerManager.setGoBoatWorldData({
  water: renderedHarbourPolygons,
  frame: world.geo.frame,
  // Optional: pierRecords, using the same fields as GOBOAT_PIER_RECORDS.
});
```

Each water record has `{ ring: [x,z,...], holes: [[x,z,...]], level }`. Coordinates are metres, EPSG:25832 relative to the world origin; x is east, z is south. `level` is **local y**, not absolute DVR90. At the current origin `[723900, 6176500, 6.84]`, sea level DVR90 0 is `-6.84`. Do not use the elevated Søerne lake level. When missing, a water level defaults to `-6.84`.

The adapter selects the connected water component containing the real departure point. It splits polygon edges at intersections and removes interior seams, then uses exact distances to the remaining boundary, islands, pier and moored boat footprints. A conservative 2.7 m hull radius plus 0.12 m clearance prevents the whole boat penetrating land. Motion is substepped at 0.25 m. Bridges are not blanket obstacles: the rendered water must continue beneath navigable bridge openings. This models physical water access, not the operator’s full commercial route restrictions or harbour traffic rules.

The default pier is OSM way 297639626, pavilion 297639625. Departure is local `(1111, 1446)`, heading `-1` rad; the boarding point is `(1117.1, 1444.4)`. Both must fall within the expanded map. Keep the pier out of the generic building collider set, or account for its actual walkable deck. The controller supplies the pier deck height for walking. Additional verified piers can be supplied as records; no fictional GoBoat bases are included.

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

Navigation tests cover absent water, shared/overlapping seams, disconnected collinear polygons, tiny islands, narrow quay intrusions, swept collision and throttle limits. Controller tests cover availability, safe pier return, speed-gated disembarking, reboarding and saved walking positions.

A Playwright browser probe also exercised the actual Boat sub-selector, unavailable harbour state, boarding, driving, disembarking, subtype memory and swan regression without page errors. It supplied a **test-only** water polygon because the separate city expansion has not landed. Screenshots of the boat/pier are model studies, not a reconstructed city backdrop.

The design scan flags existing Inter usage (suggests a distinctive face and a complementary font) and existing `padding`, `max-width` and `width` transitions (suggests transform/opacity). The GoBoat selector follows the existing bicycle selector; this change does not redesign the application’s typography or animations.
