import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import furniture_dedupe as D


def test_repeated_points_of_one_source_are_dropped_and_ord_follows():
    doc = {"tile": "t", "ord": {"bollards": [10, 11, 12, 13]},
           "bollards": [{"x": 1.0, "z": 2.0, "src": ["kk:pullert:1"]}, {"x": 1.0, "z": 2.0, "src": ["kk:pullert:1"]},
                        {"x": 1.0, "z": 2.0, "src": ["kk:pullert:2"]}, {"x": 5.0, "z": 2.0, "src": ["kk:pullert:1"]}],
           "lamps": []}
    dropped = D.dedupe_tile(doc)
    assert dict(dropped) == {"bollards": 1}
    assert [(b["x"], b["src"][0]) for b in doc["bollards"]] == [(1.0, "kk:pullert:1"), (1.0, "kk:pullert:2"), (5.0, "kk:pullert:1")]
    assert doc["ord"]["bollards"] == [10, 12, 13]
    assert not D.dedupe_tile(doc), "idempotent"
