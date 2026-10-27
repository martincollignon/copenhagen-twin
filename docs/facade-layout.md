# Measured window layouts (`cph-facade-layout/1`)

Up close (under 45 m, `js/facade-lod.js PHOTO.close0`) every facade is the procedural one. Until now that facade guessed its window grid from the storey count and a preset bay width, so up close a building showed windows where the real ones are not. The facade photos fade in only between 45 and 80 m. A building with a Skråfoto atlas now gets a window grid fitted to that photo. The procedural shader draws the windows, doors and shopfronts at the measured columns and storeys, and the photo crossfade puts its own windows on top of them.

Step 1 of the better-buildings plan. The data is a tile layer (`windows`). The extractor is `tools/cph-geodata/facade_layout.py`, and the checks are `tools/cph-geodata/facade_layout_check.py`. The engine pieces are `js/facade-layout.js`, `js/building-geometry.js` (vertex words) and `js/tsl-materials.js facadeCell`.

## Extraction

Each wall strip of an atlas (`appearance.json atlas.walls[]`) is rectified in the engine's wall frame. Column 0 is the raw edge's start. Row 0 is `h_m` above the engine ground and the last row is the ground. Each strip is read from the processed look atlas (`data/tex-look/<id>.webp`, cached in `~/.cache/cph-twin/tex-look`).

1. **Deviation map.** The look atlas's own window alpha (255) only marks compact dark blobs. On the Nyhavn fronts it finds 0 of 15 windows on one front and 1 of 19 on another, so it is not used. Instead each texel's luminance is compared with a 2 m running median of the wall: panes are darker, frames are lighter, and edges carry gradient. A 0.3 m grey closing then merges the panes of one window into one block.
2. **Rows, then columns, twice.** The row profile, taken over the window columns, gets a periodic square-wave fit: storey pitch 2.4 to 4.8 m, a phase, and a window height. The fit is computed with folded cumulative sums. A multiple of the true pitch scores well too, so the smallest pitch within 80 % of the best score that is a local maximum wins. The column profile inside the window rows gets the same fit for the column pitch (1.1 to 6.5 m), the phase and the window width. Each pass narrows the other.
3. **Grid.** The lowest upper-storey row is the first one whose sill is at least 2.5 m up. Anything lower belongs to the ground floor. Rows run up to 0.4 m under the eave (`eave_m` on gable strips). Each cell (row × column) is tested on the mean deviation inside its window against the wall between the columns. A column is on when half of its observed cells are, and the top rows that have no windows are dropped. The fit sees the glazing, so the opening adds 0.08 m of frame on each side and 0.2 m at the sill and at the head. The vertical margin is calibrated on the Nyhavn fronts, where the bare band fit came out about 25 % short.
4. **Ground floor.** Each column bay below the ground-floor line is open or closed, from the deviation in the bay against the piers at that height. The engine's ground-floor kind (shop, residential: `js/groundfloor.js`) decides whether an open bay is a shopfront or a window. Real entrance doors (`js/entrances.js`) on a measured wall snap to the nearest bay centre within 0.9 m, and that bay is opened.
5. **Confidence** = observed share × comb contrast of the weaker axis × min(1, windows / 6) × (0.5 + 0.5 × cell fill), scaled by 1.4 and capped at 0.3 when the grid is implausible. A grid is implausible when the window width is outside 0.45 m to min(2.6 m, 0.92 × pitch), the window height is outside 0.8 m to min(3.2 m, 0.92 × storey), or it has fewer than 3 windows. Walls under 4 m tall or 2.5 m long, or with less than half of the strip observed, are not fitted. **Kept: confidence ≥ 0.6**. The cutoff was tuned on one hand-checked sample (seed 7) and checked on another (seed 11, below). Every other wall keeps the procedural guess.

About 0.12 s per wall on one core. The whole city ran locally (see Coverage), so no Cloud Run job was needed.

## The tile layer: `windows`

`data/tiles/<id>/windows.json`. It is a near-ring layer (`js/tile-rings.js RING_LAYERS.near`), so it ships in the tile's detail pack (`d/<hash>.pack`). `tools/hosting/build_packs.py` picks it up from the ring list, and `facade_layout.py index` adds it to `tiles/index.json`. An engine that does not know the layer never fetches it.

```jsonc
{
  "format": "cph-facade-layout/1",
  "tile": "1451_12352",
  "buildings": {
    "gdk:1202806702": {                  // the GeoDanmark id, as in appearance.json
      "0:19": {                          // "<ring>:<edge>" of the geodata record, as the atlas strips
        "u0": 0.49, "p": 1.91, "n": 5,   // columns centred at u0 + (c + 0.5) p, metres from the raw edge's start
        "w": 1.17,                       // window width (frame included)
        "cm": 31,                        // column mask: bit c = column c has windows on the upper storeys
        "g": 4.39, "f": 3.18, "rows": 3, // ground-floor height, storey pitch, upper storeys with windows (metres above the building's ground)
        "rm": 7,                         // rows that have windows (informational: the shader draws every row up to `rows`)
        "sill": 0.89, "head": 2.71,      // above each storey's floor
        "gm": 27,                        // ground-floor bay mask (absent: unknown, every bay open)
        "conf": 1.0
      }
    }
  }
}
```

A change that an older engine would misread gets a new format number. The engine ignores a payload whose `format` it does not know.

## Engine

- `js/tile-data.js` puts the layer on the building records (`observed.layout`, `js/facade-layout.js applyWindows`).
- `addBuilding` maps each layout onto its cleaned edge. It uses the raw edge's projection onto the cleaned edge, exactly as `texturedWalls` maps the photo strip, and mirrors the grid when the cleaned edge runs the other way. So the procedural windows sit where the photo's windows are, and the crossfade at 45 to 80 m lines up.
- **No new draw calls and no new vertex buffers.** WebGPU's baseline is 8 vertex buffers, and the wall mesh already uses all 8. Two attributes get wider instead:
  - `facadeTop`, from a float to a vec4: (top, grid start u0, sill/head word, rows/columns word).
  - `facadeUV`, from a vec2 to a vec4: (u, v, column mask bits 0 to 15, bits 16 to 31).
  - `facadeWindow.x` now packs the frame palette and the division type, which frees `.y` for the 16-bit ground-floor bay mask.

  Every packed word is an integer ≤ 65535, so it survives varying interpolation after rounding. The cost is 20 bytes more per wall vertex (4 per wall quad).
- `facadeCell` takes the measured grid on these walls: columns from u0 at the measured pitch (`facadeWall.w`), the measured storey and ground-floor heights (`facadeWall.y/z`), and the measured window width (`facadeTone.w`). The pre-war material puts the upper sill and head at the measured fractions of the storey. Blind columns, the wall outside the grid, storeys above the measured rows, and closed ground-floor bays are solid wall. Frames, reveals, glazing, interiors and night lights are the existing procedural ones. On walls without a layout the branch is a `mix` with weight 0: the same picture as before, for a few ALU ops more per fragment.
- The heuristic entrance bay and the plinth gap (`js/building-details.js plinthOutline`) use the measured columns.
- `?windows=0` leaves the layouts out (the "before" of a comparison).
- The photo material, the mid ring (tone-only walls), districts without atlases and buildings without a layout are unchanged.

## Accuracy

Measured with `tools/cph-geodata/facade_layout_check.py`.

**Nyhavn 9–17 against the photo-traced fronts** (`nyhavn`): 80 traced openings (81 without the one round window). An opening counts as found when it matches a drawn opening one to one at IoU ≥ 0.5 (or ≥ 0.3). The traced fronts come from street photos registered by hand. On two fronts they sit 0.5 to 1.1 m off the atlas: the cream front is traced 1.1 m higher and with taller storeys than the Skråfoto strip shows. So the table also gives the score after the best rigid shift of each traced front (within ±2 m). The engine draws the atlas frame, so for the crossfade the atlas is the reference.

| | precision@0.5 | recall@0.5 | precision@0.3 | recall@0.3 | mean IoU of matches |
|---|---|---|---|---|---|
| all 5 fronts, as traced | 0.43 | 0.43 | 0.61 | 0.61 | 0.58 |
| all 5 fronts, registered | 0.63 | 0.63 | 0.79 | 0.79 | 0.64 |
| the 4 kept fronts, as traced | 0.45 | 0.49 | 0.59 | 0.65 | |
| the 4 kept fronts, registered | 0.66 | 0.72 | 0.78 | 0.85 | |

The yellow (Nyhavn 13) and red (Nyhavn 17) fronts, where tracing and atlas agree, score 33 of 37 openings at IoU ≥ 0.5 and 35 of 37 at 0.3. Nyhavn 9 (blue, gabled, with parasols over the ground floor) gets confidence 0.41 and keeps the procedural facade. The rest of the IoU loss is mostly size: the traced openings include surrounds, and the ground-floor openings are drawn as whole bays.

**Hand check, 30 random walls** (`sheet`, walls at least 7 m tall and 6 m long, drawn at random across all tiles). The cutoff was tuned on seed 7, so the independent sample is seed 11:

- 8 walls kept. 7 of them have a plausible grid (88 %): the windows are on the photo's windows, with the right count, rows and spacing. Some cells are wrong, such as a blind bay drawn as a window or a top row on a cornice. The bad one (#23, a white modern front) draws 4 columns where the photo has windows in 2.
- 22 walls fall back. 17 of these are right to: balcony slabs and access galleries, gables without a window grid, walls hidden by trees, sky or roof, low walls. 4 are regular facades that the fit found but did not trust (confidence 0.23 to 0.54).
- So the decision is right on 24 of 30 walls (kept and plausible, or a correct fallback). Plausible grid rate among kept walls: 88 %.
- On the tuning sample (seed 7), 12 of 12 walls with confidence ≥ 0.6 were plausible. 4 implausible grids had confidence 0.46 to 0.59, which is where the cutoff comes from.

## Coverage and size

Whole city, all 465 tiles with appearance data: 482,832 atlas wall strips on 70,976 buildings.

| | |
|---|---|
| buildings with a layout | 20,818 (29 % of the buildings with an atlas) |
| walls with a layout | 59,398 (33 % of the photographed wall area) |
| windows drawn (rows × masked columns) | ~754,000 |
| layer files | 410 tiles, 8.0 MB JSON, 1.47 MB gzip'd (in the detail packs) |
| per building | 383 bytes JSON, 71 bytes gzip'd |

Of the 297,581 strips the extractor looks at (4 m tall and 2.5 m long or more), it leaves out those whose wall below the eave is under 5 m (91,425; mostly two-storey houses, sheds and annexes), those with too few windows (65,747; gables, party walls and blank backs), those with no grid that fits (26,918), and those less than half observed (7,296). Grids that fit but fall below the confidence cutoff are left out as well.

Run: about 0.12 s per wall. The whole city takes 41 min with 13 processes on a laptop shared with other jobs (`facade_layout.py run all --workers 13`; `--resume` picks up an interrupted run), so no Cloud Run job was needed. Cost: none beyond the local machine. Only the detail packs and the city pack changed (123 packs, 76 MB). The atlas and core packs are byte-identical, so an upload only adds those 123 packs.

## Shots, performance and requests

`tools/shoot-windows.py --data <bucket> --runs main,before,after --main-root <worktree of main>`. The stops are computed from the data: at each place, the nearest wall with a confident layout and a clear view. Each place gets a street shot from 15 to 27 m, a close-up from 9 to 12 m next to the atlas strip with the fitted grid drawn on it, and at Nyhavn a 60 m shot where the photo is fading in. The places are Frederiksberg Allé, Istedgade, Strøget, Østerbrogade/Trianglen, Nørrebrogade, Christianshavn and Nyhavn. Every run uses the personal R2 bucket, at 1600 × 900 with a headless WebGPU Chromium. `before` is `?windows=0`. `main` is main's client on the new manifest. The before | after pairs are in `docs/windows/pairs`, and the numbers are in `docs/windows/perf.json`.

| | main | before (`?windows=0`) | after |
|---|---|---|---|
| fps, Strøget street (median of three 5 s windows) | 32.4 | 32.6 | 41.6 |
| fps, Nyhavn street | 29.4 | 32.2 | 32.8 |
| draw calls, Strøget / Nyhavn | 2420 / 3111 | 2416 / 3116 | 2387 / 3115 |
| wall vertex attributes, Strøget | 133.9 MB | 160.6 MB | 160.6 MB |
| all vertex attributes, Strøget | 742.5 MB | 773.0 MB | 772.9 MB |
| console errors | none | none | none |

Headless frame pacing is quantised at 16.7 and 33.3 ms, and the machine was shared, so the fps differences are noise. The median frame is 33.3 ms in every run except one window at 16.7 ms. Draw calls and triangles do not change. Wall vertex buffers grow by 20 bytes per vertex: +27 MB at Strøget and +22 MB at Nyhavn, which is +4 % of all vertex attribute bytes. The texture budget is unchanged (no textures are added).

Requests per visit (`tools/hosting/measure_visit.py`, same bucket): 172 with this client and 170 with main's client. The windows layer rides in the detail packs a near tile already loads, so it adds no request. The difference comes from streaming order (one more detail pack and two atlas chunks fetched). Bytes: 191.4 and 191.5 MB.

## Known limits

- The shader draws a regular grid: one pitch and one window size per wall, and separable column and row masks. Per-column and per-row offsets, irregular facades, bay windows, and openings that differ by storey are not drawn. `rm` and the per-cell detail are fitted but not used.
- The ground floor is a bay mask on the upper grid. A shopfront that spans two bays, or a door between bays, is drawn per bay.
- At 10 to 13 cm per pixel a window is about 10 texels. Small attic windows, and windows behind trees or balconies, are missed. Balcony slabs and access galleries mostly fail the fit and keep the procedural facade, as intended.
- The column pitch can lock onto a harmonic (every second window) when the panes are faint. The confidence cutoff catches most of these cases, not all.
- A front whose window groups have different spacings (a centre bay plus outer pairs, as on Christianshavn's Overgaden) gets the strongest group. The rest of the wall is drawn blank, where the guessed grid used to fill it.
- Where the top of the strip is washed out or unobserved, the grid stops at the last row it saw. Some Nyhavn fronts lose their top storey of windows this way.
- +20 bytes per wall vertex (see above). Packing the frame width and reveal into one float would free a slot and let `facadeUV` go back to a vec2, which would halve the extra memory.
