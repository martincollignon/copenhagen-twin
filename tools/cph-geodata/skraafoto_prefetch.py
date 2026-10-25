# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "pyproj"]
# ///
"""Prefetch the Skråfoto images (one collection, default 2025) that cover the district.

For a grid of ground points over the bbox and each direction (north/south/east/west/nadir),
pick the image in which the point lands closest to the image centre. Then read, per selected
image, one full-resolution window covering every point it serves, from 0 m up to `--zmax`.
Output: data/raw/skraafoto<year>/<view_id>.jpg + cameras.json (same record format as the
building-case-to-3d skill: view_id, pers (verbatim pers:*), crop, image_size, direction, file).

Needs the Skråfoto token (header auth). It is read from --env-file and never printed.
Everything downstream (photogrammetric colour/texture sampling) runs offline from this cache.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

import numpy as np

SKILL = Path("/Users/martincollignon/conductor/workspaces/dk-building-data/kolkata-v4/.claude/skills/building-case-to-3d/scripts")
sys.path.insert(0, str(SKILL))
import skraafoto as S  # noqa: E402

ORIGIN = (723900.0, 6176500.0, 6.84)


def search(token: str, collection: str, bbox_ll: tuple[float, float, float, float]) -> list[dict]:
    url = f"{S.BASE_URL}/collections/{collection}/items?" + urlencode({"bbox": ",".join(f"{v:.6f}" for v in bbox_ll), "limit": 200})
    feats = []
    while url:
        page = S._request_json(url, token)
        feats += page.get("features", [])
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
    return feats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", required=True)
    ap.add_argument("--collection", default="skraafotos2025")
    ap.add_argument("--half", type=float, default=750.0, help="half bbox size in metres around the origin")
    ap.add_argument("--step", type=float, default=60.0, help="grid spacing in metres")
    ap.add_argument("--zmax", type=float, default=45.0)
    ap.add_argument("--margin", type=float, default=0.06, help="min fractional distance from image edge")
    ap.add_argument("--out", default="data/raw/skraafoto2025")
    a = ap.parse_args()

    from pyproj import Transformer
    import rasterio
    from rasterio.windows import Window
    from PIL import Image

    token = S._token(a.env_file)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tr = Transformer.from_crs(25832, 4326, always_xy=True)
    E0, N0, Z0 = ORIGIN
    lon0, lat0 = tr.transform(E0 - a.half, N0 - a.half)
    lon1, lat1 = tr.transform(E0 + a.half, N0 + a.half)
    feats = search(token, a.collection, (lon0, lat0, lon1, lat1))
    print(f"{len(feats)} items in {a.collection}")

    grid = [(E0 + x, N0 + y) for x in np.arange(-a.half, a.half + 1, a.step) for y in np.arange(-a.half, a.half + 1, a.step)]
    by_dir: dict[str, list[dict]] = {}
    for f in feats:
        by_dir.setdefault(f["properties"].get("direction", "?"), []).append(f)

    selected: dict[str, dict] = {}  # item id -> {"feat", "pts": []}
    for d, fs in by_dir.items():
        for (E, N) in grid:
            best, bestd = None, 9.0
            for f in fs:
                pers = S._pers(f)
                W, H = pers["pers:interior_orientation"]["sensor_array_dimensions"]
                try:
                    c, r = S.world_to_pixel(pers, E, N, Z0)
                except ValueError:
                    continue
                u, v = c / W, r / H
                if not (a.margin <= u <= 1 - a.margin and a.margin <= v <= 1 - a.margin):
                    continue
                dist = (u - 0.5) ** 2 + (v - 0.5) ** 2
                if dist < bestd:
                    best, bestd = f, dist
            if best is not None:
                selected.setdefault(best["id"], {"feat": best, "pts": []})["pts"].append((E, N))
    print(f"selected {len(selected)} images: " + ", ".join(f"{d}={sum(1 for s in selected.values() if s['feat']['properties']['direction']==d)}" for d in by_dir))

    os.environ["GDAL_HTTP_HEADERS"] = f"token: {token}"
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
    records = []
    for iid, s in selected.items():
        f = s["feat"]
        pers = S._pers(f)
        W, H = (int(v) for v in pers["pers:interior_orientation"]["sensor_array_dimensions"])
        cs, rs = [], []
        for (E, N) in s["pts"]:
            for dE in (-a.step / 2, a.step / 2):
                for dN in (-a.step / 2, a.step / 2):
                    for z in (Z0, Z0 + a.zmax):
                        try:
                            c, r = S.world_to_pixel(pers, E + dE, N + dN, z)
                        except ValueError:
                            continue
                        cs.append(c)
                        rs.append(r)
        x0, x1 = max(0, int(min(cs)) - 64), min(W, int(max(cs)) + 64)
        y0, y1 = max(0, int(min(rs)) - 64), min(H, int(max(rs)) + 64)
        view_id = S._view_id(f["collection"], f["properties"]["direction"], iid)
        path = out / f"{view_id}.jpg"
        if not path.exists():
            href = f["assets"]["data"]["href"]
            try:
                with rasterio.open("/vsicurl/" + href) as ds:
                    arr = ds.read([1, 2, 3], window=Window(x0, y0, x1 - x0, y1 - y0))
            except Exception as exc:  # noqa: BLE001
                print(f"FAILED {view_id}: {S._redact(exc, token)}")
                continue
            Image.fromarray(np.moveaxis(arr, 0, -1)).save(path, quality=92)
        records.append({"view_id": view_id, "item_id": iid, "collection": f["collection"],
                        "direction": f["properties"]["direction"], "datetime": f["properties"].get("datetime"),
                        "gsd": f["properties"].get("gsd"), "href": f["assets"]["data"]["href"],
                        "image_size": [W, H], "crop": {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "overview_factor": 1},
                        "file": path.name, "pers": pers, "grid_points_served": len(s["pts"])})
        print(f"{view_id}: window {x1 - x0}x{y1 - y0} serves {len(s['pts'])} grid points")
    (out / "cameras.json").write_text(json.dumps(records, indent=1))
    print(f"wrote {len(records)} views -> {out / 'cameras.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
