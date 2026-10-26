"""Shared constants and helpers for the LoD2 pipeline (tools/lod2).

Frame (docs/cph-geodata-schema.md): local x = E - 723900, z = -(N - 6176500), y = DVR90 - 6.84.
Tile id is "<N km>_<E km>", as in the Punktsky file name PUNKTSKY_1km_<N>_<E>.laz.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "cph-geodata"))
import frame  # noqa: E402  (the one source of the origin, the district bbox and the tile grid)
RAW_DIR = ROOT / "data" / "raw" / "lod2"
WORK_DIR = RAW_DIR / "work"
OUT_DIR = ROOT / "data" / "lod2"
GEODATA = ROOT / "data" / "cph-geodata.json"

ORIGIN = frame.ORIGIN
DISTRICT_BBOX = frame.DISTRICT_UTM_BBOX  # (minE, minN, maxE, maxN) in EPSG:25832
MARGIN_M = 25.0  # points are cropped this far outside the tile so cut-off roofs stay whole
ROOFER_IMAGE = "3dgi/roofer:v1.1.0-beta.1"

GPS_EPOCH = dt.datetime(1980, 1, 6, tzinfo=dt.timezone.utc)


def tile_id(n_km: int, e_km: int) -> str:
    return f"{n_km}_{e_km}"


def tile_bounds(tid: str) -> tuple[float, float, float, float]:
    """(minE, minN, maxE, maxN) in metres."""
    n, e = (int(v) for v in tid.split("_"))
    return (e * 1000.0, n * 1000.0, e * 1000.0 + 1000.0, n * 1000.0 + 1000.0)


def tile_file(tid: str) -> Path:
    return RAW_DIR / f"PUNKTSKY_1km_{tid}.laz"


def tiles_for_bbox(bbox, margin: float = 0.0) -> list[str]:
    """Tile ids (sorted) of the 1 km Punktsky tiles intersecting bbox = (minE, minN, maxE, maxN) grown by margin."""
    e0, n0, e1, n1 = bbox
    out = []
    for n in range(math.floor((n0 - margin) / 1000), math.floor((n1 + margin) / 1000) + 1):
        for e in range(math.floor((e0 - margin) / 1000), math.floor((e1 + margin) / 1000) + 1):
            out.append(tile_id(n, e))
    return sorted(out)


def tile_of_point(e: float, n: float) -> str:
    return tile_id(math.floor(n / 1000), math.floor(e / 1000))


def to_local(e: float, n: float, z: float) -> tuple[float, float, float]:
    return (e - ORIGIN[0], -(n - ORIGIN[1]), z - ORIGIN[2])


def gps_to_date(adjusted_gps_time: float) -> str:
    """LAS 1.4 adjusted standard GPS time (seconds since 1980-01-06 minus 1e9) -> ISO date."""
    return (GPS_EPOCH + dt.timedelta(seconds=adjusted_gps_time + 1e9)).date().isoformat()


def ring_to_en(flat: list[float]) -> list[tuple[float, float]]:
    """Flat local [x, z, ...] ring -> [(E, N), ...] (no closing point)."""
    ox, oy, _ = ORIGIN
    return [(flat[i] + ox, -flat[i + 1] + oy) for i in range(0, len(flat), 2)]


def load_geodata(path: Path = GEODATA) -> dict:
    return json.loads(Path(path).read_text())


def bare_id(building_id: str) -> str:
    """'gdk:1064715171' -> '1064715171' (the id roofer carries)."""
    return building_id.split(":", 1)[-1]
