import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from furniture import bay_layout, classify_lamp, genus_key, parking_kind, parse_mast, tree_age  # noqa: E402


def test_genus_families():
    assert genus_key("Lind", "Tilia europaea") == "lime"
    assert genus_key("Hestekastanie", "Aesculus hippocastanum") == "chestnut"
    assert genus_key("Platan", "Platanus hybr. acerifolia") == "plane"  # not maple via 'acerifolia'
    assert genus_key("Løn", "Acer platanoides") == "maple"
    assert genus_key("Kirsebær/Blomme", "Prunus avium 'Plena'") == "cherry"
    assert genus_key("Elm") == "elm" and genus_key("Eg") == "oak"
    assert genus_key(None, None, None) == "generic"


def test_tree_age():
    assert tree_age("1953") == 73
    assert tree_age("Ikke registreret") is None


def test_mast_parsing():
    assert parse_mast("Københavnermast 9,0m") == {"kind": "kbh", "h": 9.0, "arm": None}
    m = parse_mast("Ørestadsmast 7,5/2,4m (RAL 7024)")
    assert m["h"] == 7.5 and m["arm"] == 2.4
    assert parse_mast("Rørmast 4,0m")["kind"] == "tube"
    assert parse_mast("2,8m Parklygte LP-lygte")["kind"] == "park"


def test_lamp_classes():
    led = classify_lamp("BGS441 GRN80 2S/830 SN (80 LED)", "", 80)
    assert led["light"] == "led" and led["cct"] == 3000 and led["led"]
    na = classify_lamp("AMT SDS 351-150-108 F, horn", "HNa (150 watt)", 170)
    assert na["light"] == "sodium" and na["cct"] == 2000
    mh = classify_lamp("AMT CGS 441 CDO-ET 70W", "Metalhalogen, HCI/EP 70W/830 E27", 86)
    assert mh["light"] == "metalhalide" and mh["cct"] == 3000
    assert classify_lamp("Thorn 72LED 865", "")["cct"] <= 5000


def test_bays():
    assert parking_kind("Afmærket skråparkering, 45°") == ("ang", 45.0)
    assert parking_kind("Afmærket skråparkering, 90°")[0] == "perp"
    assert parking_kind("Uafmærket parkering")[0] == "par"
    n, step = bay_layout(27.0, 5, "par")
    assert n == 5 and abs(step - 5.4) < 1e-9
    n, _ = bay_layout(10.0, 40, "par")
    assert n <= 4, "the register count cannot exceed what fits"
