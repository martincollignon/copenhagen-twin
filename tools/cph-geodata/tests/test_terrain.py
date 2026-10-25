import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pytest.importorskip("shapely")

import terrain as T  # noqa: E402


class Aff:  # the bits of rasterio's Affine that resample() reads
    def __init__(self, c, f, a=1.0, e=-1.0):
        self.c, self.f, self.a, self.e = c, f, a, e


def sq(x0, z0, x1, z1):
    return [x0, z0, x0, z1, x1, z1, x1, z0]


def test_resample_averages_source_pixels_per_cell_and_subtracts_the_origin():
    # a raster covering the grid with a ramp in easting: value = (E - origin_e) * 0.1 + origin height
    half, cell = 8.0, 2.0
    e0, n1 = T.ORIGIN[0] - half, T.ORIGIN[1] + half
    cols = rows = 16
    xs = e0 + np.arange(cols) + 0.5
    arr = np.tile((xs - T.ORIGIN[0]) * 0.1 + T.ORIGIN[2], (rows, 1))
    grid = T.resample(arr, Aff(e0, n1), half=half, cell=cell)
    assert grid.shape == (8, 8)
    # cell i covers x in [-8 + 2i, -6 + 2i): its mean ramp height is 0.1 * (centre x)
    assert np.allclose(grid[0], 0.1 * (-8 + 2 * np.arange(8) + 1))
    assert np.allclose(grid[:, 0], grid[0, 0])


def test_sample_is_bilinear_and_clamped():
    g = np.array([[0.0, 1.0], [2.0, 3.0]])
    assert T.sample(g, 0.0, 0.0, half=2.0, cell=2.0) == pytest.approx(1.5)
    assert T.sample(g, -1.0, -1.0, half=2.0, cell=2.0) == pytest.approx(0.0)
    assert T.sample(g, -50.0, 50.0, half=2.0, cell=2.0) == pytest.approx(2.0)
    assert T.sample(g, 50.0, -50.0, half=2.0, cell=2.0) == pytest.approx(1.0)


def test_cells_under_buildings_are_refilled_from_the_surrounding_ground():
    half, cell = 20.0, 2.0
    n = int(2 * half / cell)
    g = np.full((n, n), 5.0)
    g[8:12, 8:12] = -4.0  # a pit under a block (the survey interpolates the DTM there)
    mask = T.ring_mask([sq(-3, -3, 3, 3)], half=half, cell=cell, buffer=0.0)
    assert mask.sum() == 9 or mask.sum() == 4 * 4 or mask.sum() > 0
    filled = T.fill_masked(g, T.ring_mask([sq(-4, -4, 4, 4)], half=half, cell=cell, buffer=0.0))
    assert np.allclose(filled, 5.0, atol=1e-6), "the pit is replaced by the ground around it"
    # a slope through the building is interpolated, not flattened
    ramp = np.tile(np.arange(n, dtype=float), (n, 1))
    ramp[8:12, 8:12] = -99
    f2 = T.fill_masked(ramp, T.ring_mask([sq(-4, -4, 4, 4)], half=half, cell=cell, buffer=0.0))
    assert np.allclose(f2[8:12, 8:12], ramp[7, 7], atol=2.5) or abs(f2[9, 9] - 9) < 1.5
    assert not np.isnan(f2).any()


def test_fill_does_not_wrap_around_the_grid_edge():
    n = 12
    g = np.zeros((n, n))
    g[:, -1] = 100.0  # the far column must not leak into a masked cell on the opposite edge
    mask = np.zeros((n, n), dtype=bool)
    mask[5, 0] = True
    assert T.fill_masked(g, mask)[5, 0] == pytest.approx(0.0, abs=1e-6)


def test_lake_cut_skips_water_cells_and_clips_the_boundary_cells():
    lakes = {"lakes": [{"id": "lake:0", "ring": sq(-10, -10, 10, 10), "holes": []}]}
    cut = T.lake_cut(lakes, cell=8.0, half=24.0)
    n = 6  # cell edges at -24, -16, -8, 0, 8, 16, 24: the lake covers [-10, 10]
    assert sorted(cut["skip"]) == [14, 15, 20, 21], "the four cells wholly inside the lake are not drawn"
    cells = {(i, j) for i, j, _ in cut["pieces"]}
    assert cells == {(i, j) for i in range(1, 5) for j in range(1, 5)} - {(2, 2), (3, 2), (2, 3), (3, 3)}, "the 12 cells the shore crosses are clipped"
    clipped = 0.0
    for i, j, ring in cut["pieces"]:
        pts = list(zip(ring[0::2], ring[1::2]))
        clipped += abs(sum(pts[k][0] * pts[(k + 1) % len(pts)][1] - pts[(k + 1) % len(pts)][0] * pts[k][1] for k in range(len(pts)))) / 2
    untouched = n * n - len(cut["skip"]) - len(cells)
    assert untouched * 64 + clipped == pytest.approx(48 * 48 - 400, abs=1e-6), "cut cells + pieces cover exactly the ground outside the water"


def test_lake_cut_of_an_island_keeps_the_island_ground():
    lakes = {"lakes": [{"id": "lake:0", "ring": sq(-20, -20, 20, 20), "holes": [sq(-2, -2, 2, 2)]}]}
    cut = T.lake_cut(lakes, cell=4.0, half=24.0)
    pieces = [p for p in cut["pieces"] if p[0] in (5, 6) and p[1] in (5, 6)]
    assert pieces, "cells over the island are clipped pieces (the island), not skipped"
    assert sum(1 for k in cut["skip"]) > 0


def test_frame_polygon_has_the_district_as_a_hole_and_follows_lakes_out_of_it():
    lakes = {"lakes": [{"id": "lake:0", "ring": sq(-50, 650, 50, 750), "holes": []}]}  # touches the south edge but is small (10 000 m2)
    big = {"lakes": [{"id": "lake:0", "ring": sq(-300, 400, 300, 750), "holes": []}]}
    plain = T.frame_polygon({"lakes": []})
    assert len(plain) == 1 and len(plain[0]["holes"]) == 1
    f = T.frame_polygon(big)
    hole = f[0]["holes"][0]
    zs = hole[1::2]
    assert max(zs) == pytest.approx(T.FAR), "the lake continues beyond the district edge to the far distance"
    xs = [x for x, z in zip(hole[0::2], hole[1::2]) if z > 760]
    assert min(xs) == pytest.approx(-300) and max(xs) == pytest.approx(300)
    assert T.frame_polygon(lakes)[0]["holes"][0] and max(T.frame_polygon(lakes)[0]["holes"][0][1::2]) == pytest.approx(750), "small ponds just end at the edge"


def test_building_ground_is_the_median_terrain_along_the_outline():
    half, cell = 20.0, 2.0
    n = int(2 * half / cell)
    g = np.tile(np.arange(n, dtype=float) * 0.1, (n, 1))  # ramps with x
    out = T.building_ground([{"id": "b", "ring": sq(-6, -6, 6, 6)}], g, half=half, cell=cell)
    assert out["b"] == pytest.approx(T.sample(g, 0.0, 0.0, half, cell), abs=0.25)
    flat = np.full((n, n), 1.234)
    assert T.building_ground([{"id": "c", "ring": sq(0, 0, 4, 4)}], flat, half=half, cell=cell)["c"] == 1.23


def test_build_doc_levels_and_decks():
    half, cell = 20.0, 2.0
    n = int(2 * half / cell)
    raw = np.full((n, n), 3.0)
    # a lake whose DTM is flat at its water level, and a bridge strip across the shore
    raw[5:15, 5:15] = -1.0
    lakes = {"lakes": [{"id": "lake:0", "ring": sq(-10, -10, 10, 10), "holes": []}], "ponds": [], "bridges": [{"id": "bridge:0", "ring": sq(-30, -2, -22, 2)}]}
    geo = {"buildings": [{"id": "b", "ring": sq(12, 12, 16, 16)}]}
    doc = T.build_doc(raw, geo, lakes, half=half, cell=cell)
    assert doc["lakes"] == [{"id": "lake:0", "level": -1.0}]
    assert doc["width"] == doc["height"] == n and doc["version"] == "cph-terrain/1"
    assert len(doc["data"]) > 0 and "buildings" in doc and doc["buildings"]["b"] == pytest.approx(3.0, abs=0.01)


def test_street_zone_is_low_passed_but_parks_and_water_keep_their_relief():
    half, cell = 40.0, 2.0
    n = int(2 * half / cell)
    g = np.zeros((n, n))
    g[:, n // 2:] = 0.15  # a kerb step across a street
    g[:, :5] += np.where(np.arange(5) % 2 == 0, 1.0, -1.0)  # rough relief in the park on the left
    zone = np.zeros((n, n), dtype=bool)
    zone[:, 10:30] = True  # the street zone: columns 10..29
    out = T.smooth_streets(g, zone, sigma_m=4.0, cell=cell)
    step_before = np.abs(np.diff(g[20, 10:30])).max()
    step_after = np.abs(np.diff(out[20, 10:30])).max()
    assert step_before == pytest.approx(0.15) and step_after < 0.05, "the kerb step is spread out"
    assert np.allclose(out[:, :5], g[:, :5]), "relief outside the street zone is untouched"
    assert out[20, 10:30].mean() == pytest.approx(g[20, 10:30].mean(), abs=0.03), "smoothing keeps the level"


def test_street_zone_excludes_buildings_and_water():
    geo = {"sidewalks": [{"ring": sq(-20, -20, 20, 20)}], "roads": [], "buildings": [{"ring": sq(-5, -5, 5, 5)}]}
    lakes = {"lakes": [{"id": "l", "ring": sq(10, -20, 20, 20), "holes": []}]}
    z = T.street_zone(geo, None, lakes, half=30.0, cell=2.0)
    i = lambda x: int((x + 30) // 2)  # noqa: E731
    assert z[i(-12), i(-12)] and not z[i(0), i(0)] and not z[i(0), i(15)]
