"""Offline tests for the citywide atlas phase: texture view choice and the strip quality gate.

    uv run --with pytest --with numpy --with pillow --with scipy --with rasterio --with pyproj --with requests --with numba \
        pytest tools/cph-geodata/tests/test_appearance_city_atlas.py
"""
import numpy as np

import appearance as A
import appearance_city_atlas as AT


RES = {"a25": (0.10, 0.134), "b25": (0.12, 0.15), "c23": (0.08, 0.098), "far25": (0.25, 0.20)}


def obs(view, year, cos=0.6, px=None, shadow=0.0, occ=0.0, vis=0.8, area=300.0):
    # px = visible samples on the tone pass's 1/2 grid: vis * area / (4 * along * up)
    if px is None:
        px = int(vis * area / (4 * RES[view][0] * RES[view][1]))
    return {"view": view, "year": year, "cos": cos, "px": px, "shadow_frac": shadow, "occluded_frac": occ, "kind": "wall"}


def pick(cands, wall, area=300.0):
    o, r = AT.texture_view(cands, wall, RES.get, area, 2)
    return o["view"] if o else None


def test_texture_view_prefers_finer_sampling_within_the_tone_year():
    wall = {"year": 2025, "best": "b25"}
    assert pick([obs("a25", 2025), obs("b25", 2025), obs("far25", 2025)], wall) == "a25"


def test_texture_view_keeps_to_the_tone_flight():
    # the 2023 view samples finer but may show scaffolding / an old paint job: not used for a 2025 tone
    wall = {"year": 2025, "best": "a25"}
    assert pick([obs("a25", 2025), obs("c23", 2023)], wall) == "a25"
    assert pick([obs("a25", 2025), obs("c23", 2023)], {"year": 2023, "best": "c23"}) == "c23"
    # no view of the tone's year at all: any view rather than none
    assert pick([obs("c23", 2023)], wall) == "c23"


def test_texture_view_penalises_grazing_shadow_and_occlusion():
    wall = {"year": 2025}
    assert pick([obs("a25", 2025, cos=0.2), obs("b25", 2025)], wall) == "b25"
    assert pick([obs("a25", 2025, occ=0.8), obs("b25", 2025)], wall) == "b25"
    assert pick([obs("a25", 2025, vis=0.2), obs("b25", 2025)], wall) == "b25"  # mostly hidden by neighbours
    assert pick([], wall) is None


def test_strip_gate():
    good = np.full((40, 60, 4), 128, np.uint8)
    meta = {"h_m": 12.0, "src_m": 0.134, "cos": 0.6}
    assert AT.strip_gate(meta, good) == []
    assert AT.strip_gate({**meta, "h_m": 3.0}, good) == ["low_wall"]
    assert AT.strip_gate({**meta, "src_m": 0.3}, good) == ["low_res"]
    assert AT.strip_gate({**meta, "cos": 0.2}, good) == ["grazing"]
    holes = good.copy()
    holes[:30, :, 3] = 0  # 75 % unobserved after facade_look
    assert AT.strip_gate(meta, holes) == ["unobserved"]
    assert "unobserved" in AT.strip_gate(meta, good[:0])
    # the district / old cells carry no src_m / cos: only the image and wall checks apply
    assert AT.strip_gate({"h_m": 12.0}, good) == []


def test_source_res_matches_the_projection():
    b = {"id": "a", "ring": [0, 0, 20, 0, 20, -10, 0, -10], "holes": [], "ground": 0.0, "eave": 15.0, "roof": "flat"}
    sc = A.build_scene([b])
    sid = sc.wall_of[(0, 0, 0)]

    class Ortho:  # 10 px per metre along x, 8 px per metre up
        def project(self, P):
            P = np.asarray(P, float)
            return P[:, 0] * 10.0, -P[:, 1] * 8.0, np.full(len(P), 100.0)
    along, up = AT.source_res(sc, Ortho(), sid)
    assert abs(along - 0.1) < 1e-9 and abs(up - 0.125) < 1e-9


def test_texel_policy():
    assert AT.texel_for("724_6175", AT.DEFAULT_TEXEL) == 0.10
    assert AT.texel_for("730_6170", AT.DEFAULT_TEXEL) == 0.10  # no coarser rings by default
    assert AT.texel_for("724_6175", "rings") == 0.10
    assert AT.texel_for("731_6182", "rings") == 0.20
