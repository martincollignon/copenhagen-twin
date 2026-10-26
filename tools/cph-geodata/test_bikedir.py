"""Table-driven tests for the OSM bicycle/car direction parsing (bikedir.py).

    uv run --with pytest python -m pytest tools/cph-geodata/test_bikedir.py
    python3 tools/cph-geodata/test_bikedir.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bikedir as B  # noqa: E402

# (name, tags, class, oneway (0/1/-1), carriageway?, expected subset of the parse_bike() result)
CASES = [
    ("two-way street, no infrastructure", {"highway": "residential"}, "residential", 0, True,
     dict(carDir="both", left="none", right="none", carriageway="both", contraflow=False, ban=False)),
    ("one-way street, no infrastructure: bicycles follow the cars", {"highway": "residential", "oneway": "yes"}, "residential", 1, True,
     dict(carDir="fwd", carriageway="fwd", contraflow=False)),
    ("oneway:bicycle=no is a shared contraflow", {"highway": "residential", "oneway": "yes", "oneway:bicycle": "no"}, "residential", 1, True,
     dict(carriageway="both", contraflow=True, contraKind="shared", explicit=True)),
    ("cycleway=opposite is a shared contraflow without any lane", {"highway": "residential", "oneway": "yes", "cycleway": "opposite"}, "residential", 1, True,
     dict(carriageway="both", contraflow=True, contraKind="shared", left="none", right="none")),
    ("cycleway=opposite_lane puts a lane on the left running against the cars",
     {"highway": "residential", "oneway": "yes", "cycleway": "opposite_lane"}, "residential", 1, True,
     dict(contraflow=True, contraKind="lane", left="back", right="back", leftKind="lane")),
    ("cycleway:left=opposite_track", {"highway": "residential", "oneway": "yes", "cycleway:left": "opposite_track"}, "residential", 1, True,
     dict(contraflow=True, contraKind="track", left="back", right="none")),
    ("cycleway:left=lane + cycleway:left:oneway=-1 on a one-way street (Sankt Hans Gade)",
     {"highway": "residential", "oneway": "yes", "cycleway:left": "lane", "cycleway:right": "no", "cycleway:left:oneway": "-1"}, "residential", 1, True,
     dict(left="back", right="none", leftKind="lane", contraflow=True, contraKind="lane", carriageway="both")),
    ("left lane on a one-way street without a direction tag runs with the cars",
     {"highway": "residential", "oneway": "yes", "cycleway:left": "lane"}, "residential", 1, True,
     dict(left="fwd", contraflow=False, carriageway="fwd")),
    ("two-way street with a track each side: right with the way, left against it",
     {"highway": "secondary", "cycleway:both": "track"}, "secondary", 0, True,
     dict(left="back", right="fwd", leftKind="track", rightKind="track", contraflow=False, carDir="both")),
    ("cycleway:right=track only", {"highway": "secondary", "cycleway:right": "track"}, "secondary", 0, True,
     dict(left="none", right="fwd")),
    ("two-way cycle track: cycleway:right:oneway=no", {"highway": "secondary", "cycleway:right": "track", "cycleway:right:oneway": "no"}, "secondary", 0, True,
     dict(right="both", left="none")),
    ("cycleway:left=track + oneway=-1 on a two-way street runs with the way", {"highway": "secondary", "cycleway:left": "track", "cycleway:left:oneway": "yes"}, "secondary", 0, True,
     dict(left="fwd")),
    ("oneway=-1 street: pts are flipped, so the original left side is the right side with the cars",
     {"highway": "residential", "oneway": "-1", "cycleway:left": "track"}, "residential", -1, True,
     dict(carDir="fwd", right="fwd", left="none", carriageway="fwd", contraflow=False)),
    ("oneway=-1 with a contraflow lane: original right side, running with the way = against the cars",
     {"highway": "residential", "oneway": "-1", "cycleway:right": "lane", "cycleway:right:oneway": "yes"}, "residential", -1, True,
     dict(carDir="fwd", left="back", right="none", contraflow=True, contraKind="lane")),
    ("oneway=-1 with oneway:bicycle=no", {"highway": "residential", "oneway": "-1", "oneway:bicycle": "no"}, "residential", -1, True,
     dict(carDir="fwd", carriageway="both", contraflow=True)),
    ("bicycle=no bans bicycles from the carriageway", {"highway": "secondary", "bicycle": "no"}, "secondary", 0, True,
     dict(ban=True, carriageway="none", contraflow=False)),
    ("bicycle=use_sidepath bans the carriageway and the sidepath is mapped separately",
     {"highway": "secondary", "bicycle": "use_sidepath", "cycleway:right": "separate"}, "secondary", 0, True,
     dict(ban=True, carriageway="none", sidepath="right", rightKind="sidepath", right="fwd")),
    ("bicycle=no on a one-way street is no contraflow", {"highway": "residential", "oneway": "yes", "oneway:bicycle": "no", "bicycle": "no"}, "residential", 1, True,
     dict(ban=True, contraflow=False, carriageway="none")),
    ("oneway:bicycle=yes on a two-way street makes bicycles one-way", {"highway": "residential", "oneway:bicycle": "yes"}, "residential", 0, True,
     dict(carDir="both", carriageway="fwd", contraflow=False)),
    ("highway=cycleway, no oneway tag: two-way", {"highway": "cycleway"}, "cycleway", 0, False,
     dict(carDir="none", carriageway="both", contraflow=False)),
    ("highway=cycleway, oneway=yes: with the way", {"highway": "cycleway", "oneway": "yes"}, "cycleway", 1, False,
     dict(carriageway="fwd", contraflow=False)),
    ("highway=cycleway, oneway=-1: pts are flipped so fwd", {"highway": "cycleway", "oneway": "-1"}, "cycleway", -1, False,
     dict(carriageway="fwd")),
    ("roundabout carries traffic with the way", {"highway": "secondary", "junction": "roundabout"}, "secondary", 1, True,
     dict(carDir="fwd", carriageway="fwd")),
    ("cycleway:both:lane advisory is a painted lane each side", {"highway": "residential", "cycleway:both": "lane"}, "residential", 0, True,
     dict(left="back", right="fwd", leftKind="lane", rightKind="lane")),
    ("shared_lane keeps its sharrow kind", {"highway": "residential", "cycleway:right": "shared_lane"}, "residential", 0, True,
     dict(right="fwd", rightKind="shared")),
    ("cycleway=no / cycleway:both=no are no infrastructure", {"highway": "residential", "cycleway": "no", "cycleway:both": "no"}, "residential", 0, True,
     dict(left="none", right="none")),
]


class BikeDirection(unittest.TestCase):
    def test_osm_tags(self):
        for name, tags, cls, ow, carriage, want in CASES:
            with self.subTest(name):
                got = B.parse_bike(tags, cls, ow, carriage)
                for k, v in want.items():
                    self.assertEqual(got[k], v, f"{name}: {k}")

    def test_kk_sides_get_the_default_direction(self):
        two_way = B.parse_bike({"highway": "secondary"}, "secondary", 0, True, {"left": "track", "right": "lane"})
        self.assertEqual((two_way["left"], two_way["right"], two_way["leftKind"], two_way["rightKind"]), ("back", "fwd", "track", "lane"))
        self.assertTrue(two_way["inferred"])
        one_way = B.parse_bike({"highway": "residential", "oneway": "yes"}, "residential", 1, True, {"left": "track"})
        self.assertEqual(one_way["left"], "fwd")

    def test_osm_direction_beats_the_kk_default(self):
        got = B.parse_bike({"highway": "secondary", "cycleway:left": "track", "cycleway:left:oneway": "no"}, "secondary", 0, True, {"left": "lane"})
        self.assertEqual((got["left"], got["leftKind"]), ("both", "track"))

    def test_kk_contraflow_merge(self):
        one_way = {"highway": "residential", "oneway": "yes"}
        got = B.parse_bike(one_way, "residential", 1, True)
        self.assertEqual(B.add_kk_contraflow(got, True), "granted")
        self.assertEqual((got["contraflow"], got["contraKind"], got["carriageway"]), (True, "shared", "both"))
        got = B.parse_bike({**one_way, "oneway:bicycle": "no"}, "residential", 1, True)
        self.assertEqual(B.add_kk_contraflow(got, True), "agree")
        got = B.parse_bike({**one_way, "oneway:bicycle": "yes"}, "residential", 1, True)
        self.assertEqual(B.add_kk_contraflow(got, True), "conflict")
        self.assertFalse(got["contraflow"])
        got = B.parse_bike({**one_way, "oneway:bicycle": "no"}, "residential", 1, True)
        self.assertEqual(B.add_kk_contraflow(got, False), "conflict")
        self.assertTrue(got["contraflow"])  # explicit OSM tag stays
        self.assertIsNone(B.add_kk_contraflow(B.parse_bike(one_way, "residential", 1, True), None))
        two_way = B.parse_bike({"highway": "residential"}, "residential", 0, True)
        self.assertIsNone(B.add_kk_contraflow(two_way, True))


if __name__ == "__main__":
    unittest.main()
