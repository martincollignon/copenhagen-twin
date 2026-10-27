#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "pyproj", "scipy"]
# ///
"""Build source-attributed facade textures for the Nyhavn waterfront model.

Run with `uv run --script tools/nyhavn/facade_sources.py street` for the high-detail
Nyhavn 9–17 reference rectifications, then `... fetch` for native Skråfoto images and
camera-rectified textures across both canal-facing rows.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve()
WORKSPACE = HERE.parents[2]
OUT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
MODEL = OUT / "model/building.json"
ROOFER = OUT / "model-v2/roofer-roofs.json"
BASE = OUT / "facade-v2"
STREET = OUT / "sources/street-reference"
STREET_DIR = BASE / "street"
NATIVE_SOURCES = OUT / "sources/skraafoto-native"
NATIVE_DIR = BASE / "native"

# The 2022 Commons photo shows the five iconic canal-side elevations. Coordinates are
# in the 4032 × 3024 source image, ordered top-left, top-right, bottom-right, bottom-left.
# The main vertical wall is traced; roof slopes and the gable are handled by roof geometry.
STREET_QUADS = {
    "kk:1064714861": {"edge": 5, "label": "Nyhavn 9", "quad": [(450, 1390), (1270, 1430), (1270, 2220), (440, 2240)], "gable_peak_xy": (850, 720),
                       "silhouette": [(440,2240),(450,1390),(565,1390),(560,1150),(850,720),(1120,1230),(1110,1270),(1270,1300),(1270,2220)]},
    "kk:1202806702": {"edge": 20, "label": "Nyhavn 11 (KK: Store Strandstræde 10)", "quad": [(1280, 810), (2040, 950), (2035, 2180), (1270, 2220)]},
    "kk:1111146131": {"edge": 3, "label": "Nyhavn 13", "quad": [(2040, 1000), (2530, 1100), (2530, 2160), (2035, 2180)]},
    "kk:1064715124": {"edge": 12, "label": "Nyhavn 15", "quad": [(2530, 1360), (2920, 1408), (2925, 2160), (2530, 2160)]},
    "kk:1088186424": {"edge": 15, "label": "Nyhavn 17", "quad": [(2920, 1408), (3390, 1450), (3395, 2160), (2925, 2160)]},
}

# Conservative source-space masks: flag strings, parasols, and the quay crowd are not facade.
STREET_OCCLUSIONS = [
    # The blue gable's street-level awnings project over the wall plane.
    [(620, 1850), (730, 1840), (740, 1970), (610, 1975)],
    [(790, 1840), (900, 1830), (910, 1970), (780, 1980)],
    [(960, 1830), (1080, 1825), (1090, 1980), (950, 1985)],
    # Five hand-traced parasol/canopy envelopes; only their overlap is transparent.
    [(1450, 1900), (1700, 1800), (1970, 1885), (2010, 2025), (1450, 2030)],
    [(1770, 1950), (2100, 1810), (2380, 1900), (2420, 2040), (1770, 2050)],
    [(2180, 1910), (2520, 1800), (2810, 1915), (2830, 2055), (2180, 2050)],
    [(2570, 1940), (2910, 1815), (3200, 1920), (3230, 2060), (2570, 2060)],
    [(2960, 1940), (3310, 1825), (3670, 1940), (3700, 2070), (2960, 2070)],
    # The quay crowd and boats are below the footprint base.
    [(0, 2100), (4032, 2100), (4032, 3024), (0, 3024)],
]
def source_homography(quad: list[tuple[float, float]], w: int, h: int) -> tuple[float, ...]:
    """PIL perspective coefficients mapping output pixels back to the source quad."""
    dst = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    rows, vals = [], []
    for (x, y), (u, v) in zip(dst, quad):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); vals.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y]); vals.append(v)
    return tuple(np.linalg.solve(np.asarray(rows), np.asarray(vals)).tolist())


def world_to_source_homography(world: list[tuple[float, float]], image: list[tuple[float, float]]) -> np.ndarray:
    """Solve the projective map from local facade (u,z) coordinates to source pixels."""
    rows, vals = [], []
    for (u, z), (x, y) in zip(world, image):
        rows.append([u, z, 1, 0, 0, 0, -x * u, -x * z]); vals.append(x)
        rows.append([0, 0, 0, u, z, 1, -y * u, -y * z]); vals.append(y)
    h = np.linalg.solve(np.asarray(rows, dtype=np.float64), np.asarray(vals, dtype=np.float64))
    return np.array([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]])


def sample_projective(source: Image.Image, alpha_source: Image.Image, H: np.ndarray,
                      U: np.ndarray, Z: np.ndarray) -> tuple[Image.Image, Image.Image]:
    """Bilinear RGB and nearest alpha samples from source coordinates given wall (u,z)."""
    pts = np.stack([U.ravel(), Z.ravel(), np.ones(U.size)], axis=0)
    q = H @ pts
    sx = (q[0] / q[2]).reshape(U.shape)
    sy = (q[1] / q[2]).reshape(U.shape)
    arr = np.asarray(source, dtype=np.float32)
    mask = np.asarray(alpha_source, dtype=np.uint8)
    h, w = mask.shape
    inside = (sx >= 0) & (sx < w - 1) & (sy >= 0) & (sy < h - 1)
    x0 = np.clip(np.floor(sx).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(sy).astype(int), 0, h - 2)
    fx = (sx - x0)[..., None]
    fy = (sy - y0)[..., None]
    rgb = (arr[y0, x0] * (1 - fx) * (1 - fy) + arr[y0, x0 + 1] * fx * (1 - fy)
           + arr[y0 + 1, x0] * (1 - fx) * fy + arr[y0 + 1, x0 + 1] * fx * fy)
    am = mask[np.clip(np.rint(sy).astype(int), 0, h - 1), np.clip(np.rint(sx).astype(int), 0, w - 1)]
    am[~inside] = 0
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB"), Image.fromarray(am, "L")


def edge_record(building: dict, edge: int) -> dict:
    ring = building["wall_rings"][0]
    points = ring["vertices_epsg25832"]
    tops = ring["eave_boundary_dvr90"]
    a, b = points[edge], points[(edge + 1) % len(points)]
    za, zb = float(tops[edge]), float(tops[(edge + 1) % len(points)])
    ground = float(building["ground_dvr90"])
    zmax = max(za, zb)
    source = "v1 DHM edge estimate"
    if ROOFER.exists():
        all_roofs = json.loads(ROOFER.read_text()).get("buildings", {})
        rr = all_roofs.get(str(building.get("kk_fot_id")))
        if rr and rr.get("vertices_epsg25832_dvr90"):
            roof_points = np.asarray(rr["vertices_epsg25832_dvr90"], dtype=np.float64)
            delta = np.asarray(b, dtype=np.float64) - np.asarray(a, dtype=np.float64)
            length2 = float(delta @ delta)
            t = ((roof_points[:, :2] - a) @ delta) / length2
            nearest = np.asarray(a) + t[:, None] * delta
            dist = np.linalg.norm(roof_points[:, :2] - nearest, axis=1)
            on_front_wall = (dist <= 0.18) & (t >= -0.015) & (t <= 1.015)
            wall_z = roof_points[on_front_wall, 2]
            if len(wall_z) >= 4:
                ground = float(np.quantile(wall_z, 0.03))
                zmax = float(wall_z.max())
                edge_eaves = rr.get("eave_by_ring_edge_dvr90", [[]])[0]
                if (edge < len(edge_eaves) and edge_eaves[edge] and len(edge_eaves[edge]) == 2
                        and all(x is not None for x in edge_eaves[edge])):
                    za, zb = map(float, edge_eaves[edge])
                else:
                    za = zb = zmax
                source = f"DHM Punktsky Roofer WallSurface vertices; {rr.get('conf', 'unknown')}"
    length = math.dist(a, b)
    return {"coordinates": {"start": a, "end": b}, "ground_dvr90": ground,
            "top_edge_dvr90": [za, zb], "z_min": ground, "z_max": zmax,
            "height_m": max(0.25, zmax - ground), "length_m": length,
            "wall_extent_source": source}


def rectify_street() -> dict:
    """Rectify street-source quads with manual planar homographies and explicit masks."""
    source_path = STREET / "nyhavn-9-17-2022.jpg"
    meta_path = STREET / "sources.json"
    if not source_path.exists() or not meta_path.exists():
        raise FileNotFoundError(f"licensed reference photo or metadata missing in {STREET}")
    source = Image.open(source_path).convert("RGB")
    if source.size != (4032, 3024):
        raise ValueError(f"expected the reviewed 4032×3024 source, got {source.size}")
    buildings = {b["id"]: b for b in json.loads(MODEL.read_text())["buildings"]}
    STREET_DIR.mkdir(parents=True, exist_ok=True)
    src_mask = Image.new("L", source.size, 0)
    draw = ImageDraw.Draw(src_mask)
    for item in STREET_QUADS.values():
        draw.polygon(item.get("silhouette", item["quad"]), fill=255)
    draw = ImageDraw.Draw(src_mask)
    for polygon in STREET_OCCLUSIONS:
        draw.polygon(polygon, fill=0)

    records, sheet_items = [], []
    for bid, item in STREET_QUADS.items():
        b = buildings[bid]
        edge = int(item["edge"])
        e = edge_record(b, edge)
        ring = np.asarray(b["wall_rings"][0]["vertices_epsg25832"], dtype=np.float64)
        a_xy = np.asarray(e["coordinates"]["start"], dtype=np.float64)
        b_xy = np.asarray(e["coordinates"]["end"], dtype=np.float64)
        d_xy = b_xy - a_xy
        edge_len = float(np.linalg.norm(d_xy))
        n_xy = np.array([d_xy[1], -d_xy[0]], dtype=np.float64) / edge_len
        midpoint = (a_xy + b_xy) * 0.5
        if float(np.dot(n_xy, midpoint - ring.mean(axis=0))) < 0:
            n_xy *= -1
        quad = item["quad"]
        src_w = (math.dist(quad[0], quad[1]) + math.dist(quad[3], quad[2])) / 2
        src_h = (math.dist(quad[0], quad[3]) + math.dist(quad[1], quad[2])) / 2
        # The traced street crop reaches the facade foot. Align it to the Roofer
        # ground estimate; do not derive a vertical crop offset from register storeys.
        z0 = e["ground_dvr90"]
        z1 = e["z_max"]
        # Preserve source detail while avoiding extreme upscale on the narrow gable frontage.
        if "gable_peak_xy" in item:
            # Calibrate on the lower wall rectangle, then extrapolate upward within the
            # hand-traced gable silhouette so upper Nyhavn 9 windows remain recognizable.
            # Project the traced gable peak back through the lower-wall homography.
            # Its normalized v position anchors the metric extension to the Roofer
            # front-wall maximum rather than extending a guessed storey fraction.
            Hinv = world_to_source_homography(
                quad, [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)])
            peak = np.asarray([*item["gable_peak_xy"], 1.0], dtype=np.float64)
            peak_v = float((Hinv @ peak)[1] / (Hinv @ peak)[2])
            Hcal = (e["z_max"] - z0) / peak_v
            za_cal = z0 + Hcal
            zb_cal = z0 + Hcal
            ppu = min(90.0, max(35.0, math.sqrt(src_w * src_h / (e["length_m"] * Hcal))))
            Hfull = z1 - z0
            w = max(128, int(round(e["length_m"] * ppu)))
            h = max(128, int(round(Hfull * ppu)))
            Hmap = world_to_source_homography(
                [(0.0, za_cal), (e["length_m"], zb_cal),
                 (e["length_m"], z0), (0.0, z0)], quad)
            uu = (np.arange(w, dtype=np.float64) + 0.5) / w * e["length_m"]
            vv = 1.0 - (np.arange(h, dtype=np.float64) + 0.5) / h
            # A rectangular metric atlas is bounded by the highest observed WallSurface.
            # Its alpha is clipped by the hand-traced photo silhouette, so the blue gable
            # tip and round upper window remain in their true extra height above the eave.
            Z = np.broadcast_to(z0 + vv[:, None] * Hfull, (h, w))
            U = np.broadcast_to(uu[None, :], (h, w))
            rgb, alpha = sample_projective(source, src_mask, Hmap, U, Z)
            v0 = (z0 - e["ground_dvr90"]) / (e["z_max"] - e["ground_dvr90"])
            v1 = 1.0
        else:
            za, zb = map(float, e["top_edge_dvr90"])
            if bid == "kk:1202806702":
                # The 2022 source clearly shows Nyhavn 11's horizontal cornice.
                # Register that manual photo trace to the lower Roofer wall-top
                # endpoint; the 2025 native image remains available above it up to
                # the full model maximum (which includes the higher roof/dormer band).
                za = zb = min(za, zb)
            Hcal = max(0.25, (za + zb) * 0.5 - z0)
            ppu = min(90.0, max(35.0, math.sqrt(src_w * src_h / (e["length_m"] * Hcal))))
            w = max(128, int(round(e["length_m"] * ppu)))
            h = max(128, int(round((z1 - z0) * ppu)))
            Hmap = world_to_source_homography(
                [(0.0, za), (e["length_m"], zb), (e["length_m"], z0), (0.0, z0)], quad)
            uu = (np.arange(w, dtype=np.float64) + 0.5) / w * e["length_m"]
            vv = 1.0 - (np.arange(h, dtype=np.float64) + 0.5) / h
            Z = np.broadcast_to(z0 + vv[:, None] * (z1 - z0), (h, w))
            U = np.broadcast_to(uu[None, :], (h, w))
            rgb, alpha = sample_projective(source, src_mask, Hmap, U, Z)
            top_line = za + (zb - za) * uu / e["length_m"]
            alpha_array = np.asarray(alpha, dtype=np.uint8).copy()
            alpha_array[Z > top_line[None, :]] = 0
            alpha = Image.fromarray(alpha_array, "L")
            v0 = (z0 - e["ground_dvr90"]) / (e["z_max"] - e["ground_dvr90"])
            v1 = 1.0
        image_name = f"{bid.replace(':', '_')}_edge{edge:02d}_street2022.png"
        image_path = STREET_DIR / image_name
        rgb.putalpha(alpha)
        rgb.save(image_path, optimize=True)
        record = {
            "building_id": bid, "edge": edge, "ring_edge_number": edge + 1,
            "label": item["label"], **e,
            "coordinates": {"start": e["coordinates"]["start"], "end": e["coordinates"]["end"]},
            "world_extent_m": [0.0, e["length_m"], e["ground_dvr90"], e["z_max"]],
            "image": {"path": f"street/{image_name}", "width_px": w, "height_px": h,
                      "orientation": "u=start→end; v=top→bottom",
                      "world_extent_m": [0.0, e["length_m"], z0, z1],
                      "top_edge_dvr90": ([za, zb] if bid == "kk:1202806702" else e["top_edge_dvr90"]),
                      "vertical_fraction_of_model_wall": [v0, v1],
                      "lower_crop_offset_above_ground_m": 0.0,
                      "vertical_registration": ({
                          "basis": "manual source-photo cornice trace registered to the lower Roofer wall-top endpoint; source crop foot aligned to estimated wall ground",
                          "cornice_dvr90": round(za, 3),
                          "confidence": "inferred_manual_image_registration; not survey measured",
                          "upper_native_backfill_dvr90": round(e["z_max"], 3),
                      } if bid == "kk:1202806702" else {
                          "basis": "manual source-photo facade bounds registered to Roofer wall-edge profile and estimated wall ground",
                          "confidence": "inferred_manual_image_registration; not survey measured",
                      }),
                      "extent_confidence": "moderate; manually traced 2022 facade crop registered to estimated wall ground",
                      "meters_per_pixel": round(1 / ppu, 4),
                      "source_type": "licensed_street_reference"},
            "normal_xy": n_xy.round(6).tolist(),
            "source_type": "licensed_street_reference",
            "view_id": "street:commons:nyhavn-9-17-2022",
            "source_confidence": "moderate",
            "confidence_score": 0.62 if "gable_peak_xy" in item else 0.68,
            "method": "lower-wall calibrated homography extended so the hand-traced gable peak meets the Roofer front-wall maximum; clipped to hand-traced silhouette" if "gable_peak_xy" in item else ("manual four-corner projective homography; manually traced source cornice registered to the lower Roofer wall-top endpoint" if bid == "kk:1202806702" else "manual four-corner projective homography to the KK/DHM wall rectangle"),
            "calibration": ({"source_space_peak_xy": list(item["gable_peak_xy"]),
                             "metric_height_m": round(Hcal, 4),
                             "normalized_peak_v": round(peak_v, 6),
                             "physical_peak_dvr90": e["z_max"]} if "gable_peak_xy" in item else None),
            "source_photo": "sources/street-reference/nyhavn-9-17-2022.jpg",
            "source_date": "2022-06-21",
            "source_attribution": "Jenny Andersson / News Øresund, CC BY 2.0; see sources/street-reference/sources.json",
            "occlusion": {"mask": "manual source-space masks for parasols/canopies and quay foreground",
                          "transparent_fraction": round(1 - np.asarray(alpha).mean() / 255, 3),
                          "note": "small wires/poles and unmasked foreground may remain; lower facade is intentionally transparent where parasols or crowd overlap"},
            "alternates": [],
        }
        records.append(record)
        thumb = rgb.copy()
        thumb.thumbnail((420, 420), Image.Resampling.LANCZOS)
        sheet_items.append((item["label"].split(" (", 1)[0], thumb, record))

    meta = json.loads(meta_path.read_text())
    source_meta = next(x for x in meta if x["file"] == source_path.name)
    out_manifest = {
        "version": "nyhavn-facade-v2/1",
        "frame": {"horizontal": "EPSG:25832", "vertical": "DVR90"},
        "scope": "Hero canal-facing facades Nyhavn 9–17",
        "sources": [{"view_id": "street:commons:nyhavn-9-17-2022", **source_meta}],
        "facades": records,
            "limitations": ["Manual image corner selection; not a calibrated camera pose or survey georeference.",
                        "The metric image homography is calibrated on the lower wall; blue gable extrapolation is clipped to a hand-traced silhouette.",
                        "Foreground and banner masks are approximate; transparent pixels are intentionally left unavailable rather than filled from neighboring facades."],
    }
    out_json = BASE / "street-reference-manifest.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(out_manifest, ensure_ascii=False, indent=2) + "\n")
    unified = {**out_manifest, "scope": "Five canal-facing hero facades Nyhavn 9–17; aerial alternates pending",
               "facades": [{**r, "alternates": r.get("alternates", [])} for r in records]}
    (BASE / "manifest.json").write_text(json.dumps(unified, ensure_ascii=False, indent=2) + "\n")
    sheet = make_contact_sheet(sheet_items, BASE / "contact-sheet-hero-street.png")
    return {"manifest": str(out_json), "contact_sheet": str(sheet), "facades": len(records),
            "texture_bytes": sum((STREET_DIR / r["image"]["path"].split("/", 1)[1]).stat().st_size for r in records)}


def make_contact_sheet(items: list[tuple[str, Image.Image, dict]], path: Path) -> Path:
    cell_w, cell_h, label_h = 450, 500, 60
    cols = 3
    rows = math.ceil(len(items) / cols)
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (239, 237, 229))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 19)
    except OSError:
        font = ImageFont.load_default()
    for i, (label, im, rec) in enumerate(items):
        x, y = i % cols * cell_w, i // cols * cell_h
        im.thumbnail((cell_w - 28, cell_h - label_h - 24), Image.Resampling.LANCZOS)
        xx = x + (cell_w - im.width) // 2
        yy = y + label_h + max(0, (cell_h - label_h - im.height) // 2)
        sheet.paste(im, (xx, yy), im if im.mode == "RGBA" else None)
        alpha_pct = 100 * (1 - rec["occlusion"]["transparent_fraction"])
        d.text((x + 14, y + 9), label, fill=(36, 45, 47), font=font)
        d.text((x + 14, y + 32), f"{rec['image']['width_px']}×{rec['image']['height_px']} px  ·  {alpha_pct:.0f}% opaque", fill=(72, 78, 76), font=font)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, optimize=True)
    return path


def import_appearance():
    workspace_module = WORKSPACE / "tools/cph-geodata"
    durable_vendor = OUT / "scripts/vendor"
    module_dir = workspace_module if (workspace_module / "appearance.py").is_file() else durable_vendor
    if not (module_dir / "appearance.py").is_file():
        raise FileNotFoundError(f"appearance.py helper not found in {module_dir}")
    sys.path.insert(0, str(module_dir))
    import appearance
    appearance.ORIGIN = tuple(map(float, json.loads(MODEL.read_text())["frame"]["origin"]))
    return appearance


def build_roofer_scene(A, model: dict, roofer: dict):
    """Make the appearance rasterizer's scene from Roofer wall/roof triangles."""
    origin = np.asarray(model["frame"]["origin"], dtype=np.float64)
    vertices, triangles, tri_surface, tri_normals, surfaces = [], [], [], [], []
    surface_ids: dict[tuple[int, str, int, int], int] = {}
    building_index = {b["id"]: i for i, b in enumerate(model["buildings"])}
    for b in model["buildings"]:
        bi = building_index[b["id"]]
        rr = roofer["buildings"].get(str(b.get("kk_fot_id")))
        if not rr or not rr.get("triangles"):
            continue
        raw = np.asarray(rr["vertices_epsg25832_dvr90"], dtype=np.float64)
        local = np.column_stack([raw[:, 0] - origin[0], raw[:, 2] - origin[2], -(raw[:, 1] - origin[1])])
        off = sum(len(v) for v in vertices)
        tri = np.asarray(rr["triangles"], dtype=np.int64)
        kinds = rr["triangle_surface_type"]
        rings = rr["triangle_ring_index"]
        edges = rr["triangle_edge_index"]
        for t, kind_name, ring, edge in zip(tri, kinds, rings, edges):
            kind = "wall" if kind_name == "WallSurface" else "roof"
            key = (bi, kind, int(ring), int(edge))
            sid = surface_ids.get(key)
            if sid is None:
                sid = len(surfaces)
                surface_ids[key] = sid
                surfaces.append(A.Surface(bi, kind, int(ring), int(edge)))
            ids = np.asarray(t, dtype=np.int64)
            p = local[ids]
            normal = np.cross(p[1] - p[0], p[2] - p[0])
            norm = np.linalg.norm(normal)
            normal = normal / norm if norm > 1e-10 else np.array([0.0, 1.0, 0.0])
            if kind == "roof" and normal[1] < 0:
                normal *= -1
            tri_normals.append(normal)
            triangles.append(ids + off)
            tri_surface.append(sid)
        vertices.append(local)
    scene = A.Scene()
    scene.verts = np.vstack(vertices)
    scene.tris = np.asarray(triangles, dtype=np.int64)
    scene.tri_surf = np.asarray(tri_surface, dtype=np.int64)
    scene.tri_n = np.asarray(tri_normals, dtype=np.float64)
    scene.surfaces = surfaces
    return scene, surface_ids


def exterior_normal(building: dict, edge: int) -> np.ndarray:
    ring = np.asarray(building["wall_rings"][0]["vertices_epsg25832"], dtype=np.float64)
    a, b = ring[edge], ring[(edge + 1) % len(ring)]
    d = b - a
    n = np.array([d[1], -d[0]], dtype=np.float64)
    n /= max(np.linalg.norm(n), 1e-12)
    if float(np.dot(n, (a + b) * 0.5 - ring.mean(axis=0))) < 0:
        n *= -1
    return n


def hero_targets(model: dict) -> list[dict]:
    by_id = {b["id"]: b for b in model["buildings"]}
    out = []
    for bid, item in STREET_QUADS.items():
        b = by_id[bid]
        edge = int(item["edge"])
        out.append({"building": b, "building_id": bid, "edge": edge,
                    "label": item["label"], "normal_xy": exterior_normal(b, edge)})
    return out


def target_wall_surfaces(scene, model: dict, roofer: dict, target: dict) -> set[int]:
    """Select actual WallSurface triangles lying on this canal-facing footprint edge."""
    bid = target["building_id"]
    b = target["building"]
    bi = next(i for i, x in enumerate(model["buildings"]) if x["id"] == bid)
    edge = target["edge"]
    ring = np.asarray(b["wall_rings"][0]["vertices_epsg25832"], dtype=np.float64)
    a, c = ring[edge], ring[(edge + 1) % len(ring)]
    d = c - a
    length2 = float(d @ d)
    L = math.sqrt(length2)
    rr = roofer["buildings"].get(str(b.get("kk_fot_id")))
    if not rr or not rr.get("vertices_epsg25832_dvr90") or not rr.get("triangles"):
        return set()
    ids = set()
    # Filter all wall triangles by their geometry, not only the convenience edge tag:
    # gable planes are represented by Roofer with ring/edge=-1 but lie on the same edge.
    start = 0
    for m in model["buildings"][:bi]:
        prior = roofer["buildings"].get(str(m.get("kk_fot_id")))
        if prior:
            start += len(prior.get("vertices_epsg25832_dvr90", []))
    base_tri = 0
    for m in model["buildings"][:bi]:
        prior = roofer["buildings"].get(str(m.get("kk_fot_id")))
        if prior:
            base_tri += len(prior.get("triangles", []))
    # Each triangle surface ID is available in scene.tri_surface in the same order.
    verts = np.asarray(rr["vertices_epsg25832_dvr90"], dtype=np.float64)
    tris = np.asarray(rr["triangles"], dtype=np.int64)
    kinds = rr["triangle_surface_type"]
    for i, tri in enumerate(tris):
        if kinds[i] != "WallSurface":
            continue
        p = verts[tri, :2]
        t = ((p - a) @ d) / length2
        q = a + t[:, None] * d
        dist = np.linalg.norm(p - q, axis=1)
        if np.max(dist) <= 0.28 and np.min(t) >= -0.025 and np.max(t) <= 1.025:
            sid = int(scene.tri_surf[base_tri + i])
            ids.add(sid)
    return ids


def pixel_visibility(vb, camera, crop: dict, points_local: np.ndarray, target_sids: set[int]) -> np.ndarray:
    col, row, depth = camera.project(points_local)
    px = np.floor((col - crop["x0"]) * vb.scale).astype(int)
    py = np.floor((row - crop["y0"]) * vb.scale).astype(int)
    ok = (depth > 1) & (px >= 0) & (px < vb.surf.shape[1]) & (py >= 0) & (py < vb.surf.shape[0])
    valid = np.zeros(len(points_local), dtype=bool)
    if ok.any() and target_sids:
        found = vb.surf[py[ok], px[ok]]
        valid[ok] = np.isin(found, np.fromiter(target_sids, dtype=np.int32))
    return valid


def project_edge_grid(target: dict, ext: dict, nx: int, ny: int) -> np.ndarray:
    a = np.asarray(ext["coordinates"]["start"], dtype=np.float64)
    b = np.asarray(ext["coordinates"]["end"], dtype=np.float64)
    origin = np.asarray(json.loads(MODEL.read_text())["frame"]["origin"], dtype=np.float64)
    u = (np.arange(nx, dtype=np.float64) + 0.5) / nx
    z = ext["ground_dvr90"] + (np.arange(ny, dtype=np.float64) + 0.5)[:, None] / ny * (ext["z_max"] - ext["ground_dvr90"])
    xy = a[None, :] + u[:, None] * (b - a)[None, :]
    E = np.broadcast_to(xy[None, :, 0], (ny, nx))
    N = np.broadcast_to(xy[None, :, 1], (ny, nx))
    H = np.broadcast_to(z, (ny, nx))
    return np.column_stack([(E.ravel() - origin[0]), (H.ravel() - origin[2]), -(N.ravel() - origin[1])])


def sample_photo(photo: np.ndarray, col: np.ndarray, row: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h, w = photo.shape[:2]
    inside = (col >= 0.5) & (col < w - 1.5) & (row >= 0.5) & (row < h - 1.5)
    x = np.clip(col - 0.5, 0, w - 2)
    y = np.clip(row - 0.5, 0, h - 2)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    rgb = (photo[y0, x0] * (1 - fx) * (1 - fy) + photo[y0, x0 + 1] * fx * (1 - fy)
           + photo[y0 + 1, x0] * (1 - fx) * fy + photo[y0 + 1, x0 + 1] * fx * fy)
    return np.clip(rgb, 0, 255).astype(np.uint8), inside


def cautious_deshadow(rgb: np.ndarray, valid: np.ndarray, ppu: float) -> np.ndarray:
    """Gently lift broad shadow fields without changing facade chroma or window contrast."""
    from scipy.ndimage import gaussian_filter
    if not valid.any():
        return rgb
    f = rgb.astype(np.float32) / 255.0
    lum = f @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    sigma = max(2.0, min(80.0, 2.0 * ppu))
    weight = valid.astype(np.float32)
    smooth = gaussian_filter(lum * weight, sigma) / np.maximum(gaussian_filter(weight, sigma), 0.04)
    reference = float(np.percentile(smooth[valid], 72))
    gain = np.clip(reference / np.maximum(smooth, 1e-3), 1.0, 1.22)
    gain = gaussian_filter(gain, max(1.0, 0.35 * ppu))
    out = np.clip(f * gain[..., None], 0, 1)
    return np.round(out * 255).astype(np.uint8)


def rectify_native(target: dict, ext: dict, rec: dict, A, scene, target_sids: set[int],
                   score: dict) -> dict:
    from scipy.ndimage import gaussian_filter
    crop = rec["crop"]
    img_path = NATIVE_SOURCES / rec["file"]
    photo = np.asarray(Image.open(img_path).convert("RGB"))
    expected = (crop["y1"] - crop["y0"], crop["x1"] - crop["x0"])
    if photo.shape[:2] != expected:
        raise ValueError(f"native crop dimensions mismatch for {rec['view_id']}: {photo.shape[:2]} != {expected}")
    origin = np.asarray(json.loads(MODEL.read_text())["frame"]["origin"], dtype=np.float64)
    a = np.asarray(ext["coordinates"]["start"], dtype=np.float64)
    b = np.asarray(ext["coordinates"]["end"], dtype=np.float64)
    L = ext["length_m"]
    H = ext["z_max"] - ext["ground_dvr90"]
    # Choose no finer than the native limiting plane scale at the facade centre.
    mid = (a + b) * 0.5
    zmid = ext["ground_dvr90"] + H * 0.5
    def loc(u, z):
        xy = a + (b - a) * u
        return np.array([xy[0] - origin[0], z - origin[2], -(xy[1] - origin[1])])
    c0, r0, _ = A.Camera.from_pers(rec["pers"]).project(np.stack([
        loc(0.5 - min(0.5 / L, 0.25), zmid), loc(0.5 + min(0.5 / L, 0.25), zmid),
        loc(0.5, max(ext["ground_dvr90"], zmid - min(0.5, H * 0.25))),
        loc(0.5, min(ext["z_max"], zmid + min(0.5, H * 0.25))),
    ]))
    px_x = math.hypot(c0[1] - c0[0], r0[1] - r0[0]) / max(2 * min(0.5 / L, 0.25), 0.1)
    px_z = math.hypot(c0[3] - c0[2], r0[3] - r0[2]) / max(2 * min(0.5, H * 0.25), 0.1)
    ppu = max(4.0, min(160.0, min(px_x, px_z)))
    w, h = max(32, int(round(L * ppu))), max(32, int(round(H * ppu)))
    w, h = min(w, 4096), min(h, 4096)
    uu = (np.arange(w, dtype=np.float64) + 0.5) / w
    zz = ext["z_max"] - (np.arange(h, dtype=np.float64) + 0.5) / h * H
    U, Z = np.meshgrid(uu, zz)
    xy = a[None, None, :] + U[..., None] * (b - a)[None, None, :]
    P = np.stack([xy[..., 0] - origin[0], Z - origin[2], -(xy[..., 1] - origin[1])], axis=-1)
    camera = A.Camera.from_pers(rec["pers"])
    col, row, depth = camera.project(P.reshape(-1, 3))
    cx, cy = col - crop["x0"], row - crop["y0"]
    rgb, sample_inside = sample_photo(photo, cx, cy)
    vb = score["buffer"]
    pix_x = np.floor((col - crop["x0"]) * vb.scale).astype(int)
    pix_y = np.floor((row - crop["y0"]) * vb.scale).astype(int)
    inbuf = (pix_x >= 0) & (pix_x < vb.surf.shape[1]) & (pix_y >= 0) & (pix_y < vb.surf.shape[0])
    visible = np.zeros(len(P.reshape(-1, 3)), dtype=bool)
    ids = np.fromiter(target_sids, dtype=np.int32)
    if inbuf.any() and len(ids):
        visible[inbuf] = np.isin(vb.surf[pix_y[inbuf], pix_x[inbuf]], ids)
    valid = sample_inside & (depth > 1) & visible
    alpha = valid.reshape(h, w).astype(np.uint8) * 255
    image = rgb.reshape(h, w, 3)
    image = cautious_deshadow(image, alpha > 0, ppu)
    name = f"{target['building_id'].replace(':', '_')}_edge{target['edge']:02d}_{rec['view_id']}.png"
    out = NATIVE_DIR / name
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([image, alpha]), "RGBA").save(out, optimize=True)
    valid_fraction = float((alpha > 0).mean())
    return {"building_id": target["building_id"], "edge": target["edge"], "ring_edge_number": target["edge"] + 1,
            "label": target["label"], **ext, "coordinates": ext["coordinates"],
            "world_extent_m": [0.0, L, ext["ground_dvr90"], ext["z_max"]],
            "normal_xy": target["normal_xy"].round(6).tolist(), "source_type": "skraafoto_native_calibrated",
            "view_id": rec["view_id"], "source_confidence": "high" if valid_fraction >= 0.55 else "moderate",
            "confidence_score": round(float(score["score"]), 4), "visible_fraction": round(valid_fraction, 4),
            "image": {"path": f"native/{name}", "width_px": w, "height_px": h,
                      "orientation": "u=start→end; v=top→bottom",
                      "world_extent_m": [0.0, L, ext["ground_dvr90"], ext["z_max"]],
                      "meters_per_pixel": round(1 / ppu, 5), "pixels_per_metre": round(ppu, 3),
                      "source_type": "skraafoto_native_calibrated"},
            "source_image": {"path": f"sources/skraafoto-native/{rec['file']}",
                             "collection": rec["collection"], "datetime": rec.get("datetime"),
                             "direction": rec["direction"], "view_id": rec["view_id"],
                             "native_crop": crop, "camera": rec["pers"]},
            "source_attribution": "Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur, Skråfoto 2025; retrieved 2026-10-26.",
            "method": "Calibrated SAUL camera projection to Roofer WallSurface plane; raster visibility checked against all Roofer wall and roof triangles; broad luminance lift capped at 1.22×",
            "occlusion": {"mask": "projected triangle-ID z-buffer; no neighboring facade fill",
                          "transparent_fraction": round(1 - valid_fraction, 4),
                          "valid_fraction": round(valid_fraction, 4)}}


def all_front_targets(model: dict) -> list[dict]:
    """Select canal-facing long front edges for both Nyhavn rows from footprint geometry."""
    by_id = {b["id"]: b for b in model["buildings"]}
    hero = hero_targets(model)
    axis = np.mean([np.asarray(x["building"]["wall_rings"][0]["vertices_epsg25832"][
                                 (x["edge"] + 1) % len(x["building"]["wall_rings"][0]["vertices_epsg25832"])]) -
                    np.asarray(x["building"]["wall_rings"][0]["vertices_epsg25832"][x["edge"]])
                    for x in hero], axis=0)
    axis /= np.linalg.norm(axis)
    qaxis = np.array([-axis[1], axis[0]])
    candidates = []
    for b in model["buildings"]:
        address = str(b.get("address", ""))
        if "Nyhavn " not in address and b["id"] != "kk:1202806702":
            continue
        ring = np.asarray(b["wall_rings"][0]["vertices_epsg25832"], dtype=np.float64)
        centroid = ring.mean(axis=0)
        candidates.append((b, ring, centroid, float(centroid @ qaxis), address))
    vals = np.asarray([x[3] for x in candidates], dtype=np.float64)
    c1, c2 = float(np.quantile(vals, 0.2)), float(np.quantile(vals, 0.8))
    for _ in range(24):
        a = np.where(np.abs(vals - c1) <= np.abs(vals - c2), 0, 1)
        n1 = float(vals[a == 0].mean()) if np.any(a == 0) else c1
        n2 = float(vals[a == 1].mean()) if np.any(a == 1) else c2
        if abs(n1 - c1) + abs(n2 - c2) < 1e-4:
            break
        c1, c2 = n1, n2
    channel_q = 0.5 * (c1 + c2)
    selected = {x["building_id"]: x for x in hero}
    for b, ring, centroid, qcent, address in candidates:
        if b["id"] in selected:
            continue
        toward_sign = 1.0 if channel_q > qcent else -1.0
        options = []
        for edge, a0 in enumerate(ring):
            b0 = ring[(edge + 1) % len(ring)]
            d = b0 - a0
            L = float(np.linalg.norm(d))
            if L < 3.4:
                continue
            parallel = abs(float(d @ axis) / L)
            if parallel < 0.72:
                continue
            n = exterior_normal(b, edge)
            if float(n @ qaxis) * toward_sign < 0.18:
                continue
            qmid = float(((a0 + b0) * 0.5) @ qaxis)
            # Keep the two canal-facing bands. Addressed rear wings and courtyard
            # outbuildings often share the Nyhavn postal address but sit well behind
            # the front wall; their cross-canal offset exceeds this envelope.
            if abs(qmid - channel_q) > 38.0:
                continue
            # The outer canal frontage is the aligned edge nearest the midpoint between rows.
            score = abs(qmid - channel_q) + 3.0 * (1.0 - parallel) + 0.15 / L
            options.append((score, edge, n))
        if options:
            _, edge, n = min(options, key=lambda x: x[0])
            selected[b["id"]] = {"building": b, "building_id": b["id"], "edge": edge,
                                  "label": address, "normal_xy": n}
    return list(selected.values())


def choose_native_view(target: dict, ext: dict, cameras: list[dict], A, scene,
                       target_sids: set[int], buffers: dict) -> tuple[dict | None, dict]:
    origin = np.asarray(json.loads(MODEL.read_text())["frame"]["origin"], dtype=np.float64)
    mid = (np.asarray(ext["coordinates"]["start"]) + np.asarray(ext["coordinates"]["end"])) * 0.5
    options = []
    for rec in cameras:
        center = np.asarray(rec["pers"]["pers:perspective_center"], dtype=np.float64)
        delta = center[:2] - mid
        horizontal = max(float(np.linalg.norm(delta)), 1e-6)
        frontality = float(target["normal_xy"] @ (delta / horizontal))
        if frontality <= 0.08:
            continue
        grid = project_edge_grid(target, ext, 9, 7)
        cam = A.Camera.from_pers(rec["pers"])
        col, row, depth = cam.project(grid)
        crop = rec["crop"]
        in_crop = ((depth > 1) & (col >= crop["x0"]) & (col < crop["x1"]) &
                   (row >= crop["y0"]) & (row < crop["y1"]))
        coverage = float(in_crop.mean())
        if coverage < 0.20:
            continue
        vb = buffers.get(rec["view_id"])
        if vb is None:
            vb = A.render_view(scene, cam, crop, 0.16)
            buffers[rec["view_id"]] = vb
        visible = pixel_visibility(vb, cam, crop, grid, target_sids)
        visible_fraction = float(visible.mean())
        # Resolve the limiting projected image scale at the facade centre.
        extents = [ext["ground_dvr90"], ext["z_max"]]
        rowdiff = max(0.5, (extents[1] - extents[0]) * 0.35)
        length = ext["length_m"]
        udelta = max(0.4, min(1.0, length * 0.12))
        p0 = np.array([grid[len(grid)//2], grid[len(grid)//2]])
        zz = sum(extents) * 0.5 - origin[2]
        xy0 = np.asarray(ext["coordinates"]["start"], dtype=np.float64)
        xy1 = np.asarray(ext["coordinates"]["end"], dtype=np.float64)
        midxy = (xy0 + xy1) * 0.5
        ptest = np.array([[midxy[0] - origin[0], zz, -(midxy[1] - origin[1])],
                          [midxy[0] + (xy1[0] - xy0[0]) / length * udelta - origin[0], zz,
                           -(midxy[1] + (xy1[1] - xy0[1]) / length * udelta - origin[1])],
                          [midxy[0] - origin[0], zz - rowdiff, -(midxy[1] - origin[1])],
                          [midxy[0] - origin[0], zz + rowdiff, -(midxy[1] - origin[1])]])
        cc, rr, _ = cam.project(ptest)
        ppu = min(math.hypot(cc[1]-cc[0], rr[1]-rr[0]) / udelta,
                  math.hypot(cc[3]-cc[2], rr[3]-rr[2]) / (2*rowdiff))
        score_value = frontality * visible_fraction * coverage * math.sqrt(max(ppu, 0.1))
        options.append((score_value, rec, {"frontality": frontality, "visible_fraction": visible_fraction,
                                            "crop_coverage": coverage, "pixels_per_metre": ppu,
                                            "buffer": vb, "score": score_value}))
    if not options:
        return None, {"reason": "no front-facing camera crop covers this facade"}
    options.sort(key=lambda x: x[0], reverse=True)
    return options[0][1], options[0][2]


def fetch_native(initial: bool, texel: float) -> dict:
    model = json.loads(MODEL.read_text())
    roofer = json.loads(ROOFER.read_text()) if ROOFER.exists() else None
    camera_path = NATIVE_SOURCES / "cameras.json"
    if not camera_path.exists():
        raise FileNotFoundError(f"native camera records not found at {camera_path}; parent fetch must finish first")
    cameras = json.loads(camera_path.read_text())
    if not cameras:
        raise ValueError(f"no camera records in {camera_path}")
    if not roofer:
        raise FileNotFoundError(f"Roofer WallSurface model missing at {ROOFER}")
    A = import_appearance()
    scene, _ = build_roofer_scene(A, model, roofer)
    targets = hero_targets(model) if initial else all_front_targets(model)
    buffers = {}
    records, sheet_items, missing = [], [], []
    street_manifest = json.loads((BASE / "street-reference-manifest.json").read_text())
    streets = {(x["building_id"], int(x["edge"])): x for x in street_manifest["facades"]}
    for index, target in enumerate(targets, 1):
        ext = edge_record(target["building"], target["edge"])
        target_sids = target_wall_surfaces(scene, model, roofer, target)
        if not target_sids:
            missing.append({"building_id": target["building_id"], "edge": target["edge"],
                            "label": target["label"],
                            "reason": "no Roofer WallSurface triangles mapped to this footprint edge"})
            continue
        view, score = choose_native_view(target, ext, cameras, A, scene, target_sids, buffers)
        if view is None:
            missing.append({"building_id": target["building_id"], "edge": target["edge"],
                            "label": target["label"], "reason": score.get("reason")})
            continue
        native = rectify_native(target, ext, view, A, scene, target_sids, score)
        print(f"[{index}/{len(targets)}] {target['label']} edge {target['edge']} {view['view_id']} visible={native['visible_fraction']:.2f} ppu={native['image']['pixels_per_metre']:.1f}", flush=True)
        if native["visible_fraction"] < 0.12:
            (BASE / native["image"]["path"]).unlink(missing_ok=True)
            missing.append({"building_id": target["building_id"], "edge": target["edge"],
                            "label": target["label"],
                            "reason": f"only {native['visible_fraction']:.1%} of projected wall passes source visibility mask"})
            continue
        records.append(native)
        thumb = Image.open(BASE / native["image"]["path"]).convert("RGBA")
        thumb.thumbnail((420, 420), Image.Resampling.LANCZOS)
        label = target["label"].split(",", 1)[0]
        sheet_items.append((label, thumb, {"image": native["image"],
                                          "occlusion": native["occlusion"]}))
    manifest_path = BASE / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        manifest = {"version": "nyhavn-facade-v2/1", "frame": {"horizontal": "EPSG:25832", "vertical": "DVR90"}, "facades": []}
    if initial:
        by_key = {(x["building_id"], int(x["edge"])): x for x in manifest.get("facades", [])}
    else:
        # Rebuild the frontage collection from the current corridor target set.
        # Keep only licensed street hero primaries; native candidates outside the
        # canal-facing bands may remain on disk but must not leak into this manifest.
        hero_keys = {(x["building_id"], int(x["edge"])) for x in hero_targets(model)}
        by_key = {(x["building_id"], int(x["edge"])): x for x in manifest.get("facades", [])
                  if (x["building_id"], int(x["edge"])) in hero_keys and
                  x.get("image", {}).get("source_type") == "licensed_street_reference"}
    for rec in records:
        key = (rec["building_id"], int(rec["edge"]))
        if key in by_key and by_key[key].get("image", {}).get("source_type") == "licensed_street_reference":
            primary = by_key[key]
            primary["alternates"] = [rec]
        else:
            rec["alternates"] = []
            by_key[key] = rec
    manifest["facades"] = list(by_key.values())
    manifest["scope"] = "Five hero facades plus canal-facing Nyhavn frontage where a full-resolution native camera view passes geometric visibility checks"
    manifest["native_imagery"] = {"source_camera_manifest": "sources/skraafoto-native/cameras.json",
                                  "native_view_count": len(cameras), "rectified_edge_count": len(records),
                                  "frontage_selection": {"rule": "Nyhavn-address footprint edge aligned with the canal and facing the corridor; red Nyhavn11 is included by its KK footprint id despite its Store Strandstræde address",
                                                         "maximum_cross_canal_offset_m": 38.0,
                                                         "rear_wings_and_courtyard_outbuildings": "excluded by footprint position",
                                                         "candidate_edge_count": len(targets)},
                                  "unavailable_edges": missing,
                                  "occlusion": "Roofer wall/roof triangle z-buffer; pixels not visible on the selected facade remain alpha transparent"}
    manifest["unavailable_facades"] = missing
    sources = manifest.setdefault("sources", [])
    if not any(s.get("source_type") == "skraafoto_native_calibrated" for s in sources):
        sources.append({"source_type": "skraafoto_native_calibrated",
                        "provider": "Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur",
                        "dataset": "Skråfoto 2025", "retrieved": "2026-10-26",
                        "attribution": "Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur, Skråfoto 2025.",
                        "camera_records": "sources/skraafoto-native/cameras.json"})
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    validation = validate_outputs(manifest, model)
    validation_path = BASE / "report.json"
    validation_path.write_text(json.dumps(validation, ensure_ascii=False, indent=2) + "\n")
    sheet = make_contact_sheet(sheet_items, BASE / ("contact-sheet-native-hero.png" if initial else "contact-sheet-native-rows.png")) if sheet_items else None
    return {"manifest": str(manifest_path), "facades": len(records), "missing": len(missing),
            "contact_sheet": str(sheet) if sheet else None, "report": str(validation_path),
            "validation": validation["validation"]}


def validate_outputs(manifest: dict, model: dict) -> dict:
    by_id = {b["id"]: b for b in model["buildings"]}
    checks = []
    problems = []
    for facade in manifest.get("facades", []):
        key = (facade["building_id"], int(facade["edge"]))
        b = by_id.get(key[0])
        if b is None:
            problems.append(f"unknown building id {key[0]}")
            continue
        points = b["wall_rings"][0]["vertices_epsg25832"]
        edge = key[1]
        if edge >= len(points):
            problems.append(f"edge outside footprint {key}")
            continue
        expected_start, expected_end = points[edge], points[(edge + 1) % len(points)]
        actual = facade["coordinates"]
        numeric = np.asarray([*actual["start"], *actual["end"], facade["ground_dvr90"],
                              facade["z_max"], *facade["normal_xy"]], dtype=np.float64)
        if not np.isfinite(numeric).all() or facade["z_max"] <= facade["ground_dvr90"]:
            problems.append(f"nonfinite or inverted extent {key}")
        if not (np.allclose(actual["start"], expected_start, atol=1e-5) and
                np.allclose(actual["end"], expected_end, atol=1e-5)):
            problems.append(f"footprint edge mismatch {key}")
        images = [facade.get("image")] + [x.get("image") for x in facade.get("alternates", [])]
        image_extents = []
        full_extent = facade.get("world_extent_m")
        if not full_extent or not np.isfinite(np.asarray(full_extent, dtype=np.float64)).all():
            problems.append(f"missing or nonfinite full extent {key}")
        for image_data in images:
            if not image_data:
                continue
            path = BASE / image_data["path"]
            if not path.is_file():
                problems.append(f"missing texture {path}")
                continue
            with Image.open(path) as im:
                im.load()
                if im.mode != "RGBA":
                    problems.append(f"texture is not RGBA {path}")
                if [im.width, im.height] != [image_data["width_px"], image_data["height_px"]]:
                    problems.append(f"texture size metadata mismatch {path}")
                extent = np.asarray(image_data["world_extent_m"], dtype=np.float64)
                if extent.shape != (4,) or not np.isfinite(extent).all() or extent[1] <= extent[0] or extent[3] <= extent[2]:
                    problems.append(f"invalid texture extent {path}")
                elif full_extent and (extent[0] < full_extent[0] - 1e-6 or extent[1] > full_extent[1] + 1e-6 or
                                      extent[2] < full_extent[2] - 1e-6 or extent[3] > full_extent[3] + 1e-6):
                    problems.append(f"texture extent exceeds full wall extent {path}")
                alpha = np.asarray(im.getchannel("A"), dtype=np.uint8)
                coverage = float((alpha > 0).mean())
                if coverage <= 0:
                    problems.append(f"empty alpha coverage {path}")
                source_type = image_data.get("source_type")
                image_extents.append((source_type, image_data["world_extent_m"]))
            checks.append({"path": image_data["path"], "size_px": image_data["width_px"],
                           "alpha_coverage": round(coverage, 4), "source_type": image_data.get("source_type")})
        for source_type, extent in image_extents:
            if source_type == "skraafoto_native_calibrated" and full_extent and not np.allclose(extent, full_extent, atol=1e-6):
                problems.append(f"native texture does not cover full Roofer extent {key}")
    if problems:
        raise ValueError("facade manifest validation failed: " + "; ".join(problems[:20]))
    return {"frame": {"horizontal": "EPSG:25832", "vertical": "DVR90"},
            "facade_count": len(manifest.get("facades", [])),
            "unavailable_count": len(manifest.get("unavailable_facades", [])),
            "checked_image_count": len(checks), "checked_images": checks,
            "validation": {"all_images_exist": all((BASE / x["path"]).is_file() for x in checks),
                           "rgba_and_dimensions_match": len(checks) > 0,
                           "all_alphas_nonempty": all(x["alpha_coverage"] > 0 for x in checks),
                           "footprint_edge_coordinates_match": not any("footprint edge mismatch" in p for p in problems),
                           "native_full_extents_match_roofer": not any("native texture does not cover full Roofer" in p for p in problems),
                           "finite_geometry": not any("nonfinite" in p for p in problems)}}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    subs = ap.add_subparsers(dest="cmd", required=True)
    subs.add_parser("street", help="rectify licensed Nyhavn 9–17 reference facades")
    f = subs.add_parser("fetch", help="fetch native Skråfoto and build calibrated row textures")
    f.add_argument("--collections", default="skraafotos2025,skraafotos2023")
    f.add_argument("--initial", action="store_true", help="only the hero Nyhavn 9–17 facades")
    f.add_argument("--top-views", type=int, default=3)
    f.add_argument("--texel", type=float, default=0.10)
    args = ap.parse_args()
    if args.cmd == "street":
        print(json.dumps(rectify_street(), indent=2))
    else:
        print(json.dumps(fetch_native(args.initial, args.texel), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
