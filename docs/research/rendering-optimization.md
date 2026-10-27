# Rendering measurements, 26 October 2026

The changes retain the city geometry, facade LOD policy, materials, reflection settings, antialiasing, and 3072-pixel shadow cascades. They reduce rendering overhead in two places:

- Static building cells share three material batches. Each cell still has its own frustum and streaming visibility, and picking ranges retain their building and roof-detail identity. Source geometry is released after packing, before GPU upload.
- WebGPU sun cascades allocate their original depth texture without the unused colour texture. Removing the 6144 × 3072 RGBA8 attachment saves 72 MiB. WebGL retains the upstream sun-light implementation.

The renderer is pinned to Three.js build `6828c9b2559167925fa90c6c84dfc1a657b38d2c`, matching the WebGPU build previously served by the moving `@dev` URL.

## Comparison

Two interleaved baseline/candidate pairs ran in headless Chromium on the same M3 Max at 1440 × 900, pixel ratio 1, with vsync disabled. Both snapshots used the same renderer commit and city assets. Texture residency was allowed to settle before each window. Concurrent GoBoat edits were excluded from both snapshots.

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Lake-view texture allocation estimate, including MSAA backing | 373.75 MiB | 301.78 MiB |
| Lake-view median frame time, paired runs | 15.6 / 16.4 ms | 13.3 / 14.7 ms |
| Lake-view p95 frame time, paired runs | 33.4 / 33.9 ms | 14.9 / 16.6 ms |
| Aerial median frame time, paired runs | 16.4 / 20.9 ms | 15.6 / 20.3 ms |
| Street median frame time, paired runs | 14.2 / 15.3 ms | 12.9 / 15.6 ms |

Texture estimates were calculated from live WebGPU texture descriptors, dimensions, formats, mip counts and sample counts. They are allocation estimates, not measurements of physical GPU memory. Three's own `renderer.info.memory.texturesSize` omits separate multisampled colour backing textures in this build.

Timing remains sensitive to other work on this machine. The lake-view improvement repeated; aerial and street results do not establish reliable 60 FPS across the scene. These two pairs are diagnostic measurements, not a statistical performance guarantee.

## Verification

- All 354 Node tests passed on the isolated candidate snapshot.
- All 108 building-picking probes matched the baseline in each comparison pair, including surface classification.
- Both candidate comparison runs completed without JavaScript or GPU validation errors. The WebGL fallback also booted and rendered without console errors.
- `uv run --with playwright python tools/shoot-m2.py --perf` completed its four views and 14-point live memory route. Peak facade reservation was 50,329,968 bytes against the unchanged 50,331,648-byte budget, with the facade manager enabled throughout.
- `--perf` now fails on captured page/rendering errors and disabled facade loading. Its error classifier rejected the captured invalid-pipeline experiment, including errors that did not appear as JavaScript page exceptions.

The required `texture-memory-budget` check also runs the building-batch picking/visibility, sun-depth preservation, lighting and module-loading tests. Real GPU timing remains a local measurement.
