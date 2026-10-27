import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import task  # noqa: E402


def feat(x0, y0, x1, y1, own=True, yoc=1900, fid="1"):
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": {"id": fid, "bid": f"gdk:{fid}", "yoc": yoc, "ground": 5.0, "own": own, "year_conf": "measured"}}


def test_pick_cell():
    assert task.pick_cell("# c\n6176_723\n\n6177_724\n", 1) == "6177_724"
    try:
        task.pick_cell("6176_723\n", 3)
    except SystemExit:
        return
    raise AssertionError


def test_neighbours_only_where_a_footprint_reaches_the_strip():
    cell = "6176_723"  # E 723000-724000, N 6176000-6177000
    inner = [feat(723400, 6176400, 723450, 6176450)]
    assert task.neighbour_tiles_needed(cell, inner) == []
    east = [feat(723990, 6176400, 724010, 6176420)]
    assert task.neighbour_tiles_needed(cell, east) == ["6176_724"]
    corner = [feat(724001, 6177001, 724010, 6177010, own=False)]
    assert "6177_724" in task.neighbour_tiles_needed(cell, corner)


def test_roofer_inputs_force_lod11_and_manifest():
    doc = {"features": [feat(0, 0, 1, 1, True, 2010, "a"), feat(0, 0, 1, 1, True, 1950, "b"), feat(0, 0, 1, 1, False, 1950, "c"),
                        feat(0, 0, 1, 1, True, 0, "d")]}
    fc, man = task.roofer_inputs(doc, 2019)
    force = {f["properties"]["id"]: f["properties"]["force_lod11"] for f in fc["features"]}
    assert force == {"a": False, "b": False, "c": True, "d": False}
    assert sorted(man) == ["gdk:a", "gdk:b", "gdk:d"]
    fc, man = task.roofer_inputs({"features": [feat(0, 0, 1, 1, True, 2021, "a")]}, 2019)
    assert fc["features"][0]["properties"]["force_lod11"] is True and man["gdk:a"]["post_scan"] is True


def test_roofer_toml_is_rerooted():
    t = task.roofer_toml(2019, Path("/work/6176_723"))
    assert "/work/6176_723/footprints.geojson" in t and "/data" not in t and "date = 2019" in t


def test_veg_pipeline_matches_vegetation_rasters_options():
    p = task.veg_pipeline(Path("/x.laz"), "6176_723", Path("/o"))
    writers = [s for s in p if s["type"] == "writers.gdal"]
    assert len(writers) == 8 and all(w["resolution"] == 1.0 and w["width"] == 1000 and w["origin_x"] == 723000 for w in writers)
    assert writers[-1]["filename"].endswith("gint_6176_723.tif") and writers[-1]["output_type"] == "mean"


def test_local_store_roundtrip(tmp_path):
    s = task.Store(str(tmp_path))
    s.put_bytes("cells/x/DONE.json", b"{}")
    assert s.exists("cells/x/DONE.json") and json.loads(s.get_bytes("cells/x/DONE.json")) == {}
