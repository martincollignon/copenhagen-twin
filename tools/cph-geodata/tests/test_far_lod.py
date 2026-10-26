import base64
import json
import struct

import numpy as np

import far_lod as F
import frame


def _building(i, x, z, size=20, eave=12.0, ridge=12.2, ground=3.0, tone=(0.6, 0.4, 0.3), holes=None):
    return {
        "id": f"gdk:{i}", "ring": [x, z, x + size, z, x + size, z - size, x, z - size], "holes": holes or [],
        "ground": ground, "eave": eave, "ridge": ridge, "roof": "flat", "roof_material": "tegl", "facade": {"tone": list(tone)},
    }


def test_footprint_simplified_and_small_ones_dropped():
    # 40 vertices on a 20 m square, 5 cm of noise: simplified to the four corners
    ring = []
    n = 10
    for k in range(n):
        ring += [k * 2.0, 0.03 * (k % 2)]
    for k in range(n):
        ring += [20.0 + 0.03 * (k % 2), -k * 2.0]
    for k in range(n):
        ring += [20.0 - k * 2.0, -20.0 + 0.03 * (k % 2)]
    for k in range(n):
        ring += [0.03 * (k % 2), -20.0 + k * 2.0]
    b = {"id": "gdk:1", "ring": ring, "holes": []}
    outer, holes = F.simplify_building(b, 1.2, 22.0, 60.0)
    assert 4 <= len(outer) <= 6 and not holes
    # a shed under min-area is dropped
    shed = _building(2, 0, 0, size=4)
    assert F.simplify_building(shed, 1.2, 22.0, 60.0) is None
    # a courtyard under --min-hole is filled, a big one kept
    big = _building(3, 0, 0, size=60, holes=[[20, -20, 20, -40, 40, -40, 40, -20]])
    small = _building(4, 0, 0, size=60, holes=[[20, -20, 20, -25, 25, -25, 25, -20]])
    assert len(F.simplify_building(big, 1.2, 22.0, 60.0)[1]) == 1
    assert F.simplify_building(small, 1.2, 22.0, 60.0)[1] == []


def test_top_height_and_tones():
    assert F.top_height({"eave": 10.0, "ridge": 10.1}) == 10.0
    assert abs(F.top_height({"eave": 10.0, "ridge": 14.0}) - 12.2) < 1e-9
    b = _building(1, 0, 0, tone=(0.5, 0.5, 0.5))
    assert F.wall_tone(b) == (0.5, 0.5, 0.5)
    b["observed"] = {"walls": [{"conf": "observed", "tone": [0.8, 0.7, 0.6]}, {"conf": "observed", "tone": [0.6, 0.5, 0.4]}, {"conf": "inferred", "tone": [0, 0, 0]}]}
    assert F.wall_tone(b)[0] in (0.6, 0.7, 0.8)  # the median of the observed walls, the inferred one ignored
    assert F.roof_tone({"roof_material": "tegl"}) == F.ROOF_COLOURS["tegl"]
    assert F.roof_tone({"observed": {"roof": {"conf": "observed", "tone": [0.1, 0.2, 0.3]}}}) == (0.1, 0.2, 0.3)


def test_height_grid_bilinear_and_sea_default():
    tid = "1447_12353"
    bounds = frame.tile_bounds_local(tid)
    w = 250
    chunk = {"x0": bounds[0], "z0": bounds[1], "w": w, "h": w, "cell": 2.0,
             "data": base64.b64encode(np.full(w * w, 500, dtype="<i2").tobytes()).decode()}  # 5.00 m everywhere
    g = F.height_grid(chunk, bounds)
    assert g.shape == (17, 17) and np.allclose(g, 5.0)
    assert np.allclose(F.height_grid(None, bounds), F.SEA)


def test_tile_block_layout_decodes(tmp_path):
    tid = "1447_12353"
    bounds = frame.tile_bounds_local(tid)
    xmin, zmin = bounds[0], bounds[1]
    tdir = tmp_path / tid
    tdir.mkdir()
    b = _building(1, xmin + 100, zmin + 200, size=30)
    (tdir / "buildings.json").write_text(json.dumps({"tile": tid, "buildings": [b, _building(2, xmin + 10, zmin + 10, size=3)]}))
    w = 250
    (tdir / "terrain.json").write_text(json.dumps({"tile": tid, "chunk": {"x0": xmin, "z0": zmin, "w": w, "h": w, "cell": 2.0, "data": base64.b64encode(np.full(w * w, 300, dtype="<i2").tobytes()).decode()}, "buildings": {}}))
    data, n, heights = F.tile_block(tid, tmp_path, None, 1.2, 22.0, 60.0)
    assert n == 1  # the 3 m shed is gone
    count, _ = struct.unpack_from("<HH", data, 0)
    assert count == 1
    off = 4 + 17 * 17 * 2 + 32
    n_outer, n_holes, base, top = struct.unpack_from("<BBhh", data, off)
    assert (n_outer, n_holes) == (4, 0)
    assert base == round((3.0 - 1.0) * 100) and top == round(12.0 * 100)
    wall = struct.unpack_from("<BBB", data, off + 6)
    # the facade preset tone (0.6, 0.4, 0.3) is pulled WALL_DESAT of the way to its luminance (f8880b2: the far city is not painted brick orange)
    y = 0.3 * 0.6 + 0.59 * 0.4 + 0.11 * 0.3
    assert wall == tuple(round(255 * (c + (y - c) * F.WALL_DESAT)) for c in (0.6, 0.4, 0.3))  # (141, 106, 88)
    xs = [struct.unpack_from("<hh", data, off + 12 + 4 * k) for k in range(4)]
    # relative to the tile's north-west corner, in decimetres
    assert xs[0] == (1000, 2000)
    assert len(data) == off + 12 + 4 * 4
    assert np.allclose(heights, 3.0)


def test_water_levels_follow_the_shore(tmp_path):
    ring = [0, 0, 400, 0, 400, 300, 0, 300]
    (tmp_path / "lakes.json").write_text(json.dumps({"lakes": [{"id": "lake:1", "name": "A", "ring": ring}, {"id": "lake:2", "name": "Sea", "ring": [5000, 5000, 6000, 5000, 6000, 6000, 5000, 6000]}], "ponds": []}))
    tid = frame.tile_of_local(200, 150)
    h_shore = np.full((17, 17), 0.4, dtype=np.float32)
    h_sea = np.full((17, 17), F.SEA + 0.5, dtype=np.float32)
    heights = {tid: h_shore, frame.tile_of_local(5500, 5500): h_sea}
    out = F.water_polygons(tmp_path, heights)
    by = {w["id"]: w for w in out}
    assert abs(by["lake:1"]["level"] - 0.4) < 1e-6  # an inland lake sits at its shore
    assert by["lake:2"]["level"] == F.SEA  # near the sea: the sea
