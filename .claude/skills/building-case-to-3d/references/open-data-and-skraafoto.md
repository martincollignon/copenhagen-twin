# Open data and Skråfoto

All sources below are Danish open data under CC BY 4.0-style terms. Credit them in the delivered README:

> Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur, <dataset>, <date>.

BBR and GeoDanmark need their own attribution lines. In the sibling dk-building-data repo (`~/conductor/dk-building-data`), the Go fetchers (`internal/fetcher/sources/{bbr,bygninger,dhmterrain,lidar,skraafoto}`) and `cmd/twinviz` already implement most of these lookups. Reuse them (or their endpoints) rather than re-deriving. In this repo, `tools/cph-geodata/` already fetches GeoDanmark/BBR (via KK WFS), DHM DSM/DTM (WCS) and 2025 Skråfoto (`skraafoto_prefetch.py`) for the twin district.

## Footprint, register, terrain

| Need | Source | How |
|---|---|---|
| Footprint (roof outline at eaves) | GeoDanmark `gdk60:Bygning` (WFS, EPSG:25832) | `internal/fetcher/sources/bygninger`, or a WFS bbox query. Match to the address through the BBR building UUID, not the nearest centroid. Courtyard blocks have many touching footprints; on NS37 the nearest large footprint was a 1929 assembly hall on another property. The address lookup (Adressevælger) reads `ADRESSEVAELGER_TOKEN`, falling back to `GSEARCH_TOKEN`. |
| Storeys, year, areas, wall/roof material, use | BBR (`byg054AntalEtager`, `byg026Opførelsesår`, `byg041BebyggetAreal`, `byg038SamletBygningsareal`, `byg032YdervæggensMateriale`, `byg033Tagdækningsmateriale`, `byg021BygningensAnvendelse`, `byg070Fredning`) | `internal/fetcher/sources/bbr` (codes decoded in `bbr/codes.go`). BBR storeys usually exclude basements and sometimes attic storeys. Treat it as a consistency check, not ground truth. |
| Terrain height (DVR90) | DHM/Terræn 0.4 m | `internal/fetcher/sources/dhmterrain` or the point-elevation service. |
| Roof heights / LoD2 | DHM/Overflade 0.4 m; Punktsky LAZ | `twinviz` builds roofer LoD2.2 from Punktsky. The DSM minus terrain gives eave and ridge heights per facade. `internal/fetcher/sources/lidar/cmd/heightmap` needs `-timeout 5m`, because its 3-minute default timed out on the LAZ download. |
| Heritage value | FBB/SAVE | `internal/fetcher/sources/fbb`. Useful context for which facade elements are original. |

## Skråfoto STAC (verified 2026-10-10)

- **Endpoint:** `https://api.dataforsyningen.dk/rest/skraafoto_api/v2`, authenticated with the `token: <SKRAAFOTO_STAC_TOKEN>` request header.
  - A token value carrying trailing whitespace or an inline comment from `.env` has produced 401s and leaked into URL error messages. Sanitise it.
- **Collections:** `skraafotos2017`, `skraafotos2019`, `skraafotos2021`, `skraafotos2023` and `skraafotos2025`, flown in spring/summer of odd years. Over Nørre Søgade 37 each collection returned 24–66 items covering `north`, `south`, `east`, `west` and `nadir`.
- **Search:** `GET /collections/<id>/items?bbox=<lon1,lat1,lon2,lat2>&limit=200`.
  - Footprint polygons are large, so filter to images whose projected building actually falls inside the frame, away from the edge.
  - Prefer the view whose look direction is closest to the facade normal.
- **Image:** `assets.data.href` points at a tiled (512 px) JPEG-compressed Cloud Optimized GeoTIFF on `skraafoto-cdn.dataforsyningen.dk`, about 14k × 10.5k px with overviews 2, 4 and 8.
  - Read only the needed window (GDAL `/vsicurl/` with `GDAL_HTTP_HEADERS="token: …"`). A 512 px window took about 11 s cold.
  - The file is not georeferenced. All geometry comes from the camera record.
- **Camera record** (`properties`):
  - `pers:perspective_center` [X, Y, Z] in EPSG:25832 / DVR90 (`pers:crs` 25832, `pers:vertical_crs` 5799);
  - `pers:omega`, `pers:phi`, `pers:kappa` in degrees, plus `pers:rotation_matrix`;
  - `pers:interior_orientation`: `focal_length` (mm), `pixel_spacing` (mm), `principal_point_offset` (mm), `sensor_array_dimensions` (px);
  - `gsd`, `datetime`, `direction`.
  - Store these verbatim per view in `cameras.json`.

### Projection (world → pixel)

Port of `internal/fetcher/sources/skraafoto/projection.go`, which follows the SAUL convention from `@dataforsyningen/saul`. With ω, φ, κ in radians:

```text
D11= cosφ cosκ              D12=-cosφ sinκ              D13= sinφ
D21= cosω sinκ+sinω sinφ cosκ  D22= cosω cosκ−sinω sinφ sinκ  D23=−sinω cosφ
D31= sinω sinκ−cosω sinφ cosκ  D32= sinω cosκ+cosω sinφ sinκ  D33= cosω cosφ
c = −focal; dimX = −(W·pix)/2; dimY = −(H·pix)/2       (W,H = sensor_array_dimensions)
dX,dY,dZ = P − perspective_center
den = D13 dX + D23 dY + D33 dZ
x' = −c (D11 dX + D21 dY + D31 dZ)/den ;  y' = −c (D12 dX + D22 dY + D32 dZ)/den
col = −((x' − ppx) + dimX)/pix ;  row = H − (−((y' − ppy) + dimY)/pix)
```

Check the projection against `projection_test.go` and on a known corner (a footprint vertex at terrain height must land on the building's ground corner in every view) before trusting any overlay.

A 3D model rendered with a pinhole camera matches this projection. In three.js:

- Set the camera position to the perspective centre (in the model's local frame).
- Set the orientation from the rotation matrix. The camera looks along −Z of the photogrammetric frame. Verify by checking that the projected corners agree with `overlay.py`.
- Vertical FOV = `2·atan((H·pix/2)/focal)`.
- Apply the principal-point offset as a view offset.

Use the full-frame aspect ratio, then crop identically to the photo crop.

## Choosing views

- For each facade, keep the oblique whose direction faces it, from the latest collection.
- Keep one or two earlier collections to detect recent alterations. A facade element that appears between 2017 and 2025 is an as-built change.
- The nadir view checks the roof outline, terraces and courtyard features.
- Record occlusions (street trees, scaffolding, neighbouring blocks) per view instead of forcing a fit.
