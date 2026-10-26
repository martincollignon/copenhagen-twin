# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow", "scipy", "rasterio"]
# ///
"""Photogrammetric facade and roof appearance (M4 item 1).

    uv run tools/cph-geodata/appearance.py                 # colours only
    uv run tools/cph-geodata/appearance.py --textures      # + per-building wall atlases

Method
  1. Build the district mesh from data/cph-geodata.json (one quad per ring edge from
     ground to eave, one flat roof per building at the eave; holes included). Every
     triangle maps to a *surface* (building, kind 'wall'|'roof', ring, edge).
  2. For each calibrated Skraafoto view, z-buffer-rasterize the whole mesh (numpy,
     perspective-correct) into a triangle-id buffer, so each pixel knows which face it
     sees with occlusion by ALL buildings. A sun shadow map (orthographic, same
     rasterizer) classifies cast and self shadow from the photo timestamp.
  3. Per wall/roof and view: collect visible pixels, drop the lowest 2.5 m of walls
     (trees, cars, people), vegetation (excess green) and windows/deep shadow (luminance
     percentiles), correct for the sun incidence, and take a per-channel median in
     linear RGB. Views are scored by frontality, pixel count and shadow, and the best
     few are combined by weighted median.
  4. Optional rectified wall textures (10 cm/px) packed in one atlas per building.
  5. Write `buildings[].observed` back into the geodata (additive) plus a QA report and
     contact sheet.

Frame: local x = E - 723900, z = -(N - 6176500), y = DVR90 - 6.84 (see schema doc).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

import polytri

ORIGIN = (723900.0, 6176500.0, 6.84)
LAT, LON = 55.686, 12.563  # district centre, for the sun position

SHADOW_AMBIENT = 0.55  # sky share of irradiance on a surface (a in E = a + (1-a) cos); soft so shaded walls stay photo-like
E_REF_COS = 0.8  # reference sun incidence the reported tone is normalised to
BOTTOM_EXCLUDE_M = 2.5
MIN_COS = 0.12  # reject walls seen more edge-on than ~83 degrees
MIN_PX = 12  # min usable pixels per wall per view

# --------------------------------------------------------------------------------------
# colour helpers


def _lut() -> np.ndarray:
    c = np.arange(256, dtype=np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


SRGB2LIN = _lut()


def lin2srgb(x):
    x = np.clip(np.asarray(x, dtype=np.float64), 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb2lin(x):
    x = np.clip(np.asarray(x, dtype=np.float64), 0.0, 1.0)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def luminance(lin: np.ndarray) -> np.ndarray:
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def vegetation_mask(srgb: np.ndarray) -> np.ndarray:
    """Green excess on sRGB (0-1). Ochre/yellow plaster has r > g, so it stays clear."""
    r, g, b = srgb[..., 0], srgb[..., 1], srgb[..., 2]
    exg = 2 * g - r - b
    return (exg > 0.07) & (g > r * 1.04) & (g > b * 1.10)


def _group_median(lin: np.ndarray, min_n: int = 5):
    """Median linear RGB after dropping the darkest 35% / brightest 5% (windows, glints)."""
    if len(lin) < min_n:
        return None
    lum = luminance(lin)
    if len(lin) >= 20:
        lo, hi = np.percentile(lum, [35, 95])
        sel = (lum >= lo) & (lum <= hi)
        if sel.sum() >= 5:
            lin = lin[sel]
    return np.median(lin, axis=0)


def robust_surface_tone(
    srgb: np.ndarray,
    shadow: np.ndarray | None = None,
    e_lit: float = 1.0,
    min_lit: int = 15,
    use_veg: bool = True,
    trim_dark: bool = True,
) -> dict | None:
    """Robust colour of a surface from its visible pixels.

    srgb: (N,3) sRGB 0-1. shadow: (N,) bool (cast or self shadow). e_lit: relative
    irradiance of sunlit pixels (ambient + direct*cos), used to normalise to the
    reference lighting. Vegetation is removed; the darkest 35% (windows, deep shadow)
    and brightest 5% (glints, sky) of the remaining luminance are dropped; the result
    is a per-channel median in linear RGB.
    Returns None when nothing usable remains.
    """
    srgb = np.asarray(srgb, dtype=np.float32).reshape(-1, 3)
    n_all = len(srgb)
    if n_all == 0:
        return None
    if shadow is None:
        shadow = np.zeros(n_all, bool)
    veg = vegetation_mask(srgb) if use_veg else np.zeros(n_all, bool)
    keep = ~veg
    n_keep = int(keep.sum())
    if n_keep == 0:
        return {"tone_lin": None, "veg_frac": 1.0, "n": 0, "n_all": n_all}
    lin = srgb2lin(srgb[keep]).astype(np.float32)
    sh = shadow[keep]
    shadow_frac = float(sh.mean())
    lit_lin, sh_lin = _group_median(lin[~sh]), _group_median(lin[sh])
    from_shadow = False
    if (~sh).sum() >= min_lit:
        use, e = lin[~sh], e_lit
    else:
        use, e, from_shadow = lin[sh], SHADOW_AMBIENT, True
        if len(use) == 0:
            use = lin
    lum = luminance(use)
    if trim_dark and len(use) >= 20:
        lo, hi = np.percentile(lum, [35, 95])
        sel = (lum >= lo) & (lum <= hi)
        if sel.sum() >= 5:
            use, lum = use[sel], lum[sel]
    raw = np.median(use, axis=0)
    e_ref = SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * E_REF_COS
    gain = min(3.0, e_ref / max(e, 1e-3))
    return {
        "tone_lin": np.clip(raw * gain, 0, 1),
        "raw_lin": raw,
        "veg_frac": 1.0 - n_keep / n_all,
        "shadow_frac": shadow_frac,
        "from_shadow": from_shadow,
        "gain": gain,
        "n_lit": int((~sh).sum()),
        "n_sh": int(sh.sum()),
        "lit_lin": lit_lin,  # trimmed medians of the two pixel groups of this surface (same
        "sh_lin": sh_lin,    # material across a shadow edge: the input to the cast estimate)
        "n": int(len(use)),
        "n_all": n_all,
    }


# --------------------------------------------------------------------------------------
# mesh


@dataclass
class Surface:
    bid: int  # index into buildings
    kind: str  # 'wall' | 'roof'
    ring: int  # 0 outer, k+1 = hole k (roof: 0)
    edge: int  # edge index within its ring (roof: -1)


class Scene:
    """Triangle mesh of the district in the local frame, tagged by surface."""

    def __init__(self):
        self.surfaces: list[Surface] = []
        self.verts = np.zeros((0, 3))
        self.tris = np.zeros((0, 3), dtype=np.int64)
        self.tri_surf = np.zeros(0, dtype=np.int64)
        self.tri_n = np.zeros((0, 3))  # outward normals
        self.surf_n = np.zeros((0, 3))
        self.surf_ground = np.zeros(0)
        self.surf_height = np.zeros(0)  # wall height (eave - ground); roof: 0
        self.surf_a = np.zeros((0, 2))  # wall start (x,z)
        self.surf_b = np.zeros((0, 2))  # wall end (x,z)
        self.surf_len = np.zeros(0)
        self.wall_of: dict[tuple[int, int, int], int] = {}
        self.roof_of: dict[int, int] = {}


def ring_pts(flat) -> np.ndarray:
    return np.asarray(flat, dtype=np.float64).reshape(-1, 2)


def signed_area(p: np.ndarray) -> float:
    """Shoelace area in the (x, north) plane: positive = counter-clockwise from above."""
    x, n = p[:, 0], -p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(n, -1) - np.roll(x, -1) * n))


def build_scene(buildings: list[dict], min_wall_h: float = 0.3) -> Scene:
    sc = Scene()
    V: list[np.ndarray] = []
    T: list[np.ndarray] = []
    TS: list[int] = []
    TN: list[np.ndarray] = []
    S_n, S_g, S_h, S_a, S_b = [], [], [], [], []
    nv = 0
    for bi, b in enumerate(buildings):
        g, e = float(b["ground"]), float(b["eave"])
        if e - g < min_wall_h:
            e = g + min_wall_h
        rings = [ring_pts(b["ring"])] + [ring_pts(h) for h in b.get("holes", [])]
        for ri, p in enumerate(rings):
            if len(p) < 3:
                continue
            o = 1.0 if signed_area(p) >= 0 else -1.0
            s = o if ri == 0 else -o  # visible side: outward of solid
            m = len(p)
            for i in range(m):
                a, c = p[i], p[(i + 1) % m]
                dx, dz = c[0] - a[0], c[1] - a[1]
                ln = math.hypot(dx, dz)
                if ln < 0.05:
                    continue
                nrm = np.array([s * -dz / ln, 0.0, s * dx / ln])
                sid = len(sc.surfaces)
                sc.surfaces.append(Surface(bi, "wall", ri, i))
                sc.wall_of[(bi, ri, i)] = sid
                S_n.append(nrm); S_g.append(g); S_h.append(e - g)
                S_a.append(a); S_b.append(c)
                V.append(np.array([[a[0], g, a[1]], [c[0], g, c[1]], [c[0], e, c[1]], [a[0], e, a[1]]]))
                T.append(np.array([[nv, nv + 1, nv + 2], [nv, nv + 2, nv + 3]]))
                TS += [sid, sid]
                TN += [nrm, nrm]
                nv += 4
        # roof at eave
        outer = rings[0]
        if len(outer) >= 3:
            sid = len(sc.surfaces)
            sc.surfaces.append(Surface(bi, "roof", 0, -1))
            sc.roof_of[bi] = sid
            S_n.append(np.array([0.0, 1.0, 0.0])); S_g.append(g); S_h.append(0.0)
            S_a.append(outer[0]); S_b.append(outer[0])
            use_rings = [r for r in rings if len(r) >= 3]
            pts = np.vstack(use_rings)
            tri = polytri.triangulate(use_rings)  # holes honoured, no optional wheel needed
            V.append(np.column_stack([pts[:, 0], np.full(len(pts), e), pts[:, 1]]))
            T.append(tri + nv)
            TS += [sid] * len(tri)
            TN += [np.array([0.0, 1.0, 0.0])] * len(tri)
            nv += len(pts)
    sc.verts = np.vstack(V)
    sc.tris = np.vstack(T)
    sc.tri_surf = np.array(TS, dtype=np.int64)
    sc.tri_n = np.array(TN)
    sc.surf_n = np.array(S_n)
    sc.surf_ground = np.array(S_g)
    sc.surf_height = np.array(S_h)
    sc.surf_a = np.array(S_a)
    sc.surf_b = np.array(S_b)
    sc.surf_len = np.hypot(*(sc.surf_b - sc.surf_a).T)
    return sc


# --------------------------------------------------------------------------------------
# camera


def _rotation(pers: dict) -> np.ndarray:
    om, ph, ka = (math.radians(float(pers[k])) for k in ("pers:omega", "pers:phi", "pers:kappa"))
    co, so, cp, sp, ck, sk = math.cos(om), math.sin(om), math.cos(ph), math.sin(ph), math.cos(ka), math.sin(ka)
    return np.array([
        [cp * ck, -cp * sk, sp],
        [co * sk + so * sp * ck, co * ck - so * sp * sk, -so * cp],
        [so * sk - co * sp * ck, so * ck + co * sp * sk, co * cp],
    ])


def loc2enu(P: np.ndarray) -> np.ndarray:
    """Local (x, y up, z south) -> offset ENU (E-E0, N-N0, Z-Z0)."""
    P = np.asarray(P, dtype=np.float64)
    return np.stack([P[..., 0], -P[..., 2], P[..., 1]], axis=-1)


def enu2loc(P: np.ndarray) -> np.ndarray:
    P = np.asarray(P, dtype=np.float64)
    return np.stack([P[..., 0], P[..., 2], -P[..., 1]], axis=-1)


class Camera:
    """Photogrammetric pinhole (SAUL collinearity, as skraafoto.world_to_pixel).

    The camera looks along -D[:,2]; `project` returns full-frame (col, row) and the
    positive depth in front of the camera.
    """

    def __init__(self, center_enu, D, focal, pix, width, height, ppx=0.0, ppy=0.0):
        self.C = np.asarray(center_enu, dtype=np.float64)  # offset ENU
        self.D = np.asarray(D, dtype=np.float64)
        self.f, self.pix, self.W, self.H, self.ppx, self.ppy = focal, pix, width, height, ppx, ppy
        self.C_loc = enu2loc(self.C)

    @classmethod
    def from_pers(cls, pers: dict) -> "Camera":
        io = pers["pers:interior_orientation"]
        w, h = map(float, io["sensor_array_dimensions"])
        pp = io.get("principal_point_offset", [0.0, 0.0])
        c = pers["pers:perspective_center"]
        center = [c[0] - ORIGIN[0], c[1] - ORIGIN[1], c[2] - ORIGIN[2]]
        return cls(center, _rotation(pers), float(io["focal_length"]), float(io["pixel_spacing"][0]),
                   w, h, float(pp[0]), float(pp[1]))

    @classmethod
    def look_at(cls, eye_loc, target_loc, f_px=2000.0, width=2000, height=1500):
        """Synthetic camera (tests): eye/target in local coordinates, up = +y."""
        eye, tgt = loc2enu(eye_loc), loc2enu(target_loc)
        fwd = tgt - eye
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, [0, 0, 1.0])
        right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        D = np.stack([right, up, -fwd], axis=1)
        pix = 1.0
        return cls(eye, D, f_px, pix, width, height)

    def project(self, P_loc: np.ndarray):
        d = loc2enu(P_loc) - self.C
        a = d @ self.D  # (.,3)
        depth = a[..., 2]
        z = -depth
        with np.errstate(divide="ignore", invalid="ignore"):
            xdot = self.f * a[..., 0] / depth
            ydot = self.f * a[..., 1] / depth
        col = self.W / 2 + (self.ppx - xdot) / self.pix
        row = self.H / 2 + (ydot - self.ppy) / self.pix
        return col, row, z

    def rays_loc(self, col, row) -> np.ndarray:
        xdot = self.ppx + (self.W / 2 - col) * self.pix
        ydot = self.ppy + (row - self.H / 2) * self.pix
        v = np.stack([xdot / self.f, ydot / self.f, np.ones_like(xdot)], axis=-1)
        r = -(v @ self.D.T)
        r = r / np.linalg.norm(r, axis=-1, keepdims=True)
        return enu2loc(r)


# --------------------------------------------------------------------------------------
# rasterizer


try:  # optional JIT (uv run --with numba): same maths as the numpy loop below, ~100x faster on a citywide mesh
    import numba as _nb

    @_nb.njit(cache=True)
    def _raster_nb(X, Y, Q, tris, ids, width, height, idbuf, qbuf):
        for t in range(tris.shape[0]):
            i0, i1, i2 = tris[t, 0], tris[t, 1], tris[t, 2]
            x0, y0, x1, y1, x2, y2 = X[i0], Y[i0], X[i1], Y[i1], X[i2], Y[i2]
            area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if abs(area) < 1e-9:
                continue
            minx = max(int(np.floor(min(x0, x1, x2))), 0)
            maxx = min(int(np.floor(max(x0, x1, x2))), width - 1)
            miny = max(int(np.floor(min(y0, y1, y2))), 0)
            maxy = min(int(np.floor(max(y0, y1, y2))), height - 1)
            if minx > maxx or miny > maxy:
                continue
            inv = 1.0 / area
            q0, q1, q2 = Q[i0], Q[i1], Q[i2]
            for yy in range(miny, maxy + 1):
                ys = yy + 0.5
                for xx in range(minx, maxx + 1):
                    xs = xx + 0.5
                    b0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) * inv
                    b1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) * inv
                    b2 = 1.0 - b0 - b1
                    if b0 >= -1e-6 and b1 >= -1e-6 and b2 >= -1e-6:
                        qq = b0 * q0 + b1 * q1 + b2 * q2
                        if qq > qbuf[yy, xx]:
                            qbuf[yy, xx] = qq
                            idbuf[yy, xx] = ids[t]


    @_nb.njit(cache=True)
    def _march_nb(arr, x0, z_top, res, start, dirs, ds, tol, top, max_len, oz, blocked):
        nr, nc = arr.shape
        for k in range(start.shape[0]):
            s = 0.0
            while True:
                s += ds[k]
                px = start[k, 0] + dirs[k, 0] * s
                py = start[k, 1] + dirs[k, 1] * s
                pz = start[k, 2] + dirs[k, 2] * s
                c = int(np.floor((px - x0) / res))
                r = int(np.floor((pz - z_top) / res))
                if c >= 0 and c < nc and r >= 0 and r < nr:
                    h = np.float64(arr[r, c]) - oz
                else:
                    h = np.float64(np.float32(-50.0)) - oz
                if h > py + tol:
                    blocked[k] = True
                    break
                if py > top or s > max_len:
                    break

    HAVE_NUMBA = True
except ImportError:  # pragma: no cover
    HAVE_NUMBA = False


def rasterize(px, py, q, tris, width, height, tri_ids=None):
    if HAVE_NUMBA:
        idbuf = np.full((height, width), -1, dtype=np.int32)
        qbuf = np.full((height, width), -np.inf, dtype=np.float32)
        ids = np.arange(len(tris), dtype=np.int64) if tri_ids is None else np.asarray(tri_ids, dtype=np.int64)
        _raster_nb(np.ascontiguousarray(px, dtype=np.float64), np.ascontiguousarray(py, dtype=np.float64),
                   np.ascontiguousarray(q, dtype=np.float64), np.ascontiguousarray(tris, dtype=np.int64), ids,
                   width, height, idbuf, qbuf)
        return idbuf, qbuf
    return _rasterize_py(px, py, q, tris, width, height, tri_ids)


def _rasterize_py(px, py, q, tris, width, height, tri_ids=None):
    """Z-buffer rasterization. q is linear in screen space, larger = nearer
    (use 1/z for perspective, distance-to-sun for orthographic).
    Returns (id_buffer int32 [-1 = empty], q_buffer float32)."""
    idbuf = np.full((height, width), -1, dtype=np.int32)
    qbuf = np.full((height, width), -np.inf, dtype=np.float32)
    X, Y, Q = px.tolist(), py.tolist(), q.tolist()
    tl = tris.tolist()
    ids = range(len(tl)) if tri_ids is None else tri_ids.tolist()
    for k, (i0, i1, i2) in zip(ids, tl):
        x0, y0, x1, y1, x2, y2 = X[i0], Y[i0], X[i1], Y[i1], X[i2], Y[i2]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue
        minx = max(int(math.floor(min(x0, x1, x2))), 0)
        maxx = min(int(math.floor(max(x0, x1, x2))), width - 1)
        miny = max(int(math.floor(min(y0, y1, y2))), 0)
        maxy = min(int(math.floor(max(y0, y1, y2))), height - 1)
        if minx > maxx or miny > maxy:
            continue
        xs = np.arange(minx, maxx + 1, dtype=np.float64)[None, :] + 0.5
        ys = np.arange(miny, maxy + 1, dtype=np.float64)[:, None] + 0.5
        inv = 1.0 / area
        b0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) * inv
        b1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) * inv
        b2 = 1.0 - b0 - b1
        eps = -1e-6
        inside = (b0 >= eps) & (b1 >= eps) & (b2 >= eps)
        if not inside.any():
            continue
        qq = b0 * Q[i0] + b1 * Q[i1] + b2 * Q[i2]
        sl = (slice(miny, maxy + 1), slice(minx, maxx + 1))
        upd = inside & (qq > qbuf[sl])
        if upd.any():
            qbuf[sl][upd] = qq[upd]
            idbuf[sl][upd] = k
    return idbuf, qbuf


@dataclass
class ViewBuffer:
    tri: np.ndarray  # (h,w) triangle id or -1
    surf: np.ndarray  # (h,w) surface id or -1
    scale: float
    x0: int
    y0: int
    cam: Camera


def render_view(scene: Scene, cam: Camera, crop: dict, scale: float) -> ViewBuffer:
    x0, y0, x1, y1 = crop["x0"], crop["y0"], crop["x1"], crop["y1"]
    w, h = int(round((x1 - x0) * scale)), int(round((y1 - y0) * scale))
    col, row, z = cam.project(scene.verts)
    px, py = (col - x0) * scale, (row - y0) * scale
    tri = scene.tris
    ok = (z[tri] > 1.0).all(axis=1)
    # back-face cull: surface must face the camera
    mid = scene.verts[tri[:, 0]]
    ok &= np.einsum("ij,ij->i", scene.tri_n, cam.C_loc - mid) > 0
    xs, ys = px[tri], py[tri]
    ok &= (xs.max(1) >= 0) & (xs.min(1) < w) & (ys.max(1) >= 0) & (ys.min(1) < h)
    idx = np.flatnonzero(ok)
    idbuf, _ = rasterize(px, py, 1.0 / np.where(z > 1e-6, z, 1e-6), tri[idx], w, h, tri_ids=idx)
    surf = np.where(idbuf >= 0, scene.tri_surf[np.maximum(idbuf, 0)], -1).astype(np.int32)
    return ViewBuffer(idbuf, surf, scale, x0, y0, cam)


def pixel_world_positions(scene: Scene, vb: ViewBuffer, ys, xs, tri_ids):
    """Intersect the pixel rays with the planes of the visible triangles (local coords)."""
    col = vb.x0 + (xs + 0.5) / vb.scale
    row = vb.y0 + (ys + 0.5) / vb.scale
    r = vb.cam.rays_loc(col, row)
    n = scene.tri_n[tri_ids]
    d = np.einsum("ij,ij->i", n, scene.verts[scene.tris[tri_ids, 0]])
    t = (d - n @ vb.cam.C_loc) / np.einsum("ij,ij->i", n, r)
    return vb.cam.C_loc + t[:, None] * r


# --------------------------------------------------------------------------------------
# sun


def sun_position(when: dt.datetime, lat: float = LAT, lon: float = LON):
    """Solar azimuth (deg from north, clockwise) and elevation (deg). NOAA algorithm."""
    when = when.astimezone(dt.timezone.utc)
    jd = (when - dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc)).total_seconds() / 86400.0
    n = jd
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    lst = math.radians(((gmst * 15) + lon) % 360)
    ha = lst - ra
    latr = math.radians(lat)
    el = math.asin(math.sin(latr) * math.sin(dec) + math.cos(latr) * math.cos(dec) * math.cos(ha))
    az = math.atan2(-math.sin(ha) * math.cos(dec), math.cos(latr) * math.sin(dec) - math.sin(latr) * math.cos(dec) * math.cos(ha))
    return math.degrees(az) % 360, math.degrees(el)


def sun_vector(az_deg: float, el_deg: float) -> np.ndarray:
    """Unit vector towards the sun in the local frame (x east, y up, z south)."""
    az, el = math.radians(az_deg), math.radians(el_deg)
    return np.array([math.cos(el) * math.sin(az), math.sin(el), -math.cos(el) * math.cos(az)])


class ShadowMap:
    """Orthographic depth map from the sun over the whole mesh."""

    def __init__(self, scene: Scene, sun: np.ndarray, res: float = 0.5):
        self.L = sun / np.linalg.norm(sun)
        up = np.array([0.0, 1.0, 0.0])
        e1 = np.cross(up, self.L)
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(self.L, e1)
        self.e1, self.e2, self.res = e1, e2, res
        v = scene.verts
        a, b, c = v @ e1, v @ e2, v @ self.L
        self.a0, self.b0 = a.min() - 1, b.min() - 1
        w = int((a.max() - self.a0) / res) + 3
        h = int((b.max() - self.b0) / res) + 3
        cast = scene.tri_n @ self.L > 0.0
        idx = np.flatnonzero(cast)
        _, q = rasterize((a - self.a0) / res, (b - self.b0) / res, c, scene.tris[idx], w, h, tri_ids=idx)
        self.q = q

    def shadowed(self, P: np.ndarray, bias: float = 0.8) -> np.ndarray:
        a, b, c = P @ self.e1, P @ self.e2, P @ self.L
        i = np.clip(((b - self.b0) / self.res).astype(int), 0, self.q.shape[0] - 1)
        j = np.clip(((a - self.a0) / self.res).astype(int), 0, self.q.shape[1] - 1)
        return self.q[i, j] > c + bias


# --------------------------------------------------------------------------------------
# per-view observation


def short_view(vid: str) -> str:
    for y in ("2025", "2023"):
        vid = vid.replace(f"skraafotos{y}_", "")
    return vid.replace("_100mm", "")


def view_year(vid: str) -> int:
    return int(vid.split("skraafotos")[1][:4]) if "skraafotos" in vid else 0


def load_small(path: Path, size: tuple[int, int]) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    if im.size != size:
        im = im.resize(size, Image.BOX)
    return np.asarray(im)


class DSM:
    """DHM surface model (DVR90 heights) on a regular grid, addressed in local metres."""

    def __init__(self, arr: np.ndarray, x0: float, z_top: float, res: float):
        self.arr = np.nan_to_num(np.asarray(arr, dtype=np.float32), nan=-50.0)
        self.x0, self.z_top, self.res = x0, z_top, res
        self.max = float(self.arr.max())

    @classmethod
    def from_tiles(cls, paths: list[Path]) -> "DSM":
        import rasterio

        srcs = [rasterio.open(p) for p in paths]
        res = srcs[0].res[0]
        left = min(s.bounds.left for s in srcs)
        right = max(s.bounds.right for s in srcs)
        top = max(s.bounds.top for s in srcs)
        bottom = min(s.bounds.bottom for s in srcs)
        arr = np.full((int(round((top - bottom) / res)), int(round((right - left) / res))), np.nan, np.float32)
        for s in srcs:
            a = s.read(1).astype(np.float32)
            r0, c0 = int(round((top - s.bounds.top) / res)), int(round((s.bounds.left - left) / res))
            arr[r0:r0 + a.shape[0], c0:c0 + a.shape[1]] = a
            s.close()
        return cls(arr, left - ORIGIN[0], -(top - ORIGIN[1]), res)

    def height(self, x, z):
        """DVR90 height at local (x, z); -50 outside the grid."""
        c = np.floor((x - self.x0) / self.res).astype(int)
        r = np.floor((z - self.z_top) / self.res).astype(int)
        ok = (c >= 0) & (c < self.arr.shape[1]) & (r >= 0) & (r < self.arr.shape[0])
        out = np.full(np.shape(x), -50.0, dtype=np.float32)
        out[ok] = self.arr[r[ok], c[ok]]
        return out


def dsm_normal(dsm: "DSM", x, z, span: float = 1.5) -> np.ndarray:
    """Unit surface normals (x east, y up, z south) from DSM central differences."""
    dhdx = (dsm.height(x + span, z) - dsm.height(x - span, z)) / (2 * span)
    dhdz = (dsm.height(x, z + span) - dsm.height(x, z - span)) / (2 * span)
    n = np.stack([-dhdx, np.ones_like(dhdx), -dhdz], axis=-1).astype(np.float64)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def dsm_march(dsm: DSM, start: np.ndarray, dirs: np.ndarray, tol: float = 0.3, step: float = 0.2,
              max_len: float = 400.0) -> np.ndarray:
    """Occlusion test by marching rays through the DSM. start: (n,3) local points,
    dirs: (n,3) unit directions (towards camera or sun). A ray is blocked when the DSM
    exceeds the ray height by more than `tol` at any step of `step` metres in plan."""
    n = len(start)
    blocked = np.zeros(n, bool)
    if n == 0:
        return blocked
    hl = np.hypot(dirs[:, 0], dirs[:, 2])
    ds = np.minimum(step / np.maximum(hl, 1e-3), 0.5)  # 3D step per iteration
    ds = np.maximum(ds, 0.05)
    if HAVE_NUMBA:
        _march_nb(dsm.arr, dsm.x0, dsm.z_top, dsm.res, np.ascontiguousarray(start, dtype=np.float64),
                  np.ascontiguousarray(dirs, dtype=np.float64), ds, tol, dsm.max - ORIGIN[2] + tol, max_len, ORIGIN[2], blocked)
        return blocked
    active = np.arange(n)
    s = np.zeros(n)
    top = dsm.max - ORIGIN[2] + tol
    while len(active):
        s[active] += ds[active]
        P = start[active] + dirs[active] * s[active, None]
        h = dsm.height(P[:, 0], P[:, 2]) - ORIGIN[2]
        hit = h > P[:, 1] + tol
        blocked[active[hit]] = True
        done = hit | (P[:, 1] > top) | (s[active] > max_len)
        active = active[~done]
    return blocked


def occlusion_starts(scene: Scene, dsm: DSM, sid: np.ndarray, P: np.ndarray, dirs: np.ndarray,
                     start_off: float = 1.2):
    """Start points for the DSM march. Walls: leave the wall by `start_off` metres
    (DSM cells next to the wall mix roof and ground). Roofs: lift to the DSM roof surface."""
    n = scene.surf_n[sid]
    is_roof = n[:, 1] > 0.5
    start = P.copy()
    # walls
    cosn = np.maximum(np.einsum("ij,ij->i", dirs, n), 0.2)
    s0 = np.minimum(start_off / cosn, 8.0)
    start = np.where(is_roof[:, None], start, P + dirs * s0[:, None])
    if is_roof.any():
        r = np.flatnonzero(is_roof)
        top = dsm.height(P[r, 0], P[r, 2]) - ORIGIN[2]
        start[r, 1] = np.maximum(top, P[r, 1])
        start[r] += dirs[r] * 1.0
    return start


def _stamp(tone: dict, rec: dict, sunv: np.ndarray, kind: str) -> dict:
    tone["view"] = rec["view_id"]
    tone["direction"] = rec["direction"]
    tone["year"] = view_year(rec["view_id"])
    tone["kind"] = kind
    return tone


def observe_view(scene: Scene, rec: dict, raw_dir: Path, scale: float, shadows: dict, buildings: list[dict],
                 dsm: DSM | None = None, occlusion: str = "dsm", n_samples: int = 250,
                 pitched: dict[int, np.ndarray] | None = None):
    """Return ({surface_id: observation}, seconds) for one view.

    occlusion: 'dsm' (DSM ray march is the occlusion truth; no colour heuristic),
    'colour' (green-excess heuristic only) or 'both'.
    pitched: {roof surface id: (n,3) footprint samples lifted onto the DSM roof}. Those
    roofs are NOT read through the flat eave-plane mesh: the lifted points are projected
    into the photo directly (any view, nadir or oblique) with DSM occlusion, DSM sun
    shadow and the DSM surface normal for the per-pixel sun incidence."""
    pitched = pitched or {}
    cam = Camera.from_pers(rec["pers"])
    crop = rec["crop"]
    t0 = time.time()
    vb = render_view(scene, cam, crop, scale)
    h, w = vb.surf.shape
    surf = vb.surf
    pad = np.pad(surf, 1, constant_values=-2)
    same = (surf == pad[:-2, 1:-1]) & (surf == pad[2:, 1:-1]) & (surf == pad[1:-1, :-2]) & (surf == pad[1:-1, 2:])
    ys, xs = np.nonzero((surf >= 0) & same)
    img = load_small(raw_dir / rec["file"], (w, h))
    sm = shadows[rec["_sun_key"]]
    sunv = rec["_sun_vec"]
    cam_c = cam.C_loc
    out: dict[int, dict] = {}
    if len(ys):
        _observe_mesh_surfaces(scene, vb, rec, img, ys, xs, sm, sunv, cam_c, buildings, dsm, occlusion,
                               n_samples, pitched, out)
    if pitched and dsm is not None:
        _observe_pitched_roofs(scene, cam, rec, img, crop, scale, sm, sunv, dsm, pitched, out)
    return out, time.time() - t0


def _observe_mesh_surfaces(scene, vb, rec, img, ys, xs, sm, sunv, cam_c, buildings, dsm, occlusion,
                           n_samples, pitched, out):
    surf = vb.surf
    tri_ids = vb.tri[ys, xs]
    sf = surf[ys, xs]
    order = np.argsort(sf, kind="stable")
    sf_o = sf[order]
    cuts = np.flatnonzero(np.diff(sf_o)) + 1
    starts = np.concatenate([[0], cuts])
    ends = np.concatenate([cuts, [len(sf_o)]])
    # phase 1: per-surface candidate pixels (height filter, view angle), subsampled
    cand = []  # (sid, idx array into ys/xs, n_full, cos, used_low)
    for s0, s1 in zip(starts, ends):
        if s1 - s0 < MIN_PX:
            continue
        sid = int(sf_o[s0])
        S = scene.surfaces[sid]
        if S.kind == "roof" and sid in pitched:
            continue  # sampled on the DSM surface instead of the flat eave plane
        sel = order[s0:s1]
        if S.kind == "wall":
            mid = (scene.surf_a[sid] + scene.surf_b[sid]) / 2
            mid3 = np.array([mid[0], scene.surf_ground[sid] + scene.surf_height[sid] / 2, mid[1]])
            vdir = cam_c - mid3
            vdir /= np.linalg.norm(vdir)
            cos = float(scene.surf_n[sid] @ vdir)
            if cos < MIN_COS:
                continue
            # height of each pixel from its triangle-plane intersection (cheap: only for this surface)
            pos_s = pixel_world_positions(scene, vb, ys[sel], xs[sel], tri_ids[sel])
            hg = pos_s[:, 1] - scene.surf_ground[sid]
            hw = scene.surf_height[sid]
            trim = 0.3 if buildings[S.bid].get("roof") == "flat" else 1.0
            keep = (hg > BOTTOM_EXCLUDE_M) & (hg < hw - trim)
            used_low = False
            if keep.sum() < 25:
                keep = (hg > 0.3) & (hg < hw - 0.2)
                used_low = True
            sel, pos_s = sel[keep], pos_s[keep]
        else:
            pos_s = pixel_world_positions(scene, vb, ys[sel], xs[sel], tri_ids[sel])
            vd = cam_c - pos_s.mean(0)
            cos = float(max(0.0, vd[1] / np.linalg.norm(vd)))
            used_low = False
        n_full = len(sel)
        if n_full < MIN_PX:
            continue
        if n_full > n_samples:
            pick = np.linspace(0, n_full - 1, n_samples).astype(int)
            sel, pos_s = sel[pick], pos_s[pick]
        cand.append((sid, sel, pos_s, n_full, cos, used_low))
    if not cand:
        return
    # phase 2: DSM occlusion toward the camera + DSM/mesh shadow toward the sun
    sid_all = np.concatenate([np.full(len(c[1]), c[0]) for c in cand])
    P_all = np.vstack([c[2] for c in cand])
    blocked = np.zeros(len(P_all), bool)
    dsm_shadow = np.zeros(len(P_all), bool)
    if dsm is not None and occlusion in ("dsm", "both"):
        d = cam_c - P_all
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        blocked = dsm_march(dsm, occlusion_starts(scene, dsm, sid_all, P_all, d), d)
        ds = np.tile(sunv, (len(P_all), 1))
        dsm_shadow = dsm_march(dsm, occlusion_starts(scene, dsm, sid_all, P_all, ds), ds)
    # phase 3: tones
    off = 0
    for sid, sel, pos_s, n_full, cos, used_low in cand:
        m = len(sel)
        blk = blocked[off:off + m]
        dsh = dsm_shadow[off:off + m]
        off += m
        S = scene.surfaces[sid]
        free = ~blk
        if free.sum() < 5:
            continue
        sel_f, pos_f = sel[free], pos_s[free]
        srgb = img[ys[sel_f], xs[sel_f]].astype(np.float32) / 255.0
        nrm = scene.surf_n[sid]
        cos_sun = max(0.0, float(nrm @ sunv))
        self_shadow = cos_sun <= 0.02
        shadow = np.full(len(sel_f), self_shadow) | sm.shadowed(pos_f) | dsh[free]
        e_lit = SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * cos_sun
        tone = robust_surface_tone(srgb, shadow, e_lit=e_lit, use_veg=occlusion in ("colour", "both"),
                                    trim_dark=S.kind == "wall")
        if tone is None or tone["tone_lin"] is None or tone["n"] < 5:
            continue
        tone["cos"] = cos
        tone["cos_sun"] = cos_sun
        tone["px"] = int(round(n_full * free.mean()))
        tone["occluded_frac"] = float(blk.mean())
        tone["used_low"] = used_low
        _stamp(tone, rec, sunv, S.kind)
        if S.kind == "roof":
            lum = luminance(srgb2lin(srgb))
            solar = (srgb[:, 2] > srgb[:, 0] * 1.15) & (srgb[:, 2] > srgb[:, 1] * 1.02) & (lum < 0.12)
            lit_px = ~shadow  # shadowed roof pixels are dark and sky-blue: never evidence of panels
            tone["solar_frac"] = float(solar[lit_px].mean()) if lit_px.sum() >= 8 else 0.0
            # in dsm mode green roofs cannot be told from trees by the mask; use colour only here
            tone["green_frac"] = float(vegetation_mask(srgb).mean())
        out[sid] = tone


PITCHED_PX_PER_POINT = 225  # one footprint sample (1.5 m grid) stands for ~ (1.5 m / 0.1 m GSD)^2 pixels


def _observe_pitched_roofs(scene, cam, rec, img, crop, scale, sm, sunv, dsm, pitched, out):
    """Colour of pitched roofs from DSM-lifted footprint samples in any view (see observe_view)."""
    h, w = img.shape[:2]
    items = []
    for sid, P in pitched.items():
        col, row, z = cam.project(P)
        bj = np.floor((col - crop["x0"]) * scale).astype(int)
        bi = np.floor((row - crop["y0"]) * scale).astype(int)
        ok = (z > 1) & (bi >= 0) & (bi < h) & (bj >= 0) & (bj < w)
        if ok.sum() < 8:
            continue
        Pk = P[ok]
        n = dsm_normal(dsm, Pk[:, 0], Pk[:, 2])
        vd = cam.C_loc - Pk
        vd /= np.linalg.norm(vd, axis=1, keepdims=True)
        cv = np.einsum("ij,ij->i", n, vd)
        front = cv > 0.1
        if front.sum() < 8:
            continue
        sel = np.flatnonzero(ok)[front]
        items.append((sid, Pk[front], n[front], vd[front], cv[front], bi[sel], bj[sel], int(len(P))))
    if not items:
        return
    P_all = np.vstack([it[1] for it in items])
    d_all = np.vstack([it[3] for it in items])
    sid_all = np.concatenate([np.full(len(it[1]), it[0]) for it in items])
    blocked = dsm_march(dsm, occlusion_starts(scene, dsm, sid_all, P_all, d_all), d_all)
    ds = np.tile(sunv, (len(P_all), 1))
    dsm_shadow = dsm_march(dsm, occlusion_starts(scene, dsm, sid_all, P_all, ds), ds)
    off = 0
    for sid, Pk, n, vd, cv, bi, bj, n_total in items:
        m = len(Pk)
        blk, dsh = blocked[off:off + m], dsm_shadow[off:off + m]
        off += m
        free = ~blk
        if free.sum() < 8:
            continue
        cs = np.maximum(0.0, n[free] @ sunv)
        shadow = (cs <= 0.02) | dsh[free] | sm.shadowed(Pk[free])
        srgb = img[bi[free], bj[free]].astype(np.float32) / 255.0
        lin = srgb2lin(srgb).astype(np.float32)
        lum = luminance(lin)
        solar = (srgb[:, 2] > srgb[:, 0] * 1.15) & (srgb[:, 2] > srgb[:, 1] * 1.02) & (lum < 0.12)
        o = {
            "pix_lin": lin, "pix_cos": cs.astype(np.float32), "pix_sh": shadow,
            "cos": float(np.clip(cv[free].mean(), 0, 1)), "cos_sun": float(cs.mean()),
            "px": int(free.sum() * PITCHED_PX_PER_POINT), "occluded_frac": float(blk.mean()),
            "n_lit": int((~shadow).sum()), "n_sh": int(shadow.sum()), "shadow_frac": float(shadow.mean()),
            "from_shadow": bool((~shadow).sum() < 15), "veg_frac": 0.0, "used_low": False,
            "solar_frac": float(solar[~shadow].mean()) if (~shadow).sum() >= 8 else 0.0, "green_frac": float(vegetation_mask(srgb).mean()),
            "lit_lin": None, "sh_lin": None, "pitched": True,
        }
        _stamp(o, rec, sunv, "roof")
        out[sid] = o


# --------------------------------------------------------------------------------------
# per-view lighting calibration (skylight chroma / ambient share) and tone finalisation

E_REF0 = SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * E_REF_COS  # lit-pixel normalisation as in v1 (soft)
GAIN_CAP_LIT = 1.7
G_RANGE = (1.0, 3.5)  # shadow -> lit luminance gain, measured per view from same-surface pairs
S_RANGE = (0.4, 1.0)
GRAZING_COS = 0.12  # sun incidence below this: "lit" pixels are effectively ambient-only
MIN_PAIRS = 8
SUNLIT_MIN_COS = 0.3  # a wall seen at more than ~72 deg is not a "sunlit" source even if lit
YEAR_DISAGREE = 0.25  # sRGB distance between sunlit sources of different years
YEAR_CHROMA_SHADOW = 0.07  # chromaticity (L1 of r,g,b shares) gap that marks a repaint when one side is shadow-sourced
YEAR_LUM_SHADOW = 2.2  # ... or a luminance ratio beyond this


def lum_norm(k: np.ndarray) -> np.ndarray:
    k = np.maximum(np.asarray(k, dtype=np.float64), 1e-4)
    return k / float(luminance(k))


def default_cal() -> dict:
    return {"G": E_REF0 / SHADOW_AMBIENT, "S": 1.0, "k_wall": np.ones(3), "k_roof": np.ones(3), "n_wall": 0, "n_roof": 0, "src": "default"}


def surface_pair(o: dict):
    """dict(k: chroma ratio [lum 1], G: shadow->lit luminance gain, rho, lit/sh tones) from the lit and
    shadowed pixels of ONE surface in ONE view, or None. Same material across a shadow edge:
    shadow/lit is the skylight-vs-sun-plus-sky ratio, independent of the albedo. G is the gain
    that makes the shadow reading equal the (v1-normalised) lit reading of the same wall."""
    if o.get("pitched") or o.get("lit_lin") is None or o.get("sh_lin") is None:
        return None
    if o["n_lit"] < 20 or o["n_sh"] < 20 or o["cos_sun"] < GRAZING_COS:
        return None
    lit, sh = np.asarray(o["lit_lin"], float), np.asarray(o["sh_lin"], float)
    if (lit < 0.01).any() or (sh < 0.003).any():
        return None
    rho = float(luminance(sh) / luminance(lit))
    if not 0.08 < rho < 0.95:
        return None
    e_lit = SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * o["cos_sun"]
    g_lit = min(GAIN_CAP_LIT, E_REF0 / e_lit)
    return {"k": lum_norm(sh / lit), "G": float(E_REF0 / (rho * e_lit)), "rho": rho,
            "lit": np.clip(lit * g_lit, 0, 1), "sh": sh}


def estimate_calibrations(per_surface: dict[int, list[dict]], views: list[dict]) -> dict[str, dict]:
    """Per-view {a, k_wall, k_roof}. Views with too few same-surface pairs borrow the pooled
    estimate of their flight (same collection and sun key), then of their collection."""
    pairs: dict[str, dict[str, list]] = {}
    for obs in per_surface.values():
        for o in obs:
            pr = surface_pair(o)
            if pr is not None:
                pairs.setdefault(o["view"], {"wall": [], "roof": []})[o["kind"]].append(pr)
    meta = {v["view_id"]: (view_year(v["view_id"]), v.get("_sun_key")) for v in views}

    def agg(prs_w, prs_r):
        allp = prs_w + prs_r
        if not allp:
            return None
        res = {"G": float(np.clip(np.median([p["G"] for p in allp]), *G_RANGE)), "n_wall": len(prs_w), "n_roof": len(prs_r)}
        res["k_wall"] = lum_norm(np.median([p["k"] for p in prs_w], axis=0)) if len(prs_w) >= 3 else None
        res["k_roof"] = lum_norm(np.median([p["k"] for p in prs_r], axis=0)) if len(prs_r) >= 3 else None
        # saturation the white-balanced shadow tone keeps relative to the lit tone of the same
        # surface (aerial shadows come out over-coloured after the gain): a single chroma scale
        kk = res["k_wall"] if res["k_wall"] is not None else np.ones(3)
        ratios = []
        for p in allp:
            t = lin2srgb(np.clip(p["sh"] / kk * res["G"], 0, 1))
            ss, sl = sat_of(t), sat_of(lin2srgb(p["lit"]))
            if ss > 0.02:
                ratios.append(sl / ss)
        res["S"] = float(np.clip(np.median(ratios), *S_RANGE)) if len(ratios) >= 5 else 1.0
        return res

    def pooled(pred):
        w, r = [], []
        for vid, d in pairs.items():
            if pred(meta.get(vid, (0, None))):
                w += d["wall"]; r += d["roof"]
        return agg(w, r) if len(w) + len(r) >= MIN_PAIRS else None

    glob = pooled(lambda m: True) or default_cal()
    cols = {y: pooled(lambda m, y=y: m[0] == y) or glob for y in {m[0] for m in meta.values()}}
    flights = {m: pooled(lambda mm, m=m: mm == m) for m in set(meta.values())}
    cal = {}
    for v in views:
        vid = v["view_id"]
        d = pairs.get(vid, {"wall": [], "roof": []})
        mine = agg(d["wall"], d["roof"]) if len(d["wall"]) + len(d["roof"]) >= MIN_PAIRS else None
        src = "view" if mine else "flight"
        base = mine or flights.get(meta[vid]) or cols.get(meta[vid][0]) or glob
        if mine is None and flights.get(meta[vid]) is None:
            src = "collection"
        g_k = glob.get("k_wall") if glob.get("k_wall") is not None else np.ones(3)
        k_w = base.get("k_wall") if base.get("k_wall") is not None else (cols[meta[vid][0]].get("k_wall") if cols[meta[vid][0]].get("k_wall") is not None else g_k)
        k_r = base.get("k_roof") if base.get("k_roof") is not None else k_w
        cal[vid] = {"G": base["G"], "S": base.get("S", 1.0), "k_wall": np.asarray(k_w), "k_roof": np.asarray(k_r),
                    "n_wall": len(d["wall"]), "n_roof": len(d["roof"]), "src": src}
    return cal


def finalize_obs(o: dict, cal: dict) -> dict:
    """Reference-lit tone of one observation. Lit pixels: divide by the (v1, soft) sun incidence.
    Shadow pixels (and grazing-sun walls, which are ambient-only in practice): divide out the
    per-view skylight chroma cast (white balance) THEN apply the per-view measured shadow->lit
    luminance gain G. `raw_lin` stays as photographed."""
    G = cal["G"]
    k = cal["k_roof"] if o["kind"] == "roof" else cal["k_wall"]
    if "pix_lin" in o:  # pitched roof: per-pixel incidence from the DSM normals
        lin, cs, sh = o["pix_lin"], o["pix_cos"], o["pix_sh"]
        sh = sh | (cs < GRAZING_COS)
        if (~sh).sum() >= 15:
            v = lin[~sh]
            gain = np.minimum(GAIN_CAP_LIT, E_REF0 / (SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * cs[~sh]))
            wb = False
            o["raw_lin"] = np.median(v, axis=0)
        else:
            v = (lin[sh] if sh.any() else lin) / k
            gain = np.full(len(v), G)
            wb = True
            S_ = cal.get("S", 1.0)
            o["raw_lin"] = np.median(lin[sh] if sh.any() else lin, axis=0)
        t = np.clip(np.median(v * gain[:, None], axis=0), 0, 1)
        if wb:
            t = np.clip(luminance(t) + S_ * (t - luminance(t)), 0, 1)
        o["tone_lin"] = t
        o["gain"] = float(np.median(gain))
        o["shadow_frac"] = float(sh.mean())
    else:
        wb = bool(o["from_shadow"]) or o["cos_sun"] < GRAZING_COS
        raw = np.asarray(o["raw_lin"], float)
        if wb:
            gain, base = G, raw / k
        else:
            gain = min(GAIN_CAP_LIT, E_REF0 / (SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * o["cos_sun"]))
            base = raw
        t = np.clip(base * gain, 0, 1)
        if wb:
            t = np.clip(luminance(t) + cal.get("S", 1.0) * (t - luminance(t)), 0, 1)
        o["tone_lin"] = t
        o["gain"] = float(gain)
    o["from_shadow"] = wb
    o["wb"] = wb
    o["cast"] = np.asarray(k, float) if wb else None
    o["sunlit"] = (not wb) and (o["kind"] == "roof" or o["cos"] >= SUNLIT_MIN_COS)
    return o


def collection_gains(per_surface: dict[int, list[dict]], min_px: int = 150, min_pairs: int = 30) -> dict[int, np.ndarray]:
    """Per-channel linear gain that maps each older collection onto the newest one, from walls
    that are sunlit in both (the 2023 flight is ~1.5x darker than 2025 in linear light: a
    different radiometric pipeline, not a different building)."""
    newest = max((o["year"] for obs in per_surface.values() for o in obs), default=0)
    ratios: dict[int, list] = {}
    for obs in per_surface.values():
        if obs[0]["kind"] != "wall":
            continue
        new = [o["tone_lin"] for o in obs if o["sunlit"] and o["year"] == newest and o["px"] >= min_px]
        if not new:
            continue
        tn = np.median(new, axis=0)
        for y in {o["year"] for o in obs} - {newest}:
            old = [o["tone_lin"] for o in obs if o["sunlit"] and o["year"] == y and o["px"] >= min_px]
            if old:
                ratios.setdefault(y, []).append(tn / np.maximum(np.median(old, axis=0), 1e-3))
    return {y: np.median(r, axis=0) for y, r in ratios.items() if len(r) >= min_pairs}


def apply_collection_gains(per_surface: dict[int, list[dict]], gains: dict[int, np.ndarray]) -> None:
    for obs in per_surface.values():
        for o in obs:
            g = gains.get(o["year"])
            if g is not None:
                o["tone_lin"] = np.clip(o["tone_lin"] * g, 0, 1)
                o["collection_gain"] = g


# --------------------------------------------------------------------------------------
# combine


def weighted_median(vals: np.ndarray, w: np.ndarray) -> np.ndarray:
    out = np.zeros(vals.shape[1])
    for c in range(vals.shape[1]):
        o = np.argsort(vals[:, c])
        cw = np.cumsum(w[o])
        out[c] = vals[o, c][np.searchsorted(cw, cw[-1] / 2)]
    return out


def view_score(o: dict, kind: str, pitched: bool = False) -> float:
    s = o["cos"] * math.sqrt(o["px"]) * (1 - 0.7 * o["shadow_frac"])
    if o["from_shadow"]:
        s *= 0.6
    if o.get("used_low"):
        s *= 0.5
    if kind == "roof" and not pitched:
        s *= 1.0 if o["direction"] == "nadir" else 0.25
    return s


def _srgb(o) -> np.ndarray:
    return lin2srgb(o["tone_lin"])


def repaint_suspect(sunlit_old: np.ndarray, shadow_new: np.ndarray) -> bool:
    """Is a white-balanced shadow tone (newer) so different from a sunlit tone (older) that the
    wall was probably repainted? Shadow luminance is the noisy part, so compare chromaticity
    first and luminance only for gross ratios."""
    cs = lambda c: np.asarray(c, float) / max(float(np.sum(c)), 1e-6)
    chroma_gap = float(np.abs(cs(sunlit_old) - cs(shadow_new)).sum())
    lr = float(luminance(srgb2lin(shadow_new)) / max(float(luminance(srgb2lin(sunlit_old))), 1e-6))
    return chroma_gap > YEAR_CHROMA_SHADOW or lr > YEAR_LUM_SHADOW or lr < 1 / YEAR_LUM_SHADOW


def select_views(obs: list[dict], kind: str, max_views: int = 3):
    """Pick the source views of one surface. Returns (chosen indices, flags).

    Sunlit sources win over shadow sources; among sunlit sources the newest collection wins
    (unless its best view is clearly poorer), and a disagreeing older sunlit view only raises
    a flag. If the only sunlit source is older and the newer shadow-only (white-balanced)
    colour differs strongly the wall was probably repainted: prefer the newer and flag."""
    pit = any(o.get("pitched") for o in obs)
    sc = np.array([view_score(o, kind, pit) for o in obs])
    newest = max(o["year"] for o in obs)

    def top(idx):
        idx = sorted(idx, key=lambda i: -sc[i])
        best = sc[idx[0]]
        return [i for i in idx if sc[i] >= 0.4 * best][:max_views]

    def tone_of(idx):
        w = sc[idx]
        t = np.array([_srgb(obs[i]) for i in idx])
        return weighted_median(t, w) if len(idx) > 1 else t[0]

    flags: list[str] = []
    sun = [i for i, o in enumerate(obs) if o["sunlit"] and sc[i] > 0]
    if sun:
        best_sun = max(sc[i] for i in sun)
        new = [i for i in sun if obs[i]["year"] == newest and sc[i] >= 0.3 * best_sun]
        old = [i for i in sun if obs[i]["year"] != newest]
        if new:
            chosen = top(new)
            if old and np.linalg.norm(tone_of(chosen) - tone_of(top(old))) > YEAR_DISAGREE:
                flags.append("year_disagree")
            return chosen, flags
        chosen = top(sun)
        if all(obs[i]["year"] != newest for i in chosen):
            shadow_new = [i for i, o in enumerate(obs) if o["year"] == newest and not o["sunlit"] and sc[i] > 0]
            if shadow_new:
                sn = top(shadow_new)
                if repaint_suspect(tone_of(chosen), tone_of(sn)):
                    flags.append("year_disagree")
                    return sn, flags
        return chosen, flags
    allv = [i for i in range(len(obs)) if sc[i] > 0] or list(range(len(obs)))
    boosted = sc.copy()
    for i in allv:
        if obs[i]["year"] == newest:
            boosted[i] *= 1.5
    sc_save, sc = sc, boosted
    chosen = top(allv)
    sc = sc_save
    return chosen, flags


def combine(obs: list[dict], kind: str, max_views: int = 3):
    """Fuse the (finalised) per-view observations of one surface."""
    if not obs:
        return None
    pit = any(o.get("pitched") for o in obs)
    if kind == "roof" and not pit and any(o["direction"] == "nadir" for o in obs):
        keep = [o for o in obs if o["direction"] == "nadir"]
        pool_note = len(obs) - len(keep)
        obs = keep
    chosen, flags = select_views(obs, kind, max_views)
    sc = np.array([view_score(o, kind, pit) for o in obs])
    tones = np.array([obs[i]["tone_lin"] for i in chosen])
    w = np.maximum(sc[chosen], 1e-6)
    tone = weighted_median(tones, w) if len(chosen) > 1 else tones[0]
    raw = weighted_median(np.array([obs[i]["raw_lin"] for i in chosen]), w) if len(chosen) > 1 else obs[chosen[0]]["raw_lin"]
    ref = lin2srgb(tone)
    agree = sum(1 for o in obs if o["px"] >= MIN_PX and np.linalg.norm(lin2srgb(o["tone_lin"]) - ref) < 0.09)
    b = obs[chosen[0]]
    sunlit = all(obs[i]["sunlit"] for i in chosen)
    wb_used = [obs[i]["cast"] for i in chosen if obs[i]["wb"]]
    res = {
        "tone": [round(float(x), 3) for x in ref],
        "tone_raw": [round(float(x), 3) for x in lin2srgb(raw)],
        "views": [short_view(obs[i]["view"]) for i in chosen],
        "angle_deg": round(math.degrees(math.acos(min(1.0, b["cos"]))), 1),
        "px": int(sum(obs[i]["px"] for i in chosen)),
        "shadow_frac": round(float(np.average([obs[i]["shadow_frac"] for i in chosen], weights=w)), 2),
        "agree": int(agree),
        "n_views": len(obs),
        "shadow_corrected": bool(not sunlit),
        "sunlit": bool(sunlit),
        "year": int(b["year"]),
        "years_used": sorted({int(obs[i]["year"]) for i in chosen}),
        "flags": flags,
        "wb_cast": [round(float(x), 3) for x in np.median(wb_used, axis=0)] if wb_used else None,
        "veg_frac": round(float(np.average([obs[i].get("green_frac", obs[i]["veg_frac"]) for i in chosen], weights=w)), 2),
        "occluded_frac": round(float(np.average([obs[i].get("occluded_frac", 0.0) for i in chosen], weights=w)), 2),
        "best": short_view(b["view"]),
        "pitched_sampled": bool(pit),
        "_best_raw": b,
    }
    if kind == "roof":
        res["solar_frac"] = round(float(np.average([obs[i].get("solar_frac", 0) for i in chosen], weights=w)), 2)
    return res


# --------------------------------------------------------------------------------------
# prior from BBR: brick

BRICK_MATERIALS = {"mursten"}
BRICK_DEFAULT_SRGB = np.array([0.55, 0.30, 0.24])
PRIOR_SAT_MAX = 0.25  # observed tones below this saturation are "ambiguous" for the brick prior


def sat_of(rgb) -> float:
    mx, mn = float(max(rgb)), float(min(rgb))
    return (mx - mn) / mx if mx > 0 else 0.0


def is_brick_hue(rgb) -> bool:
    r, g, b = rgb
    return r > g * 1.25 and r > b * 1.45 and sat_of(rgb) > 0.32


def apply_brick_prior(c: dict, ref_srgb) -> bool:
    """Pull an ambiguous shadow-sourced tone toward the brick hue (keeps its luminance).
    Never touches sunlit (confident) observations or already-brick tones."""
    if c["sunlit"] or sat_of(c["tone"]) >= PRIOR_SAT_MAX or is_brick_hue(c["tone"]):
        return False
    tone_lin = srgb2lin(np.array(c["tone"]))
    ref_lin = srgb2lin(np.asarray(ref_srgb, float))
    target = ref_lin * (float(luminance(tone_lin)) / max(float(luminance(ref_lin)), 1e-6))
    alpha = 0.4 + 0.4 * (1 - sat_of(c["tone"]) / PRIOR_SAT_MAX)
    new = lin2srgb(np.clip((1 - alpha) * tone_lin + alpha * target, 0, 1))
    c["tone_prior_free"] = c["tone"]
    c["tone"] = [round(float(x), 3) for x in new]
    c["prior"] = "brick"
    return True


def roof_type_hint(tone_srgb, roof: str | None, veg_frac: float, solar_frac: float) -> str:
    r, g, b = tone_srgb
    lum = float(luminance(srgb2lin(np.array(tone_srgb))))
    mx, mn = max(r, g, b), min(r, g, b)
    sat = (mx - mn) / mx if mx > 0 else 0
    if solar_frac > 0.35:
        return "solar"
    if veg_frac > 0.5:
        return "green"
    if r > g * 1.25 and r > b * 1.5 and sat > 0.25:
        return "tile"  # red/orange clay tile
    if g > r * 1.05 and g > b * 0.95 and sat > 0.12:
        return "copper"  # patinated copper / green metal
    if lum < 0.10:
        return "tagpap" if roof in ("flat", "unknown", None) else "slate"
    if lum < 0.22 and sat < 0.2:
        return "slate" if roof not in ("flat",) else "tagpap"
    if lum >= 0.22 and sat < 0.2:
        return "metal" if roof in ("flat", "unknown", None) else "fibre-cement"
    return "other"


# --------------------------------------------------------------------------------------
# textures


def ring_label(ri: int):
    return 0 if ri == 0 else f"hole_{ri - 1}"


def wall_texture(scene: Scene, sid: int, vb: ViewBuffer, full_img: np.ndarray, crop: dict, texel: float,
                 dsm: DSM | None = None, veg: bool = False):
    """Rectified strip for one wall from one view. Returns (rgb uint8 (h,w,3), valid bool, tone_lin)."""
    L, Hh = float(scene.surf_len[sid]), float(scene.surf_height[sid])
    nw, nh = max(2, int(round(L / texel))), max(2, int(round(Hh / texel)))
    s = (np.arange(nw) + 0.5) / nw
    t = (np.arange(nh) + 0.5) / nh
    A, B = scene.surf_a[sid], scene.surf_b[sid]
    X = A[0] + (B[0] - A[0]) * s
    Z = A[1] + (B[1] - A[1]) * s
    Y = scene.surf_ground[sid] + Hh * (1 - t)  # row 0 = top
    P = np.stack(np.broadcast_arrays(X[None, :], Y[:, None], Z[None, :]), axis=-1).reshape(-1, 3)
    col, row, z = vb.cam.project(P)
    cc, rr = col - crop["x0"], row - crop["y0"]
    bh, bw = vb.surf.shape
    bi = np.floor(rr * vb.scale).astype(int)
    bj = np.floor(cc * vb.scale).astype(int)
    inb = (z > 1) & (bi >= 0) & (bi < bh) & (bj >= 0) & (bj < bw)
    vis = np.zeros(len(P), bool)
    vis[inb] = vb.surf[bi[inb], bj[inb]] == sid
    fh, fw = full_img.shape[:2]
    # bilinear sample
    c0 = np.clip(np.floor(cc - 0.5).astype(int), 0, fw - 2)
    r0 = np.clip(np.floor(rr - 0.5).astype(int), 0, fh - 2)
    fc = np.clip(cc - 0.5 - c0, 0, 1)[:, None]
    fr = np.clip(rr - 0.5 - r0, 0, 1)[:, None]
    im = full_img
    px = (im[r0, c0] * (1 - fc) * (1 - fr) + im[r0, c0 + 1] * fc * (1 - fr)
          + im[r0 + 1, c0] * (1 - fc) * fr + im[r0 + 1, c0 + 1] * fc * fr)
    valid = vis
    if veg:
        valid = valid & ~vegetation_mask(px / 255.0)
    if dsm is not None:  # DSM occlusion on a 0.5 m lattice, repeated up to texel size
        k = max(1, int(round(0.5 / texel)))
        ii, jj = np.arange(0, nh, k), np.arange(0, nw, k)
        Pc = np.stack(np.broadcast_arrays(X[None, jj], Y[ii, None], Z[None, jj]), axis=-1).reshape(-1, 3)
        d = vb.cam.C_loc - Pc
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        n = np.tile(scene.surf_n[sid], (len(Pc), 1))
        s0 = np.minimum(1.2 / np.maximum(d @ scene.surf_n[sid], 0.2), 8.0)
        blk = dsm_march(dsm, Pc + d * s0[:, None], d).reshape(len(ii), len(jj))
        full_blk = np.repeat(np.repeat(blk, k, axis=0), k, axis=1)[:nh, :nw]
        valid = valid & ~full_blk.reshape(-1)
    return px.reshape(nh, nw, 3), valid.reshape(nh, nw)


def fill_texture(px: np.ndarray, valid: np.ndarray, texel: float):
    """Fill invalid texels from the nearest valid one (<= 0.6 m), else the wall median."""
    from scipy import ndimage as ndi

    if valid.sum() == 0:
        return None, 1.0
    med = np.median(px[valid], axis=0)
    out = px.copy()
    if (~valid).any():
        dist, (ii, jj) = ndi.distance_transform_edt(~valid, return_indices=True)
        near = dist * texel <= 0.6
        fillmask = ~valid
        out[fillmask & near] = px[ii, jj][fillmask & near]
        out[fillmask & ~near] = med
    return np.clip(out, 0, 255).astype(np.uint8), float(1.0 - valid.mean())


def pack_atlas(strips: list[tuple[dict, np.ndarray]], max_w: int = 4096, max_h: int = 8192):
    """Pack strips into columns of equal width (JPEG-safe sizes). Returns (image, metas)."""
    pad = 2
    cw = min(max(s.shape[1] for _, s in strips), max_w)
    placed, col, y, col_h = [], 0, pad, 0
    for meta, s in strips:
        if s.shape[1] > cw:
            s = np.asarray(Image.fromarray(s).resize((cw, s.shape[0]), Image.BILINEAR))
        if y + s.shape[0] + pad > max_h and y > pad:
            col, y = col + 1, pad
        placed.append((meta, s, col, y))
        y += s.shape[0] + pad
        col_h = max(col_h, y)
    ncol = col + 1
    W, H = ncol * cw, col_h
    atlas = np.zeros((H, W, 3), np.uint8)
    metas = []
    for meta, s, c, yy in placed:
        x = c * cw
        atlas[yy:yy + s.shape[0], x:x + s.shape[1]] = s
        m = dict(meta)
        m["uv"] = [round(x / W, 5), round(yy / H, 5), round((x + s.shape[1]) / W, 5), round((yy + s.shape[0]) / H, 5)]
        m["px"] = [x, yy, int(s.shape[1]), int(s.shape[0])]
        metas.append(m)
    return atlas, metas


# --------------------------------------------------------------------------------------
# driver


def nearest_median_fallback(buildings, centroids, observed_tone, bi, k=6, radius=60.0):
    d = np.hypot(*(centroids - centroids[bi]).T)
    order = np.argsort(d)
    vals = []
    for j in order[1:80]:
        if d[j] > radius:
            break
        if observed_tone[j] is not None:
            vals.append(observed_tone[j])
            if len(vals) >= k:
                break
    if not vals:
        return None
    return np.median(np.array(vals), axis=0)


def points_in_ring(pts: np.ndarray, ring: np.ndarray) -> np.ndarray:
    x, y = pts[:, 0], pts[:, 1]
    inside = np.zeros(len(pts), bool)
    n = len(ring)
    for i in range(n):
        x0, y0, x1, y1 = ring[i, 0], ring[i, 1], ring[(i + 1) % n, 0], ring[(i + 1) % n, 1]
        if y0 == y1:
            continue
        cond = (y0 > y) != (y1 > y)
        xi = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        inside ^= cond & (x < xi)
    return inside


def dist_to_ring(pts: np.ndarray, ring: np.ndarray) -> np.ndarray:
    a, b = ring, np.roll(ring, -1, axis=0)
    ab = b - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    t = np.clip(((pts[:, None, :] - a[None]) * ab[None]).sum(2) / L2[None], 0, 1)
    proj = a[None] + t[..., None] * ab[None]
    return np.sqrt(((pts[:, None, :] - proj) ** 2).sum(2)).min(1)


def footprint_samples(b: dict, step: float = 1.5, inset: float = 0.7, max_n: int = 160) -> np.ndarray:
    """Regular plan-view samples inside the footprint (outside holes), `inset` m from edges."""
    outer = ring_pts(b["ring"])
    holes = [ring_pts(h) for h in b.get("holes", []) if len(h) >= 6]
    lo, hi = outer.min(0), outer.max(0)
    st = step
    while ((hi - lo) / st + 1).prod() > max_n * 6:
        st *= 1.5
    gx, gz = np.meshgrid(np.arange(lo[0] + st / 2, hi[0], st), np.arange(lo[1] + st / 2, hi[1], st))
    pts = np.column_stack([gx.ravel(), gz.ravel()])
    if len(pts) == 0:
        return np.zeros((0, 2))
    ok = points_in_ring(pts, outer)
    for h in holes:
        ok &= ~points_in_ring(pts, h)
    pts = pts[ok]
    if len(pts) == 0:
        return pts
    d = dist_to_ring(pts, outer)
    for h in holes:
        d = np.minimum(d, dist_to_ring(pts, h))
    pts = pts[d >= inset]
    if len(pts) > max_n:
        pts = pts[np.linspace(0, len(pts) - 1, max_n).astype(int)]
    return pts


PITCH_RISE_M = 1.5


def pitched_roofs(scene: Scene, B: list[dict], dsm: DSM) -> tuple[dict[int, np.ndarray], dict[int, float]]:
    """Roofs whose DSM ridge (95th percentile in the footprint) rises > 1.5 m above the modelled
    eave. Returns {roof surface id: samples lifted onto the DSM}, {building index: rise (m)}."""
    pts_by, rise_by = {}, {}
    for bi, b in enumerate(B):
        sid = scene.roof_of.get(bi)
        if sid is None:
            continue
        xz = footprint_samples(b)
        if len(xz) < 6:
            continue
        h = dsm.height(xz[:, 0], xz[:, 1]).astype(np.float64) - ORIGIN[2]
        h = np.where(h < -40, np.nan, h)
        if np.isnan(h).all():
            continue
        rise = float(np.nanpercentile(h, 95) - b["eave"])
        rise_by[bi] = rise
        if rise > PITCH_RISE_M:
            pts_by[sid] = np.column_stack([xz[:, 0], np.nan_to_num(h, nan=b["eave"]), xz[:, 1]])
    return pts_by, rise_by


def load_views(args, root: Path, scene: Scene, shadows: dict) -> list[dict]:
    cams: list[dict] = []
    for d in str(args.raw).split(","):
        rd = root / d.strip()
        for rec in json.loads((rd / "cameras.json").read_text()):
            rec["_raw_dir"] = rd
            cams.append(rec)
    cams.sort(key=lambda r: (-view_year(r["view_id"]), r["view_id"]))
    if args.limit_views:
        step = max(1, len(cams) // args.limit_views)
        cams = cams[::step][: args.limit_views]
    for rec in cams:
        when = dt.datetime.fromisoformat(rec["datetime"].replace("Z", "+00:00"))
        key = int(when.timestamp() // 600)  # shadow maps are shared within 10 minutes
        az, el = sun_position(dt.datetime.fromtimestamp(key * 600 + 300, dt.timezone.utc))
        rec["_sun_key"] = key
        rec["_sun_vec"] = sun_vector(az, el)
        rec["_sun"] = (az, el)
        if key not in shadows:
            shadows[key] = ShadowMap(scene, rec["_sun_vec"])
            print(f"  sun map {key}: {when:%Y-%m-%d %H:%M}Z az {az:.0f} el {el:.0f}", flush=True)
    return cams


def brick_contradicted(scene: Scene, B: list[dict], walls_obs: dict[int, dict]) -> set[int]:
    """BBR-brick buildings where a confident (sunlit, >= 300 px) wall shows a clearly non-brick
    colour (another saturated hue, or white/light plaster): the prior must not fight that."""
    out = set()
    for sid, c in walls_obs.items():
        bi = scene.surfaces[sid].bid
        if c["sunlit"] and c["px"] >= 300 and not is_brick_hue(c["tone"]):
            lum_s = float(lin2srgb(luminance(srgb2lin(np.array(c["tone"])))))
            if sat_of(c["tone"]) >= 0.12 or lum_s > 0.75:
                out.add(bi)
    return out


def brick_references(scene: Scene, B: list[dict], walls_obs: dict[int, dict]):
    """Brick colour from CONFIDENT (sunlit, brick-hued) walls of BBR-brick buildings: one per
    building where available, else the district median."""
    per_b: dict[int, list] = {}
    for sid, c in walls_obs.items():
        bi = scene.surfaces[sid].bid
        if (B[bi].get("wall_material") or "").lower() in BRICK_MATERIALS and c["sunlit"] and is_brick_hue(c["tone"]) and c["px"] >= 100:
            per_b.setdefault(bi, []).append(c["tone"])
    allv = [t for v in per_b.values() for t in v]
    glob = np.median(allv, axis=0) if len(allv) >= 10 else BRICK_DEFAULT_SRGB
    return glob, {bi: np.median(v, axis=0) for bi, v in per_b.items()}


def run(args) -> dict:
    root = Path(args.root)
    geo_path = root / args.geodata
    t_start = time.time()
    geo = json.loads(geo_path.read_text())
    B = geo["buildings"]
    scene = build_scene(B)
    print(f"mesh: {len(B)} buildings, {len(scene.surfaces)} surfaces, {len(scene.tris)} triangles", flush=True)
    dsm = None
    if args.occlusion in ("dsm", "both"):
        tiles = sorted((root / args.dsm).glob("dhm_dsm_*.tif"))
        if not tiles:
            raise SystemExit(f"no DSM tiles under {root / args.dsm}: copy M1's data/raw/dhm_dsm_*.tif there")
        dsm = DSM.from_tiles(tiles)
        print(f"dsm: {dsm.arr.shape} @ {dsm.res} m, max {dsm.max:.1f} m", flush=True)
    args._dsm = dsm
    shadows: dict = {}
    cams = load_views(args, root, scene, shadows)
    pitched_pts, rise_by = pitched_roofs(scene, B, dsm) if dsm is not None else ({}, {})
    print(f"pitched roofs (DSM ridge - eave > {PITCH_RISE_M} m): {len(pitched_pts)} of {len(B)}", flush=True)

    cache = root / args.cache if args.cache else None
    per_surface: dict[int, list[dict]] = {}
    t_views = time.time()
    if cache and args.reuse_cache and cache.exists():
        import pickle
        per_surface = pickle.loads(cache.read_bytes())
        print(f"reused observation cache {cache}", flush=True)
    else:
        for k, rec in enumerate(cams):
            obs, dtv = observe_view(scene, rec, rec["_raw_dir"], args.scale, shadows, B, dsm=dsm,
                                    occlusion=args.occlusion, pitched=pitched_pts)
            for sid, o in obs.items():
                per_surface.setdefault(sid, []).append(o)
            print(f"  view {k + 1}/{len(cams)} {short_view(rec['view_id'])} ({rec['direction']}, sun el "
                  f"{rec['_sun'][1]:.0f}): {len(obs)} surfaces, {dtv:.1f}s", flush=True)
        if cache:
            import pickle
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(pickle.dumps(per_surface, protocol=4))

    # lighting calibration per view, then reference-lit / white-balanced tones
    cal = estimate_calibrations(per_surface, cams)
    for obs in per_surface.values():
        for o in obs:
            finalize_obs(o, cal.get(o["view"]) or default_cal())

    col_gains = collection_gains(per_surface)
    apply_collection_gains(per_surface, col_gains)
    print("collection gains (older -> newest, linear RGB):", {y: np.round(g, 2).tolist() for y, g in col_gains.items()}, flush=True)
    walls_obs: dict[int, dict] = {}
    roofs_obs: dict[int, dict] = {}
    for sid, obs in per_surface.items():
        kind = scene.surfaces[sid].kind
        c = combine(obs, kind)
        if c is not None:
            (walls_obs if kind == "wall" else roofs_obs)[sid] = c

    # BBR brick prior for ambiguous (shadow-sourced, low-saturation) walls
    brick_ref_global, brick_ref_b = brick_references(scene, B, walls_obs)
    contradicted = brick_contradicted(scene, B, walls_obs)
    n_prior = n_prior_skipped = 0
    for sid, c in walls_obs.items():
        bi = scene.surfaces[sid].bid
        if (B[bi].get("wall_material") or "").lower() in BRICK_MATERIALS:
            if bi in contradicted:
                n_prior_skipped += not c["sunlit"] and sat_of(c["tone"]) < PRIOR_SAT_MAX
                continue
            if apply_brick_prior(c, brick_ref_b.get(bi, brick_ref_global)):
                n_prior += 1
    print(f"brick prior skipped on {n_prior_skipped} ambiguous walls of buildings whose sunlit walls contradict brick", flush=True)
    print(f"brick prior applied to {n_prior} walls (reference {np.round(brick_ref_global, 2).tolist()})", flush=True)

    # per-building output
    centroids = np.array([ring_pts(b["ring"]).mean(0) for b in B])
    bld_wall_tone = [None] * len(B)
    bld_roof_tone = [None] * len(B)
    by_b: dict[int, list] = {}
    for sid, c in walls_obs.items():
        by_b.setdefault(scene.surfaces[sid].bid, []).append((sid, c))
    for bi, lst in by_b.items():
        w = np.array([c["px"] for _, c in lst], float)
        bld_wall_tone[bi] = weighted_median(np.array([c["tone"] for _, c in lst]), w)
    for sid, c in roofs_obs.items():
        bld_roof_tone[scene.surfaces[sid].bid] = np.array(c["tone"])

    n_walls_total = n_walls_obs = n_roofs_obs = 0
    fallback_counts = {"building": 0, "neighbours": 0, "preset": 0}
    for b in B:
        b["observed"] = {"walls": [], "roof": None}
    surf_by_b: dict[int, list[int]] = {}
    for sid, S in enumerate(scene.surfaces):
        if S.kind == "wall":
            surf_by_b.setdefault(S.bid, []).append(sid)
    for bi, b in enumerate(B):
        for sid in sorted(surf_by_b.get(bi, []), key=lambda s: (scene.surfaces[s].ring, scene.surfaces[s].edge)):
            S = scene.surfaces[sid]
            n_walls_total += 1
            if sid in walls_obs:
                c = walls_obs[sid]
                n_walls_obs += 1
                entry = {"edge": S.edge, "ring": ring_label(S.ring), "tone": c["tone"],
                         "conf": "observed+prior" if c.get("prior") else "observed",
                         "views": c["views"], "angle_deg": c["angle_deg"], "px": c["px"],
                         "shadow_frac": c["shadow_frac"], "tone_raw": c["tone_raw"], "agree": c["agree"],
                         "shadow_corrected": c["shadow_corrected"], "sunlit": c["sunlit"], "year": c["year"],
                         "wb_cast": c["wb_cast"]}
                if c["flags"]:
                    entry["flags"] = c["flags"]
                if c.get("prior"):
                    entry["prior"] = c["prior"]
                    entry["tone_observed"] = c["tone_prior_free"]
            else:
                tone, how = None, None
                if bld_wall_tone[bi] is not None:
                    tone, how = bld_wall_tone[bi], "building"
                else:
                    t = nearest_median_fallback(B, centroids, bld_wall_tone, bi)
                    if t is not None:
                        tone, how = t, "neighbours"
                if tone is None:
                    tone, how = np.array(b["facade"]["tone"]), "preset"
                fallback_counts[how] += 1
                entry = {"edge": S.edge, "ring": ring_label(S.ring), "tone": [round(float(x), 3) for x in tone],
                         "conf": "inferred", "views": [], "angle_deg": None, "px": 0, "shadow_frac": None,
                         "fallback": how}
            b["observed"]["walls"].append(entry)
        rs = scene.roof_of.get(bi)
        rise = rise_by.get(bi)
        if rs is not None and rs in roofs_obs:
            c = roofs_obs[rs]
            n_roofs_obs += 1
            b["observed"]["roof"] = {
                "tone": c["tone"], "conf": "observed", "views": c["views"], "px": c["px"],
                "shadow_frac": c["shadow_frac"], "angle_deg": c["angle_deg"],
                "type_hint": roof_type_hint(c["tone"], b.get("roof"), c["veg_frac"], c.get("solar_frac", 0)),
                "solar_frac": c.get("solar_frac", 0.0), "green_frac": c["veg_frac"],
                "sunlit": c["sunlit"], "year": c["year"], "pitched": rs in pitched_pts,
                "ridge_rise_m": round(rise, 2) if rise is not None else None,
                "sampled_on": "dsm_surface" if rs in pitched_pts else "eave_plane",
            }
            if c["flags"]:
                b["observed"]["roof"]["flags"] = c["flags"]
        else:
            t = nearest_median_fallback(B, centroids, bld_roof_tone, bi)
            b["observed"]["roof"] = {
                "tone": [round(float(x), 3) for x in t] if t is not None else None,
                "conf": "inferred", "views": [], "px": 0, "type_hint": None,
                "pitched": rs in pitched_pts, "ridge_rise_m": round(rise, 2) if rise is not None else None,
            }
    print(f"observed walls {n_walls_obs}/{n_walls_total}, roofs {n_roofs_obs}/{len(B)}; "
          f"views {time.time() - t_views:.0f}s", flush=True)

    atlas_stats = None
    if args.textures:
        atlas_stats = make_textures(scene, B, walls_obs, per_surface, cams, root, args)

    stats = {
        "walls_total": n_walls_total, "walls_observed": n_walls_obs, "roofs_total": len(B),
        "roofs_observed": n_roofs_obs, "fallback": fallback_counts, "runtime_s": round(time.time() - t_start, 1),
        "views": len(cams), "scale": args.scale, "textures": atlas_stats, "brick_prior_walls": n_prior, "brick_prior_skipped": n_prior_skipped,
        "pitched_roofs": len(pitched_pts),
    }
    years: dict[int, int] = {}
    for c in cams:
        y = view_year(c["view_id"])
        years[y] = years.get(y, 0) + 1
    geo["appearance"] = {"version": "appearance/2",
                         "method": "skraafoto2025+2023 z-buffer visibility, sunlit-view selection, per-view shadow white balance, BBR brick prior",
                         "views": len(cams), "views_by_year": {str(k): v for k, v in sorted(years.items())},
                         "scale": args.scale}
    out_path = root / (args.out or args.geodata)
    out_path.write_text(json.dumps(geo, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)", flush=True)
    return {"geo": geo, "scene": scene, "walls_obs": walls_obs, "roofs_obs": roofs_obs, "stats": stats,
            "cams": cams, "per_surface": per_surface, "cal": cal, "col_gains": col_gains}


def make_textures(scene, B, walls_obs, per_surface, cams, root, args):
    """Second pass: rectify the best (sunlit if any) view of every observed wall into per-building
    atlases. Strips taken from a shadow-sourced view get the per-channel linear gain that maps
    the photographed wall median to the white-balanced tone."""
    tex_dir = root / "data" / "tex"
    tex_dir.mkdir(parents=True, exist_ok=True)
    cam_by_id = {c["view_id"]: c for c in cams}
    short2id = {short_view(c["view_id"]): c["view_id"] for c in cams}
    by_view: dict[str, list[int]] = {}
    for sid, c in walls_obs.items():
        by_view.setdefault(short2id[c["best"]], []).append(sid)
    strips: dict[int, list] = {}
    filled_all, sunlit_src = [], []
    for vid, sids in by_view.items():
        rec = cam_by_id[vid]
        cam = Camera.from_pers(rec["pers"])
        vb = render_view(scene, cam, rec["crop"], args.scale)
        full = np.asarray(Image.open(rec["_raw_dir"] / rec["file"]).convert("RGB"))
        for sid in sids:
            S = scene.surfaces[sid]
            c = walls_obs[sid]
            texel = max(args.texel, scene.surf_len[sid] / 4096)
            px, valid = wall_texture(scene, sid, vb, full, rec["crop"], texel, dsm=args._dsm, veg=args.occlusion != "dsm")
            img, fill = fill_texture(px, valid, texel)
            if img is None:
                continue
            mult = None
            if not c["sunlit"]:
                mult = np.clip(srgb2lin(np.array(c["tone"])) / np.maximum(srgb2lin(np.array(c["tone_raw"])), 1e-3), 0.3, 8.0)
                lin = srgb2lin(img.astype(np.float64) / 255.0) * mult
                img = np.clip(np.round(lin2srgb(lin) * 255), 0, 255).astype(np.uint8)
            filled_all.append(fill)
            sunlit_src.append(bool(c["sunlit"]))
            strips.setdefault(S.bid, []).append((
                {"edge": S.edge, "ring": ring_label(S.ring), "len_m": round(float(scene.surf_len[sid]), 2),
                 "h_m": round(float(scene.surf_height[sid]), 2), "texel_m": round(float(texel), 3),
                 "filled_frac": round(fill, 2), "sunlit": bool(c["sunlit"]), "year": c["year"],
                 "wb_applied": mult is not None}, img))
        print(f"  tex view {short_view(vid)}: {len(sids)} walls", flush=True)
    total_bytes = 0
    for bi, lst in strips.items():
        lst.sort(key=lambda t: (str(t[0]["ring"]), t[0]["edge"]))
        atlas, metas = pack_atlas(lst)
        name = f"{B[bi]['id'].replace(':', '_')}.jpg"
        Image.fromarray(atlas).save(tex_dir / name, quality=85)
        total_bytes += (tex_dir / name).stat().st_size
        B[bi]["observed"]["atlas"] = {"file": f"tex/{name}", "size": [atlas.shape[1], atlas.shape[0]], "walls": metas}
    return {"buildings": len(strips), "walls": len(filled_all),
            "mean_filled": round(float(np.mean(filled_all)), 3) if filled_all else None,
            "median_filled": round(float(np.median(filled_all)), 3) if filled_all else None,
            "sunlit_sourced": int(sum(sunlit_src)), "mb": round(total_bytes / 1e6, 1)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--geodata", default="data/cph-geodata.json")
    ap.add_argument("--raw", default="data/raw/skraafoto2025,data/raw/skraafoto2023",
                    help="comma-separated Skraafoto dirs, each with cameras.json (newest collection preferred)")
    ap.add_argument("--out", default=None, help="write here instead of updating --geodata in place")
    ap.add_argument("--dsm", default="data/raw/dhm", help="dir with dhm_dsm_*.tif (EPSG:25832, DVR90)")
    ap.add_argument("--occlusion", choices=["dsm", "colour", "both"], default="dsm",
                    help="occlusion truth: DSM ray march (default), green-excess heuristic, or both")
    ap.add_argument("--scale", type=float, default=0.5, help="ID-buffer scale vs the JPEG window")
    ap.add_argument("--limit-views", type=int, default=0)
    ap.add_argument("--textures", action="store_true")
    ap.add_argument("--texel", type=float, default=0.10)
    ap.add_argument("--report", default="data/appearance.report.md")
    ap.add_argument("--sheet", default="docs/m4/appearance_check_v2.png")
    ap.add_argument("--cache", default="data/raw/appearance_obs_cache.pkl", help="per-view observation cache")
    ap.add_argument("--reuse-cache", action="store_true", help="skip the (slow) view pass, redo selection onward")
    ap.add_argument("--v1", default="data/raw/cph-geodata.v1.json", help="v1 geodata for the before/after report")
    ap.add_argument("--no-qa", action="store_true")
    args = ap.parse_args(argv)
    res = run(args)
    if not args.no_qa:
        import appearance_qa
        appearance_qa.write_report(res, Path(args.root), args)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
