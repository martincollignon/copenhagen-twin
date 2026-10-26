import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from entrances import (  # noqa: E402
    BuildingIndex, conf_for, entry_for, link_husnummer, normalise, parse_point, point_in_building, snap_to_walls,
)


def box(id_, x0, z0, x1, z1, bbr=None, holes=None):
    return {"id": id_, "bbr_id": bbr, "ring": [x0, z0, x1, z0, x1, z1, x0, z1], "holes": holes or []}


def hn(x, z, **kw):
    return {"id": kw.pop("id", "h"), "x": x, "z": z, "text": "1", "street": "Gade", **kw}


def test_parse_point():
    assert parse_point("POINT(723934.02 6176501.87)") == (723934.02, 6176501.87)
    assert parse_point(None) is None and parse_point("LINESTRING(0 0, 1 1)") is None


def test_snap_to_nearest_wall_with_distance_and_position_along_it():
    b = box("gdk:1", 0, 0, 20, 10)
    s = snap_to_walls(8, 3, b)
    assert (s["ring"], s["edge"]) == (0, 0)  # the z = 0 wall
    assert abs(s["d"] - 3) < 1e-9 and abs(s["sx"] - 8) < 1e-9 and abs(s["sz"]) < 1e-9
    assert abs(s["along"] - 8) < 1e-9 and abs(s["wall_len"] - 20) < 1e-9


def test_snap_prefers_a_courtyard_hole_wall_when_nearer():
    b = box("gdk:1", 0, 0, 40, 40, holes=[[10, 10, 10, 30, 30, 30, 30, 10]])
    s = snap_to_walls(20, 12, b)
    assert s["ring"] == 1 and abs(s["d"] - 2) < 1e-9


def test_snap_gives_up_beyond_max_distance():
    assert snap_to_walls(100, 100, box("gdk:1", 0, 0, 10, 10)) is None


def test_point_in_building_respects_holes():
    b = box("gdk:1", 0, 0, 40, 40, holes=[[10, 10, 10, 30, 30, 30, 30, 10]])
    assert point_in_building(5, 5, b) and not point_in_building(20, 20, b) and not point_in_building(50, 5, b)


def test_conf_thresholds():
    assert conf_for(1.5) == "measured" and conf_for(1.51) == "observed" and conf_for(3.0) == "observed" and conf_for(3.01) == "inferred"


def test_link_prefers_register_ids_then_footprint_then_nearest_wall():
    a, c = box("gdk:10", 0, 0, 20, 10, bbr="bbr-a"), box("gdk:11", 30, 0, 50, 10, bbr="bbr-c")
    by_gdk, by_bbr = {b["id"]: b for b in (a, c)}, {b["bbr_id"]: b for b in (a, c)}
    idx = BuildingIndex([a, c])
    # id link beats geometry: the point lies in c but the register says a
    assert link_husnummer(hn(40, 5, gdk="10"), by_gdk, by_bbr, idx) == (a, "geoDanmarkBygning")
    assert link_husnummer(hn(40, 5, bbr="bbr-a"), by_gdk, by_bbr, idx) == (a, "bbr")
    assert link_husnummer(hn(40, 5, gdk="999"), by_gdk, by_bbr, idx) == (c, "footprint")
    assert link_husnummer(hn(52, 5), by_gdk, by_bbr, idx) == (c, "nearest")
    assert link_husnummer(hn(90, 90), by_gdk, by_bbr, idx) == (None, None)


def test_entry_records_snap_distance_wall_and_conf():
    b = box("gdk:1", 0, 0, 20, 10, bbr="bbr-1")
    e = entry_for(hn(8, 1.0, id="abc"), b, "geoDanmarkBygning", {"abc"})
    assert e["bid"] == "gdk:1" and e["bbr"] == "bbr-1" and e["d"] == 1.0 and e["conf"] == "measured"
    assert e["opgang"] is True and e["inside"] is True and (e["sx"], e["sz"]) == (8, 0)
    assert entry_for(hn(8, 4.0), b, "bbr", set())["conf"] == "inferred"
    assert entry_for(hn(-60, 5), b, "bbr", set()) is None


def test_normalise_converts_to_local_and_drops_non_gaeldende():
    raw = {"id_lokalId": "u", "status": "3", "husnummertekst": "37A", "geoDanmarkBygning": 1064715171,
           "adgangTilBygning": "bbr", "adgangspunkt": {"position": "POINT(723934.02 6176501.87)", "oprindelse_nøjagtighedsklasse": "A"},
           "vejpunkt": {"position": "POINT(723900 6176500)"}, "navngivenVej": {"vejnavn": "Nørre Søgade"}}
    n = normalise(raw)
    assert (round(n["x"], 2), round(n["z"], 2)) == (34.02, -1.87) and n["road"] == [0.0, 0.0]
    assert n["gdk"] == "1064715171" and n["street"] == "Nørre Søgade" and n["acc"] == "A"
    assert normalise({**raw, "status": "4"}) is None
