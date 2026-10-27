#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Drop duplicate furniture items from the compiled tiles in place (the same fix `furniture.py single_points` now makes at the source).

The KK `pullert` WFS returns 20 bollards at Proviantbroen 79 times each (different WFS ids, same attribute id and coordinates), and a few
other registers repeat a point; the placement relaxation spread the copies into a bollard forest. An item is a duplicate when an earlier
item in the same list has the same `src` and the same x / z. Items keep their `ord`; the tile index counts and byte sizes are updated.

    uv run tools/cph-geodata/furniture_dedupe.py [--tiles data/tiles] [--dry]
"""
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def dedupe_tile(doc: dict) -> Counter:
    dropped = Counter()
    for key, items in list(doc.items()):
        if not (isinstance(items, list) and items and isinstance(items[0], dict) and "x" in items[0] and "z" in items[0]):
            continue
        seen, keep = set(), []
        for i, it in enumerate(items):
            k = (tuple(it.get("src") or ()), it["x"], it["z"])
            if k in seen:
                continue
            seen.add(k)
            keep.append(i)
        if len(keep) < len(items):
            dropped[key] = len(items) - len(keep)
            doc[key] = [items[i] for i in keep]
            if key in doc.get("ord", {}):
                doc["ord"][key] = [doc["ord"][key][i] for i in keep]
    return dropped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tiles", default=str(ROOT / "data" / "tiles"))
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    tiles = Path(a.tiles)
    idx_path = tiles / "index.json"
    idx = json.loads(idx_path.read_text())
    total = Counter()
    for tid, rec in idx["tiles"].items():
        f = tiles / tid / "furniture.json"
        if not f.exists():
            continue
        doc = json.loads(f.read_text())
        d = dedupe_tile(doc)
        if not d:
            continue
        total.update(d)
        if a.dry:
            continue
        raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
        tmp = f.with_suffix(".tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, f)
        idx["bytes"] += len(raw) - rec["layers"]["furniture"]
        rec["layers"]["furniture"] = len(raw)
        for k, n in d.items():
            rec["counts"]["furniture"][k] -= n
        rec["bytes"] = sum(rec["layers"].values()) if "bytes" in rec else rec.get("bytes")
    print("dropped:", dict(total))
    if not a.dry and total:
        tmp = idx_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp, idx_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
