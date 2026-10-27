# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely"]
# ///
"""Lake compiler for the Copenhagen twin -> data/cph-lakes.json (additive: data/cph-geodata.json is never touched).

The twin renders the Soerne as sunken water surfaces with stone walls, so it needs clean, disjoint lake polygons:

  * sources: `water` polygons (OSM natural=water) larger than POND_MAX_M2, plus the Koebenhavns Kommune park-register
    polygons `parkregister.161*` ("Soerne"). The register's .161 polygons are the open-water areas of Sortedams Soe,
    Peblinge Soe and Sankt Joergens Soe (OSM only carries Peblinge Soe), .162 are the shore park strips (ignored);
  * a morphological closing (BRIDGE_CLOSE_M) merges lakes that are only separated by a bridge deck (Dronning Louises Bro
    splits Sortedams Soe from Peblinge Soe by a ~27 m strip). The added strips are reported as `bridges`, with the
    edges that open onto water, so the viewer can build a deck soffit and fascia over water instead of leaving ground;
  * `ponds` are the small basins (fountains, pools): flat water, no walls;
  * `surface_cuts` are the ground-surface polygons (cph-surfaces.json) that overlap a lake (a gravel polygon that
    covers a pond), each with the replacement polygons cut by the lake outline (empty `replace` = drop the surface):
    the viewer must not draw them over the water.

Rings use the geodata convention (flat [x0, z0, ...], counter-clockwise seen from above, i.e. negative shoelace area in
x/z, rounded to 0.01 m; holes the opposite way).

    uv run tools/cph-geodata/lakes.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POND_MAX_M2 = 1500.0  # smaller water polygons are fountains / pools, not lakes
BRIDGE_CLOSE_M = 15.0  # gaps narrower than 2 x this are bridged (a bridge deck between two lakes)
MIN_FILL_M2 = 50.0  # closing artefacts smaller than this are not bridges
REGISTER_LAKE_PREFIX = "kk:parkregister:parkregister.161"
MIN_CUT_M2 = 2.0  # overlaps smaller than this are ignored


def _poly(flat_ring, holes=()):
    from shapely.geometry import Polygon  # noqa: PLC0415

    def pts(r):
        return [(r[i], r[i + 1]) for i in range(0, len(r), 2)]

    return Polygon(pts(flat_ring), [pts(h) for h in holes if len(h) >= 6]).buffer(0)


def _flat(coords, ccw_xz: bool):
    """Open flat ring from shapely coords, oriented counter-clockwise seen from above (x east, z south): in x/z
    that is a NEGATIVE shoelace area; ccw_xz=False flips it (holes)."""
    pts = list(coords)[:-1]
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    want_negative = ccw_xz
    if (area < 0) != want_negative:
        pts.reverse()
    out = []
    for x, z in pts:
        out += [round(x, 2), round(z, 2)]
    return out


def _parts(geom):
    return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "Polygon" and not g.is_empty]


def build_lakes(geo: dict, surfaces: dict | None = None) -> dict:
    from shapely.ops import unary_union  # noqa: PLC0415

    sources, ponds = [], []
    for w in geo.get("water", []):
        p = _poly(w["ring"], w.get("holes", []))
        (sources if p.area >= POND_MAX_M2 else ponds).append((w["id"], w.get("name", ""), p, w))
    for park in geo.get("parks", []):
        if park["id"].startswith(REGISTER_LAKE_PREFIX):
            sources.append((park["id"], park.get("name", ""), _poly(park["ring"], park.get("holes", [])), park))
    union = unary_union([s[2] for s in sources])
    d = BRIDGE_CLOSE_M
    closed = union.buffer(d, join_style=2, mitre_limit=3).buffer(-d, join_style=2, mitre_limit=3)
    fill = closed.difference(union.buffer(0.05))
    fills = [f for f in _parts(fill) if f.area >= MIN_FILL_M2]
    merged = unary_union([union] + [f.buffer(0.1) for f in fills]) if fills else union
    merged = merged.simplify(0.05)

    lakes = []
    for k, p in enumerate(sorted(_parts(merged), key=lambda q: -q.area)):
        members = [s for s in sources if s[2].intersects(p) and s[2].intersection(p).area > 0.5 * s[2].area]
        names = sorted({s[1] for s in members if s[1]})
        rec = {
            "id": f"lake:{k}",
            "name": " / ".join(names) or "Lake",
            "ring": _flat(p.exterior.coords, True),
            "area_m2": round(p.area, 1),
            "src": sorted({x for s in members for x in s[3].get("src", [s[0]])}) or [s[0] for s in members],
            "conf": "inferred",
            "conf_fields": {"surface_level": "inferred", "edge": "inferred"},
        }
        holes = [_flat(h.coords, False) for h in p.interiors if h.area >= 5]
        if holes:
            rec["holes"] = holes
        lakes.append(rec)

    bridges = []
    for f in fills:
        pts = list(f.exterior.coords)[:-1]
        open_edges = []
        for i in range(len(pts)):
            j = (i + 1) % len(pts)
            from shapely.geometry import LineString  # noqa: PLC0415

            if LineString([pts[i], pts[j]]).intersection(union.buffer(0.6)).length > 0.5 * LineString([pts[i], pts[j]]).length:
                open_edges.append(i)
        ring = _flat(f.exterior.coords, True)
        # edge indices refer to the ring as emitted: recompute against the emitted orientation
        emitted = [(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]
        open_edges = [
            i for i in range(len(emitted))
            if LineString([emitted[i], emitted[(i + 1) % len(emitted)]]).intersection(union.buffer(0.6)).length
            > 0.5 * LineString([emitted[i], emitted[(i + 1) % len(emitted)]]).length
        ]
        bridges.append({"id": f"bridge:{len(bridges)}", "ring": ring, "open_edges": open_edges,
                        "area_m2": round(f.area, 1), "conf": "inferred"})

    pond_recs = [{"id": pid, "name": name, "ring": _flat(p.exterior.coords, True), "conf": "inferred"}
                 for pid, name, p, _ in ponds if p.geom_type == "Polygon"]

    cuts = []
    lake_union = unary_union(_parts(merged)) if lakes else None
    if surfaces and lake_union is not None:
        for srf in surfaces.get("surfaces", []):
            sp = _poly(srf["ring"], srf.get("holes", []))
            if sp.is_empty or not sp.intersects(lake_union) or sp.intersection(lake_union).area < MIN_CUT_M2:
                continue
            replace = []
            for k, q in enumerate(sorted(_parts(sp.difference(lake_union)), key=lambda g: -g.area)):
                if q.area < 1.0:
                    continue
                rec = {"id": srf["id"] if k == 0 else f"{srf['id']}~lake{k}", "ring": _flat(q.exterior.coords, True)}
                holes = [_flat(h.coords, False) for h in q.interiors if h.area >= 1.0]
                if holes:
                    rec["holes"] = holes
                replace.append(rec)
            cuts.append({"id": srf["id"], "replace": replace})

    return {
        "version": "cph-lakes/1",
        "method": "water >= %d m2 + kk parkregister.161 (Soerne) polygons, closed over bridge strips (%.0f m)" % (POND_MAX_M2, 2 * BRIDGE_CLOSE_M),
        "frame": geo.get("frame"),
        "lakes": lakes,
        "bridges": bridges,
        "ponds": pond_recs,
        "surface_cuts": cuts,
    }


def main() -> int:
    geo = json.loads((ROOT / "data/cph-geodata.json").read_text())
    sp = ROOT / "data/cph-surfaces.json"
    surfaces = json.loads(sp.read_text()) if sp.exists() else None
    doc = build_lakes(geo, surfaces)
    out = ROOT / "data/cph-lakes.json"
    out.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    print(f"{out}: {len(doc['lakes'])} lakes {[l['area_m2'] for l in doc['lakes']]}, {len(doc['bridges'])} bridge strips, "
          f"{len(doc['ponds'])} ponds, {len(doc['surface_cuts'])} surfaces cut")
    return 0


if __name__ == "__main__":
    sys.exit(main())
