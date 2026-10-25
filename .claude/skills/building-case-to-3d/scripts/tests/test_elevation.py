import json, subprocess, sys, shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

SCRIPT = Path(__file__).resolve().parents[1] / "elevation.py"
sys.path.insert(0, str(SCRIPT.parent))
import elevation as E  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("pdftoppm"), reason="poppler missing")


def _sheet(tmp: Path) -> Path:
    # 1:100 at 100 dpi-ish synthetic elevation: 10 m wide facade, two windows on storey "1".
    im = Image.new("RGB", (1200, 700), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([100, 100, 1100, 600], outline="black", width=4)  # facade 0..10 m, 0..5 m
    for x in (250, 650):
        d.rectangle([x, 250, x + 200, 350], outline="black", width=3)
    pdf = tmp / "e.pdf"
    im.save(pdf, resolution=100)
    return pdf


def _building() -> dict:
    return {"storeys": [{"id": "ST", "ffl": 0, "height": 2.5}, {"id": "1", "ffl": 2.5, "height": 2.5}],
            "volumes": [{"id": "volume-1", "outline": [[0, 0], [10, 0], [10, -8], [0, -8]]}],
            "facades": [{"id": "1-street", "volume": "volume-1", "edge": [0, 1], "openings": [], "balconies": []}]}


def _run(*a):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, a)], capture_output=True, text=True, check=True)


def test_trace_roundtrip_and_gate(tmp_path):
    pdf = _sheet(tmp_path)
    b = tmp_path / "b.json"
    b.write_text(json.dumps(_building()))
    # Facade edge (0,0)->(10,0) faces north (y+ outward from centroid at y=-4): viewer looks south (180).
    _run("calibrate", "--pdf", pdf, "--page", 1, "--dpi", 100, "--x", "100:-10", "--x", "1100:0",
         "--z", "600:0", "--z", "100:5", "--view-bearing", 180, "--out", tmp_path / "cal.json")
    _run("detect", "--pdf", pdf, "--page", 1, "--dpi", 100, "--roi", "110,110,1090,590",
         "--out", tmp_path / "c.json", "--overlay", tmp_path / "c.png")
    cands = json.loads((tmp_path / "c.json").read_text())["candidates"]
    assert len(cands) == 2
    _run("to-model", "--cal", tmp_path / "cal.json", "--candidates", tmp_path / "c.json", "--building", b,
         "--sheet", "T:1", "--out", tmp_path / "o.json")
    ops = json.loads((tmp_path / "o.json").read_text())["1-street"]
    assert len(ops) == 2 and all(o["storey"] == "1" for o in ops)
    assert abs(sorted(o["w"] for o in ops)[0] - 2.0) < 0.15
    bd = _building(); bd["facades"][0]["openings"] = ops
    b.write_text(json.dumps(bd))
    _run("check", "--cal", tmp_path / "cal.json", "--building", b, "--traced", tmp_path / "c.json", "--out", tmp_path / "k.png")
    assert json.loads((tmp_path / "k.json").read_text())["status"] == "pass"
    # An invented window must fail the gate.
    bd["facades"][0]["openings"].append({"id": "fake", "storey": "1", "x": 4.6, "w": 0.6, "sill": 0.2, "h": 0.5, "kind": "window"})
    b.write_text(json.dumps(bd))
    _run("check", "--cal", tmp_path / "cal.json", "--building", b, "--traced", tmp_path / "c.json", "--out", tmp_path / "k.png")
    rep = json.loads((tmp_path / "k.json").read_text())
    assert rep["status"] == "fail" and [i["id"] for i in rep["invented"]] == ["fake"]
