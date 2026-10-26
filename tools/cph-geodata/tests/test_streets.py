import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pytest.importorskip("shapely")

from shapely.geometry import LineString  # noqa: E402

import streets as S  # noqa: E402


def sq(x0, z0, x1, z1):
    return [x0, z0, x0, z1, x1, z1, x1, z0]


def scene(edges_car, edges_cyc=(), sidewalks=(), buildings=(), road_pts=(0, 0, 80, 0), cls="residential", lakes=None, cycle_tag="none"):
    geo = {
        "roads": [{"id": "r", "name": "Teststr", "class": cls, "pts": list(road_pts), "width": 12.0, "lanesFwd": 1, "lanesBack": 1, "oneway": False, "cycleTrack": cycle_tag}],
        "buildings": [{"id": f"b{i}", "ring": r} for i, r in enumerate(buildings)] or [{"id": "far", "ring": sq(900, 900, 910, 910)}],
        "sidewalks": [{"id": f"s{i}", "ring": r} for i, r in enumerate(sidewalks)] or [{"id": "sfar", "ring": sq(900, 900, 910, 910)}],
        "cycleTracks": [],
        "roadGraph": {"nodes": [0.0, 0.0, 80.0, 0.0], "links": [[0, 1, 1, 1, 12.0, 30, 0, 0, 0, 0]], "names": [""], "classes": [cls]},
    }
    vk = {"car": [LineString(e) for e in edges_car], "cyc": [LineString(e) for e in edges_cyc]}
    return geo, vk, lakes or {"lakes": [], "bridges": [], "ponds": []}


def test_the_road_is_recentred_on_its_measured_edges_and_gets_their_half_width():
    # carriageway edges at z = -4 and z = +6: the street is 10 m wide, its middle lies 1 m to the right of the OSM line
    geo, vk, lakes = scene([[(-10, -4), (100, -4)], [(-10, 6), (100, 6)]])
    doc = S.build_doc(geo, lakes, vk)
    r = doc["roads"]["r"]
    assert r["hw"] == pytest.approx(5.0, abs=0.05)
    zs = r["p"][1::2]
    assert all(z == pytest.approx(1.0, abs=0.1) for z in zs), "re-centred 1 m towards the +z (right of travel) side"
    assert r["prov"].startswith("measured")
    # the graph follows: nodes shifted, link width = the measured kerb-to-kerb width
    moved = {i: (x, z) for i, x, z in doc["graph"]["nodes"]}
    assert moved[0][1] == pytest.approx(1.0, abs=0.1) and moved[1][1] == pytest.approx(1.0, abs=0.1)
    assert doc["graph"]["widths"] == [[0, pytest.approx(10.0, abs=0.1)]]


def test_a_side_without_a_vejkant_falls_back_to_the_pavement_edge_then_the_building_line():
    # right side: pavement polygon from z = 5; left side: only a building at z = -9 (minus 1.8 m of frontage -> edge at 7.2... capped by lanes)
    geo, vk, lakes = scene([], sidewalks=[sq(-10, 5, 100, 9)], buildings=[sq(-10, -20, 100, -9)])
    doc = S.build_doc(geo, lakes, vk)
    r = doc["roads"]["r"]
    assert r["prov"].startswith("building"), "the weakest source used is the building line"
    # right edge 5 (pavement), left edge 9 - 1.8 = 7.2: centred on 1.1 m to the left, half width 6.1
    assert r["hw"] == pytest.approx(6.1, abs=0.15)


def test_cycle_strip_width_from_the_vejkant_cycle_lines_and_its_ranges_avoid_buildings():
    geo, vk, lakes = scene([[(-10, -4), (100, -4)], [(-10, 4), (100, 4)]], edges_cyc=[[(-10, 6.4), (100, 6.4)]],
                           sidewalks=[sq(-10, 6.5, 100, 10)], buildings=[sq(30, 4.5, 40, 12)])
    doc = S.build_doc(geo, lakes, vk)
    r = doc["roads"]["r"]
    assert "cr" in r, "a cycle track on the right"
    w, ranges = r["cr"]
    assert w == pytest.approx(6.4 - 4 - 0.3, abs=0.1)
    # the footprint at x in [30, 40] stands where the strip would: the strip is cut there
    assert len(ranges) == 2
    assert ranges[0][1] <= 30.5 and ranges[1][0] >= 39.5


def test_pavements_lose_the_carriageway_strips_and_buildings():
    geo, vk, lakes = scene([[(-10, -4), (100, -4)], [(-10, 4), (100, 4)]], sidewalks=[sq(-10, 3.8, 100, 12)], buildings=[sq(50, 8, 60, 14)])
    doc = S.build_doc(geo, lakes, vk)
    from shapely.ops import unary_union

    pav = [S.poly_of(g["ring"]) for g in doc["sidewalks"]]
    u = unary_union(pav)
    road = S.road_ribbon(doc["roads"]["r"]["p"], doc["roads"]["r"]["hw"])
    assert u.intersection(road).area < 0.5, "pavement never overlaps the carriageway"
    assert u.intersection(S.poly_of(sq(50, 8, 60, 14))).area < 0.5, "nor a building"
    # 110 x 8.2 m of pavement minus the 10 x 4 m footprint (the carriageway edge at z = 4 leaves a 0.2 m strip untouched)
    assert u.area == pytest.approx(110 * 8.2 - 40 - 80 * 0.2, rel=0.03)


def test_a_road_through_a_building_is_cut_and_a_gateway_is_dropped():
    geo, vk, lakes = scene([[(-10, -4), (200, -4)], [(-10, 4), (200, 4)]], road_pts=(0, 0, 200, 0), buildings=[sq(80, -10, 90, 10)])
    doc = S.build_doc(geo, lakes, vk)
    ids = {"r"} | {e["id"] for e in doc["extraRoads"]}
    assert len(ids) == 2, "cut into two pieces at the footprint"
    xs = [x for e in [doc["roads"]["r"]] + doc["extraRoads"] for x in e["p"][0::2]]
    assert not any(80.3 < x < 89.7 for x in xs), "nothing inside the footprint"
    # a short road wholly inside a building is a gateway
    geo2, vk2, lakes2 = scene([], road_pts=(0, 0, 30, 0), buildings=[sq(-5, -5, 40, 5)])
    assert S.build_doc(geo2, lakes2, vk2)["roads"]["r"]["drop"] == "passage"


def test_arc_intervals_pads_and_drops_short_runs():
    import numpy as np

    iv = S.arc_intervals(20.0, lambda s: (s < 6) | ((s > 10) & (s < 11)), step=0.5, min_len=2.0)
    assert len(iv) == 1 and iv[0][0] == 0.0 and iv[0][1] == pytest.approx(6.0, abs=0.3)
    assert S.arc_intervals(20.0, lambda s: np.ones(len(s), dtype=bool))[0] == [0.0, 20.0]


def test_a_dual_carriageway_neighbour_halves_the_width():
    # two parallel one-way roads 8 m apart, no edge lines: neither may claim more than 4 m on the shared side
    geo, vk, lakes = scene([])
    geo["roads"].append({"id": "r2", "name": "Teststr", "class": "residential", "pts": [0, 8.0, 80, 8.0], "width": 12.0, "lanesFwd": 1, "lanesBack": 0, "oneway": True, "cycleTrack": "none"})
    geo["buildings"] = [{"id": "b1", "ring": sq(-10, -9.5, 100, -6)}, {"id": "b2", "ring": sq(-10, 14, 100, 18)}]
    doc = S.build_doc(geo, lakes, vk)
    a = S.road_ribbon(doc["roads"]["r"]["p"], doc["roads"]["r"]["hw"])
    b = S.road_ribbon(doc["roads"]["r2"]["p"], doc["roads"]["r2"]["hw"])
    assert a.intersection(b).area < 1.0


# ----------------------------------------------------------------------------------------------- data errors
def bld(bid, ring, **kw):
    return {"id": bid, "ring": ring, **kw}


def test_footprint_overlaps_follow_source_precedence_and_report():
    from shapely.geometry import Polygon

    water = Polygon()
    geo = {"heroes": [{"building_id": "gdk:1000000003"}], "buildings": [
        bld("gdk:1000000001", sq(0, 0, 40, 20)),  # old block 800 m2
        bld("gdk:1200000002", sq(30, 0, 50, 20)),  # newer neighbour overlapping its east end by 10 x 20 = 200 m2
        bld("gdk:1100000004", sq(5, 5, 9, 9)),  # a 16 m2 shed drawn on the old block: hidden inside it
        bld("gdk:1000000003", sq(100, 0, 120, 20)),  # a hero
        bld("gdk:1300000005", sq(110, 0, 130, 20)),  # newer, overlapping the hero: the hero wins
        bld("kk:bygning:7", sq(200, 0, 210, 10)),  # a KK footprint ...
        bld("gdk:1000000006", sq(200, 0, 210, 10)),  # ... duplicated by an older GeoDanmark one: GeoDanmark outranks KK
    ]}
    res = S.resolve_buildings(geo, water)
    assert res["drop"]["gdk:1100000004"] == "inside-larger"
    assert "gdk:1200000002" not in res["drop"] and "gdk:1200000002" not in res["clip"], "the newer footprint is untouched"
    piece = res["clip"]["gdk:1000000001"]["pieces"][0]
    assert piece.area == pytest.approx(600.0, abs=0.5), "the older block loses the 200 m2 overlap"
    assert "gdk:1000000003" not in res["drop"] and "gdk:1000000003" not in res["clip"], "heroes are never touched"
    assert res["clip"]["gdk:1300000005"]["pieces"][0].area == pytest.approx(200.0, abs=0.5), "even a newer footprint yields the overlap to a hero"
    assert res["drop"].get("kk:bygning:7") == "overlap-older"
    assert {r["id"] for r in res["report"]} >= {"gdk:1100000004", "gdk:1000000001", "kk:bygning:7"}


def test_a_house_in_a_lake_is_dropped_and_one_on_the_quay_is_clipped():
    water = S.poly_of(sq(0, 0, 100, 100))
    geo = {"heroes": [], "buildings": [bld("gdk:1", sq(10, 10, 20, 20)), bld("gdk:2", sq(95, 40, 115, 60))]}
    res = S.resolve_buildings(geo, water)
    assert res["drop"] == {"gdk:1": "in-water"}
    assert res["clip"]["gdk:2"]["pieces"][0].area == pytest.approx(300, abs=1)
    rec = S.building_records(geo, res)
    assert rec["drop"] == [{"id": "gdk:1", "reason": "in-water"}] and rec["clip"][0]["pieces"][0]["ring"]


def test_ground_surfaces_lose_roads_buildings_parks_and_the_losing_class():
    from shapely.geometry import Polygon

    carriage = {"r": S.poly_of(sq(0, 40, 100, 50))}
    surfaces = {"surfaces": [
        {"id": "osm:square", "cls": "cobbles", "ring": sq(0, 0, 100, 100)},  # a 100 x 100 'square' enclosing a street, a house and a park
        {"id": "kk:gravel", "cls": "gravel", "ring": sq(60, 60, 80, 80)},  # the register beats OSM where both cover a spot
    ]}
    geo = {"parks": [{"id": "p", "ring": sq(0, 0, 30, 30)}]}
    house = S.poly_of(sq(0, 60, 30, 100))
    cuts, stats = S.compile_surfaces(surfaces, geo, Polygon(), carriage, [], house)
    by = {c["id"]: c["replace"] for c in cuts}
    area = sum(S.poly_of(r["ring"], r.get("holes", ())).area for r in by["osm:square"])
    # 10 000 - street 1 000 - house 1 200 - park 900 - gravel 400 = 6 500
    assert area == pytest.approx(10000 - 1000 - 1200 - 900 - 400, abs=5)
    assert "kk:gravel" not in by, "a register polygon clear of everything stays as it is"
    assert stats["osm"] == 1
