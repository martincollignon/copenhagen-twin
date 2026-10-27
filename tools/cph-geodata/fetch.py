"""Cached downloads. Raw responses live under data/raw/ so reruns are offline."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

import frame

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
UA = "cph-twin-geodata/0.1 (+https://github.com/ ; open-data compiler)"
KK_WFS = "https://wfs-kbhkort.kk.dk/k101/ows"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
MARGIN = frame.FETCH_MARGIN  # metres beyond the area so edge geometry is complete


def utm_bbox(margin: float = MARGIN):
    """The active area (frame.area_utm(): the district unless --bbox / --tile was given) grown by margin."""
    e0, n0, e1, n1 = frame.area_utm()
    return (e0 - margin, n0 - margin, e1 + margin, n1 + margin)


def cache_dir() -> Path:
    """data/raw for the district; a per-area folder (data/raw/areas/<E0>_<N0>_<E1>_<N1>) for any other area, so a
    --bbox / --tile run never reads or overwrites the district cache."""
    if frame.is_district():
        return RAW
    e0, n0, e1, n1 = frame.area_utm()
    return RAW / "areas" / f"{e0:.0f}_{n0:.0f}_{e1:.0f}_{n1:.0f}"


def wgs_bbox(margin: float = MARGIN):
    from pyproj import Transformer

    t = Transformer.from_crs(25832, 4326, always_xy=True)
    x0, y0, x1, y1 = utm_bbox(margin)
    pts = [t.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)  # S, W, N, E


def _log(*a):
    print(*a, file=sys.stderr)


def kk_layer(name: str, refresh: bool = False):
    """GeoJSON FeatureCollection (EPSG:25832) for a KK WFS layer in the bbox, or raises."""
    path = cache_dir() / f"kk_{name}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    x0, y0, x1, y1 = utm_bbox()
    feats, start, page = [], 0, 3000
    while True:
        r = requests.get(
            KK_WFS,
            params={
                "service": "WFS", "version": "2.0.0", "request": "GetFeature",
                "typeNames": f"k101:{name}", "outputFormat": "application/json",
                "bbox": f"{x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::25832",
                "count": page,
                **({"startIndex": start} if start else {}),
            },
            headers={"User-Agent": UA}, timeout=180,
        )
        r.raise_for_status()
        fc = r.json()
        got = fc.get("features", [])
        feats += got
        if len(got) < page:
            break
        start += page
    fc = {"type": "FeatureCollection", "features": feats}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fc, ensure_ascii=False))
    _log(f"[fetch] kk:{name}: {len(feats)} features")
    return fc


def overpass(key: str, query_body: str, refresh: bool = False):
    path = cache_dir() / f"osm_{key}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    s, w, n, e = wgs_bbox()
    q = f"[out:json][timeout:120][bbox:{s:.6f},{w:.6f},{n:.6f},{e:.6f}];{query_body}"
    last = None
    for url in OVERPASS:
        for attempt in range(2):
            try:
                r = requests.post(url, data={"data": q}, headers={"User-Agent": UA}, timeout=180)
                r.raise_for_status()
                data = r.json()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, ensure_ascii=False))
                _log(f"[fetch] osm:{key}: {len(data.get('elements', []))} elements")
                return data
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(3)
    raise RuntimeError(f"overpass {key} failed: {last}")


def load_env_value(env_file: str | None, *names: str) -> str | None:
    """Optional credential lookup: process env first, then an explicit env file.
    Values are sanitised (quotes, inline comments, first token) and never printed."""
    for n in names:
        v = os.environ.get(n)
        if v:
            return _sanitize(v)
    if env_file and Path(env_file).exists():
        vals = {}
        for line in Path(env_file).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vals[k.strip().removeprefix("export ").strip()] = v
        for n in names:
            if vals.get(n):
                return _sanitize(vals[n])
    return None


def _sanitize(v: str) -> str:
    v = v.strip()
    if v[:1] in "\"'":
        q = v[0]
        end = v.find(q, 1)
        v = v[1:end] if end > 0 else v[1:]
    else:
        v = v.split("#", 1)[0]
    parts = v.strip().split()
    return parts[0] if parts else ""
