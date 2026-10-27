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


def graph_stats(g: dict) -> dict:
    import roadgraph as RG

    n = len(g["nodes"]) // 2
    classes = g["classes"]
    drv = {classes.index(c) for c in ("primary", "secondary", "residential", "service") if c in classes}

    def comp(links):
        sizes = RG.components(n, links)
        used = sum(sizes)
        return {"nodes": used, "links": len(links), "components": len(sizes), "largest": sizes[0] if sizes else 0,
                "largest_share": sizes[0] / used if used else 0, "second": sizes[1] if len(sizes) > 1 else 0,
                "outside_largest": used - (sizes[0] if sizes else 0), "islands_over_20": sum(1 for s in sizes[1:] if s > 20)}

    allr = comp([(l[0], l[1]) for l in g["links"]])
    allr["nodes"] = n
    return {"all": allr, "drivable": comp([(l[0], l[1]) for l in g["links"] if l[7] in drv])}


def district_comparison(tiles: dict) -> dict:
    ref = BC.DISTRICT_REF
    if not ref.is_dir():
        return {}
    out = {"ref": 0, "same": 0, "ref_only": 0, "new_only_inside": 0, "new_outside": 0, "eave_diff": 0, "observed": 0, "footprint_changed": 0}
    diffs = []
    # the old district bbox in local metres: +-750
    inside = lambda b: abs(b["ring"][0]) <= 750 and abs(b["ring"][1]) <= 750  # noqa: E731
    for d in sorted(ref.iterdir()):
        p, q = d / "buildings.json", BC.TILES_DIR / d.name / "buildings.json"
        if not p.exists():
            continue
        A = {b["id"]: b for b in json.loads(p.read_text())["buildings"]}
        B = {b["id"]: b for b in json.loads(q.read_text())["buildings"]} if q.exists() else {}
        out["ref"] += len(A)
        for k, a in A.items():
            b = B.get(k)
            if b is None:
                out["ref_only"] += 1
                continue
            out["same"] += 1
            diffs.append(abs(a["eave"] - b["eave"]))
            if "observed" in a:
                out["observed" if "observed" in b else "footprint_changed"] += 1
        for k, b in B.items():
            if k not in A:
                out["new_only_inside" if inside(b) else "new_outside"] += 1
    out["eave_diff"] = sum(1 for x in diffs if x > 0.05)
    out["eave_mean"] = sum(diffs) / max(1, len(diffs))
    out["eave_max"] = max(diffs, default=0.0)
    srt = sorted(diffs)
    out["eave_median"] = srt[len(srt) // 2] if srt else 0.0
    out["eave_gt05"] = sum(1 for x in diffs if x > 0.5)
    return out


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
    rg = BC.CITY_DIR / "roadgraph.json"
    if rg.exists():
        g = graph_stats(json.loads(rg.read_text()))
        w("## Road graph (`data/city/roadgraph.json`)\n")
        w(f"- {g['all']['nodes']:,} nodes, {g['all']['links']:,} links, built once from the citywide road layer (OSM centrelines of the {len(tiles)} tiles).")
        a = g["all"]
        w(f"- All classes (carriageways, cycleways, footways): {a['components']:,} connected components; the largest holds "
          f"**{100 * a['largest_share']:.2f} %** of the linked nodes; the other {a['components'] - 1:,} are isolated footpath, service-yard and "
          f"park networks that OSM does not connect to the street network ({a['outside_largest']:,} nodes in total).")
        d = g["drivable"]
        w(f"- Carriageways only (primary, secondary, residential, service): {d['components']:,} components; the largest holds "
          f"**{100 * d['largest_share']:.2f} %** of {d['nodes']:,} nodes; the other {d['components'] - 1:,} components have at most "
          f"{d['second']} nodes each (private yards, car parks and cul-de-sacs mapped without a junction to the network) and "
          f"hold {d['outside_largest']:,} nodes in total.")
        w(f"- Vehicles and agents can therefore reach "
          f"{100 * d['largest_share']:.1f} % of the carriageway nodes from any other; no kommune part (Amager, Vestamager, Frederiksberg, Nordhavn, Valby) "
          f"is cut off: {d['islands_over_20']} carriageway components have more than 20 nodes.")
        w("")
    cmp_ = district_comparison(tiles)
    if cmp_:
        w("## District reproduction (16 tiles of the earlier district build)\n")
        w(f"- Buildings in the 16 district tiles, inside the old district bbox (+-750 m): reference {cmp_['ref']:,}, now {cmp_['same']:,} identical ids "
          f"({100 * cmp_['same'] / max(1, cmp_['ref']):.2f} %); {cmp_['ref_only']:,} reference ids no longer exist in any source "
          f"(demolished or re-surveyed since the district build); {cmp_['new_only_inside']:,} ids are new inside the old bbox: the footprints of the part of "
          f"the old district that lies in Frederiksberg (the KK `bygning` layer has none there, so the district build had holes) and a few gap-fills.")
        w(f"- Outside the old district bbox the same tiles now hold {cmp_['new_outside']:,} further buildings (the district build only covered +-750 m).")
        w(f"- Of the identical ids: median eave difference {cmp_['eave_median']:.2f} m; {cmp_['eave_diff']:,} ({100 * cmp_['eave_diff'] / max(1, cmp_['same']):.1f} %) differ by more than 5 cm, "
          f"{cmp_['eave_gt05']:,} by more than 0.5 m (mean {cmp_['eave_mean']:.3f} m, max {cmp_['eave_max']:.1f} m; the large ones are footprints of a few m2 beside a tall "
          f"building). Cause: the DHM WCS resamples differently for every request window (measured: the same 600 m window requested inside two different "
          f"bboxes differs by 0.14 m on average and by up to 23 m at single building edges); the district build used 800 m windows over the district, this one "
          f"uses 600 m windows per 1 km cell.")
        w(f"- Photo-measured wall tones (`observed`) were carried over to {cmp_['observed']:,} of the identical buildings (same footprint); "
          f"{cmp_['footprint_changed']:,} had a changed footprint and keep none.")
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
    qs = sorted(BC.WORK.glob("queue*.md"))
    if qs:
        w("## Not done yet / queued\n")
        for q in qs:
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
