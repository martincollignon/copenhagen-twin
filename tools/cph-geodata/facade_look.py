#!/usr/bin/env python3
"""Facade photo quality pass: data/tex/*.jpg (rectified wall strips) -> data/tex-look/*.webp (RGBA).

Per strip (rectangles from `observed.atlas.walls[].px`):
  - unobserved texels (copies of the nearest valid texel / flat wall median left by appearance.py's fill) are detected by
    their lack of texture and written as alpha 0, so the engine fills them procedurally instead of showing the smear;
  - baked shadows are divided out: a masked large-scale luminance estimate, texels well below the strip's lit level are
    lifted towards it (penumbra-smooth), then the strip is re-normalised so its median wall colour equals the calibrated
    `tone_cal` (the base albedo of the twin);
  - windows are detected as dark, compact, window-sized blobs and written as alpha 255 (observed wall = 128);
  - light unsharp mask on luminance; the 2 px atlas gaps are filled by edge replication (no seams on bilinear reads).
Alpha encoding: 0 unobserved, 128 observed wall, up to 255 inside a (smoothed) window blob (lossless WebP alpha, `exact` keeps RGB under alpha 0).

    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_look.py [--limit N] [--ids a,b]
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "tex-look"
MAX_UNOBS = 0.5  # strips with more unobserved texels than this are dropped entirely


def s2l(x):
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def lum(lin):
    return lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def unobserved_mask(srgb8: np.ndarray, texel: float) -> np.ndarray:
    """True where the texel is a fill (no texture): flat along x or along y over a run, then cleaned up."""
    g = srgb8.astype(np.float32).mean(axis=2)
    dx = np.abs(np.diff(g, axis=1, prepend=g[:, :1]))
    dy = np.abs(np.diff(g, axis=0, prepend=g[:1, :]))
    flat = (ndi.uniform_filter(dx, (1, 5)) < 0.9) | (ndi.uniform_filter(dy, (5, 1)) < 0.9)
    flat &= ndi.uniform_filter(dx + dy, 5) < 1.6
    flat = ndi.binary_opening(flat, np.ones((4, 4)))
    lab, n = ndi.label(flat)
    if n:
        sizes = ndi.sum(flat, lab, range(1, n + 1))
        keep = np.isin(lab, 1 + np.flatnonzero(sizes * texel * texel >= 0.5))  # >= 0.5 m2
        flat = keep
    return ndi.binary_dilation(flat, np.ones((3, 3)))


def masked_blur(v, valid, sigma):
    w = valid.astype(np.float32)
    num = ndi.gaussian_filter(v * w, sigma)
    den = ndi.gaussian_filter(w, sigma)
    return num / np.maximum(den, 1e-3), den


def windows(lin, valid, texel):
    """Window blobs: compact, window-sized regions of high local contrast (dark panes inside pale frames) on a wall that is
    otherwise smooth. The engine refines each blob to its dark pane pixels, so frames keep their photo."""
    L = lum(lin)
    Lloc, _ = masked_blur(L, valid, 0.9 / texel)
    panes = valid & (L < 0.74 * Lloc) & (Lloc > 0.05)
    panes = ndi.binary_opening(panes, np.ones((2, 2)))
    r = max(1, int(round(0.18 / texel)))
    busy = ndi.binary_dilation(panes, np.ones((2 * r + 1, 2 * r + 1)))  # pane + its frame
    busy = ndi.binary_closing(busy, np.ones((3, 3)))
    lab, n = ndi.label(busy)
    out = np.zeros_like(busy)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        h, w = (sl[0].stop - sl[0].start) * texel, (sl[1].stop - sl[1].start) * texel
        area = (lab[sl] == i).sum() * texel * texel
        if 0.45 <= w <= 2.6 and 0.6 <= h <= 3.0 and area >= 0.55 * w * h and 0.28 <= w / h <= 1.5:
            out[sl] |= lab[sl] == i
    return out


def process_strip(img8, texel, tone_cal):
    srgb = img8.astype(np.float32) / 255.0
    lin = s2l(srgb)
    unobs = unobserved_mask(img8, texel)
    valid = ~unobs
    if valid.sum() < 40 or unobs.mean() > MAX_UNOBS:
        return None  # mostly fill: the whole strip stays procedural (alpha 0)
    L = lum(lin)
    # shadow division, two scales: large cast shadows (masked blur, thresholded against the lit level) and small ones such as
    # leaf shadows (grey closing removes dark features narrower than ~1.4 m, i.e. the "lit plaster" level underneath)
    Ls, cover = masked_blur(L, valid, 1.5 / texel)
    ref = np.percentile(Ls[valid], 75)
    w = np.clip((0.78 * ref - Ls) / (0.78 * ref - 0.45 * ref + 1e-6), 0, 1)
    gain = np.where(w > 0, 1 + w * (np.clip(ref / np.maximum(Ls, 1e-3), 1, 2.4) - 1), 1.0)
    gain = ndi.gaussian_filter(gain, 0.6 / texel * 0.5)
    lin = lin * gain[..., None]
    win = windows(lin, valid, texel)
    wall = valid & ~win
    # small shadows: lift towards the closing level outside windows (cap 1.8x), then fall back to the wall level at the borders
    k = max(3, int(round(1.4 / texel)) | 1)
    Lf = np.where(valid, lum(lin), 0.0)
    closed = ndi.gaussian_filter(ndi.grey_closing(Lf, size=(k, k)), 0.3 / texel)
    lift = np.clip(closed / np.maximum(lum(lin), 1e-3), 1, 1.8)
    lift = np.where(ndi.binary_dilation(win, np.ones((3, 3))), 1.0, ndi.gaussian_filter(lift, 0.5))
    lin = lin * lift[..., None]
    # normalise the wall median to the calibrated tone
    if wall.sum() > 20 and tone_cal is not None:
        med = np.median(lin[wall], axis=0)
        target = s2l(np.array(tone_cal, np.float32))
        scale = np.clip(target / np.maximum(med, 1e-3), 0.4, 2.5)
        lin = lin * scale
        # damp the deviation from the wall tone (blotches, residual shadows, blue sky-lit patches); windows keep full contrast
        ratio = np.maximum(lin / np.maximum(target, 1e-3), 1e-3)
        damped = target * ratio ** 0.8
        lin = np.where(win[..., None], lin, damped)
    # unsharp on luminance
    Lc = lum(lin)
    blur = ndi.gaussian_filter(Lc, 0.8)
    lin = lin * (1 + 0.55 * np.clip((Lc - blur) / np.maximum(Lc, 1e-3), -0.5, 0.5))[..., None]
    rgb = (l2s(lin) * 255 + 0.5).astype(np.uint8)
    soft = ndi.gaussian_filter(win.astype(np.float32), 1.1)  # smooth blob contours: the engine thresholds the bilinear alpha
    a = np.where(valid, 128 + np.round(127 * np.clip(soft * 1.15, 0, 1)), 0).astype(np.uint8)
    return rgb, a


def process_building(args):
    b_id, atlas, walls_cal = args
    src = ROOT / "data" / atlas["file"]
    if not src.exists():
        return b_id, None
    im = np.asarray(Image.open(src).convert("RGB"))
    H, W = im.shape[:2]
    rgb = im.copy()
    alpha = np.zeros((H, W), np.uint8)
    stats = {"strips": 0, "unobs": 0.0, "win": 0.0, "area": 0}
    for w in atlas["walls"]:
        x, y, pw, ph = w["px"]
        tone = walls_cal.get((w["ring"], w["edge"]))
        res = process_strip(im[y:y + ph, x:x + pw], w.get("texel_m", 0.1), tone)
        if res is None:
            alpha[y:y + ph, x:x + pw] = 0
            continue
        rgb[y:y + ph, x:x + pw], alpha[y:y + ph, x:x + pw] = res
        a = alpha[y:y + ph, x:x + pw]
        stats["strips"] += 1
        stats["unobs"] += float((a == 0).sum())
        stats["win"] += float((a == 255).sum())
        stats["area"] += ph * pw
        # replicate the strip border 2 px outwards (atlas gaps) so bilinear taps never read black
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            pass
        for k in (1, 2):
            if y - k >= 0: rgb[y - k, x:x + pw] = rgb[y, x:x + pw]; alpha[y - k, x:x + pw] = alpha[y, x:x + pw]
            if y + ph - 1 + k < H: rgb[y + ph - 1 + k, x:x + pw] = rgb[y + ph - 1, x:x + pw]; alpha[y + ph - 1 + k, x:x + pw] = alpha[y + ph - 1, x:x + pw]
            if x - k >= 0: rgb[y:y + ph, x - k] = rgb[y:y + ph, x]; alpha[y:y + ph, x - k] = alpha[y:y + ph, x]
            if x + pw - 1 + k < W: rgb[y:y + ph, x + pw - 1 + k] = rgb[y:y + ph, x + pw - 1]; alpha[y:y + ph, x + pw - 1 + k] = alpha[y:y + ph, x + pw - 1]
    out = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
    out.save(OUT / (Path(atlas["file"]).stem + ".webp"), quality=82, method=4, exact=True, alpha_quality=100)
    return b_id, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids", default="")
    ap.add_argument("--geodata", default="data/cph-geodata.json")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    geo = json.load(open(ROOT / a.geodata))
    ids = set(filter(None, a.ids.split(",")))
    jobs = []
    for b in geo["buildings"]:
        at = (b.get("observed") or {}).get("atlas")
        if not at or (ids and b["id"] not in ids):
            continue
        cal = {(w["ring"], w["edge"]): (w.get("tone_cal") or w.get("tone")) for w in b["observed"]["walls"] if w.get("conf") != "inferred"}
        jobs.append((b["id"], at, cal))
    if a.limit:
        jobs = jobs[: a.limit]
    tot = {"strips": 0, "unobs": 0.0, "win": 0.0, "area": 0}
    with ProcessPoolExecutor() as ex:
        for i, (bid, st) in enumerate(ex.map(process_building, jobs, chunksize=8)):
            if st:
                for k in tot: tot[k] += st[k]
            if i % 200 == 0: print(i, len(jobs), flush=True)
    print(json.dumps({k: (round(v / max(tot["area"], 1), 3) if k in ("unobs", "win") else v) for k, v in tot.items()}))


if __name__ == "__main__":
    main()
