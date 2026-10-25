"""Offline tests for appearance.py: face tagging, visibility, DSM occlusion, colour robustness.

    uv run --with pytest --with numpy --with pillow --with scipy --with mapbox-earcut --with rasterio pytest tools/cph-geodata/tests/test_appearance.py
"""
import numpy as np

import appearance as A


def box(id_, x0, z0, x1, z1, eave, ground=0.0, holes=None):
    # counter-clockwise seen from above (x east, north = -z)
    ring = [x0, z0, x1, z0, x1, z1, x0, z1]
    ring = [x0, z0, x0, z1, x1, z1, x1, z0] if False else ring
    return {"id": id_, "ring": ring, "holes": holes or [], "ground": ground, "eave": eave, "roof": "flat"}


def ccw_box(id_, x0, z0, x1, z1, eave):
    # in (x, north=-z): (x0,n0)->(x1,n0)->(x1,n1)->(x0,n1) with n = -z, z1<z0 means north larger
    return {"id": id_, "ring": [x0, z0, x1, z0, x1, z1, x0, z1], "holes": [], "ground": 0.0, "eave": eave, "roof": "flat"}


def test_face_tagging_and_normals():
    b = ccw_box("a", 0, 0, 10, -6, 12)  # 10 m wide in x, 6 m deep to the north
    sc = A.build_scene([b])
    walls = [s for s in sc.surfaces if s.kind == "wall"]
    assert [(s.ring, s.edge) for s in walls] == [(0, 0), (0, 1), (0, 2), (0, 3)]
    assert sum(s.kind == "roof" for s in sc.surfaces) == 1
    # edge 0 runs along z=0 on the southern side: outward normal points south (+z)
    n0 = sc.surf_n[sc.wall_of[(0, 0, 0)]]
    assert np.allclose(n0, [0, 0, 1])
    # every triangle of a wall surface lies in that wall's plane
    for k, sid in enumerate(sc.tri_surf):
        S = sc.surfaces[sid]
        if S.kind == "wall":
            v = sc.verts[sc.tris[k]]
            assert np.allclose((v - v[0]) @ sc.surf_n[sid], 0, atol=1e-9)
    assert np.allclose(sc.surf_height[sc.wall_of[(0, 0, 0)]], 12)


def test_hole_walls_face_into_cavity_and_roof_area():
    outer = [0, 0, 20, 0, 20, -20, 0, -20]
    hole = [5, -5, 5, -15, 15, -15, 15, -5]  # clockwise seen from above
    b = {"id": "h", "ring": outer, "holes": [hole], "ground": 0.0, "eave": 10.0, "roof": "flat"}
    sc = A.build_scene([b])
    hw = [s for s in sc.surfaces if s.kind == "wall" and s.ring == 1]
    assert len(hw) == 4
    c = np.array([10.0, -10.0])
    for s in hw:
        sid = sc.wall_of[(0, 1, s.edge)]
        mid = (sc.surf_a[sid] + sc.surf_b[sid]) / 2
        n = sc.surf_n[sid]
        assert (c - mid) @ np.array([n[0], n[2]]) > 0  # normal points toward the courtyard
    roof = sc.roof_of[0]
    area = 0.0
    for k in np.flatnonzero(sc.tri_surf == roof):
        v = sc.verts[sc.tris[k]]
        area += abs(np.cross(v[1] - v[0], v[2] - v[0])[1]) / 2
    assert abs(area - (400 - 100)) < 1e-6


def test_visibility_front_box_occludes_back_box():
    front = ccw_box("front", -5, 0, 5, -10, 8)  # south box, 8 m high
    back = ccw_box("back", -5, -30, 5, -40, 20)  # taller box further north
    sc = A.build_scene([front, back])
    cam = A.Camera.look_at([0, 14, 60], [0, 8, -20], f_px=1500, width=1200, height=900)
    crop = {"x0": 0, "y0": 0, "x1": 1200, "y1": 900}
    vb = A.render_view(sc, cam, crop, 1.0)
    front_wall = sc.wall_of[(0, 0, 0)]  # south-facing wall of the front box
    back_wall = sc.wall_of[(1, 0, 0)]  # south-facing wall of the back box
    assert front_wall != back_wall
    # project back-wall points: those below the front roofline are hidden, those above visible
    def seen(y):
        P = np.array([[0.0, y, -30.0]])
        col, row, _ = cam.project(P)
        return vb.surf[int(row[0]), int(col[0])]
    assert seen(1.0) == -1 or seen(1.0) != back_wall  # low part hidden behind the front box
    assert seen(19.0) == back_wall  # top part visible above it
    P = np.array([[0.0, 4.0, 0.0]])
    col, row, _ = cam.project(P)
    assert vb.surf[int(row[0]), int(col[0])] == front_wall
    # backfaces are never drawn: the north wall of the front box is not in the buffer
    north_front = sc.wall_of[(0, 0, 2)]
    assert not (vb.surf == north_front).any()


def test_dsm_marks_tree_in_front_of_wall_as_occluded():
    # 100 m x 100 m DSM, 1 m cells, ground 7 m DVR90; wall at x = 60 facing west; tree at x 40..48
    arr = np.full((100, 100), 7.0, np.float32)
    x0 = -50.0
    z_top = -50.0
    for r in range(45, 56):
        for c in range(90, 98):  # x = c + x0 -> 40..47
            arr[r, c] = 7.0 + 15.0
    dsm = A.DSM(arr, x0, z_top, 1.0)
    cam_c = np.array([-45.0, 40.0, 0.0])  # camera west of the wall, high
    pts = np.array([[60.0, 3.0, 0.0],    # behind the tree, low: ray passes through the blob
                    [60.0, 3.0, 30.0],   # off to the side: free
                    [60.0, 40.0, 0.0]])  # high on the wall: ray passes above the tree
    n = np.tile([-1.0, 0, 0], (3, 1))
    d = cam_c - pts
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    blk = A.dsm_march(dsm, pts + d * 1.2 / np.maximum(d @ n[0], 0.2), d)
    assert blk.tolist() == [True, False, False]


def test_robust_tone_ignores_green_and_shadow():
    rng = np.random.default_rng(0)
    beige = np.array([0.80, 0.72, 0.58])
    wall = beige + rng.normal(0, 0.02, (600, 3))
    green = np.array([0.25, 0.45, 0.18]) + rng.normal(0, 0.03, (250, 3))
    dark = beige * 0.25 + rng.normal(0, 0.01, (200, 3))  # deep shadow / windows
    px = np.clip(np.vstack([wall, green, dark]), 0, 1)
    shadow = np.r_[np.zeros(600, bool), np.zeros(250, bool), np.ones(200, bool)]
    t = A.robust_surface_tone(px, shadow, e_lit=A.SHADOW_AMBIENT + (1 - A.SHADOW_AMBIENT) * A.E_REF_COS)
    assert t["veg_frac"] > 0.15
    assert np.abs(A.lin2srgb(t["tone_lin"]) - beige).max() < 0.04
    # without any shadow flag the darkest-35% rule still keeps the dark blob out
    t2 = A.robust_surface_tone(px, None)
    assert np.abs(A.lin2srgb(t2["tone_lin"]) - beige).max() < 0.05


def test_shadow_only_wall_is_brightened_and_flagged():
    px = np.full((100, 3), 0.3)
    t = A.robust_surface_tone(px, np.ones(100, bool))
    assert t["from_shadow"] and t["gain"] > 1.5


def test_sun_position_sanity():
    import datetime as dt
    az, el = A.sun_position(dt.datetime(2025, 4, 27, 10, 23, tzinfo=dt.timezone.utc))
    assert 155 < az < 175 and 44 < el < 50


def test_pack_atlas_columns_and_uv():
    strips = [({"edge": i}, np.full((3000, 100 + i, 3), i * 20, np.uint8)) for i in range(6)]
    atlas, metas = A.pack_atlas(strips, max_h=8192)
    assert atlas.shape[0] <= 8192
    for m in metas:
        x, y, w, h = m["px"]
        assert (atlas[y:y + h, x:x + w] == m["edge"] * 20).all()
        assert abs(m["uv"][0] - x / atlas.shape[1]) < 1e-4


# ---------------------------------------------------------------------------------------
# v2: shadow white balance, sun selection, brick prior, pitched roofs


def _obs(view="v", year=2025, kind="wall", sunlit=True, tone=(0.6, 0.55, 0.5), px=1000, cos=0.8, shadow_frac=0.0):
    lin = A.srgb2lin(np.array(tone))
    return {"view": view, "year": year, "kind": kind, "direction": "east", "cos": cos, "cos_sun": 0.6, "px": px,
            "shadow_frac": shadow_frac, "from_shadow": not sunlit, "n_lit": 100 if sunlit else 3, "n_sh": 3 if sunlit else 100,
            "raw_lin": lin, "tone_lin": lin, "lit_lin": None, "sh_lin": None, "veg_frac": 0.0, "wb": not sunlit,
            "cast": None if sunlit else np.ones(3), "sunlit": sunlit, "used_low": False}


def test_shadow_white_balance_removes_skylight_cast():
    albedo = np.array([0.50, 0.40, 0.30])  # warm plaster
    sun = np.array([1.0, 0.95, 0.85])
    sky = np.array([0.22, 0.38, 0.75])  # blue skylight, linear
    cos = 0.6
    lit = albedo * (sun * cos + sky)
    sh = albedo * sky
    # 12 surfaces of different albedo, each seen both in sun and in shadow in one view
    rng = np.random.default_rng(1)
    per_surface = {}
    for i in range(12):
        al = np.clip(albedo * rng.uniform(0.6, 1.3, 3), 0.05, 1)
        o = _obs(view="v1")
        o.update(cos_sun=cos, lit_lin=al * (sun * cos + sky), sh_lin=al * sky, n_lit=60, n_sh=60)
        per_surface[i] = [o]
    cal = A.estimate_calibrations(per_surface, [{"view_id": "skraafotos2025_v1", "_sun_key": 1}] if False else
                                  [{"view_id": "v1", "_sun_key": 1}])["v1"]
    assert cal["src"] == "view" and cal["n_wall"] == 12
    # the estimated cast is blue (b > r) with luminance normalised to 1
    k = cal["k_wall"]
    assert k[2] > k[0] and abs(A.luminance(k) - 1) < 1e-6
    # a wall seen only in shadow: raw bluish grey -> after WB it has the warm hue of the lit wall
    o = _obs(view="v1", sunlit=False)
    o["raw_lin"] = sh
    A.finalize_obs(o, cal)
    tone = A.lin2srgb(o["tone_lin"])
    lit_srgb = A.lin2srgb(np.clip(lit, 0, 1))
    raw_srgb = A.lin2srgb(sh)
    assert o["wb"] and not o["sunlit"]
    # chromaticity (r/g, b/g) close to the lit wall, and clearly better than a pure luminance boost
    def chroma(c):
        return np.array([c[0] / c[1], c[2] / c[1]])
    assert np.abs(chroma(tone) - chroma(lit_srgb)).max() < 0.06
    assert np.abs(chroma(raw_srgb) - chroma(lit_srgb)).max() > 0.15
    assert o["cast"] is not None and np.allclose(o["raw_lin"], sh)  # tone_raw untouched


def test_calibration_falls_back_to_flight_pool_with_few_pairs():
    per_surface = {}
    for i in range(10):
        o = _obs(view="a")
        o.update(cos_sun=0.6, lit_lin=np.array([0.5, 0.45, 0.4]), sh_lin=np.array([0.1, 0.12, 0.2]), n_lit=40, n_sh=40)
        per_surface[i] = [o]
    thin = _obs(view="b")  # no usable pair
    per_surface[99] = [thin]
    views = [{"view_id": "a", "_sun_key": 7}, {"view_id": "b", "_sun_key": 7}]
    cal = A.estimate_calibrations(per_surface, views)
    assert cal["a"]["src"] == "view" and cal["b"]["src"] == "flight"
    assert np.allclose(cal["a"]["k_wall"], cal["b"]["k_wall"])


def test_sun_selection_prefers_newest_sunlit_and_flags_disagreement():
    o25 = _obs("2025", year=2025, tone=(0.70, 0.40, 0.30))
    o23 = _obs("2023", year=2023, tone=(0.70, 0.70, 0.70))  # repainted since
    idx, flags = A.select_views([o23, o25], "wall")
    assert [([o23, o25][i])["year"] for i in idx] == [2025] and flags == ["year_disagree"]
    # agreeing colours: still 2025, no flag
    o23b = _obs("2023", year=2023, tone=(0.71, 0.41, 0.31))
    idx, flags = A.select_views([o23b, o25], "wall")
    assert [([o23b, o25][i])["year"] for i in idx] == [2025] and flags == []


def test_sun_selection_uses_2023_when_2025_is_shadowed():
    sh25 = _obs("2025", year=2025, sunlit=False, tone=(0.40, 0.38, 0.36))
    sun23 = _obs("2023", year=2023, tone=(0.45, 0.42, 0.40), px=800)
    idx, flags = A.select_views([sh25, sun23], "wall")
    assert [([sh25, sun23][i])["year"] for i in idx] == [2023] and flags == []
    c = A.combine([sh25, sun23], "wall")
    assert c["sunlit"] and c["year"] == 2023 and not c["shadow_corrected"]
    # 2023 sunlit disagrees strongly with the white-balanced 2025 shadow tone: repainted -> keep 2025, flag
    far23 = _obs("2023", year=2023, tone=(0.9, 0.2, 0.2), px=800)
    idx, flags = A.select_views([sh25, far23], "wall")
    assert [([sh25, far23][i])["year"] for i in idx] == [2025] and flags == ["year_disagree"]
    c = A.combine([sh25, far23], "wall")
    assert not c["sunlit"] and c["flags"] == ["year_disagree"]


def test_sun_selection_shadow_only_picks_best_and_flags_nothing():
    a = _obs("a", year=2023, sunlit=False, px=3000)
    b = _obs("b", year=2025, sunlit=False, px=2500)
    idx, flags = A.select_views([a, b], "wall")
    assert 1 in idx and flags == []  # newest gets a small preference


def test_brick_prior_only_touches_ambiguous_shadow_walls():
    ref = [0.55, 0.28, 0.22]
    grey_shadow = {"tone": [0.55, 0.55, 0.57], "sunlit": False}
    assert A.apply_brick_prior(grey_shadow, ref)
    r, g, b = grey_shadow["tone"]
    assert r > g * 1.1 and grey_shadow["prior"] == "brick"
    sunlit_grey = {"tone": [0.55, 0.55, 0.57], "sunlit": True}  # confident observation (painted brick)
    assert not A.apply_brick_prior(sunlit_grey, ref) and sunlit_grey["tone"] == [0.55, 0.55, 0.57]
    confident_yellow = {"tone": [0.80, 0.70, 0.40], "sunlit": False}  # saturated: not ambiguous
    assert not A.apply_brick_prior(confident_yellow, ref)


def test_pitched_roof_flag_and_dsm_sampling():
    b = ccw_box("p", 0, 0, 20, -10, 10)
    sc = A.build_scene([b])
    arr = np.full((60, 60), 6.84, np.float32)  # ground at local y 0
    for r in range(19, 32):  # rows cover z -10..0 (+margin)
        for c in range(20, 40):
            arr[r, c] = 6.84 + 10 + (3.0 - abs(c - 30) * 0.3)  # ridge 3 m above the eave
    dsm = A.DSM(arr, -20.0, -30.0, 1.0)
    pts, rise = A.pitched_roofs(sc, [b], dsm)
    assert rise[0] > 1.5 and sc.roof_of[0] in pts
    P = pts[sc.roof_of[0]]
    assert len(P) >= 6 and (P[:, 1] >= 10 - 1e-6).all()  # lifted to / above the eave plane
    flat_arr = np.full((60, 60), 16.84, np.float32)
    _, rise2 = A.pitched_roofs(sc, [b], A.DSM(flat_arr, -20.0, -30.0, 1.0))
    assert rise2[0] < 1.5


def test_polytri_matches_shapely_area_for_concave_with_holes():
    import polytri
    outer = np.array([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10.0]])
    hole = np.array([[1, 1], [1, 3], [3, 3], [3, 1.0]])
    p = np.vstack([outer, hole])
    t = polytri.triangulate([outer, hole])
    area = sum(abs((p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0])) / 2 for a, b, c in t)
    assert abs(area - (64 - 4)) < 1e-9
