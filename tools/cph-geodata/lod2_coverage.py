#!/usr/bin/env python3
"""LoD2 vs LoD1 roof coverage of a tile set, by district, plus the roofer cells without output.

    CPH_TILES_DIR=<tiles> python3 tools/cph-geodata/lod2_coverage.py [--out lod2-coverage.md]

Reads <tiles>/*/buildings.json + lod2.json and data/raw/lod2-out/<cell>/DONE.json. A building is `LoD2` when its lod2 entry is
`measured` (roofer roof mesh in lod2.bin), `inferred` when roofer returned no usable roof (it keeps the eave-ridge extrusion, the
reason is counted) and `LoD1` when it has no entry (cell without roofer output, hero, building outside the roofer run).
Districts: Frederiksberg Kommune by polygon (data/city/boundary.geojson), the rest by nearest anchor point (approximate
neighbourhood anchors in the local frame, not an official district boundary)."""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_city as BC  # noqa: E402
import frame  # noqa: E402

# local frame (x east, z south) anchors, from js/city-teleports.js plus a few neighbourhood centres
ANCHORS = {"Indre By": (1100, 500), "Vesterbro": (-281, 1414), "Østerbro": (879, -2142), "Nørrebro": (-900, -1600),
           "Christianshavn / Amager": (1500, 2300), "Nordhavn": (2600, -3600), "Valby / Sydhavn": (-3500, 2500),
           "Bispebjerg / Nordvest": (-2200, -3200), "Vanløse / Brønshøj": (-6500, -1500), "Vestamager / Ørestad": (1000, 5000)}


def district_of(x: float, z: float, frb) -> str:
    from shapely.geometry import Point
    if frb.contains(Point(x + frame.ORIGIN[0], frame.ORIGIN[1] - z)):
        return "Frederiksberg"
    return min(ANCHORS, key=lambda k: (ANCHORS[k][0] - x) ** 2 + (ANCHORS[k][1] - z) ** 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    a = ap.parse_args()
    from shapely.geometry import shape
    bnd = json.loads((BC.CITY_DIR / "boundary.geojson").read_text())
    frb = shape(next(f for f in bnd["features"] if f["properties"].get("kommunekode") == "0147")["geometry"])
    by_d: dict[str, Counter] = defaultdict(Counter)
    reasons, ids = Counter(), 0
    for d in sorted(BC.TILES_DIR.iterdir()):
        p = d / "buildings.json"
        if not p.exists():
            continue
        ent = json.loads((d / "lod2.json").read_text())["buildings"] if (d / "lod2.json").exists() else {}
        for b in json.loads(p.read_text())["buildings"]:
            ids += 1
            e = ent.get(b["id"])
            k = "LoD1" if e is None else ("LoD2" if "offset" in e else "inferred")
            if k == "inferred":
                reasons[re.sub(r"\d+% of the footprint", "NN % of the footprint", e.get("reason", "?"))] += 1
            r = b["ring"]
            x, z = sum(r[0::2]) / (len(r) // 2), sum(r[1::2]) / (len(r) // 2)
            by_d[district_of(x, z, frb)][k] += 1
    tot = Counter()
    for c in by_d.values():
        tot.update(c)
    L = [f"# LoD2 roof coverage ({BC.TILES_DIR})", "", f"{ids:,} buildings. LoD2 = roofer roof mesh; inferred = roofer had no usable roof (eave-ridge extrusion kept); LoD1 = no roofer record.", "",
         "| district | buildings | LoD2 | inferred | LoD1 | LoD2 share |", "|---|---:|---:|---:|---:|---:|"]
    for dn, c in sorted(by_d.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(c.values())
        L.append(f"| {dn} | {n:,} | {c['LoD2']:,} | {c['inferred']:,} | {c['LoD1']:,} | {100 * c['LoD2'] / n:.1f} % |")
    n = sum(tot.values())
    L.append(f"| **total** | {n:,} | {tot['LoD2']:,} | {tot['inferred']:,} | {tot['LoD1']:,} | {100 * tot['LoD2'] / n:.1f} % |")
    L += ["", "## Why `inferred`", ""] + [f"- {r}: {c:,}" for r, c in reasons.most_common()]
    out = BC.DATA / "raw" / "lod2-out"
    empty, missing = [], []
    for dd in sorted(out.iterdir()):
        dn = json.loads((dd / "DONE.json").read_text()) if (dd / "DONE.json").exists() else None
        if dn is None:
            missing.append(dd.name)
        elif dn.get("no_own_buildings"):
            empty.append(dd.name)
    L += ["", "## Cells", "", f"- roofer cells synced: {len(list(out.iterdir()))}; without DONE.json (failed): {missing or 'none'}",
          f"- DONE without own buildings (sea / no footprints, nothing to convert): {len(empty)} {empty}"]
    txt = "\n".join(L) + "\n"
    print(txt)
    if a.out:
        Path(a.out).write_text(txt)


if __name__ == "__main__":
    main()
