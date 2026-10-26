# Dronning Louises Bro validation

26 October 2026. The model is implemented; **GPU screenshot validation remains blocked**.

## Executed checks

- `node --test tests/*.cjs tests/*.mjs`: 219 passed, no failures.
- Three.js 187dev scene construction using the same CDN build as the application's import map: passed; 15 mesh batches. `scene-check.json` records dimensions, bounds, eight night lights and day switching. This is a CPU-side check, not a rendered image.
- Three horizontal rays through the arch centres: no stone intersections. Upward rays hit each vaulted intrados at the expected local height, about 0.74 m.
- Geometry tests cover finite positions/indices, outward face winding, bounds, three arch spans, parapet coping height, continuous water, default soffit restoration, and replacement of all eight generic heritage lamps without mutating source data.
- Design scan: `index.html` retains two existing warnings, `overused-font` (Inter: choose a more distinctive face) and `single-font` (pair a display face with a body face). Only module preloads changed in that file. The bridge JS scans reported no findings.

## Browser attempt

Executed:

```sh
UV_CACHE_DIR=/tmp/dlb-uv-cache uv run --with playwright python tools/shoot-dlb.py
```

The harness starts `python http.server` on a free 127.0.0.1 port and launches headless Chromium with `--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist`. Chromium exits before navigation: macOS sandbox denies `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer` (permission denied 1100). `verification.json` contains the actual failed attempt. A Chrome DevTools tool fallback also rejected opening the local URL because the session's approval policy was `never`.

**No screenshots were produced, and no rendered comparison is claimed.** Run the command in an environment that permits Chromium startup to capture the path day/night, deck, aerial, lamp closeup, frontal arches and disabled fallback views. The harness exits nonzero on browser errors, missing lamps, failed night switching or missing fallback soffit.

## Reference-led revisions completed in code

The source photographs were inspected directly. The first model was revised to retain the long solid causeway with three small central openings; replace generic poles with brown fluted shafts, ornamental bases, green curved cage ribs, spherical glass and finials; keep the ribs outside the glass; use radial voussoir joints rather than horizontal block joints on the arch rings; fit benches to the draped pavement; and curve the four stone-faced approaches towards the shore paths. Recorded Citelum lamp positions determine the central arch bay spacing.

Remaining visual uncertainty: ornate heraldic sculpture is simplified, ramp paths are inferred rather than surveyed, and the procedural stone colour, lamp scale, connection of ramp landings to the shoreline, and near-view gaps need the unavailable rendered comparison. See [the source and confidence notes](../../research/dronning-louises-bro.md).

## Commit limitation

Staging the explicit task files failed because this workspace's Git metadata is read-only to the session: `Unable to create .../cph-twin/.git/worktrees/cph-twin-dlb-bridge/index.lock: Operation not permitted`. No commit was created and nothing was pushed. The current branch remains `dlb-bridge`; unrelated untracked `data/raw` and `data/tex` were not touched. Once Git writes are permitted, the intended commit message is:

```text
Model Dronning Louises Bro from heritage sources and mapped geometry

Co-Authored-By: Codex (gpt-6-astra) <noreply@openai.com>
```
