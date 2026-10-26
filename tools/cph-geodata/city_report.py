"""data/city/coverage.md for build_city.py: per-layer tile coverage and feature counts, GeoDanmark building coverage,
height-source coverage, road-graph connectivity, Frederiksberg substitutions, queued work and sizes on disk."""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

import build_city as BC
import tile_split as T

LAYERS = ["buildings", "roads", "terrain", "surfaces", "furniture", "entrances", "groundfloor", "vegetation", "lod2"]


def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def mb(n: float) -> str:
    return f"{n / 1e6:,.1f} MB" if n < 1e9 else f"{n / 1e9:,.2f} GB"


def building_coverage(tiles: dict) -> dict:
    """Share of GeoDanmark Bygning footprints (Datafordeler GEODKV, centroid inside the DAGI boundary) that are in the tiles."""
    from shapely.geometry import shape
    from shapely.prepared import prep

    gd_path = BC.RAW_CITY / "geodk_bygning.json"
    if not gd_path.exists():
        return {}
    bnd = json.loads((BC.CITY_DIR / "boundary.geojson").read_text())
    union = next(f for f in bnd["features"] if f["properties"].get("kind") == "union")
    pu = prep(shape(union["geometry"]))
    from shapely.geometry import Point

    have, heights, n_tot = set(), Counter(), 0
    kommune = {}
    for k in ("0101", "0147"):
        f = next(f for f in bnd["features"] if f["properties"].get("kommunekode") == k)
        kommune[k] = prep(shape(f["geometry"]))
    for tid in tiles:
        p = BC.TILES_DIR / tid / "buildings.json"
        if not p.exists():
            continue
        for b in json.loads(p.read_text())["buildings"]:
            n_tot += 1
            have.add(b["id"].split("-")[0].removeprefix("gdk:"))
            src = b.get("src", [])
            if "dsm:p60-p95" in src:
                heights["dhm_dsm_measured"] += 1
            elif "kk:bygning:tagrendehoejde_estimat" in src:
                heights["kk_eave_estimate"] += 1
            elif "default:storeys*3.0" in src:
                heights["storeys_x_3m"] += 1
            else:
                heights["default_outbuilding"] += 1
    gd = json.loads(gd_path.read_text())["features"]
    inside = Counter()
    miss = Counter()
    for f in gd:
        c = shape(f["geometry"]).centroid
        if not pu.contains(c):
            continue
        k = next((k for k, pk in kommune.items() if pk.contains(c)), "other")
        inside[k] += 1
        if str(f["properties"]["fot_id"]) not in have:
            miss[k] += 1
    return {"compiled": n_tot, "geodanmark_inside": sum(inside.values()), "missing": sum(miss.values()),
            "by_kommune": {k: {"geodanmark": inside[k], "missing": miss[k]} for k in inside}, "heights": dict(heights)}


def write_report(tiles: dict, cells: dict) -> None:
    t0 = time.time()
    idx = BC.scan_tiles(tiles)
    L = []
    w = L.append
    w("# Citywide data coverage (Københavns + Frederiksberg Kommune)\n")
    w(f"Generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())} by `tools/cph-geodata/build_city.py` (stage `report`). "
      f"{len(tiles)} tiles of 500 m in {len(cells)} one-km cells (`data/city/tiles.json`).\n")
    w("## Layers\n")
    w("| layer | tiles done | of | features (by list) | bytes |")
    w("|---|---:|---:|---|---:|")
    for name in LAYERS:
        have = [e for e in idx.values() if name in e["layers"]]
        agg: Counter = Counter()
        for e in have:
            agg.update(e["counts"].get(name, {}))
        feats = ", ".join(f"{k} {v:,}" for k, v in sorted(agg.items())) or "-"
        w(f"| {name} | {len(have)} | {len(tiles)} | {feats} | {mb(sum(e['layers'][name] for e in have))} |")
    w("")
    bc = building_coverage(tiles)
    if bc:
        w("## Buildings\n")
        pct = 100.0 * (1 - bc["missing"] / max(1, bc["geodanmark_inside"]))
        w(f"- GeoDanmark Bygning footprints (Datafordeler GEODKV `bygning_current`) with the centroid inside the DAGI boundary: "
          f"**{bc['geodanmark_inside']:,}**; of them in the tiles: **{bc['geodanmark_inside'] - bc['missing']:,} ({pct:.2f} %)**; "
          f"missing {bc['missing']:,} (target >= 98 %).")
        for k, v in bc["by_kommune"].items():
            w(f"  - kommune {k}: {v['geodanmark']:,} footprints, {v['missing']:,} missing")
        w(f"- Buildings compiled (parts of multipolygons count separately): {bc['compiled']:,}.")
        w("- Height source (eave and ridge):")
        tot = max(1, sum(bc["heights"].values()))
        names = {"dhm_dsm_measured": "DHM DSM p60/p95 over DTM ground (measured)", "kk_eave_estimate": "KK `tagrendehoejde_estimat` (observed)",
                 "storeys_x_3m": "BBR storeys x 3.0 m (inferred)", "default_outbuilding": "default 3.2 m outbuilding (inferred)"}
        for k, v in sorted(bc["heights"].items(), key=lambda kv: -kv[1]):
            w(f"  - {names.get(k, k)}: {v:,} ({100 * v / tot:.1f} %)")
        b0 = BC.read_done("buildings0")
        if b0:
            w(f"- Footprint sources: KK `bygning` {b0.get('kk_bygning', 0):,}, KK `bygning_kk` extra {b0.get('kk_bygning_kk_extra', 0):,}, "
              f"GeoDanmark Bygning added where KK has none (all of Frederiksberg, plus gaps) {b0.get('geodanmark_added', 0):,} "
              f"({b0.get('geodanmark_added_without_bbr', 0):,} of them without a BBR record).")
        w("")
    gs = BC.WORK / "graph_stats.json"
    if gs.exists():
        g = json.loads(gs.read_text())
        w("## Road graph (`data/city/roadgraph.json`)\n")
        w(f"- {g['nodes']:,} nodes, {g['links']:,} links, built once from the citywide road layer.")
        w(f"- Connected components: {g['components']:,}; the largest holds **{100 * g['largest_share']:.2f} %** of the linked nodes "
          f"(largest ten: {g['largest']}); {g['nodes_in_small_components']:,} nodes sit outside the largest component "
          f"({g['singletons_or_pairs']:,} components of one or two nodes).")
        w("")
    sub = BC.WORK / "frb_substitutions.json"
    if sub.exists():
        w("## Frederiksberg substitutions\n")
        w("The KK WFS layers are empty in Frederiksberg Kommune; these sources replace them (`src`/`conf` mark every item):\n")
        w("| item | source used | count | note |")
        w("|---|---|---:|---|")
        for r in json.loads(sub.read_text()):
            w(f"| {r['item']} | {r['source']} | {r['count']:,} | {r['note']} |")
        w("")
    q = BC.WORK / "queue.md"
    if q.exists():
        w("## Not done yet / queued\n")
        w(q.read_text().strip())
        w("")
    w("## Sizes on disk\n")
    w(f"- `data/tiles`: {mb(_dir_size(BC.TILES_DIR))} ({len(idx)} tiles)")
    w(f"- `data/city`: {mb(sum(f.stat().st_size for f in BC.CITY_DIR.glob('*.json')))}")
    w(f"- `data/raw` (not committed): {mb(_dir_size(BC.DATA / 'raw'))}")
    w(f"- free disk: {BC.free_gb():.1f} GB")
    w("")
    states = sorted(BC.STATE.glob("cell-*-core.json"))
    if states:
        secs = [json.loads(p.read_text()).get("seconds", 0) for p in states]
        w("## Timings\n")
        w(f"- cells stage: {len(states)} cells, {sum(secs) / 60:.1f} CPU-minutes (mean {sum(secs) / len(secs):.0f} s per 1 km cell)")
        w("")
    (BC.CITY_DIR / "coverage.md").write_text("\n".join(L))
    BC.log(f"[report] data/city/coverage.md in {time.time() - t0:.0f}s")
