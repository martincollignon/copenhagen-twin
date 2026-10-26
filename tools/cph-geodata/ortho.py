# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "numpy", "rasterio", "pillow", "scipy", "shapely>=2"]
# ///
"""GeoDanmark spring orthophoto (RGB + colour-infrared) spike: fetch, NDVI, and checks against the twin's data.

Source: Dataforsyningen WMS `orto_foraar_DAF` (Klimadatastyrelsen / GeoDanmark, free data, token in a header). The CIR
layers deliver the same exposure as the RGB layers with the channels shifted (R = NIR, G = red, B = green), so RGB + CIR
together give four bands R, G, B, NIR at the same pixel grid, and NDVI = (NIR - R) / (NIR + R).

    uv run tools/cph-geodata/ortho.py fetch               # test window at 10 cm + district at 25 cm, cached
    uv run tools/cph-geodata/ortho.py analyse             # numbers -> data/raw/ortho/ortho_stats.json, previews -> docs/research/realism/ortho/

Raw imagery stays under data/raw/ortho/ (git-ignored). Nothing here writes data/*.json.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "ortho"
VEG = ROOT / "data" / "raw" / "veg"
DOC = ROOT / "docs" / "research" / "realism" / "ortho"
WMS = "https://api.dataforsyningen.dk/orto_foraar_DAF"
ORIGIN = (723900.0, 6176500.0)
YEAR = 2025
TILE = 1000  # px per WMS request

# (E0, N0, E1, N1, pixel m). test: Dronning Louises Bro + Peblinge Soe + Blaagaards Plads; district: the playable bbox.
WINDOWS = {
    "test": (723460, 6176780, 724060, 6177180, 0.10),
    "district": (723150, 6175750, 724650, 6177250, 0.25),
}


def token() -> str:
    for k in ("GSEARCH_TOKEN", "DHM_TERRAIN_TOKEN", "DATAFORSYNINGEN_TOKEN"):
        if os.environ.get(k):
            return os.environ[k].strip()
    return subprocess.run([str(ROOT / "tools" / "adc-secret.sh"), "gsearch-token"], capture_output=True, text=True, check=True).stdout.strip()


# ---------------------------------------------------------------------------------------------------------------- fetch

def layer_name(kind: str, px: float) -> str:
    res = "10cm" if px < 0.125 else "12_5cm"
    return f"geodanmark_{YEAR}_{res}" + ("_cir" if kind == "cir" else "")


def fetch_window(win: str, kind: str, tok: str) -> Path:
    import requests  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415
    import rasterio  # noqa: PLC0415
    from rasterio.transform import from_origin  # noqa: PLC0415

    e0, n0, e1, n1, px = WINDOWS[win]
    dest = RAW / f"{win}_{kind}_{YEAR}.tif"
    if dest.exists():
        return dest
    W, H = round((e1 - e0) / px), round((n1 - n0) / px)
    img = np.zeros((H, W, 3), "uint8")
    tiles = RAW / "tiles"
    tiles.mkdir(parents=True, exist_ok=True)
    lyr = layer_name(kind, px)
    for r0 in range(0, H, TILE):
        for c0 in range(0, W, TILE):
            w, h = min(TILE, W - c0), min(TILE, H - r0)
            be, bn1 = e0 + c0 * px, n1 - r0 * px
            bbox = (be, bn1 - h * px, be + w * px, bn1)
            cache = tiles / f"{lyr}_{px}_{bbox[0]:.1f}_{bbox[1]:.1f}.png"
            if not cache.exists():
                r = requests.get(WMS, params=dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS=lyr, STYLES="", CRS="EPSG:25832",
                                                  BBOX=",".join(f"{v:.2f}" for v in bbox), WIDTH=w, HEIGHT=h, FORMAT="image/png"),
                                 headers={"token": tok, "User-Agent": "cph-twin-geodata/0.1"}, timeout=300)
                r.raise_for_status()
                if not r.headers.get("content-type", "").startswith("image/"):
                    raise SystemExit(f"WMS error for {lyr}: {r.text[:300]}")
                cache.write_bytes(r.content)
            img[r0:r0 + h, c0:c0 + w] = np.asarray(Image.open(cache).convert("RGB"))
            print(f"[ortho] {win} {kind} tile {r0},{c0}", file=sys.stderr)
    with rasterio.open(dest, "w", driver="GTiff", height=H, width=W, count=3, dtype="uint8", crs="EPSG:25832",
                       transform=from_origin(e0, n1, px, px), compress="deflate", tiled=True, photometric="RGB") as d:
        d.write(img.transpose(2, 0, 1))
    return dest


def cmd_fetch(_args):
    tok = token()
    for win in WINDOWS:
        for kind in ("rgb", "cir"):
            print("wrote", fetch_window(win, kind, tok))


# -------------------------------------------------------------------------------------------------------------- analyse

class Grid:
    """A window's 4-band stack and local-frame helpers."""

    def __init__(self, win: str):
        import rasterio  # noqa: PLC0415

        self.win = win
        self.e0, self.n0, self.e1, self.n1, self.px = WINDOWS[win]
        with rasterio.open(RAW / f"{win}_rgb_{YEAR}.tif") as s:
            self.rgb = s.read().transpose(1, 2, 0)
            self.transform = s.transform
        with rasterio.open(RAW / f"{win}_cir_{YEAR}.tif") as s:
            cir = s.read()
        self.nir = cir[0]
        # sanity: CIR green/blue must equal RGB red/green (same exposure, shifted channels)
        self.cir_shift_err = float(np.abs(cir[1].astype(int) - self.rgb[..., 0]).mean())
        r = self.rgb[..., 0].astype("float32")
        n = self.nir.astype("float32")
        self.ndvi = (n - r) / np.maximum(n + r, 1.0)
        self.lum = self.rgb.astype("float32").mean(2)
        self.shape = self.ndvi.shape

    def to_px(self, x, z):
        e, n = np.asarray(x) + ORIGIN[0], ORIGIN[1] - np.asarray(z)
        return (e - self.e0) / self.px, (self.n1 - n) / self.px  # col, row

    def burn(self, rings, value=1, all_touched=False):
        """Rasterise local-frame flat rings [x0, z0, x1, z1, ...] onto the grid."""
        from rasterio import features  # noqa: PLC0415
        from shapely.geometry import Polygon  # noqa: PLC0415

        shapes = []
        for ring in rings:
            xs, zs = np.asarray(ring[0::2]), np.asarray(ring[1::2])
            p = Polygon(list(zip(xs + ORIGIN[0], ORIGIN[1] - zs)))
            if p.is_valid and not p.is_empty:
                shapes.append((p, value))
        if not shapes:
            return np.zeros(self.shape, "uint8")
        return features.rasterize(shapes, out_shape=self.shape, transform=self.transform, fill=0, all_touched=all_touched, dtype="uint8")

    def lidar(self, cls: int):
        """DHM class-count raster (1 m, tools/cph-geodata/vegetation_rasters.py) resampled (nearest) to this grid."""
        import rasterio  # noqa: PLC0415

        out = np.zeros(self.shape, "float32")
        rows, cols = np.indices(self.shape, sparse=True)
        ee = self.e0 + (cols + 0.5) * self.px
        nn = self.n1 - (rows + 0.5) * self.px
        for f in sorted(VEG.glob(f"c{cls}_*.tif")):
            with rasterio.open(f) as s:
                a, t = s.read(1), s.transform
            c = np.floor((ee - t.c) / t.a).astype(int)
            r = np.floor((nn - t.f) / t.e).astype(int)
            ok_c, ok_r = (c >= 0) & (c < a.shape[1]), (r >= 0) & (r < a.shape[0])
            m = ok_r & ok_c
            rr, cc = np.broadcast_arrays(np.clip(r, 0, a.shape[0] - 1), np.clip(c, 0, a.shape[1] - 1))
            out = np.where(m, np.maximum(out, a[rr, cc]), out)
        return out


def srgb_to_linear(c):
    c = np.asarray(c, "float64") / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def otsu(v, lo=-0.5, hi=0.8):
    h, edges = np.histogram(v[(v > lo) & (v < hi)], 200, (lo, hi))
    mids = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(h)
    w1 = w0[-1] - w0
    m0 = np.cumsum(h * mids) / np.maximum(w0, 1)
    m1 = (np.sum(h * mids) - np.cumsum(h * mids)) / np.maximum(w1, 1)
    return float(mids[np.argmax(w0 * w1 * (m0 - m1) ** 2)])


def load_twin():
    geo = json.loads((ROOT / "data" / "cph-geodata.json").read_text())
    fur = json.loads((ROOT / "data" / "cph-furniture.json").read_text())
    surf = json.loads((ROOT / "data" / "cph-surfaces.json").read_text())
    lakes = json.loads((ROOT / "data" / "cph-lakes.json").read_text())
    vegp = ROOT / "data" / "cph-vegetation.json"
    veg = json.loads(vegp.read_text()) if vegp.exists() else None
    return geo, fur, surf, lakes, veg


def masks(g: Grid, geo, lakes):
    from scipy import ndimage  # noqa: PLC0415

    water = g.burn([lk["ring"] for lk in lakes["lakes"]] + [p["ring"] for p in lakes.get("ponds", [])])
    bld = g.burn([b["ring"] for b in geo["buildings"]])
    shadow = g.lum < 45
    t = otsu(g.ndvi[(water == 0) & ~shadow])
    k = max(1, round(0.3 / g.px))
    nd = ndimage.uniform_filter(g.ndvi, k)
    veg = (nd > t) & (water == 0)
    c5 = g.lidar(5)
    c6 = g.lidar(6)
    tall = ndimage.binary_dilation(c5 >= 1, iterations=max(1, round(0.5 / g.px)))
    canopy = veg & tall
    low = veg & ~tall
    return dict(water=water.astype(bool), bld=bld.astype(bool), shadow=shadow, veg=veg, canopy=canopy, low=low, c5=c5, c6=c6, t=t)


def tree_check(g: Grid, m, trees, roads):
    """Crown area per KK tree (Voronoi share of the canopy mask) and crown blobs with no KK tree nearby."""
    from scipy import ndimage  # noqa: PLC0415

    col, row = g.to_px([t["x"] for t in trees], [t["z"] for t in trees])
    inside = (col >= 0) & (col < g.shape[1]) & (row >= 0) & (row < g.shape[0])
    idx = np.nonzero(inside)[0]
    markers = np.zeros(g.shape, "int32")
    markers[row[idx].astype(int), col[idx].astype(int)] = np.arange(1, len(idx) + 1)
    # nearest-tree assignment, capped at 9 m (no Voronoi cell larger than a big crown)
    dist, (ri, ci) = ndimage.distance_transform_edt(markers == 0, return_indices=True)
    owner = markers[ri, ci]
    owner[dist * g.px > 9.0] = 0
    can = m["canopy"]
    lab_i = np.arange(1, len(idx) + 1)
    area = ndimage.sum(can, owner, index=lab_i) * g.px ** 2
    lid = ndimage.sum(m["c5"] >= 1, owner, index=lab_i) * g.px ** 2  # LiDAR high-vegetation footprint (leaf-independent)
    near = owner * (dist * g.px <= 2.5)  # 2.5 m disc round the trunk: is this tree in leaf on the photo date?
    leaf = ndimage.sum(can, near, index=lab_i) / np.maximum(ndimage.sum(np.ones(g.shape), near, index=lab_i), 1)
    rows = []
    for j, ti in enumerate(idx):
        t = trees[ti]
        a = float(area[j])
        rows.append(dict(i=int(ti), kk_r=t.get("crown_radius"), cat=t.get("category"), genus=t.get("genus"), src=t["src"][0].split(":")[1],
                         ortho_r=float(np.sqrt(a / np.pi)), lidar_r=float(np.sqrt(lid[j] / np.pi)), leaf=float(leaf[j]), area=a))
    # unclaimed canopy blobs (>= 12 m2): trees the twin does not have
    unclaimed = can & (owner == 0)
    lab, n = ndimage.label(ndimage.binary_opening(unclaimed, iterations=2))
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1)) * g.px ** 2
    keep = np.nonzero(sizes >= 12.0)[0] + 1
    cent = ndimage.center_of_mass(np.ones_like(lab), lab, keep) if len(keep) else []
    blobs = []
    for k, (r, c) in zip(keep, cent):
        blobs.append(dict(area=float(sizes[k - 1]), row=float(r), col=float(c), street=bool(roads[int(r), int(c)])))
    return rows, blobs, lab, keep


def tree_summary(rows):
    """Crown radius agreement (KK vs ortho canopy vs LiDAR class 5) per source, and leaf-out per genus."""
    def agg(rs):
        if not rs:
            return None
        kk = np.array([x["kk_r"] or np.nan for x in rs])
        orr = np.array([x["ortho_r"] for x in rs])
        li = np.array([x["lidar_r"] for x in rs])
        leafed = np.array([x["leaf"] >= 0.5 for x in rs])
        ok = leafed & np.isfinite(kk) & (kk > 0)
        out = dict(n=len(rs), leafed=int(leafed.sum()), bare_or_missing=int((~leafed).sum()), kk_r_median=round(float(np.nanmedian(kk)), 2),
                   lidar_r_median=round(float(np.median(li)), 2))
        if ok.sum() > 5:
            out.update(ortho_r_median_leafed=round(float(np.median(orr[ok])), 2), ratio_ortho_kk=round(float(np.median(orr[ok] / kk[ok])), 3),
                       corr_ortho_kk=round(float(np.corrcoef(orr[ok], kk[ok])[0, 1]), 3), corr_lidar_kk=round(float(np.corrcoef(li[ok], kk[ok])[0, 1]), 3),
                       ratio_lidar_kk=round(float(np.median(li[ok] / kk[ok])), 3), kk_too_small=int((orr[ok] > 1.3 * kk[ok]).sum()), kk_too_big=int((orr[ok] < 0.7 * kk[ok]).sum()))
        return out

    by_src = {s: agg([x for x in rows if x["src"] == s]) for s in sorted({x["src"] for x in rows})}
    genera = {}
    for gname in sorted({x["genus"] for x in rows}):
        rs = [x for x in rows if x["genus"] == gname]
        if len(rs) >= 8:
            genera[gname] = dict(n=len(rs), leafed_frac=round(float(np.mean([x["leaf"] >= 0.5 for x in rs])), 2), leaf_median=round(float(np.median([x["leaf"] for x in rs])), 2))
    return dict(all=agg(rows), by_src=by_src, leaf_by_genus=genera)


def road_buffer(g: Grid, geo, extra=4.0):
    """Streets: road centrelines buffered by width/2 + extra, plus KK sidewalks."""
    from shapely.geometry import LineString  # noqa: PLC0415
    from rasterio import features  # noqa: PLC0415

    shapes = []
    for rd in geo["roads"]:
        p = rd["pts"]
        ls = LineString([(x + ORIGIN[0], ORIGIN[1] - z) for x, z in zip(p[0::2], p[1::2])])
        shapes.append((ls.buffer(rd.get("width", 6) / 2 + extra), 1))
    a = features.rasterize(shapes, out_shape=g.shape, transform=g.transform, fill=0, dtype="uint8")
    return (a > 0) | (g.burn([s["ring"] for s in geo["sidewalks"]]) > 0)


def lake_colours(g: Grid, lakes, m, sidewalks):
    from scipy import ndimage  # noqa: PLC0415

    out = {}
    groups = {"Sankt Jorgens So": [], "Peblinge So": [], "Sortedams So": []}
    for lk in lakes["lakes"]:
        mk = g.burn([lk["ring"]]).astype(bool)
        if lk["id"] in ("lake:1", "lake:2"):
            groups["Sankt Jorgens So"].append(mk)
        elif lk["id"] == "lake:0":
            # split at Dronning Louises Bro (local 97, -477): along the lake axis (NE = +x, -z)
            rows, cols = np.indices(g.shape)
            x = g.e0 + (cols + 0.5) * g.px - ORIGIN[0]
            z = ORIGIN[1] - (g.n1 - (rows + 0.5) * g.px)
            s = (x - 97) * 0.6 - (z + 477) * 0.8
            groups["Peblinge So"].append(mk & (s < 0))
            groups["Sortedams So"].append(mk & (s >= 0))
    er = max(1, round(6.0 / g.px))
    side = g.burn([s["ring"] for s in sidewalks]).astype(bool) & ~m["shadow"] & (m["veg"] == 0)
    grey = np.median(g.rgb[side].astype("float64"), 0)
    gain = grey.mean() / grey  # grey-world on sunlit KK pavements (concrete / granite slabs are near neutral)
    out["_pavement_grey_srgb"] = grey.round(1).tolist()
    out["_wb_gain"] = gain.round(3).tolist()
    for name, ms in groups.items():
        if not ms:
            continue
        mk = ndimage.binary_erosion(np.any(ms, axis=0), iterations=er)
        sel = mk & (g.ndvi < 0.05) & (g.lum < 140)  # drop algae / reeds, glints, boats
        if sel.sum() < 100:
            continue
        px = g.rgb[sel].astype("float64")
        med = np.median(px, 0)
        out[name] = dict(px=int(sel.sum()), srgb_median=med.round(1).tolist(), srgb_mean=px.mean(0).round(1).tolist(),
                         srgb_p10=np.percentile(px, 10, 0).round(1).tolist(), srgb_p90=np.percentile(px, 90, 0).round(1).tolist(),
                         linear_median=srgb_to_linear(med).round(4).tolist(), srgb_median_wb=np.clip(med * gain, 0, 255).round(1).tolist(),
                         linear_median_wb=srgb_to_linear(np.clip(med * gain, 0, 255)).round(4).tolist(), nir_median=float(np.median(g.nir[sel])),
                         excluded_frac=float(1 - sel.sum() / max(mk.sum(), 1)))
    return out


def roof_check(g: Grid, geo, m):
    """Per-building ortho roof colour (footprint eroded 1.5 m) vs appearance roof tone; green-roof candidates."""
    from scipy import ndimage  # noqa: PLC0415

    res = []
    er = max(1, round(1.5 / g.px))
    for b in geo["buildings"]:
        ring = b["ring"]
        xs, zs = ring[0::2], ring[1::2]
        c, r = g.to_px(xs, zs)
        if c.min() < 0 or r.min() < 0 or c.max() >= g.shape[1] or r.max() >= g.shape[0]:
            continue
        c0, r0 = int(c.min()), int(r.min())
        c1, r1 = min(int(c.max()) + 2, g.shape[1]), min(int(r.max()) + 2, g.shape[0])
        sub = Grid.__new__(Grid)
        sub.transform = g.transform * g.transform.translation(c0, r0)
        sub.shape = (r1 - r0, c1 - c0)
        mk = Grid.burn(sub, [ring]).astype(bool)
        mk = ndimage.binary_erosion(mk, iterations=er)
        if mk.sum() * g.px ** 2 < 8:
            continue
        rgb = g.rgb[r0:r1, c0:c1][mk].astype("float64")
        nd = g.ndvi[r0:r1, c0:c1][mk]
        c5 = m["c5"][r0:r1, c0:c1][mk]
        green = (nd > m["t"] + 0.05) & (c5 < 1)
        ap = (b.get("observed") or {}).get("roof") or {}
        res.append(dict(id=b["id"], area=float(mk.sum() * g.px ** 2), ortho=np.median(rgb, 0).round(1).tolist(),
                        twin=[round(v * 255, 1) for v in ap["tone"]] if ap.get("tone") else None,
                        twin_conf=ap.get("conf"), twin_green=ap.get("green_frac"), green_frac=float(green.mean()),
                        tree_over=float((c5 >= 1).mean() * (nd > m["t"]).mean()), mat=b.get("roof_material"), roof=b.get("roof")))
    return res


def surface_check(g: Grid, surf, veg, geo, m):
    out = {}
    groups = {}
    for s in surf["surfaces"]:
        groups.setdefault(s["cls"], []).append(s["ring"])
    if veg:
        for s in veg["surfaces"]:
            groups.setdefault(f"veg:{s['kind']}", []).append(s["ring"])
    groups["parks (kk:parkregister)"] = [p["ring"] for p in geo["parks"]]
    groups["sidewalks (kk:fortov)"] = [s["ring"] for s in geo["sidewalks"]]
    for k, rings in groups.items():
        mk = g.burn(rings).astype(bool) & ~m["water"] & ~m["bld"]
        if mk.sum() * g.px ** 2 < 20:
            continue
        sel = mk & ~m["shadow"]
        out[k] = dict(m2=round(float(mk.sum() * g.px ** 2)), veg_frac=round(float(m["veg"][mk].mean()), 3), canopy_frac=round(float(m["canopy"][mk].mean()), 3),
                      low_veg_frac=round(float(m["low"][mk].mean()), 3), ndvi_median=round(float(np.median(g.ndvi[mk])), 3),
                      sunlit_srgb_median=np.median(g.rgb[sel], 0).round(1).tolist() if sel.sum() > 50 else None)
    return out


def courtyard_check(g: Grid, m, roads, geo):
    """Green inside street blocks (not street, not park, not water): the courtyards the street-level data cannot see."""
    parks = g.burn([p["ring"] for p in geo["parks"]]).astype(bool)
    yard = ~roads & ~parks & ~m["water"] & ~m["bld"]
    a = g.px ** 2
    return dict(yard_m2=round(float(yard.sum() * a)), yard_canopy_m2=round(float((yard & m["canopy"]).sum() * a)),
                yard_lowveg_m2=round(float((yard & m["low"]).sum() * a)),
                park_canopy_m2=round(float((parks & m["canopy"]).sum() * a)), street_canopy_m2=round(float((roads & m["canopy"]).sum() * a)),
                roof_veg_m2=round(float((m["bld"] & m["veg"] & (m["c5"] < 1)).sum() * a))), yard


# ------------------------------------------------------------------------------------------------------------- previews

def save_png(im, name, max_kb=390):
    from PIL import Image  # noqa: PLC0415

    DOC.mkdir(parents=True, exist_ok=True)
    p = DOC / name
    im = im.convert("RGB")
    for scale, colours in ((1.0, 256), (1.0, 128), (0.85, 128), (0.7, 128), (0.6, 64)):
        x = im if scale == 1.0 else im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
        x.quantize(colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(p, optimize=True)
        if p.stat().st_size < max_kb * 1024:
            break
    print(f"[ortho] {p.name} {p.stat().st_size // 1024} KB", file=sys.stderr)


def crop_img(arr, g: Grid, box, out_w):
    """box = (x0, z0, x1, z1) local; returns PIL image scaled to out_w and the scale (px of output per m)."""
    from PIL import Image  # noqa: PLC0415

    (c0, c1), (r0, r1) = g.to_px([box[0], box[2]], [box[1], box[3]])
    c0, c1, r0, r1 = int(c0), int(c1), int(r0), int(r1)
    im = Image.fromarray(arr[r0:r1, c0:c1])
    s = out_w / im.width
    return im.resize((out_w, round(im.height * s)), Image.Resampling.LANCZOS), s / g.px


def ndvi_rgb(nd):
    """NDVI -> brown (bare) .. white .. green ramp."""
    t = np.clip((nd + 0.3) / 0.9, 0, 1)
    stops = np.array([[90, 60, 40], [200, 190, 170], [240, 240, 220], [120, 190, 80], [20, 100, 30]], float)
    pos = t * (len(stops) - 1)
    i = np.clip(pos.astype(int), 0, len(stops) - 2)
    f = (pos - i)[..., None]
    return (stops[i] * (1 - f) + stops[i + 1] * f).astype("uint8")


def overlay_trees(im, scale, box, trees, colour=(255, 230, 0), width=2):
    from PIL import ImageDraw  # noqa: PLC0415

    d = ImageDraw.Draw(im)
    for t in trees:
        x, z = t["x"], t["z"]
        if not (box[0] <= x <= box[2] and box[1] <= z <= box[3]):
            continue
        cx, cy = (x - box[0]) * scale, (z - box[1]) * scale
        r = (t.get("crown_radius") or 3) * scale
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=colour, width=width)
        d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=colour)
    return im


def previews(g: Grid, gd: Grid, m, md, trees, blobs_lab, keep, yard):
    from PIL import Image, ImageDraw  # noqa: PLC0415

    box = (-430, -660, 150, -290)  # test window, local metres (DLB + Blaagaards Plads)
    W = 1100
    im, s = crop_img(g.rgb, g, box, W)
    save_png(im, "01_rgb_test_10cm.png")
    cir = np.dstack([g.nir, g.rgb[..., 0], g.rgb[..., 1]])
    im, s = crop_img(cir, g, box, W)
    save_png(im, "02_cir_test_10cm.png")
    im, s = crop_img(ndvi_rgb(g.ndvi), g, box, W)
    save_png(im, "03_ndvi_test.png")
    # masks + KK trees: canopy green, low veg light green, unclaimed blobs magenta, KK crowns yellow
    base = (g.rgb.astype("float32") * 0.55).astype("uint8")
    base[m["low"]] = (150, 220, 120)
    base[m["canopy"]] = (30, 150, 50)
    if len(keep):
        un = np.isin(blobs_lab, keep)
        base[un] = (230, 40, 200)
    im, s = crop_img(base, g, box, W)
    im = overlay_trees(im, s, box, trees)
    save_png(im, "04_masks_kktrees_test.png")
    # zoom: Blaagaards Plads courtyards, 160 x 120 m, rgb | masks
    zb = (-400, -520, -240, -400)
    a, s2 = crop_img(g.rgb, g, zb, 640)
    b, _ = crop_img(base, g, zb, 640)
    b = overlay_trees(b, s2, zb, trees)
    c = Image.new("RGB", (1290, a.height), "white")
    c.paste(a, (0, 0))
    c.paste(b, (650, 0))
    save_png(c, "05_zoom_blaagaard_courtyards.png")
    # district overview at 1 m: NDVI-tinted with water + canopy, KK trees as dots
    dbox = (-750, -750, 750, 750)
    base = (gd.rgb.astype("float32") * 0.6).astype("uint8")
    base[md["canopy"]] = (30, 160, 60)
    base[md["low"]] = (150, 220, 120)
    im, s = crop_img(base, gd, dbox, 1000)
    d = ImageDraw.Draw(im)
    for t in trees:
        cx, cy = (t["x"] - dbox[0]) * s, (t["z"] - dbox[1]) * s
        d.point([(cx, cy)], fill=(255, 230, 0))
        d.rectangle([cx - 1, cy - 1, cx + 1, cy + 1], fill=(255, 230, 0))
    save_png(im, "06_district_canopy_vs_kktrees.png")


def preview_roofs_lakes(gd: Grid, geo, roofs, lakes_stats):
    """Top green-roof candidates (RGB | CIR, 40 m crops, footprint in yellow) and lake swatches vs the twin's water."""
    from PIL import Image, ImageDraw  # noqa: PLC0415

    bmap = {b["id"]: b for b in geo["buildings"]}
    cands = [x for x in sorted(roofs, key=lambda x: -x["green_frac"] * min(x["area"], 300)) if x["green_frac"] > 0.25][:6]
    cir = np.dstack([gd.nir, gd.rgb[..., 0], gd.rgb[..., 1]])
    S = 200
    sheet = Image.new("RGB", (S * 4 + 30, (S + 18) * 3), "white")
    d0 = ImageDraw.Draw(sheet)
    for k, c in enumerate(cands):
        b = bmap[c["id"]]
        xs, zs = b["ring"][0::2], b["ring"][1::2]
        cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        half = max(20.0, (max(max(xs) - min(xs), max(zs) - min(zs))) / 2 + 6)
        box = (cx - half, cz - half, cx + half, cz + half)
        for j, arr in enumerate((gd.rgb, cir)):
            im, sc = crop_img(arr, gd, box, S)
            dr = ImageDraw.Draw(im)
            dr.polygon([((x - box[0]) * sc, (z - box[1]) * sc) for x, z in zip(xs, zs)], outline=(255, 230, 0))
            sheet.paste(im, ((k % 2) * (2 * S + 15) + j * S, (k // 2) * (S + 18)))
        d0.text(((k % 2) * (2 * S + 15) + 2, (k // 2) * (S + 18) + S + 2), f"{c['id']} {c['area']:.0f} m2 green {c['green_frac']:.2f} twin {c['twin_green']}", fill=(0, 0, 0))
    save_png(sheet, "07_green_roof_candidates.png")
    # lake swatches: ortho raw | ortho white-balanced | twin DEEP | twin SHALLOW (js/water-cph.js, linear -> sRGB)
    def to_srgb(lin):
        lin = np.asarray(lin, float)
        return tuple(int(v) for v in np.round(255 * np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)))
    names = [k for k in lakes_stats if not k.startswith("_")]
    sw = Image.new("RGB", (4 * 130 + 10, len(names) * 70 + 90), "white")
    d = ImageDraw.Draw(sw)
    for i, nme in enumerate(names):
        L = lakes_stats[nme]
        for j, col in enumerate((tuple(int(v) for v in L["srgb_median"]), tuple(int(v) for v in L["srgb_median_wb"]))):
            d.rectangle([j * 130, i * 70, j * 130 + 125, i * 70 + 50], fill=col)
        d.text((270, i * 70 + 20), nme, fill=(0, 0, 0))
    y = len(names) * 70
    for j, (lbl, lin) in enumerate((("twin DEEP", (0.010, 0.040, 0.040)), ("twin SHALLOW", (0.045, 0.085, 0.060)))):
        d.rectangle([j * 130, y, j * 130 + 125, y + 50], fill=to_srgb(lin))
        d.text((j * 130 + 2, y + 55), lbl, fill=(0, 0, 0))
    d.text((270, y + 20), "cols: ortho median | ortho white-balanced", fill=(0, 0, 0))
    save_png(sw, "08_lake_colour_swatches.png")


def cmd_analyse(_args):
    from scipy import ndimage  # noqa: PLC0415

    geo, fur, surf, lakes, veg = load_twin()
    trees = fur["trees"]
    stats = {"year": YEAR}
    grids = {}
    for win in ("test", "district"):
        g = Grid(win)
        m = masks(g, geo, lakes)
        roads = road_buffer(g, geo)
        rows, blobs, lab, keep = tree_check(g, m, trees, roads)
        cy, yard = courtyard_check(g, m, roads, geo)
        ws = dict(px=g.px, cir_shift_err=round(g.cir_shift_err, 3), ndvi_threshold=round(m["t"], 3),
                  veg_m2=round(float(m["veg"].sum() * g.px ** 2)), canopy_m2=round(float(m["canopy"].sum() * g.px ** 2)),
                  low_veg_m2=round(float(m["low"].sum() * g.px ** 2)), shadow_frac=round(float(m["shadow"].mean()), 3))
        ws["trees"] = tree_summary(rows)
        ws["unclaimed_canopy"] = dict(blobs=len(blobs), m2=round(sum(b["area"] for b in blobs)), street_blobs=sum(b["street"] for b in blobs),
                                      offstreet_blobs=sum(not b["street"] for b in blobs), offstreet_m2=round(sum(b["area"] for b in blobs if not b["street"])),
                                      est_trees_at_25m2=round(sum(b["area"] for b in blobs) / 25))
        ws["courtyards"] = cy
        ws["surfaces"] = surface_check(g, surf, veg, geo, m)
        if win == "district":
            ws["lakes"] = lake_colours(g, lakes, m, geo["sidewalks"])
            roofs = roof_check(g, geo, m)
            tw = np.array([x["twin"] for x in roofs if x["twin"]])
            ob = np.array([x["ortho"] for x in roofs if x["twin"]])
            ws["roofs"] = dict(n=len(roofs), with_twin_tone=len(tw),
                               ortho_median=np.median([x["ortho"] for x in roofs], 0).round(1).tolist(),
                               twin_median=np.median(tw, 0).round(1).tolist() if len(tw) else None,
                               mean_abs_diff=np.abs(tw - ob).mean(0).round(1).tolist() if len(tw) else None,
                               lum_corr=round(float(np.corrcoef(tw.mean(1), ob.mean(1))[0, 1]), 3) if len(tw) > 5 else None,
                               green_roof_candidates=[dict(id=x["id"], area=round(x["area"]), green_frac=round(x["green_frac"], 2), twin_green=x["twin_green"])
                                                      for x in sorted(roofs, key=lambda x: -x["green_frac"]) if x["green_frac"] > 0.25][:40],
                               twin_green_gt_0_25=sum(1 for x in roofs if (x["twin_green"] or 0) > 0.25))
            (RAW / "roofs_ortho.json").write_text(json.dumps(roofs))
        (RAW / f"trees_{win}.json").write_text(json.dumps(dict(rows=rows, blobs=blobs)))
        stats[win] = ws
        grids[win] = (g, m, lab, keep, yard)
        print(json.dumps({k: v for k, v in ws.items() if k not in ("surfaces",)}, indent=1)[:4000], file=sys.stderr)
    (RAW / "ortho_stats.json").write_text(json.dumps(stats, indent=1))
    g, m, lab, keep, yard = grids["test"]
    gd, md, *_ = grids["district"]
    previews(g, gd, m, md, trees, lab, keep, yard)
    preview_roofs_lakes(gd, geo, json.loads((RAW / "roofs_ortho.json").read_text()), stats["district"]["lakes"])
    print("wrote", RAW / "ortho_stats.json")


def main():
    import argparse  # noqa: PLC0415

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("fetch").set_defaults(fn=cmd_fetch)
    sp.add_parser("analyse").set_defaults(fn=cmd_analyse)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
