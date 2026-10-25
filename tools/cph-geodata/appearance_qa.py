"""QA outputs for appearance.py: coverage report and photo-vs-swatch contact sheet."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import appearance as A

NS37 = "gdk:1064715171"


def tone_class(rgb) -> str:
    r, g, b = rgb
    mx, mn = max(rgb), min(rgb)
    sat = (mx - mn) / mx if mx else 0
    lum = float(A.luminance(A.srgb2lin(np.array(rgb))))
    if sat < 0.10:
        return "white/light grey" if lum > 0.4 else ("grey" if lum > 0.12 else "dark grey")
    if r > g * 1.18 and r > b * 1.4 and lum < 0.35:
        return "red brick/brown"
    if r >= g >= b and sat < 0.35:
        return "beige/ochre/yellow" if g > b * 1.08 else "warm grey"
    return "other"


def write_stats(res: dict, root: Path, args) -> dict:
    scene, walls, roofs = res["scene"], res["walls_obs"], res["roofs_obs"]
    occ = [c["occluded_frac"] for c in walls.values()]
    best_dir: dict[str, int] = {}
    for c in walls.values():
        d = c["best"].split("_")[0]
        best_dir[d] = best_dir.get(d, 0) + 1
    st = dict(res["stats"])
    st.update({
        "occlusion": args.occlusion,
        "mean_occluded_frac_selected": round(float(np.mean(occ)), 3) if occ else None,
        "mean_px_per_wall": round(float(np.mean([c["px"] for c in walls.values()])), 1) if walls else None,
        "best_view_direction": best_dir,
    })
    p = root / "data" / "raw" / f"appearance_stats_{args.occlusion}.json"
    p.write_text(json.dumps(st))
    return st


def hist(vals, bins):
    h, e = np.histogram(vals, bins=bins)
    return " ".join(f"[{e[i]:.2f},{e[i + 1]:.2f}):{int(h[i])}" for i in range(len(h)))


def write_report(res: dict, root: Path, args):
    st = write_stats(res, root, args)
    scene, walls, roofs, geo = res["scene"], res["walls_obs"], res["roofs_obs"], res["geo"]
    B = geo["buildings"]
    L = ["# Appearance (M4 item 1) QA report", "",
         f"Occlusion mode: `{args.occlusion}`; views: {st['views']}; ID-buffer scale {st['scale']}; runtime {st['runtime_s']} s.", "",
         "## Coverage", "",
         f"- Walls with observed colour: **{st['walls_observed']} / {st['walls_total']} ({100 * st['walls_observed'] / st['walls_total']:.1f}%)**",
         f"- Roofs with observed colour: **{st['roofs_observed']} / {st['roofs_total']} ({100 * st['roofs_observed'] / st['roofs_total']:.1f}%)**",
         f"- Unseen walls filled (conf `inferred`): {st['fallback']}"]
    nb_any = sum(1 for b in B if any(w["conf"] == "observed" for w in b["observed"]["walls"]))
    L.append(f"- Buildings with at least one observed wall: {nb_any} / {len(B)}")
    # per-building wall coverage weighted by wall length
    tot_len = obs_len = 0.0
    for sid, S in enumerate(scene.surfaces):
        if S.kind == "wall":
            tot_len += scene.surf_len[sid] * scene.surf_height[sid]
            if sid in walls:
                obs_len += scene.surf_len[sid] * scene.surf_height[sid]
    L.append(f"- Observed share of wall area: {100 * obs_len / tot_len:.1f}%")
    L += ["", "## Distributions (observed walls)", ""]
    ang = [c["angle_deg"] for c in walls.values()]
    L.append(f"- Viewing angle to wall normal (deg): {hist(ang, [0, 15, 30, 45, 60, 75, 90])}")
    L.append(f"- Pixels per wall: {hist(np.log10([max(c['px'], 1) for c in walls.values()]), [0, 1.5, 2, 2.5, 3, 3.5, 4, 6])} (log10)")
    L.append(f"- Shadow fraction: {hist([c['shadow_frac'] for c in walls.values()], [0, .1, .25, .5, .75, .9, 1.01])}")
    L.append(f"- Views agreeing within 0.09 sRGB: {hist([c['agree'] for c in walls.values()], [1, 2, 3, 4, 6, 10, 100])}")
    L.append(f"- Shadow-corrected walls: {sum(c['shadow_corrected'] for c in walls.values())}")
    L.append(f"- Mean occluded share of candidate pixels (selected views): {st['mean_occluded_frac_selected']}")
    L.append(f"- Best view direction: {st['best_view_direction']}")
    cls: dict[str, int] = {}
    for c in walls.values():
        cls[tone_class(c["tone"])] = cls.get(tone_class(c["tone"]), 0) + 1
    L.append(f"- Wall colour classes: {cls}")
    hints: dict[str, int] = {}
    for b in B:
        r = b["observed"]["roof"]
        if r and r["conf"] == "observed":
            hints[r["type_hint"]] = hints.get(r["type_hint"], 0) + 1
    L.append(f"- Roof type hints: {hints}")
    # comparison across occlusion modes
    others = sorted((root / "data" / "raw").glob("appearance_stats_*.json"))
    if len(others) > 1:
        L += ["", "## Occlusion modes compared", "",
              "| mode | walls observed | roofs observed | mean occluded share | mean px/wall | runtime s |", "|---|---|---|---|---|---|"]
        for p in others:
            s = json.loads(p.read_text())
            L.append(f"| {s['occlusion']} | {s['walls_observed']}/{s['walls_total']} | {s['roofs_observed']}/{s['roofs_total']} | "
                     f"{s.get('mean_occluded_frac_selected')} | {s.get('mean_px_per_wall')} | {s['runtime_s']} |")
    if st.get("textures"):
        L += ["", "## Textures", "", f"{st['textures']}"]
    (root / args.report).write_text("\n".join(L) + "\n")
    print(f"wrote {args.report}", flush=True)
    contact_sheet(res, root, args)


def _font(sz):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf"):
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            pass
    return ImageFont.load_default()


def pick_buildings(res, n=12):
    B, scene = res["geo"]["buildings"], res["scene"]
    cen = np.array([A.ring_pts(b["ring"]).mean(0) for b in B])
    good = [i for i, b in enumerate(B) if sum(w["conf"] == "observed" for w in b["observed"]["walls"]) >= 3
            and b["observed"]["roof"]["conf"] == "observed"]
    ids = {b["id"]: i for i, b in enumerate(B)}
    chosen = []
    if NS37 in ids:
        chosen.append(ids[NS37])
        d = np.hypot(*(cen - cen[ids[NS37]]).T)
        near = [i for i in np.argsort(d) if i in set(good) and i != ids[NS37] and A.signed_area(A.ring_pts(B[i]["ring"])) > 150]
        chosen += near[:5]
    pool = np.array([i for i in good if i not in chosen])
    while len(chosen) < n and len(pool):
        dmin = np.min([np.hypot(*(cen[pool] - cen[c]).T) for c in chosen], axis=0) if chosen else np.zeros(len(pool))
        j = int(np.argmax(dmin))
        chosen.append(int(pool[j]))
        pool = np.delete(pool, j)
    return chosen


def contact_sheet(res, root: Path, args):
    B, scene, cams = res["geo"]["buildings"], res["scene"], res["cams"]
    short = {A.short_view(c["view_id"]): c for c in cams}
    raw = root / args.raw
    chosen = pick_buildings(res)
    f, fs = _font(13), _font(11)
    CW, CH = 760, 290
    cols = 2
    rows = (len(chosen) + cols - 1) // cols
    sheet = Image.new("RGB", (CW * cols, CH * rows), (24, 24, 26))
    dr = ImageDraw.Draw(sheet)
    for k, bi in enumerate(chosen):
        b = B[bi]
        ox, oy = (k % cols) * CW, (k // cols) * CH
        obs = b["observed"]
        ws = [w for w in obs["walls"] if w["conf"] == "observed"]
        ws.sort(key=lambda w: -w["px"])
        bestv = short[ws[0]["views"][0]]
        cam = A.Camera.from_pers(bestv["pers"])
        p = A.ring_pts(b["ring"])
        g, e = b["ground"], b["eave"]
        P = np.vstack([np.column_stack([p[:, 0], np.full(len(p), g), p[:, 1]]), np.column_stack([p[:, 0], np.full(len(p), e), p[:, 1]])])
        c, r, _ = cam.project(P)
        cr = bestv["crop"]
        pad = 40 + 0.15 * (c.max() - c.min())
        x0, x1 = int(max(cr["x0"], c.min() - pad)), int(min(cr["x1"], c.max() + pad))
        y0, y1 = int(max(cr["y0"], r.min() - pad)), int(min(cr["y1"], r.max() + pad))
        im = Image.open(raw / bestv["file"]).convert("RGB").crop((x0 - cr["x0"], y0 - cr["y0"], x1 - cr["x0"], y1 - cr["y0"]))
        sc = min(440 / im.width, 250 / im.height)
        im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
        d2 = ImageDraw.Draw(im)
        # footprint outline at eave height, thin, so one can see which building is meant
        q = [((c[len(p) + i] - x0) * sc, (r[len(p) + i] - y0) * sc) for i in range(len(p))]
        d2.line(q + [q[0]], fill=(255, 40, 40), width=1)
        sheet.paste(im, (ox + 8, oy + 28))
        dr.text((ox + 8, oy + 6), f"{b['id']}  {b.get('year') or ''}  eave {e - g:.0f} m  view {A.short_view(bestv['view_id'])[:22]}", font=f, fill=(235, 235, 235))
        # swatches
        sx, sy = ox + 460, oy + 34
        dr.text((sx, sy - 4), "walls (by pixel count)", font=fs, fill=(160, 160, 160))
        for j, w in enumerate(ws[:10]):
            xx, yy = sx + (j % 5) * 58, sy + 12 + (j // 5) * 62
            dr.rectangle([xx, yy, xx + 52, yy + 40], fill=tuple(int(round(v * 255)) for v in w["tone"]))
            dr.text((xx, yy + 42), f"e{w['edge']} {w['angle_deg']:.0f}d s{w['shadow_frac']:.1f}", font=fs, fill=(200, 200, 200))
        dr.text((sx, sy + 150), "roof", font=fs, fill=(160, 160, 160))
        rf = obs["roof"]
        if rf and rf.get("tone"):
            dr.rectangle([sx, sy + 164, sx + 52, sy + 204], fill=tuple(int(round(v * 255)) for v in rf["tone"]))
            dr.text((sx + 60, sy + 170), f"{rf.get('type_hint')} ({rf['conf']})", font=fs, fill=(200, 200, 200))
        if ws:
            m = np.median([w["tone"] for w in ws], axis=0)
            dr.rectangle([sx + 60, sy + 190, sx + 112, sy + 206], fill=tuple(int(round(v * 255)) for v in m))
            dr.text((sx + 118, sy + 192), "median wall", font=fs, fill=(200, 200, 200))
    out = root / args.sheet
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"wrote {out}", flush=True)
