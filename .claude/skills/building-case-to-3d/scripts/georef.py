# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26"]
# ///
"""Fit and apply drawing-pixel to EPSG:25832 transforms."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np


def _pixel_basis(points: np.ndarray) -> np.ndarray:
    """Convert drawing coordinates (y down) to a conventional y-up basis."""
    return np.column_stack((points[:, 0], -points[:, 1]))


def _fit_similarity(pixels: np.ndarray, world: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    """Return the 2x3 pixel-to-world matrix for a proper similarity transform."""
    source = _pixel_basis(pixels)
    source_mean = source.mean(axis=0)
    target_mean = world.mean(axis=0)
    centered_source = source - source_mean
    centered_target = world - target_mean
    denominator = float(np.sum(centered_source * centered_source))
    if denominator <= np.finfo(float).eps:
        raise ValueError("similarity fit needs at least two distinct pixel points")

    dot = float(np.sum(centered_source[:, 0] * centered_target[:, 0] + centered_source[:, 1] * centered_target[:, 1]))
    cross = float(np.sum(centered_source[:, 0] * centered_target[:, 1] - centered_source[:, 1] * centered_target[:, 0]))
    magnitude = math.hypot(dot, cross)
    if magnitude <= np.finfo(float).eps:
        raise ValueError("similarity fit is degenerate")
    scale = magnitude / denominator
    cosine, sine = dot / magnitude, cross / magnitude
    rotation = np.array([[cosine, -sine], [sine, cosine]])
    translation = target_mean - scale * rotation @ source_mean

    # The model is fitted in y-up drawing space; convert the matrix back to the
    # actual pixel basis so consumers can multiply [px, py, 1] directly.
    pixel_flip = np.diag([1.0, -1.0])
    linear = scale * rotation @ pixel_flip
    matrix = np.column_stack((linear, translation))
    return matrix, {
        "scale_m_per_px": scale,
        "rotation_deg": math.degrees(math.atan2(sine, cosine)),
        "translation_X": float(translation[0]),
        "translation_Y": float(translation[1]),
    }


def _fit_affine(pixels: np.ndarray, world: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    source = _pixel_basis(pixels)
    design = np.column_stack((source, np.ones(len(source))))
    if np.linalg.matrix_rank(design) < 3:
        raise ValueError("affine fit needs at least three non-collinear pixel points")
    coefficients, _, _, _ = np.linalg.lstsq(design, world, rcond=None)
    # coefficients maps [px, -py, 1] to [X, Y].
    affine = coefficients[:2, :].T
    translation = coefficients[2, :]
    matrix = np.column_stack((affine @ np.diag([1.0, -1.0]), translation))

    # Report the closest proper rotation (polar factor) and geometric-mean
    # scale. These remain useful summaries when the affine includes shear.
    left, _, right = np.linalg.svd(affine)
    polar = left @ right
    if np.linalg.det(polar) < 0:
        left[:, -1] *= -1
        polar = left @ right
    scale = math.sqrt(abs(float(np.linalg.det(affine))))
    rotation_deg = math.degrees(math.atan2(float(polar[1, 0]), float(polar[0, 0])))
    return matrix, {
        "a": float(matrix[0, 0]),
        "b": float(matrix[0, 1]),
        "c": float(matrix[1, 0]),
        "d": float(matrix[1, 1]),
        "translation_X": float(translation[0]),
        "translation_Y": float(translation[1]),
        "scale_m_per_px": scale,
        "rotation_deg": rotation_deg,
    }


def _fit(model: str, pixels: np.ndarray, world: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    if model == "similarity":
        if len(pixels) < 2:
            raise ValueError("similarity fit needs at least two control points")
        return _fit_similarity(pixels, world)
    if model == "affine":
        if len(pixels) < 3:
            raise ValueError("affine fit needs at least three control points")
        return _fit_affine(pixels, world)
    raise ValueError(f"unknown model: {model}")


def _predict(matrix: np.ndarray, pixels: np.ndarray) -> np.ndarray:
    return np.column_stack((pixels, np.ones(len(pixels)))) @ matrix.T


def _read_gcps(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        required = {"id", "px", "py", "X", "Y"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError("GCP CSV must have columns id,px,py,X,Y[,use]")
        points: list[dict[str, Any]] = []
        for row_number, row in enumerate(reader, start=2):
            try:
                px, py, x, y = (float(row[key]) for key in ("px", "py", "X", "Y"))
                use_text = (row.get("use") or "1").strip()
                use = use_text not in {"0", "false", "False", "no", "No"}
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid numeric value on CSV row {row_number}") from exc
            if not all(math.isfinite(value) for value in (px, py, x, y)):
                raise ValueError(f"non-finite coordinate on CSV row {row_number}")
            points.append({"id": (row.get("id") or str(row_number - 1)).strip(), "px": px, "py": py, "X": x, "Y": y, "use": use})
    if not points:
        raise ValueError("GCP CSV contains no points")
    return points


def fit_gcps(gcps_path: Path, model: str) -> dict[str, Any]:
    points = _read_gcps(gcps_path)
    active = [point for point in points if point["use"]]
    pixels = np.array([[point["px"], point["py"]] for point in active], dtype=float)
    world = np.array([[point["X"], point["Y"]] for point in active], dtype=float)
    matrix, parameters = _fit(model, pixels, world)
    predicted = _predict(matrix, np.array([[point["px"], point["py"]] for point in points]))

    active_residuals = np.linalg.norm(_predict(matrix, pixels) - world, axis=1)
    median = float(np.median(active_residuals))
    # A point is an outlier when it exceeds either criterion, hence the lower
    # of the two cutoffs is the effective threshold.
    threshold = min(2.5 * median, 0.5)
    loo_by_id: dict[str, float | None] = {}
    for index, point in enumerate(active):
        if len(active) - 1 < (2 if model == "similarity" else 3):
            loo_by_id[point["id"]] = None
            continue
        keep = np.arange(len(active)) != index
        try:
            loo_matrix, _ = _fit(model, pixels[keep], world[keep])
            prediction = _predict(loo_matrix, pixels[index:index + 1])[0]
            loo_by_id[point["id"]] = float(np.linalg.norm(prediction - world[index]))
        except (ValueError, np.linalg.LinAlgError):
            loo_by_id[point["id"]] = None

    # A use=0 point is a holdout, so its leave-one-out fit is the full fit.
    records: list[dict[str, Any]] = []
    for index, point in enumerate(points):
        residual = float(np.linalg.norm(predicted[index] - [point["X"], point["Y"]]))
        loo = loo_by_id.get(point["id"], residual)
        records.append({
            **point,
            "predicted_X": float(predicted[index, 0]),
            "predicted_Y": float(predicted[index, 1]),
            "residual_m": residual,
            "loo_residual_m": loo,
            "outlier": residual > threshold,
        })

    rms = math.sqrt(float(np.mean(active_residuals ** 2)))
    max_residual = float(np.max(active_residuals))
    all_residuals = [record["residual_m"] for record in records]
    return {
        "model": model,
        "source_y_axis": "down (flipped during fit)",
        "matrix": [
            [float(matrix[0, 0]), float(matrix[0, 1]), float(matrix[0, 2])],
            [float(matrix[1, 0]), float(matrix[1, 1]), float(matrix[1, 2])],
            [0.0, 0.0, 1.0],
        ],
        "parameters": parameters,
        "scale_m_per_px": float(parameters["scale_m_per_px"]),
        "rotation_deg": float(parameters["rotation_deg"]),
        "rms_m": rms,
        "max_residual_m": max_residual,
        "all_points_max_residual_m": max(all_residuals),
        "outlier_threshold_m": threshold,
        "points": records,
    }


def _transform_matrix(document: dict[str, Any]) -> np.ndarray:
    try:
        matrix = np.asarray(document["matrix"], dtype=float)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("transform JSON must contain a numeric 3x3 matrix") from exc
    if matrix.shape != (3, 3) or not np.isfinite(matrix).all():
        raise ValueError("transform JSON must contain a numeric 3x3 matrix")
    if not np.allclose(matrix[2], [0, 0, 1], atol=1e-12):
        raise ValueError("transform matrix must have final row [0,0,1]")
    return matrix


def apply_xy(matrix: np.ndarray, x: float, y: float) -> tuple[float, float]:
    result = matrix @ np.array([x, y, 1.0])
    return float(result[0]), float(result[1])


def _map_coordinates(value: Any, matrix: np.ndarray) -> Any:
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(v, (int, float)) for v in value[:2]):
        x, y = apply_xy(matrix, float(value[0]), float(value[1]))
        return [x, y, *value[2:]]
    if isinstance(value, list):
        return [_map_coordinates(item, matrix) for item in value]
    raise ValueError("invalid GeoJSON coordinate structure")


def _map_geometry(geometry: dict[str, Any], matrix: np.ndarray) -> None:
    if geometry.get("type") == "GeometryCollection":
        for child in geometry.get("geometries", []):
            _map_geometry(child, matrix)
    elif "coordinates" in geometry:
        geometry["coordinates"] = _map_coordinates(geometry["coordinates"], matrix)
    else:
        raise ValueError("GeoJSON geometry has no coordinates")


def apply_transform(transform_path: Path, input_path: Path, output_path: Path) -> None:
    try:
        transform_document = json.loads(transform_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid transform JSON: {exc.msg}") from exc
    matrix = _transform_matrix(transform_document)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if input_path.suffix.lower() == ".csv":
        with input_path.open(newline="", encoding="utf-8-sig") as source:
            reader = csv.DictReader(source)
            if not reader.fieldnames or not {"px", "py"}.issubset(reader.fieldnames):
                raise ValueError("input CSV must have px,py columns")
            fieldnames = list(reader.fieldnames)
            for column in ("X", "Y"):
                if column not in fieldnames:
                    fieldnames.append(column)
            rows = list(reader)
        with output_path.open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                try:
                    x, y = apply_xy(matrix, float(row["px"]), float(row["py"]))
                except (TypeError, ValueError) as exc:
                    raise ValueError("input CSV has invalid px,py values") from exc
                row.update(X=f"{x:.9f}", Y=f"{y:.9f}")
                writer.writerow(row)
        return

    try:
        data = json.loads(input_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid GeoJSON: {exc.msg}") from exc
    kind = data.get("type")
    if kind == "FeatureCollection":
        for feature in data.get("features", []):
            if feature.get("geometry") is not None:
                _map_geometry(feature["geometry"], matrix)
    elif kind == "Feature":
        if data.get("geometry") is not None:
            _map_geometry(data["geometry"], matrix)
    else:
        _map_geometry(data, matrix)
    data["crs"] = {"type": "name", "properties": {"name": "EPSG:25832"}}
    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.exit(2, f"error: {message}\n")


def _write_fit(args: argparse.Namespace) -> None:
    document = fit_gcps(args.gcps, args.model)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("id       residual_m  loo_residual_m  status")
    for point in document["points"]:
        loo = "-" if point["loo_residual_m"] is None else f"{point['loo_residual_m']:.3f}"
        status = "OUTLIER" if point["outlier"] else ("holdout" if not point["use"] else "ok")
        print(f"{point['id'][:8]:8s} {point['residual_m']:11.3f} {loo:>15s}  {status}")
    print(f"RMS {document['rms_m']:.3f} m; max fit residual {document['max_residual_m']:.3f} m")


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    fit_parser = subparsers.add_parser("fit", help="fit a transform from ground-control points")
    fit_parser.add_argument("--gcps", type=Path, required=True, help="CSV with id,px,py,X,Y[,use]")
    fit_parser.add_argument("--out", type=Path, required=True, help="output transform JSON")
    fit_parser.add_argument("--model", choices=("similarity", "affine"), default="similarity")
    fit_parser.set_defaults(run=_write_fit)
    apply_parser = subparsers.add_parser("apply", help="transform pixel-space CSV or GeoJSON")
    apply_parser.add_argument("--transform", type=Path, required=True, help="transform JSON from fit")
    apply_parser.add_argument("--in", dest="input", type=Path, required=True, help="pixel-space GeoJSON or CSV")
    apply_parser.add_argument("--out", type=Path, required=True, help="output projected file")
    apply_parser.set_defaults(run=lambda args: apply_transform(args.transform, args.input, args.out))
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except (OSError, ValueError, csv.Error, np.linalg.LinAlgError) as exc:
        message = " ".join(str(exc).splitlines())
        print(f"error: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
