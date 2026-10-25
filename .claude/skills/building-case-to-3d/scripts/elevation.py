# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "opencv-python-headless"]
# ///
"""Trace facade openings from a scanned elevation and check a model against it.

An elevation is an orthographic view of the facade, so a traced rectangle maps to
metres with two linear calibrations: drawing x -> elevation metres along the view's
right axis, and drawing y -> height above terrain. Workflow:

  grid      render a page (or crop) with a labelled pixel grid to read coordinates
  detect    propose opening rectangles (closed frames) in a region; numbered overlay
  calibrate fit the px->m maps from >=2 x and >=2 z reference pairs; reports residuals
  to-model  turn accepted rectangles into building.json openings (src = page + px bbox)
  check     draw every model opening/balcony of the facing facades onto the scan and
            report drawing openings with no model match (missing) and model elements
            with no drawing match (invented). This is the gate: invented > 0 fails.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def _render(pdf: str, page: int, dpi: int) -> Image.Image:
    if not shutil.which("pdftoppm"):
        raise SystemExit("pdftoppm (poppler) is required")
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "p"
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", "-f", str(page), "-l", str(page),
                        "-singlefile", pdf, str(stem)], check=True)
        return Image.open(f"{stem}.png").convert("RGB")


def _roi(text: str | None, img: Image.Image) -> tuple[int, int, int, int]:
    if not text:
        return 0, 0, img.width, img.height
    x0, y0, x1, y1 = (int(float(v)) for v in text.split(","))
    return max(0, x0), max(0, y0), min(img.width, x1), min(img.height, y1)


# --------------------------------------------------------------------------- grid
def cmd_grid(a: argparse.Namespace) -> None:
    img = _render(a.pdf, a.page, a.dpi)
    x0, y0, x1, y1 = _roi(a.roi, img)
    crop = img.crop((x0, y0, x1, y1))
    d = ImageDraw.Draw(crop)
    step = a.step
    for gx in range((x0 // step + 1) * step, x1, step):
        d.line([(gx - x0, 0), (gx - x0, crop.height)], fill=(255, 0, 0), width=1)
        d.text((gx - x0 + 2, 2), str(gx), fill=(255, 0, 0))
    for gy in range((y0 // step + 1) * step, y1, step):
        d.line([(0, gy - y0), (crop.width, gy - y0)], fill=(0, 0, 255), width=1)
        d.text((2, gy - y0 + 2), str(gy), fill=(0, 0, 255))
    crop.save(a.out)
    print(f"{a.out}: page px {x0},{y0}-{x1},{y1} at {a.dpi} dpi, grid {step}px")


# ------------------------------------------------------------------------- detect
def cmd_detect(a: argparse.Namespace) -> None:
    import cv2
    img = _render(a.pdf, a.page, a.dpi)
    x0, y0, x1, y1 = _roi(a.roi, img)
    g = np.asarray(img.convert("L").crop((x0, y0, x1, y1)))
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 12)
    # Close small gaps in frame lines so each opening becomes one enclosed region.
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    if a.mode == "railings":
        # Railings are drawn as dense vertical hatching: strong horizontal intensity change
        # (vertical strokes) with little vertical change. Score that texture per window.
        gf = g.astype(np.float32)
        gx = np.abs(cv2.Sobel(gf, cv2.CV_32F, 1, 0, ksize=3))
        gy = np.abs(cv2.Sobel(gf, cv2.CV_32F, 0, 1, ksize=3))
        ex = cv2.boxFilter(gx, -1, (a.gap * 2 + 1, a.stroke))
        ey = cv2.boxFilter(gy, -1, (a.gap * 2 + 1, a.stroke))
        mask = ((ex > np.percentile(ex, a.pct)) & (ex > a.ratio * ey)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 15), np.uint8))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        fill_ok = lambda area, w, h: area >= a.fill * w * h  # noqa: E731
    elif a.mode == "dark":
        # Hatched/dark zones (recesses, loggias, dark glazing): low mean intensity after blurring
        # away the hatch pattern; thin frame lines are removed by an opening.
        blur = cv2.blur(g, (a.gap * 2 + 1, a.gap * 2 + 1))
        mask = (blur < np.percentile(blur, a.pct)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((a.stroke, a.stroke), np.uint8))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        fill_ok = lambda area, w, h: area >= a.fill * w * h  # noqa: E731
    else:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(255 - bw, connectivity=4)
        fill_ok = lambda area, w, h: area >= a.fill * w * h  # noqa: E731
    cands = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if w < a.min_px or h < a.min_px or w > a.max_frac * g.shape[1] or h > a.max_frac * g.shape[0]:
            continue
        if not fill_ok(area, w, h):  # region should nearly fill its bbox (a rectangle)
            continue
        cands.append({"id": len(cands), "px": [int(x + x0), int(y + y0), int(x + x0 + w), int(y + y0 + h)]})
    vis = img.crop((x0, y0, x1, y1))
    d = ImageDraw.Draw(vis)
    for c in cands:
        bx = [c["px"][0] - x0, c["px"][1] - y0, c["px"][2] - x0, c["px"][3] - y0]
        d.rectangle(bx, outline=(220, 0, 0), width=2)
        d.text((bx[0] + 2, bx[1] + 1), str(c["id"]), fill=(0, 0, 200))
    vis.save(a.overlay)
    out = {"pdf": a.pdf, "page": a.page, "dpi": a.dpi, "roi": [x0, y0, x1, y1], "candidates": cands}
    Path(a.out).write_text(json.dumps(out, indent=2))
    print(f"{len(cands)} candidate rectangles -> {a.out}, overlay {a.overlay}. Review the overlay; "
          "candidates are proposals, not evidence, until a person/agent accepts them.")


# ---------------------------------------------------------------------- calibrate
def _fit(px: list[float], m: list[float]) -> tuple[float, float, list[float]]:
    A = np.vstack([px, np.ones(len(px))]).T
    (k, c), *_ = np.linalg.lstsq(A, np.asarray(m), rcond=None)
    res = [float(k * p + c - mm) for p, mm in zip(px, m)]
    return float(k), float(c), res


def cmd_calibrate(a: argparse.Namespace) -> None:
    xs = [tuple(map(float, s.split(":"))) for s in a.x]
    zs = [tuple(map(float, s.split(":"))) for s in a.z]
    if len(xs) < 2 or len(zs) < 2:
        raise SystemExit("need >=2 --x px:m and >=2 --z px:m pairs")
    kx, cx, rx = _fit([p for p, _ in xs], [m for _, m in xs])
    kz, cz, rz = _fit([p for p, _ in zs], [m for _, m in zs])
    ratio = abs(kx / kz) if kz else float("nan")
    cal = {"pdf": a.pdf, "page": a.page, "dpi": a.dpi, "x": {"k": kx, "c": cx, "residuals_m": rx},
           "z": {"k": kz, "c": cz, "residuals_m": rz}, "x_over_z_scale": ratio,
           "view_bearing_deg": a.view_bearing, "pairs": {"x": xs, "z": zs}}
    Path(a.out).write_text(json.dumps(cal, indent=2))
    print(f"x: {abs(kx)*1000:.2f} mm/px, max resid {max(map(abs, rx)):.3f} m | "
          f"z: {abs(kz)*1000:.2f} mm/px, max resid {max(map(abs, rz)):.3f} m | x/z scale {ratio:.4f}")
    if abs(ratio - 1) > 0.01:
        print("WARNING: x and z scales differ by >1% (paper shrinkage or a wrong reference)")


def _px_to_m(cal: dict, x: float, y: float) -> tuple[float, float]:
    return cal["x"]["k"] * x + cal["x"]["c"], cal["z"]["k"] * y + cal["z"]["c"]


def _m_to_px(cal: dict, u: float, z: float) -> tuple[float, float]:
    return (u - cal["x"]["c"]) / cal["x"]["k"], (z - cal["z"]["c"]) / cal["z"]["k"]


# ----------------------------------------------------- facade geometry from model
def _facing_facades(b: dict, bearing: float) -> list[dict]:
    """Facades whose outward normal points at the viewer, with their elevation-x span.

    The viewer looks along `bearing`; the elevation's right axis is bearing+90 deg.
    A facade edge a->b maps to elevation x via dot(P, right)."""
    look = np.array([math.sin(math.radians(bearing)), math.cos(math.radians(bearing))])
    right = np.array([look[1], -look[0]])  # rotate look -90 deg in ENU -> viewer's right
    vols = {v["id"]: v for v in b["volumes"]}
    out = []
    for f in b["facades"]:
        v = vols.get(f["volume"])
        if not v:
            continue
        o = np.asarray(v["outline"], float)
        i, j = f["edge"]
        pa, pb = o[i], o[j]
        t = pb - pa
        L = float(np.linalg.norm(t))
        if L < 0.3:
            continue
        n = np.array([t[1], -t[0]]) / L
        cen = o.mean(axis=0)
        if np.dot((pa + pb) / 2 - cen, n) < 0:
            n = -n
        if np.dot(n, -look) < 0.5:  # not facing the viewer
            continue
        ua, ub = float(np.dot(pa, right)), float(np.dot(pb, right))
        out.append({"facade": f, "pa": pa, "t": t / L, "L": L, "ua": ua, "ub": ub,
                    "depth": float(np.dot((pa + pb) / 2, look))})
    return out


def _storey_of(b: dict, z: float) -> dict:
    best = None
    for s in b["storeys"]:
        if s["ffl"] - 0.05 <= z < s["ffl"] + s["height"] - 0.05:
            best = s
    return best or min(b["storeys"], key=lambda s: abs(s["ffl"] - z))


# ----------------------------------------------------------------------- to-model
def cmd_to_model(a: argparse.Namespace) -> None:
    cal = json.loads(Path(a.cal).read_text())
    det = json.loads(Path(a.candidates).read_text())
    b = json.loads(Path(a.building).read_text())
    spec = a.keep or [str(c["id"]) for c in det["candidates"]]
    keep = {int(k): kind for k, kind in (s.split("=") if "=" in s else (s, "window") for s in spec)}
    for k in a.exclude or []:
        keep.pop(k, None)
    fac = _facing_facades(b, cal["view_bearing_deg"])
    sheet = a.sheet
    added, unplaced = [], []
    for c in det["candidates"]:
        if c["id"] not in keep:
            continue
        x0, y0, x1, y1 = c["px"]
        u0, z_top = _px_to_m(cal, x0, y0)
        u1, z_bot = _px_to_m(cal, x1, y1)
        u0, u1 = sorted((u0, u1))
        z_bot, z_top = sorted((z_bot, z_top))
        uc = (u0 + u1) / 2
        sid = _storey_of(b, z_bot + 0.1)["id"]
        hits = [f for f in fac if min(f["ua"], f["ub"]) - 0.05 <= uc <= max(f["ua"], f["ub"]) + 0.05
                and f["facade"].get("volume", "") == f"volume-{sid}"]
        if not hits:
            # Never fall back to another storey's facade: that silently misplaces openings.
            unplaced.append({"id": c["id"], "u": round(uc, 2), "z": round(z_bot, 2), "storey": sid})
            continue
        f = min(hits, key=lambda h: h["depth"])  # nearest to the viewer
        s = _storey_of(b, z_bot + 0.1)
        # elevation u -> distance along edge from vertex a
        sgn = 1 if f["ub"] >= f["ua"] else -1
        xa, xb = sgn * (u0 - f["ua"]), sgn * (u1 - f["ua"])
        x, w = min(xa, xb), abs(xb - xa)
        op = {"id": f"{f['facade']['id']}-tr{c['id']:03d}", "storey": s["id"], "x": round(x, 3), "w": round(w, 3),
              "sill": round(z_bot - s["ffl"], 3), "h": round(z_top - z_bot, 3), "kind": keep[c["id"]],
              "src": [f"{sheet}#px={x0},{y0},{x1},{y1}@{det['dpi']}dpi"], "conf": "measured"}
        added.append((f["facade"]["id"], op))
    res: dict[str, list] = {}
    for fid, op in added:
        res.setdefault(fid, []).append(op)
    Path(a.out).write_text(json.dumps(res, indent=2))
    print(f"{len(added)} openings on {len(res)} facades -> {a.out} (review, then merge into building.json)")
    if unplaced:
        Path(a.out).with_suffix(".unplaced.json").write_text(json.dumps(unplaced, indent=2))
        print(f"{len(unplaced)} traced openings have NO model facade at their storey/position: the model "
              f"geometry disagrees with the drawing there -> {Path(a.out).with_suffix('.unplaced.json')}")


# -------------------------------------------------------------------------- check
def _iou(a: tuple, b: tuple) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def cmd_check(a: argparse.Namespace) -> None:
    cal = json.loads(Path(a.cal).read_text())
    b = json.loads(Path(a.building).read_text())
    st = {s["id"]: s for s in b["storeys"]}
    img = _render(cal["pdf"], cal["page"], cal["dpi"])
    fac = _facing_facades(b, cal["view_bearing_deg"])
    model = []  # (kind, id, px-rect)
    inconsistent = []  # element storey differs from its facade's storey: builds at the wrong height
    for f in fac:
        fd = f["facade"]
        sgn = 1 if f["ub"] >= f["ua"] else -1
        def to_px(x0: float, x1: float, z0: float, z1: float) -> tuple:
            u0, u1 = f["ua"] + sgn * x0, f["ua"] + sgn * x1
            p0, p1 = _m_to_px(cal, u0, z0), _m_to_px(cal, u1, z1)
            return (min(p0[0], p1[0]), min(p0[1], p1[1]), max(p0[0], p1[0]), max(p0[1], p1[1]))
        vol_storey = fd.get("volume", "").replace("volume-", "")
        for op in fd.get("openings", []) + fd.get("balconies", []):
            if op.get("storey") != vol_storey:
                inconsistent.append({"id": op["id"], "facade": fd["id"], "storey": op.get("storey"),
                                     "facade_storey": vol_storey})
        for op in fd.get("openings", []):
            s = st[op["storey"]]
            z0 = s["ffl"] + op["sill"]
            model.append((op.get("kind", "window"), op["id"], to_px(op["x"], op["x"] + op["w"], z0, z0 + op["h"]),
                          op.get("conf", "?")))
        for bal in fd.get("balconies", []):
            s = st[bal["storey"]]
            model.append(("balcony", bal["id"], to_px(bal["x0"], bal["x1"], s["ffl"], s["ffl"] + bal.get("rail_h", 1.0)),
                          bal.get("conf", "?")))
    traced = []
    if a.traced:
        det = json.loads(Path(a.traced).read_text())
        keep = {int(k.split("=")[0]) for k in a.keep} if a.keep else {c["id"] for c in det["candidates"]}
        keep -= set(a.exclude or [])
        traced = [tuple(c["px"]) for c in det["candidates"] if c["id"] in keep]
    removed = set(a.removed or [])
    traced_ids = []
    if a.traced:
        det_ids = [c["id"] for c in json.loads(Path(a.traced).read_text())["candidates"]]
        keep_ids = {int(k.split("=")[0]) for k in a.keep} if a.keep else set(det_ids)
        keep_ids -= set(a.exclude or [])
        traced_ids = [i for i in det_ids if i in keep_ids]
    used, invented, matches, photo_sourced = set(), [], [], []
    for kind, mid, r, conf in model:
        if conf == "observed":  # reconciled: present today per photos/user, not in this drawing
            photo_sourced.append({"id": mid, "kind": kind})
            continue
        best, bi = 0.0, -1
        for i, t in enumerate(traced):
            v = _iou(r, t)
            if v > best:
                best, bi = v, i
        if traced and best < a.iou:
            invented.append({"id": mid, "kind": kind, "conf": conf, "best_iou": round(best, 2)})
        else:
            used.add(bi)
            matches.append({"id": mid, "iou": round(best, 2)})
    missing, reconciled_removed = [], []
    for i, t in enumerate(traced):
        if i in used:
            continue
        cid = traced_ids[i] if i < len(traced_ids) else i
        (reconciled_removed if cid in removed else missing).append({"traced_id": cid, "px": list(t)})
    d = ImageDraw.Draw(img, "RGBA")
    for t in traced:
        d.rectangle(t, outline=(0, 90, 255, 255), width=3)
    bad = {x["id"] for x in invented}
    for kind, mid, r, conf in model:
        col = (230, 0, 0, 255) if mid in bad else ((255, 140, 0, 255) if conf == "observed" else (0, 170, 60, 255))
        d.rectangle(r, outline=col, width=2)
    img.save(a.out)
    rep = {"sheet": f"{Path(cal['pdf']).name}:{cal['page']}", "model_elements": len(model),
           "traced_openings": len(traced), "matched": len(matches), "invented": invented,
           "missing": missing, "inconsistent_storey": inconsistent, "iou_threshold": a.iou,
           "reconciled_photo_sourced": photo_sourced, "reconciled_removed": reconciled_removed,
           "status": "fail" if (invented or missing or inconsistent) else ("pass" if traced else "visual-only")}
    Path(a.out).with_suffix(".json").write_text(json.dumps(rep, indent=2))
    print(f"{rep['status'].upper()}: {len(model)} model elements, {len(traced)} traced, "
          f"{len(invented)} invented, {len(missing)} missing, {len(inconsistent)} storey-inconsistent | reconciled: "
          f"{len(photo_sourced)} photo-sourced, {len(reconciled_removed)} removed -> {a.out}")
    print("Legend: blue = traced from drawing, green = model element matching it, orange = photo-sourced "
          "(reconciled), red = model element with no evidence.")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    g = sp.add_parser("grid", help="page or crop with a labelled pixel grid")
    g.add_argument("--pdf", required=True); g.add_argument("--page", type=int, required=True)
    g.add_argument("--dpi", type=int, default=150); g.add_argument("--roi"); g.add_argument("--step", type=int, default=100)
    g.add_argument("--out", required=True); g.set_defaults(fn=cmd_grid)
    d = sp.add_parser("detect", help="propose opening rectangles")
    d.add_argument("--pdf", required=True); d.add_argument("--page", type=int, required=True)
    d.add_argument("--dpi", type=int, default=150); d.add_argument("--roi")
    d.add_argument("--min-px", type=int, default=8); d.add_argument("--max-frac", type=float, default=0.3)
    d.add_argument("--fill", type=float, default=0.8)
    d.add_argument("--mode", choices=["openings", "railings", "dark"], default="openings")
    d.add_argument("--stroke", type=int, default=25, help="railings: min vertical stroke length px")
    d.add_argument("--gap", type=int, default=9, help="railings: max px between hatch strokes")
    d.add_argument("--pct", type=float, default=85, help="railings: texture percentile threshold")
    d.add_argument("--ratio", type=float, default=3.0, help="railings: min vertical/horizontal stroke energy")
    d.add_argument("--out", required=True); d.add_argument("--overlay", required=True); d.set_defaults(fn=cmd_detect)
    c = sp.add_parser("calibrate", help="fit px->m from reference pairs")
    c.add_argument("--pdf", required=True); c.add_argument("--page", type=int, required=True)
    c.add_argument("--dpi", type=int, default=150)
    c.add_argument("--x", action="append", required=True, help="drawing px x : elevation metres (repeat)")
    c.add_argument("--z", action="append", required=True, help="drawing px y : metres above terrain (repeat)")
    c.add_argument("--view-bearing", type=float, required=True,
                   help="compass bearing the viewer LOOKS toward (street elevation of a WNW facade: ~115)")
    c.add_argument("--out", required=True); c.set_defaults(fn=cmd_calibrate)
    t = sp.add_parser("to-model", help="accepted rectangles -> building.json openings")
    t.add_argument("--cal", required=True); t.add_argument("--candidates", required=True)
    t.add_argument("--building", required=True); t.add_argument("--sheet", required=True)
    t.add_argument("--keep", nargs="*", help="ids to accept, optionally id=door|window (default: all)")
    t.add_argument("--exclude", nargs="*", type=int, help="candidate ids to reject")
    t.add_argument("--out", required=True); t.set_defaults(fn=cmd_to_model)
    k = sp.add_parser("check", help="gate: overlay model on the scanned elevation")
    k.add_argument("--cal", required=True); k.add_argument("--building", required=True)
    k.add_argument("--traced", help="candidates JSON of the drawing's openings")
    k.add_argument("--keep", nargs="*", help="accepted candidate ids (default: all)")
    k.add_argument("--exclude", nargs="*", type=int, help="candidate ids to reject")
    k.add_argument("--removed", nargs="*", type=int,
                   help="traced ids removed by a reconciliation decision (reported, not failed)")
    k.add_argument("--iou", type=float, default=0.5); k.add_argument("--out", required=True)
    k.set_defaults(fn=cmd_check)
    a = p.parse_args()
    a.fn(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
