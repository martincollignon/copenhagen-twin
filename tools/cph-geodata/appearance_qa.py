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
    return st


def hist(vals, bins):
    h, e = np.histogram(vals, bins=bins)
    return " ".join(f"[{e[i]:.2f},{e[i + 1]:.2f}):{int(h[i])}" for i in range(len(h)))


def sat(rgb) -> float:
    return A.sat_of(rgb)


def wall_metrics(geo: dict) -> dict:
    """Comparable v1/v2 numbers straight from the geodata JSON (both versions share the schema)."""
    tot = obs = sunlit = shadow = 0
    sat_sh, sat_su, blue_sh, brick_cls = [], [], [], 0
    bbr_brick_walls = bbr_brick_hue = 0
    cls: dict[str, int] = {}
    keyed = {}
    for b in geo["buildings"]:
        is_b = (b.get("wall_material") or "").lower() in A.BRICK_MATERIALS
        for w in b["observed"]["walls"]:
            tot += 1
            if not w["conf"].startswith("observed"):
                continue
            obs += 1
            t = w["tone"]
            c = tone_class(t)
            cls[c] = cls.get(c, 0) + 1
            brick_cls += c == "red brick/brown"
            if is_b:
                bbr_brick_walls += 1
                bbr_brick_hue += A.is_brick_hue(t)
            if w.get("shadow_corrected"):
                shadow += 1
                sat_sh.append(sat(t))
                blue_sh.append(t[2] - t[0])
            else:
                sunlit += 1
                sat_su.append(sat(t))
            keyed[(b["id"], w["ring"], w["edge"])] = w
    return {"walls_total": tot, "observed": obs, "sunlit": sunlit, "shadow": shadow,
            "sat_shadow": float(np.mean(sat_sh)) if sat_sh else None, "sat_sunlit": float(np.mean(sat_su)) if sat_su else None,
            "blue_excess_shadow": float(np.mean(blue_sh)) if blue_sh else None,
            "brick_class": brick_cls, "bbr_brick_walls": bbr_brick_walls, "bbr_brick_hue": bbr_brick_hue,
            "classes": cls, "keyed": keyed}


def write_report(res: dict, root: Path, args):
    st = write_stats(res, root, args)
    scene, walls, roofs, geo = res["scene"], res["walls_obs"], res["roofs_obs"], res["geo"]
    B = geo["buildings"]
    v1p = root / args.v1
    v1 = json.loads(v1p.read_text()) if v1p.exists() else None
    m2 = wall_metrics(geo)
    m1 = wall_metrics(v1) if v1 else None
    L = ["# Appearance (M4) QA report - v2 (sunlit-view selection, shadow white balance, brick prior)", "",
         f"Occlusion mode: `{args.occlusion}`; views: {st['views']} (2025 + 2023 collections); ID-buffer scale {st['scale']}; runtime {st['runtime_s']} s.", ""]
    if m1:
        def pct(a, b):
            return f"{100 * a / b:.1f}%"
        sh_keys = [k for k, w in m1["keyed"].items() if w.get("shadow_corrected")]
        matched = [m2["keyed"][k] for k in sh_keys if k in m2["keyed"]]
        sat_matched_v1 = float(np.mean([sat(m1["keyed"][k]["tone"]) for k in sh_keys if k in m2["keyed"]]))
        sat_matched_v2 = float(np.mean([sat(w["tone"]) for w in matched]))
        still_sh = sum(1 for w in matched if w.get("shadow_corrected"))
        L += ["## Before / after (v1 = 2025 only, luminance boost; v2 = this run)", "",
              "| metric | v1 | v2 |", "|---|---|---|",
              f"| walls with observed colour | {m1['observed']}/{m1['walls_total']} ({pct(m1['observed'], m1['walls_total'])}) | {m2['observed']}/{m2['walls_total']} ({pct(m2['observed'], m2['walls_total'])}) |",
              f"| observed walls sourced from a sunlit view | {m1['sunlit']} ({pct(m1['sunlit'], m1['observed'])} of observed; {pct(m1['sunlit'], m1['walls_total'])} of all walls) | {m2['sunlit']} ({pct(m2['sunlit'], m2['observed'])} of observed; {pct(m2['sunlit'], m2['walls_total'])} of all walls) |",
              f"| observed walls sourced from shadow only | {m1['shadow']} | {m2['shadow']} (white-balanced) |",
              f"| mean saturation, shadow-sourced walls | {m1['sat_shadow']:.3f} | {m2['sat_shadow']:.3f} |",
              f"| mean blue-minus-red (sRGB), shadow-sourced walls | {m1['blue_excess_shadow']:+.3f} | {m2['blue_excess_shadow']:+.3f} |",
              f"| mean saturation, sunlit-sourced walls (reference) | {m1['sat_sunlit']:.3f} | {m2['sat_sunlit']:.3f} |",
              f"| walls classed red brick/brown | {m1['brick_class']} | {m2['brick_class']} |",
              f"| walls of BBR `mursten` buildings with brick hue | {m1['bbr_brick_hue']}/{m1['bbr_brick_walls']} | {m2['bbr_brick_hue']}/{m2['bbr_brick_walls']} |",
              "",
              f"Same {len(sh_keys)} walls that v1 had to take from shadow: mean saturation {sat_matched_v1:.3f} (v1) -> {sat_matched_v2:.3f} (v2); "
              f"{len(sh_keys) - still_sh} of them are now sourced from a sunlit view, {still_sh} remain shadow-sourced "
              f"({sum(1 for k in sh_keys if k not in m2['keyed'])} lost their observation).", ""]
    L += ["## Coverage", "",
          f"- Walls with observed colour: **{st['walls_observed']} / {st['walls_total']} ({100 * st['walls_observed'] / st['walls_total']:.1f}%)**",
          f"- Roofs with observed colour: **{st['roofs_observed']} / {st['roofs_total']} ({100 * st['roofs_observed'] / st['roofs_total']:.1f}%)**",
          f"- Unseen walls filled (conf `inferred`): {st['fallback']}"]
    nb_any = sum(1 for b in B if any(w["conf"].startswith("observed") for w in b["observed"]["walls"]))
    L.append(f"- Buildings with at least one observed wall: {nb_any} / {len(B)}")
    tot_len = obs_len = 0.0
    for sid, S in enumerate(scene.surfaces):
        if S.kind == "wall":
            tot_len += scene.surf_len[sid] * scene.surf_height[sid]
            if sid in walls:
                obs_len += scene.surf_len[sid] * scene.surf_height[sid]
    L.append(f"- Observed share of wall area: {100 * obs_len / tot_len:.1f}%")
    yrs: dict[int, int] = {}
    for c in walls.values():
        yrs[c["year"]] = yrs.get(c["year"], 0) + 1
    L.append(f"- Observed walls by source year: {yrs}")
    fl: dict[str, int] = {}
    for c in list(walls.values()) + list(roofs.values()):
        for f in c["flags"]:
            fl[f] = fl.get(f, 0) + 1
    L.append(f"- Flags: {fl} (`year_disagree` = sunlit 2023 and 2025 colours differ strongly: kept 2025, flagged as probably repainted)")
    L.append(f"- Brick prior applied (conf `observed+prior`): {st['brick_prior_walls']} walls")
    L += ["", "## Lighting calibration (per view, from lit/shadow pixels of the same surface)", ""]
    cal = res["cal"]
    by_src: dict[str, int] = {}
    for c in cal.values():
        by_src[c["src"]] = by_src.get(c["src"], 0) + 1
    L.append(f"- Estimate source per view: {by_src}")
    for y in sorted({A.view_year(v) for v in cal}):
        cs = [c for v, c in cal.items() if A.view_year(v) == y]
        L.append(f"- {y}: median shadow->lit gain G = {np.median([c['G'] for c in cs]):.2f}; median wall skylight cast k (r,g,b; lum=1) = "
                 f"{np.round(np.median([c['k_wall'] for c in cs], axis=0), 2).tolist()}; median pairs/view = {int(np.median([c['n_wall'] + c['n_roof'] for c in cs]))}")
    L += ["", "## Distributions (observed walls)", ""]
    ang = [c["angle_deg"] for c in walls.values()]
    L.append(f"- Viewing angle to wall normal (deg): {hist(ang, [0, 15, 30, 45, 60, 75, 90])}")
    L.append(f"- Pixels per wall: {hist(np.log10([max(c['px'], 1) for c in walls.values()]), [0, 1.5, 2, 2.5, 3, 3.5, 4, 6])} (log10)")
    L.append(f"- Shadow fraction of chosen views: {hist([c['shadow_frac'] for c in walls.values()], [0, .1, .25, .5, .75, .9, 1.01])}")
    L.append(f"- Views agreeing within 0.09 sRGB: {hist([c['agree'] for c in walls.values()], [1, 2, 3, 4, 6, 10, 100])}")
    L.append(f"- Mean occluded share of candidate pixels (selected views): {st['mean_occluded_frac_selected']}")
    L.append(f"- Best view direction: {st['best_view_direction']}")
    L.append(f"- Wall colour classes: {m2['classes']}")
    hints: dict[str, int] = {}
    for b in B:
        r = b["observed"]["roof"]
        if r and r["conf"] == "observed":
            hints[r["type_hint"]] = hints.get(r["type_hint"], 0) + 1
    L.append(f"- Roof type hints: {hints}")
    npit = sum(1 for b in B if b["observed"]["roof"].get("pitched"))
    npit_obs = sum(1 for b in B if b["observed"]["roof"].get("pitched") and b["observed"]["roof"]["conf"] == "observed")
    pit_nad = sum(1 for sid, c in roofs.items() if c["pitched_sampled"] and c["views"] and c["views"][0].startswith("nadir"))
    L.append(f"- Pitched roofs (DSM ridge - eave > 1.5 m): {npit} flagged, {npit_obs} observed, sampled on the DSM surface; best view nadir for {pit_nad}, oblique for {npit_obs - pit_nad}")
    if st.get("textures"):
        L += ["", "## Textures", "", f"{st['textures']}"]
    (root / args.report).write_text("\n".join(L) + "\n")
    print(f"wrote {args.report}", flush=True)
    contact_sheet(res, root, args, v1)


def _font(sz):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf"):
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            pass
    return ImageFont.load_default()


V1_TWELVE = ["gdk:1064715171", "gdk:1064714567", "gdk:1064715029", "gdk:1107312678", "gdk:1064714572", "gdk:1064715026",
             "gdk:1064712705", "gdk:1064716464", "gdk:1241239835", "gdk:1213434780", "gdk:1064716971", "gdk:1064713864"]


def pick_brick(v1: dict | None, exclude: list[str], n: int = 4) -> list[str]:
    """Buildings that are BBR `mursten` AND had confidently red-brown walls already in v1."""
    if not v1:
        return []
    cand = []
    for b in v1["buildings"]:
        if b["id"] in exclude or (b.get("wall_material") or "").lower() not in A.BRICK_MATERIALS:
            continue
        ws = [w for w in b["observed"]["walls"] if w["conf"] == "observed" and not w.get("shadow_corrected")
              and A.is_brick_hue(w["tone"])]
        if len(ws) >= 1:
            cand.append((sum(w["px"] for w in ws), b["id"]))
    cand.sort(reverse=True)
    pool = [c[1] for c in cand[:40]]
    step = max(1, len(pool) // n)
    return pool[::step][:n]


def contact_sheet(res, root: Path, args, v1: dict | None = None):
    B, scene, cams = res["geo"]["buildings"], res["scene"], res["cams"]
    by_id = {b["id"]: i for i, b in enumerate(B)}
    v1_by = {b["id"]: b for b in v1["buildings"]} if v1 else {}
    ids = [i for i in V1_TWELVE if i in by_id]
    brick = pick_brick(v1, ids)
    ids += brick
    short = {A.short_view(c["view_id"]): c for c in cams}
    f, fs = _font(13), _font(11)
    CW, CH = 900, 340
    cols = 2
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new("RGB", (CW * cols, CH * rows), (24, 24, 26))
    dr = ImageDraw.Draw(sheet)

    def rgb(t):
        return tuple(int(round(v * 255)) for v in t)
    for k, bid in enumerate(ids):
        b = B[by_id[bid]]
        b1 = v1_by.get(bid)
        ox, oy = (k % cols) * CW, (k // cols) * CH
        obs = b["observed"]
        ws = [w for w in obs["walls"] if w["conf"].startswith("observed")]
        ws.sort(key=lambda w: -w["px"])
        tag = "BRICK " if bid in brick else ""
        if not ws:
            dr.text((ox + 8, oy + 6), f"{tag}{bid}: no observed walls", font=f, fill=(235, 235, 235))
            continue
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
        im = Image.open(bestv["_raw_dir"] / bestv["file"]).convert("RGB").crop((x0 - cr["x0"], y0 - cr["y0"], x1 - cr["x0"], y1 - cr["y0"]))
        sc = min(360 / im.width, 280 / im.height)
        im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
        d2 = ImageDraw.Draw(im)
        q = [((c[len(p) + i] - x0) * sc, (r[len(p) + i] - y0) * sc) for i in range(len(p))]
        d2.line(q + [q[0]], fill=(255, 40, 40), width=1)
        sheet.paste(im, (ox + 8, oy + 28))
        dr.text((ox + 8, oy + 6), f"{tag}{bid} {b.get('year') or ''} {b.get('wall_material') or ''} | photo {A.short_view(bestv['view_id'])[:24]}",
                font=f, fill=(235, 235, 235))
        sx, sy = ox + 380, oy + 26
        v1w = {(w["ring"], w["edge"]): w for w in (b1["observed"]["walls"] if b1 else [])}
        top = ws[:7]
        dr.text((sx, sy), "v1 (top) vs v2 (bottom); label: edge, source year, S=sunlit / W=white-balanced shadow, P=brick prior", font=fs, fill=(160, 160, 160))
        for j, w in enumerate(top):
            xx = sx + j * 72
            w1 = v1w.get((w["ring"], w["edge"]))
            if w1:
                dr.rectangle([xx, sy + 16, xx + 66, sy + 66], fill=rgb(w1["tone"]))
                dr.text((xx, sy + 68), f"v1 e{w['edge']} {'sh' if w1.get('shadow_corrected') else 'sun'}", font=fs, fill=(190, 190, 190))
            dr.rectangle([xx, sy + 88, xx + 66, sy + 138], fill=rgb(w["tone"]))
            lab = ("S" if w.get("sunlit") else "W") + ("P" if w.get("prior") else "") + ("!" if w.get("flags") else "")
            dr.text((xx, sy + 140), f"v2 e{w['edge']} {w.get('year')} {lab}", font=fs, fill=(235, 235, 235))
        # roof
        ry = sy + 172
        dr.text((sx, ry), "roof v1 / v2", font=fs, fill=(160, 160, 160))
        r1 = b1["observed"]["roof"] if b1 else None
        r2 = obs["roof"]
        if r1 and r1.get("tone"):
            dr.rectangle([sx, ry + 14, sx + 66, ry + 54], fill=rgb(r1["tone"]))
        if r2 and r2.get("tone"):
            dr.rectangle([sx + 76, ry + 14, sx + 142, ry + 54], fill=rgb(r2["tone"]))
            dr.text((sx + 150, ry + 18), f"{r2.get('type_hint')} {'PITCHED +' + str(r2.get('ridge_rise_m')) + 'm' if r2.get('pitched') else 'flat'} "
                    f"{'sun' if r2.get('sunlit') else 'shadow'} {r2.get('year') or ''} via {r2.get('views', [''])[0][:14] if r2.get('views') else ''}", font=fs, fill=(210, 210, 210))
        med = lambda w_: np.median([x["tone"] for x in w_], axis=0)
        if b1:
            w1s = [w for w in b1["observed"]["walls"] if w["conf"] == "observed"]
            if w1s:
                dr.text((sx, ry + 62), "median observed wall v1 / v2", font=fs, fill=(160, 160, 160))
                dr.rectangle([sx, ry + 76, sx + 66, ry + 106], fill=rgb(med(w1s)))
        dr.rectangle([sx + 76, ry + 76, sx + 142, ry + 106], fill=rgb(med(ws)))
        nsun = sum(1 for w in ws if w.get("sunlit"))
        dr.text((sx + 150, ry + 82), f"{len(ws)} walls observed, {nsun} sunlit-sourced", font=fs, fill=(210, 210, 210))
    out = root / args.sheet
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"wrote {out}", flush=True)
