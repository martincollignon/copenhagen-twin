# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "pyproj", "shapely", "trimesh"]
# ///
"""Project building edges into a calibrated Skråfoto crop."""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely.geometry import Polygon, shape
from shapely.ops import triangulate, transform as transform_geometry

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skraafoto import world_to_pixel  # noqa: E402


def _read_gltf_document(path: Path) -> dict[str, Any]:
    """Read glTF JSON from a .gltf file or the JSON chunk of a GLB."""
    data = path.read_bytes()
    if data[:4] != b"glTF":
        return json.loads(data.decode("utf-8"))
    if len(data) < 20:
        raise ValueError("invalid GLB header")
    magic, version, total = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or total > len(data):
        raise ValueError("unsupported or invalid GLB file")
    offset = 12
    while offset + 8 <= total:
        length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + length]
        offset += length
        if chunk_type == 0x4E4F534A:
            return json.loads(chunk.rstrip(b" \t\r\n\0").decode("utf-8"))
    raise ValueError("GLB contains no JSON chunk")


def _up_axis(document: dict[str, Any]) -> str:
    """Use explicit exporter metadata when present; glTF otherwise defaults to Y-up."""
    found: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = key.lower().replace("_", "").replace("-", "")
                if normalized in {"upaxis", "up"} and isinstance(child, str):
                    axis = child.strip().upper()
                    if axis in {"Y", "Z"}:
                        found.append(axis)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(document.get("asset", {}).get("extras", {}))
    visit(document.get("extras", {}))
    if not found:
        return "Y"
    if len(set(found)) > 1:
        raise ValueError("GLB has conflicting up-axis metadata")
    return found[0]


def _load_glb_mesh(path: Path) -> tuple[np.ndarray, np.ndarray, str]:
    import trimesh

    document = _read_gltf_document(path)
    axis = _up_axis(document)
    loaded = trimesh.load(path, force="scene", process=False)
    if isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        pieces = []
        for node in loaded.graph.nodes_geometry:
            matrix, geometry_name = loaded.graph.get(node)
            piece = loaded.geometry[geometry_name].copy()
            piece.apply_transform(matrix)
            pieces.append(piece)
        if not pieces:
            raise ValueError("GLB contains no mesh geometry")
        mesh = trimesh.util.concatenate(pieces)
    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("GLB contains an empty mesh")
    return np.asarray(mesh.vertices, dtype=float), np.asarray(mesh.faces, dtype=int), axis


def _geojson_polygons(path: Path, z0: float, z1: float) -> tuple[np.ndarray, np.ndarray]:
    data = json.loads(path.read_text(encoding="utf-8"))
    crs_name = str(data.get("crs", {}).get("properties", {}).get("name", ""))
    features = data.get("features", []) if data.get("type") == "FeatureCollection" else [data]
    polygons: list[Polygon] = []
    for feature in features:
        geometry = feature.get("geometry") if feature.get("type") == "Feature" else feature
        if not geometry:
            continue
        item = shape(geometry)
        if item.geom_type == "Polygon":
            polygons.append(item)
        elif item.geom_type == "MultiPolygon":
            polygons.extend(item.geoms)
    if not polygons:
        raise ValueError("footprint GeoJSON has no Polygon geometry")
    if "4326" in crs_name or "CRS84" in crs_name.upper():
        converter = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True)
        polygons = [transform_geometry(converter.transform, polygon) for polygon in polygons]
    if z1 <= z0:
        raise ValueError("--z1 must be higher than --z0")

    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for polygon in polygons:
        if not polygon.is_valid or polygon.area <= 0:
            raise ValueError("footprint contains an invalid or empty polygon")
        ring = list(polygon.exterior.coords)[:-1]
        if len(ring) < 3:
            continue
        start = len(vertices)
        count = len(ring)
        vertices.extend((x, y, z0) for x, y in ring)
        vertices.extend((x, y, z1) for x, y in ring)
        for index in range(count):
            nxt = (index + 1) % count
            a, b = start + index, start + nxt
            faces.extend(((a, b, start + count + nxt),
                          (a, start + count + nxt, start + count + index)))
        indexes = {tuple(point): index for index, point in enumerate(ring)}
        for triangle in triangulate(polygon):
            if not polygon.covers(triangle.representative_point()):
                continue
            ids = [indexes[tuple(point)] for point in list(triangle.exterior.coords)[:3]]
            faces.append(tuple(start + index for index in ids))
            faces.append(tuple(start + count + index for index in reversed(ids)))
    if not vertices or not faces:
        raise ValueError("footprint has no usable polygon vertices")
    return np.asarray(vertices, dtype=float), np.asarray(faces, dtype=int)


def _load_camera(spec: str) -> tuple[dict[str, Any], dict[str, Any]]:
    camera_file, separator, view_id = spec.rpartition("#")
    if not separator or not camera_file or not view_id:
        raise ValueError("--camera must be CAMERAS.json#VIEW_ID")
    document = json.loads(Path(camera_file).read_text(encoding="utf-8"))
    if isinstance(document, list):
        candidates = document
    else:
        candidates = document.get("cameras", document.get("views", []))
        if not candidates and document.get("view_id"):
            candidates = [document]
        if isinstance(candidates, dict):
            candidates = [dict(record, view_id=key) for key, record in candidates.items()]
    camera = next((record for record in candidates if record.get("view_id") == view_id), None)
    if camera is None:
        raise ValueError(f"camera view not found: {view_id}")
    pers = camera.get("pers", camera.get("properties", camera))
    if not isinstance(pers, dict):
        raise ValueError("camera has no perspective parameters")
    return camera, pers


def _world_vertices(local: np.ndarray, axis: str, frame_path: Path) -> np.ndarray:
    frame = json.loads(frame_path.read_text(encoding="utf-8"))
    try:
        origin = np.asarray(frame["frame"]["origin"], dtype=float)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("frame JSON needs frame.origin [X,Y,Z]") from exc
    if origin.shape != (3,):
        raise ValueError("frame.origin must have three coordinates")
    # Rotate Y-up coordinates +90 degrees around X: (x,y,z) -> (x,-z,y).
    if axis == "Y":
        local = local @ np.array([[1.0, 0.0, 0.0],
                                  [0.0, 0.0, 1.0],
                                  [0.0, -1.0, 0.0]])
    return local + origin


def _rotation(pers: dict[str, Any]) -> np.ndarray:
    omega, phi, kappa = (math.radians(float(pers[key])) for key in
                         ("pers:omega", "pers:phi", "pers:kappa"))
    co, so = math.cos(omega), math.sin(omega)
    cp, sp = math.cos(phi), math.sin(phi)
    ck, sk = math.cos(kappa), math.sin(kappa)
    return np.array([
        [cp * ck, -cp * sk, sp],
        [co * sk + so * sp * ck, co * ck - so * sp * sk, -so * cp],
        [so * sk - co * sp * ck, so * ck + co * sp * sk, co * cp],
    ])


def _depths(pers: dict[str, Any], vertices: np.ndarray) -> np.ndarray:
    center = np.asarray(pers["pers:perspective_center"], dtype=float)
    return (vertices - center) @ _rotation(pers)[:, 2]


def _crop_point(camera: dict[str, Any], col: float, row: float) -> tuple[float, float]:
    crop = camera.get("crop", {})
    factor = float(crop.get("overview_factor", 1.0))
    if factor <= 0:
        raise ValueError("camera crop overview_factor must be positive")
    return ((col - float(crop.get("x0", 0))) / factor,
            (row - float(crop.get("y0", 0))) / factor)


def _feature_edges(vertices: np.ndarray, faces: np.ndarray) -> list[tuple[int, int]]:
    edge_faces: dict[tuple[int, int], list[int]] = {}
    for face_index, face in enumerate(faces):
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edge_faces.setdefault((min(int(a), int(b)), max(int(a), int(b))), []).append(face_index)
    normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                       vertices[faces[:, 2]] - vertices[faces[:, 0]])
    lengths = np.linalg.norm(normals, axis=1)
    lengths[lengths == 0] = 1
    normals = normals / lengths[:, None]
    selected = []
    for edge, adjacent in edge_faces.items():
        if len(adjacent) != 2:
            selected.append(edge)
            continue
        dot = float(np.clip(np.dot(normals[adjacent[0]], normals[adjacent[1]]), -1, 1))
        if math.degrees(math.acos(dot)) > 20:
            selected.append(edge)
    return selected


def _hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    unique = sorted(set(points))
    if len(unique) < 3:
        return unique

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[float, float]] = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _clip_polygon(polygon: list[tuple[float, float]], width: int, height: int) -> list[tuple[float, float]]:
    bounds = ((0, 0.0, True), (0, width - 1.0, False),
              (1, 0.0, True), (1, height - 1.0, False))
    output = polygon
    for axis, value, is_min in bounds:
        if not output:
            break
        result = []
        previous = output[-1]
        previous_inside = previous[axis] >= value if is_min else previous[axis] <= value
        for current in output:
            current_inside = current[axis] >= value if is_min else current[axis] <= value
            if current_inside != previous_inside:
                denominator = current[axis] - previous[axis]
                t = 0.0 if denominator == 0 else (value - previous[axis]) / denominator
                result.append((previous[0] + t * (current[0] - previous[0]),
                               previous[1] + t * (current[1] - previous[1])))
            if current_inside:
                result.append(current)
            previous, previous_inside = current, current_inside
        output = result
    return output


def _clip_segment(start: tuple[float, float], end: tuple[float, float],
                  width: int, height: int) -> tuple[tuple[float, float], tuple[float, float]] | None:
    dx, dy = end[0] - start[0], end[1] - start[1]
    low, high = 0.0, 1.0
    for p, q in ((-dx, start[0]), (dx, width - 1 - start[0]),
                 (-dy, start[1]), (dy, height - 1 - start[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            low = max(low, t)
        else:
            high = min(high, t)
        if low > high:
            return None
    return ((start[0] + low * dx, start[1] + low * dy),
            (start[0] + high * dx, start[1] + high * dy))


def _render(args: argparse.Namespace) -> None:
    camera, pers = _load_camera(args.camera)
    image = Image.open(args.image).convert("RGB")
    if args.model:
        local, faces, axis = _load_glb_mesh(args.model)
        vertices = _world_vertices(local, axis, args.frame)
    else:
        local, faces = _geojson_polygons(args.footprint, args.z0, args.z1)
        vertices = local
    depth = _depths(pers, vertices)
    projected: list[tuple[float, float] | None] = []
    for index, vertex in enumerate(vertices):
        if depth[index] >= -1e-9:
            projected.append(None)
            continue
        try:
            projected.append(_crop_point(camera, *world_to_pixel(pers, *vertex)))
        except (ValueError, KeyError, TypeError, IndexError):
            projected.append(None)

    if args.alpha > 0:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        fill = ImageDraw.Draw(overlay, "RGBA")
        triangles = []
        for face in faces:
            if any(projected[int(index)] is None for index in face):
                continue
            triangles.append((float(np.mean(depth[face])), [projected[int(i)] for i in face]))
        for _, points in sorted(triangles, key=lambda item: item[0]):
            polygon = _clip_polygon(points, *image.size)
            if len(polygon) >= 3:
                fill.polygon(polygon, fill=(255, 175, 0, round(255 * args.alpha)))
        image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")

    draw = ImageDraw.Draw(image)
    for a, b in _feature_edges(vertices, faces):
        if projected[a] is None or projected[b] is None:
            continue
        clipped = _clip_segment(projected[a], projected[b], *image.size)
        if clipped:
            draw.line(clipped, fill=(0, 255, 255), width=2)

    silhouette = _clip_polygon(_hull([point for point in projected if point is not None]), *image.size)
    bbox = None
    if silhouette:
        bbox = {"x0": min(point[0] for point in silhouette),
                "y0": min(point[1] for point in silhouette),
                "x1": max(point[0] for point in silhouette),
                "y1": max(point[1] for point in silhouette)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.out, format="PNG")
    sidecar = Path(str(args.out) + ".json")
    sidecar.write_text(json.dumps({"silhouette": silhouette, "bbox": bbox},
                                  ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class OneLineParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.exit(2, f"error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = OneLineParser(description=__doc__)
    parser.add_argument("--camera", required=True, help="CAMERAS.json#VIEW_ID")
    parser.add_argument("--image", required=True, type=Path, help="saved Skråfoto crop")
    model = parser.add_mutually_exclusive_group(required=True)
    model.add_argument("--model", type=Path, help="building GLB in local metres")
    model.add_argument("--footprint", type=Path, help="EPSG:25832 or 4326 footprint GeoJSON")
    parser.add_argument("--frame", type=Path, help="building frame JSON (required with --model)")
    parser.add_argument("--z0", type=float, help="prism bottom elevation (required with --footprint)")
    parser.add_argument("--z1", type=float, help="prism top elevation (required with --footprint)")
    parser.add_argument("--alpha", type=float, default=0.0, help="optional face-fill opacity, 0 to 1")
    parser.add_argument("--out", required=True, type=Path, help="output PNG path")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if not 0 <= args.alpha <= 1:
            raise ValueError("--alpha must be between 0 and 1")
        if args.model and not args.frame:
            raise ValueError("--frame is required with --model")
        if args.footprint and (args.z0 is None or args.z1 is None):
            raise ValueError("--z0 and --z1 are required with --footprint")
        _render(args)
        return 0
    except Exception as exc:
        print(str(exc).replace("\n", " ").strip(), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
