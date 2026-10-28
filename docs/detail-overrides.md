# Detail overrides (`cph-detail/1`)

A detail override puts a hand-guided or semi-automatic building reconstruction in the place of the generated building, in the live twin. Nyhavn (PR #15, `tools/nyhavn`) is the first content. LiDAR dormers and chimneys are meant to use the same format later, through its parametric part. Measured window layouts went to their own tile layer instead (`windows`, docs/facade-layout.md): the facade shader draws them on the generated wall, which takes no geometry and no draw calls, so they do not need the detail-override mesh path.

Version: `cph-detail/1` (the tile layer) and `cph-detail-source/1` (a source set on disk). A change that an older engine would misread gets a new number. The engine ignores a layer whose `format` it does not know, and the tile keeps its generated buildings.

## Where it lives

```
source set (durable, outside git)        ~/.local/share/cph-twin/overrides/<set>/overrides.json + meshes/*.glb
                                         (written by a converter, e.g. tools/overrides/nyhavn.py)
packed data (published)                  <base>/d/<hash>.pack   the tile's `overrides` layer (a near-ring layer, so in the detail pack)
                                         <base>/x/<hash>.pack   the tile's override GLBs, cut into chunks of <= 2 MB (one HTTP Range each)
                                         tiles/index.json       lists `overrides` among the tile's layers (build_packs patches it)
unpacked data (local dev)                data/tiles/<id>/overrides.json, data/overrides/<set>/meshes/*.glb
                                         (tools/overrides/publish.py install / uninstall)
```

`tools/hosting/build_packs.py` reads every set under `~/.local/share/cph-twin/overrides` (or `--overrides DIR`, repeatable; `--no-overrides`), validates it (`tools/overrides/publish.py check`: files present, sizes and hashes match, GLB magic), and writes per tile the layer and the mesh pack. The manifest's tile row gets the mesh pack as its last slot (`manifest.overrides.meshSlot`), so `upload_packs.py` uploads it with the rest. A set that is unchanged keeps its pack names.

## The tile layer: `overrides`

```jsonc
{
  "format": "cph-detail/1",
  "tile": "1451_12352",
  "generated": "...",                         // the tile index this was made against
  "attribution": { "<key>": { "text": "...", "licence": "CC BY 4.0", "url": "..." } },
  "pack": {                                   // packed data only: where the GLBs are
    "file": "x/<hash>.pack", "size": 883025, "chunks": [[offset, length], ...],
    "entries": { "overrides/nyhavn/meshes/gdk_1064714861.glb": [chunk, offset, length, "gzip"|"identity", decoded size] }
  },
  "buildings": {
    "gdk:1064714861": {                       // keyed by the GeoDanmark id of the generated building it replaces
      "mode": "replace",                      // "replace": a mesh takes the building's place; "details": parametric details on the generated building
      "covers": ["gdk:1064714861"],           // generated buildings the mesh hides (always includes the key)
      "footprint": { "use": "gdk" },          // or { "use": "override", "ring": [x, z, ...], "holes": [[...]] }: see Mapping
      "match": { "kind": "1:1", "iou": 1.0, "hausdorff": 0.0 },
      "source": { "set": "nyhavn", "ids": ["kk:1064714861"], "kind": "kk-bygning", "reconstruction": "nyhavn-waterfront/3" },
      "confidence": "observed",               // observed (measured geometry or photo) | inferred
      "attribution": ["dhm-punktsky", "geodanmark", "skraafoto-2025", "street-2022"],
      "bounds": [x0, y0, z0, x1, y1, z1],     // local frame (x east, y up, z south; the tile index frame)
      "ground": -4.62, "low": -4.71, "sunk": 0.22,
      "mesh": {
        "path": "overrides/nyhavn/meshes/gdk_1064714861.glb",   // data-base relative
        "bytes": 61234, "sha256": "…16 hex", "triangles": 310,
        "textures": [[w, h], ...],
        "textureBytes": 349524,               // RGBA8 + full mip chain (js/facade-lod.js estimateTextureBytes): what the budget counts
        "gpuBytes": 7400                      // vertex + index buffers
      },
      "details": { ... }                      // optional, see Parametric details
    }
  }
}
```

### (a) The mesh

One GLB per building, already in the twin's local frame (no transform at load):

- **Geometry**: indexed triangles. `POSITION` uint16 normalized, padded to 8 bytes, dequantised by the node's translation (mesh minimum) and scale (mesh extent): about 1 mm over 60 m. `NORMAL` int8 normalized, padded to 4 bytes. `TEXCOORD_0` uint16 normalized for atlas UVs, float for tiling textures. `COLOR_0` uint16 normalized RGBA (linear). The padding is there because WebGPU vertex formats are 4-byte multiples. Extensions: `KHR_mesh_quantization` and `EXT_texture_webp`. Both are built into three's GLTFLoader, so no decoder is fetched. The pack stores the GLB gzip'd, and the client inflates it with DecompressionStream.
- **Textures**: webp. One atlas per building holds the roof crop and the facade photos baked over their paint tone. Tiling textures (procedural roof tiles, brick, paint) keep their own small textures. Every photo-derived pixel and colour goes through the twin's albedo mapping (gain 0.72, soft shoulder at 0.4 to 0.58, as `js/appearance.js albedoFromLinear` and the photo material do), so an override is lit like the buildings around it.
- **Draw calls**: one mesh per material, 1 to 5 per building: `photo` (atlas), `tiled-*`, `painted` and `glass` (vertex colours).
- **Extras**: the root node carries `building_id`, `source_ids`, `attribution` (keys), `licences`, `confidence` and `match`. Each mesh node carries `part`, `elements` (the source element names) and `conf`. Materials carry `attribution` and `conf`. `asset.extras` holds the frame and the attribution texts. Anyone who opens the GLB on its own sees where every part comes from.
- **Ground**: every vertex on the bottom of the building is moved to 0.25 m under the twin's lowest terrain along the footprint (`groundLow`, as the generated walls do). `sunk` records how far the source walls ended above that level.

### (b) Parametric details

Each value of v is in metres above the building record's `ground` (local frame), so a detail follows a re-compiled terrain. `edge` indexes the gdk outer ring: edge i runs from vertex i to i+1. u is in metres from vertex i along that edge.

```jsonc
"details": {
  "baked": true,                              // the mesh already carries them: drawn only when the mesh is not shown
  "openings": [{ "edge": 5, "u": [3.20, 4.29], "v": [10.5, 12.0], "kind": "window"|"door"|"shopfront"|"round", "id": "...", "conf": "inferred", "src": ["street-2022"] }],
  "cornices": [{ "edge": 5, "u": [0, 8.2], "v": 9.8, "height": 0.3, "depth": 0.18, "kind": "cornice"|"storey_band" }],
  "dormers":  [{ "edge": 19, "u": [1.09, 2.41], "base": [front v, rear v], "top": 14.1, "depth": 1.65, "kind": "roof-window" }],
  "chimneys": [{ "at": [x, z], "size": [w, d], "base": 11.2, "top": 13.9, "kind": "chimney"|"flue" }]
}
```

`js/detail-overrides.js detailGeometry` draws them in one vertex-coloured mesh per tile. An opening is a framed dark pane a few cm in front of the generated wall (the generated wall has no holes). A cornice is a box along the edge. A dormer is a box with a window face, set inward from the eave edge. A chimney is a box.

## Engine

- **Rings.** `overrides` is in `RING_LAYERS.near` only (js/tile-rings.js). A near tile builds its mesh overrides in place of the generated buildings they cover. A mid tile never loads them, and draws the generated building with its measured tones. The swap therefore happens with the near/mid rebuild that already swaps the photo walls. There is no popping inside the near ring, because a covered building is never built there.
- **Hiding.** A shown override's covered ids are left out of the build (`buildRealBuildings`), like a hero glTF. So their walls, roof, LoD2 record, photo atlas candidate and entrance doors never exist. Nothing is drawn under the override, so there is no z-fighting.
- **Budget.** `OVERRIDE.maxTextureBytes` is 32 MiB, `OVERRIDE.maxMeshes` is 400, and `maxDistance` is 900 m. One budget covers every tile (js/buildings-stream.js), filled nearest first when a tile builds. The budget is committed in `tools/perf/texture-memory-budget.json` and checked by the texture-memory-budget CI. An override the budget refuses keeps the generated building, plus its parametric details when it has any. An overridden building gives up its photo atlas, so the photo band frees about what the overrides take.
- **Loads.** Packed data uses one HTTP Range request per mesh chunk, shared and cached like the photo atlases (`js/data-packs.js createAtlasSource`, `bytes()`). Unpacked data uses `<data base>/<path>`. Loads run beside the generated build. A tile removed while its overrides load aborts them (`AbortController` per tile). A mesh that fails to load is extruded on its own, with its details.
- **Dispose.** The tile disposes its overrides with everything else: geometries, materials, textures and decoded bitmaps. The budget is released at the same time.
- **Colliders and walk space.** `overrideFootprints()` keeps the gdk footprints when an entry says `footprint.use: "gdk"`. With `"override"`, the entry's own ring takes the place of every building it covers, in the static colliders (near ring) and in the walk space (rebuilt when the tile changes ring).
- **Picking and info.** An override's group carries `userData.buildingId`. The info panel shows the gdk record plus a `Detail model` row (set, IoU, confidence) and the attribution keys with their licences.
- **Switches.** `?overrides=0` turns the layer off (the "before" of a comparison). `?overrides=details` draws only the parametric details on the generated buildings.

## Mapping (source footprints to gdk ids)

`tools/overrides/overrides_lib.py match_footprints` matches source footprints to the GeoDanmark buildings of the tiles by overlap. A source names a gdk id when it can (`gdk_hint`), and that id wins a near tie.

| case | rule | handling |
|---|---|---|
| 1:1 | one gdk building takes the source | keyed by it |
| many-to-one (`merge`) | several sources fall on one gdk building | their meshes are joined into one override keyed by the gdk id |
| one-to-many (`split`) | one source covers several gdk buildings (>= 50 % of each) | keyed by the one it overlaps most; `covers` hides all of them |
| unmatched | no gdk building takes 20 % of the source | not published; the generated city stays |

`footprint.use` is `"gdk"` when IoU >= 0.85 and Hausdorff distance <= 1 m. Otherwise it is `"override"`, with the union of the source rings. Known limit: a `covers` id owned by a neighbouring tile is not hidden by this tile's build. A converter should key such a case by the id in the tile that owns the most of it. No Nyhavn case needs this.

**Nyhavn** (`mapping-report.json` next to the set): the KK `bygning` objects carry the GeoDanmark id (`fot_id`) and geometry. All 116 match 1:1, with IoU 1.000 (min, median and max) and Hausdorff distance 0.00 m. No merge, split or unmatched case. Colliders and walk space keep the gdk footprints.

What is published is a quality call (`tools/overrides/nyhavn.py --select`, default `traced`):

- **traced (published): 5 buildings**, Nyhavn 9, 11, 13, 15 and 17 on tile 1451_12352. Their fronts and roofs are photo-traced: 81 openings, 9 cornices and bands, 12 roof windows and 5 chimneys. They are clearly better than the generated buildings (`docs/overrides/pairs`).
- **photo / all (not published): 92 more Roofer-fitted buildings.** These were converted, packed and looked at in local runs. They do not beat the generated building. Their roofs are the same Roofer fit as the twin's LoD2. Their facades are the same Skråfoto 2025 source as the twin's atlases, but without its procedural windows close up and without the facade shader's shading. 54 of their wall edges have a photo, and the rest are untextured shells. In practice they read flat and pale, at street level and from the air, and with all 97 the canal stop gained about 340 draw calls (1 to 5 meshes each) for no visual gain.
- **19 inferred fallback envelopes (skipped).** These are a KK footprint extruded to a DSM height with a flat cap. The twin's generated building, with its own LoD2 roof and Skråfoto atlas, is at least as good.

## Licences: what Nyhavn publishes and what it leaves out

| source | used for | licence | published |
|---|---|---|---|
| DHM Punktsky 2019 (Klimadatastyrelsen), Roofer fit | roofs and walls | CC BY 4.0 | yes |
| Skråfoto 2025 (SDFI) | roof crops, facade photos | CC BY 4.0 terms for free geographic data | yes, credited |
| GeoDanmark Bygning (via KK `bygning`, same objects) | footprints | CC BY 4.0 | yes |
| Jenny Andersson / News Øresund, 2022 (Commons) | Nyhavn 9–17 opening, chimney and colour tracing | CC BY 2.0 | yes, credited |
| Liberaler Humanist, 2018 (Commons) | Nyhavn 11–17 roof window, cornice and opening dimensions | CC BY-SA 3.0 | measurements and sampled colours only, credited as a reference |
| same 2018 photo | storefront lettering textures (HEERING, NYHAVN 17): pixel crops | CC BY-SA 3.0 | **no**: the share-alike licence would bind the texture |
| DHM terrain, OSM water, quay faces (with the 2022 timber texture), paving, parasols | context | various | **no**: the twin has its own ground, water and quay |

## Making a set

```sh
python3 tools/overrides/nyhavn.py            # ~/.local/share/building-case-3d/nyhavn -> ~/.local/share/cph-twin/overrides/nyhavn
python3 tools/overrides/publish.py check
python3 tools/overrides/publish.py install   # optional: local unpacked ./data
python3 tools/hosting/build_packs.py --offline --out .context/packs/<v>
python3 tools/hosting/upload_packs.py --dir .context/packs/<v>   # personal account, manifest last
uv run --with playwright --with pillow python tools/shoot-overrides.py --data <base>   # before / after shots, fps, memory
```

A converter for other content writes the same `overrides.json`. Each entry needs `tile` (the tile that owns the gdk building), `mode`, `covers`, `footprint`, `bounds`, `attribution` and `mesh` and/or `details`. It also writes one GLB per mesh, in the twin frame and with the encoding above (`tools/overrides/overrides_lib.py GlbWriter`).
