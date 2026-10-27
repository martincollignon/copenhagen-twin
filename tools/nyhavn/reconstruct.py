#!/usr/bin/env python3
"""Reconstruct both Nyhavn waterfront rows from KK footprints, DHM and Skråfoto.

No drawings, facade openings or interiors are used. Roof surfaces are directly
meshed from DHM DSM samples; eave-edge heights are explicitly interpolated.
"""
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests", "rasterio", "pyproj", "shapely", "pillow", "scipy"]
# ///
from __future__ import annotations
import argparse, json, math, os, shutil, struct, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import requests
from PIL import Image
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.geometry.polygon import orient
from shapely.ops import triangulate
from shapely import constrained_delaunay_triangles

ROOT = Path(__file__).resolve().parents[2]
if not (ROOT / "tools/cph-geodata").exists():
    ROOT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
OUT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
SRC, KK, DHM, PHOTO = (OUT / "sources", OUT / "sources/kk", OUT / "sources/dhm", OUT / "sources/skraafoto")
MODEL, ANALYSIS, VALIDATION = OUT / "model", OUT / "analysis", OUT / "validation"
UA = "nyhavn-waterfront-reconstruction/1.0"
WFS = "https://wfs-kbhkort.kk.dk/k101/ows"
CORRIDOR_LONLAT = [(12.58615,55.68063),(12.58755,55.68042),(12.58900,55.68015),
                   (12.59055,55.67987),(12.59210,55.67958),(12.59365,55.67929),
                   (12.59520,55.67900),(12.59670,55.67873)]
CORRIDOR_BUFFER = 43.0

def dirs():
    for p in (KK, DHM / "cache", PHOTO, MODEL, ANALYSIS, VALIDATION, OUT / "scripts/vendor/cph_geodata"):
        p.mkdir(parents=True, exist_ok=True)

def corridor():
    tr = Transformer.from_crs(4326,25832,always_xy=True)
    return LineString([tr.transform(*p) for p in CORRIDOR_LONLAT])

def fetch_kk():
    dirs()
    line = corridor()
    # The WFS extent is intentionally narrow around the named canal.
    bbox = (725400,6175900,726200,6176600)
    raw = KK / "kk_bygning_wfs_bbox.geojson"
    if raw.exists():
        features = json.loads(raw.read_text()).get("features",[])
    else:
        features, start, page = [], 0, 1000
        while True:
            r = requests.get(WFS, params={
                "service":"WFS","version":"2.0.0","request":"GetFeature","typeNames":"k101:bygning",
                "outputFormat":"application/json","bbox":",".join(map(str,bbox))+",urn:ogc:def:crs:EPSG::25832",
                "count":page,**({"startIndex":start} if start else {})},
                headers={"User-Agent":UA},timeout=180)
            r.raise_for_status()
            batch = r.json().get("features",[])
            features.extend(batch)
            if len(batch) < page: break
            start += page
        raw.write_text(json.dumps({"type":"FeatureCollection","features":features},ensure_ascii=False))
    road_corridor = line.buffer(CORRIDOR_BUFFER,cap_style="flat",join_style="mitre")
    selected=[]
    for f in features:
        try:
            g=shape(f["geometry"]); address=str(f.get("properties",{}).get("adgangs_adresse") or "")
            if g.area > .2 and ("nyhavn" in address.lower() or g.intersects(road_corridor)):
                selected.append(f)
        except (KeyError,TypeError,ValueError): pass
    (KK/"kk_bygning_corridor.geojson").write_text(json.dumps({"type":"FeatureCollection","features":selected},ensure_ascii=False,indent=2))
    (ANALYSIS/"scope.json").write_text(json.dumps({
        "scope":"Nyhavn from Kongens Nytorv to harbour, both canal-facing rows",
        "selection":"KK adgangs_adresse containing Nyhavn, plus footprints intersecting the hand-positioned corridor buffer",
        "corridor_buffer_m":CORRIDOR_BUFFER,"corridor_lonlat":CORRIDOR_LONLAT,
        "source":"User-defined geographic scope; selector line is approximate and is not model geometry.",
        "selected_footprints":len(selected),"bbox_candidate_count":len(features)},indent=2))
    print(f"KK WFS: {len(features)} bbox candidates; selected {len(selected)} Nyhavn/corridor footprints")
    return selected

def vendor_dhm():
    v=OUT/"scripts/vendor/cph_geodata"
    original=ROOT/"tools/cph-geodata"
    for name in ("dhm.py","fetch.py","frame.py"):
        dst=v/name
        if not dst.exists():
            shutil.copy2(original/name,dst)
    if str(v) not in sys.path: sys.path.insert(0,str(v))
    return v

def fetch_dhm():
    if not os.environ.get("GSEARCH_TOKEN"):
        raise RuntimeError("GSEARCH_TOKEN is required in the process environment for DHM WCS access")
    import rasterio
    vendor_dhm()
    import fetch as cph_fetch
    import dhm as cph_dhm
    features=json.loads((KK/"kk_bygning_corridor.geojson").read_text()).get("features",[])
    geoms=[shape(f["geometry"]) for f in features]
    xmin=min(g.bounds[0] for g in geoms)-28; ymin=min(g.bounds[1] for g in geoms)-28
    xmax=max(g.bounds[2] for g in geoms)+28; ymax=max(g.bounds[3] for g in geoms)+28
    cph_fetch.RAW=DHM/"cache"; cph_fetch.UA=UA
    cph_dhm.RES=1.0
    cph_fetch.utm_bbox=lambda margin=0:(xmin,ymin,xmax,ymax)
    rasters=cph_dhm.load_rasters(os.environ["GSEARCH_TOKEN"])
    for kind,r in rasters.items():
        path=DHM/f"dhm_{kind}_nyhavn.tif"
        if not path.exists():
            with rasterio.open(path,"w",driver="GTiff",height=r.arr.shape[0],width=r.arr.shape[1],count=1,
                dtype="float32",crs="EPSG:25832",transform=r.t,nodata=r.nodata,compress="deflate",tiled=True) as ds:
                ds.write(r.arr,1)
    print(f"DHM WCS: DSM and DTM cached ({rasters['dsm'].arr.shape[1]} x {rasters['dsm'].arr.shape[0]} pixels)")

def fetch_photos():
    if not os.environ.get("SKRAAFOTO_STAC_TOKEN"):
        raise RuntimeError("SKRAAFOTO_STAC_TOKEN is required in the process environment")
    cams=PHOTO/"cameras.json"
    script=OUT/"scripts/skraafoto.py"
    if not script.exists():
        script.parent.mkdir(parents=True,exist_ok=True)
        source=ROOT/".agents/skills/building-case-to-3d/scripts/skraafoto.py"
        if not source.exists():raise FileNotFoundError(f"calibrated Skråfoto helper missing: {source}")
        shutil.copy2(source,script)
    if cams.exists() and json.loads(cams.read_text()):
        print("Skråfoto: existing calibrated 2025 crops found")
        return
    subprocess.run(["uv","run","--script",str(script),"fetch","--lon","12.5915","--lat","55.6801",
        "--radius","400","--collections","skraafotos2025","--directions","north,south,east,west,nadir",
        "--per-direction","3","--pad","35","--max-px","3600","--z","5","--out",str(PHOTO)],
        check=True,cwd=OUT,env=os.environ.copy())

def run_fetch():
    dirs()
    if not fetch_kk(): raise RuntimeError("No footprints returned for the Nyhavn scope")
    fetch_dhm()
    fetch_photos()

def vals_in(raster, geom):
    from rasterio.features import geometry_mask
    from rasterio.windows import from_bounds
    from affine import Affine
    if geom.is_empty:return np.array([])
    w=from_bounds(*geom.bounds,transform=raster.t).round_offsets().round_lengths()
    r0,c0=max(0,int(w.row_off)),max(0,int(w.col_off))
    r1=min(raster.arr.shape[0],int(w.row_off+w.height)+1); c1=min(raster.arr.shape[1],int(w.col_off+w.width)+1)
    if r1<=r0 or c1<=c0:return np.array([])
    a=raster.arr[r0:r1,c0:c1]; t=raster.t*Affine.translation(c0,r0)
    m=geometry_mask([geom],out_shape=a.shape,transform=t,invert=True)
    v=a[m]; v=v[np.isfinite(v)]
    if raster.nodata is not None:v=v[v!=raster.nodata]
    return v[v>-100]

def edge_height(raster,poly,e,n,fallback):
    inner=poly.buffer(-.35)
    if inner.is_empty:inner=poly
    v=vals_in(raster,Point(e,n).buffer(2.5).intersection(inner))
    if v.size:
        med=float(np.median(v)); v=v[np.abs(v-med)<=3.0]
    return float(np.median(v)) if v.size else float(fallback)

def roof_triangles(raster,poly,edge_fallback):
    from rasterio.windows import from_bounds
    w=from_bounds(*poly.bounds,transform=raster.t).round_offsets().round_lengths()
    r0,c0=max(0,int(w.row_off)),max(0,int(w.col_off))
    r1=min(raster.arr.shape[0],int(w.row_off+w.height)+1); c1=min(raster.arr.shape[1],int(w.col_off+w.width)+1)
    cells={}
    inner=poly.buffer(-.75)
    if inner.is_empty:inner=poly.buffer(-.25)
    if inner.is_empty:inner=poly
    for r in range(r0,r1):
        for c in range(c0,c1):
            e,n=raster.t*(c+.5,r+.5)
            if not inner.covers(Point(e,n)):continue
            h=float(raster.arr[r,c])
            if math.isfinite(h) and (raster.nodata is None or h!=raster.nodata):cells[(r,c)]=(e,n,h)
    core=[]
    for (r,c),a in cells.items():
        b=cells.get((r,c+1)); d=cells.get((r+1,c)); e=cells.get((r+1,c+1))
        if b and d and e:
            quad=Polygon([(a[0],a[1]),(b[0],b[1]),(e[0],e[1]),(d[0],d[1])])
            if inner.covers(quad):
                # EPSG map plane CCW yields an upward roof normal.
                core.extend([(a,e,b),(a,d,e)])
    from shapely.ops import unary_union
    known=unary_union([Polygon([(v[0],v[1]) for v in tri]) for tri in core]) if core else Polygon()
    core_heights={(round(v[0],3),round(v[1],3)):float(v[2]) for tri in core for v in tri}
    remainder=poly.difference(known)
    skirt=[]
    if not remainder.is_empty:
        result=constrained_delaunay_triangles(remainder)
        triangles=list(result.geoms) if hasattr(result,"geoms") else [result]
        for tri in triangles:
            if tri.is_empty or tri.area<=1e-9:continue
            coords=[c[:2] for c in list(orient(tri,sign=1.0).exterior.coords)[:-1]]
            verts=[]
            for e,n in coords:
                h=core_heights.get((round(e,3),round(n,3)))
                if h is None:h=edge_height(raster,poly,e,n,edge_fallback)
                verts.append((float(e),float(n),float(h)))
            if len(verts)==3:skirt.append(tuple(verts))
    return core,skirt

def cameras_load():
    p=PHOTO/"cameras.json"
    if not p.exists():return []
    cams=json.loads(p.read_text())
    for c in cams:
        c["effective_gsd_m_px"]=round(float(c.get("gsd") or 0)*float(c.get("crop",{}).get("overview_factor",1)),3)
    return cams

def sample_tones(cameras):
    # Front-facing calibrated camera samples only. Each local patch median rejects
    # isolated pixels; dark pixels are discarded to reduce windows and cast shadow.
    vend=OUT/"scripts"
    if str(vend) not in sys.path:sys.path.insert(0,str(vend))
    from skraafoto import world_to_pixel
    loaded=[]
    for c in cameras:
        try: loaded.append((c,Image.open(PHOTO/c["file"]).convert("RGB")))
        except OSError:pass
    def sample(e0,n0,e1,n1,ground,top,outward):
        dx=e1-e0;dy=n1-n0; ln=max(math.hypot(dx,dy),.01); n=np.array(outward,dtype=float)
        points=[(e0+dx*t,n0+dy*t,ground+(top-ground)*zf) for t in (.2,.4,.6,.8) for zf in (.35,.55,.72)]
        samples=[]; used=[]
        for cam,img in loaded:
            p=cam["pers"]["pers:perspective_center"]; to=np.array([p[0]-(e0+e1)/2,p[1]-(n0+n1)/2],dtype=float)
            length=np.linalg.norm(to)
            if length<1 or float(np.dot(n,to/length))<.12:continue
            factor=float(cam["crop"].get("overview_factor",1)); crop=cam["crop"]
            for e,north,z in points:
                try: col,row=world_to_pixel(cam["pers"],e,north,z)
                except (ValueError,KeyError):continue
                u=(col-crop["x0"])/factor;v=(row-crop["y0"])/factor
                if not (3<=u<img.width-3 and 3<=v<img.height-3):continue
                patch=np.asarray(img.crop((int(u)-2,int(v)-2,int(u)+3,int(v)+3)),dtype=np.uint8).reshape(-1,3)
                lum=patch.mean(axis=1)
                patch=patch[lum>54]
                if not len(patch):continue
                rgb=np.median(patch,axis=0)/255
                samples.append(rgb);used.append(cam["view_id"])
        if not samples:return [0.63,.61,.57],[],0
        return np.median(np.asarray(samples),axis=0).round(4).tolist(),sorted(set(used)),len(samples)
    return sample

def local(e,n,h,origin):return [e-origin[0],h-origin[2],-(n-origin[1])]

def collect(fc,dsm,dtm,origin,cameras):
    tone_sampler=sample_tones(cameras); buildings=[]
    for f in fc.get("features",[]):
        props=f.get("properties",{})
        geom=shape(f["geometry"])
        parts=list(geom.geoms) if geom.geom_type=="MultiPolygon" else [geom]
        for pi,raw_poly in enumerate(parts):
            if raw_poly.area<.2:continue
            poly=orient(raw_poly,sign=1.0)
            rv=vals_in(dsm,poly);gv=vals_in(dtm,poly.buffer(1.5).difference(poly))
            if not gv.size:gv=vals_in(dtm,poly)
            if rv.size<1:continue
            med=float(np.median(rv)); rr=rv[np.abs(rv-med)<max(2.5,float(np.std(rv))*2.5)]
            if rr.size<4:rr=rv
            ground=float(np.median(gv)) if gv.size else float(np.nanmin(rv))
            fallback=float(np.percentile(rr,60))
            rings=[[(c[0],c[1]) for c in list(poly.exterior.coords)[:-1]]]+[
                [(c[0],c[1]) for c in list(r.coords)[:-1]] for r in poly.interiors]
            edge_tops=[[edge_height(dsm,poly,e,n,fallback) for e,n in ring] for ring in rings]
            roofs,skirt=roof_triangles(dsm,poly,fallback)
            if not roofs and not skirt:
                for t in triangulate(poly):
                    if poly.covers(t):
                        coords=[c[:2] for c in list(orient(t,sign=1.0).exterior.coords)[:-1]]
                        skirt.append(tuple((float(e),float(n),edge_height(dsm,poly,e,n,fallback)) for e,n in coords))
            tones=[]
            wall_rings=[]
            for ri,ring in enumerate(rings):
                tops=edge_tops[ri]
                ring_tones=[]
                for i,(e0,n0) in enumerate(ring):
                    e1,n1=ring[(i+1)%len(ring)];dx=e1-e0;dy=n1-n0;ln=max(math.hypot(dx,dy),.01)
                    # Outer rings are CCW; courtyard rings are CW, so flip the normal.
                    sign=1 if ri==0 else -1
                    outward=[sign*dy/ln,-sign*dx/ln]
                    if ri==0:
                        color,views,count=tone_sampler(e0,n0,e1,n1,ground+.8,
                            max(ground+1,(tops[i]+tops[(i+1)%len(ring)])/2-.7),outward)
                    else:color,views,count=[.63,.61,.57],[],0
                    row={"edge":i,"tone_srgb":color,"src":["skraafoto:2025:calibrated-projection"] if count else [],
                         "views":views,"sample_count":count,"conf":"observed" if count else "inferred"}
                    ring_tones.append(row)
                    if ri==0:tones.append(row)
                wall_rings.append({"kind":"exterior" if ri==0 else "courtyard",
                    "vertices_epsg25832":[[round(e,3),round(n,3)] for e,n in ring],
                    "eave_boundary_dvr90":[round(h,3) for h in tops],"facade_tones":ring_tones})
            bid=str(props.get("fot_id") or f.get("id") or len(buildings)+1)
            if pi:bid+=f"-{pi}"
            buildings.append({
                "id":f"kk:{bid}","kk_fot_id":props.get("fot_id"),"bbr_uuid":props.get("bygningid"),
                "address":props.get("adgangs_adresse"),"year":props.get("opfoerelselsaar"),
                "use_code":props.get("bygningensanvendelsekode"),"storeys_register":props.get("antaletager"),
                "footprint_epsg25832":[[round(e,3),round(n,3)] for e,n in rings[0]],
                "footprint_holes_epsg25832":[[[round(e,3),round(n,3)] for e,n in r] for r in rings[1:]],
                "footprint_local_xz":[[round(e-origin[0],3),round(-(n-origin[1]),3)] for e,n in rings[0]],
                "wall_rings":wall_rings,"ground_dvr90":round(ground,3),
                "eave_boundary_dvr90":[round(h,3) for h in edge_tops[0]],
                "roof_surface":{"method":"DHM DSM interior raster-cell mesh plus constrained interpolated boundary skirt",
                    "sample_count":int(rv.size),
                    "height_p05_dvr90":round(float(np.percentile(rr,5)),3),"height_p95_dvr90":round(float(np.percentile(rr,95)),3),
                    "observed_triangle_count":len(roofs),"edge_skirt_triangle_count":len(skirt),
                    "triangles_observed_epsg25832_dvr90":[[[float(q[0]),float(q[1]),float(q[2])] for q in t] for t in roofs],
                    "triangles_edge_inferred_epsg25832_dvr90":[[[float(q[0]),float(q[1]),float(q[2])] for q in t] for t in skirt],
                    "src":["dhm:overflade:1.0m-output"],"conf":"observed-with-inferred-edge-skirt"},
                "facade_tones":tones,
                "src":[f"kk:k101:bygning:{props.get('fot_id')}","dhm:terraen:1.0m-output","dhm:overflade:1.0m-output"],
                "conf":{"footprint":"observed","roof_surface":"observed","terrain":"observed",
                        "eave_boundary":"inferred-from-DHM-edge-interpolation","facade_tone":"observed-or-inferred-per-edge",
                        "openings":"not-modelled","interiors":"not-modelled"},
                })
    return buildings

class GLB:
    def __init__(self):self.b=bytearray();self.views=[];self.accessors=[];self.meshes=[];self.nodes=[];self.materials=[];self.mat={}
    def append(self,data,target):
        while len(self.b)%4:self.b.append(0)
        o=len(self.b);self.b.extend(data);self.views.append({"buffer":0,"byteOffset":o,"byteLength":len(data),"target":target});return len(self.views)-1
    def add(self,name,tris,rgb,src,conf):
        if not tris:return
        flat=[p for t in tris for p in t]
        v=np.asarray(flat,dtype="<f4");ix=np.arange(len(v),dtype="<u4")
        norms=[]
        for t in tris:
            a,b,c=[np.asarray(p,dtype=float) for p in t]
            no=np.cross(b-a,c-a);length=np.linalg.norm(no)
            no=no/length if length>1e-12 else np.array([0.,1.,0.])
            norms.extend([no,no,no])
        nv=np.asarray(norms,dtype="<f4")
        pv=self.append(v.tobytes(),34962);nvw=self.append(nv.tobytes(),34962);iv=self.append(ix.tobytes(),34963)
        self.accessors += [{"bufferView":pv,"componentType":5126,"count":len(v),"type":"VEC3",
            "min":v.reshape(-1,3).min(axis=0).astype(float).tolist(),"max":v.reshape(-1,3).max(axis=0).astype(float).tolist()},
            {"bufferView":nvw,"componentType":5126,"count":len(nv),"type":"VEC3"},
            {"bufferView":iv,"componentType":5125,"count":len(ix),"type":"SCALAR"}]
        # glTF baseColorFactor values are linear-light; facade_tones store sRGB.
        key=tuple(round(float(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4),5) for c in rgb)
        if key not in self.mat:
            self.mat[key]=len(self.materials);self.materials.append({"name":name,"pbrMetallicRoughness":{
                "baseColorFactor":[*key,1],"metallicFactor":0,"roughnessFactor":.88}})
        mi=len(self.meshes);self.meshes.append({"name":name,"primitives":[{"attributes":{"POSITION":len(self.accessors)-3,"NORMAL":len(self.accessors)-2},
            "indices":len(self.accessors)-1,"material":self.mat[key],"mode":4}]})
        parts=name.split("/",1)
        self.nodes.append({"name":name,"mesh":mi,"extras":{"src":src,"conf":conf,
            "building_id":parts[0],"element":parts[1] if len(parts)>1 else name}})
    def save(self,path):
        doc={"asset":{"version":"2.0","generator":"Nyhavn DHM/Skraafoto reconstruction"},"scene":0,
            "scenes":[{"nodes":list(range(len(self.nodes)))}],"nodes":self.nodes,"meshes":self.meshes,
            "materials":self.materials,"accessors":self.accessors,"bufferViews":self.views,"buffers":[{"byteLength":len(self.b)}]}
        js=json.dumps(doc,separators=(",",":")).encode()
        while len(js)%4:js+=b" "
        while len(self.b)%4:self.b.append(0)
        total=12+8+len(js)+8+len(self.b)
        with open(path,"wb") as f:
            f.write(struct.pack("<4sII",b"glTF",2,total));f.write(struct.pack("<I4s",len(js),b"JSON"));f.write(js)
            f.write(struct.pack("<I4s",len(self.b),b"BIN\x00"));f.write(self.b)

def export_cityjson(buildings,path,origin):
    vertices=[];objects={};scale=.001
    def addv(e,n,h):
        idx=len(vertices)
        vertices.append([int(round((e-origin[0])/scale)),int(round((n-origin[1])/scale)),int(round((h-origin[2])/scale))])
        return idx
    for b in buildings:
        boundaries=[];surfaces=[];ground=b["ground_dvr90"];ground_rings=[]
        for ring in b["wall_rings"]:
            xy=ring["vertices_epsg25832"];tops=ring["eave_boundary_dvr90"]
            bottom=[addv(e,n,ground) for e,n in xy]
            ground_rings.append(list(reversed(bottom)))
            for i,(e,n) in enumerate(xy):
                j=(i+1)%len(xy);t0=addv(e,n,tops[i]);t1=addv(xy[j][0],xy[j][1],tops[j])
                boundaries.append([[bottom[i],bottom[j],t1,t0]])
                surfaces.append({"type":"WallSurface"})
        boundaries.append(ground_rings);surfaces.append({"type":"GroundSurface"})
        for field in ("triangles_observed_epsg25832_dvr90","triangles_edge_inferred_epsg25832_dvr90"):
            for tri in b["roof_surface"][field]:
                ids=[addv(e,n,h) for e,n,h in tri]
                boundaries.append([ids]);surfaces.append({"type":"RoofSurface"})
        objects[b["id"]]={"type":"Building","attributes":{"kk_fot_id":b["kk_fot_id"],"address":b["address"],
            "source":b["src"],"confidence":b["conf"]},"geometry":[{"type":"MultiSurface","lod":"2.2",
            "boundaries":boundaries,"semantics":{"surfaces":surfaces,"values":list(range(len(surfaces)))}}]}
    city={"type":"CityJSON","version":"2.0","transform":{"scale":[scale,scale,scale],"translate":list(origin)},
        "metadata":{"referenceSystem":"https://www.opengis.net/def/crs/EPSG/0/25832",
            "title":"Nyhavn waterfront shells; horizontal EPSG:25832 and vertical DVR90"},
        "CityObjects":objects,"vertices":vertices}
    path.write_text(json.dumps(city,separators=(",",":")))

def run_build():
    dirs()
    import rasterio
    vendor_dhm()
    import dhm as cph_dhm
    rasters={}
    for k in ("dsm","dtm"):
        with rasterio.open(DHM/f"dhm_{k}_nyhavn.tif") as ds:
            rasters[k]=cph_dhm.Raster(ds.read(1),ds.transform,ds.nodata)
    fc=json.loads((KK/"kk_bygning_corridor.geojson").read_text())
    line=corridor()
    xy=line.interpolate(.5,normalized=True).coords[0]
    zvals=rasters["dtm"].arr[np.isfinite(rasters["dtm"].arr)]
    origin=(float(xy[0]),float(xy[1]),float(np.median(zvals)))
    cameras=cameras_load()
    buildings=collect(fc,rasters["dsm"],rasters["dtm"],origin,cameras)
    if not buildings:
        raise RuntimeError("No selected footprints had enough valid DHM DSM samples")

    model={"version":"nyhavn-waterfront/1","generated":datetime.now(timezone.utc).isoformat(),
        "frame":{"epsg":25832,"vertical":"DVR90","origin":list(origin),
                 "axes_glb":"x=east, y=up, z=south","axes_cityjson":"x=east, y=north, z=up"},
        "scope":{"name":"Nyhavn, Kongens Nytorv to harbour, both canal rows",
                 "corridor_buffer_m":CORRIDOR_BUFFER,"line_epsg25832":[[float(x),float(y)] for x,y in line.coords]},
        "viewer_context":{"canal_surface":{"method":"17 m-wide ribbon along the hand-positioned scope line",
          "half_width_m":8.5,"level_dvr90":0.0,"src":["skraafoto:2025:visual-context"],
          "conf":"inferred","included_in_exports":False}},
        "methods":{"footprint":"Copenhagen Municipality KK k101:bygning WFS",
          "ground":"DHM Terræn product; 1.0 m WCS output grid",
          "roof":"DHM Overflade product; 1.0 m WCS output grid",
          "eave":"boundary heights interpolated from adjacent interior DSM samples; not a direct measured eave",
          "facade_tones":"approximate front-facing pixel patches from calibrated 2025 Skråfoto crops; visibility, illumination and occlusion are not calibrated",
          "openings":"not modelled; no drawings or window-level assumptions","interiors":False},
        "cameras":[{k:c[k] for k in ("view_id","collection","direction","datetime","gsd",
            "effective_gsd_m_px","file","image_size","crop","pers")} for c in cameras],
        "buildings":buildings}
    (MODEL/"building.json").write_text(json.dumps(model,ensure_ascii=False,separators=(",",":")))

    glb=GLB()
    roof_count=0
    ground_count=0
    for b in model["buildings"]:
        ground=b["ground_dvr90"]
        for ring in b["wall_rings"]:
            xy=ring["vertices_epsg25832"]
            tops=ring["eave_boundary_dvr90"]
            for i,(e0,n0) in enumerate(xy):
                j=(i+1)%len(xy)
                e1,n1=xy[j]
                p0=local(e0,n0,ground,origin);p1=local(e1,n1,ground,origin)
                q0=local(e0,n0,tops[i],origin);q1=local(e1,n1,tops[j],origin)
                tone=ring["facade_tones"][i]
                glb.add(f"{b['id']}/WallSurface/{ring['kind']}/{i:02d}",
                    [(p0,p1,q1),(p0,q1,q0)],tone["tone_srgb"],
                    b["src"]+tone["src"],"inferred")
        footprint=Polygon(b["footprint_epsg25832"],b["footprint_holes_epsg25832"])
        tess=constrained_delaunay_triangles(footprint)
        faces=list(tess.geoms) if hasattr(tess,"geoms") else [tess]
        ground_tris=[]
        for face in faces:
            if face.is_empty or face.area<=1e-9:continue
            coords=[c[:2] for c in list(orient(face,sign=-1.0).exterior.coords)[:-1]]
            ground_tris.append([local(e,n,ground,origin) for e,n in coords])
        ground_count+=len(ground_tris)
        glb.add(f"{b['id']}/GroundSurface",ground_tris,[.68,.66,.61],
                ["dhm:terraen:1.0m-output"],"inferred")
        for field,conf,color in (
            ("triangles_observed_epsg25832_dvr90","observed",[.39,.38,.35]),
            ("triangles_edge_inferred_epsg25832_dvr90","inferred",[.41,.40,.37])):
            tris=[[local(e,n,h,origin) for e,n,h in tri]
                  for tri in b["roof_surface"][field]]
            roof_count+=len(tris)
            glb.add(f"{b['id']}/RoofSurface/{conf}",tris,color,
                    ["dhm:overflade:1.0m-output"],conf)
    glb.save(MODEL/"building.glb")
    export_cityjson(model["buildings"],MODEL/"building.city.json",origin)
    (MODEL/"building.mesh.json").write_text(json.dumps({
        "frame":model["frame"],"source":"building.json",
        "note":"Building geometry and provenance in building.json drive both exports."},separators=(",",":")))

    from shapely.ops import unary_union
    model_polys=[Polygon(b["footprint_epsg25832"],b["footprint_holes_epsg25832"])
                 for b in model["buildings"]]
    source_polys=[shape(f["geometry"]) for f in fc["features"]]
    model_union=unary_union(model_polys)
    source_union=unary_union(source_polys)
    iou=model_union.intersection(source_union).area/model_union.union(source_union).area
    footprint_area=sum(p.area for p in model_polys)

    roundtrip=[];finite_values=[];roof_cover=[]
    for b,poly in zip(model["buildings"],model_polys):
        for e,n in b["footprint_epsg25832"]:
            x=e-origin[0];z=-(n-origin[1])
            roundtrip.append((x+origin[0]-e)**2+(-z+origin[1]-n)**2)
        finite_values.extend([b["ground_dvr90"],*b["eave_boundary_dvr90"]])
        roof_shapes=[]
        for field in ("triangles_observed_epsg25832_dvr90","triangles_edge_inferred_epsg25832_dvr90"):
            for tri in b["roof_surface"][field]:
                finite_values.extend(v for vertex in tri for v in vertex)
                roof_shapes.append(Polygon([(v[0],v[1]) for v in tri]))
        roof_union=unary_union(roof_shapes) if roof_shapes else Polygon()
        roof_cover.append(roof_union.intersection(poly).area/poly.area if poly.area else 0)

    raw=(MODEL/"building.glb").read_bytes()
    if len(raw)<20 or raw[:4]!=b"glTF" or struct.unpack("<I",raw[4:8])[0]!=2:
        raise ValueError("GLB header or version validation failed")
    if struct.unpack("<I",raw[8:12])[0]!=len(raw):
        raise ValueError("GLB declared file length does not match")
    json_len=struct.unpack("<I",raw[12:16])[0]
    if raw[16:20]!=b"JSON":
        raise ValueError("GLB JSON chunk is missing")
    gltf=json.loads(raw[20:20+json_len])
    binary_len=struct.unpack("<I",raw[20+json_len:24+json_len])[0]
    binary_start=28+json_len
    for view in gltf.get("bufferViews",[]):
        if view.get("byteOffset",0)+view["byteLength"]>binary_len:
            raise ValueError("GLB bufferView exceeds binary chunk")
    city=json.loads((MODEL/"building.city.json").read_text())
    if len(city["CityObjects"])!=len(model["buildings"]):
        raise ValueError("CityJSON object count mismatch")
    for obj in city["CityObjects"].values():
        for geom in obj["geometry"]:
            if len(geom["semantics"]["surfaces"])!=len(geom["boundaries"]):
                raise ValueError("CityJSON semantics/boundary count mismatch")
            for surface in geom["boundaries"]:
                for ring in surface:
                    if any(i<0 or i>=len(city["vertices"]) for i in ring):
                        raise ValueError("CityJSON vertex index is out of range")
    finite=bool(np.isfinite(np.asarray(finite_values,dtype=float)).all())
    rms=math.sqrt(float(np.mean(roundtrip))) if roundtrip else 0.0
    metrics={"building_count":len(model["buildings"]),"footprint_area_m2":round(footprint_area,2),
        "roof_dsm_sample_count":sum(b["roof_surface"]["sample_count"] for b in model["buildings"]),
        "roof_mesh_triangle_count":roof_count,
        "ground_mesh_triangle_count":ground_count,
        "storeys_register_count":sum(bool(b["storeys_register"]) for b in model["buildings"]),
        "finite_geometry":finite,"glb_structural_load":"passed" if gltf.get("meshes") else "failed",
        "glb_mesh_count":len(gltf.get("meshes",[])),"glb_binary_payload_bytes":binary_len,
        "cityjson_objects":len(city["CityObjects"]),
        "cityjson_integer_vertices":all(all(isinstance(c,int) for c in v) for v in city["vertices"]),
        "georeference_roundtrip_rms_m":round(rms,6),
        "footprint_iou_vs_selected_kk":round(float(iou),6),
        "roof_xy_coverage_mean":round(float(np.mean(roof_cover)),5),
        "roof_xy_coverage_min":round(float(np.min(roof_cover)),5),
        "height_validation":"Roof vertices use DHM DSM pixels. Boundary eave heights are interpolated; no direct measured-eave claim is made.",
        "limitations":["KK footprints define mapped outlines, not measured facade planes.",
          "DHM DSM may include trees, rooftop plant and temporary objects.",
          "Boundary interpolation is uncertain by approximately one 1 m output-grid cell.",
          "Facade samples at the effective GSD recorded in building.json can include glazing, shade and occlusion.",
          "No facade openings, decorative details, interiors or hidden elevations are modelled."]}
    (VALIDATION/"metrics.json").write_text(json.dumps(metrics,indent=2))

    script_copy=OUT/"scripts/reconstruct.py"
    if Path(__file__).resolve()!=script_copy.resolve():
        shutil.copy2(Path(__file__),script_copy)
    skill=ROOT/".agents/skills/building-case-to-3d/scripts/skraafoto.py"
    if skill.exists() and skill.resolve()!=(OUT/"scripts/skraafoto.py").resolve():
        shutil.copy2(skill,OUT/"scripts/skraafoto.py")
    print(f"Built {len(model['buildings'])} shells; {roof_count} roof triangles; {footprint_area:.1f} m²")
    print(f"Geometry checks: IoU {iou:.5f}; GLB meshes {len(gltf.get('meshes',[]))}; CityJSON objects {len(city['CityObjects'])}")
def main():
    p=argparse.ArgumentParser();p.add_argument("command",choices=("fetch","build","all"));a=p.parse_args()
    if a.command in ("fetch","all"):run_fetch()
    if a.command in ("build","all"):run_build()
if __name__=="__main__":main()
