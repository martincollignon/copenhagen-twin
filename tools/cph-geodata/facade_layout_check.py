#!/usr/bin/env python3
"""Checks for the measured window layouts (tools/cph-geodata/facade_layout.py, docs/facade-layout.md).

    nyhavn   the photo-traced Nyhavn 9-17 fronts (~/.local/share/cph-twin/overrides/nyhavn, 81 openings, `round` ones left out) against
             the openings the fitted grid draws: precision / recall at IoU >= 0.5 and >= 0.3 and the mean IoU of the matches, once as
             traced and once after the best rigid shift of each traced front (within +-2 m): the tracing comes from street photos
             registered by hand, the atlas from the engine's wall frame, and they disagree by up to ~1.3 m on some fronts
    sheet    a contact sheet of N random walls (seeded) across the city: the atlas strip and the fitted grid on it (green: kept,
             red: below the confidence cutoff; yellow: ground-floor bays), in chunks of six, for a hand check
    stats    coverage of the data/tiles/*/windows.json layers: buildings and walls with a layout, the share of photographed wall area
             they cover, bytes
    regress  walls whose measured layout draws less upper-storey window area than the guessed grid it replaces (< 80 %) although the
             photo does not confirm blank wall in every region it leaves out (blind column bays, bays beyond the measured columns,
             storeys above the last row): the regressions the fallback rules must prevent

    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout_check.py nyhavn [--out docs/windows/nyhavn.jpg]
    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout_check.py sheet --seed 11 --n 30 --out docs/windows/sheet
    uv run --with pillow --with numpy --with scipy python tools/cph-geodata/facade_layout_check.py stats
"""
from __future__ import annotations

import argparse
import gzip
import json
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import facade_layout as FLY  # noqa: E402

ROOT = FLY.ROOT
NYHAVN = Path.home() / ".local/share/cph-twin/overrides/nyhavn/overrides.json"
NYHAVN_FRONTS = [("gdk:1064714861", 5), ("gdk:1064715124", 12), ("gdk:1088186424", 15), ("gdk:1111146131", 3), ("gdk:1202806702", 19)]
NYHAVN_TILE = "1451_12352"


def iou(a, b):
    iu = max(0.0, min(a["u"][1], b["u"][1]) - max(a["u"][0], b["u"][0]))
    iv = max(0.0, min(a["v"][1], b["v"][1]) - max(a["v"][0], b["v"][0]))
    inter = iu * iv
    area = lambda o: (o["u"][1] - o["u"][0]) * (o["v"][1] - o["v"][0])  # noqa: E731
    return inter / (area(a) + area(b) - inter) if inter > 0 else 0.0


def match(gt, pr):
    """Greedy one-to-one matching by IoU: [(iou, gt index, prediction index)]."""
    pairs = sorted(((iou(g, p), i, j) for i, g in enumerate(gt) for j, p in enumerate(pr)), reverse=True)
    ug, up, out = set(), set(), []
    for s, i, j in pairs:
        if s <= 0:
            break
        if i in ug or j in up:
            continue
        ug.add(i)
        up.add(j)
        out.append((s, i, j))
    return out


def shifted(gt, du, dv):
    return [dict(o, u=[o["u"][0] + du, o["u"][1] + du], v=[o["v"][0] + dv, o["v"][1] + dv]) for o in gt]


def strip_of(atlas, ring, edge):
    w = next((w for w in atlas["walls"] if str(w["ring"]) == str(ring) and int(w["edge"]) == int(edge)), None)
    p = FLY.look_path(atlas["file"])
    if not w or not p:
        return None, None
    im = np.asarray(Image.open(p).convert("RGBA"))
    x, y, pw, ph = w["px"]
    return w, im[y:y + ph, x:x + pw]


def draw(strip, w, groups, scale=5):
    ph, pw = strip.shape[:2]
    img = Image.fromarray(strip[..., :3]).resize((pw * scale, ph * scale), Image.BILINEAR)
    d = ImageDraw.Draw(img)
    sx, sy = pw * scale / w["len_m"], ph * scale / w["h_m"]
    for ops, colour in groups:
        for o in ops:
            c = colour(o) if callable(colour) else colour
            d.rectangle([o["u"][0] * sx, (w["h_m"] - o["v"][1]) * sy, o["u"][1] * sx, (w["h_m"] - o["v"][0]) * sy], outline=c, width=2)
    return img


def cmd_nyhavn(a):
    app = json.loads((ROOT / "data/tiles" / NYHAVN_TILE / "appearance.json").read_text())
    ov = json.loads(NYHAVN.read_text())
    tot = {"gt": 0, "pred": 0}
    acc = {"raw": {"tp5": 0, "tp3": 0, "ious": []}, "registered": {"tp5": 0, "tp3": 0, "ious": []}}
    rows, panels = [], []
    for gid, e in NYHAVN_FRONTS:
        atlas = app["buildings"][gid]["atlas"]
        w, strip = strip_of(atlas, 0, e)
        lay, why = FLY.fit_strip(strip, w["len_m"], w["h_m"], w.get("eave_m"))
        gt = [dict(o, v=[max(o["v"][0], 0.0), o["v"][1]]) for o in ov["buildings"][gid]["details"]["openings"] if o["kind"] != "round"]
        pr = FLY.layout_openings(lay, w["len_m"]) if lay else []
        kept = bool(lay) and lay["conf"] >= FLY.MIN_CONF
        best = (sum(s for s, _, _ in match(gt, pr)), 0.0, 0.0)
        for du in np.arange(-2, 2.001, 0.1):
            for dv in np.arange(-2, 2.001, 0.1):
                sc = sum(s for s, _, _ in match(shifted(gt, du, dv), pr))
                if sc > best[0] + 1e-9:
                    best = (sc, float(du), float(dv))
        row = {"building": gid, "edge": e, "gt": len(gt), "pred": len(pr), "conf": lay["conf"] if lay else None, "kept": kept,
               "why": why or (lay or {}).get("why"), "shift": [round(best[1], 1), round(best[2], 1)]}
        for name, g in (("raw", gt), ("registered", shifted(gt, best[1], best[2]))):
            m = match(g, pr)
            row[name] = {"tp@0.5": sum(1 for s, _, _ in m if s >= 0.5), "tp@0.3": sum(1 for s, _, _ in m if s >= 0.3)}
            acc[name]["tp5"] += row[name]["tp@0.5"]
            acc[name]["tp3"] += row[name]["tp@0.3"]
            acc[name]["ious"] += [s for s, _, _ in m if s >= 0.3]
        tot["gt"] += len(gt)
        tot["pred"] += len(pr)
        rows.append(row)
        panels.append(draw(strip, w, [(shifted(gt, best[1], best[2]), (255, 0, 255)), (pr, lambda o: (0, 255, 0) if o["kind"] == "window" else (255, 200, 0))]))
    summary = {"fronts": rows, **tot}
    for name, v in acc.items():
        summary[name] = {"precision@0.5": round(v["tp5"] / max(tot["pred"], 1), 3), "recall@0.5": round(v["tp5"] / tot["gt"], 3),
                         "precision@0.3": round(v["tp3"] / max(tot["pred"], 1), 3), "recall@0.3": round(v["tp3"] / tot["gt"], 3),
                         "meanIoU(matches>=0.3)": round(float(np.mean(v["ious"])), 3) if v["ious"] else 0.0}
    print(json.dumps(summary, indent=1))
    if a.out:
        W = sum(p.width for p in panels) + 10 * len(panels)
        out = Image.new("RGB", (W, max(p.height for p in panels)), (25, 25, 25))
        x = 0
        for p in panels:
            out.paste(p, (x, 0))
            x += p.width + 10
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        out.save(a.out, quality=80)
        (Path(a.out).with_suffix(".json")).write_text(json.dumps(summary, indent=1))


def cmd_sheet(a):
    rng = random.Random(a.seed)
    tiles = sorted(p for p in (ROOT / "data/tiles").iterdir() if (p / "appearance.json").exists())
    picks = []
    while len(picks) < a.n:
        t = rng.choice(tiles)
        d = json.loads((t / "appearance.json").read_text())
        cands = [(bid, b["atlas"], w) for bid, b in d["buildings"].items() if b.get("atlas") for w in b["atlas"]["walls"]
                 if w["h_m"] >= a.min_h and w["len_m"] >= a.min_len]
        if not cands:
            continue
        bid, at, w = rng.choice(cands)
        if FLY.look_path(at["file"]):
            picks.append((t.name, bid, at, w))
    cells, listing = [], []
    from PIL import ImageFont  # noqa: F401
    for i, (tn, bid, at, w) in enumerate(picks):
        w, strip = strip_of(at, w["ring"], w["edge"])
        ph, pw = strip.shape[:2]
        lay, why = FLY.fit_strip(strip, w["len_m"], w["h_m"], w.get("eave_m"))
        kept = bool(lay) and lay["conf"] >= FLY.MIN_CONF
        S = max(2, min(6, int(360 / max(ph, 1)), int(600 / max(pw, 1))))
        base = draw(strip, w, [], S)
        ops = FLY.layout_openings(lay, w["len_m"]) if lay else []
        ov = draw(strip, w, [(ops, lambda o: ((0, 255, 0) if kept else (255, 80, 80)) if o["kind"] == "window" else (255, 200, 0))], S)
        cell = Image.new("RGB", (base.width * 2 + 6, base.height + 28), (25, 25, 25))
        cell.paste(base, (0, 28))
        cell.paste(ov, (base.width + 6, 28))
        d = ImageDraw.Draw(cell)
        text = f"#{i} {bid} {w['ring']}:{w['edge']} {w['len_m']}x{w['h_m']} m " + (f"conf {lay['conf']} {lay['n']} cols x {lay['rows']} rows" if lay else f"no grid: {why}")
        d.text((2, 2), text, fill=(255, 255, 255))
        d.text((2, 14), "KEPT" if kept else "fallback (procedural)", fill=(0, 255, 0) if kept else (255, 120, 120))
        cells.append(cell)
        listing.append({"i": i, "tile": tn, "building": bid, "wall": f"{w['ring']}:{w['edge']}", "len_m": w["len_m"], "h_m": w["h_m"],
                        "kept": kept, "conf": lay["conf"] if lay else None, "why": why or (lay or {}).get("why")})
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for ci in range(0, len(cells), 6):
        chunk = cells[ci:ci + 6]
        rows = [chunk[i:i + 3] for i in range(0, len(chunk), 3)]
        Wt = max(sum(c.width + 8 for c in r) for r in rows)
        Ht = sum(max(c.height for c in r) + 8 for r in rows)
        sheet = Image.new("RGB", (Wt, Ht), (10, 10, 10))
        y = 0
        for r in rows:
            x = 0
            for c in r:
                sheet.paste(c, (x, y))
                x += c.width + 8
            y += max(c.height for c in r) + 8
        sheet.save(out / f"sheet-{a.seed}-{ci // 6}.jpg", quality=82)
    (out / f"sheet-{a.seed}.json").write_text(json.dumps(listing, indent=1))
    print(json.dumps(listing, indent=1))


def cmd_stats(a):
    tiles = sorted(p for p in (ROOT / "data/tiles").iterdir() if (p / "appearance.json").exists())
    st = {"tiles": 0, "atlasBuildings": 0, "atlasWalls": 0, "atlasArea": 0.0, "layoutTiles": 0, "layoutBuildings": 0, "layoutWalls": 0,
          "layoutArea": 0.0, "bytes": 0, "gzipBytes": 0, "windows": 0}
    for t in tiles:
        st["tiles"] += 1
        app = json.loads((t / "appearance.json").read_text())
        lay_p = t / "windows.json"
        lays = json.loads(lay_p.read_text())["buildings"] if lay_p.exists() else {}
        if lay_p.exists():
            raw = lay_p.read_bytes()
            st["layoutTiles"] += 1
            st["bytes"] += len(raw)
            st["gzipBytes"] += len(gzip.compress(raw, 9))
        for bid, b in app["buildings"].items():
            at = b.get("atlas")
            if not at:
                continue
            st["atlasBuildings"] += 1
            L = lays.get(bid, {})
            if L:
                st["layoutBuildings"] += 1
            for w in at["walls"]:
                area = w["len_m"] * w.get("eave_m", w["h_m"])
                st["atlasWalls"] += 1
                st["atlasArea"] += area
                lw = L.get(f"{w['ring']}:{w['edge']}")
                if lw:
                    st["layoutWalls"] += 1
                    st["layoutArea"] += area
                    st["windows"] += lw["rows"] * bin(lw["cm"]).count("1")
    st["areaShare"] = round(st["layoutArea"] / max(st["atlasArea"], 1), 3)
    st["buildingShare"] = round(st["layoutBuildings"] / max(st["atlasBuildings"], 1), 3)
    st["bytesPerBuilding"] = round(st["bytes"] / max(st["layoutBuildings"], 1), 1)
    st["gzipBytesPerBuilding"] = round(st["gzipBytes"] / max(st["layoutBuildings"], 1), 1)
    st["atlasArea"] = round(st["atlasArea"])
    st["layoutArea"] = round(st["layoutArea"])
    print(json.dumps(st, indent=1))
    if a.out:
        Path(a.out).write_text(json.dumps(st, indent=1))


# ------------------------------------------------------------------------------------------------------------------- regressions
CORNER_PIER = 0.9  # js/facade-style.js FACADE_CORNER_PIER
WINDOW_RATIO_Y = 0.64  # js/facade-style.js WINDOW.ratioY


def guessed_area(b, len_m, top):
    """Upper-storey window area (m2) of the engine's guessed grid on a wall (js/building-geometry.js + facadeCell)."""
    f = b.get("facade") or {}
    ground_h = f.get("ground_floor_h") or f.get("floor_h") or 3.0
    nominal = f.get("floor_h") or 3.0
    upper = max(top - ground_h, 0.0)
    floor_h = upper / max(1, round(upper / nominal)) if upper > nominal * 0.5 else nominal
    rows = int(round(upper / floor_h)) if upper > nominal * 0.5 else 0
    bay_w = f.get("bay_w") or 3.0
    pier = min(CORNER_PIER, len_m * 0.2)
    inner = len_m - 2 * pier
    bays = max(1, round(inner / bay_w))
    bw = inner / bays
    ww = min(max((f.get("window_w") or 1.2) / bay_w, 0.12), 0.85) * bw
    return rows * bays * ww * WINDOW_RATIO_Y * floor_h


def wall_regression(strip, w, lay, b, extended):
    """(drawn area, guessed area, regressed?) of one measured wall. `extended`: the engine continues the grid beyond the measured
    columns (this PR's fix); else the wall beyond them is blank (the first version)."""
    len_m, h_m = w["len_m"], w["h_m"]
    top = min(h_m, w.get("eave_m") or h_m)
    ph, pw = strip.shape[:2]
    sx, sy = len_m / pw, h_m / ph
    F, valid = FLY.deviation_map(strip, sx, sy)
    F = __import__("scipy.ndimage", fromlist=["x"]).grey_closing(F, size=(max(2, int(round(0.3 / sy))), max(2, int(round(0.3 / sx))))) * valid
    gl = strip[..., :3].astype(np.float32).mean(2) / 255.0
    from scipy import ndimage as ndi
    kf = (max(3, int(round(0.8 / sy))), max(3, int(round(0.8 / sx))))
    m1 = ndi.uniform_filter(gl, kf)
    seen = valid & ~(np.sqrt(np.maximum(ndi.uniform_filter(gl * gl, kf) - m1 * m1, 0)) < FLY.FLAT_STD)
    ys = h_m - (np.arange(ph) + 0.5) * sy
    xs = (np.arange(pw) + 0.5) * sx
    p, n, ww, f, g, sill, head = lay["p"], lay["n"], lay["w"], lay["f"], lay["g"], lay["sill"], lay["head"]
    wh = head - sill
    centres = [lay["u0"] + (c + 0.5) * p for c in range(n)]
    upper = (ys > g) & (ys < top)
    near_col = np.zeros(pw, bool)
    for uc in centres:
        near_col |= np.abs(xs - uc) < ww / 2
    sel = seen & upper[:, None] & ~near_col[None, :]
    base = float(np.median(F[sel])) if sel.any() else 0.0
    cellv = []
    for r in range(lay["rows"]):
        rr = np.abs(ys - (g + r * f + sill + wh / 2)) < wh / 2
        for c, uc in enumerate(centres):
            if (lay["cm"] >> c) & 1:
                m = seen & rr[:, None] & (np.abs(xs - uc) < ww / 2)[None, :]
                if m.any():
                    cellv.append(float(F[m].mean()))
    hi = float(np.percentile(cellv, 75)) if cellv else base + 0.1
    thr = base + FLY.BLANK_FRAC * (hi - base)

    def blank(rows_m, cols_m):
        m = seen & rows_m[:, None] & cols_m[None, :]
        region = rows_m[:, None] & cols_m[None, :]
        if region.sum() == 0 or m.sum() < 0.5 * region.sum():
            return False
        return float(F[m].mean()) < thr

    band = np.zeros(ph, bool)
    for r in range(lay["rows"]):
        band |= np.abs(ys - (g + r * f + sill + wh / 2)) < wh / 2
    pier = min(CORNER_PIER, len_m * 0.2)
    cols = []  # (centre, drawn?) of every bay that lies on the wall
    for c in range(-int(len_m / p) - 2, n + int(len_m / p) + 2):
        uc = lay["u0"] + (c + 0.5) * p
        if 0 <= c < n:
            if uc - ww / 2 < 0 or uc + ww / 2 > len_m:
                continue
            cols.append((uc, bool((lay["cm"] >> c) & 1) if c < 32 else True))
        elif uc - p / 2 >= pier and uc + p / 2 <= len_m - pier:
            cols.append((uc, extended))
    rows = sum(1 for r in range(lay["rows"]) if g + r * f + head <= top + 0.05)
    drawn = rows * sum(1 for _, on in cols if on) * ww * wh
    dropped = [blank(band, np.abs(xs - uc) < p / 2) for uc, on in cols if not on]
    r = lay["rows"]
    while g + r * f + head <= top - 0.4:  # storeys above the last measured row
        dropped.append(blank(np.abs(ys - (g + r * f + sill + wh / 2)) < wh / 2, np.ones(pw, bool)))
        r += 1
    guess = guessed_area(b, len_m, top)
    return drawn, guess, drawn < 0.8 * guess and not all(dropped)


def _regress_tile(args):
    tid, layer_path, extended = args
    if not Path(layer_path).exists():
        return []
    lays = json.loads(Path(layer_path).read_text())["buildings"]
    app = json.loads((ROOT / "data/tiles" / tid / "appearance.json").read_text())["buildings"]
    recs = {b["id"]: b for b in json.loads((ROOT / "data/tiles" / tid / "buildings.json").read_text())["buildings"]}
    out = []
    for bid, walls in lays.items():
        at = app.get(bid, {}).get("atlas")
        if not at or bid not in recs:
            continue
        for key, lay in walls.items():
            ring, edge = key.split(":")
            w, strip = strip_of(at, ring, edge)
            if w is None:
                continue
            drawn, guess, reg = wall_regression(strip, w, lay, recs[bid], extended)
            out.append((tid, bid, key, round(drawn, 1), round(guess, 1), reg))
    return out


def cmd_regress(a):
    from concurrent.futures import ProcessPoolExecutor
    layer_dir = Path(a.layers) if a.layers else None
    tids = sorted(p.name for p in (ROOT / "data/tiles").iterdir() if (p / "appearance.json").exists())
    jobs = [(t, str(layer_dir / f"{t}.json") if layer_dir else str(ROOT / "data/tiles" / t / FLY.LAYER_FILE), not a.blank_beyond) for t in tids]
    rows = []
    with ProcessPoolExecutor(a.workers) as ex:
        for r in ex.map(_regress_tile, jobs, chunksize=2):
            rows += r
    reg = [r for r in rows if r[5]]
    summary = {"walls": len(rows), "regressed": len(reg), "share": round(len(reg) / max(len(rows), 1), 4),
               "drawnArea": round(sum(r[3] for r in rows)), "guessedArea": round(sum(r[4] for r in rows)), "examples": reg[:15]}
    print(json.dumps(summary, indent=1))
    if a.out:
        Path(a.out).write_text(json.dumps({**summary, "regressedWalls": reg}, indent=0))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["nyhavn", "sheet", "stats", "regress"])
    ap.add_argument("--out", default="")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--min-h", type=float, default=7.0)
    ap.add_argument("--min-len", type=float, default=6.0)
    ap.add_argument("--layers", default="", help="regress: a directory of <tile>.json layer files to check (default: data/tiles/*/windows.json)")
    ap.add_argument("--blank-beyond", action="store_true", help="regress: the engine leaves the wall beyond the measured columns blank (first version)")
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args(argv)
    if a.cmd == "sheet" and not a.out:
        a.out = str(ROOT / ".context/windows-sheet")
    {"nyhavn": cmd_nyhavn, "sheet": cmd_sheet, "stats": cmd_stats, "regress": cmd_regress}[a.cmd](a)


if __name__ == "__main__":
    main()
