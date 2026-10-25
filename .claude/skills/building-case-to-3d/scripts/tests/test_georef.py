import csv
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "georef.py"
SPEC = importlib.util.spec_from_file_location("georef", SCRIPT)
georef = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(georef)


def _synthetic_points():
    rng = np.random.default_rng(41)
    pixels = np.array(
        [[100, 80], [950, 110], [1030, 720], [550, 880], [80, 630], [400, 390], [800, 500]],
        dtype=float,
    )
    scale = 0.0085
    angle = math.radians(17)
    cosine, sine = math.cos(angle), math.sin(angle)
    x_offset, y_offset = 724000.0, 6175000.0
    world = []
    for px, py in pixels:
        u, v = px, -py
        x = x_offset + scale * (cosine * u - sine * v)
        y = y_offset + scale * (sine * u + cosine * v)
        world.append([x, y])
    world = np.asarray(world) + rng.normal(0, 0.01, size=(len(pixels), 2))
    return pixels, world, scale, angle


def test_fit_similarity_recovers_parameters_and_reports_holdout_outlier(tmp_path):
    pixels, world, expected_scale, expected_angle = _synthetic_points()
    rows = []
    for index, ((px, py), (x, y)) in enumerate(zip(pixels, world), start=1):
        rows.append([f"gcp-{index}", px, py, x, y, 1])
    # This point is deliberately withheld from the fit, but must still be
    # projected, reported, and flagged from its residual.
    rows.append(["bad-corner", 600, 1000, 724020, 6174985, 0])
    csv_path = tmp_path / "gcps.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["id", "px", "py", "X", "Y", "use"])
        writer.writerows(rows)

    result = georef.fit_gcps(csv_path, "similarity")

    assert result["scale_m_per_px"] == pytest.approx(expected_scale, abs=0.00005)
    assert result["rotation_deg"] == pytest.approx(math.degrees(expected_angle), abs=0.2)
    assert result["rms_m"] < 0.02
    assert len(result["matrix"]) == 3 and len(result["matrix"][0]) == 3
    holdout = next(point for point in result["points"] if point["id"] == "bad-corner")
    assert holdout["use"] is False
    assert holdout["outlier"] is True
    assert holdout["residual_m"] > 0.5
    assert holdout["loo_residual_m"] == pytest.approx(holdout["residual_m"])
    assert all(point["loo_residual_m"] is not None for point in result["points"][:7])


def test_apply_transforms_csv_and_pixel_geojson(tmp_path):
    transform = {
        "matrix": [[0.01, 0, 700000], [0, -0.01, 6170000], [0, 0, 1]],
    }
    transform_path = tmp_path / "transform.json"
    transform_path.write_text(json.dumps(transform), encoding="utf-8")

    csv_path = tmp_path / "pixels.csv"
    csv_path.write_text("id,px,py\na,20,30\n", encoding="utf-8")
    csv_out = tmp_path / "projected.csv"
    georef.apply_transform(transform_path, csv_path, csv_out)
    with csv_out.open(newline="", encoding="utf-8") as stream:
        row = next(csv.DictReader(stream))
    assert float(row["X"]) == pytest.approx(700000.2)
    assert float(row["Y"]) == pytest.approx(6169999.7)

    geojson_path = tmp_path / "pixels.geojson"
    geojson_path.write_text(
        json.dumps({"type": "Polygon", "coordinates": [[[0, 0], [100, 0], [0, 100], [0, 0]]]}),
        encoding="utf-8",
    )
    geojson_out = tmp_path / "projected.geojson"
    georef.apply_transform(transform_path, geojson_path, geojson_out)
    geometry = json.loads(geojson_out.read_text(encoding="utf-8"))
    assert geometry["coordinates"][0][1] == pytest.approx([700001.0, 6170000.0])
    assert geometry["crs"]["properties"]["name"] == "EPSG:25832"
