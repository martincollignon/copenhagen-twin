"""The atlas pipeline's port of the engine wall frame (engine_walls.py) and the scene / strip shape built from it.

    uv run --with pytest --with numpy --with pillow --with scipy --with rasterio --with pyproj --with requests --with numba \
        pytest tools/cph-geodata/tests/test_engine_walls.py

The last test runs the engine's own JS (tools/audit/engine_wall_tops.mjs) on a real tile and compares every wall, when node and the
tile data are available.
"""
import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest

import appearance as A
import engine_walls as EW

ROOT = Path(__file__).resolve().parents[3]

# tests/lod2-geometry.test.mjs: a 10 x 6 m gabled house, ground 5, eave 9, ridge 11 along x
RING = [0, 0, 10, 0, 10, -6, 0, -6]
P = {"A": [0, 5, 0], "B": [10, 5, 0], "C": [10, 5, -6], "D": [0, 5, -6], "a": [0, 9, 0], "b": [10, 9, 0], "c": [10, 9, -6],
     "d": [0, 9, -6], "r0": [0, 11, -3], "r1": [10, 11, -3]}
NAMES = list(P)
TRIS = [
    (("A", "B", "b"), 1, 0), (("A", "b", "a"), 1, 0),
    (("B", "C", "c"), 1, 1), (("B", "c", "r1"), 1, 1), (("B", "r1", "b"), 1, 1),
    (("C", "D", "d"), 1, 2), (("C", "d", "c"), 1, 2),
    (("D", "A", "a"), 1, 3), (("D", "a", "r0"), 1, 3), (("D", "r0", "d"), 1, 3),
    (("a", "b", "r1"), 0, -1), (("a", "r1", "r0"), 0, -1), (("d", "r0", "r1"), 0, -1), (("d", "r1", "c"), 0, -1),
]


def pack(tops=(9, 9, 9, 9)) -> bytes:
    out = struct.pack("<fffHHH", 5, 0, -3, len(NAMES), len(TRIS), len(tops))
    for n in NAMES:
        x, y, z = P[n]
        out += struct.pack("<hhh", round((x - 5) * 100), round(y * 100), round((z + 3) * 100))
    for t, _, _ in TRIS:
        out += struct.pack("<HHH", *(NAMES.index(n) for n in t))
    out += bytes(k for _, k, _ in TRIS)
    out += struct.pack(f"<{len(TRIS)}h", *(e for _, _, e in TRIS))
    out += struct.pack(f"<{len(tops)}h", *(EW.LOD2_NO_TOP if t is None else round(t * 100) for t in tops))
    return out


def house(**kw):
    return {"id": "gdk:1", "ring": RING, "holes": [], "ground": 5.0, "eave": 9.6, **kw}


def test_record_and_edge_tops():
    rec = EW.parse_lod2_record(pack((9, 9, None, 7.5)))
    assert rec["nT"] == len(TRIS) and rec["nE"] == 4
    f = EW.frame(house(), rec)
    tops = {k: round(v["top"], 3) for k, v in f["edges"].items()}
    # edge 2 has no roofer top: the DSM eave; edge 3 its own lower roofer top
    assert tops == {(0, 0): 9.0, (0, 1): 9.0, (0, 2): 9.6, (0, 3): 7.5}
    assert f["lod2"] and len(f["roof"]) == 4


def test_gable_pieces_and_no_lod2_fallback():
    f = EW.frame(house(), EW.parse_lod2_record(pack()))
    for e in ((0, 1), (0, 3)):  # the gable ends
        ys = [p[1] for t in f["edges"][e]["pieces"] for p in t]
        assert ys and min(ys) >= 9 - 1e-3 and abs(max(ys) - 11) < 1e-3
    assert all(p[1] <= 9 + 1e-3 for t in f["edges"][(0, 0)]["pieces"] for p in t)  # the long walls: at most clipAbove's eave slivers
    # no record (LoD1 / inferred, or a footprint the street layout clipped): every wall ends at max(eave, ground + 0.5)
    g = EW.frame(house(eave=5.2), None)
    assert g["eave"] == 5.5 and all(v["top"] == 5.5 and not v["pieces"] for v in g["edges"].values())


def test_terrain_ground_moves_an_inferred_eave():
    assert EW.engine_ground(house(), {"gdk:1": 4.0}) == (4.0, 9.6)  # measured ground: the absolute eave stays
    assert EW.engine_ground(house(conf_fields={"ground": "inferred"}), {"gdk:1": 4.0}) == (4.0, 8.6)


def test_scene_and_strip_shape_follow_the_engine_frame():
    b = house()
    f = EW.frame(b, EW.parse_lod2_record(pack()))
    sc = A.build_scene([b], frames=[f])
    east = sc.wall_of[(0, 0, 1)]
    south = sc.wall_of[(0, 0, 0)]
    assert abs(sc.surf_eave[east] - 4) < 1e-6 and abs(sc.surf_height[east] - 6) < 1e-3
    assert abs(sc.surf_height[south] - 4) < 1e-6 and south not in sc.surf_pieces
    shape = A.wall_shape(sc, east, 0.1)
    assert shape.shape == A.strip_size(sc, east, 0.1)[::-1]
    assert shape[-1].all() and shape[shape.shape[0] // 2:].all()  # the wall below the eave
    assert not shape[0, 0] and not shape[0, -1] and shape[1, shape.shape[1] // 2]  # the gable triangle: apex in the middle
    gable = shape[:20]  # the top 2 m: a triangle, half of the rectangle
    assert abs(gable.mean() - 0.5) < 0.05
    assert A.wall_shape(sc, south, 0.1) is None
    # the roofer roof is the building's roof surface (the z-buffer occluder), not a flat lid at the DSM eave
    rid = sc.roof_of[0]
    assert (sc.tri_surf == rid).sum() == 4 and sc.verts[sc.tris[sc.tri_surf == rid]][..., 1].max() == pytest.approx(11, abs=1e-3)
    # without frames the scene is the old one
    old = A.build_scene([b])
    assert abs(old.surf_height[old.wall_of[(0, 0, 1)]] - 4.6) < 1e-9 and not old.surf_pieces


def test_fill_fraction_counts_only_the_wall_shape():
    px = np.zeros((10, 10, 3))
    valid = np.zeros((10, 10), bool)
    valid[5:] = True
    inside = valid.copy()
    _, fill = A.fill_texture(px, valid, 0.1, inside)
    assert fill == 0.0
    _, fill = A.fill_texture(px, valid, 0.1)
    assert fill == 0.5


TILE = "1433_12357"


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "data/tiles" / TILE / "lod2.bin").exists(), reason="needs node and the tile data")
def test_port_matches_the_engine_on_a_real_tile():
    out = subprocess.run(["node", str(ROOT / "tools/audit/engine_wall_tops.mjs"), str(ROOT / "data/tiles"), TILE],
                         capture_output=True, text=True, check=True).stdout
    js = json.loads(out)
    tf = EW.TileFrames(ROOT / "data/tiles")
    n = 0
    for b in json.loads((ROOT / "data/tiles" / TILE / "buildings.json").read_text())["buildings"]:
        e = js.get(b["id"])
        if e is None or e["fix"]:
            continue
        f = tf.frame(b, TILE)
        assert f["ground"] == e["ground"] and f["lod2"] == e["lod2"]
        tops = {f"{k[0]}:{k[1]}": round(v["top"], 3) for k, v in f["edges"].items()}
        assert tops == e["edges"], b["id"]
        pieces = {f"{k[0]}:{k[1]}": [round(max(p[1] for t in v["pieces"] for p in t), 3), len(v["pieces"])]
                  for k, v in f["edges"].items() if v["pieces"]}
        assert pieces == e["pieces"], b["id"]
        n += 1
    assert n > 100
