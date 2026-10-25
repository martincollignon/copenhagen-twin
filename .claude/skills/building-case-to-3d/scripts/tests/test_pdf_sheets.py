import csv
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw


SCRIPT = Path(__file__).resolve().parents[1] / "pdf_sheets.py"
POPPLER = ("pdftoppm", "pdfimages", "pdfinfo", "pdftotext")


@pytest.mark.skipif(any(shutil.which(tool) is None for tool in POPPLER), reason="Poppler is required")
def test_inventory_writes_sheets_and_page_csv_for_quoted_path(tmp_path: Path) -> None:
    pages = []
    for number in range(1, 4):
        page = Image.new("RGB", (612, 792), "white")
        ImageDraw.Draw(page).text((30, 30), f"Page {number}", fill="black")
        pages.append(page)
    pdf = tmp_path / "permit set (A).pdf"
    pages[0].save(pdf, save_all=True, append_images=pages[1:], resolution=72)

    out_dir = tmp_path / "sheets"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "inventory", "--out", str(out_dir), str(pdf)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert len(list(out_dir.glob("sheet_*_1.png"))) == 1
    with (out_dir / "pages.csv").open(encoding="utf-8", newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
    assert len(rows) == 3
    assert [row["page"] for row in rows] == ["1", "2", "3"]
    assert all(row["file"] == str(pdf) for row in rows)
    assert rows[0]["has_text"] == "false"
    assert rows[0]["text_chars"] == "0"
