import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pytest.importorskip("shapely")

from lakes import build_lakes  # noqa: E402


def sq(x0, z0, x1, z1):
    # counter-clockwise seen from above (x east, z south) = negative shoelace area in x/z
    return [x0, z0, x0, z1, x1, z1, x1, z0]


def area(r):
    return sum(r[i] * r[(i + 2) % len(r) + 1] - r[(i + 2) % len(r)] * r[i + 1] for i in range(0, len(r), 2)) / 2


def test_lakes_separated_by_a_bridge_strip_are_joined_and_the_strip_is_reported():
    geo = {
        "frame": {},
        "water": [{"id": "w1", "name": "Peblinge Sø", "ring": sq(0, 0, 100, 100), "src": ["osm:1"]},
                  {"id": "pond", "name": "", "ring": sq(300, 300, 310, 310), "src": ["osm:2"]}],
        "parks": [{"id": "kk:parkregister:parkregister.161", "name": "Søerne", "ring": sq(0, 120, 100, 220), "src": ["kk"]},
                  {"id": "kk:parkregister:parkregister.162", "name": "Søerne", "ring": sq(400, 400, 500, 500), "src": ["kk"]}],
    }
    doc = build_lakes(geo)
    assert len(doc["lakes"]) == 1, "joined across the 20 m strip; .162 shore strips are not water"
    assert abs(doc["lakes"][0]["area_m2"] - (100 * 220)) < 50
    assert len(doc["bridges"]) == 1 and 1900 < doc["bridges"][0]["area_m2"] < 2100
    assert doc["bridges"][0]["open_edges"], "the strip opens onto the lakes"
    assert len(doc["ponds"]) == 1
    assert area(doc["lakes"][0]["ring"]) < 0, "rings follow the geodata orientation"


def test_surface_polygons_over_a_lake_are_cut():
    geo = {"frame": {}, "water": [{"id": "w1", "name": "", "ring": sq(0, 0, 100, 100), "src": ["osm:1"]}], "parks": []}
    surfaces = {"surfaces": [{"id": "gravel", "cls": "gravel", "ring": sq(-50, -50, 150, 150)},
                             {"id": "inside", "cls": "gravel", "ring": sq(10, 10, 20, 20)},
                             {"id": "away", "cls": "gravel", "ring": sq(300, 300, 320, 320)}]}
    cuts = {c["id"]: c["replace"] for c in build_lakes(geo, surfaces)["surface_cuts"]}
    assert "away" not in cuts
    assert cuts["inside"] == [], "a surface wholly in the lake is dropped"
    assert cuts["gravel"] and cuts["gravel"][0].get("holes") or len(cuts["gravel"]) >= 1
