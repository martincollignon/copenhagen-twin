"""Buildings: GeoDanmark footprints (fot_id) + BBR attributes from KK's open `bygning` layer."""
from __future__ import annotations

from shapely.geometry import box, shape

import frame
import presets

FLAT_ROOFS = ("tagpap med lille", "built-up", "asfalt", "tagpap", "beton", "glas")
PITCHED_ROOFS = ("tegl", "tagsten", "betontagsten", "fibercement", "skifer", "tagpap med stor", "stråtag", "metal", "zink")
DEFAULT_H = 3.2  # outbuilding eave height when no source exists


def roof_kind(mat: str | None) -> str:
    m = (mat or "").lower()
    if not m:
        return "unknown"
    if "stor hældning" in m:
        return "pitched"
    if any(m.startswith(f) for f in FLAT_ROOFS):
        return "flat"
    if any(m.startswith(p) for p in PITCHED_ROOFS):
        return "pitched"
    return "unknown"


def supplement_from_bygning_kk(bygning, bygning_kk):
    """KK's `bygning` layer lacks a few GeoDanmark footprints that `bygning_kk` has; add them
    with the BBR use/year/UUID that layer carries (no storeys/materials)."""
    if not bygning_kk:
        return []
    have = {f["properties"].get("fot_id") for f in bygning["features"]}
    out = []
    for f in bygning_kk["features"]:
        p = f["properties"]
        if p.get("fot_id") in have:
            continue
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "fot_id": p.get("fot_id"), "bygningid": p.get("bbruuid"),
            "bygningensanvendelsekode": p.get("byganvendelsekode"), "opfoerelselsaar": p.get("opfoerelse_aar")}})
    return out


def _parts(geom):
    return list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]


def compile_buildings(kk_bygning: dict, rasters=None, dhm_mod=None):
    """Returns (buildings, stats)."""
    bb = box(*frame.LOCAL_BBOX)
    out = []
    stats = {"input_features": 0, "dsm": 0, "kk_eave": 0, "storey_default": 0, "no_bbr": 0}
    for f in kk_bygning["features"]:
        p = f["properties"]
        fot = p.get("fot_id")
        stats["input_features"] += 1
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        for k, part in enumerate(_parts(g)):
            if part.is_empty or part.area < 1.0:
                continue
            ring = frame.ring_to_local(part.exterior.coords)
            from shapely.geometry import Polygon

            if not Polygon(ring).intersects(bb):
                continue
            holes = [frame.flat(frame.ring_to_local(i.coords)) for i in part.interiors]
            bid = f"gdk:{fot}" if k == 0 else f"gdk:{fot}-{k}"
            out.append(_building(bid, fot, p, ring, holes, part, rasters, dhm_mod, stats))
    return out, stats


def _building(bid, fot, p, ring, holes, part_utm, rasters, dhm_mod, stats):
    use = p.get("bygningensanvendelsekode")
    year = p.get("opfoerelselsaar") or None
    wall = (p.get("ydervaeggensmateriale") or None)
    wall = wall.lower() if wall else None
    roofm = (p.get("tagdaekningsmateriale") or None)
    roofm = roofm.lower() if roofm else None
    storeys = p.get("antaletager") or None
    src = [f"geodanmark:bygning:{fot}"]
    conf_fields: dict[str, str] = {}
    bbr_uuid = (p.get("bygningid") or "").lower() or None
    if bbr_uuid:
        src.append(f"bbr:{bbr_uuid}")
        for fld in ("byg054", "byg021", "byg026", "byg032", "byg033"):
            src.append(f"bbr:{fld}")
    else:
        stats["no_bbr"] += 1

    ground = 0.0
    ground_src = "default:flat-ground"
    ground_conf = "inferred"
    h_conf, h_src = "inferred", None
    eave_h = ridge_h = None
    hs = None
    if rasters is not None:
        hs = dhm_mod.building_heights(rasters, part_utm)
    if hs:
        ground = frame.to_local_y(hs["ground"])
        eave_h = hs["eave"] - hs["ground"]
        ridge_h = hs["ridge"] - hs["ground"]
        ground_src, ground_conf = "dtm:median", "measured"
        h_conf, h_src = "measured", "dsm:p60-p95"
        stats["dsm"] += 1
    elif (p.get("tagrendehoejde_estimat") or 0) >= 2.0:  # <2 m is a placeholder, not a roof height
        eave_h = float(p["tagrendehoejde_estimat"])
        ridge_h = eave_h
        h_conf, h_src = "observed", "kk:bygning:tagrendehoejde_estimat"
        stats["kk_eave"] += 1
    elif storeys:
        eave_h = storeys * 3.0
        ridge_h = eave_h
        h_src = "default:storeys*3.0"
    else:
        eave_h = DEFAULT_H
        ridge_h = eave_h
        h_src = "default:outbuilding-height"
    src.append(h_src)
    src.append(ground_src)
    n_storeys = storeys
    if not n_storeys:
        n_storeys = max(1, round(eave_h / 3.0))
        conf_fields["storeys"] = "inferred"
        stats["storey_default"] += 1
    roof = roof_kind(roofm)
    conf_fields.update({"eave": h_conf, "ridge": h_conf if h_conf == "measured" else "inferred",
                        "ground": ground_conf, "roof": "inferred" if roof != "unknown" else "inferred",
                        "facade": "inferred"})
    fac = presets.facade_for(use, year, wall, eave_h, n_storeys, p.get("antalerhvervsenheder"))
    preset = fac.pop("preset")
    src.append(f"default:preset:{preset}")
    return {
        "id": bid,
        "bbr_id": bbr_uuid,
        "ring": frame.flat(ring),
        "holes": holes,
        "ground": round(ground, 2),
        "eave": round(ground + eave_h, 2),
        "ridge": round(ground + ridge_h, 2),
        "roof": roof,
        "storeys": int(n_storeys),
        "use": use,
        "year": year,
        "wall_material": wall,
        "roof_material": roofm,
        "facade": fac,
        "src": src,
        "conf": "measured",
        "conf_fields": conf_fields,
        "preset": preset,
    }
