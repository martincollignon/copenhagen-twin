import json
import math

import tile_streets as TS


def _graph(points, links):
    nodes = []
    for x, z in points:
        nodes += [x, z]
    return {"nodes": nodes, "links": links, "names": [""], "classes": ["residential"]}


def test_graph_fixes_keep_their_numbering_when_they_fit():
    city = _graph([(0, 0), (10, 0), (20, 0)], [[0, 1, 1, 1, 6, 30, 0, 0, 0, 0], [1, 2, 1, 1, 6, 30, 0, 0, 0, 0]])
    fix = {"nodes": [[1, 10.5, 0.2]], "widths": [[0, 7.5]], "dropLinks": [1]}
    out, rep = TS.remap_graph(fix, None, city)
    assert rep["identity"] and out["nodes"] == fix["nodes"] and out["widths"] == fix["widths"] and out["dropLinks"] == [1]


def test_graph_fixes_are_renumbered_by_position_for_another_graph():
    # the district numbered the same streets differently (node 0 of the district is node 2 of the city, and so on)
    city = _graph([(500, 0), (0, 0), (10, 0), (20, 0)], [[1, 2, 1, 1, 6, 30, 0, 0, 0, 0], [2, 3, 1, 1, 6, 30, 0, 0, 0, 0], [0, 3, 1, 1, 6, 30, 0, 0, 0, 0]])
    survey = _graph([(10, 0), (20, 0), (0, 0)], [[0, 1, 1, 1, 6, 30, 0, 0, 0, 0], [2, 0, 1, 1, 6, 30, 0, 0, 0, 0]])
    fix = {"nodes": [[0, 10.4, 0.1], [9, 1, 1]], "widths": [[0, 8.0], [1, 9.0], [7, 1.0]], "dropLinks": [1]}
    out, rep = TS.remap_graph(fix, survey, city)
    assert not rep["identity"]
    assert out["nodes"] == [[2, 10.4, 0.1]]  # survey node 0 is city node 2; node 9 does not exist
    assert sorted(out["widths"]) == [[0, 9.0], [1, 8.0]] or sorted(out["widths"]) == [[0, 8.0], [1, 9.0]] or len(out["widths"]) == 2
    by_link = dict(map(tuple, out["widths"]))
    # survey link 0 = (10,0)-(20,0) = city link 1; survey link 1 = (0,0)-(10,0) = city link 0
    assert by_link == {1: 8.0, 0: 9.0}
    assert out["dropLinks"] == [0]
    assert rep["nodes"] == [1, 2] and rep["widths"][0] == 2


def test_ownership_by_bbox_centre():
    assert TS.owner([0, 0, 10, -10]) == "1447_12353"
    assert TS.owner([]) is None
    x0, z0, x1, z1 = TS.doc_extent({"roads": {"a": {"p": [0, 0, 10, 5]}}, "extraRoads": [{"p": [-5, 1]}], "sidewalks": [{"ring": [3, 9, 4, 12]}], "cycleTracks": [{"pts": [2, -7]}]})
    assert (x0, z0, x1, z1) == (-5, -7, 10, 12)


def test_buckets_and_manifest(tmp_path):
    tiles = tmp_path / "tiles"
    city = tmp_path / "city"
    for t in ("1447_12353", "1448_12353"):
        (tiles / t).mkdir(parents=True)
    (tiles / "1447_12353" / "roads.json").write_text(json.dumps({"roads": [{"id": "osm:way/1"}]}))
    (tiles / "1448_12353" / "roads.json").write_text(json.dumps({"roads": [{"id": "osm:way/2"}]}))
    (tiles / "1447_12353" / "buildings.json").write_text(json.dumps({"buildings": [{"id": "gdk:9"}]}))
    city.mkdir()
    streets = {
        "version": "cph-streets/1",
        "roads": {"osm:way/1": {"p": [0, 0, 50, 0], "hw": 3}, "osm:way/2": {"p": [120, 0, 160, 0], "hw": 3}},
        "extraRoads": [{"id": "osm:way/2#1", "base": "osm:way/2", "p": [130, 0, 140, 0], "hw": 3}],
        "graph": {"nodes": [], "widths": [], "dropLinks": []},
        "sidewalks": [{"id": "s1", "ring": [10, -2, 20, -2, 20, -4, 10, -4]}, {"id": "s2", "ring": [130, -2, 140, -2, 140, -4, 130, -4]}],
        "cycleTracks": [{"id": "c1", "pts": [5, -5, 15, -5]}],
        "buildings": {"drop": [{"id": "gdk:9", "reason": "x"}], "clip": []},
        "surfaceCuts": [],
    }
    (city / "streets.json").write_text(json.dumps(streets))
    (city / "roadgraph.json").write_text(json.dumps(_graph([(0, 0), (10, 0)], [[0, 1, 1, 1, 6, 30, 0, 0, 0, 0]])))
    import sys
    argv = sys.argv
    sys.argv = ["tile_streets", "--tiles", str(tiles), "--city", str(city), "--data", str(tmp_path / "nodata")]
    try:
        assert TS.main() == 0
    finally:
        sys.argv = argv
    a = json.loads((tiles / "1447_12353" / "streets.json").read_text())
    b = json.loads((tiles / "1448_12353" / "streets.json").read_text())
    assert list(a["roads"]) == ["osm:way/1"] and list(b["roads"]) == ["osm:way/2"]
    assert [e["id"] for e in b["extraRoads"]] == ["osm:way/2#1"]  # an extra piece goes with its base road's tile
    assert [s["id"] for s in a["sidewalks"]] == ["s1"] and [s["id"] for s in b["sidewalks"]] == ["s2"]
    assert [c["id"] for c in a["cycleTracks"]] == ["c1"]
    assert a["buildings"]["drop"][0]["id"] == "gdk:9"
    post = json.loads((city / "post.json").read_text())
    assert post["streets"]["graph"] == "streets-graph.json" and set(post["streets"]["tiles"]) == {"1447_12353", "1448_12353"}
    assert math.isfinite(post["streets"]["tiles"]["1447_12353"])
