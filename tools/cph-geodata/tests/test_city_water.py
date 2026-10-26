import numpy as np
from shapely.geometry import LineString, Polygon, box

import city_water as W


def shoelace(flat):
    n = len(flat) // 2
    return sum(flat[2 * i] * flat[2 * ((i + 1) % n) + 1] - flat[2 * ((i + 1) % n)] * flat[2 * i + 1] for i in range(n))


def test_rings_follow_the_geodata_convention():
    p = box(0, 0, 10, 10).difference(box(4, 4, 6, 6))  # exterior counter-clockwise in x / z, hole the other way
    rec = W.poly_rec(p)
    assert shoelace(rec["ring"]) < 0, "counter-clockwise seen from above is a negative shoelace in x / z"
    assert shoelace(rec["holes"][0]) > 0
    assert len(rec["ring"]) == 8


def test_densify_keeps_vertices_and_splits_long_segments():
    pts = W.densify([(0, 0), (20, 0), (20, 4)], 8.0)
    assert pts[0] == (0, 0) and (20, 0) in [(round(x, 6), round(z, 6)) for x, z in pts] and pts[-1] == (20, 4)
    assert all(np.hypot(b[0] - a[0], b[1] - a[1]) <= 8.0 + 1e-9 for a, b in zip(pts[:-1], pts[1:]))


def test_cells_are_run_length_coded_by_row():
    runs = W.rle_cells([[3, 1], [4, 1], [5, 1], [9, 1], [3, 2]])
    assert runs == [[1, 3, 3], [1, 9, 1], [2, 3, 1]]


def test_lattice_cut_leaves_out_cells_inside_water_and_clips_the_rest(monkeypatch):
    tid = "1446_12352"
    x0, z0, x1, z1 = W.frame.tile_bounds_local(tid)
    # a 41 m wide band of water across the tile's middle, off the 4 m lattice
    water = box(x0 - 50, z0 + 100.3, x1 + 50, z0 + 141.7)
    cut = W.lattice_cut(water, [tid])[tid]
    assert cut["keyed"] and cut["cell"] == 4.0
    skipped = sum(n for _, _, n in cut["skip"])
    assert skipped > 100 and cut["pieces"], "whole cells inside, partial cells along the two banks"
    for i, j, ring in cut["pieces"]:
        cx0, cz0 = -750 + 4 * i, -750 + 4 * j
        assert shoelace(ring) < 0
        for k in range(0, len(ring), 2):
            assert cx0 - 1e-6 <= ring[k] <= cx0 + 4 + 1e-6 and cz0 - 1e-6 <= ring[k + 1] <= cz0 + 4 + 1e-6
        assert not Polygon([(ring[k], ring[k + 1]) for k in range(0, len(ring), 2)]).buffer(-0.01).intersects(water)
    # cell centres belong to the tile that contains them: nothing of the band lies outside this tile's rows
    rows = {j for j, _, _ in cut["skip"]}
    assert all(x0 - 4 <= -750 + 4 * (i + 0.5) <= x1 + 4 for _, i0, _ in cut["skip"] for i in (i0,))
    assert min(rows) >= (z0 + 750) // 4 - 1 and max(rows) <= (z1 + 750) // 4 + 1


def test_the_sea_is_the_side_of_the_coast_line_that_is_on_its_right():
    coast = LineString([(0, 0), (100, 0)])  # OSM: land on the left of the way (north, y up)
    north, south = box(0, 0, 100, 100), box(0, -100, 100, 0)
    sea = W.sea_faces([coast], [north, south])
    assert sea.equals(south)
    sea = W.sea_faces([LineString([(100, 0), (0, 0)])], [north, south])
    assert sea.equals(north), "the same line the other way round turns land and sea over"


class FlatDtm:
    """DTM stub: ground at 2.0 m on land, the water level (-1.0 m) on the water side x < 0."""

    def at(self, x, z):
        x = np.asarray(x, dtype=float)
        return np.where(x < 0, -1.0, 2.0)


def test_quay_top_is_the_land_side_terrain_plus_coping_and_never_under_the_freeboard():
    from shapely import prepare

    water = box(-100, -100, 0, 100)
    prepare(water)
    top = W.wall_tops(np.array([[0.0, 0.0]]), np.array([-1.0]), water, FlatDtm())
    assert abs(top[0] - (2.0 + W.WALL_TOP)) < 1e-9
    low = W.wall_tops(np.array([[0.0, 0.0]]), np.array([1.9]), water, FlatDtm())  # water almost at the land
    assert abs(low[0] - (1.9 + W.MIN_FREEBOARD)) < 1e-9
    nowhere = W.wall_tops(np.array([[-50.0, 0.0]]), np.array([-1.0]), box(-1e3, -1e3, 1e3, 1e3), FlatDtm())  # all probes wet
    assert abs(nowhere[0] - (-1.0 + 0.8 + W.WALL_TOP)) < 1e-9


def test_isolated_flips_in_the_quay_flags_are_smoothed():
    assert W.smooth_flags([True, True, False, True, True]) == [True] * 5
    assert W.smooth_flags([True, False, False, True]) == [True, False, False, True]
