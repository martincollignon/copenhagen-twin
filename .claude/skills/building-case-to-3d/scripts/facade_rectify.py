# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "opencv-python-headless"]
# ///
"""Rectify one facade out of a calibrated Skråfoto oblique, at metric scale.

A facade is (close to) a plane, and a pinhole camera maps a plane to the image by a
homography. We project the four facade corners with the photo's own calibrated camera
(skraafoto.world_to_pixel) and warp that quadrilateral to a front-on image in metres:
x = distance along the facade edge from vertex a, z = height above terrain.

Use it in the reconciliation phase to put the *current* facade next to the elevation
drawing at the same scale, and to overlay model openings/balconies on the photo.
Projections (balconies, canopies) sit in front of the plane, so they shift slightly in
the rectified image; judge presence and rhythm, not centimetres.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skraafoto import world_to_pixel  # noqa: E402


def _camera(spec: str) -> tuple[dict, Path]:
    path, _, vid = spec.partition("#")
    recs = json.loads(Path(path).read_text())
    rec = next((r for r in recs if r["view_id"] == vid), None)
    if rec is None:
        raise SystemExit(f"view {vid} not in {path}")
    return rec, Path(path).parent


def _facade(b: dict, fid: str) -> tuple[np.ndarray, np.ndarray, float, dict]:
    f = next((f for f in b["facades"] if f["id"] == fid), None)
    if f is None:
        raise SystemExit(f"facade {fid} not in building.json")
    v = next(v for v in b["volumes"] if v["id"] == f["volume"])
    o = np.asarray(v["outline"], float)
    pa, pb = o[f["edge"][0]], o[f["edge"][1]]
    L = float(np.linalg.norm(pb - pa))
    return pa, (pb - pa) / L, L, f


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--camera", required=True, help="cameras.json#view_id")
    p.add_argument("--building", required=True)
    p.add_argument("--facade", required=True, help="facade id whose edge defines the plane, e.g. ST-courtyard")
    p.add_argument("--z0", type=float, default=0.0, help="bottom, metres above terrain")
    p.add_argument("--z1", type=float, required=True, help="top, metres above terrain")
    p.add_argument("--pad", type=float, default=1.0, help="extra metres left/right")
    p.add_argument("--res", type=float, default=0.05, help="output metres per pixel")
    p.add_argument("--overlay-family", help="draw model openings/balconies of facades ending in this suffix, "
                   "e.g. '-courtyard' (same edge on every storey)")
    p.add_argument("--out", required=True)
    a = p.parse_args()

    import cv2
    rec, base = _camera(a.camera)
    b = json.loads(Path(a.building).read_text())
    origin = np.asarray(b["frame"]["origin"], float)
    pa, t, L, _ = _facade(b, a.facade)
    pers = rec["pers"]
    crop = rec["crop"]
    f = crop.get("overview_factor", 1) or 1

    def img_px(s: float, z: float) -> tuple[float, float]:
        e, n = origin[:2] + pa + t * s
        c, r = world_to_pixel(pers, e, n, origin[2] + z)
        return (c - crop["x0"]) / f, (r - crop["y0"]) / f

    s0, s1 = -a.pad, L + a.pad
    W = int(round((s1 - s0) / a.res))
    H = int(round((a.z1 - a.z0) / a.res))
    src = np.float32([img_px(s0, a.z1), img_px(s1, a.z1), img_px(s1, a.z0), img_px(s0, a.z0)])
    dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    Hm = cv2.getPerspectiveTransform(src, dst)
    photo = np.asarray(Image.open(base / rec["file"]).convert("RGB"))
    warped = cv2.warpPerspective(photo, Hm, (W, H), flags=cv2.INTER_CUBIC)
    # Visible-face check: the plane must face the camera, or we are looking at its back.
    cam = np.asarray(pers["pers:perspective_center"], float)[:2] - (origin[:2] + pa + t * L / 2)
    normal = np.array([t[1], -t[0]])
    facing = "unknown"
    try:
        o = np.asarray(next(v for v in b["volumes"] if v["id"] == _facade(b, a.facade)[3]["volume"])["outline"])
        if np.dot((pa + t * L / 2) - o.mean(axis=0), normal) < 0:
            normal = -normal
        facing = "yes" if np.dot(cam, normal) > 0 else "NO (camera sees the back of this plane)"
    except StopIteration:
        pass

    img = Image.fromarray(warped)
    d = ImageDraw.Draw(img, "RGBA")
    to = lambda s, z: ((s - s0) / a.res, (a.z1 - z) / a.res)  # noqa: E731
    st = {s["id"]: s for s in b["storeys"]}
    for s in b["storeys"]:  # storey lines from the model, for orientation
        y = to(0, s["ffl"])[1]
        if 0 <= y <= H:
            d.line([(0, y), (W, y)], fill=(255, 220, 0, 110), width=1)
    if a.overlay_family:
        for fd in b["facades"]:
            if not fd["id"].endswith(a.overlay_family):
                continue
            for op in fd.get("openings", []):
                z = st[op["storey"]]["ffl"] + op["sill"]
                d.rectangle([to(op["x"], z + op["h"]), to(op["x"] + op["w"], z)],
                            outline=(0, 200, 255, 220) if op.get("kind") != "door" else (255, 60, 200, 230), width=2)
            for bal in fd.get("balconies", []):
                z = st[bal["storey"]]["ffl"]
                d.rectangle([to(bal["x0"], z + bal.get("rail_h", 1.0)), to(bal["x1"], z)], outline=(255, 120, 0, 230), width=2)
    img.save(a.out)
    meta = {"view_id": rec["view_id"], "facade": a.facade, "res_m_per_px": a.res, "s_range_m": [s0, s1],
            "z_range_m": [a.z0, a.z1], "edge_length_m": L, "camera_faces_plane": facing,
            "note": "x = metres along facade edge from vertex a; projections in front of the plane are displaced"}
    Path(a.out).with_suffix(".json").write_text(json.dumps(meta, indent=2))
    print(f"{a.out}: {W}x{H}px at {a.res} m/px, facade {a.facade} ({L:.2f} m), camera faces plane: {facing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
