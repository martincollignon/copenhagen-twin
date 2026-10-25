import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from surfaces import MARKING_KIND, classify_osm, classify_surface  # noqa: E402


def test_register_materials_map_to_twin_classes():
    assert classify_surface("Grus")[0] == "gravel"
    assert classify_surface("Perlesten")[0] == "gravel"
    assert classify_surface("Asfalt") == ("asphalt_road", "observed")
    assert classify_surface("Træhulsrist")[0] == "other"
    # concrete slabs: Københavnerfortov on a street, Rådhusbelægning on a square
    assert classify_surface("Betonsten og -fliser", "Gader og pladser", "Øvrig gade")[0] == "kbh_fortov"
    assert classify_surface("Betonsten og -fliser", "Gader og pladser", "Øvrig plads")[0] == "raadhus"
    # natural stone: setts in a street, cobbles on a square; the pattern is our reading, not the register's
    assert classify_surface("Natursten og -fliser", "Gader og pladser", "Øvrig gade") == ("setts", "inferred")
    assert classify_surface("Natursten og -fliser", "Gader og pladser", "Øvrig plads")[0] == "cobbles"
    assert classify_surface(None)[0] == "other"


def test_osm_squares():
    assert classify_osm({"surface": "sett"}) == ("setts", "observed")
    assert classify_osm({"surface": "paving_stones"})[0] == "raadhus"
    assert classify_osm({"place": "square"}) == ("cobbles", "inferred")


def test_marking_kinds_cover_every_kk_type():
    for t in ("Hvidafmærkning", "Fodgængerfelt", "Blå cykelfelt", "Pileafmærkning", "Parkering", "Symboler på kørebane"):
        assert t in MARKING_KIND
    assert MARKING_KIND["Blå cykelfelt"] == "bluecycle"


def test_sanitize_repairs_bowtie_and_keeps_valid_polygons():
    import pytest  # noqa: PLC0415

    pytest.importorskip("shapely")
    from surfaces import sanitize  # noqa: PLC0415

    valid = {"id": "v", "ring": [0, 0, 10, 0, 10, 10, 0, 10], "holes": [[2, 2, 4, 2, 4, 4, 2, 4]]}
    assert sanitize(valid) == [valid]
    bowtie = {"id": "b", "ring": [0, 0, 10, 10, 10, 0, 0, 10]}
    parts = sanitize(bowtie)
    assert len(parts) == 2 and {p["id"] for p in parts} == {"b", "b~1"}
