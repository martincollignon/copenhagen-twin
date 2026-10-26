"""Citywide source access for build_city.py: retrying HTTP, the KK WFS paged + deduped, Overpass in one query per key,
GeoDanmark Bygning (Datafordeler GEODKV WFS), BBR attributes (Datafordeler GraphQL) and the Frederiksberg GC2 SQL API.

Everything lands as JSON under data/raw/city/ with the file names fetch.py already uses (kk_<layer>.json, osm_<key>.json),
so the per-area compiler steps find their inputs without a network call. Secrets come from the environment
(DATAFORDELER_USERNAME / _PASSWORD / _GRAPHQL_API_KEY, GSEARCH_TOKEN) and are never printed or written.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW_CITY = ROOT / "data" / "raw" / "city"
UA = "cph-twin-geodata/0.2 (open-data compiler; contact martin@lun.energy)"
KK_WFS = "https://wfs-kbhkort.kk.dk/k101/ows"
GEODKV = "https://wfs.datafordeler.dk/GEODKV/GEODKV_WFS/1.0.0/WFS"
BBR_GQL = "https://graphql.datafordeler.dk/BBR/v2"
GC2 = "https://gc2ekstern.frederiksberg.dk/api/v2/sql/frederiksberg"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"]
OSM_BBOX = "55.58,12.43,55.74,12.74"  # S,W,N,E: both kommuner with margin (clip by tile ownership afterwards)
RETRY_STATUS = {429, 500, 502, 503, 504}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"{name} is not set (export it from tools/adc-secret.sh; never print it)")
    return v


def request(method: str, url: str, tries: int = 7, what: str = "", **kw) -> requests.Response:
    """requests with retry/backoff on 429/5xx and connection errors; the URL is never logged (it may carry credentials)."""
    kw.setdefault("timeout", 240)
    headers = {"User-Agent": UA, **kw.pop("headers", {})}
    last = ""
    for attempt in range(tries):
        try:
            r = requests.request(method, url, headers=headers, **kw)
            if r.status_code not in RETRY_STATUS:
                return r
            last = f"http {r.status_code}"
            wait = float(r.headers.get("Retry-After") or 0) or min(120.0, 5.0 * 2 ** attempt)
        except (requests.ConnectionError, requests.Timeout) as e:
            last = type(e).__name__
            wait = min(120.0, 5.0 * 2 ** attempt)
        log(f"[http] {what or 'request'} {last}, retry {attempt + 1}/{tries} in {wait:.0f}s")
        time.sleep(wait)
    raise RuntimeError(f"{what or 'request'} failed after {tries} tries ({last})")


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(text)
    tmp.replace(path)


# ---------------------------------------------------------------------------------------------------------- KK WFS

def kk_hits(layer: str, bbox) -> int:
    x0, y0, x1, y1 = bbox
    r = request("GET", KK_WFS, what=f"kk:{layer}:hits", params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"k101:{layer}", "resultType": "hits",
        "bbox": f"{x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::25832"})
    r.raise_for_status()
    import re

    m = re.search(r'numberMatched="(\d+)"', r.text)
    return int(m.group(1)) if m else -1


def kk_page(layer: str, bbox, start: int, page: int):
    x0, y0, x1, y1 = bbox
    r = request("GET", KK_WFS, what=f"kk:{layer}@{start}", params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"k101:{layer}",
        "outputFormat": "application/json", "bbox": f"{x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::25832",
        "count": page, **({"startIndex": start} if start else {})})
    r.raise_for_status()
    return r.json().get("features", [])


def kk_all(layer: str, bbox, page: int = 3000) -> tuple[list, dict]:
    """Every feature of a KK WFS layer in the bbox: paged (server order, sortBy is rejected), deduped by feature id and
    checked against resultType=hits; when paging comes up short the bbox is cut into 4 km blocks and merged."""
    hits = kk_hits(layer, bbox)
    seen, feats, start = set(), [], 0
    while True:
        got = kk_page(layer, bbox, start, page)
        for f in got:
            fid = f.get("id")
            if fid in seen:
                continue
            seen.add(fid)
            feats.append(f)
        if len(got) < page:
            break
        start += page
    info = {"hits": hits, "paged": len(feats), "fallback_blocks": False}
    if hits > len(feats) >= 0:
        # paging in server order drops features (seen on `bygning`: 141,330 of 144,330): refetch by quadtree blocks that
        # each fit in one response (no paging), merge by id
        log(f"[fetch] kk:{layer}: paging gave {len(feats)} of {hits}; refetching in quadtree blocks")
        info["fallback_blocks"] = True
        limit = 4000

        def block(bb, depth=0):
            got = kk_page(layer, bb, 0, limit)
            if len(got) >= limit and depth < 8:
                x0, y0, x1, y1 = bb
                mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                for sub in ((x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)):
                    block(sub, depth + 1)
                return
            for f in got:
                if f.get("id") not in seen:
                    seen.add(f.get("id"))
                    feats.append(f)

        x0, y0, x1, y1 = bbox
        step = 4096.0
        ex = x0
        while ex < x1:
            ny = y0
            while ny < y1:
                block((ex, ny, min(ex + step, x1), min(ny + step, y1)))
                ny += step
            ex += step
        info["blocks"] = len(feats)
    info["features"] = len(feats)
    return feats, info


def fetch_kk(layer: str, bbox, force: bool = False) -> dict:
    path = RAW_CITY / f"kk_{layer}.json"
    meta = RAW_CITY / f"kk_{layer}.meta.json"
    if path.exists() and meta.exists() and not force:
        return json.loads(meta.read_text())
    t0 = time.time()
    feats, info = kk_all(layer, bbox)
    atomic_write(path, json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))
    info["seconds"] = round(time.time() - t0, 1)
    info["bytes"] = path.stat().st_size
    atomic_write(meta, json.dumps(info))
    log(f"[fetch] kk:{layer}: {info}")
    return info


# ----------------------------------------------------------------------------------------------------------- Overpass

def fetch_overpass(key: str, body: str, force: bool = False) -> dict:
    path = RAW_CITY / f"osm_{key}.json"
    if path.exists() and not force:
        return {"cached": True}
    q = f"[out:json][timeout:300][bbox:{OSM_BBOX}];{body}"
    last = None
    t0 = time.time()
    for attempt in range(8):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = request("POST", url, tries=2, what=f"overpass:{key}", data={"data": q}, timeout=420)
            if r.status_code == 200 and r.content[:1] == b"{":
                data = r.json()
                if data.get("remark") and "error" in data["remark"].lower():
                    raise RuntimeError(data["remark"][:120])
                atomic_write(path, json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                info = {"elements": len(data.get("elements", [])), "seconds": round(time.time() - t0, 1), "bytes": path.stat().st_size}
                log(f"[fetch] osm:{key}: {info}")
                return info
            last = f"http {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {str(e)[:100]}"
        log(f"[fetch] overpass {key}: {last}; waiting")
        time.sleep(min(180, 20 * (attempt + 1)))
    raise RuntimeError(f"overpass {key} failed: {last}")


# ------------------------------------------------------------------------------------------- GeoDanmark + BBR (FRB)

def fetch_geodk_bygning(bbox, force: bool = False) -> dict:
    """GeoDanmark Bygning (Datafordeler GEODKV WFS `bygning_current`) for the bbox -> raw/city/geodk_bygning.json
    with only the fields the compiler needs (id_lokalId = fot_id, BBRUUID, flags) and the footprint."""
    path = RAW_CITY / "geodk_bygning.json"
    if path.exists() and not force:
        return {"cached": True}
    user, pw = env("DATAFORDELER_USERNAME"), env("DATAFORDELER_PASSWORD")
    x0, y0, x1, y1 = bbox
    feats, seen, start, page = [], set(), 0, 5000
    t0 = time.time()
    while True:
        r = request("GET", GEODKV, what=f"geodk:bygning@{start}", params={
            "username": user, "password": pw, "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "geodkv_v001:bygning_current", "outputFormat": "application/json", "count": page, "startIndex": start,
            "bbox": f"{x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::25832"})
        r.raise_for_status()
        got = r.json().get("features", [])
        for f in got:
            p = f["properties"]
            fid = p.get("id_lokalId")
            if fid in seen:
                continue
            seen.add(fid)
            feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                "fot_id": int(fid) if fid and str(fid).isdigit() else fid, "bbruuid": (p.get("BBRUUID") or "").lower() or None,
                "bygningstype": p.get("bygningstype"), "synlig": p.get("synligBygning"), "metode3D": p.get("metode3D"),
                "status": p.get("status")}})
        log(f"[fetch] geodk:bygning {len(feats)}")
        if len(got) < page:
            break
        start += page
    atomic_write(path, json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))
    info = {"features": len(feats), "seconds": round(time.time() - t0, 1), "bytes": path.stat().st_size}
    atomic_write(RAW_CITY / "geodk_bygning.meta.json", json.dumps(info))
    return info


BBR_FIELDS = "id_lokalId status byg021BygningensAnvendelse byg026Opfoerelsesaar byg032YdervaeggensMateriale byg033Tagdaekningsmateriale byg054AntalEtager"


def fetch_bbr(kommune: str, force: bool = False) -> dict:
    """BBR Bygning attributes of a kommune (GraphQL, current) -> raw/city/bbr_<kommune>.json {bbr uuid: [fields]}."""
    path = RAW_CITY / f"bbr_{kommune}.json"
    if path.exists() and not force:
        return {"cached": True}
    key = env("DATAFORDELER_GRAPHQL_API_KEY")
    out, after, t0 = {}, None, time.time()
    while True:
        q = ('{ BBR_Bygning(first:1000%s, registreringstid:"2026-10-26T00:00:00Z", virkningstid:"2026-10-26T00:00:00Z", '
             'where:{kommunekode:{eq:"%s"}}){ pageInfo{hasNextPage endCursor} nodes{ %s } } }') % (
            f', after:"{after}"' if after else "", kommune, BBR_FIELDS)
        r = request("POST", BBR_GQL, what=f"bbr:{kommune}", params={"apiKey": key}, json={"query": q})
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(f"BBR query failed: {body['errors'][0].get('message')}")
        page = body["data"]["BBR_Bygning"]
        for n in page["nodes"]:
            out[n["id_lokalId"].lower()] = {k: v for k, v in n.items() if k != "id_lokalId"}
        log(f"[fetch] bbr:{kommune} {len(out)}")
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    atomic_write(path, json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    info = {"buildings": len(out), "seconds": round(time.time() - t0, 1)}
    atomic_write(RAW_CITY / f"bbr_{kommune}.meta.json", json.dumps(info))
    return info


# ----------------------------------------------------------------------------------------- Frederiksberg GC2 SQL API

def gc2(sql: str, srs: int = 25832) -> list[dict]:
    """GC2 SQL API (public, no key): rows as GeoJSON features in the requested srs. Pages are the caller's business (LIMIT/OFFSET)."""
    r = request("GET", GC2, what="gc2", tries=4, params={"q": sql, "srs": srs, "format": "geojson"}, timeout=180)
    r.raise_for_status()
    return r.json().get("features", [])


def gc2_columns(table: str) -> list[str]:
    r = request("GET", GC2, what="gc2", tries=3, params={"q": f"SELECT * FROM {table} LIMIT 1", "srs": 25832, "format": "geojson"}, timeout=120)
    r.raise_for_status()
    return [c["name"] for c in r.json().get("forStore", [])]


def gc2_table(table: str, where: str = "", page: int = 5000) -> list[dict]:
    """A whole GC2 table without its photo / image columns (a SELECT * of a table with photos exhausts the server's memory).
    One unordered query first (ORDER BY on a geometry column answers HTTP 500 on some tables); only when the table is larger
    than a page is it paged, ordered by its gid/id column."""
    import re

    cols = [c for c in gc2_columns(table) if not re.search(r"foto|image|billede|photo", c, re.I)]
    sel = ", ".join(f'"{c}"' for c in cols)
    w = f"WHERE {where}" if where else ""
    got = gc2(f"SELECT {sel} FROM {table} {w} LIMIT {page}")
    if len(got) < page:
        return got
    key = next((k for k in ("gid", "id") if k in cols), None)
    if key is None:
        raise RuntimeError(f"{table} has more than {page} rows and no gid/id column to page by")
    feats, off = [], 0
    while True:
        got = gc2(f"SELECT {sel} FROM {table} {w} ORDER BY {key} LIMIT {page} OFFSET {off}")
        feats += got
        if len(got) < page:
            return feats
        off += page
