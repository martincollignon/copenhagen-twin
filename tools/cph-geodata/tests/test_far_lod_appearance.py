import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import far_lod as F  # noqa: E402


def test_summary_used_when_record_has_no_observed():
    app = {"summary": {"wall": [0.5, 0.5, 0.5], "roof": [0.2, 0.3, 0.4]}}
    assert F.wall_tone({}, app) == F.albedo_srgb([0.5, 0.5, 0.5])
    assert F.roof_tone({}, app) == F.albedo_srgb([0.2, 0.3, 0.4])


def test_falls_back_without_summary():
    b = {"roof_material": "tegl", "facade": {"tone": [0.6, 0.4, 0.3]}}
    assert F.roof_tone(b, {"summary": {"wall": None, "roof": None}}) == F.ROOF_COLOURS["tegl"]
    assert F.roof_tone(b) == F.ROOF_COLOURS["tegl"]
    y = 0.3 * 0.6 + 0.59 * 0.4 + 0.11 * 0.3
    assert F.wall_tone(b, None) == tuple(c + (y - c) * F.WALL_DESAT for c in (0.6, 0.4, 0.3))


def test_albedo_has_no_pure_white():
    assert max(F.albedo_srgb([1.0, 1.0, 1.0])) < 0.85
