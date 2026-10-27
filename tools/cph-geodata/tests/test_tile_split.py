import json
from pathlib import Path

import pytest

import frame
import tile_split as T

DATA = Path(__file__).resolve().parents[3] / "data"


def test_ownership_by_centroid_and_tile_edges():
    # local x=0,z=0 is E 723900, N 6176500 -> tile 1447_12353; x=100 is E 724000 -> the next tile east
    assert T.owner_of_point({"x": 0, "z": 0}) == "1447_12353"
    assert T.owner_of_point({"x": 99.99, "z": -0.01}) == "1447_12353"
    assert T.owner_of_point({"x": 100.0, "z": -0.01}) == "1448_12353"
    # a building sticking out of its tile belongs to the tile of its bbox centre
    ring = [90, -10, 130, -10, 130, -30, 90, -30]  # centre x = 110
    assert T.owner_of_ring({"ring": ring}) == "1448_12353"
    assert T.owner_of_line({"pts": [-10, -10, 10, -30]}) == "1447_12353"


def _mini(tmp_path):
    b = lambda i, x, z: {"id": f"gdk:{i}", "ring": [x, z, x + 10, z, x + 10, z - 10, x, z - 10]}  # noqa: E731
    geo = {"version": "cph-geodata/1", "frame": {}, "buildings": [b(1, 150, 0), b(2, 0, 0), b(3, 200, 0)],
           "roads": [{"id": "r", "pts": [0, 0, 5, 5]}], "roadGraph": {"nodes": [], "links": []}, "cycleTracks": [], "sidewalks": [],
           "water": [], "parks": [], "points": {"signals": [], "trees": [{"x": 150, "z": 0}], "bikeRacks": [], "benches": [], "lights": []},
           "heroes": [], "meta": {}}
    (tmp_path / "cph-geodata.json").write_text(json.dumps(geo))
    return geo


def test_split_keeps_every_item_once_and_orders(tmp_path):
    geo = _mini(tmp_path)
    tiles, meta, rg, extra, bins = T.split_all(tmp_path)
    owners = {tid: [b["id"] for b in L["buildings"]["buildings"]] for tid, L in tiles.layers.items() if "buildings" in L}
    assert owners == {"1448_12353": ["gdk:1", "gdk:3"], "1447_12353": ["gdk:2"]}
    out, city = tmp_path / "tiles", tmp_path / "city"
    T.write_all(tiles, meta, rg, extra, bins, out, city, tmp_path)
    again = T.assemble(out, city)
    assert again["geodata"]["buildings"] == geo["buildings"]  # original order restored via ord
    assert again["geodata"]["points"]["trees"] == geo["points"]["trees"]


@pytest.mark.skipif(not (DATA / "cph-geodata.json").exists(), reason="no district data")
def test_district_roundtrip_is_lossless(tmp_path):
    tiles, meta, rg, extra, bins = T.split_all(DATA)
    out, city = tmp_path / "tiles", tmp_path / "city"
    index = T.write_all(tiles, meta, rg, extra, bins, out, city, DATA)
    assert len(index["tiles"]) >= 9
    got = T.assemble(out, city)
    for key, fname in (("geodata", "cph-geodata.json"), ("surfaces", "cph-surfaces.json"), ("furniture", "cph-furniture.json"),
                       ("vegetation", "cph-vegetation.json"), ("entrances", "cph-entrances.json"), ("groundfloor", "cph-groundfloor.json"),
                       ("terrain", "cph-terrain.json")):
        p = DATA / fname
        if not p.exists():
            continue
        want = json.loads(p.read_text())
        if key == "geodata":
            want.pop("points_keys", None)
        assert got[key] == want, key
    lod2 = json.loads((DATA / "lod2" / "index.json").read_text())
    assert set(got["lod2"]["buildings"]) <= set(lod2["buildings"])
    # every roofer record survives byte for byte
    for tid, t in index["tiles"].items():
        if "lod2.bin" not in t["layers"]:
            continue
        buf = (out / tid / "lod2.bin").read_bytes()
        entries = json.loads((out / tid / "lod2.json").read_text())["buildings"]
        for bid, e in entries.items():
            if "offset" in e:
                old = lod2["buildings"][bid]
                src = (DATA / "lod2" / lod2["tiles"][old["tile"]]["file"]).read_bytes()
                assert buf[e["offset"]:e["offset"] + e["length"]] == src[old["offset"]:old["offset"] + old["length"]]
