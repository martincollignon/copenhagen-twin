#!/usr/bin/env python3
"""Measured window layouts from the Skråfoto facade look atlases (data/tex-look/<id>.webp, tools/cph-geodata/facade_look.py).

Per wall strip (appearance.json `atlas.walls[]`, rectified in the engine's wall frame: column 0 at the raw edge's start, row 0 at
the strip top `h_m` above the engine ground, the last row at the ground) this fits a regular window grid:

    rows    upper-storey window bands: sill and head heights per row, a common storey pitch `f`, the ground-floor line `g`
    columns window centres on a common pitch `p` from a start `u0`, with a column mask (missing bays are wall), per-column offsets
    ground  the ground-floor band below `g`: openings (shopfront, door, window) as u-ranges, snapped to the column grid when they fit
    conf    0..1 from the grid's regularity, the opening contrast and how much of the strip is observed

The look atlas's own window alpha (255 = window blob) finds few of the windows (compact dark blobs only), so the openings come from
a luminance-deviation map of the de-lit photo: panes and frames differ from the wall, the wall is smooth. Its row profile gives the
window bands, its column profile inside those bands the window columns. A grid is kept only when it is plausible (storey 2.4-4.8 m,
pitch 1.1-6.5 m, window 0.45-2.6 m wide and 0.8-3.2 m tall, at least two rows or three columns of windows, residuals small);
walls without one keep the engine's procedural guess.

Output, per tile: data/tiles/<tile>/windows.json (the tile layer `windows`, format `cph-facade-layout/1`, docs/facade-layout.md); `index`
patches data/tiles/index.json (the layer's bytes and counts per tile, which is what js/tile-store.js hasLayer reads).

    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout.py run [tiles...|all] [--workers 8]
    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout.py index
    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout.py show <gdk id>
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
TILES = ROOT / "data" / "tiles"
FORMAT = "cph-facade-layout/1"
LAYER = "windows"
LAYER_FILE = LAYER + ".json"
LOOK_DIRS = [Path(os.environ.get("CPH_TEX_LOOK", str(Path.home() / ".cache" / "cph-twin" / "tex-look"))), ROOT / "data" / "tex-look"]

# plausibility of a fitted grid
FLOOR_H = (2.4, 4.8)  # m storey pitch
PITCH = (1.1, 6.5)  # m column pitch
WIN_W = (0.45, 2.6)  # m window width
WIN_H = (0.8, 3.2)  # m window height
MIN_CONF = 0.6  # walls below this keep the procedural facade (tuned on a hand-checked sample, docs/facade-layout.md)
MIN_WALL_H = 4.0
MIN_WALL_LEN = 2.5


def look_path(file: str) -> Path | None:
    name = Path(file).stem + ".webp"
    for d in LOOK_DIRS:
        p = d / name
        if p.exists():
            return p
    return None


def _masked_blur(v, w, sigma):
    num = ndi.gaussian_filter(v * w, sigma)
    den = ndi.gaussian_filter(w, sigma)
    return num / np.maximum(den, 1e-3), den


def deviation_map(rgba: np.ndarray, sx: float, sy: float):
    """(F, valid): F 0..1, how far each texel is from the surrounding wall (panes darker, frames lighter, both edged)."""
    rgb = rgba[..., :3].astype(np.float32) / 255.0
    valid = rgba[..., 3] > 0
    g = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    w = valid.astype(np.float32)
    # the wall level: a running median over ~2 m (the wall is the most common surface; windows are a minority of it, light
    # frames on dark brick as well as dark panes on pale render)
    gm = np.where(valid, g, np.median(g[valid]) if valid.any() else 0.5)
    ky, kx = max(3, int(round(2.0 / sy))), max(3, int(round(2.0 / sx)))
    small = gm[::2, ::2] if min(sx, sy) < 0.12 else gm
    step = 2 if small is not gm else 1
    ref = ndi.median_filter(small, size=(max(3, ky // step), max(3, kx // step)), mode="nearest")
    if step > 1:
        ref = np.repeat(np.repeat(ref, 2, 0), 2, 1)[: g.shape[0], : g.shape[1]]
    ref = ndi.gaussian_filter(ref, 2)
    dark = np.clip((ref - g) / np.maximum(ref, 0.08), 0, 1)
    light = np.clip((g - ref) / np.maximum(ref, 0.08), 0, 1)
    gy, gx = np.gradient(ndi.gaussian_filter(g, 0.6))
    grad = np.clip(np.hypot(gx, gy) / np.maximum(ref, 0.08) * 1.6, 0, 1)
    F = np.maximum(np.maximum(dark * 1.5, light * 1.2), grad * 0.7)
    F = np.clip(F, 0, 1) * w
    return F, valid


def _runs(mask: np.ndarray):
    """[(start, stop)] of the True runs of a 1-d mask."""
    m = np.concatenate([[False], mask, [False]])
    d = np.diff(m.astype(np.int8))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def _merge(runs, gap):
    out = []
    for a, b in runs:
        if out and a - out[-1][1] <= gap:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def _bands(profile, valid_frac, lo_len, hi_len, gap, smooth):
    """Bands where a profile stands out: threshold between its low (spandrel / pier) and high (window) levels."""
    p = ndi.gaussian_filter1d(profile.astype(np.float32), smooth) if smooth > 0 else profile.astype(np.float32)
    ok = valid_frac > 0.35
    if ok.sum() < 6:
        return [], p, 0.0
    lo, hi = np.percentile(p[ok], 15), np.percentile(p[ok], 92)
    if hi - lo < 0.03:
        return [], p, 0.0
    thr = lo + 0.42 * (hi - lo)
    runs = _merge(_runs((p > thr) & ok), gap)
    runs = [(a, b) for a, b in runs if lo_len <= b - a <= hi_len]
    return runs, p, float((hi - lo) / max(hi, 1e-3))


def _fit_pitch(centres: np.ndarray, lo: float, hi: float):
    """(pitch, phase, rms residual, integer index per centre) of the regular grid that best explains `centres` (missing members allowed)."""
    if len(centres) < 2:
        return None
    best = None
    diffs = np.diff(np.sort(centres))
    cands = set()
    for d in diffs:
        for k in (1, 2, 3):
            if lo <= d / k <= hi:
                cands.add(round(d / k, 3))
    for p in sorted(cands):
        k = np.round((centres - centres[0]) / p)
        # least-squares pitch and phase for these indices
        if np.ptp(k) == 0:
            continue
        A = np.stack([k, np.ones_like(k)], 1)
        sol, *_ = np.linalg.lstsq(A, centres, rcond=None)
        pp, c0 = float(sol[0]), float(sol[1])
        if not (lo <= pp <= hi):
            continue
        res = centres - (c0 + k * pp)
        rms = float(np.sqrt(np.mean(res ** 2)))
        span = int(np.ptp(k)) + 1
        fill = len(centres) / span  # missing members cost
        score = rms / pp + 0.25 * (1 - fill)
        if best is None or score < best[0]:
            best = (score, pp, c0, rms, k.astype(int))
    if best is None:
        return None
    _, pp, c0, rms, k = best
    return pp, c0, rms, k - k.min()


def detect_boxes(F: np.ndarray, valid: np.ndarray, sx: float, sy: float, thr: float | None = None, wlim=WIN_W, hlim=WIN_H, max_aspect=2.2,
                 close_m: float = 0.13, pct: float = 72):
    """Window candidates: connected blobs of the thresholded deviation map, closed over the gaps between panes of one window
    (glazing bars, mullions: < ~0.3 m), kept when window sized. Returns [(u0, u1, v_top_row, v_bottom_row, fill)] in texels."""
    vals = F[valid]
    if vals.size < 50:
        return []
    if thr is None:
        thr = float(np.clip(np.percentile(vals, pct), 0.12, 0.45))
    B = (F > thr) & valid
    B = ndi.binary_opening(B, np.ones((2, 2))) | (B & (F > thr * 1.6))
    kx, ky = max(1, int(round(close_m / sx))), max(1, int(round(close_m / sy)))
    C = ndi.binary_closing(B, np.ones((2 * ky + 1, 2 * kx + 1))) & valid
    lab, n = ndi.label(C)
    out = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        h = (sl[0].stop - sl[0].start) * sy
        w = (sl[1].stop - sl[1].start) * sx
        if not (wlim[0] * 0.8 <= w <= wlim[1] * 1.1 and hlim[0] * 0.7 <= h <= hlim[1] * 1.1):
            continue
        reg = lab[sl] == i
        fill = float(reg.mean())
        dens = float(B[sl][reg].mean())
        if fill < 0.45 or dens < 0.25 or w / h > max_aspect:
            continue
        out.append((sl[1].start, sl[1].stop, sl[0].start, sl[0].stop, fill))
    return out


def _cluster_1d(vals: np.ndarray, tol: float):
    """Groups of sorted values whose neighbours are within tol: [(mean, [indices])]."""
    order = np.argsort(vals)
    groups, cur = [], [order[0]]
    for a, b in zip(order[:-1], order[1:]):
        if vals[b] - vals[a] <= tol:
            cur.append(b)
        else:
            groups.append(cur)
            cur = [b]
    groups.append(cur)
    return [(float(np.mean(vals[g])), g) for g in groups]


def comb_fit(P: np.ndarray, ok: np.ndarray, x: np.ndarray, plim, rlim, pstep=0.03, phstep=0.06, harmonic=0.8):
    """Best periodic square wave for a profile: (score, pitch, centre phase, width) maximising the contrast between the
    profile inside the pulses (windows) and between them (piers / spandrels), in units of the profile's spread. A multiple of
    the true pitch also scores well (every second window, wider pulses); the smallest pitch within `harmonic` of the best score
    that is a local maximum wins."""
    P = P[ok]
    x = x[ok]
    if len(P) < 8:
        return None
    sd = float(P.std()) + 1e-4
    Pz = (P - P.mean()) / sd
    ratios = np.linspace(rlim[0], rlim[1], 9)
    per_p = []
    n = len(P)
    for p in np.arange(plim[0], plim[1] + 1e-9, pstep):
        # fold the profile modulo p into phase bins; a pulse is a circular run of bins (cumulative sums of the tripled folds)
        nb = max(8, int(round(p / phstep)))
        b = np.floor((x % p) / p * nb).astype(int) % nb
        S = np.bincount(b, Pz, nb)
        C = np.bincount(b, None, nb).astype(np.float64)
        cS = np.concatenate([[0.0], np.cumsum(np.tile(S, 3))])
        cC = np.concatenate([[0.0], np.cumsum(np.tile(C, 3))])
        k = np.arange(nb) + nb
        bp = None
        for r in ratios:
            h = max(0, int(round(r * nb / 2)))
            s_in = cS[k + h + 1] - cS[k - h]
            n_in = cC[k + h + 1] - cC[k - h]
            n_out = n - n_in
            okp = (n_in >= 3) & (n_out >= 3)
            if not okp.any():
                continue
            score = (s_in / np.maximum(n_in, 1) + s_in / np.maximum(n_out, 1)) * np.sqrt(np.minimum(n_in, n_out) / n)
            score = np.where(okp, score, -1e9)
            kk = int(np.argmax(score))
            if bp is None or score[kk] > bp[0]:
                bp = (float(score[kk]), float(p), float((kk + 0.5) / nb * p), float((2 * h + 1) / nb * p))
        if bp:
            per_p.append(bp)
    if not per_p:
        return None
    top = max(b[0] for b in per_p)
    sc = [b[0] for b in per_p]
    for i, b in enumerate(per_p):
        lm = (i == 0 or sc[i] >= sc[i - 1]) and (i == len(sc) - 1 or sc[i] >= sc[i + 1])
        if lm and b[0] >= harmonic * top:
            return b
    return max(per_p)


def _refine(P, ok, x, fit, plim, rlim):
    """A finer search around a coarse comb fit."""
    sc, p, ph, w = fit
    r = w / p
    f2 = comb_fit(P, ok, x, (max(plim[0], p - 0.06), min(plim[1], p + 0.06)), (max(rlim[0], r - 0.08), min(rlim[1], r + 0.08)), 0.01, 0.02, harmonic=1.0)
    return f2 if f2 and f2[0] >= sc else fit


def fit_strip(rgba: np.ndarray, len_m: float, h_m: float, eave_m: float | None = None, debug: dict | None = None):
    """Layout of one strip (RGBA, row 0 at the top) or (None, reason)."""
    ph, pw = rgba.shape[:2]
    sx, sy = len_m / pw, h_m / ph
    F, valid = deviation_map(rgba, sx, sy)
    top_m = min(h_m, eave_m) if eave_m else h_m
    obs_rows = max(1, int(round(top_m / sy)))
    obs = float(valid[ph - obs_rows:, :].mean())
    if obs < 0.5:
        return None, "unobserved"
    if top_m < 5.0:
        return None, "low_wall"
    F0 = F
    # glazing bars and mullions split a window into panes: a grey closing over ~0.3 m makes each window one block
    F = ndi.grey_closing(F, size=(max(2, int(round(0.3 / sy))), max(2, int(round(0.3 / sx))))) * valid
    ys = h_m - (np.arange(ph) + 0.5) * sy  # metres above the ground per row
    xs = (np.arange(pw) + 0.5) * sx
    upper_rows = (ys > 2.3) & (ys < top_m - 0.25)
    if upper_rows.sum() < int(2.0 / sy):
        return None, "no_upper_band"
    colw = np.ones(pw, bool)
    rowfit = colfit = None
    for _ in range(2):
        # rows (storeys) from the row profile over the window columns, then columns from the column profile in the window rows
        W = valid[:, colw]
        rp = F[:, colw].sum(1) / np.maximum(W.sum(1), 1)
        rok = upper_rows & (W.mean(1) > 0.35)
        rowfit = comb_fit(rp, rok, ys, FLOOR_H, (0.3, 0.72), 0.04, 0.08)
        if rowfit is None:
            return None, "no_rows"
        rowfit = _refine(rp, rok, ys, rowfit, FLOOR_H, (0.3, 0.72))
        _, f, rph, wh = rowfit
        d = np.abs(((ys - rph) + f / 2) % f - f / 2)
        inrow = (d < wh / 2) & upper_rows
        V = valid[inrow]
        cp = F[inrow].sum(0) / np.maximum(V.sum(0), 1)
        cok = V.mean(0) > 0.35
        colfit = comb_fit(cp, cok, xs, (PITCH[0], min(PITCH[1], max(PITCH[0] + 0.1, len_m * 0.9))), (0.25, 0.8), 0.04, 0.08)
        if colfit is None:
            return None, "no_cols"
        colfit = _refine(cp, cok, xs, colfit, PITCH, (0.25, 0.8))
        _, p, cph, ww = colfit
        dc = np.abs(((xs - cph) + p / 2) % p - p / 2)
        colw = dc < ww / 2
        if colw.sum() < 3:
            return None, "no_cols"
    sc_r, f, rph, wh = rowfit
    sc_c, p, cph, ww = colfit
    # the grid's rows and columns that fall on the wall
    # the lowest upper-storey row: sill at 2.5 m or more (a lower band is the ground floor: shopfronts, raised-ground windows)
    first_r = rph - math.floor((rph - wh / 2 - 2.5) / f) * f
    while first_r - wh / 2 < 2.5:
        first_r += f
    while first_r - f - wh / 2 >= 2.5:
        first_r -= f
    nr = int(math.floor((top_m - 0.4 - (first_r + wh / 2)) / f)) + 1
    first_c = cph - math.floor(cph / p) * p
    if first_c - ww / 2 < -0.1 * ww:
        first_c += p
    nc = int(math.floor((len_m - (first_c + ww / 2)) / p + 0.1 * ww / p)) + 1
    if nr < 1 or nc < 1:
        return None, "empty_grid"
    # washed-out or smeared texels (the fill where the photo did not see the wall, burnt-out highlights): flat over ~0.8 m. They
    # count as unobserved, so the grid is not cut back where the photo shows nothing
    gl = rgba[..., :3].astype(np.float32).mean(2) / 255.0
    kf = (max(3, int(round(0.8 / sy))), max(3, int(round(0.8 / sx))))
    m1 = ndi.uniform_filter(gl, kf)
    flat = np.sqrt(np.maximum(ndi.uniform_filter(gl * gl, kf) - m1 * m1, 0)) < FLAT_STD
    seen = valid & ~flat
    # cell presence: mean deviation in the cell's window vs the wall level between windows
    cells = np.zeros((nr, nc))
    obs_c = np.zeros((nr, nc), bool)
    between = valid & ~colw[None, :]
    base = float(np.median(F[between & upper_rows[:, None]])) if (between & upper_rows[:, None]).any() else 0.0
    for r in range(nr):
        yc = first_r + r * f
        rr = np.flatnonzero(np.abs(ys - yc) < wh / 2)
        for c in range(nc):
            xc = first_c + c * p
            cc = np.flatnonzero(np.abs(xs - xc) < ww / 2)
            if len(rr) < 2 or len(cc) < 2:
                continue
            blk = F[np.ix_(rr, cc)]
            vv = seen[np.ix_(rr, cc)]
            if vv.mean() < 0.5:
                continue
            obs_c[r, c] = True
            cells[r, c] = float(blk[vv].mean())
    if not obs_c.any():
        return None, "unobserved_cells"
    hi = float(np.percentile(cells[obs_c], 75))
    thr = max(base + 0.45 * (hi - base), base * 1.3 + 0.03)  # relative to the strip, and an absolute margin over the wall
    on = (cells > thr) & obs_c
    # A column or a top row is left out only where the photo shows blank wall: its whole bay (or the whole row band) mostly seen and
    # about as smooth as the wall between the windows. Window groups at another spacing (the comb's cells fall between their
    # windows) or an unobserved / washed-out band keep the grid, so the wall is never drawn blanker than the guess it replaces.
    blank_thr = base + BLANK_FRAC * (hi - base)
    band_rows = np.zeros(ph, bool)
    for r in range(nr):
        band_rows |= np.abs(ys - (first_r + r * f)) < wh / 2

    def confirmed_blank(rows_m, cols_m):
        region = seen[np.ix_(rows_m, cols_m)]
        if region.size == 0 or region.mean() < 0.5:
            return False
        return float(F[np.ix_(rows_m, cols_m)][region].mean()) < blank_thr

    rows_idx = np.flatnonzero(band_rows)
    col_on = np.ones(nc, bool)
    for c in range(nc):
        if on[:, c].any():
            continue
        col_on[c] = not confirmed_blank(rows_idx, np.flatnonzero(np.abs(xs - (first_c + c * p)) < p / 2))
    cols_all = np.arange(pw)
    while nr > 1 and not on[nr - 1].any() and confirmed_blank(np.flatnonzero(np.abs(ys - (first_r + (nr - 1) * f)) < wh / 2), cols_all):
        nr -= 1
    on, obs_c = on[:nr], obs_c[:nr]
    row_on = on.sum(1) > 0
    n_on = int(on.sum())
    win_w = ww + 2 * FRAME_M
    win_h = wh + 2 * FRAME_V
    sill0 = first_r - win_h / 2
    sill_h = float(np.clip(0.28 * f, 0.6, 1.1))
    g = sill0 - sill_h
    if g < 2.0:
        sill_h = max(0.2, sill0 - 2.0)
        g = sill0 - sill_h
    # ground floor: which bays of the column grid have an opening in the band below g (shopfront, door or window: the engine's
    # ground-floor kind decides which), from the deviation in the bay's opening vs the pier between bays at that height
    gm = 0
    g_obs = 0
    grows = np.flatnonzero((ys > 0.5) & (ys < g - 0.45))
    if len(grows) >= 3:
        gw = min(0.8 * p, max(win_w, 0.55 * p))
        piers = np.flatnonzero(np.abs(((xs - first_c) + p / 2) % p - p / 2) > gw / 2 + 0.1)
        Vg = valid[grows]
        pier_lvl = float(np.median(F[np.ix_(grows, piers)][Vg[:, piers]])) if len(piers) and Vg[:, piers].any() else base
        vals = []
        for c in range(nc):
            cc = np.flatnonzero(np.abs(xs - (first_c + c * p)) < gw / 2)
            if len(cc) < 2:
                vals.append(None)
                continue
            vv = Vg[:, cc]
            vals.append(float(F[np.ix_(grows, cc)][vv].mean()) if vv.mean() > 0.5 else None)
        seen = [v for v in vals if v is not None]
        if seen:
            g_obs = len(seen)
            hi_g = max(float(np.percentile(seen, 75)), pier_lvl + 0.02)
            for c, v in enumerate(vals):
                if v is None or v > pier_lvl + 0.35 * (hi_g - pier_lvl):
                    gm |= 1 << c  # unobserved bays keep an opening (the usual case)
    ground = {"gm": gm} if g_obs else {}
    why = []
    if not (WIN_W[0] <= win_w <= min(WIN_W[1], 0.92 * p)): why.append("win_w")
    if not (WIN_H[0] <= win_h <= min(WIN_H[1], 0.92 * f)): why.append("win_h")
    if n_on < 3: why.append("few_windows")
    if col_on.sum() == 0 or row_on.sum() == 0: why.append("empty")
    fill = n_on / max(1, int(obs_c.sum()))
    sharp = min(1.0, max(0.0, (min(sc_r, sc_c) - 0.35) / 0.6))  # comb contrast of the weaker axis
    conf = obs * sharp * min(1.0, n_on / 6) * (0.5 + 0.5 * fill)
    conf = float(np.clip(conf * 1.4, 0, 1))
    if why:
        conf = min(conf, 0.3)
    lay = {
        "u0": round(first_c - p / 2, 2), "p": round(p, 3), "n": int(nc), "w": round(win_w, 2),
        "cm": int(sum(1 << i for i in range(nc) if col_on[i])),
        "g": round(g, 2), "f": round(f, 3), "rows": int(nr),
        "rm": int(sum(1 << i for i in range(nr) if row_on[i])),
        "sill": round(sill_h, 2), "head": round(sill_h + win_h, 2),
        **ground,
        "conf": round(conf, 2),
    }
    if why:
        lay["why"] = why
    if debug is not None:
        debug.update(F=F, rp=rp, cp=cp, on=on, obs=obs_c)
    return lay, None


FLAT_STD = 0.02  # sRGB luminance std over ~0.8 m under which a texel counts as washed out / smeared (unobserved)
BLANK_FRAC = 0.25  # a bay or row band is blank wall when its deviation is within this share of the window contrast of the wall level
FRAME_M = 0.08  # the blob is the glazing; the opening adds the pale frame around it
FRAME_V = 0.2  # vertically: sill and head below / above the glazing (calibrated on the Nyhavn fronts: the band fit sees the panes, ~25 % short)


def layout_openings(lay: dict, len_m: float) -> list[dict]:
    """The openings a layout draws (what js/tsl-materials.js facadeCell draws: every row up to `rows`, the masked columns, the open ground
    bays), metres in the strip frame. `rm` is informational: the shader has no per-row mask."""
    out = []
    for r in range(lay["rows"]):
        v0 = lay["g"] + lay["sill"] + r * lay["f"]
        for c in range(lay["n"]):
            if not (lay["cm"] >> c) & 1:
                continue
            uc = lay["u0"] + (c + 0.5) * lay["p"]
            out.append({"u": [uc - lay["w"] / 2, uc + lay["w"] / 2], "v": [v0, v0 + lay["head"] - lay["sill"]], "kind": "window"})
    if "gm" in lay:
        gw = min(0.8 * lay["p"], max(lay["w"], 0.55 * lay["p"]))
        for c in range(lay["n"]):
            if (lay["gm"] >> c) & 1:
                uc = lay["u0"] + (c + 0.5) * lay["p"]
                out.append({"u": [uc - gw / 2, uc + gw / 2], "v": [0.0, max(1.8, lay["g"] - 0.45)], "kind": "ground"})
    return [o for o in out if o["u"][1] > 0 and o["u"][0] < len_m]


def building_layouts(bid: str, atlas: dict) -> dict:
    p = look_path(atlas["file"])
    if p is None:
        return {}
    im = np.asarray(Image.open(p).convert("RGBA"))
    walls = {}
    for w in atlas["walls"]:
        if w["h_m"] < MIN_WALL_H or w["len_m"] < MIN_WALL_LEN:
            continue
        x, y, pw, ph = w["px"]
        lay, why = fit_strip(im[y:y + ph, x:x + pw], w["len_m"], w["h_m"], w.get("eave_m"))
        key = f"{w['ring']}:{w['edge']}"
        if lay is None:
            walls[key] = {"conf": 0.0, "why": [why]}
        else:
            walls[key] = lay
    return walls


def compact(walls: dict) -> dict:
    """Drop what the engine does not read for low-confidence walls (keeps the file small)."""
    out = {}
    for k, w in walls.items():
        if w.get("conf", 0) < MIN_CONF:
            continue
        w = dict(w)
        w.pop("why", None)
        out[k] = w
    return out


def tile_job(tile: str) -> dict:
    t0 = time.time()
    app = TILES / tile / "appearance.json"
    if not app.exists():
        return {"tile": tile, "skipped": "no appearance"}
    doc = json.loads(app.read_text())
    out = {}
    st = {"buildings": 0, "walls": 0, "fitted": 0, "kept": 0, "reasons": {}}
    for bid, b in doc["buildings"].items():
        a = b.get("atlas")
        if not a:
            continue
        st["buildings"] += 1
        walls = building_layouts(bid, a)
        for w in walls.values():
            st["walls"] += 1
            if "u0" in w:
                st["fitted"] += 1
            for r in w.get("why", []):
                st["reasons"][r] = st["reasons"].get(r, 0) + 1
        kept = compact(walls)
        st["kept"] += len(kept)
        if kept:
            out[bid] = kept
    dst = TILES / tile / LAYER_FILE
    if out:
        dst.write_text(json.dumps({"format": FORMAT, "tile": tile, "buildings": out}, separators=(",", ":")))
    elif dst.exists():
        dst.unlink()
    st["tile"] = tile
    st["bytes"] = dst.stat().st_size if dst.exists() else 0
    st["t"] = round(time.time() - t0, 2)
    return st


def patch_index() -> None:
    """data/tiles/index.json: `layers.windows` (bytes) and `counts.windows` per tile that has the layer; dropped where it has none."""
    p = TILES / "index.json"
    index = json.loads(p.read_text())
    n = 0
    for tid, t in index["tiles"].items():
        f = TILES / tid / LAYER_FILE
        t.setdefault("layers", {}).pop(LAYER, None)
        t.setdefault("counts", {}).pop(LAYER, None)
        if f.exists():
            doc = json.loads(f.read_text())
            t["layers"][LAYER] = f.stat().st_size
            t["counts"][LAYER] = {"buildings": len(doc["buildings"]), "walls": sum(len(w) for w in doc["buildings"].values())}
            n += 1
    p.write_text(json.dumps(index, separators=(",", ":")))
    print(f"index: {LAYER} on {n} tiles")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run", "show", "index"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--resume", action="store_true", help="skip tiles that already have the layer (an interrupted run)")
    a = ap.parse_args(argv)
    if a.cmd == "index":
        patch_index()
        return 0
    if a.cmd == "show":
        bid = a.args[0]
        for tdir in sorted(TILES.iterdir()):
            p = tdir / "appearance.json"
            if not p.exists():
                continue
            b = json.loads(p.read_text())["buildings"].get(bid)
            if b and b.get("atlas"):
                print(json.dumps(building_layouts(bid, b["atlas"]), indent=1))
                return 0
        return 1
    tiles = sorted(p.name for p in TILES.iterdir() if (p / "appearance.json").exists()) if a.args in ([], ["all"]) else a.args
    if a.resume:
        tiles = [t for t in tiles if not (TILES / t / LAYER_FILE).exists()]
    tot = {"buildings": 0, "walls": 0, "fitted": 0, "kept": 0, "bytes": 0, "reasons": {}}
    t0 = time.time()
    with ProcessPoolExecutor(a.workers) as ex:
        for i, st in enumerate(ex.map(tile_job, tiles)):
            for k in ("buildings", "walls", "fitted", "kept", "bytes"):
                tot[k] += st.get(k, 0)
            for r, n in st.get("reasons", {}).items():
                tot["reasons"][r] = tot["reasons"].get(r, 0) + n
            if i % 25 == 0:
                print(i, len(tiles), json.dumps({k: tot[k] for k in ("buildings", "walls", "kept", "bytes")}), flush=True)
    tot["t"] = round(time.time() - t0, 1)
    print(json.dumps(tot))
    patch_index()
    return 0


if __name__ == "__main__":
    sys.exit(main())
