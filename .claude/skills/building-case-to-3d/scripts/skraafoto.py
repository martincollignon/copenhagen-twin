# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "pyproj"]
# ///
"""Fetch cropped Skråfoto views and project points with calibrated cameras."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

BASE_URL = "https://api.dataforsyningen.dk/rest/skraafoto_api/v2"
USER_AGENT = "cph-twin/building-case-to-3d"


def _properties(camera: dict) -> dict:
    """Accept a raw STAC properties map or one of our camera records."""
    if "pers" in camera and isinstance(camera["pers"], dict):
        return camera["pers"]
    if "properties" in camera and isinstance(camera["properties"], dict):
        return camera["properties"]
    return camera


def _rotation(pers: dict) -> np.ndarray:
    """Build the Go/SAUL D matrix, whose transpose is STAC rotation_matrix."""
    try:
        omega, phi, kappa = (math.radians(float(pers[k])) for k in
                             ("pers:omega", "pers:phi", "pers:kappa"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("camera needs numeric pers:omega, pers:phi and pers:kappa") from exc
    co, so = math.cos(omega), math.sin(omega)
    cp, sp = math.cos(phi), math.sin(phi)
    ck, sk = math.cos(kappa), math.sin(kappa)
    return np.array([
        [cp * ck, -cp * sk, sp],
        [co * sk + so * sp * ck, co * ck - so * sp * sk, -so * cp],
        [so * sk - co * sp * ck, so * ck + co * sp * sk, co * cp],
    ], dtype=float)


def _interior(pers: dict) -> tuple[float, float, float, float, float, float, float, float, float]:
    try:
        io = pers["pers:interior_orientation"]
        width, height = map(float, io["sensor_array_dimensions"])
        spacing = float(io["pixel_spacing"][0])
        focal = float(io["focal_length"])
        pp = io.get("principal_point_offset", [0.0, 0.0])
        ppx, ppy = float(pp[0]), float(pp[1])
        center = list(map(float, pers["pers:perspective_center"]))
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise ValueError("camera has incomplete interior or perspective-center parameters") from exc
    if len(center) != 3 or min(width, height, spacing, focal) <= 0:
        raise ValueError("camera dimensions, spacing, focal length and center must be valid")
    return width, height, spacing, focal, ppx, ppy, center[0], center[1], center[2]


def world_to_pixel(pers: dict, X: float, Y: float, Z: float) -> tuple[float, float]:
    """Project EPSG:25832/DVR90 coordinates to full-frame (column, row)."""
    p = _properties(pers)
    width, height, pix, focal, ppx, ppy, x0, y0, z0 = _interior(p)
    d = np.array([float(X) - x0, float(Y) - y0, float(Z) - z0])
    D = _rotation(p)
    depth = float(D[0, 2] * d[0] + D[1, 2] * d[1] + D[2, 2] * d[2])
    if abs(depth) < 1e-10:
        raise ValueError(f"point projects at the camera plane (depth={depth:g})")
    # This is the SAUL collinearity convention used by projection.go.
    xdot = focal * float(D[0, 0] * d[0] + D[1, 0] * d[1] + D[2, 0] * d[2]) / depth
    ydot = focal * float(D[0, 1] * d[0] + D[1, 1] * d[1] + D[2, 1] * d[2]) / depth
    col = -((xdot - ppx) - width * pix / 2) / pix
    row_bottom = -((ydot - ppy) - height * pix / 2) / pix
    return col, height - row_bottom


def pixel_to_world(pers: dict, col: float, row: float, Z: float) -> tuple[float, float]:
    """Intersect a full-frame pixel ray with the horizontal plane at height Z."""
    p = _properties(pers)
    width, height, pix, focal, ppx, ppy, x0, y0, z0 = _interior(p)
    D = _rotation(p)
    # Undo the top-left row convention and SAUL's focal/pixel signs.
    row_bottom = height - float(row)
    xdot = -float(col) * pix + width * pix / 2 + ppx
    ydot = -row_bottom * pix + height * pix / 2 + ppy
    u, v = xdot / focal, ydot / focal
    dz = float(Z) - z0
    a = np.array([
        [u * D[0, 2] - D[0, 0], u * D[1, 2] - D[1, 0]],
        [v * D[0, 2] - D[0, 1], v * D[1, 2] - D[1, 1]],
    ])
    b = np.array([(D[2, 0] - u * D[2, 2]) * dz,
                  (D[2, 1] - v * D[2, 2]) * dz])
    det = float(np.linalg.det(a))
    if abs(det) < 1e-10:
        raise ValueError("camera ray is parallel to the requested height plane")
    dx, dy = np.linalg.solve(a, b)
    return float(dx + x0), float(dy + y0)


def _clean_value(value: str) -> str:
    value = value.strip().split("#", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value.split()[0] if value.split() else ""


def _nearest_env_file() -> Path | None:
    return next((parent / ".env" for parent in (Path.cwd(), *Path.cwd().parents)
                 if (parent / ".env").is_file()), None)


def _token(env_file: str | None) -> str:
    for key in ("SKRAAFOTO_STAC_TOKEN", "GSEARCH_TOKEN"):
        if os.environ.get(key):
            clean = _clean_value(os.environ[key])
            if clean:
                return clean
    path = Path(env_file).expanduser() if env_file else _nearest_env_file()
    if path and path.is_file():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.partition("=")
                if sep and key.strip() in ("SKRAAFOTO_STAC_TOKEN", "GSEARCH_TOKEN"):
                    clean = _clean_value(value)
                    if clean:
                        return clean
        except OSError as exc:
            raise ValueError(f"cannot read env file {path}: {exc}") from exc
    raise ValueError("missing SKRAAFOTO_STAC_TOKEN or GSEARCH_TOKEN")


def _redact(message: object, token: str) -> str:
    return str(message).replace(token, "[REDACTED]").replace("\n", " ").strip()


def _request_json(url: str, token: str) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json", "token": token}
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers=headers), timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code == 429 or 500 <= exc.code <= 599:
                if attempt < 4:
                    time.sleep(2**attempt)
                    continue
            raise RuntimeError(f"STAC request failed with HTTP {exc.code}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt < 4:
                time.sleep(2**attempt)
                continue
            raise RuntimeError(f"STAC request failed: {exc}") from exc
    raise RuntimeError("STAC request failed after retries")


def _bbox(lon: float, lat: float, radius: float) -> str:
    from pyproj import Transformer

    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    to_wgs = Transformer.from_crs(25832, 4326, always_xy=True)
    x, y = to_utm.transform(lon, lat)
    coords = [to_wgs.transform(x + dx, y + dy)
              for dx in (-radius, radius) for dy in (-radius, radius)]
    xs, ys = zip(*coords)
    return ",".join(f"{v:.8f}" for v in (min(xs), min(ys), max(xs), max(ys)))


def _view_id(collection: str, direction: str, item_id: str) -> str:
    # Keep output filenames inside the selected directory even for odd STAC IDs.
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{collection}_{direction}_{item_id}").strip("._")


def _pers(feature: dict) -> dict:
    return {k: v for k, v in feature.get("properties", {}).items() if k.startswith("pers:")}


def _crop_bounds(pers: dict, x: float, y: float, z: float, radius: float) -> tuple[int, int, int, int]:
    points = [world_to_pixel(pers, x + dx, y + dy, z + dz)
              for dx in (-radius, radius) for dy in (-radius, radius)
              for dz in (0.0, 60.0)]
    return (math.floor(min(p[0] for p in points)), math.floor(min(p[1] for p in points)),
            math.ceil(max(p[0] for p in points)), math.ceil(max(p[1] for p in points)))


def _fetch(args: argparse.Namespace) -> None:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import Window
    from pyproj import Transformer

    if not (-180 <= args.lon <= 180 and -90 <= args.lat <= 90):
        raise ValueError("longitude/latitude are outside WGS84 bounds")
    if args.radius <= 0 or args.pad < 0 or args.max_px <= 0 or args.per_direction <= 0:
        raise ValueError("radius, max-px and per-direction must be positive; pad cannot be negative")
    token = _token(args.env_file)
    collections_response = _request_json(f"{BASE_URL}/collections", token)
    available = [c["id"] for c in collections_response.get("collections", []) if c.get("id")]
    collections = available if args.collections == "all" else [
        c.strip() for c in args.collections.split(",") if c.strip()]
    unknown = set(collections) - set(available)
    if unknown:
        raise ValueError(f"unknown collection(s): {', '.join(sorted(unknown))}")
    radius = args.radius
    bbox = _bbox(args.lon, args.lat, radius)
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    x, y = to_utm.transform(args.lon, args.lat)
    directions = {d.strip().lower() for d in args.directions.split(",") if d.strip()}
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    selected: list[tuple[float, str, str, dict, dict]] = []
    for collection in collections:
        url = f"{BASE_URL}/collections/{quote(collection, safe='')}/items?" + urlencode(
            {"bbox": bbox, "limit": 200})
        response = _request_json(url, token)
        for feature in response.get("features", []):
            props = feature.get("properties", {})
            direction = str(props.get("direction", "")).lower()
            pers = _pers(feature)
            if direction not in directions or not pers:
                continue
            try:
                col, row = world_to_pixel(pers, x, y, args.z)
                width, height, *_ = _interior(pers)
            except (ValueError, KeyError, TypeError):
                continue
            if not (0.1 * width <= col <= 0.9 * width and 0.1 * height <= row <= 0.9 * height):
                continue
            distance = math.hypot(col - width / 2, row - height / 2)
            selected.append((distance, collection, direction, feature, pers))
    keep: list[tuple[float, str, str, dict, dict]] = []
    counts: dict[tuple[str, str], int] = {}
    for candidate in sorted(selected, key=lambda item: item[0]):
        key = candidate[1], candidate[2]
        if counts.get(key, 0) < args.per_direction:
            keep.append(candidate)
            counts[key] = counts.get(key, 0) + 1

    cameras = []
    for _, collection, direction, feature, pers in keep:
        view_id = _view_id(collection, direction, str(feature.get("id", "item")))
        assets = feature.get("assets", {})
        href = assets.get("data", {}).get("href")
        if not href:
            continue
        try:
            last_error = None
            for attempt in range(5):
                try:
                    with rasterio.Env(
                        GDAL_HTTP_HEADERS=f"token: {token}",
                        GDAL_HTTP_TIMEOUT="90",
                        GDAL_HTTP_CONNECTTIMEOUT="30",
                        GDAL_HTTP_USERAGENT=USER_AGENT,
                        GDAL_HTTP_MAX_RETRY="0",
                        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                    ):
                        with rasterio.open("/vsicurl/" + href) as dataset:
                            width, height = dataset.width, dataset.height
                            x0, y0, x1, y1 = _crop_bounds(pers, x, y, args.z, radius + args.pad)
                            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
                            if x1 <= x0 or y1 <= y0:
                                break
                            crop_w, crop_h = x1 - x0, y1 - y0
                            factors = sorted({1, *dataset.overviews(1)})
                            factor = next((f for f in factors if
                                           math.ceil(crop_w / f) <= args.max_px and
                                           math.ceil(crop_h / f) <= args.max_px), factors[-1])
                            out_w, out_h = math.ceil(crop_w / factor), math.ceil(crop_h / factor)
                            data = dataset.read(window=Window(x0, y0, crop_w, crop_h),
                                                out_shape=(dataset.count, out_h, out_w),
                                                resampling=Resampling.bilinear)
                    last_error = None
                    break
                except Exception as exc:
                    last_error = exc
                    if attempt < 4:
                        time.sleep(2**attempt)
            if last_error is not None:
                raise last_error
            if x1 <= x0 or y1 <= y0:
                continue
            if data.shape[0] >= 3:
                pixels = np.moveaxis(data[:3], 0, -1)
            else:
                pixels = data[0]
            if pixels.dtype != np.uint8:
                pixels = np.clip(pixels, 0, 255).astype(np.uint8)
            filename = f"{view_id}.jpg"
            Image.fromarray(pixels).convert("RGB").save(output / filename, quality=92)
        except Exception as exc:
            raise RuntimeError(_redact(f"could not crop {view_id}: {exc}", token)) from None
        props = feature.get("properties", {})
        cameras.append({
            "view_id": view_id, "item_id": str(feature.get("id", "")),
            "collection": collection, "direction": direction,
            "datetime": props.get("datetime"), "gsd": props.get("gsd"),
            "href": href, "image_size": [width, height],
            "crop": {"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                     "overview_factor": factor},
            "file": filename, "pers": pers,
        })
    (output / "cameras.json").write_text(
        json.dumps(cameras, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _parse_xyz(value: str) -> tuple[float, float, float]:
    try:
        parts = tuple(float(v) for v in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("XYZ must be X,Y,Z") from exc
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("XYZ must be X,Y,Z")
    return parts


def _project(args: argparse.Namespace) -> None:
    file_part, sep, view_id = args.camera.rpartition("#")
    if not sep or not file_part or not view_id:
        raise ValueError("--camera must be CAMERAS.json#VIEW_ID")
    records = json.loads(Path(file_part).read_text(encoding="utf-8"))
    camera = next((row for row in records if row.get("view_id") == view_id), None)
    if camera is None:
        raise ValueError(f"view not found: {view_id}")
    results = []
    for point in args.xyz:
        col, row = world_to_pixel(camera["pers"], *point)
        if args.crop_relative:
            crop = camera["crop"]
            factor = float(crop.get("overview_factor", 1))
            col, row = (col - float(crop["x0"])) / factor, (row - float(crop["y0"])) / factor
        results.append({"xyz": list(point), "col": col, "row": row})
    print(json.dumps(results, ensure_ascii=False, indent=2))


class OneLineParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.exit(2, f"{self.prog}: error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = OneLineParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=OneLineParser)
    fetch = commands.add_parser("fetch", help="find views and save cropped COG windows")
    fetch.add_argument("--lon", type=float, required=True)
    fetch.add_argument("--lat", type=float, required=True)
    fetch.add_argument("--radius", type=float, default=40)
    fetch.add_argument("--collections", default="all")
    fetch.add_argument("--directions", default="north,south,east,west,nadir")
    fetch.add_argument("--per-direction", type=int, default=1)
    fetch.add_argument("--pad", type=float, default=30)
    fetch.add_argument("--max-px", type=int, default=2500)
    fetch.add_argument("--z", type=float, default=10)
    fetch.add_argument("--env-file", help="token file (default: nearest .env from CWD)")
    fetch.add_argument("--out", required=True, type=Path)
    fetch.set_defaults(func=_fetch)
    project = commands.add_parser("project", help="project EPSG:25832 points into a view")
    project.add_argument("--camera", required=True, help="CAMERAS.json#VIEW_ID")
    project.add_argument("--xyz", required=True, action="append", type=_parse_xyz)
    project.add_argument("--crop-relative", action="store_true")
    project.set_defaults(func=_project)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
        return 0
    except Exception as exc:
        token = ""
        if args.command == "fetch":
            try:
                token = _token(args.env_file)
            except Exception:
                pass
        print(_redact(exc, token), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
