# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""Building entrances from DAR -> data/cph-entrances.json (cph-entrances/1).

DAR (Danmarks Adresseregister, Datafordeler) stores for every husnummer (adgangsadresse) an `adgangspunkt` (the entrance
point, usually surveyed at the door) and a `vejpunkt` (where the access road is reached). This compiler:

  1. discovers the streets (`vejmidte`) around the district from the husnumre of every twin building
     (DAR `adgangTilBygning=<BBR bygning>` / `geoDanmarkBygning=<id>`), then pulls every husnummer of those streets;
  2. keeps the gaeldende ones (status 3) whose adgangspunkt lies in the district;
  3. links each husnummer to a twin building: `geoDanmarkBygning` (== the `gdk:<id>` in the geodata), else the BBR bygning
     (`adgangTilBygning` == building `bbr_id`), else the footprint containing / nearest to the point; BBR `opgang`
     (stairwell) records add the husnumre a building is entered from;
  4. snaps the adgangspunkt to the nearest wall of its building (outer ring or courtyard holes) and records the
     distance. conf: `measured` <= 1.5 m, `observed` <= 3 m, else `inferred`.

    uv run tools/cph-geodata/entrances.py            # cached raw responses under data/raw/dar/ make reruns offline

Credentials come only from `tools/adc-secret.sh` (datafordeler-username/-password/-graphql-api-key) or the
DATAFORDELER_USERNAME / DATAFORDELER_PASSWORD / DATAFORDELER_GRAPHQL_API_KEY environment; they are never printed.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frame import LOCAL_BBOX, to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "dar"
GEO = ROOT / "data" / "cph-geodata.json"
OUT = ROOT / "data" / "cph-entrances.json"
DAR_REST = "https://services.datafordeler.dk/DAR/DAR/1/rest/husnummer"
BBR_GQL = "https://graphql.datafordeler.dk/BBR/v2"
MEASURED_M = 1.5
OBSERVED_M = 3.0
MAX_SNAP_M = 12.0  # beyond this the point is not tied to a wall at all
MARGIN_M = 40.0  # husnumre this far outside the district are kept for linking to edge buildings

_POINT = re.compile(r"POINT\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)")


# ---------------------------------------------------------------------------------------------------------- pure helpers


def parse_point(wkt: str | None):
    """'POINT(E N)' -> (E, N) or None."""
    m = _POINT.match(wkt or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def closest_on_segment(px, pz, x0, z0, x1, z1):
    """(qx, qz, t, distance) of the closest point of segment p0-p1 to p."""
    dx, dz = x1 - x0, z1 - z0
    l2 = dx * dx + dz * dz
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - x0) * dx + (pz - z0) * dz) / l2))
    qx, qz = x0 + dx * t, z0 + dz * t
    return qx, qz, t, math.hypot(px - qx, pz - qz)


def rings_of(b: dict):
    """[(ring_index, flat ring)] with ring 0 the outline and 1.. the courtyard holes."""
    out = [(0, b["ring"])]
    out += [(i + 1, h) for i, h in enumerate(b.get("holes") or [])]
    return out


def point_in_ring(x, z, ring) -> bool:
    inside, n = False, len(ring) // 2
    j = n - 1
    for i in range(n):
        xi, zi, xj, zj = ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_building(x, z, b) -> bool:
    return point_in_ring(x, z, b["ring"]) and not any(point_in_ring(x, z, h) for h in (b.get("holes") or []))


def snap_to_walls(x, z, b, max_m=MAX_SNAP_M):
    """Nearest wall of building b to local point (x, z): dict(ring, edge, t, d, sx, sz, along, wall_len) or None."""
    best = None
    for ri, ring in rings_of(b):
        n = len(ring) // 2
        for i in range(n):
            j = (i + 1) % n
            x0, z0, x1, z1 = ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]
            wl = math.hypot(x1 - x0, z1 - z0)
            if wl < 0.05:
                continue
            qx, qz, t, d = closest_on_segment(x, z, x0, z0, x1, z1)
            if best is None or d < best["d"]:
                best = {"ring": ri, "edge": i, "t": t, "d": d, "sx": qx, "sz": qz, "along": t * wl, "wall_len": wl}
    return best if best and best["d"] <= max_m else None


def conf_for(d: float) -> str:
    return "measured" if d <= MEASURED_M else "observed" if d <= OBSERVED_M else "inferred"


class BuildingIndex:
    """Grid index of buildings by bounding box for point-in-footprint / nearest-wall candidate lookup."""

    def __init__(self, buildings, cell=40.0):
        self.cell = cell
        self.grid: dict[tuple[int, int], list] = {}
        for b in buildings:
            xs, zs = b["ring"][0::2], b["ring"][1::2]
            for i in range(int((min(xs) - 14) // cell), int((max(xs) + 14) // cell) + 1):
                for j in range(int((min(zs) - 14) // cell), int((max(zs) + 14) // cell) + 1):
                    self.grid.setdefault((i, j), []).append(b)

    def near(self, x, z):
        return self.grid.get((int(x // self.cell), int(z // self.cell)), [])


def link_husnummer(hn: dict, by_gdk: dict, by_bbr: dict, index: BuildingIndex):
    """-> (building, how) for a normalised husnummer {x, z, gdk, bbr}. `how`: geoDanmarkBygning | bbr | footprint | nearest.

    The id links win (they are the register's own statement); the geometry only decides for husnumre without a usable id
    or whose id points at a building that is not in the twin.
    """
    gdk, bbr = hn.get("gdk"), hn.get("bbr")
    if gdk and f"gdk:{gdk}" in by_gdk:
        return by_gdk[f"gdk:{gdk}"], "geoDanmarkBygning"
    if bbr and bbr in by_bbr:
        return by_bbr[bbr], "bbr"
    cands = index.near(hn["x"], hn["z"])
    for b in cands:
        if point_in_building(hn["x"], hn["z"], b):
            return b, "footprint"
    best, bd = None, 3.0
    for b in cands:
        s = snap_to_walls(hn["x"], hn["z"], b, bd)
        if s and s["d"] <= bd:
            best, bd = b, s["d"]
    return (best, "nearest") if best else (None, None)


def entry_for(hn: dict, b: dict, how: str, opgang_ids: set[str]):
    """Build one output entry (snapped to b's walls), or None when no wall is within MAX_SNAP_M."""
    s = snap_to_walls(hn["x"], hn["z"], b)
    if not s:
        return None
    inside = point_in_building(hn["x"], hn["z"], b)
    return {
        "id": hn["id"], "bid": b["id"], "bbr": b.get("bbr_id"), "text": hn["text"], "street": hn["street"],
        "x": round(hn["x"], 2), "z": round(hn["z"], 2),
        "sx": round(s["sx"], 2), "sz": round(s["sz"], 2), "ring": s["ring"], "edge": s["edge"],
        "t": round(s["t"], 3), "along": round(s["along"], 2), "wall_len": round(s["wall_len"], 2), "d": round(s["d"], 2),
        "inside": inside, "link": how, "opgang": hn["id"] in opgang_ids, "acc": hn.get("acc"),
        "road": hn.get("road"), "src": [f"dar:husnummer/{hn['id']}", "dar:adgangspunkt"],
        "conf": conf_for(s["d"]),
    }


# ----------------------------------------------------------------------------------------------------------- data access


def _secret(name: str, env: str) -> str:
    if os.environ.get(env):
        return os.environ[env].strip()
    out = subprocess.run([str(ROOT / "tools" / "adc-secret.sh"), name], capture_output=True, text=True, check=True)
    return out.stdout.strip()


class Dar:
    def __init__(self):
        self.user = _secret("datafordeler-username", "DATAFORDELER_USERNAME")
        self.pw = _secret("datafordeler-password", "DATAFORDELER_PASSWORD")
        self.key = _secret("datafordeler-graphql-api-key", "DATAFORDELER_GRAPHQL_API_KEY")
        RAW.mkdir(parents=True, exist_ok=True)
        import requests

        self.http = requests

    def _cache(self, name: str) -> Path:
        return RAW / (re.sub(r"[^A-Za-z0-9_.-]", "_", name) + ".json")

    def husnumre(self, param: str, value: str):
        """DAR REST husnummer?<param>=<value> (cached). Returns the list of husnummer records."""
        path = self._cache(f"hn_{param}_{value}")
        if path.exists():
            return json.loads(path.read_text())
        for attempt in range(4):
            try:
                r = self.http.get(DAR_REST, params={param: value, "format": "json", "username": self.user, "password": self.pw}, timeout=120)
                if r.status_code == 200:
                    data = r.json()
                    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                    return data
                if r.status_code in (400, 404):
                    return []
            except Exception as exc:  # noqa: BLE001 - retried
                err = type(exc).__name__
            else:
                err = f"http {r.status_code}"
        print(f"[dar] {param}={value} failed ({err})", file=sys.stderr)
        return []

    def opgange(self, bbr_ids: list[str]):
        """BBR opgang (stairwell) records for a batch of bygning ids (gaeldende: status 6), cached per batch."""
        key = hashlib.sha1(",".join(sorted(bbr_ids)).encode()).hexdigest()[:16]
        path = self._cache(f"opgang_{key}")
        if path.exists():
            return json.loads(path.read_text())
        ids = json.dumps(sorted(bbr_ids))
        out, after = [], None
        while True:
            q = ("{ BBR_Opgang(first:1000%s, registreringstid:\"2026-10-26T00:00:00Z\", virkningstid:\"2026-10-26T00:00:00Z\", "
                 "where:{bygning:{in:%s}}){ pageInfo{hasNextPage endCursor} nodes{ bygning adgangFraHusnummer status } } }") % (
                (f', after:"{after}"' if after else ""), ids)
            r = self.http.post(BBR_GQL, params={"apiKey": self.key}, json={"query": q}, timeout=120)
            r.raise_for_status()
            body = r.json()
            if body.get("errors"):
                raise RuntimeError(f"BBR opgang query failed: {body['errors'][0].get('message')}")
            page = body["data"]["BBR_Opgang"]
            out += page["nodes"]
            if not page["pageInfo"]["hasNextPage"]:
                break
            after = page["pageInfo"]["endCursor"]
        path.write_text(json.dumps(out, separators=(",", ":")))
        return out


def normalise(raw: dict):
    """DAR husnummer record -> flat dict in the local frame, or None when not usable."""
    if str(raw.get("status")) != "3":
        return None
    p = parse_point((raw.get("adgangspunkt") or {}).get("position"))
    if not p:
        return None
    x, z = to_local(*p)
    vp = parse_point((raw.get("vejpunkt") or {}).get("position"))
    road = None
    if vp:
        vx, vz = to_local(*vp)
        road = [round(vx, 2), round(vz, 2)]
    nv = raw.get("navngivenVej") or {}
    return {
        "id": raw["id_lokalId"], "x": x, "z": z, "text": raw.get("husnummertekst"), "street": nv.get("vejnavn"),
        "gdk": str(raw["geoDanmarkBygning"]) if raw.get("geoDanmarkBygning") else None,
        "bbr": raw.get("adgangTilBygning"), "vejmidte": raw.get("vejmidte"),
        "acc": (raw.get("adgangspunkt") or {}).get("oprindelse_nøjagtighedsklasse"), "road": road,
    }


# ------------------------------------------------------------------------------------------------------------------ main


def histogram(ds):
    edges = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0]
    c = Counter()
    for d in ds:
        for e in edges:
            if d <= e:
                c[f"<= {e:g} m"] += 1
                break
    return {f"<= {e:g} m": c.get(f"<= {e:g} m", 0) for e in edges}


def main() -> None:
    geo = json.loads(GEO.read_text())
    buildings = [b for b in geo["buildings"] if b.get("ring")]
    by_gdk = {b["id"]: b for b in buildings}
    by_bbr = {b["bbr_id"]: b for b in buildings if b.get("bbr_id")}
    index = BuildingIndex(buildings)
    x0, z0, x1, z1 = LOCAL_BBOX
    dar = Dar()

    # 1. streets from per-building lookups, then every husnummer of those streets
    def lookup(b):
        if b.get("bbr_id"):
            return dar.husnumre("adgangTilBygning", b["bbr_id"])
        return dar.husnumre("geoDanmarkBygning", b["id"].split(":")[1])

    with ThreadPoolExecutor(12) as ex:
        per_building = list(ex.map(lookup, buildings))
    streets = {h.get("vejmidte") for recs in per_building for h in recs if h.get("vejmidte")}
    print(f"[entrances] {len(buildings)} buildings -> {len(streets)} streets", file=sys.stderr)
    with ThreadPoolExecutor(12) as ex:
        per_street = list(ex.map(lambda v: dar.husnumre("vejmidte", v), sorted(streets)))
    seen: dict[str, dict] = {}
    for recs in [*per_building, *per_street]:
        for raw in recs:
            n = normalise(raw)
            if n and x0 - MARGIN_M <= n["x"] <= x1 + MARGIN_M and z0 - MARGIN_M <= n["z"] <= z1 + MARGIN_M:
                seen.setdefault(n["id"], n)

    # 2. BBR opgang (stairwells): which husnumre each building is entered from; fetch husnumre not yet seen
    bbr_ids = sorted(by_bbr)
    batches = [bbr_ids[i:i + 100] for i in range(0, len(bbr_ids), 100)]
    with ThreadPoolExecutor(4) as ex:
        opg = [o for rows in ex.map(dar.opgange, batches) for o in rows]
    opgang_ids: set[str] = set()
    stair: dict[str, int] = Counter()
    for o in opg:
        h = o.get("adgangFraHusnummer")
        if o.get("status") != "6" or not h or h.startswith("00000000"):
            continue
        opgang_ids.add(h)
        stair[o["bygning"]] += 1
    missing = sorted(opgang_ids - set(seen))
    with ThreadPoolExecutor(12) as ex:
        for recs in ex.map(lambda i: dar.husnumre("id", i), missing):
            for raw in recs:
                n = normalise(raw)
                if n and x0 - MARGIN_M <= n["x"] <= x1 + MARGIN_M and z0 - MARGIN_M <= n["z"] <= z1 + MARGIN_M:
                    seen.setdefault(n["id"], n)
    print(f"[entrances] {len(seen)} gaeldende husnumre in/near the district ({len(missing)} fetched via opgang)", file=sys.stderr)

    # 3. link + snap
    entries, unlinked, far = [], 0, 0
    for hn in sorted(seen.values(), key=lambda h: h["id"]):
        b, how = link_husnummer(hn, by_gdk, by_bbr, index)
        if not b:
            unlinked += 1
            continue
        e = entry_for(hn, b, how, opgang_ids)
        if not e:
            far += 1
            continue
        entries.append(e)

    doc = {
        "version": "cph-entrances/1", "frame": "cph-geodata local (x east, z south)",
        "attribution": ["Danmarks Adresseregister (DAR), Datafordeler, Klimadatastyrelsen / SDFI"],
        "note": "x,z = DAR adgangspunkt; sx,sz = snapped to the wall (ring 0 outline, >=1 courtyard hole); conf by snap distance d",
        "entrances": entries,
        "stairwells": {k: v for k, v in sorted(stair.items())},
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))

    in_district = [e for e in entries if x0 <= e["x"] <= x1 and z0 <= e["z"] <= z1]
    with_e = {e["bid"] for e in in_district}
    n_b = sum(1 for b in buildings if x0 <= b["ring"][0] <= x1 and z0 <= b["ring"][1] <= z1)
    print(f"entrances: {len(entries)} ({len(in_district)} in district) -> {OUT}")
    print(f"unlinked husnumre: {unlinked}; no wall within {MAX_SNAP_M:g} m: {far}")
    print(f"buildings with >=1 entrance: {len(with_e)} / {n_b} ({100 * len(with_e) / max(n_b, 1):.1f}%)")
    print("conf:", dict(Counter(e["conf"] for e in in_district)), "link:", dict(Counter(e["link"] for e in in_district)))
    print("snap distance:", histogram([e["d"] for e in in_district]))
    print("inside footprint:", sum(1 for e in in_district if e["inside"]), "| on a courtyard wall:", sum(1 for e in in_district if e["ring"] > 0))


if __name__ == "__main__":
    main()
