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
    assert t["veg_frac"] > 0.2
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
