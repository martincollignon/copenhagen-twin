# Nyhavn facade source upgrade

`facade_sources.py` builds rectified, source-attributed façade textures for the Nyhavn waterfront. It uses a manually calibrated licensed street photo for Nyhavn 9–17 and native calibrated Skråfoto crops for both waterfront rows. Native textures are sampled from the camera images at their delivered resolution, then masked by the Roofer wall/roof triangle visibility buffer. Unseen pixels remain transparent; the script does not copy texture from adjacent buildings.

## Inputs

The durable project is `~/.local/share/building-case-3d/nyhavn/`. It must contain:

- `model/building.json`
- `model-v2/roofer-roofs.json`
- `sources/street-reference/nyhavn-9-17-2022.jpg` and `sources.json`
- `sources/skraafoto-native/cameras.json` and the corresponding native crop JPEGs

The Skråfoto files are fetched separately through the authorized ADC helper; this rectification script reads the saved crops and camera records and never reads or writes a token.

## Rebuild

From the workspace:

```sh
uv run --script tools/nyhavn/facade_sources.py street
uv run --script tools/nyhavn/facade_sources.py fetch
```

`fetch --initial` rebuilds only the five Nyhavn 9–17 aerial alternates. The full `fetch` rebuilds both address rows and replaces the façade list in the manifest with the currently selected canal-front corridor. Old, unreferenced texture files are left in place.

The same commands work after the workspace is archived using the durable self-contained copy:

```sh
uv run --script ~/.local/share/building-case-3d/nyhavn/scripts/facade_sources.py street
uv run --script ~/.local/share/building-case-3d/nyhavn/scripts/facade_sources.py fetch
```

That copy uses the vendored `scripts/vendor/appearance.py` and `polytri.py`; the Python dependencies are declared in the script header for `uv run --script`.

## Outputs

- `facade-v2/manifest.json` — per-edge coordinates, absolute DVR90 texture extents, source type/camera, crop metadata, confidence, visibility and attribution.
- `facade-v2/street/` and `facade-v2/native/` — RGBA metric rectifications.
- `facade-v2/contact-sheet-hero-street.png` and `contact-sheet-native-rows.png` — visual source review.
- `facade-v2/report.json` — image size/alpha and footprint-edge consistency checks.

The native imagery attribution is: “Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur, Skråfoto 2025.” The hero street image is credited per `sources/street-reference/sources.json` (Jenny Andersson / News Øresund, CC BY 2.0). The street homography and masks are manual, and the rectified aerial resolution varies by view; both limits are recorded in the manifest.
