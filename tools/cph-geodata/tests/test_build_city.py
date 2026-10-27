import json

import build_city as BC
import frame
import tile_split as T


def test_cells_and_tiles_agree():
    # four 500 m tiles fill one 1 km LoD2 / DHM cell, whose bbox matches the tiles
    tiles = {t: {} for t in ("1446_12352", "1447_12352", "1446_12353", "1447_12353", "1448_12353")}
    cells = BC.cells_of(tiles)
    assert cells == {"6176_723": ["1446_12352", "1446_12353", "1447_12352", "1447_12353"], "6176_724": ["1448_12353"]}
    assert BC.cell_bbox_utm("6176_723") == (723000.0, 6176000.0, 724000.0, 6177000.0)
    for tid in cells["6176_723"]:
        e0, n0, e1, n1 = frame.tile_bounds_utm(tid)
        c = BC.cell_bbox_utm("6176_723")
        assert c[0] <= e0 and e1 <= c[2] and c[1] <= n0 and n1 <= c[3]


def test_layers_drop_items_of_tiles_that_are_not_ours():
    L = BC.Layers({"1447_12353"})
    L.add("1447_12353", "roads", "roads", {"id": "a"}, 0)
    L.add("9_9", "roads", "roads", {"id": "b"}, 1)
    assert [r["id"] for r in L.t.layers["1447_12353"]["roads"]["roads"]] == ["a"]
    assert L.dropped["roads.roads"] == 1


def test_centroid_ownership_has_one_owner_across_cells():
    # a footprint sticking out of its cell belongs to the tile of its bbox centre only
    ring = [490, -10, 530, -10, 530, -30, 490, -30]  # centre x = 510 -> E 724410 -> tile 1448
    assert T.owner_of_ring({"ring": ring}) == "1448_12353"


def test_graph_components_counts_islands():
    g = {"nodes": [0, 0, 1, 0, 2, 0, 9, 9, 10, 9], "links": [[0, 1], [1, 2], [3, 4]]}
    c = BC.graph_components(g)
    assert c["components"] == 2 and c["largest"][0] == 3 and c["largest_share"] == 0.6


def test_done_markers_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(BC, "STATE", tmp_path)
    assert not BC.is_done("x")
    BC.mark_done("x", n=3)
    assert BC.is_done("x") and BC.read_done("x")["n"] == 3
