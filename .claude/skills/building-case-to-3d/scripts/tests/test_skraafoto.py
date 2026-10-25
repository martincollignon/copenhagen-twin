"""Offline checks for the SAUL camera projection used by skraafoto.py."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import skraafoto


def nadir_camera():
    return {
        "pers:omega": 0.0,
        "pers:phi": 0.0,
        "pers:kappa": 0.0,
        "pers:perspective_center": [725000.0, 6176000.0, 3500.0],
        "pers:interior_orientation": {
            "focal_length": 122.982,
            "pixel_spacing": [0.0069333, 0.0069333],
            "principal_point_offset": [0.0, 0.0],
            "sensor_array_dimensions": [5775.0, 7725.0],
        },
    }


def live_oblique_camera():
    return {
        "pers:omega": -44.94026,
        "pers:phi": -0.02549,
        "pers:kappa": 179.91875,
        "pers:perspective_center": [724230.51, 6177872.975, 1192.729],
        "pers:rotation_matrix": [
            -0.9999988955637256, 0.0006895263283999381, -0.0013165959028893987,
            -0.0014180794016294075, -0.7078434023480131, 0.7063679684153292,
            -0.00044488441165794085, 0.7063690553144519, 0.7078435983831661,
        ],
        "pers:interior_orientation": {
            "focal_length": 112.0,
            "pixel_spacing": [0.0046366, 0.0046366],
            "principal_point_offset": [0.0, 0.0],
            "sensor_array_dimensions": [11508.0, 8628.0],
        },
    }


def test_nadir_identity_camera_projects_camera_foot_to_sensor_center():
    camera = nadir_camera()
    col, row = skraafoto.world_to_pixel(camera, 725000.0, 6176000.0, 10.0)
    assert abs(col - 5775 / 2) <= 1
    assert abs(row - 7725 / 2) <= 1


def test_offset_point_and_nadir_round_trip_match_go_fixtures():
    camera = nadir_camera()
    col, row = skraafoto.world_to_pixel(camera, 725100.0, 6176000.0, 10.0)
    assert col > 5775 / 2
    px, py = skraafoto.pixel_to_world(camera, col, row, 10.0)
    assert abs(px - 725100.0) < 0.1
    assert abs(py - 6176000.0) < 0.1

    # Go's real nadir-camera fixture from TestPixelToWorldAtDistance_RealPhoto.
    real_nadir = {
        "pers:omega": 0.07398,
        "pers:phi": -0.00946,
        "pers:kappa": -0.20687,
        "pers:perspective_center": [721726.873, 6180449.344, 1189.25],
        "pers:interior_orientation": {
            "focal_length": 71.0,
            "pixel_spacing": [0.0046366, 0.0046366],
            "principal_point_offset": [0.0, 0.0],
            "sensor_array_dimensions": [11508.0, 8628.0],
        },
    }
    point = (721869.45, 6180413.85, 26.38)
    col, row = skraafoto.world_to_pixel(real_nadir, *point)
    assert abs(col - 7631.0) <= 1.0
    assert abs(row - 4794.0) <= 1.0
    rx, ry = skraafoto.pixel_to_world(real_nadir, col, row, point[2])
    assert abs(rx - point[0]) < 0.001
    assert abs(ry - point[1]) < 0.001


def test_live_oblique_rotation_convention_and_round_trip():
    camera = live_oblique_camera()
    built = skraafoto._rotation(camera)
    supplied = np.asarray(camera["pers:rotation_matrix"]).reshape(3, 3)
    # Go/SAUL D is the transpose of STAC's row-major pers:rotation_matrix.
    assert np.max(np.abs(built - supplied.T)) < 1e-4

    point = (724275.0, 6176650.0, 42.5)
    col, row = skraafoto.world_to_pixel(camera, *point)
    rx, ry = skraafoto.pixel_to_world(camera, col, row, point[2])
    assert abs(rx - point[0]) <= 0.001
    assert abs(ry - point[1]) <= 0.001

    # A ground point roughly 1.2 km south of the camera is inside the frame.
    col, row = skraafoto.world_to_pixel(camera, 724230.51, 6177872.975 - 1200, 10.0)
    assert 0 <= col < 11508
    assert 0 <= row < 8628
