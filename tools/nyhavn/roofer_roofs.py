#!/usr/bin/env python3
"""Run Roofer for the durable Nyhavn project and export normalized roof/wall meshes.

Run: uv run --script tools/nyhavn/roofer_roofs.py
Writes inputs under ~/.local/share/building-case-3d/nyhavn/sources/lidar and the
roofer-roofs.json handoff under model-v2. Coordinates are absolute [E,N,H] in
EPSG:25832 / DVR90. Roofer wall semantics include the gable triangles.
"""
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "mapbox-earcut>=1.0.1"]
# ///
from __future__ import annotations
import datetime as dt
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any
import numpy as np
import mapbox_earcut as earcut

ROOT = Path(__file__).resolve().parents[2]
PROJECT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
INPUT = PROJECT / "model/building.json"
LIDAR = PROJECT / "sources/lidar"
WORK = LIDAR / "roofer-work/6176_725"
OUTPUT = PROJECT / "model-v2/roofer-roofs.json"
TILE = "6176_725"
IMAGE = "3dgi/roofer:v1.1.0-beta.1"
MARGIN = 25.0
MIN_DENSITY, MAX_NODATA = 4.0, 0.30
MATCH_DIST, MATCH_COS = 0.30, math.cos(math.radians(5))


def cmd(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True)


def laz_path(tile: str = TILE) -> Path:
    return LIDAR / f"PUNKTSKY_1km_{tile}.laz"


def get_laz() -> Path:
    path = laz_path()
    if path.exists() and path.open("rb").read(4) == b"LASF":
        print(f"LAZ {TILE}: already present ({path.stat().st_size / 1e6:.0f} MB)", flush=True)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    cache = Path.home() / ".cache/dk-lidar" / path.name
    if cache.exists() and cache.open("rb").read(4) == b"LASF":
        part = path.with_suffix(".laz.part")
        if sys.platform == "darwin":
            cp = subprocess.run(["cp", "-c", str(cache), str(part)], capture_output=True, text=True)
            if cp.returncode:
                shutil.copyfile(cache, part)
        else:
            shutil.copyfile(cache, part)
        os.replace(part, path)
        print(f"LAZ {TILE}: copied from local cache", flush=True)
        return path
    helper = Path(__file__).resolve().with_name("adc-secret.sh")
    if not helper.is_file():
        helper = ROOT / "tools/adc-secret.sh"
    key = cmd([str(helper), "datafordeler-graphql-api-key"]).stdout.strip()
    if not key:
        raise RuntimeError("Datafordeler API key helper returned an empty value")
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    # Keep any earlier interrupted .laz.part intact for diagnosis.
    part = path.with_name(f"{path.name}.download-{stamp}.part")
    url = f"https://api.datafordeler.dk/FileDownloads/GetPointCloudFile?apiKey={key}&FileName={path.name}"
    print(f"LAZ {TILE}: downloading into durable Nyhavn sources/lidar", flush=True)
    # Send the key via curl config stdin, and suppress captured diagnostics.
    p = subprocess.run(["curl", "-sS", "--fail", "--max-time", "1800", "-o", str(part), "-K", "-"],
                       input=f'url = "{url}"\n', capture_output=True, text=True)
    if p.returncode or not part.exists() or part.stat().st_size <= 1_000_000 or part.open("rb").read(4) != b"LASF":
        raise RuntimeError(f"DHM Punktsky download failed for tile {TILE} (curl rc={p.returncode})")
    os.replace(part, path)
    print(f"LAZ {TILE}: downloaded {path.stat().st_size / 1e6:.0f} MB", flush=True)
    return path


def date_from_gps(seconds: float) -> str:
    return (dt.datetime(1980, 1, 6, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=float(seconds) + 1e9)).date().isoformat()


def get_scan(path: Path) -> dict:
    meta_path = path.with_suffix(".meta.json")
    if meta_path.exists():
        try:
            return json.loads(meta_path.read_text())
        except (ValueError, OSError):
            pass
    data = json.loads(cmd(["pdal", "info", "--stats", "--dimensions", "GpsTime", str(path)]).stdout)
    stats = data["stats"]["statistic"]
    s = next((v for v in stats if v.get("name", "").lower() == "gpstime"), stats[0])
    out = {"tile": TILE, "count": s["count"], "gps_min": s["minimum"], "gps_max": s["maximum"],
           "scan_date_min": date_from_gps(s["minimum"]), "scan_date_max": date_from_gps(s["maximum"]),
           "scan_date": date_from_gps(s.get("average", (s["minimum"] + s["maximum"]) / 2))}
    meta_path.write_text(json.dumps(out, indent=2) + "\n")
    return out


def bounds_for(buildings: list[dict]) -> tuple[float, float, float, float]:
    points = [p for b in buildings for ring in [b["footprint_epsg25832"], *(b.get("footprint_holes_epsg25832") or [])] for p in ring]
    return (min(p[0] for p in points) - MARGIN, min(p[1] for p in points) - MARGIN,
            max(p[0] for p in points) + MARGIN, max(p[1] for p in points) + MARGIN)


def make_inputs(buildings: list[dict], bounds: tuple[float, float, float, float], scan: dict) -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    feats, byid = [], {}
    for b in buildings:
        bid = str(int(b["kk_fot_id"]))
        rings = [b["footprint_epsg25832"], *(b.get("footprint_holes_epsg25832") or [])]
        coords = []
        for ring in rings:
            if len(ring) < 3 or not all(math.isfinite(float(v)) for p in ring for v in p[:2]):
                raise ValueError(f"Invalid footprint ring: {bid}")
            closed = [[round(float(p[0]), 3), round(float(p[1]), 3)] for p in ring]
            coords.append(closed + [closed[0]])
        year = b.get("year")
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords},
                      "properties": {"id": bid, "yoc": int(year) if isinstance(year, int) else 0,
                                     "force_lod11": False}})
        byid[bid] = {"building": b, "rings": rings}
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}}, "features": feats}
    (WORK / "footprints.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    (WORK / "manifest.json").write_text(json.dumps({"tile": TILE, "scan": scan, "margin_m": MARGIN,
        "footprint_bounds_epsg25832": list(bounds), "target_buildings": len(buildings), "input_ids": sorted(byid)}, indent=2) + "\n")
    cropped, pipe = WORK / "cropped.laz", WORK / "crop.json"
    if not cropped.exists():
        e0, n0, e1, n1 = bounds
        pipeline = [
            {"type": "readers.las", "filename": str(laz_path()), "tag": "tile"},
            {"type": "filters.range", "limits": "Classification[2:2],Classification[6:6]"},
            {"type": "filters.crop", "bounds": f"([{e0:.3f},{e1:.3f}],[{n0:.3f},{n1:.3f}])"},
            {"type": "writers.las", "filename": str(cropped), "compression": "laszip"},
        ]
        pipe.write_text(json.dumps(pipeline, indent=2) + "\n")
        print(f"PDAL crop: classes 2+6, {MARGIN:g} m beyond footprint bounds", flush=True)
        cmd(["pdal", "pipeline", str(pipe)])
    else:
        print(f"PDAL crop: reusing {cropped} ({cropped.stat().st_size / 1e6:.0f} MB)", flush=True)
    year = int(scan["scan_date"][:4])
    # No h-terrain-attribute is supplied: Roofer estimates terrain from class 2
    # points instead of inheriting the old whole-footprint median in model v1.
    toml = f'''[input]\npolygon-source = "/data/footprints.geojson"\nid-attribute = "id"\nyoc-attribute = "yoc"\nforce-lod11-attribute = "force_lod11"\n\n[[input.pointclouds]]\nname = "punktsky"\nquality = 1\ndate = {year}\nsource = ["/data/cropped.laz"]\nbuilding_class = 6\nground_class = 2\n\n[crop]\nceil-point-density = 20\nmin-building-density = 1\nclear-insufficient = true\n\n[reconstruction]\nlod12 = false\nlod22 = true\n\n[output]\noutput-directory = "/data/out"\n'''
    (WORK / "roofer.toml").write_text(toml)


def run_roofer() -> None:
    out = WORK / "out"
    if any(out.glob("*.jsonl")):
        print("Roofer: reusing existing CityJSONSeq output", flush=True)
        return
    arch = "linux/arm64" if platform.machine().lower() in ("arm64", "aarch64") else "linux/amd64"
    print("Roofer: starting 6176_725 Docker batch (-j 4)", flush=True)
    t0 = time.time()
    p = subprocess.run(["docker", "run", "--rm", "--platform", arch, "-v", f"{WORK}:/data", IMAGE,
                        "-c", "/data/roofer.toml", "-j", "4", "/data/out"], capture_output=True, text=True)
    (WORK / "roofer.log").write_text(p.stdout + p.stderr)
    if p.returncode or not any(out.glob("*.jsonl")):
        raise RuntimeError(f"Roofer failed rc={p.returncode}; see {WORK / 'roofer.log'}")
    print(f"Roofer: CityJSONSeq ready in {time.time()-t0:.1f}s", flush=True)


def newell(poly: np.ndarray) -> np.ndarray:
    n = np.zeros(3, dtype=np.float64)
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        n += [(a[1]-b[1])*(a[2]+b[2]), (a[2]-b[2])*(a[0]+b[0]), (a[0]-b[0])*(a[1]+b[1])]
    return n


def triangulate(rings: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    normal = newell(rings[0]); length = np.linalg.norm(normal)
    if length < 1e-10: return None
    normal /= length
    pts = np.concatenate(rings)
    keep = [i for i in range(3) if i != int(np.argmax(np.abs(normal)))]
    ends = np.cumsum([len(r) for r in rings], dtype=np.uint32)
    tris = earcut.triangulate_float64(pts[:, keep], ends).reshape(-1, 3)
    if not len(tris): return None
    for i, (a,b,c) in enumerate(tris):
        if np.dot(np.cross(pts[b]-pts[a], pts[c]-pts[a]), normal) < 0: tris[i] = [a,c,b]
    return pts, tris, normal


def edges_of(rings: list[list[list[float]]]) -> list[dict]:
    edges = []
    for ri, ring in enumerate(rings):
        for ei, a in enumerate(ring):
            b = ring[(ei+1) % len(ring)]; d = np.asarray(b[:2],float)-np.asarray(a[:2],float); ln = float(np.linalg.norm(d))
            if ln > .01: edges.append({"ring":ri,"edge":ei,"a":np.asarray(a[:2],float),"u":d/ln,"length":ln})
    return edges


def match_edge(poly: np.ndarray, edges: list[dict]) -> tuple[dict,float,float] | None:
    zmin = float(poly[:,2].min()); foot = poly[poly[:,2] <= zmin+.05,:2]
    if len(foot)<2:return None
    pair=max(((i,j) for i in range(len(foot)) for j in range(i+1,len(foot))),key=lambda ij:float(np.linalg.norm(foot[ij[1]]-foot[ij[0]])))
    a,b=foot[pair[0]],foot[pair[1]]; d=b-a; ln=float(np.linalg.norm(d))
    if ln<.2:return None
    direction=d/ln; cand=[]
    for e in edges:
        if abs(float(np.dot(direction,e["u"]))) < MATCH_COS: continue
        perp=np.array([-e["u"][1],e["u"][0]])
        dist=max(abs(float(np.dot(a-e["a"],perp))),abs(float(np.dot(b-e["a"],perp))))
        if dist>MATCH_DIST:continue
        s0,s1=sorted((float(np.dot(a-e["a"],e["u"])),float(np.dot(b-e["a"],e["u"]))))
        overlap=min(s1,e["length"])-max(s0,0.)
        if overlap < min(.5*ln,.25):continue
        cand.append((overlap,-dist,e,max(0.,s0),min(e["length"],s1)))
    if not cand:return None
    _,_,e,s0,s1=max(cand,key=lambda x:(x[0],x[1]))
    return (e,s0,s1)


def cityjsonseq(path: Path):
    transform=None
    for line in path.open():
        if not line.strip():continue
        obj=json.loads(line)
        if obj.get("type")=="CityJSON":transform=obj["transform"];continue
        yield transform or obj.get("transform",{"scale":[1,1,1],"translate":[0,0,0]}),obj


def shells(feature: dict, oid: str):
    objects=feature["CityObjects"]; parent=objects[oid]; children=parent.get("children") or [oid]; out=[]
    for child in children:
        for g in objects[child].get("geometry",[]) or []:
            if str(g.get("lod"))!="2.2":continue
            ss=g.get("semantics",{}).get("surfaces",[]); vals=g.get("semantics",{}).get("values",[])
            if g.get("type")=="Solid":
                for sh,vv in zip(g["boundaries"],vals):
                    out.append((sh,[ss[i]["type"] if i is not None else None for i in vv]))
            elif g.get("type")=="MultiSurface":
                out.append((g["boundaries"],[ss[i]["type"] if i is not None else None for i in vals]))
    return out


def safe(x: Any):
    if isinstance(x,dict):return {str(k):safe(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [safe(v) for v in x]
    if isinstance(x,(np.integer,)):return int(x)
    if isinstance(x,(np.floating,float)):
        v=float(x);return v if math.isfinite(v) else None
    if isinstance(x,np.bool_):return bool(x)
    return x


def normalize_attrs(obj: dict, scan_year: int) -> tuple[dict,dict]:
    a=obj.get("attributes",{}) or {}
    def attr(name): return a.get(f"rf_{name}_punktsky",a.get(f"rf_{name}"))
    all_rf={k:v for k,v in a.items() if k.startswith("rf_")}
    fit={"success":a.get("rf_success"),"rmse_lod22":a.get("rf_rmse_lod22"),
         "point_density_pts_m2":attr("pt_density"),"nodata_fraction":attr("nodata_frac"),
         "roof_type":a.get("rf_roof_type"),"roof_planes":a.get("rf_roof_planes"),
         "pointcloud_unusable":a.get("rf_pointcloud_unusable"),"extrusion_mode":a.get("rf_extrusion_mode"),
         "terrain_dvr90":a.get("rf_h_ground"),"scan_year":scan_year}
    return safe(all_rf),safe(fit)


def reconstruct_one(feature: dict, oid: str, verts: np.ndarray, b: dict, rings: list[list[list[float]]], scan_year: int) -> dict:
    attrs,fit=normalize_attrs(feature["CityObjects"][oid],scan_year)
    reason=None; yoc=b.get("year")
    if isinstance(yoc,int) and yoc>scan_year:reason=f"register year {yoc} post-dates scan"
    elif fit["success"] is not True:reason="roofer reported failure"
    elif fit["pointcloud_unusable"]:reason="roofer marked point cloud unusable"
    elif fit["extrusion_mode"] not in (None,"standard"):reason=f"roofer extrusion mode {fit['extrusion_mode']}"
    elif fit["nodata_fraction"] is not None and fit["nodata_fraction"]>MAX_NODATA:reason=f"nodata fraction exceeds {MAX_NODATA:.0%}"
    elif fit["point_density_pts_m2"] is not None and fit["point_density_pts_m2"]<MIN_DENSITY:reason=f"point density below {MIN_DENSITY:g}/m2"
    elif fit["roof_type"] in ("no points","no planes"):reason=f"roof type: {fit['roof_type']}"
    solid=shells(feature,oid)
    if not solid:reason=reason or "no LoD2.2 geometry returned"
    edge_defs=edges_of(rings); eaves=[[[] for _ in ring] for ring in rings]
    vertices=[]; triangles=[]; kinds=[]; rattrs=[]; eattrs=[]; surfaces=[]; invalid=0; roof_count=wall_count=0
    for shell,types in solid:
        for face,typ in zip(shell,types):
            if typ not in ("RoofSurface","WallSurface"):continue
            xyz=[verts[np.asarray(r,dtype=np.int64)] for r in face]
            if any(len(r)<3 or not np.isfinite(r).all() for r in xyz):invalid+=1;continue
            t=triangulate(xyz)
            if t is None:invalid+=1;continue
            pts,tris,normal=t
            if typ=="RoofSurface":
                if abs(normal[2])<=1e-5:invalid+=1;continue
                if normal[2]<0:tris=tris[:,[0,2,1]]
            base=len(vertices);vertices.extend(pts.tolist());match=None
            if typ=="WallSurface":match=match_edge(xyz[0],edge_defs)
            ri,ei=(-1,-1)
            if match:
                edge,s0,s1=match;ri,ei=edge["ring"],edge["edge"]
                # Only ground-to-eave faces provide eaves. Terrain comes from Roofer's
                # Class 2 ground estimate, never the old v1 footprint-wide median.
                ground=fit.get("terrain_dvr90"); zmin=float(xyz[0][:,2].min())
                if ground is not None and zmin-float(ground)<=.75:
                    top=xyz[0][xyz[0][:,2]>zmin+.3]
                    if len(top)>=2:
                        ss=(top[:,:2]-edge["a"])@edge["u"]
                        keep=(ss>=s0-.3)&(ss<=s1+.3)
                        vals=sorted((float(np.clip(s,s0,s1)),float(z)) for s,z in zip(ss[keep],top[keep,2]))
                        if len(vals)>=2 and vals[-1][0]-vals[0][0]>=.2:
                            eaves[ri][ei].append({"s0_m":round(vals[0][0],3),"s1_m":round(vals[-1][0],3),
                                "z0_dvr90":round(vals[0][1],3),"z1_dvr90":round(vals[-1][1],3)})
            for tri in tris:
                triangles.append([base+int(i) for i in tri]);kinds.append(typ);rattrs.append(ri);eattrs.append(ei)
                if typ=="RoofSurface":roof_count+=1
                else:wall_count+=1
            cur=0; rings_idx=[]
            for ring in xyz:
                rings_idx.append(list(range(base+cur,base+cur+len(ring))));cur+=len(ring)
            surfaces.append({"type":typ,"rings":rings_idx,"ring_index":ri,"edge_index":ei})
    if invalid:reason=f"{invalid} non-finite, degenerate, or near-vertical roof polygon(s)"
    if not triangles or not roof_count:reason=reason or "no valid roof triangles"
    if reason:
        return {"status":"inferred" if fit["success"] else "failed","conf":"inferred","reason":reason,
                "pointfit":fit,"roofer_attributes":attrs,"geometry_status":{"invalid_polygons":invalid}}
    edge_lookup={(e["ring"],e["edge"]):e for e in edge_defs}
    eave_by=[]
    for ri,ring in enumerate(rings):
        vals=[]
        for ei in range(len(ring)):
            ss=eaves[ri][ei]; edge=edge_lookup.get((ri,ei))
            if edge is None:
                vals.append(None)
                continue
            start=[s["z0_dvr90"] for s in ss if s["s0_m"]<=.3]
            end=[s["z1_dvr90"] for s in ss if s["s1_m"]>=edge["length"]-.3]
            vals.append(None if not start and not end else [min(start) if start else None,min(end) if end else None])
        eave_by.append(vals)
    return {"status":"reconstructed","conf":"observed","confidence_basis":"2019 DHM Punktsky point-cloud fit by Roofer; not survey control",
            "reason":None,"pointfit":fit,"roofer_attributes":attrs,
            "vertices_epsg25832_dvr90":vertices,"triangles":triangles,"triangle_surface_type":kinds,
            "triangle_ring_index":rattrs,"triangle_edge_index":eattrs,"surfaces":surfaces,
            "roof_triangle_count":roof_count,"wall_triangle_count":wall_count,"polygon_count":len(surfaces),
            "eave_by_ring_edge_dvr90":eave_by,"eave_segments_by_ring_edge":eaves}


def main() -> int:
    import argparse
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-roofer",action="store_true",help="use existing cropped cloud and Roofer CityJSONSeq")
    ap.add_argument("--replace-output",action="store_true",help="replace only model-v2/roofer-roofs.json")
    args=ap.parse_args()
    if OUTPUT.exists() and not args.replace_output:raise FileExistsError(f"Refusing to replace {OUTPUT}; pass --replace-output explicitly")
    doc=json.loads(INPUT.read_text());buildings=doc.get("buildings",[])
    if len(buildings)!=116:raise ValueError(f"expected 116 target buildings, got {len(buildings)}")
    byid={str(int(b["kk_fot_id"])):b for b in buildings}
    if len(byid)!=len(buildings):raise ValueError("duplicate KK fot_id")
    bbox=bounds_for(buildings)
    required=sorted(f"{n}_{e}" for n in range(math.floor(bbox[1]/1000),math.floor(bbox[3]/1000)+1)
                    for e in range(math.floor(bbox[0]/1000),math.floor(bbox[2]/1000)+1))
    if required!=[TILE]:raise ValueError(f"unexpected footprint tiles {required}")
    print(f"Nyhavn Roofer: {len(buildings)} buildings, tile {TILE}, bbox+margin {bbox}",flush=True)
    laz=get_laz();scan=get_scan(laz);print(f"Punktsky: {scan['count']:,} points, {scan['scan_date_min']}..{scan['scan_date_max']}",flush=True)
    rings={bid:[b["footprint_epsg25832"],*(b.get("footprint_holes_epsg25832") or [])] for bid,b in byid.items()}
    make_inputs(buildings,bbox,scan)
    if not args.skip_roofer:run_roofer()
    scan_year=int(scan["scan_date"][:4])
    output={}
    for bid,b in byid.items():
        output[bid]={"id":b["id"],"fot_id":int(b["kk_fot_id"]),"address":b.get("address"),"status":"not_returned",
            "conf":"inferred","reason":"Roofer returned no feature for this ID","source":{"provider":"DHM Punktsky",
            "tile":TILE,"scan_date":scan["scan_date"],"scan_date_range":[scan["scan_date_min"],scan["scan_date_max"]],
            "roofer":"1.1.0-beta.1","file":f"sources/lidar/PUNKTSKY_1km_{TILE}.laz"},
            "construction_year_register":b.get("year"),"footprint_rings_epsg25832":rings[bid],
            "eave_by_ring_edge_dvr90":[[None for _ in r] for r in rings[bid]],"eave_segments_by_ring_edge":[[[] for _ in r] for r in rings[bid]],"pointfit":{}}
    for path in sorted((WORK/"out").glob("*.jsonl")):
        transform=None
        for line in path.open():
            if not line.strip():continue
            ft=json.loads(line)
            if ft.get("type")=="CityJSON":transform=ft["transform"];continue
            transform=transform or ft.get("transform",{"scale":[1,1,1],"translate":[0,0,0]})
            scale=np.asarray(transform.get("scale",[1,1,1]),float);translate=np.asarray(transform.get("translate",[0,0,0]),float)
            verts=np.asarray(ft.get("vertices",[]),float).reshape(-1,3)*scale+translate
            for oid,obj in ft.get("CityObjects",{}).items():
                if obj.get("type")!="Building":continue
                bid=str(oid).split(":")[-1]
                if bid not in byid:continue
                if output[bid]["status"]!="not_returned":raise ValueError(f"duplicate Roofer feature {bid}")
                built=reconstruct_one(ft,oid,verts,byid[bid],rings[bid],scan_year)
                output[bid].update(built)
    expected=set(byid);actual=set(output)
    if expected!=actual:raise ValueError(f"ID inventory mismatch: missing={expected-actual}, extra={actual-expected}")
    statuses=Counter(x["status"] for x in output.values());meshes=[(k,v) for k,v in output.items() if "vertices_epsg25832_dvr90" in v]
    finite_vertices=tri_count=roof_tris=wall_tris=0;rmse=[];density=[];nodata=[];eave_n=0
    for bid,b in output.items():
        f=b.get("pointfit",{})
        if isinstance(f.get("rmse_lod22"),(int,float)) and math.isfinite(f["rmse_lod22"]):rmse.append(f["rmse_lod22"])
        if isinstance(f.get("point_density_pts_m2"),(int,float)):density.append(f["point_density_pts_m2"])
        if isinstance(f.get("nodata_fraction"),(int,float)):nodata.append(f["nodata_fraction"])
        if "vertices_epsg25832_dvr90" not in b:continue
        v=np.asarray(b["vertices_epsg25832_dvr90"],float);t=np.asarray(b["triangles"],int)
        if v.ndim!=2 or v.shape[1]!=3 or not np.isfinite(v).all():raise ValueError(f"bad vertices {bid}")
        if t.ndim!=2 or t.shape[1]!=3 or not len(t) or t.min()<0 or t.max()>=len(v):raise ValueError(f"bad triangles {bid}")
        if not (len(t)==len(b["triangle_surface_type"])==len(b["triangle_ring_index"])==len(b["triangle_edge_index"])):raise ValueError(f"semantic length mismatch {bid}")
        for face in b["surfaces"]:
            for ring in face["rings"]:
                p=v[np.asarray(ring,int)]
                if len(p)<3 or not np.isfinite(p).all() or np.linalg.norm(newell(p))<=1e-8:raise ValueError(f"invalid face polygon {bid}")
        finite_vertices+=len(v);tri_count+=len(t);roof_tris+=sum(x=="RoofSurface" for x in b["triangle_surface_type"]);wall_tris+=sum(x=="WallSurface" for x in b["triangle_surface_type"])
        eave_n+=sum(x is not None for r in b["eave_by_ring_edge_dvr90"] for x in r)
    if not meshes or roof_tris==0:raise ValueError("no valid Roofer roof meshes")
    qa={"building_ids_match":expected==actual,"expected_buildings":len(expected),"reported_buildings":len(actual),
        "status_counts":dict(statuses),"measured_mesh_buildings":len(meshes),"finite_vertices":finite_vertices,
        "valid_triangles":tri_count,"roof_triangles":roof_tris,"wall_triangles_including_gables":wall_tris,
        "non_ground_surface_polygons":sum(len(b["surfaces"]) for _,b in meshes),"edges_with_eave_evidence":eave_n,
        "rmse_lod22_count":len(rmse),"rmse_lod22_median":None if not rmse else float(np.median(rmse)),
        "rmse_lod22_p90":None if not rmse else float(np.percentile(rmse,90)),
        "point_density_min_median":None if not density else [float(min(density)),float(np.median(density))],
        "nodata_fraction_max_median":None if not nodata else [float(max(nodata)),float(np.median(nodata))],
        "quality_gate":{"minimum_point_density_pts_m2":MIN_DENSITY,"maximum_nodata_fraction":MAX_NODATA,
        "rmse_lod22":"reported and retained; not gated because its meaning is not established"}}
    result={"schema":"nyhavn-roofer-roofs/1","crs":{"horizontal":"EPSG:25832","vertical":"DVR90","coordinate_order":["E","N","H"]},
        "frame":doc.get("frame"),"confidence_basis":"Successful surfaces are fitted from observed 2019 DHM Punktsky returns; not survey control.",
        "eave_summary_note":"Per-edge eave endpoints summarize ground-to-wall faces; for gable ends and complex roofs, use the ring-edge mapped WallSurface triangles as the exact silhouette.",
        "source":{"provider":"DHM Punktsky","tile":TILE,"scan":scan,
        "roofer":"3dgi/roofer:v1.1.0-beta.1","source_file":f"sources/lidar/PUNKTSKY_1km_{TILE}.laz",
        "point_filter":"PDAL classification 2 (ground) + 6 (building); 25 m around footprint extent"},"qa":qa,"buildings":output}
    OUTPUT.parent.mkdir(parents=True,exist_ok=True);tmp=OUTPUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(safe(result),separators=(",",":"))+"\n")
    if OUTPUT.exists() and not args.replace_output:tmp.unlink();raise FileExistsError(f"refusing to replace {OUTPUT}")
    os.replace(tmp,OUTPUT)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size/1e6:.1f} MB)",flush=True);print(json.dumps(qa,indent=2),flush=True)
    return 0


if __name__=="__main__":
    try:sys.exit(main())
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}",file=sys.stderr,flush=True);sys.exit(1)
