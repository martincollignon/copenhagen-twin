# Lakes, trees and night lighting: before / after

Shots: `<view>-<day|night>-<before|after>.png` from `tools/shoot-look.py` (`uv run --with playwright python tools/shoot-look.py --tag after`).
Frame times: `fps-before.json`, `fps-after.json` (+ `fps-after-run1.json`): unthrottled, 3 s per view.

## What changed
- **Water level / walls.** `tools/cph-geodata/basins.py` splits the bridge-merged lake into basins: Peblinge Sø -0.94 m, Sortedams Sø -0.10 m (DTM over the water). One level for both made 62 shore vertices >2 m. Now Søerne quay: p5/p50/p95 = 0.30 / 0.65 / 0.96 m; audit `lake-wall-too-tall` 62 -> 0. The only walls >2 m are the Dronning Louises Bro abutments (deck 1.62 m over a -0.94 m lake). Park ponds get grassed 1:1.6 banks, not granite.
- **Lake path.** Ground shader (`js/ground-shader-cph.js`): 3.6 m fine-gravel band with a wandering soft edge, grass in parks, shared gravel colour with the register polygons (no seams).
- **Trees.** `js/tree-geometry-cph.js`: per-genus skeleton (trunk with flare, limbs, twigs) + leaf-spray cards from a painted atlas (heart / palmate / lobed / ovate / compound), mid clusters, painted billboards; wind sway; light through the leaves. Untyped crowns (3,678 of 4,905) get a context genus (`js/tree-species-cph.js`): Søerne avenues lime 42 % / horse chestnut 46 %.
- **Night.** `js/night-lights-cph.js` + `js/pool-light-cph.js`: lamp photometry from CCT and source type, one illuminance raster around the camera added by ground / road / pavement shaders, glare halos, 8 real lights chosen by flux and distance.
- **Furniture.** Benches and rescue posts face the water, lake lights project over the path (`js/lake-furniture-cph.js`).

## Licences
Nothing downloaded. Tree algorithm is original, designed after [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT, credited as design reference); leaf atlas and billboards are painted procedurally at load.

## Remaining issues (critical look)
- Water planar reflection plane is at the Peblinge level: Sortedams reflections are offset ~1.7 m.
- No stairs/ramps at Dronning Louises Bro yet (left with the bridge module); the abutment wall is 2.5 m of plain ashlar, and pedestrians still stand in the water at its foot (ped routes).
- Pools do not light facades, cars or people (only the 8 real lights do); no building shadow in the pool raster.
- Lit windows at night were not touched (facade code belongs to another agent).
- Mid-LOD to near-LOD tree pop is visible; crowns are a little sparse from directly below; pale gravel reads bluish in noon light.
- Frame times are noisy on the shared GPU (before 44-69 fps, after 32-60 fps across runs); hiding trees / ground / halos changes <2 fps, so no single new cost stands out, but lake-path day was not reliably >=50 fps in either build (planar reflection pass doubles the scene).
