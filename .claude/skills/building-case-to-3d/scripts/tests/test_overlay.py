import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "overlay.py"


def test_glb_overlay_writes_clipped_silhouette(tmp_path):
    has_trimesh = importlib.util.find_spec("trimesh") is not None

    glb = tmp_path / "unit cube.glb"
    make_cube = (
        "import sys, trimesh; "
        "trimesh.creation.box(extents=(1, 1, 1)).export(sys.argv[1])"
    )
    make_command = ([sys.executable, "-c", make_cube, str(glb)] if has_trimesh else
                    ["uv", "run", "--with", "trimesh", "python", "-c", make_cube, str(glb)])
    subprocess.run(
        make_command,
        check=True,
        capture_output=True,
        text=True,
    )

    camera = tmp_path / "cameras.json"
    camera.write_text(json.dumps([{
        "view_id": "synthetic-oblique",
        "image_size": [800, 600],
        "crop": {"x0": 0, "y0": 0, "x1": 800, "y1": 600, "overview_factor": 1},
        "pers": {
                "pers:omega": 26.565051,
            "pers:phi": 0.0,
            "pers:kappa": 0.0,
                "pers:perspective_center": [0.0, -10.0, 20.0],
            "pers:interior_orientation": {
                "focal_length": 30.0,
                "pixel_spacing": [0.01, 0.01],
                "principal_point_offset": [0.0, 0.0],
                "sensor_array_dimensions": [800.0, 600.0],
            },
        },
    }]), encoding="utf-8")
    frame = tmp_path / "building.json"
    frame.write_text(json.dumps({"frame": {"origin": [0.0, 0.0, 0.0]}}), encoding="utf-8")
    image = tmp_path / "crop.jpg"
    Image.new("RGB", (800, 600), (90, 100, 110)).save(image)
    output = tmp_path / "overlay.png"

    run_command = [sys.executable, str(SCRIPT)] if has_trimesh else ["uv", "run", str(SCRIPT)]
    result = subprocess.run(
        [
            *run_command,
            "--camera", f"{camera}#synthetic-oblique",
            "--image", str(image),
            "--model", str(glb),
            "--frame", str(frame),
            "--alpha", "0.2",
            "--out", str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert output.is_file()
    assert Image.open(output).size == (800, 600)

    sidecar = json.loads(Path(str(output) + ".json").read_text(encoding="utf-8"))
    assert len(sidecar["silhouette"]) > 4
    assert sidecar["bbox"] is not None
    assert 0 <= sidecar["bbox"]["x0"] <= sidecar["bbox"]["x1"] < 800
    assert 0 <= sidecar["bbox"]["y0"] <= sidecar["bbox"]["y1"] < 600
