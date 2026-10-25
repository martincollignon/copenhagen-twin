# Reconciling drawings with the current building

## Why

A building case records approvals. Buildings change afterwards: balconies added, loggias glazed, roof storeys built, entrances moved, renovations. On Nørre Søgade 37 the final 1970 courtyard elevation shows ribbon windows only. The 2017 photos show three stacks of projecting balconies, and the 2025 photos show balconies across almost the whole courtyard facade after the 2021–23 renovation. None of these changes is in the eight downloaded PDFs. A model built from the drawings alone is a 1970 model.

## Side-by-side sheets at one scale

1. `facade_rectify.py` gives each oblique in facade metres: x along the edge from vertex a, z above terrain.
2. Crop the elevation drawing to the same x/z range using its `elevation.py` calibration. If the elevation-u axis runs opposite to the facade edge, flip the crop. Stack the crops: drawing, oldest photo, newest photo.
3. Projections such as balconies sit in front of the facade plane, so they appear slightly displaced. Judge presence, rhythm and storey, not centimetres.
4. Glass reflects sky, so in photos it is often lighter than the wall. Recesses and loggias are dark. Hatched or dark zones on drawings are usually recesses or loggias with doors behind.

## `analysis/reconciliation.md` template

| facade | element | final drawing | photo (oldest) | photo (newest) | permits / user | decision | evidence |
|---|---|---|---|---|---|---|---|
| courtyard | balconies | none (60B) | 3 stacks, 2 bays each, floors 1–8 | nearly full width, floors 1–7 | renovation 2021–23 (case not in set) | as photographed (2025) | rectified 2025 west, px boxes |

The decision must be one of `as drawn`, `as photographed`, `user` or `ask`. Every `ask` row goes to the user before Phase 3.

## Also look for

- **Gaps in the building case.** Look for later cases you don't have: alterations visible between collections. Ask the user for them (Filarkiv search by address, or *aktindsigt*).
- **Scaffolding and occlusion.** Use the other collection for that part of the facade, and record which one was used.
- **Ground floor.** Shopfronts and entrances change most often. Ask the user.

## Lessons from NS37

- **Check the rectification against the drawing, not just the other photo.** Rectifications from different collections can be offset along the facade: about 1.3 m for the 2017 west view. Align them on features in the facade plane, such as ribbon windows or piers traced from the drawing, before reading balcony extents. Projecting balconies are displaced by perspective.
- **Read appearance from the photos too.** NS37's courtyard balcony fronts are solid grey panels. Modelled as sparse metal posts they vanished in renders. Record the front type with the extent.
- **Count entrances against the user, not the drawing.** The final 1970 drawing has 5 courtyard doors; today there are 3, one per stair, at the drawing's door positions A, C and E.
- **Use the drawing's pattern where a detector fails.** The street loggias are drawn as a fine stipple that none of the detectors separated. One bay was read on a pixel grid and repeated on the measured bay pitch. Each bay was visually confirmed, and the copies were marked `scaled`.
