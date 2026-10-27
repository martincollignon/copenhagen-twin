#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "shapely"]
# ///
"""Build source-traced clean facade geometry for Nyhavn 9–17.

The output is a supplemental geometry contract for the v2 integrator. It replaces
the five noisy photo-covered front walls with sampled paint, actual cut openings,
recessed glazing, muntins, cornices and two sign textures. Every feature retains
its source photograph pixel box and an inferred/manual calibration note.

Run with:
  uv run --script tools/nyhavn/hero_facades.py build
"""
from __future__ import annotations

import json
import math
import os
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, box as box2d
from shapely.ops import unary_union

OUT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
MODEL_PATH = OUT / "model/building.json"
ROOFER_PATH = OUT / "model-v2/roofer-roofs.json"
MANIFEST_PATH = OUT / "facade-v2/manifest.json"
SOURCE_ROOT = OUT / "sources/street-reference"
OUT_DIR = OUT / "detail-v3"

HEROES = {
    "kk:1064714861": {"label": "Nyhavn 9", "edge": 5, "photo": "nyhavn-9-17-2022.jpg",
        "source_corners": [[450, 1390], [1270, 1430], [1270, 2220], [440, 2240]],
        "source_roi": [400, 650, 1330, 2280], "color_sample": [650, 1380, 705, 1445],
        "frame_sample": [810, 1002, 916, 1150], "frame_mode":"white",
        "glass_sample": [837, 1040, 855, 1070], "blue_gable": True,
        "right_wing_color_sample":[1180,1450,1235,1510]},
    "kk:1202806702": {"label": "Nyhavn 11", "edge": 20, "photo": "nyhavn-9-17-2018.jpg",
        "source_corners": [[800, 1000], [1765, 925], [1775, 2675], [800, 2725]],
        "source_roi": [760, 880, 1840, 2800], "color_sample": [1010, 1340, 1070, 1400],
        "frame_sample": [879, 1118, 981, 1333], "frame_mode":"white",
        "glass_sample": [1220, 1190, 1250, 1230],
        "trim_sample":[805,995,1765,1080],
        "sidewall_sample":[795,1130,832,1700],"sidewall_mode":"darkbrick","manual_top_dvr90":17.277},
    "kk:1111146131": {"label": "Nyhavn 13", "edge": 3, "photo": "nyhavn-9-17-2018.jpg",
        "source_corners": [[1795, 960], [2640, 900], [2650, 2675], [1800, 2725]],
        "source_roi": [1760, 820, 2700, 2800], "color_sample": [2310, 1280, 2360, 1340],
        "frame_sample": [1848, 1000, 1978, 1230], "frame_mode":"white",
        "glass_sample": [2090, 1110, 2120, 1150],"trim_sample":[1795,950,2640,1015]},
    "kk:1064715124": {"label": "Nyhavn 15", "edge": 12, "photo": "nyhavn-9-17-2018.jpg",
        "source_corners": [[2670, 1345], [3525, 1300], [3530, 2690], [2670, 2725]],
        "source_roi": [2630, 1080, 3560, 2790], "color_sample": [2850, 1620, 2900, 1670],
        "frame_sample": [2725, 1385, 2845, 1595], "frame_mode":"white",
        "glass_sample": [2950, 1475, 2980, 1510],"trim_sample":[2670,1335,3525,1395]},
    "kk:1088186424": {"label": "Nyhavn 17", "edge": 15, "photo": "nyhavn-9-17-2018.jpg",
        "source_corners": [[3515, 1230], [4975, 1155], [4985, 2695], [3515, 2735]],
        "source_roi": [3470, 950, 5030, 2800], "color_sample": [3980, 1530, 4035, 1590],
        "frame_sample": [3570, 1265, 3740, 1515], "frame_mode":"dark",
        "glass_sample": [4105, 1380, 4140, 1420],"trim_sample":[3515,1220,4975,1285]},
}

# Literal source-photo boxes, measured in the original Commons image pixels.
# These are individual traces, not a generated bay grid. Pattern fields describe
# only the muntins visible inside each traced opening.
FEATURES: dict[str, list[dict]] = {
    "kk:1064714861": [
        {"id":"blue-round-window", "kind":"round_window", "box":[817,868,900,944], "panes":[2,2]},
        {"id":"blue-gable-window", "kind":"window", "box":[810,1002,916,1150], "panes":[2,2]},
        {"id":"blue-upper-bay-1", "kind":"window", "box":[630,1227,734,1365], "panes":[2,2]},
        {"id":"blue-upper-bay-2", "kind":"window", "box":[783,1246,891,1386], "panes":[2,2]},
        {"id":"blue-upper-bay-3", "kind":"window", "box":[950,1261,1052,1403], "panes":[2,2]},
        {"id":"blue-right-wing-upper", "kind":"window", "box":[1100,1292,1232,1435], "panes":[2,2]},
        {"id":"blue-lower-bay-1", "kind":"window", "box":[585,1486,722,1677], "panes":[2,2]},
        {"id":"blue-lower-bay-2", "kind":"window", "box":[765,1499,895,1688], "panes":[2,2]},
        {"id":"blue-lower-bay-3", "kind":"window", "box":[935,1515,1060,1698], "panes":[2,2]},
        {"id":"blue-right-wing-lower", "kind":"window", "box":[1095,1532,1215,1705], "panes":[2,2]},
        {"id":"blue-storefront-1", "kind":"storefront", "box":[602,1945,697,2090], "panes":[2,1]},
        {"id":"blue-storefront-2", "kind":"storefront", "box":[746,1905,858,2103], "panes":[2,1]},
        {"id":"blue-storefront-3", "kind":"storefront", "box":[946,1930,1068,2100], "panes":[2,1]},
    ],
    "kk:1202806702": [
        {"id":"red-upper-1-1", "kind":"window", "box":[879,1118,981,1333], "panes":[2,2]},
        {"id":"red-upper-1-2", "kind":"window", "box":[1065,1099,1166,1317], "panes":[2,2]},
        {"id":"red-upper-1-3", "kind":"window", "box":[1241,1078,1349,1301], "panes":[2,2]},
        {"id":"red-upper-1-4", "kind":"window", "box":[1422,1058,1532,1283], "panes":[2,2]},
        {"id":"red-upper-1-5", "kind":"window", "box":[1619,1037,1731,1263], "panes":[2,2]},
        {"id":"red-upper-2-1", "kind":"window", "box":[875,1482,977,1713], "panes":[2,2]},
        {"id":"red-upper-2-2", "kind":"window", "box":[1065,1466,1167,1701], "panes":[2,2]},
        {"id":"red-upper-2-3", "kind":"window", "box":[1240,1451,1348,1685], "panes":[2,2]},
        {"id":"red-upper-2-4", "kind":"window", "box":[1421,1436,1534,1673], "panes":[2,2]},
        {"id":"red-upper-2-5", "kind":"window", "box":[1616,1420,1733,1660], "panes":[2,2]},
        {"id":"red-upper-3-1", "kind":"window", "box":[874,1862,977,2091], "panes":[2,2]},
        {"id":"red-upper-3-2", "kind":"window", "box":[1060,1852,1168,2081], "panes":[2,2]},
        {"id":"red-upper-3-3", "kind":"window", "box":[1238,1842,1350,2072], "panes":[2,2]},
        {"id":"red-upper-3-4", "kind":"window", "box":[1418,1831,1533,2061], "panes":[2,2]},
        {"id":"red-upper-3-5", "kind":"window", "box":[1616,1818,1733,2052], "panes":[2,2]},
        {"id":"red-ground-1", "kind":"storefront", "box":[831,2270,973,2380], "panes":[2,2]},
        {"id":"red-ground-2", "kind":"storefront", "box":[1058,2270,1172,2380], "panes":[2,2]},
        {"id":"red-ground-3", "kind":"storefront", "box":[1225,2260,1340,2380], "panes":[2,2]},
        {"id":"red-arched-entrance", "kind":"arched_door", "box":[1450,2196,1740,2388], "panes":[1,1]},
    ],
    "kk:1111146131": [
        {"id":"cream-upper-1-1", "kind":"window", "box":[1848,1000,1978,1230], "panes":[2,2]},
        {"id":"cream-upper-1-2", "kind":"window", "box":[2022,990,2168,1235], "panes":[2,2]},
        {"id":"cream-upper-1-3", "kind":"window", "box":[2202,975,2350,1220], "panes":[2,2]},
        {"id":"cream-upper-1-4", "kind":"window", "box":[2390,957,2540,1208], "panes":[2,2]},
        {"id":"cream-upper-2-1", "kind":"window", "box":[1848,1360,1978,1630], "panes":[2,2]},
        {"id":"cream-upper-2-2", "kind":"window", "box":[2022,1350,2168,1630], "panes":[2,2]},
        {"id":"cream-upper-2-3", "kind":"window", "box":[2202,1338,2350,1620], "panes":[2,2]},
        {"id":"cream-upper-2-4", "kind":"window", "box":[2390,1328,2540,1608], "panes":[2,2]},
        {"id":"cream-upper-3-1", "kind":"window", "box":[1848,1755,1978,2020], "panes":[2,2]},
        {"id":"cream-upper-3-2", "kind":"window", "box":[2022,1745,2168,2010], "panes":[2,2]},
        {"id":"cream-upper-3-3", "kind":"window", "box":[2202,1735,2350,2005], "panes":[2,2]},
        {"id":"cream-upper-3-4", "kind":"window", "box":[2390,1725,2540,1995], "panes":[2,2]},
        {"id":"cream-ground-1", "kind":"storefront", "box":[1848,2150,1978,2408], "panes":[2,2]},
        {"id":"cream-ground-2", "kind":"storefront", "box":[2022,2140,2168,2408], "panes":[2,2]},
        {"id":"cream-ground-3", "kind":"storefront", "box":[2202,2130,2350,2408], "panes":[2,2]},
        {"id":"cream-ground-4", "kind":"door", "box":[2390,2120,2540,2408], "panes":[2,2]},
    ],
    "kk:1064715124": [
        {"id":"green-upper-1-1", "kind":"window", "box":[2725,1385,2845,1595], "panes":[2,2]},
        {"id":"green-upper-1-2", "kind":"window", "box":[2895,1380,3020,1590], "panes":[2,2]},
        {"id":"green-upper-1-3", "kind":"window", "box":[3072,1375,3200,1585], "panes":[2,2]},
        {"id":"green-upper-1-4", "kind":"window", "box":[3250,1368,3370,1585], "panes":[2,2]},
        {"id":"green-upper-1-5", "kind":"window", "box":[3395,1358,3505,1578], "panes":[2,2]},
        {"id":"green-upper-2-1", "kind":"window", "box":[2725,1740,2845,1994], "panes":[2,2]},
        {"id":"green-upper-2-2", "kind":"window", "box":[2895,1730,3028,1990], "panes":[2,2]},
        {"id":"green-upper-2-3", "kind":"window", "box":[3072,1715,3208,1985], "panes":[2,2]},
        {"id":"green-upper-2-4", "kind":"window", "box":[3250,1705,3370,1982], "panes":[2,2]},
        {"id":"green-upper-2-5", "kind":"window", "box":[3395,1695,3505,1975], "panes":[2,2]},
        {"id":"green-ground-1", "kind":"storefront", "box":[2720,2138,2848,2370], "panes":[2,2]},
        {"id":"green-ground-2", "kind":"door", "box":[2888,2138,3028,2375], "panes":[2,2]},
        {"id":"green-ground-3", "kind":"storefront", "box":[3070,2130,3210,2378], "panes":[2,2]},
        {"id":"green-ground-4", "kind":"storefront", "box":[3250,2125,3370,2378], "panes":[2,2]},
        {"id":"green-ground-5", "kind":"storefront", "box":[3400,2120,3510,2378], "panes":[2,2]},
    ],
    "kk:1088186424": [
        {"id":"yellow-upper-1-1", "kind":"window", "box":[3570,1265,3740,1515], "panes":[2,2]},
        {"id":"yellow-upper-1-2", "kind":"window", "box":[3810,1258,3960,1515], "panes":[2,2]},
        {"id":"yellow-upper-1-3", "kind":"window", "box":[4050,1250,4225,1510], "panes":[2,2]},
        {"id":"yellow-upper-1-4", "kind":"window", "box":[4280,1242,4450,1502], "panes":[2,2]},
        {"id":"yellow-upper-1-5", "kind":"window", "box":[4525,1234,4695,1495], "panes":[2,2]},
        {"id":"yellow-upper-1-6", "kind":"window", "box":[4760,1228,4925,1485], "panes":[2,2]},
        {"id":"yellow-upper-2-1", "kind":"window", "box":[3568,1655,3745,1975], "panes":[2,2]},
        {"id":"yellow-upper-2-2", "kind":"window", "box":[3805,1648,3970,1968], "panes":[2,2]},
        {"id":"yellow-upper-2-3", "kind":"window", "box":[4048,1640,4230,1960], "panes":[2,2]},
        {"id":"yellow-upper-2-4", "kind":"window", "box":[4280,1635,4455,1955], "panes":[2,2]},
        {"id":"yellow-upper-2-5", "kind":"window", "box":[4520,1628,4700,1945], "panes":[2,2]},
        {"id":"yellow-upper-2-6", "kind":"window", "box":[4760,1622,4930,1938], "panes":[2,2]},
        {"id":"yellow-ground-1", "kind":"storefront", "box":[3550,2188,3710,2375], "panes":[2,2]},
        {"id":"yellow-ground-2", "kind":"storefront", "box":[3780,2185,3935,2375], "panes":[2,2]},
        {"id":"yellow-ground-3", "kind":"storefront", "box":[3970,2180,4120,2375], "panes":[2,2]},
        {"id":"yellow-ground-4", "kind":"storefront", "box":[4185,2175,4370,2375], "panes":[2,2]},
        {"id":"yellow-ground-5", "kind":"door", "box":[4425,2170,4625,2375], "panes":[2,2]},
        {"id":"yellow-ground-6", "kind":"storefront", "box":[4750,2165,4935,2375], "panes":[2,2]},
    ],
}


def extend_ground_openings_to_sill():
    """Extend only source-visible ground openings to a near-ground sill.

    Parasol cloth, people and restaurant furniture hide the lower continuation
    in these street photographs. Preserve the visible pixel box separately and
    mark the modeled extension as inferred rather than observed.
    """
    for bid,spec in HEROES.items():
        src=spec["source_corners"]
        left=src[3]; right=src[2]
        x0,y0=map(float,left);x1,y1=map(float,right)
        for feat in FEATURES[bid]:
            if feat["kind"] not in ("storefront","door","arched_door"):
                continue
            if "visible_box" in feat:
                continue
            visible=list(map(int,feat["box"]))
            cx=(visible[0]+visible[2])/2
            t=min(1.0,max(0.0,(cx-x0)/(x1-x0)))
            base_y=y0+(y1-y0)*t
            full=visible.copy()
            full[3]=max(full[1]+1,int(round(base_y-22)))
            feat["visible_box"]=visible
            feat["box"]=full
            feat["inferred_extension"]={
                "direction":"down to a near-ground sill",
                "pixels_added":max(0,full[3]-visible[3]),
                "occlusion_reason":"lower frame and sill hidden by parasols, awnings, people or quay furniture",
                "conf":"inferred"}


extend_ground_openings_to_sill()

# Source-photo crop boxes for raised horizontal trim. Blue9's gable perimeter is
# represented in the wall silhouette; red11's attic strip above this cornice is
# deliberately omitted because the Roofer mesh had merged dormers into that strip.
BANDS = {
    "kk:1202806702": [
        {"id":"red-main-cornice", "kind":"cornice", "box":[805,1000,1765,1080], "material_suffix":"trim_white", "depth_m":0.09},
        {"id":"red-ground-frieze", "kind":"storey_band", "box":[805,2088,1765,2160], "material_suffix":"trim_white", "depth_m":0.05},
    ],
    "kk:1111146131": [
        {"id":"cream-eave-cornice", "kind":"cornice", "box":[1795,925,2640,1005], "material_suffix":"trim_white", "depth_m":0.08},
        {"id":"cream-band-1", "kind":"storey_band", "box":[1810,1220,2630,1265], "material_suffix":"trim_cream", "depth_m":0.035},
        {"id":"cream-band-2", "kind":"storey_band", "box":[1810,1620,2630,1665], "material_suffix":"trim_cream", "depth_m":0.035},
        {"id":"cream-band-3", "kind":"storey_band", "box":[1810,2000,2630,2045], "material_suffix":"trim_cream", "depth_m":0.035},
    ],
    "kk:1064715124": [
        {"id":"green-eave-cornice", "kind":"cornice", "box":[2670,1305,3525,1380], "material_suffix":"trim_white", "depth_m":0.08},
        {"id":"green-belt-course", "kind":"storey_band", "box":[2675,1610,3515,1655], "material_suffix":"trim_green", "depth_m":0.055},
    ],
    "kk:1088186424": [
        {"id":"yellow-eave-cornice", "kind":"cornice", "box":[3515,1170,4975,1250], "material_suffix":"trim_white", "depth_m":0.07},
    ],
}

LABELS = {
    "kk:1064715124": {"text":"HEERING", "box":[2815,2015,3400,2110], "texture":"labels/heering.png", "ink_mode":"white", "font":"/System/Library/Fonts/Supplemental/Georgia Bold.ttf"},
    "kk:1088186424": {"text":"NYHAVN 17", "box":[3590,1995,4765,2145], "texture":"labels/nyhavn-17.png", "ink_mode":"red", "font":"/System/Library/Fonts/Supplemental/Georgia Bold.ttf"},
}


def load_inputs():
    model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    roofer = json.loads(ROOFER_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    buildings = {x["id"]: x for x in model["buildings"]}
    facades = {(x["building_id"], int(x["edge"])): x for x in manifest["facades"]}
    return model, roofer, buildings, facades


def solve_homography(source_points, destination_points):
    rows, vals = [], []
    for (x, y), (u, v) in zip(source_points, destination_points):
        rows.append([x, y, 1, 0, 0, 0, -u*x, -u*y]); vals.append(u)
        rows.append([0, 0, 0, x, y, 1, -v*x, -v*y]); vals.append(v)
    h = np.linalg.solve(np.asarray(rows, dtype=float), np.asarray(vals, dtype=float))
    return np.array([[h[0],h[1],h[2]],[h[3],h[4],h[5]],[h[6],h[7],1.0]], dtype=float)


def project(H, points):
    p = np.c_[np.asarray(points, dtype=float), np.ones(len(points))]
    q = (H @ p.T).T
    return q[:,:2] / q[:,2,None]


def edge_frame(facade, building):
    a = np.asarray(facade["coordinates"]["start"], dtype=float)
    b = np.asarray(facade["coordinates"]["end"], dtype=float)
    delta = b-a
    length = float(np.linalg.norm(delta))
    tangent = delta/length
    normal = np.array([tangent[1],-tangent[0]])
    ring = np.asarray(building["wall_rings"][0]["vertices_epsg25832"], dtype=float)
    midpoint = (a+b)/2
    if np.dot(normal, ring.mean(axis=0)-midpoint) > 0:
        normal = -normal
    return a,b,tangent,normal,length


def source_to_wall(spec, facade):
    quad = np.asarray(spec["source_corners"], dtype=float)
    ground = float(facade["ground_dvr90"])
    tops = list(map(float, facade["top_edge_dvr90"]))
    if spec.get("blue_gable"):
        destination = [(0.0,tops[0]),(float(facade["length_m"]),tops[1]),
                       (float(facade["length_m"]),ground),(0.0,ground)]
        return solve_homography(quad,destination), (ground,tops)
    if spec.get("manual_top_dvr90") is not None:
        tops = [float(spec["manual_top_dvr90"])]*2
    destination = [(0.0,tops[0]),(float(facade["length_m"]),tops[1]),
                   (float(facade["length_m"]),ground),(0.0,ground)]
    return solve_homography(quad,destination), (ground,tops)


def wall_polygon(roofer, bid, edge, facade):
    """Union only Roofer WallSurface triangles coplanar with the selected front edge."""
    record = roofer["buildings"].get(bid.split(":",1)[1])
    if not record:
        raise ValueError(f"Roofer record missing {bid}")
    a = np.asarray(facade["coordinates"]["start"], dtype=float)
    b = np.asarray(facade["coordinates"]["end"], dtype=float)
    delta = b-a
    length = float(np.linalg.norm(delta))
    tangent = delta/length
    normal = np.array([tangent[1],-tangent[0]])
    ring = np.asarray(record["footprint_rings_epsg25832"][0], dtype=float)
    if np.dot(normal, ring.mean(axis=0)-((a+b)/2)) > 0:
        normal = -normal
    vertices = np.asarray(record["vertices_epsg25832_dvr90"], dtype=float)
    triangles = np.asarray(record["triangles"], dtype=int)
    surfaces = record["triangle_surface_type"]
    candidate = []
    for i, idx in enumerate(triangles):
        if surfaces[i] != "WallSurface":
            continue
        tri = vertices[idx]
        dxy = tri[:,:2]-a
        u = dxy@tangent
        off = dxy@normal
        if (np.max(np.abs(off)) <= 0.16 and np.min(u) >= -0.06 and
                np.max(u) <= length+0.06):
            p = Polygon(np.c_[u,tri[:,2]])
            if p.is_valid and p.area > 1e-5:
                candidate.append(p)
    if not candidate:
        raise ValueError(f"No Roofer front WallSurface triangles for {bid} edge {edge}")
    face = unary_union(candidate).buffer(0)
    # Remove sub-centimetre Roofer edge noise while retaining real blue9 steps.
    if face.geom_type != "Polygon":
        pieces = [g for g in getattr(face,"geoms",[]) if g.area > 0.05]
        face = max(pieces,key=lambda p:p.area) if pieces else face
    if face.geom_type != "Polygon":
        raise ValueError(f"Front face not a single polygon for {bid}: {face.geom_type}")
    coords = []
    for u,z in face.exterior.coords:
        if abs(u) < 0.015: u=0.0
        if abs(u-length) < 0.015: u=length
        coords.append((float(u),float(z)))
    face = Polygon(coords)
    if bid == "kk:1202806702":
        # Roofer's highest strip is a merged dormer cap; the clean front wall ends
        # at the visible cornice. Roof/dormer replacement is supplied separately.
        face = Polygon([(0.0,float(facade["ground_dvr90"])),
                        (length,float(facade["ground_dvr90"])),
                        (length,17.277),(0.0,17.277)])
    return face


def adjust_blue_gable_uv(uv, H, facade, source_peak_px=(850,720)):
    """Apply measured peak height only above the eave-calibrated lower wall."""
    uv=np.asarray(uv,dtype=float).copy()
    eave_a,eave_b=map(float,facade["top_edge_dvr90"])
    peak_u=3.686
    peak_z=float(facade["z_max"])
    source_peak=project(H,[source_peak_px])[0]
    length=float(facade["length_m"])
    sp_t=min(1.0,max(0.0,peak_u/length))
    source_eave=eave_a+(eave_b-eave_a)*sp_t
    span=max(0.1,float(source_peak[1])-source_eave)
    for i,(u,z) in enumerate(uv):
        if z<=source_eave:
            continue
        edge_t=min(1.0,max(0.0,u/length))
        eave=eave_a+(eave_b-eave_a)*edge_t
        uv[i,1]=eave+(z-source_eave)/span*(peak_z-eave)
    return uv


def extend_blue_rightwing_silhouette(face,H,facade):
    """Add a small source-visible wall strip where Roofer clips the upper wing.

    The 2022 photo shows the blue facade continuing under the right wing roof.
    Roofer's inferred edge profile turns down too early there. This local patch
    follows two visible roofline points from the photo and does not alter roofs.
    """
    profile_px=[(1110,1260),(1270,1290)]
    profile_uv=adjust_blue_gable_uv(project(H,profile_px),H,facade)
    # The fixed window box reaches one millimetre beyond the hand-traced corner
    # after projective rounding. Extend by 2 cm to avoid a visible sliver seam.
    du=0.02
    dz=(profile_uv[-1,1]-profile_uv[-2,1])/(profile_uv[-1,0]-profile_uv[-2,0])*du
    profile_uv[-1,0]+=du
    profile_uv[-1,1]+=dz
    u0=float(profile_uv[0,0]);u1=float(profile_uv[-1,0])
    outline=list(face.exterior.coords)[:-1]
    peak_i=max(range(len(outline)),key=lambda i:outline[i][1])
    top_path=outline[peak_i:]+outline[:peak_i+1]
    def boundary_at(u):
        for p,q in zip(top_path,top_path[1:]):
            if min(p[0],q[0])-1e-8<=u<=max(p[0],q[0])+1e-8:
                if abs(q[0]-p[0])<1e-8:return float(max(p[1],q[1]))
                t=(u-p[0])/(q[0]-p[0])
                return float(p[1]+t*(q[1]-p[1]))
        return float(face.bounds[3])
    z_old0=boundary_at(float(u0));z_old1=boundary_at(float(u1))
    old_path=[(float(u0),z_old0)]
    active=False
    for p,q in zip(top_path,top_path[1:]):
        if not active and min(p[0],q[0])-1e-8<=u0<=max(p[0],q[0])+1e-8:
            active=True
        if not active:
            continue
        if u0+1e-8<q[0]<u1-1e-8 or (abs(p[0]-q[0])<1e-8 and u0+1e-8<q[0]<u1-1e-8):
            old_path.append((float(q[0]),float(q[1])))
        if min(p[0],q[0])-1e-8<=u1<=max(p[0],q[0])+1e-8:
            old_path.append((float(u1),z_old1))
            break
    new_path=[(float(u),float(z)) for u,z in profile_uv]
    ground=float(facade["ground_dvr90"])
    patch=Polygon([(u0,ground),(u1,ground)]+list(reversed(new_path)))
    if not patch.is_valid: patch=patch.buffer(0)
    extended=face.union(patch).buffer(0)
    return extended,{"source":"sources/street-reference/nyhavn-9-17-2022.jpg",
        "source_roofline_px":[list(map(int,p)) for p in profile_px],
        "world_profile_u_dvr90":[[round(float(u),4),round(float(z),4)] for u,z in profile_uv],
        "roofer_top_path_before":[[round(float(u),4),round(float(z),4)] for u,z in old_path],
        "extension_area_m2":round(float(extended.area-face.area),4),
        "conf":"inferred","reason":"visible blue wall continues beneath the photographed right wing roof junction; Roofer wall boundary clipped part of the upper right-wing opening"}


def rgb_median(photo, roi):
    arr = np.asarray(photo.crop(tuple(map(int,roi))).convert("RGB"), dtype=np.uint8)
    if arr.size == 0:
        raise ValueError(f"empty color sample {roi}")
    return [round(float(x)/255.0,4) for x in np.median(arr.reshape(-1,3),axis=0)]


def sample_masked_color(photo,roi,mode,fallback=None):
    arr=np.asarray(photo.crop(tuple(map(int,roi))).convert("RGB"),dtype=np.float32).reshape(-1,3)
    if not len(arr): return fallback or [0.90,0.89,0.85]
    hi=arr.max(axis=1);lo=arr.min(axis=1);sat=hi-lo
    lum=0.2126*arr[:,0]+0.7152*arr[:,1]+0.0722*arr[:,2]
    if mode=="white": mask=(lum>=195)&(sat<=40)&(arr.min(axis=1)>=195)
    elif mode=="dark": mask=(lum<=82)&(sat<=85)
    elif mode=="red": mask=(arr[:,0]>=105)&(arr[:,0]>=arr[:,1]*1.80)&(arr[:,0]>=arr[:,2]*1.45)&(arr[:,1]<=85)&(sat>=80)
    elif mode=="darkbrick": mask=(arr[:,0]>=arr[:,1]*1.08)&(arr[:,0]>=arr[:,2]*1.03)&(lum<=70)&(sat>=18)
    else: raise ValueError(f"unknown color sample mode: {mode}")
    values=arr[mask]
    minimum=24 if mode=="white" else 12
    if len(values)<minimum:
        defaults={"white":[0.90,0.89,0.85],"dark":[0.12,0.13,0.14],"darkbrick":[0.29,0.12,0.10]}
        return fallback or defaults.get(mode,rgb_median(photo,roi))
    return [round(float(c)/255.0,4) for c in np.median(values,axis=0)]


def color_shift(rgb, factor):
    return [round(min(1.0,max(0.0,x*factor)),4) for x in rgb]


def triangle_list(geom):
    result = constrained_delaunay_triangles(geom)
    geoms = list(result.geoms) if hasattr(result,"geoms") else [result]
    return [g for g in geoms if g.geom_type == "Polygon" and g.area > 1e-8]


class Geometry:
    def __init__(self, a, tangent, normal):
        self.a = a
        self.tangent = tangent
        self.normal = normal
        self.groups = defaultdict(lambda: {"triangles":[],"trace_ids":set(),"src":set()})

    def point(self, uv, depth=0.0):
        u,z = map(float,uv)
        en = self.a + self.tangent*u + self.normal*float(depth)
        return [float(en[0]),float(en[1]),float(z)]

    def add(self, bid, element, material, triangles, trace_id=None, src=None, conf="inferred"):
        if not triangles:
            return
        key=(bid,element,material,conf)
        g=self.groups[key]
        g["triangles"].extend([[[float(c) for c in p] for p in tri] for tri in triangles])
        if trace_id:g["trace_ids"].add(trace_id)
        if src:g["src"].add(src)

    def add_uv_geom(self,bid,element,material,geom,depth=0.0,trace_id=None,src=None):
        tris=[]
        for t in triangle_list(geom):
            pts=list(t.exterior.coords)[:3]
            tri=[self.point(p,depth) for p in pts]
            tris.append(tri)
        self.add(bid,element,material,tris,trace_id,src)

    def add_quad(self,bid,element,material,quad,depth=0.0,trace_id=None,src=None):
        pts=[self.point(p,depth) for p in quad]
        self.add(bid,element,material,[[pts[0],pts[1],pts[2]],[pts[0],pts[2],pts[3]]],trace_id,src)

    def records(self):
        output=[]
        for (bid,element,material,conf),g in self.groups.items():
            output.append({"building_id":bid,"element":element,"material":material,
                           "triangles":g["triangles"],"conf":conf,
                           "src":sorted(g["src"]),"trace_ids":sorted(g["trace_ids"])})
        return output


def map_box_to_uv(H, boxpx, bid, spec, facade):
    x0,y0,x1,y1=map(float,boxpx)
    uv=project(H,[(x0,y0),(x1,y0),(x1,y1),(x0,y1)])
    # Source perspective is removed by the homography; axis-align the resulting
    # metric rectangle because the photographed frames themselves are vertical.
    u0,u1=float(uv[:,0].min()),float(uv[:,0].max())
    z0,z1=float(uv[:,1].min()),float(uv[:,1].max())
    if spec.get("blue_gable"):
        vals=adjust_blue_gable_uv(uv,H,facade)
        z0,z1=float(vals[:,1].min()),float(vals[:,1].max())
    return u0,u1,z0,z1,uv


def source_key(spec):
    return spec["photo"]


def source_ref(spec, source_box):
    return f"sources/street-reference/{source_key(spec)}#px={int(source_box[0])},{int(source_box[1])},{int(source_box[2])},{int(source_box[3])}"


def rectangular_opening(feature, H, bid, spec, facade):
    u0,u1,z0,z1,uv=map_box_to_uv(H,feature["box"],bid,spec,facade)
    if u1-u0 < 0.28 or z1-z0 < 0.45:
        raise ValueError(f"opening too small after calibration: {bid}/{feature['id']} {u1-u0:.2f}×{z1-z0:.2f}")
    return {"u0":u0,"u1":u1,"z0":z0,"z1":z1,
            "poly":box2d(u0,z0,u1,z1),"source_quad_uv":uv}


def round_opening(feature,H,bid,spec,facade):
    rect=rectangular_opening(feature,H,bid,spec,facade)
    u0,u1,z0,z1=(rect[x] for x in ("u0","u1","z0","z1"))
    cx=(u0+u1)/2; cz=(z0+z1)/2; radius=min(u1-u0,z1-z0)/2
    pts=[(cx+radius*math.cos(2*math.pi*i/32),cz+radius*math.sin(2*math.pi*i/32)) for i in range(32)]
    rect["poly"]=Polygon(pts)
    return rect


def arch_opening(feature, H, bid, spec, facade):
    rect=rectangular_opening(feature,H,bid,spec,facade)
    u0,u1,z0,z1=(rect[x] for x in ("u0","u1","z0","z1"))
    width=u1-u0
    # Keep the arch apex within the traced photo rectangle. The prior spring
    # formula added a full half-width above the box top and collided with the
    # upper storefront windows.
    radius=min(width/2,(z1-z0)*0.48)
    spring=z1-radius
    pts=[(u0,z0),(u1,z0),(u1,spring)]
    for i in range(1,13):
        theta=math.pi*i/12
        pts.append(((u0+u1)/2+radius*math.cos(theta),spring+radius*math.sin(theta)))
    pts.append((u0,spring))
    poly=Polygon(pts)
    rect.update({"poly":poly,"spring":spring,"arch_radius":radius})
    return rect


def add_window_geometry(geom, bid, feat, opening, materials, trace):
    u0,u1,z0,z1=(opening[x] for x in ("u0","u1","z0","z1"))
    width=u1-u0; height=z1-z0
    frame=f"{bid}_frame"
    glass="glass_dark"
    src=trace["src"]
    tid=feat["id"]
    # Reveal walls give a true setback around a cut opening; the pane stays behind.
    exterior=list(opening["poly"].exterior.coords)[:-1]
    for i,p0 in enumerate(exterior):
        p1=exterior[(i+1)%len(exterior)]
        p0f=geom.point(p0,0); p1f=geom.point(p1,0)
        p1b=geom.point(p1,-0.14); p0b=geom.point(p0,-0.14)
        geom.add(bid,"window_reveal","reveal_shadow",[[p0f,p1f,p1b],[p0f,p1b,p0b]],tid,src)
    fw=min(0.075,width*0.075,height*0.035)
    # Four clean outer casing strips follow the source-traced aperture.
    strips=[[(u0,z0),(u0+fw,z0),(u0+fw,z1),(u0,z1)],
            [(u1-fw,z0),(u1,z0),(u1,z1),(u1-fw,z1)],
            [(u0+fw,z1-fw),(u1-fw,z1-fw),(u1-fw,z1),(u0+fw,z1)],
            [(u0+fw,z0),(u1-fw,z0),(u1-fw,z0+fw),(u0+fw,z0+fw)]]
    for q in strips:
        geom.add_quad(bid,"window_frame",frame,q,depth=0.025,trace_id=tid,src=src)
    cols,rows=map(int,feat.get("panes",[2,2]))
    clear=(u0+fw,u1-fw,z0+fw,z1-fw)
    cw=(clear[1]-clear[0])/cols; ch=(clear[3]-clear[2])/rows
    for i in range(cols):
        for j in range(rows):
            a=clear[0]+i*cw+0.012; b=clear[0]+(i+1)*cw-0.012
            c=clear[2]+j*ch+0.012; d=clear[2]+(j+1)*ch-0.012
            if b>a and d>c:
                geom.add_quad(bid,"glass_pane",glass,[(a,c),(b,c),(b,d),(a,d)],depth=-0.11,trace_id=tid,src=src)
    bar=min(0.045,width*0.045)
    for i in range(1,cols):
        x=clear[0]+i*cw
        geom.add_quad(bid,"window_mullion",frame,[(x-bar/2,clear[2]),(x+bar/2,clear[2]),(x+bar/2,clear[3]),(x-bar/2,clear[3])],depth=-0.055,trace_id=tid,src=src)
    for j in range(1,rows):
        z=clear[2]+j*ch
        geom.add_quad(bid,"window_mullion",frame,[(clear[0],z-bar/2),(clear[1],z-bar/2),(clear[1],z+bar/2),(clear[0],z+bar/2)],depth=-0.055,trace_id=tid,src=src)
    # Masonry/stone sills are visibly deeper than the paint plane.
    sill_h=min(0.075,height*0.05)
    geom.add_quad(bid,"window_sill",f"{bid}_trim",
                  [(u0-fw*0.2,z0-sill_h),(u1+fw*0.2,z0-sill_h),(u1+fw*0.2,z0+0.015),(u0-fw*0.2,z0+0.015)],
                  depth=0.06,trace_id=tid,src=src)


def add_door_geometry(geom,bid,feat,opening,materials,trace,arch=False):
    tid=feat["id"]; src=trace["src"]
    poly=opening["poly"]
    exterior=list(poly.exterior.coords)[:-1]
    for i,p0 in enumerate(exterior):
        p1=exterior[(i+1)%len(exterior)]
        p0f=geom.point(p0,0); p1f=geom.point(p1,0)
        p1b=geom.point(p1,-0.16); p0b=geom.point(p0,-0.16)
        geom.add(bid,"door_reveal","reveal_shadow",[[p0f,p1f,p1b],[p0f,p1b,p0b]],tid,src)
    if arch:
        # Architrave ring is a geometric offset around the source-traced opening.
        outer=poly.buffer(0.10,join_style="round")
        ring=outer.difference(poly)
        geom.add_uv_geom(bid,"arched_entry_trim",f"{bid}_trim",ring,depth=0.035,trace_id=tid,src=src)
        panel=poly.buffer(-0.10)
        geom.add_uv_geom(bid,"arched_door_panel","door_dark",panel,depth=-0.12,trace_id=tid,src=src)
    else:
        geom.add_uv_geom(bid,"door_panel","door_dark",poly.buffer(-0.07),depth=-0.12,trace_id=tid,src=src)
        u0,u1,z0,z1=(opening[x] for x in ("u0","u1","z0","z1"))
        mid=(u0+u1)/2
        geom.add_quad(bid,"door_mullion",f"{bid}_frame",[(mid-0.025,z0),(mid+0.025,z0),(mid+0.025,z1),(mid-0.025,z1)],depth=-0.05,trace_id=tid,src=src)


def add_round_window(geom,bid,feat,opening,materials,trace):
    u0,u1,z0,z1=(opening[x] for x in ("u0","u1","z0","z1"))
    cx=(u0+u1)/2; cz=(z0+z1)/2; r=min(u1-u0,z1-z0)/2
    angles=np.linspace(0,2*math.pi,25)[:-1]
    inner=[(cx+r*math.cos(a),cz+r*math.sin(a)) for a in angles]
    outer=[(cx+(r+0.085)*math.cos(a),cz+(r+0.085)*math.sin(a)) for a in angles]
    tid=feat["id"]; src=trace["src"]
    for i in range(len(inner)):
        j=(i+1)%len(inner)
        p0f=geom.point(inner[i],0);p1f=geom.point(inner[j],0);p1b=geom.point(inner[j],-0.13);p0b=geom.point(inner[i],-0.13)
        geom.add(bid,"round_window_reveal","reveal_shadow",[[p0f,p1f,p1b],[p0f,p1b,p0b]],tid,src)
        q=[outer[i],outer[j],inner[j],inner[i]]
        geom.add_quad(bid,"round_window_ring",f"{bid}_frame",q,depth=0.035,trace_id=tid,src=src)
    glass_geom=Polygon(inner)
    geom.add_uv_geom(bid,"round_window_glass","glass_dark",glass_geom,depth=-0.10,trace_id=tid,src=src)


def add_band(geom,bid,band,H,spec,facade,materials,trace):
    u0,u1,z0,z1,_=map_box_to_uv(H,band["box"],bid,spec,facade)
    # Reduce a photo rectangle to a clean, physically horizontal trim band.
    # The source line/bbox establishes its height; geometry follows the wall span.
    length=float(facade["length_m"])
    zc=(z0+z1)/2; half=max(0.03,min(0.18,(z1-z0)*0.30))
    geom.add_quad(bid,band["kind"],f"{bid}_{band['material_suffix']}",
                  [(0.0,zc-half),(length,zc-half),(length,zc+half),(0.0,zc+half)],
                  depth=float(band.get("depth_m",0.05)),trace_id=band["id"],src=trace["src"])


def make_label_texture(text, rgb, font_path, out_path):
    out_path.parent.mkdir(parents=True,exist_ok=True)
    w,h=1024,256
    im=Image.new("RGBA",(w,h),(0,0,0,0))
    try: font=ImageFont.truetype(font_path,190)
    except OSError: font=ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf",190)
    draw=ImageDraw.Draw(im)
    bbox=draw.textbbox((0,0),text,font=font,stroke_width=0)
    tw,th=bbox[2]-bbox[0],bbox[3]-bbox[1]
    scale=min((w-48)/max(1,tw),(h-32)/max(1,th))
    if scale<0.999:
        font=ImageFont.truetype(font.path,max(1,int(190*scale)))
        bbox=draw.textbbox((0,0),text,font=font)
        tw,th=bbox[2]-bbox[0],bbox[3]-bbox[1]
    x=(w-tw)/2-bbox[0]; y=(h-th)/2-bbox[1]
    rgba=tuple(int(round(c*255)) for c in rgb)+(255,)
    draw.text((x,y),text,font=font,fill=rgba)
    im.save(out_path)
    return [w,h]


def face_materials(photo, spec, bid):
    paint=rgb_median(photo,spec["color_sample"])
    frame=sample_masked_color(photo,spec["frame_sample"],spec.get("frame_mode","white"))
    glass=rgb_median(photo,spec["glass_sample"])
    return paint,frame,glass


def build():
    model,roofer,buildings,facades=load_inputs()
    OUT_DIR.mkdir(parents=True,exist_ok=True)
    source_cache={}
    materials={"glass_dark":{"color_srgb":[0.18,0.24,0.29],"roughness":0.38},
                "reveal_shadow":{"color_srgb":[0.12,0.13,0.14],"roughness":0.92},
                "door_dark":{"color_srgb":[0.09,0.10,0.11],"roughness":0.74}}
    traces=[]; labels=[]; mesh_groups=[]; replaced=[]; sidewall_materials={}
    max_opening_overlap_m2=0.0
    contact_panels=[]

    for bid,spec in HEROES.items():
        key=(bid,int(spec["edge"]))
        facade=facades.get(key)
        if not facade:
            raise ValueError(f"frontage missing in stable facade manifest: {key}")
        photo_path=SOURCE_ROOT/spec["photo"]
        if photo_path.name not in source_cache:
            source_cache[photo_path.name]=Image.open(photo_path).convert("RGB")
        photo=source_cache[photo_path.name]
        width,height=photo.size
        for p in spec["source_corners"]:
            if not (0<=p[0]<width and 0<=p[1]<height): raise ValueError(f"calibration point outside {photo_path.name}: {p}")
        if spec.get("manual_top_dvr90") is not None:
            facade=dict(facade); facade["top_edge_dvr90"]=[spec["manual_top_dvr90"]]*2
        H,(ground,tops)=source_to_wall(spec,facade)
        building=buildings[bid]
        a,b,tangent,normal,length=edge_frame(facade,building)
        face=wall_polygon(roofer,bid,spec["edge"],facade)
        silhouette_correction=None
        if spec.get("blue_gable"):
            face,silhouette_correction=extend_blue_rightwing_silhouette(face,H,facade)
        geom=Geometry(a,tangent,normal)
        paint,frame_rgb,glass_rgb=face_materials(photo,spec,bid)
        frame_id=f"{bid}_frame"; paint_id=f"{bid}_paint"; trim_id=f"{bid}_trim"
        materials[paint_id]={"color_srgb":paint,"roughness":0.90,
            "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["color_sample"],"statistic":"channel median of source photo patch"}}
        materials[frame_id]={"color_srgb":frame_rgb,"roughness":0.76,
            "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["frame_sample"],"statistic":"median of bright, low-saturation pixels selected as frame paint; off-white fallback if the mask is sparse"}}
        trim_sample=spec.get("trim_sample",spec["frame_sample"])
        trim_rgb=sample_masked_color(photo,trim_sample,"white",fallback=[0.90,0.89,0.85])
        materials[trim_id]={"color_srgb":trim_rgb,"roughness":0.82}
        materials[f"{bid}_trim_white"]={"color_srgb":trim_rgb,"roughness":0.82}
        materials[f"{bid}_trim_cream"]={"color_srgb":color_shift(paint,1.10),"roughness":0.86}
        materials[f"{bid}_trim_green"]={"color_srgb":color_shift(paint,0.82),"roughness":0.88}
        if bid=="kk:1088186424":
            materials[frame_id]={"color_srgb":frame_rgb,"roughness":0.62,
                "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["frame_sample"],"statistic":"median of low-luminance, low-saturation frame pixels selected from the traced window box"}}
        materials["glass_dark"]["sample"]={"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["glass_sample"],"statistic":"photo pane sample; shared dark-glass material approximate"}
        sidewall_materials[bid]=paint_id
        if "sidewall_sample" in spec:
            side_id=f"{bid}_sidewall_paint"
            side_rgb=sample_masked_color(photo,spec["sidewall_sample"],spec.get("sidewall_mode","darkbrick"),fallback=[0.29,0.12,0.10])
            materials[side_id]={"color_srgb":side_rgb,"roughness":0.90,
                "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["sidewall_sample"],"statistic":"median of dark red-brown brick pixels filtered from exposed party-wall patch"}}
            sidewall_materials[bid]=side_id

        # Source calibration face boundary is documented independently of every opening.
        calbox=[int(min(p[0] for p in spec["source_corners"])),int(min(p[1] for p in spec["source_corners"])),
                int(max(p[0] for p in spec["source_corners"])),int(max(p[1] for p in spec["source_corners"]))]
        wall_src=source_ref(spec,calbox)
        opening_records=[]; opening_polys=[]
        for feat in FEATURES[bid]:
            observed_box=feat.get("visible_box",feat["box"])
            src=source_ref(spec,observed_box)
            if feat["kind"]=="round_window": opening=round_opening(feat,H,bid,spec,facade)
            elif feat["kind"]=="arched_door": opening=arch_opening(feat,H,bid,spec,facade)
            else: opening=rectangular_opening(feat,H,bid,spec,facade)
            if not face.buffer(1e-5).covers(opening["poly"]):
                # Small photo-calibration overshoots at facade ends are trimmed to
                # the observed wall polygon; gross misses are an error, not a guess.
                clipped=opening["poly"].intersection(face)
                ratio=clipped.area/max(opening["poly"].area,1e-8)
                if ratio<0.90:
                    raise ValueError(f"feature exceeds facade by {1-ratio:.0%}: {bid}/{feat['id']}")
                opening["poly"]=clipped
            opening_records.append((feat,opening,src))
            opening_polys.append(opening["poly"])
            mapped=np.asarray(opening["poly"].exterior.coords[:-1],dtype=float)
            traces.append({"building_id":bid,"edge":int(spec["edge"]),"feature_id":feat["id"],
                "element":feat["kind"],"source":f"sources/street-reference/{spec['photo']}",
                "source_date":"2022-06-21" if "2022" in spec["photo"] else "2018-07-19",
                "source_attribution":"Jenny Andersson / News Øresund, CC BY 2.0" if "2022" in spec["photo"] else "Liberaler Humanist, CC BY-SA 3.0",
                "source_box_px":list(map(int,observed_box)),"modeled_source_envelope_px":list(map(int,feat["box"])),
                "inferred_extension":feat.get("inferred_extension"),"source_quad_world_uv":mapped.round(4).tolist(),
                "dimensions_m":{"width":round(float(opening["u1"]-opening["u0"]),3),"height":round(float(opening["z1"]-opening["z0"]),3)},
                "conf":"inferred","calibration":"manual four-corner planar registration; dimensions inferred from photograph and Roofer edge extent; not survey measured",
                "visibility_note":("visible upper frame traced; lower continuation inferred to near-ground sill because obscured by parasols, awnings, people or quay furniture" if feat.get("inferred_extension") else "source-visible opening; some portions are partly masked by rigging, signs or awnings")})
        for i,(feat_a,opening_a,_) in enumerate(opening_records):
            for feat_b,opening_b,_ in opening_records[i+1:]:
                overlap=float(opening_a["poly"].intersection(opening_b["poly"]).area)
                max_opening_overlap_m2=max(max_opening_overlap_m2,overlap)
                if overlap>0.005:
                    raise ValueError(f"source-traced openings overlap by {overlap:.4f} m²: {bid}/{feat_a['id']} and {feat_b['id']}")
        holes=unary_union(opening_polys)
        clean_wall=face.difference(holes)
        if spec.get("right_wing_color_sample"):
            # Nyhavn 9 has a visibly lighter blue side wing with two source-traced
            # windows. Keep its paint patch on the same registered frontage plane.
            zone_px=[1095,1245,1270,1735]
            zu0,zu1,zz0,zz1,_=map_box_to_uv(H,zone_px,bid,spec,facade)
            zone=box2d(zu0,zz0,zu1,zz1)
            wing_wall=clean_wall.intersection(zone)
            main_wall=clean_wall.difference(zone)
            wing_id=f"{bid}_right_wing_paint"
            wing_rgb=rgb_median(photo,spec["right_wing_color_sample"])
            materials[wing_id]={"color_srgb":wing_rgb,"roughness":0.90,
                "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":spec["right_wing_color_sample"],"statistic":"channel median of visible blue paint patch on the right window wing"}}
            geom.add_uv_geom(bid,"wall",paint_id,main_wall,depth=0,trace_id=f"{bid}-front-wall",src=wall_src)
            geom.add_uv_geom(bid,"wall_paint_zone",wing_id,wing_wall,depth=0,trace_id=f"{bid}-right-wing-paint-zone",src=source_ref(spec,zone_px))
            traces.append({"building_id":bid,"edge":int(spec["edge"]),"feature_id":"blue-right-wing-paint-zone",
                "element":"paint_zone","source":f"sources/street-reference/{spec['photo']}","source_box_px":zone_px,
                "sample_box_px":spec["right_wing_color_sample"],"conf":"inferred",
                "calibration":"same manual frontage homography as the adjacent gable wall"})
        else:
            geom.add_uv_geom(bid,"wall",paint_id,clean_wall,depth=0,trace_id=f"{bid}-front-wall",src=wall_src)

        for feat,opening,src in opening_records:
            trace={"src":src}
            if feat["kind"]=="round_window":
                add_round_window(geom,bid,feat,opening,materials,trace)
            elif feat["kind"]=="arched_door":
                add_door_geometry(geom,bid,feat,opening,materials,trace,arch=True)
            elif feat["kind"]=="door":
                add_door_geometry(geom,bid,feat,opening,materials,trace,arch=False)
            else:
                add_window_geometry(geom,bid,feat,opening,materials,trace)

        band_specs=BANDS.get(bid,[])
        for band in band_specs:
            src=source_ref(spec,band["box"])
            add_band(geom,bid,band,H,spec,facade,materials,{"src":src})
            traces.append({"building_id":bid,"edge":int(spec["edge"]),"feature_id":band["id"],
                "element":band["kind"],"source":f"sources/street-reference/{spec['photo']}",
                "source_box_px":list(map(int,band["box"])),"conf":"inferred",
                "dimensions_m":{"source_height_m":"inferred from manual photo registration"},
                "calibration":"manual source strip; simple raised band approximation"})

        # Source paint sample and current façade shell bounds are kept separately.
        replaced.append({"building_id":bid,"edge":int(spec["edge"]),"label":spec["label"],
            "paint_material":paint_id,"reason":"clean cutout wall and source-traced geometry replaces both street and native photo wall textures on this front edge",
            "registration":{"source":f"sources/street-reference/{spec['photo']}",
                "source_quad_px":spec["source_corners"],
                "source_quad_order":"upper-left,upper-right,lower-right,lower-left along photographed facade",
                "world_quad_u_dvr90":[[0.0,float(tops[0])],[float(facade["length_m"]),float(tops[1])],
                                      [float(facade["length_m"]),float(ground)],[0.0,float(ground)]],
                "registration_method":"manual planar homography anchored to the Roofer frontage length and wall heights; lower edge is estimated where the source photo is partly hidden by parasols and crowd",
                "conf":"inferred"},
            "silhouette_corrections":[silhouette_correction] if silhouette_correction else []})
        mesh_groups.extend(geom.records())

        roi=spec["source_roi"]
        contact_panels.append({"building_id":bid,"label":spec["label"],"source":photo_path.name,
                               "roi":roi,"features":FEATURES[bid],"bands":band_specs,
                               "labels":[v for k,v in LABELS.items() if k==bid]})

        if bid in LABELS:
            lbl=LABELS[bid]
            src=source_ref(spec,lbl["box"])
            corners=project(H,[(lbl["box"][0],lbl["box"][1]),(lbl["box"][2],lbl["box"][1]),
                               (lbl["box"][2],lbl["box"][3]),(lbl["box"][0],lbl["box"][3])])
            quad=[geom.point(corners[i],0.025) for i in (3,2,1,0)]
            # Pick label paint directly from the letters, not the surrounding wall.
            label_fallback=[0.92,0.91,0.87] if lbl["ink_mode"]=="white" else [0.78,0.08,0.04]
            label_rgb=sample_masked_color(photo,lbl["box"],lbl["ink_mode"],fallback=label_fallback)
            mat_id=f"{bid}_sign_ink"
            materials[mat_id]={"color_srgb":label_rgb,"roughness":0.72,
                "sample":{"source":f"sources/street-reference/{spec['photo']}","pixel_box":lbl["box"],"statistic":f"median of source pixels filtered to {lbl['ink_mode']} sign ink"}}
            tex_path=OUT_DIR/lbl["texture"]
            texsize=make_label_texture(lbl["text"],label_rgb,lbl["font"],tex_path)
            labels.append({"building_id":bid,"edge":int(spec["edge"]),"text":lbl["text"],
                "material":mat_id,"texture_path":lbl["texture"],"texture_size_px":texsize,
                "world_quad_epsg25832_dvr90":quad,"normal_xy":normal.tolist(),
                "quad_order":"bottom-left,bottom-right,top-right,top-left in facade-u/z coordinates",
                "uv_quad":[[0,1],[1,1],[1,0],[0,0]],"source":f"sources/street-reference/{spec['photo']}",
                "source_box_px":list(map(int,lbl["box"])),"conf":"inferred",
                "registration":"manual photo-to-wall homography; physical text dimensions inferred from visible sign box; typeface approximated by Georgia Bold",
                "appears_within_replaced_facade":True})
            traces.append({"building_id":bid,"edge":int(spec["edge"]),"feature_id":f"{bid}-sign-{lbl['text'].lower().replace(' ','-')}",
                "element":"sign_text","source":f"sources/street-reference/{spec['photo']}","source_box_px":list(map(int,lbl["box"])),
                "text":lbl["text"],"dimensions_m":{"width":round(float(max(corners[:,0])-min(corners[:,0])),3),
                                                       "height":round(float(max(corners[:,1])-min(corners[:,1])),3)},
                "conf":"inferred","calibration":"manual source box projected by same frontage homography; lettering typeface approximated"})

    # Join grouped meshes and validate every reference before writing.
    meshes=mesh_groups
    expected_counts={"kk:1064714861":13,"kk:1202806702":19,"kk:1111146131":16,"kk:1064715124":15,"kk:1088186424":18}
    feature_counts={bid:len(FEATURES[bid]) for bid in HEROES}
    if feature_counts != expected_counts:
        raise ValueError(f"source trace count mismatch: {feature_counts}")
    for f in traces:
        path=SOURCE_ROOT/Path(f["source"]).name
        if not path.is_file(): raise FileNotFoundError(path)
        im=source_cache[path.name]
        for box in [f["source_box_px"],f.get("modeled_source_envelope_px",f["source_box_px"])]:
            x0,y0,x1,y1=box
            if x0<0 or y0<0 or x1>im.width or y1>im.height or x1<=x0 or y1<=y0:
                raise ValueError(f"invalid source box {f['feature_id']}: {box}")
    triangle_count=0; vertex_count=0
    for m in meshes:
        for tri in m["triangles"]:
            arr=np.asarray(tri,dtype=float)
            if arr.shape!=(3,3) or not np.isfinite(arr).all(): raise ValueError(f"bad triangle in {m['building_id']}/{m['element']}")
            triangle_count+=1;vertex_count+=3
    if {x["building_id"] for x in replaced} != set(HEROES):
        raise ValueError("not all five hero fronts are replaced")

    document={"schema":"nyhavn-detail-v3/1","frame":{"horizontal":"EPSG:25832","vertical":"DVR90",
                "coordinates":"absolute [E,N,H]; front face u follows selected footprint edge start→end; outward normal faces the canal"},
        "materials":materials,"meshes":meshes,"replaced_facades":replaced,
        "sidewall_materials":sidewall_materials,"labels":labels,"traces":traces,
        "source_images":[
            {"id":"nyhavn-9-17-2018","path":"sources/street-reference/nyhavn-9-17-2018.jpg","date":"2018-07-19","attribution":"Liberaler Humanist, CC BY-SA 3.0","resolution_px":[5760,3840]},
            {"id":"nyhavn-9-17-2022","path":"sources/street-reference/nyhavn-9-17-2022.jpg","date":"2022-06-21","attribution":"Jenny Andersson / News Øresund, CC BY 2.0","resolution_px":[4032,3024]}],
        "method":"Roofer WallSurface front-edge polygons cut by manually photo-traced window, door and round-window apertures. Frames, mullions and panes sit within recessed openings. 2018 photograph bounds follow the visible upper cornice and an estimated quay/wall base partly hidden by parasols; this registration is manually inferred. Facade paint, brick, frame and trim colors use source-pixel filtering. Sign text uses alpha textures with an inferred font match.",
        "limitations":["All dimensions and front-wall registration are inferred from manual projective calibration of perspective photographs; they are not survey measurements.","Windows and lower storefront openings partly obscured by rigging, signs, awnings or people are traced from visible frame bounds; concealed detail is not invented.","Nyhavn 11 front wall ends at the photographed cornice at DVR90 17.277 m; the higher Roofer strip is omitted as a merged dormer cap pending roof replacement.","Text typeface is approximated; signage is included to retain recognizable facade character.","No interiors are modeled; dark pane geometry represents glazing only."],
        "validation":{"hero_facade_count":len(replaced),"feature_counts":feature_counts,"mesh_count":len(meshes),
                      "triangle_count":triangle_count,"vertex_count":vertex_count,"all_vertices_finite":True,
                      "all_source_boxes_valid":True,"all_opening_dimensions_positive":True,
                      "max_pairwise_opening_overlap_m2":round(max_opening_overlap_m2,6),
                      "opening_overlap_limit_m2":0.005}}
    outpath=OUT_DIR/"facades.json"
    outpath.write_text(json.dumps(document,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    make_contact_sheet(contact_panels,source_cache,OUT_DIR/"trace-contact-sheet.png")
    print(json.dumps({"facades":len(replaced),"feature_counts":feature_counts,"meshes":len(meshes),
                      "triangles":triangle_count,"vertices":vertex_count,"labels":len(labels),
                      "output":str(outpath),"contact_sheet":str(OUT_DIR/"trace-contact-sheet.png")},indent=2))


def make_contact_sheet(panels, source_cache, outpath):
    """Render a review sheet with numbered manual source boxes over each photo crop."""
    cell_w,cell_h=1100,700
    sheet=Image.new("RGB",(cell_w*2,cell_h*3),(246,244,239))
    draw=ImageDraw.Draw(sheet)
    try: title=ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf",24)
    except OSError: title=ImageFont.load_default()
    try: small=ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf",16)
    except OSError: small=ImageFont.load_default()
    for idx,panel in enumerate(panels):
        ox=(idx%2)*cell_w; oy=(idx//2)*cell_h
        photo=source_cache[panel["source"]]
        x0,y0,x1,y1=panel["roi"]
        crop=photo.crop((x0,y0,x1,y1)).convert("RGB")
        crop.thumbnail((cell_w-36,cell_h-112),Image.Resampling.LANCZOS)
        scale=crop.width/(x1-x0)
        px=ox+18;py=oy+78
        sheet.paste(crop,(px,py))
        draw.text((ox+18,oy+15),f"{panel['label']} · {len(panel['features'])} source-traced openings",font=title,fill=(42,43,42))
        draw.text((ox+18,oy+48),f"{panel['source']} · photo pixels shown at {scale:.3f}×",font=small,fill=(77,77,74))
        draw.text((ox+18,oy+65),"orange = full opening incl. inferred hidden sill; cyan = visible source extent",font=small,fill=(77,77,74))
        py=oy+90
        for j,feat in enumerate(panel["features"],1):
            x0f,y0f,x1f,y1f=feat["box"]
            r=(px+(x0f-x0)*scale,py+(y0f-y0)*scale,px+(x1f-x0)*scale,py+(y1f-y0)*scale)
            color=(230,66,46) if feat["kind"] not in ("round_window","arched_door") else (0,129,143)
            if feat.get("visible_box"):
                draw.rectangle(r,outline=(232,130,36),width=3)
                vx0,vy0,vx1,vy1=feat["visible_box"]
                vr=(px+(vx0-x0)*scale,py+(vy0-y0)*scale,px+(vx1-x0)*scale,py+(vy1-y0)*scale)
                draw.rectangle(vr,outline=(0,129,143),width=3)
            else:
                draw.rectangle(r,outline=color,width=3)
            draw.text((r[0]+2,r[1]+2),str(j),font=small,fill=(20,20,20),stroke_width=2,stroke_fill=(255,255,255))
        for band in panel["bands"]:
            x0f,y0f,x1f,y1f=band["box"]
            r=(px+(x0f-x0)*scale,py+(y0f-y0)*scale,px+(x1f-x0)*scale,py+(y1f-y0)*scale)
            draw.rectangle(r,outline=(37,104,197),width=2)
        for lbl in panel["labels"]:
            x0f,y0f,x1f,y1f=lbl["box"]
            r=(px+(x0f-x0)*scale,py+(y0f-y0)*scale,px+(x1f-x0)*scale,py+(y1f-y0)*scale)
            draw.rectangle(r,outline=(113,59,169),width=3)
            draw.text((r[0]+2,r[1]+2),lbl["text"],font=small,fill=(30,20,40),stroke_width=2,stroke_fill=(255,255,255))
    sheet.save(outpath)


if __name__ == "__main__":
    build()
