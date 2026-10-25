#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow>=10"]
# ///
"""Render PDF pages and prepare labelled contact sheets for drawing review."""

from __future__ import annotations

import argparse
import csv
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


CSV_FIELDS = (
    "file",
    "page",
    "width_pt",
    "height_pt",
    "orientation",
    "image_ppi",
    "image_px_w",
    "image_px_h",
    "has_text",
    "text_chars",
)
POPPLER_TOOLS = ("pdftoppm", "pdfimages", "pdfinfo", "pdftotext")
PAGE_SIZE_RE = re.compile(r"Page\s+(?:(\d+)\s+)?size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts")
PAGE_ROT_RE = re.compile(r"Page\s+(?:(\d+)\s+)?rot:\s*(-?\d+)")
IMAGE_ROW_RE = re.compile(
    r"^\s*(\d+)\s+\d+\s+(\S+)\s+(\d+)\s+(\d+)\s+\S+\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+([\d.]+)\s+([\d.]+)\s+",
    re.MULTILINE,
)


class UserError(Exception):
    """An input or external-tool error suitable for a one-line CLI message."""


class OneLineArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.exit(2, f"error: {message}\n")


def _run(command: list[str]) -> str:
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise UserError(f"required command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "command failed").strip().splitlines()[0]
        raise UserError(f"{command[0]} failed: {detail}") from exc
    return result.stdout


def _require_tools(names: tuple[str, ...]) -> None:
    missing = [name for name in names if shutil.which(name) is None]
    if missing:
        raise UserError(f"missing Poppler command(s): {', '.join(missing)}")


def _check_pdf(path: Path) -> None:
    if not path.is_file():
        raise UserError(f"PDF does not exist or is not a file: {path}")


def _page_count(pdf: Path) -> int:
    info = _run(["pdfinfo", str(pdf)])
    match = re.search(r"^Pages:\s+(\d+)\s*$", info, re.MULTILINE)
    if not match:
        raise UserError(f"could not read page count from {pdf}")
    return int(match.group(1))


def _page_geometry(pdf: Path, count: int) -> dict[int, tuple[float, float, int]]:
    info = _run(["pdfinfo", "-f", "1", "-l", str(count), "-box", str(pdf)])
    sizes: dict[int, tuple[float, float]] = {}
    rotations: dict[int, int] = {}
    for match in PAGE_SIZE_RE.finditer(info):
        number = int(match.group(1) or 1)
        sizes[number] = (float(match.group(2)), float(match.group(3)))
    for match in PAGE_ROT_RE.finditer(info):
        number = int(match.group(1) or 1)
        rotations[number] = int(match.group(2)) % 360
    if not sizes:
        # pdfinfo omits the page number when queried for a single page.
        size = re.search(r"^Page size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts", info, re.MULTILINE)
        if size:
            sizes[1] = (float(size.group(1)), float(size.group(2)))
        rotation = re.search(r"^Page rot:\s*(-?\d+)", info, re.MULTILINE)
        if rotation:
            rotations[1] = int(rotation.group(1)) % 360
    if any(page not in sizes for page in range(1, count + 1)):
        raise UserError(f"could not read page dimensions from {pdf}")
    geometry = {}
    for page, (width, height) in sizes.items():
        rotation = rotations.get(page, 0)
        if rotation in (90, 270):
            width, height = height, width
        geometry[page] = (width, height, rotation)
    return geometry


def _largest_images(pdf: Path) -> dict[int, tuple[int, int, float]]:
    output = _run(["pdfimages", "-list", str(pdf)])
    largest: dict[int, tuple[int, int, float]] = {}
    for match in IMAGE_ROW_RE.finditer(output):
        page, kind = int(match.group(1)), match.group(2)
        width, height = int(match.group(3)), int(match.group(4))
        ppi_x, ppi_y = float(match.group(5)), float(match.group(6))
        if kind not in ("image", "smask", "mask") or width <= 0 or height <= 0:
            continue
        if page not in largest or width * height > largest[page][0] * largest[page][1]:
            largest[page] = (width, height, min(ppi_x, ppi_y))
    return largest


def _page_text_lengths(pdf: Path, count: int) -> list[int]:
    output = _run(["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"])
    pages = output.split("\f")
    lengths = [len(page.strip()) for page in pages[:count]]
    return lengths + [0] * (count - len(lengths))


def _render_pages(pdf: Path, dpi: int, target_dir: Path) -> list[Path]:
    prefix = target_dir / "render"
    _run(["pdftoppm", "-png", "-r", str(dpi), "-forcenum", str(pdf), str(prefix)])
    pages = sorted(target_dir.glob("render-*.png"), key=lambda path: int(path.stem.rsplit("-", 1)[1]))
    if not pages:
        raise UserError(f"pdftoppm produced no pages for {pdf}")
    return pages


def _sheet_stem(pdf: Path) -> str:
    return pdf.stem[:8] or "pdf"


def _write_contact_sheets(pdf: Path, rendered: list[Path], out_dir: Path, per_sheet: int) -> None:
    cell_w, cell_h, label_h = 340, 270, 26
    for sheet_index, first in enumerate(range(0, len(rendered), per_sheet), start=1):
        page_paths = rendered[first : first + per_sheet]
        rows = math.ceil(len(page_paths) / 6)
        sheet = Image.new("RGB", (6 * cell_w, rows * cell_h), "white")
        draw = ImageDraw.Draw(sheet)
        for local_index, page_path in enumerate(page_paths):
            page_number = first + local_index + 1
            col, row = local_index % 6, local_index // 6
            x, y = col * cell_w, row * cell_h
            draw.text((x + 6, y + 4), f"{_sheet_stem(pdf)} p{page_number}", fill=(210, 0, 0))
            with Image.open(page_path) as source:
                thumbnail = source.convert("RGB")
                thumbnail.thumbnail((cell_w - 12, cell_h - label_h - 8), Image.Resampling.LANCZOS)
                image_x = x + (cell_w - thumbnail.width) // 2
                image_y = y + label_h + (cell_h - label_h - thumbnail.height) // 2
                sheet.paste(thumbnail, (image_x, image_y))
        sheet.save(out_dir / f"sheet_{_sheet_stem(pdf)}_{sheet_index}.png", format="PNG")


def inventory(args: argparse.Namespace) -> None:
    _require_tools(POPPLER_TOOLS)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for pdf_arg in args.pdfs:
        pdf = Path(pdf_arg)
        _check_pdf(pdf)
        count = _page_count(pdf)
        geometry = _page_geometry(pdf, count)
        images = _largest_images(pdf)
        text_lengths = _page_text_lengths(pdf, count)
        with tempfile.TemporaryDirectory(prefix="pdf-sheets-") as temp:
            rendered = _render_pages(pdf, args.dpi, Path(temp))
            if len(rendered) != count:
                raise UserError(f"pdftoppm rendered {len(rendered)} of {count} pages for {pdf}")
            _write_contact_sheets(pdf, rendered, out_dir, args.per_sheet)
        for page in range(1, count + 1):
            width, height, _rotation = geometry[page]
            image_w, image_h, ppi = images.get(page, ("", "", ""))
            text_chars = text_lengths[page - 1]
            rows.append(
                {
                    "file": pdf_arg,
                    "page": page,
                    "width_pt": f"{width:g}",
                    "height_pt": f"{height:g}",
                    "orientation": "landscape" if width > height else "portrait" if height > width else "square",
                    "image_ppi": f"{ppi:g}" if ppi != "" else "",
                    "image_px_w": image_w,
                    "image_px_h": image_h,
                    "has_text": str(text_chars > 0).lower(),
                    "text_chars": text_chars,
                }
            )
    with (out_dir / "pages.csv").open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def _page_render(pdf: Path, page: int, dpi: int) -> Image.Image:
    _check_pdf(pdf)
    count = _page_count(pdf)
    if page < 1 or page > count:
        raise UserError(f"page must be between 1 and {count}: {page}")
    with tempfile.TemporaryDirectory(prefix="pdf-page-") as temp:
        prefix = Path(temp) / "page"
        _run(
            [
                "pdftoppm",
                "-png",
                "-r",
                str(dpi),
                "-f",
                str(page),
                "-l",
                str(page),
                "-singlefile",
                str(pdf),
                str(prefix),
            ]
        )
        image_path = prefix.with_suffix(".png")
        if not image_path.is_file():
            raise UserError(f"pdftoppm produced no image for page {page} of {pdf}")
        with Image.open(image_path) as image:
            return image.convert("RGB")


def _save_png(image: Image.Image, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(out_path, format="PNG")


def titleblock(args: argparse.Namespace) -> None:
    _require_tools(("pdftoppm", "pdfinfo"))
    pdf = Path(args.pdf)
    image = _page_render(pdf, args.page, args.dpi)
    width = max(1, round(image.width * args.frac))
    height = max(1, round(image.height * args.frac))
    x = 0 if "l" in args.corner else image.width - width
    y = 0 if "t" in args.corner else image.height - height
    _save_png(image.crop((x, y, x + width, y + height)), Path(args.out))


def _parse_crop(value: str) -> tuple[float, float, float, float]:
    try:
        coordinates = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("crop must be x0,y0,x1,y1 normalized to 0..1") from exc
    if len(coordinates) != 4:
        raise argparse.ArgumentTypeError("crop must be x0,y0,x1,y1 normalized to 0..1")
    x0, y0, x1, y1 = coordinates
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise argparse.ArgumentTypeError("crop coordinates must satisfy 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1")
    return coordinates  # type: ignore[return-value]


def page(args: argparse.Namespace) -> None:
    _require_tools(("pdftoppm", "pdfinfo"))
    image = _page_render(Path(args.pdf), args.page, args.dpi)
    if args.crop:
        x0, y0, x1, y1 = args.crop
        box = (round(x0 * image.width), round(y0 * image.height), round(x1 * image.width), round(y1 * image.height))
        image = image.crop(box)
    _save_png(image, Path(args.out))


def _positive_int(value: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if result <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def _fraction(value: str) -> float:
    try:
        result = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number greater than 0 and at most 1") from exc
    if not 0 < result <= 1:
        raise argparse.ArgumentTypeError("must be a number greater than 0 and at most 1")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = OneLineArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    inventory_parser = commands.add_parser("inventory", help="render low-resolution contact sheets and page metadata")
    inventory_parser.add_argument("--out", required=True, metavar="DIR")
    inventory_parser.add_argument("--dpi", type=_positive_int, default=12)
    inventory_parser.add_argument("--per-sheet", type=_positive_int, default=36)
    inventory_parser.add_argument("pdfs", nargs="+", metavar="PDF")
    inventory_parser.set_defaults(func=inventory)

    title_parser = commands.add_parser("titleblock", help="render a high-resolution page corner crop")
    title_parser.add_argument("--pdf", required=True, metavar="PDF")
    title_parser.add_argument("--page", required=True, type=_positive_int)
    title_parser.add_argument("--out", required=True, metavar="PNG")
    title_parser.add_argument("--dpi", type=_positive_int, default=150)
    title_parser.add_argument("--corner", choices=("br", "bl", "tr", "tl"), default="br")
    title_parser.add_argument("--frac", type=_fraction, default=0.35)
    title_parser.set_defaults(func=titleblock)

    page_parser = commands.add_parser("page", help="render a page or normalized crop at full resolution")
    page_parser.add_argument("--pdf", required=True, metavar="PDF")
    page_parser.add_argument("--page", required=True, type=_positive_int)
    page_parser.add_argument("--out", required=True, metavar="PNG")
    page_parser.add_argument("--dpi", type=_positive_int, default=300)
    page_parser.add_argument("--crop", type=_parse_crop, metavar="X0,Y0,X1,Y1")
    page_parser.set_defaults(func=page)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except (UserError, OSError, ValueError) as exc:
        print(f"error: {str(exc).replace(chr(10), ' ').strip()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
