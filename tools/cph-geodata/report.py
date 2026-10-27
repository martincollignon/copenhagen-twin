# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2", "pyproj", "numpy", "requests"]
# ///
"""Provenance report: data/cph-geodata.json -> data/cph-geodata.report.md.

    uv run tools/cph-geodata/report.py --in data/cph-geodata.json --out data/cph-geodata.report.md
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch  # noqa: E402
import frame  # noqa: E402
import roadgraph  # noqa: E402


def load(path: Path):
    if not path.exists() and Path(str(path) + ".gz").exists():
        path = Path(str(path) + ".gz")
    op = gzip.open if path.suffix == ".gz" else open
    with op(path, "rt") as fh:
        return json.load(fh)


def footprint_coverage(doc):
    """Compiled footprints vs the reference GeoDanmark fot_id set (KK `bygning_kk`) in the bbox."""
    from shapely.geometry import box, shape

    ref_path = fetch.RAW / "kk_bygning_kk.json"
    if not ref_path.exists():
        return None
    bb = box(*frame.area_local())
    ref = set()
    for f in json.loads(ref_path.read_text())["features"]:
        g = shape(f["geometry"])
        ring = [frame.to_local(c[0], c[1]) for c in g.convex_hull.exterior.coords]
        from shapely.geometry import Polygon

        if Polygon(ring).intersects(bb):
            ref.add(str(f["properties"].get("fot_id")))
    have = {b["id"].split(":")[1].split("-")[0] for b in doc["buildings"]}
    return len(ref), len(ref & have), sorted(ref - have)[:10]


def graph_components(doc):
    g = doc["roadGraph"]
    n = len(g["nodes"]) // 2
    cls = g["classes"]
    res = {}
    for label, pick in (("all links", lambda c: True),
                        ("vehicular (secondary/residential/service)", lambda c: c in ("primary", "secondary", "residential", "service")),
                        ("vehicular + cycleway", lambda c: c in ("primary", "secondary", "residential", "service", "cycleway")),
                        ("cycleway only", lambda c: c == "cycleway")):
        ls = [(l[0], l[1]) for l in g["links"] if pick(cls[l[7]])]
        sizes = roadgraph.components(n, ls)
        res[label] = (len(ls), sizes)
    return n, res


def vehicular_fragments(doc):
    """Classify non-main vehicular components: bbox-edge slivers vs interior (private lanes)."""
    g = doc["roadGraph"]
    n = len(g["nodes"]) // 2
    veh = [l for l in g["links"] if g["classes"][l[7]] in ("primary", "secondary", "residential", "service")]
    uf = roadgraph._UF(n)
    for l in veh:
        uf.union(l[0], l[1])
    comp: dict[int, set] = {}
    for l in veh:
        comp.setdefault(uf.find(l[0]), set()).update((l[0], l[1]))
    if not comp:
        return ""
    main_root = max(comp, key=lambda r: len(comp[r]))
    edge = interior = 0
    for r, nodes in comp.items():
        if r == main_root:
            continue
        near = any(max(abs(g["nodes"][2 * i]), abs(g["nodes"][2 * i + 1])) > 745 for i in nodes)
        edge += near
        interior += not near
    return (f"\nVehicular graph: {len(comp) - 1} non-main components = {edge} touching the bbox edge (clipping slivers) "
            f"+ {interior} interior (private courtyard lanes / OSM service stubs).\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="data/cph-geodata.json")
    ap.add_argument("--out", default="data/cph-geodata.report.md")
    a = ap.parse_args(argv)
    doc = load(Path(a.inp))
    meta = doc.get("meta", {})
    L = []
    w = L.append
    w("# cph-geodata provenance report\n")
    w(f"Generated: {doc['generated']}  \nSchema: `{doc['version']}`, origin {doc['frame']['origin']}, bbox {doc['frame']['bbox']}\n")
    w("## Counts per layer\n\n| layer | count |\n|---|---|")
    for k in ("buildings", "roads", "cycleTracks", "sidewalks", "water", "parks", "heroes"):
        w(f"| {k} | {len(doc[k])} |")
    g = doc["roadGraph"]
    w(f"| roadGraph nodes | {len(g['nodes']) // 2} |\n| roadGraph links | {len(g['links'])} |")
    for k, v in doc["points"].items():
        w(f"| points.{k} | {len(v)} |")
    w("\n## Footprint coverage\n")
    cov = footprint_coverage(doc)
    if cov:
        n, hit, miss = cov
        w(f"{hit} of {n} reference GeoDanmark buildings (by `fot_id`, KK `bygning_kk` layer) in the bbox are in the output: "
          f"**{100 * hit / max(n, 1):.2f}%** (target >= 98%). Missing examples: {miss or 'none'}.\n")
        w("Caveat: the footprints themselves come from KK's open copy of GeoDanmark `Bygning` (`k101:bygning`), "
          "so this compares two KK layers keyed by GeoDanmark id, not the Datafordeler WFS directly.\n")
    else:
        w("Reference layer not cached; coverage not computed.\n")
    b = doc["buildings"]
    w("## Building heights and attributes\n")
    hs = Counter()
    for x in b:
        s = [t for t in x["src"] if t.startswith(("dsm", "kk:bygning:tagrende", "default:storeys", "default:outbuilding"))]
        hs[s[0] if s else "none"] += 1
    dsm = sum(1 for x in b if x["conf_fields"].get("eave") == "measured")
    w(f"- Buildings with a DSM-measured height: **{dsm} / {len(b)} ({100 * dsm / max(len(b), 1):.1f}%)**")
    w(f"- Buildings with any height source: {sum(hs.values()) - hs['none']} / {len(b)}")
    for k, v in hs.most_common():
        w(f"  - {k}: {v}")
    w(f"- With BBR UUID link: {sum(1 for x in b if x['bbr_id'])} / {len(b)}")
    w(f"- Storeys inferred (no BBR value): {sum(1 for x in b if x['conf_fields'].get('storeys') == 'inferred')}")
    w(f"- Ground measured (DTM): {sum(1 for x in b if x['conf_fields'].get('ground') == 'measured')}; otherwise ground = 0 (flat-district assumption, conf inferred)")
    w("- Facade presets: " + ", ".join(f"{k}={v}" for k, v in Counter(next((t.split('preset:')[1] for t in x['src'] if 'preset:' in t), '?') for x in b).most_common()))
    w("- Roof kind: " + ", ".join(f"{k}={v}" for k, v in Counter(x["roof"] for x in b).most_common()))
    hero = [h["building_id"] for h in doc["heroes"]]
    w(f"- Heroes: {hero}")
    w("\n## Road graph connectivity\n")
    n, comps = graph_components(doc)
    w(f"{n} nodes (dedup tolerance 0.5 m).\n\n| subgraph | links | components | largest | top 5 sizes (nodes) |\n|---|---|---|---|---|")
    for k, (nl, sizes) in comps.items():
        tot = sum(sizes) or 1
        w(f"| {k} | {nl} | {len(sizes)} | {100 * sizes[0] / tot:.1f}% of nodes | {sizes[:5]} |" if sizes else f"| {k} | 0 | 0 | - | - |")
    w(vehicular_fragments(doc))
    rs = Counter()
    for r in doc["roads"]:
        rs[r["class"]] += 1
    w("\nRoads by class: " + ", ".join(f"{k}={v}" for k, v in rs.most_common()))
    cf = Counter()
    for r in doc["roads"]:
        for f, c in r["conf_fields"].items():
            cf[(f, c)] += 1
    w("\nRoad field provenance: " + ", ".join(f"{f}:{c}={n}" for (f, c), n in sorted(cf.items())))
    w(f"\nRoad notes: {meta.get('road_stats', {})}")
    w("\n## Failed / empty layers\n")
    failed = meta.get("failed", {})
    empties = [k for k in ("cycleTracks", "sidewalks", "water", "parks") if not doc[k]] + [f"points.{k}" for k, v in doc["points"].items() if not v]
    if failed or empties:
        for k, v in failed.items():
            w(f"- `{k}`: {v}")
        for k in empties:
            w(f"- `{k}`: empty in output")
    else:
        w("None.")
    w("\n## Conventions\n\n- Rings: counter-clockwise in the (x, -z) map plane, no closing duplicate; holes are also CCW (literal schema reading).\n"
      "- `ground` = 0 without a DTM; `eave`/`ridge` are `ground + height`.\n- Facade: all `inferred`, preset in `src` (`default:preset:*`).")
    Path(a.out).write_text("\n".join(L) + "\n")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
