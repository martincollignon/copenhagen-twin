#!/usr/bin/env python3
"""Build the durable Nyhavn v2 from Roofer, facade, DHM, OSM and Skråfoto evidence.

The v1 model remains untouched. Geometry uses EPSG:25832/DVR90 and exports to
local east-up-south metres. Photo textures are appearance evidence, not measured
window or door geometry.
"""
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "shapely", "pyproj"]
# ///
from __future__ import annotations
import argparse, hashlib, json, math, os, re, shutil, struct, xml.etree.ElementTree as ET
from array import array
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageFilter
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box
from shapely import constrained_delaunay_triangles
from shapely.ops import triangulate, unary_union

OUT = Path(os.environ.get("NYHAVN_OUT", Path.home() / ".local/share/building-case-3d/nyhavn")).expanduser()
V1, V2 = OUT / "model", OUT / "model-v2"
FACADE, SOURCES = OUT / "facade-v2", OUT / "sources"
DETAIL = OUT / "detail-v3"
VIEWER, VALIDATION = OUT / "viewer-v2", OUT / "validation-v3"
FRONTAGE_LABELS = {
    "kk:1064714861": "Nyhavn 9",
    "kk:1202806702": "Nyhavn 11",
    "kk:1111146131": "Nyhavn 13",
    "kk:1064715124": "Nyhavn 15",
    "kk:1088186424": "Nyhavn 17",
}

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def strlist(value):
    if value is None: return []
    if isinstance(value, (str, int, float)): return [str(value)]
    if isinstance(value, dict): return [json.dumps(value, ensure_ascii=False, sort_keys=True)]
    return [str(x) for x in value if x is not None]

def local(p, origin):
    e, n, h = map(float, p[:3])
    return [e-origin[0], h-origin[2], -(n-origin[1])]

def linear_srgb_rgba(color, alpha=1.0):
    s=np.clip(np.asarray(color[:3],dtype=np.float64),0.0,1.0)
    rgb=np.where(s<=0.04045,s/12.92,((s+0.055)/1.055)**2.4)
    return [float(x) for x in rgb]+[float(alpha)]

def procedural_roof_tiles(base_srgb=(.58,.24,.14)):
    """One metre-scaled clay tile cell with quiet relief and a staggered course seam."""
    from PIL import ImageDraw
    base=np.clip(np.asarray(base_srgb[:3],dtype=float),.08,.92)*255
    image=Image.new("RGB",(256,256),(72,49,42));draw=ImageDraw.Draw(image)
    color=tuple(int(np.clip(v,0,255)) for v in base)
    lighter=tuple(int(np.clip(v+9,0,255)) for v in base)
    draw.rounded_rectangle((3,3,253,253),radius=34,fill=color)
    draw.arc((10,7,246,230),180,360,fill=lighter,width=3)
    draw.line((10,245,246,245),fill=tuple(int(v*.62) for v in color),width=4)
    draw.line((18,250,238,250),fill=tuple(int(v*.83) for v in color),width=1)
    return image

def procedural_paving():
    """One metre-scaled inferred stone slab cell with restrained surface variation."""
    from PIL import ImageDraw
    grid=np.indices((256,256),dtype=float)
    variation=1.3*np.sin(grid[0]/21)*np.cos(grid[1]/17)
    base=np.clip(132+variation,0,255).astype(np.uint8)
    pixels=np.stack([base,np.clip(base.astype(int)-2,0,255),np.clip(base.astype(int)-7,0,255)],axis=2).astype(np.uint8)
    image=Image.fromarray(pixels,"RGB");draw=ImageDraw.Draw(image)
    draw.rectangle((0,0,255,255),outline=(113,109,102),width=5)
    return image

def procedural_brick(base_srgb):
    """Low-contrast red11 running-bond coursing; repeat spans 2 bricks x 2 courses."""
    from PIL import ImageDraw
    base=np.clip(np.asarray(base_srgb[:3],dtype=float),.08,.92)*255
    image=Image.new("RGB",(512,256),tuple(int(v*.78) for v in base));draw=ImageDraw.Draw(image)
    brick_w=256;course_h=128
    for row in range(2):
        offset=brick_w//2 if row%2 else 0
        for col in range(-1,4):
            x=col*brick_w-offset;seed=((row*5+col*3)%7)-3
            color=tuple(int(np.clip(v+seed,0,255)) for v in base)
            draw.rectangle((x+3,row*course_h+3,x+brick_w-3,(row+1)*course_h-3),fill=color)
            draw.line((x+8,row*course_h+7,x+brick_w-8,row*course_h+7),
                      fill=tuple(int(np.clip(v+3,0,255)) for v in color),width=2)
            draw.line((x+7,(row+1)*course_h-7,x+brick_w-7,(row+1)*course_h-7),
                      fill=tuple(int(v*.92) for v in color),width=2)
    return image

def procedural_water():
    """Low-contrast repeating ripple appearance without nadir boat ghosts."""
    x,y=np.meshgrid(np.linspace(0,2*math.pi,512,endpoint=False),np.linspace(0,2*math.pi,256,endpoint=False))
    wave=2.2*np.sin(y*7+1.2*np.sin(x*1.4))+1.1*np.sin(y*13+x*.28)
    base=np.zeros((256,512,3),dtype=np.uint8)
    for channel,value in enumerate((35,76,83)):
        base[:,:,channel]=np.clip(value+wave*(1.0 if channel else .7),0,255).astype(np.uint8)
    return Image.fromarray(base,"RGB")

def metric_uv(triangles, tile_size, uv_origin=(0.0,0.0)):
    """Project absolute EPSG east/north coordinates into repeating metric UVs."""
    width,height=map(float,tile_size)
    return [[[(float(p[0])-float(uv_origin[0]))/width,(float(p[1])-float(uv_origin[1]))/height] for p in tri] for tri in triangles]

def roof_tile_uv(tri, frontage, footprint, tile_size):
    """Use frontage u and slope-corrected inward roof distance for clay tiles."""
    width,height=map(float,tile_size)
    if frontage and frontage.get("coordinates"):
        start=frontage["coordinates"]["start"];end=frontage["coordinates"]["end"]
        dx=float(end[0])-float(start[0]);dy=float(end[1])-float(start[1]);length=math.hypot(dx,dy) or 1
        ux,uy=dx/length,dy/length
        normal=frontage.get("normal_xy") or frontage.get("normal") or [-uy,ux]
        nl=math.hypot(float(normal[0]),float(normal[1])) or 1
        ix,iy=-float(normal[0])/nl,-float(normal[1])/nl
        if footprint is not None:
            mid=((float(start[0])+float(end[0]))/2,(float(start[1])+float(end[1]))/2)
            inward=(float(footprint.centroid.x)-mid[0])*ix+(float(footprint.centroid.y)-mid[1])*iy
            if inward<0:ix,iy=-ix,-iy
        coords=[]
        for p in tri:
            rx=float(p[0])-float(start[0]);ry=float(p[1])-float(start[1])
            coords.append((rx*ux+ry*uy,rx*ix+ry*iy,float(p[2])))
        matrix=np.asarray([[1.0,u,d] for u,d,_ in coords],dtype=float)
        heights=np.asarray([z for _,_,z in coords],dtype=float)
        try:slope=float(np.linalg.lstsq(matrix,heights,rcond=None)[0][2])
        except np.linalg.LinAlgError:slope=0.0
        factor=math.sqrt(1+slope*slope)
        return [[u/width,d*factor/height] for u,d,_ in coords]
    return [[(float(p[0])-float(tri[0][0]))/width,(float(p[1])-float(tri[0][1]))/height] for p in tri]

def wall_metric_uv(tri, ring, ground, repeat_m):
    """Align wall texture courses to a nearby footprint edge and DVR90 base."""
    width,height=map(float,repeat_m);xy=[list(map(float,p[:2])) for p in ring]
    center=[sum(float(p[i]) for p in tri)/3 for i in range(2)]
    best=None
    for i,a in enumerate(xy):
        b=xy[(i+1)%len(xy)];dx=b[0]-a[0];dy=b[1]-a[1];length2=dx*dx+dy*dy
        if length2<1e-12:continue
        t=max(0.0,min(1.0,((center[0]-a[0])*dx+(center[1]-a[1])*dy)/length2))
        q=(a[0]+t*dx,a[1]+t*dy);dist=(center[0]-q[0])**2+(center[1]-q[1])**2
        if best is None or dist<best[0]:best=(dist,a,dx,dy,math.sqrt(length2))
    if best is None:return [[0.0,(float(p[2])-ground)/height] for p in tri]
    _,a,dx,dy,length=best;ux,uy=dx/length,dy/length
    return [[((float(p[0])-a[0])*ux+(float(p[1])-a[1])*uy)/width,
             (float(p[2])-ground)/height] for p in tri]

def smooth_vertex_normals(triangles, origin):
    """Average terrain normals at shared millimetre vertices without moving geometry."""
    local_tris=[[local(p,origin) for p in tri] for tri in triangles]
    sums=defaultdict(lambda:np.zeros(3,dtype=np.float64))
    def key(p):return tuple(int(round(float(x)*1000)) for x in p)
    for tri in local_tris:
        a,b,c=(np.asarray(p,dtype=np.float64) for p in tri)
        n=np.cross(b-a,c-a)
        if n[1]<0:n=-n
        if np.linalg.norm(n)<1e-12:continue
        for p in tri:sums[key(p)]+=n
    result=[]
    for tri in local_tris:
        out=[]
        for p in tri:
            n=sums[key(p)];length=np.linalg.norm(n) or 1.0
            out.append((n/length).tolist())
        result.append(out)
    return local_tris,result

def rot(p):
    r = math.radians
    o, f, k = (r(float(p[f"pers:{x}"])) for x in ("omega", "phi", "kappa"))
    co, so, cp, sp, ck, sk = math.cos(o), math.sin(o), math.cos(f), math.sin(f), math.cos(k), math.sin(k)
    return ((cp*ck,-cp*sk,sp),(co*sk+so*sp*ck,co*ck-so*sp*sk,-so*cp),
            (so*sk-co*sp*ck,so*ck+co*sp*sk,co*cp))

def world_to_pixel(p, e, n, h):
    io=p["pers:interior_orientation"]; w,ih=map(float,io["sensor_array_dimensions"])
    pix=float(io["pixel_spacing"][0]); focal=float(io["focal_length"])
    off=io.get("principal_point_offset") or [0,0]; c=list(map(float,p["pers:perspective_center"]))
    d=[e-c[0],n-c[1],h-c[2]]; m=rot(p)
    dep=m[0][2]*d[0]+m[1][2]*d[1]+m[2][2]*d[2]
    if dep >= -1e-9: return None
    x=focal*(m[0][0]*d[0]+m[1][0]*d[1]+m[2][0]*d[2])/dep
    y=focal*(m[0][1]*d[0]+m[1][1]*d[1]+m[2][1]*d[2])/dep
    col=-((x-float(off[0]))-w*pix/2)/pix
    rowbot=-((y-float(off[1]))-ih*pix/2)/pix
    return [col, ih-rowbot]

def project_uv(camera,p):
    q=world_to_pixel(camera["pers"],*map(float,p[:3]))
    if q is None:return None
    c=camera["crop"]; factor=float(c.get("overview_factor") or 1)
    w,h=camera["saved_size"]
    u=(q[0]-float(c["x0"]))/factor/w; v=(q[1]-float(c["y0"]))/factor/h
    return [u,v] if 0<=u<=1 and 0<=v<=1 else None

class GLB:
    def __init__(self):
        self.b=bytearray(); self.views=[]; self.accessors=[]; self.meshes=[]; self.nodes=[]
        self.mats=[]; self.images=[]; self.textures=[]; self.samplers=[]; self.sampler_map={}
        self.matmap={}; self.imgmap={}
    def align(self):
        while len(self.b)%4:self.b.append(0)
    def view(self,data,target=None):
        self.align(); off=len(self.b); self.b.extend(data)
        v={"buffer":0,"byteOffset":off,"byteLength":len(data)}
        if target:v["target"]=target
        self.views.append(v); return len(self.views)-1
    def accessor(self,values,kind,target,limits=False):
        data=array("f",(float(x) for item in values for x in item))
        view=self.view(data.tobytes(),target)
        width=2 if kind=="VEC2" else 3
        out={"bufferView":view,"componentType":5126,"count":len(data)//width,"type":kind}
        if limits and values:
            a=np.asarray(values,dtype=np.float32); out["min"]=a.min(axis=0).tolist();out["max"]=a.max(axis=0).tolist()
        self.accessors.append(out);return len(self.accessors)-1
    def material(self,name,color=(1,1,1,1),texture=None,rough=0.88,alpha=None,repeat_s=False,repeat_t=False):
        digest=hashlib.sha1(texture[0]).hexdigest() if texture else "none"
        key=(name,tuple(color),digest,float(rough),alpha,bool(repeat_s),bool(repeat_t))
        if key in self.matmap:return self.matmap[key]
        mat={"name":name,"pbrMetallicRoughness":{"baseColorFactor":list(color),"metallicFactor":0,"roughnessFactor":rough},"doubleSided":True}
        if texture:
            raw,mime=texture
            if digest not in self.imgmap:
                view=self.view(raw); image=len(self.images);self.images.append({"bufferView":view,"mimeType":mime,"name":name})
                self.imgmap[digest]=image
            sampler_key=(bool(repeat_s),bool(repeat_t))
            if sampler_key not in self.sampler_map:
                self.sampler_map[sampler_key]=len(self.samplers)
                self.samplers.append({"magFilter":9729,"minFilter":9987,
                    "wrapS":10497 if repeat_s else 33071,"wrapT":10497 if repeat_t else 33071})
            texture_key=(digest,sampler_key)
            texture_index=next((i for i,t in enumerate(self.textures) if t.get("source")==self.imgmap[digest] and t.get("sampler")==self.sampler_map[sampler_key]),None)
            if texture_index is None:
                texture_index=len(self.textures);self.textures.append({"sampler":self.sampler_map[sampler_key],"source":self.imgmap[digest]})
            mat["pbrMetallicRoughness"]["baseColorTexture"]={"index":texture_index,"texCoord":0}
            mat["pbrMetallicRoughness"]["baseColorFactor"]=[1,1,1,1]
        if alpha:mat["alphaMode"]=alpha
        self.mats.append(mat);idx=len(self.mats)-1;self.matmap[key]=idx;return idx
    def triangles(self,name,tris,material,extras,uvs=None,vertex_normals=None):
        if not tris:return
        pos=[];norm=[];tex=[]
        for i,t in enumerate(tris):
            a,b,c=([float(x) for x in p] for p in t)
            u=[b[j]-a[j] for j in range(3)];v=[c[j]-a[j] for j in range(3)]
            n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            d=math.sqrt(sum(x*x for x in n)) or 1;n=[x/d for x in n]
            pos.extend([a,b,c])
            norm.extend(vertex_normals[i] if vertex_normals is not None else [n,n,n])
            if uvs is not None:tex.extend(uvs[i])
        attrs={"POSITION":self.accessor(pos,"VEC3",34962,True),"NORMAL":self.accessor(norm,"VEC3",34962)}
        if uvs is not None:attrs["TEXCOORD_0"]=self.accessor(tex,"VEC2",34962)
        mi=len(self.meshes);self.meshes.append({"name":name,"primitives":[{"attributes":attrs,"material":material,"mode":4}]})
        self.nodes.append({"name":name,"mesh":mi,"extras":extras})
    def save(self,path):
        doc={"asset":{"version":"2.0","generator":"Nyhavn v2 Roofer + photo appearance integration"},
             "scene":0,"scenes":[{"nodes":list(range(len(self.nodes)))}],"nodes":self.nodes,"meshes":self.meshes,
             "materials":self.mats,"accessors":self.accessors,"bufferViews":self.views,
             "buffers":[{"byteLength":len(self.b)}]}
        if self.images:
            doc["images"]=self.images;doc["textures"]=self.textures
            doc["samplers"]=self.samplers
        js=json.dumps(doc,separators=(",",":"),ensure_ascii=False).encode()
        while len(js)%4:js+=b" "
        self.align();total=12+8+len(js)+8+len(self.b)
        with open(path,"wb") as f:
            f.write(struct.pack("<4sII",b"glTF",2,total));f.write(struct.pack("<I4s",len(js),b"JSON"));f.write(js)
            f.write(struct.pack("<I4s",len(self.b),b"BIN\x00"));f.write(self.b)

def load_photo_cameras(model):
    result=[]
    native_root=SOURCES/"skraafoto-native"
    if (native_root/"cameras.json").exists():
        camera_records=read_json(native_root/"cameras.json")
        root=native_root
    else:
        camera_records=model.get("cameras",[])
        root=SOURCES/"skraafoto"
    for src in camera_records:
        c=dict(src); p=root/c.get("file","")
        try:
            with Image.open(p) as im:c["saved_size"]=list(im.size);im.verify()
            c["texture"]=(p.read_bytes(),"image/jpeg") if c.get("direction")=="nadir" else None
        except (OSError,ValueError):continue
        result.append(c)
    return result

def best_camera(cameras,tri):
    candidates=[]
    for c in cameras:
        if c.get("direction")!="nadir" or not c.get("texture"):continue
        uv=[project_uv(c,p) for p in tri]
        if any(x is None for x in uv):continue
        margin=min(min(x[0],x[1],1-x[0],1-x[1]) for x in uv)
        candidates.append((margin,c,uv))
    return max(candidates,key=lambda x:x[0]) if candidates else None

def parse_water(path):
    root=ET.parse(path).getroot(); nodes={n.get("id"):(float(n.get("lon")),float(n.get("lat"))) for n in root.findall("node")}
    ways={w.get("id"):[n.get("ref") for n in w.findall("nd")] for w in root.findall("way")}
    rel=next((r for r in root.findall("relation") if r.get("id")=="6476337"),None)
    if rel is None:raise ValueError("OSM extract is missing Nyhavn water relation 6476337")
    ids=[m.get("ref") for m in rel.findall("member") if m.get("type")=="way" and m.get("role")=="outer"]
    rings=[list(ways[i]) for i in ids];stitch=[]
    while rings:
        r=rings.pop(0)
        changed=True
        while changed and r[0]!=r[-1]:
            changed=False
            for j,q in enumerate(rings):
                if r[-1]==q[0]:r.extend(q[1:]);rings.pop(j);changed=True;break
                if r[-1]==q[-1]:q.reverse();r.extend(q[1:]);rings.pop(j);changed=True;break
        stitch.append(r)
    tf=Transformer.from_crs(4326,25832,always_xy=True);polys=[]
    for ids0 in stitch:
        pts=[tf.transform(*nodes[i]) for i in ids0 if i in nodes]
        if len(pts)>=3:
            if pts[0]!=pts[-1]:pts.append(pts[0])
            p=Polygon(pts)
            if p.is_valid and p.area>10:polys.append(p)
    if not polys:raise ValueError("Could not stitch OSM Nyhavn relation into a water polygon")
    return unary_union(polys),{"osm_relation":"6476337","outer_ways":ids}

def mesh_water(poly):
    out=[]
    for p in (list(poly.geoms) if poly.geom_type=="MultiPolygon" else [poly]):
        result=constrained_delaunay_triangles(p)
        tris=list(result.geoms) if hasattr(result,"geoms") else [result]
        for tri in tris:
            if p.covers(tri.representative_point()) and p.intersection(tri).area>=tri.area*.999:
                pts=[[float(x),float(y),0.0] for x,y in list(tri.exterior.coords)[:3]]
                signed=(pts[1][0]-pts[0][0])*(pts[2][1]-pts[0][1])-(pts[1][1]-pts[0][1])*(pts[2][0]-pts[0][0])
                if signed<0:pts[1],pts[2]=pts[2],pts[1]
                out.append(pts)
    return out

def mesh_terrain(dtm_path,footprints,water,bounds,step=4):
    """Drape the nadir view on DTM triangles, clipping exactly to buildings and OSM water.

    The old cell-centre skip left multi-metre slits along every footprint. Clipping
    each grid cell to the source polygons preserves a continuous quay/ground edge.
    """
    with rasterio.open(dtm_path) as ds:
        x0,y0,x1,y1=bounds
        r0,c0=ds.index(x0,y1);r1,c1=ds.index(x1,y0)
        r0,r1=max(0,min(r0,r1)),min(ds.height-1,max(r0,r1))
        c0,c1=max(0,min(c0,c1)),min(ds.width-1,max(c0,c1))
        rows=list(range(r0,r1+1,step));cols=list(range(c0,c1+1,step))
        if rows[-1]!=r1:rows.append(r1)
        if cols[-1]!=c1:cols.append(c1)
        land=Polygon([(x0,y0),(x1,y0),(x1,y1),(x0,y1)]).difference(footprints).difference(water)
        out=[];inferred_flags=[];repaired_vertices=set();shore_edges={};height_grid=ds.read(1)
        shoreline_band=water.buffer(8.0)
        shoreline_line=water.boundary
        shoreline_edge_band=shoreline_line.buffer(.025)
        height_cache={}
        def sample_height(e,n):
            key=(round(float(e),3),round(float(n),3))
            if key in height_cache:return height_cache[key]
            try:
                row,col=ds.index(e,n)
                if not(0<=row<ds.height and 0<=col<ds.width):return None,False
                value=float(height_grid[row,col])
                if not math.isfinite(value) or (ds.nodata is not None and value==ds.nodata):return None,False
                if value>0.05 or not shoreline_band.covers(Point(e,n)):
                    height_cache[key]=(value,False);return value,False
                # OSM and the 1 m DTM shoreline differ by a few cells. A valid
                # water/edge zero inside the OSM land clip would pull the whole
                # 4 m terrain triangle down into the water, so use nearby
                # positive DTM land samples and mark those vertices inferred.
                candidates=[]
                for radius in (1,2,3,4,6,8,10,12):
                    for i in range(16):
                        angle=2*math.pi*i/16
                        x=e+radius*math.cos(angle);y=n+radius*math.sin(angle);q=Point(x,y)
                        if water.covers(q):continue
                        try:
                            rr,cc=ds.index(x,y)
                            if 0<=rr<ds.height and 0<=cc<ds.width:
                                sample=float(height_grid[rr,cc])
                                if math.isfinite(sample) and (ds.nodata is None or sample!=ds.nodata) and 0.5<=sample<=5.5:
                                    candidates.append((radius,sample))
                        except (ValueError,IndexError):pass
                    if len(candidates)>=5:break
                if candidates:
                    nearest=sorted(candidates,key=lambda item:item[0])[:8]
                    value=float(np.median([v for _,v in nearest]))
                else:value=2.2
                repaired_vertices.add(key);height_cache[key]=(value,True);return value,True
            except (ValueError,IndexError):return None,False
        for ra,rb in zip(rows,rows[1:]):
            for ca,cb in zip(cols,cols[1:]):
                # Pixel-cell boundaries are exact in the projected DTM grid.
                ea,na=ds.transform*(ca,ra);eb,nb=ds.transform*(cb,rb)
                cell=box(min(ea,eb),min(na,nb),max(ea,eb),max(na,nb))
                clipped=cell.intersection(land)
                if clipped.is_empty:continue
                pieces=list(clipped.geoms) if clipped.geom_type=="MultiPolygon" else [clipped]
                for piece in pieces:
                    if piece.area<0.02:continue
                    result=constrained_delaunay_triangles(piece)
                    tris=list(result.geoms) if hasattr(result,"geoms") else [result]
                    for tri in tris:
                        if not piece.covers(tri.representative_point()) or piece.intersection(tri).area<tri.area*.999:continue
                        pts=[];triangle_inferred=False
                        for e,n in list(tri.exterior.coords)[:3]:
                            h,was_inferred=sample_height(e,n)
                            if h is None:break
                            triangle_inferred=triangle_inferred or was_inferred
                            pts.append([float(e),float(n),h])
                        if len(pts)!=3:continue
                        signed=(pts[1][0]-pts[0][0])*(pts[2][1]-pts[0][1])-(pts[1][1]-pts[0][1])*(pts[2][0]-pts[0][0])
                        if signed<0:pts[1],pts[2]=pts[2],pts[1]
                        out.append(pts);inferred_flags.append(triangle_inferred)
                        for ia,ib in ((0,1),(1,2),(2,0)):
                            a=pts[ia];b=pts[ib];mx=(a[0]+b[0])/2;my=(a[1]+b[1])/2
                            if math.hypot(b[0]-a[0],b[1]-a[1])<.02:continue
                            if (shoreline_edge_band.covers(Point(a[0],a[1])) and
                                shoreline_edge_band.covers(Point(mx,my)) and
                                shoreline_edge_band.covers(Point(b[0],b[1]))):
                                ka=(round(a[0]*1000),round(a[1]*1000));kb=(round(b[0]*1000),round(b[1]*1000))
                                key=(ka,kb) if ka<kb else (kb,ka)
                                shore_edges[key]=([a[0],a[1],a[2]],[b[0],b[1],b[2]])
        return out,inferred_flags,len(repaired_vertices),list(shore_edges.values())

def mesh_quay(water,shoreline_segments,hero_frontage):
    """Extrude the terrain's exact shoreline edges to water, closing the seam."""
    plain=[];observed_texture=[];photo_uvs=[];tile_length=5.5;tile_height=2.75
    polys=list(water.geoms) if water.geom_type=="MultiPolygon" else [water]
    rings=[LineString(r.coords) for poly in polys for r in [poly.exterior,*poly.interiors]]
    for raw_a,raw_b in shoreline_segments:
        a=list(map(float,raw_a));b=list(map(float,raw_b));segment=LineString([a[:2],b[:2]])
        if segment.length<.02:continue
        ring=min(rings,key=lambda line:line.distance(segment))
        perim=ring.length;ca=ring.project(Point(a[0],a[1]));cb=ring.project(Point(b[0],b[1]))
        forward=(cb-ca)%perim;backward=(ca-cb)%perim
        if abs(forward-segment.length)<=abs(backward-segment.length):start,end,chain=a,b,ca
        else:start,end,chain=b,a,cb
        ln=segment.length
        a0=[start[0],start[1],0.0];b0=[end[0],end[1],0.0]
        atop=[start[0],start[1],max(.05,start[2])];btop=[end[0],end[1],max(.05,end[2])]
        ts=[[a0,b0,btop],[a0,btop,atop]]
        if hero_frontage is not None and segment.distance(hero_frontage)<=28:
            observed_texture.extend(ts)
            u0=chain/tile_length;u1=(chain+ln)/tile_length
            h0=atop[2];h1=btop[2]
            photo_uvs.extend([[[u0,1.0],[u1,1.0],[u1,1-h1/tile_height]],
                              [[u0,1.0],[u1,1-h1/tile_height],[u0,1-h0/tile_height]]])
        else:plain.extend(ts)
    return plain,observed_texture,photo_uvs

def make_quay_texture():
    """Crop a source-backed timber bay from the licensed Nyhavn 9–17 photo."""
    source=SOURCES/"street-reference/nyhavn-9-17-2022.jpg"
    if not source.exists():return None
    target=V2/"appearance/nyhavn-quay-timber.jpg";target.parent.mkdir(parents=True,exist_ok=True)
    with Image.open(source) as im:
        # Horizontal wall beam and the timber posts/boards below it; no facade or people.
        crop=im.crop((100,2420,620,2970)).convert("RGB")
        crop.save(target,"JPEG",quality=94,optimize=True)
    return target.read_bytes(),"image/jpeg"

def resolve_img(rec):
    if isinstance(rec,str):rec={"path":rec}
    name=(rec or {}).get("path") or (rec or {}).get("file")
    if not name:return None
    p=Path(name).expanduser()
    if p.is_absolute() and p.exists():return p
    for candidate in (OUT/p,FACADE/p,FACADE/"textures"/p.name):
        if candidate.exists():return candidate
    return None

def facade_paint_linear(image):
    """Estimate one source-backed paint backing tone for transparent photo-mask pixels."""
    px=np.asarray(image.convert("RGBA"))
    a=px[:,:,3];rgb=px[:,:,:3].astype(np.float32)
    lum=rgb.mean(axis=2);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
    sat=(hi-lo)/np.maximum(hi,1)
    mask=(a>220)&(lum>48)&(lum<224)&~((sat<.10)&(lum>152))
    values=rgb[mask]
    if len(values)<100:
        values=rgb[a>220]
    if len(values)==0:
        srgb=np.array([155,143,124],dtype=np.float32)
    else:
        bins=np.clip((values//32).astype(np.int16),0,7)
        ids=bins[:,0]*64+bins[:,1]*8+bins[:,2]
        most=int(np.bincount(ids,minlength=512).argmax())
        selected=values[ids==most]
        srgb=np.median(selected,axis=0)
    s=np.clip(srgb/255,0,1)
    linear=np.where(s<=.04045,s/12.92,((s+.055)/1.055)**2.4)
    return [float(x) for x in linear]+[1.0]

def extent_value(record, fallback=None):
    if not isinstance(record,dict):return fallback
    for candidate in (record.get("world_extent_m"),record.get("image",{}).get("world_extent_m")):
        if candidate is not None and len(candidate)==4:
            try:
                value=list(map(float,candidate))
                if value[1]>value[0] and value[3]>value[2]:return value
            except (TypeError,ValueError):pass
    return fallback

def paste_by_world_extent(source,source_extent,target_extent,size):
    """Map a rectified RGBA image onto a wall canvas by physical u/z extents."""
    if not source_extent or not target_extent:return None
    su0,su1,sz0,sz1=map(float,source_extent);tu0,tu1,tz0,tz1=map(float,target_extent)
    u0,u1=max(su0,tu0),min(su1,tu1);z0,z1=max(sz0,tz0),min(sz1,tz1)
    if u1<=u0 or z1<=z0:return None
    sw,sh=source.size;tw,th=size
    sx0=(u0-su0)/(su1-su0)*sw;sx1=(u1-su0)/(su1-su0)*sw
    sy0=(sz1-z1)/(sz1-sz0)*sh;sy1=(sz1-z0)/(sz1-sz0)*sh
    tx0=(u0-tu0)/(tu1-tu0)*tw;tx1=(u1-tu0)/(tu1-tu0)*tw
    ty0=(tz1-z1)/(tz1-tz0)*th;ty1=(tz1-z0)/(tz1-tz0)*th
    x0=max(0,min(sw-1,int(math.floor(sx0))));y0=max(0,min(sh-1,int(math.floor(sy0))))
    x1=max(x0+1,min(sw,int(math.ceil(sx1))));y1=max(y0+1,min(sh,int(math.ceil(sy1))))
    crop=source.crop((x0,y0,x1,y1))
    dw=max(1,int(round(tx1-tx0)));dh=max(1,int(round(ty1-ty0)))
    if crop.size!=(dw,dh):crop=crop.resize((dw,dh),Image.Resampling.LANCZOS)
    layer=Image.new("RGBA",size,(0,0,0,0))
    layer.alpha_composite(crop,(int(round(tx0)),int(round(ty0))))
    return layer

def match_aerial_to_street(aerial,street):
    """Apply a bounded per-channel gain from overlapping visible facade pixels."""
    a=np.asarray(aerial.convert("RGBA")).copy();s=np.asarray(street.convert("RGBA"))
    if a.shape!=s.shape:return aerial,(1.0,1.0,1.0)
    ar=a[:,:,:3].astype(np.float32);sr=s[:,:,:3].astype(np.float32)
    lum=sr.mean(axis=2);alum=ar.mean(axis=2)
    mask=(s[:,:,3]>220)&(a[:,:,3]>220)&(lum>52)&(lum<218)&(alum>35)&(alum<238)
    if int(mask.sum())<80:return aerial,(1.0,1.0,1.0)
    gains=[]
    for channel in range(3):
        top=float(np.median(sr[:,:,channel][mask]));bottom=float(np.median(ar[:,:,channel][mask]))
        gains.append(float(np.clip(top/max(1,bottom),.78,1.28)))
    a[:,:,:3]=np.clip(ar*np.asarray(gains,dtype=np.float32)[None,None,:],0,255).astype(np.uint8)
    return Image.fromarray(a,"RGBA"),tuple(gains)

def prepare_facade_image(record):
    """Place each facade source at its physical wall u/z extent before texturing."""
    primary=record.get("image")
    alternates=record.get("alternates") or []
    target_extent=extent_value(record)
    if target_extent is None:
        length=float(record.get("length_m") or 0);z0=float(record.get("z_min") or 0);z1=float(record.get("z_max") or z0)
        if length>0 and z1>z0:target_extent=[0.0,length,z0,z1]
    if target_extent:record["world_extent_m"]=target_extent
    def unpack(entry,world_extent=None):
        if not entry:return None
        entry=dict(entry) if isinstance(entry,dict) else {"path":entry}
        path=resolve_img(entry)
        if not path:return None
        try:
            with Image.open(path) as im:
                image=im.convert("RGBA")
            return {"entry":entry,"path":path,"image":image,"raw":path.read_bytes(),
                    "mime":"image/png" if path.suffix.lower()==".png" else "image/jpeg",
                    "world_extent":world_extent or extent_value(entry)}
        except (OSError,ValueError):return None
    main=unpack(primary,extent_value(primary) or target_extent)
    alt_records=[]
    for alt in alternates:
        image_rec=(alt.get("image") if isinstance(alt,dict) and "image" in alt else alt)
        alt_extent=extent_value(alt) if isinstance(alt,dict) else None
        item=unpack(image_rec,alt_extent or extent_value(image_rec))
        if item:
            item["source_type"]=(alt.get("source_type") if isinstance(alt,dict) else None) or item["entry"].get("source_type")
            alt_records.append(item)
    if main:
        record["_paint_linear"]=facade_paint_linear(main["image"])
        source_type=(main["entry"].get("source_type") or record.get("source_type") or "").lower()
        if target_extent:
            source_extent=main.get("world_extent") or target_extent
            u_scale=(target_extent[1]-target_extent[0])/max(1e-8,source_extent[1]-source_extent[0])
            z_scale=(target_extent[3]-target_extent[2])/max(1e-8,source_extent[3]-source_extent[2])
            scale=min(2.5,max(1.0,u_scale,z_scale))
            size=(max(1,min(4096,int(round(main["image"].width*scale)))),
                  max(1,min(4096,int(round(main["image"].height*scale)))))
            merged=Image.new("RGBA",size,(0,0,0,0));sources_used=[];gains=(1.0,1.0,1.0)
            aerial=next((x for x in alt_records if "skraafoto" in str(x.get("source_type") or "").lower()),None)
            if aerial and aerial.get("world_extent"):
                base_layer=paste_by_world_extent(aerial["image"],aerial["world_extent"],target_extent,size)
                if base_layer:
                    # Estimate a restrained aerial colour gain only from wall
                    # pixels where both source layers are visible.
                    comparison=paste_by_world_extent(main["image"],source_extent,target_extent,size)
                    if comparison and "street" in source_type:
                        base_layer,gains=match_aerial_to_street(base_layer,comparison)
                    merged=Image.alpha_composite(merged,base_layer);sources_used.append(aerial["entry"])
            main_layer=paste_by_world_extent(main["image"],source_extent,target_extent,size)
            if main_layer:
                if aerial and "street" in source_type:
                    alpha=main_layer.getchannel("A").filter(ImageFilter.GaussianBlur(radius=2.25))
                    main_layer.putalpha(alpha)
                merged=Image.alpha_composite(merged,main_layer);sources_used.append(main["entry"])
            if sources_used:
                target=V2/"appearance"/("facade-"+str(record.get("building_id","building")).replace(":","-")+"-"+str(record.get("edge",0))+".png")
                target.parent.mkdir(parents=True,exist_ok=True);merged.save(target,"PNG",optimize=True)
                main.update({"path":target,"raw":target.read_bytes(),"mime":"image/png"})
                record["_composite_sources"]=sources_used
                record["_composite_method"]=("street-first source layers placed by their own physical u/z extents on the full Roofer wall extent; "
                    f"aerial per-channel gain {tuple(round(v,3) for v in gains)} estimated from overlapping facade pixels; "
                    "street mask edge feathered 2.25 source pixels")
        record["_path"]=main["path"];record["_bytes"]=main["raw"];record["_mime"]=main["mime"]
        record["_image_source_type"]=source_type
        if not record.get("provenance"):record["provenance"]={}
        return record
    if alt_records:
        best=next((x for x in alt_records if "skraafoto" in str(x.get("source_type") or "").lower()),alt_records[0])
        target_extent=target_extent or best.get("world_extent")
        if target_extent and best.get("world_extent"):
            scale=min(2.5,max(1.0,(target_extent[1]-target_extent[0])/max(1e-8,best["world_extent"][1]-best["world_extent"][0]),
                              (target_extent[3]-target_extent[2])/max(1e-8,best["world_extent"][3]-best["world_extent"][2])))
            size=(max(1,min(4096,int(round(best["image"].width*scale)))),max(1,min(4096,int(round(best["image"].height*scale)))))
            placed=paste_by_world_extent(best["image"],best["world_extent"],target_extent,size)
            if placed:
                target=V2/"appearance"/("facade-"+str(record.get("building_id","building")).replace(":","-")+"-"+str(record.get("edge",0))+".png")
                target.parent.mkdir(parents=True,exist_ok=True);placed.save(target,"PNG",optimize=True)
                record["_path"]=target;record["_bytes"]=target.read_bytes();record["_mime"]="image/png"
            else:
                record["_path"]=best["path"];record["_bytes"]=best["raw"];record["_mime"]=best["mime"]
        else:
            record["_path"]=best["path"];record["_bytes"]=best["raw"];record["_mime"]=best["mime"]
        record["_image_source_type"]=best.get("source_type")
        return record
    return record

def keys(record):
    out=set()
    for k in ("id","building_id","fot_id","kk_fot_id","bfe","bbr_uuid"):
        v=record.get(k)
        if v is not None:
            s=str(v);out.update((s,s.removeprefix("kk:")))
            if s.removeprefix("kk:").isdigit():out.add("kk:"+s.removeprefix("kk:"))
    return out

def face_uv(face,p):
    s,e=face["coordinates"]["start"],face["coordinates"]["end"]
    dx=float(e[0])-float(s[0]);dy=float(e[1])-float(s[1]);length=math.hypot(dx,dy)
    if length<1e-8:return [.5,.5]
    along=((float(p[0])-float(s[0]))*dx+(float(p[1])-float(s[1]))*dy)/length
    extent=face.get("world_extent_m") or face.get("image",{}).get("world_extent_m")
    u0,u1,z0,z1=map(float,extent);return [(along-u0)/max(1e-8,u1-u0),1-(float(p[2])-z0)/max(1e-8,z1-z0)]

def facade_for_wall_triangle(bid, tri, ring_index, edge_index, facade_map, facade_records):
    """Match explicit roof-worker edge labels first, then same-plane gable triangles."""
    id_options=(bid,bid.removeprefix("kk:"))
    if edge_index>=0:
        for key in id_options:
            f=facade_map.get((key,edge_index))
            if f and f.get("_path") and int(f.get("ring_index",0))==max(0,ring_index):
                return f
    choices=[]
    for f in facade_records:
        if not f.get("_path") or not (set(id_options) & {str(f.get("building_id","")),str(f.get("building_id","")).removeprefix("kk:")}):
            continue
        if int(f.get("ring_index",0)) != max(0,ring_index) and ring_index>=0:
            continue
        start=f["coordinates"]["start"];end=f["coordinates"]["end"]
        dx=float(end[0])-float(start[0]);dy=float(end[1])-float(start[1]);length=math.hypot(dx,dy)
        if length<1e-6:continue
        residuals=[];along=[]
        for p in tri:
            rx=float(p[0])-float(start[0]);ry=float(p[1])-float(start[1])
            along.append((rx*dx+ry*dy)/length)
            residuals.append(abs((rx*dy-ry*dx)/length))
        extent=f.get("world_extent_m") or f.get("image",{}).get("world_extent_m")
        u0,u1,_,_=map(float,extent)
        if max(residuals)<=0.65 and min(along)>=u0-0.7 and max(along)<=u1+0.7:
            choices.append((max(residuals),f))
    return min(choices,key=lambda x:x[0])[1] if choices else None

def normalized_building_id(value):
    value=str(value or "")
    return value if value.startswith("kk:") else ("kk:"+value if value.isdigit() else value)

def detail_element_class(value):
    value=re.sub(r"(?i)^Nyhavn\s+\d+[A-Z]?\s+","",str(value or "architectural detail"))
    value=re.sub(r"(?i)\b(roof\s+window|window|door|chimney|dormer|feature)\s+\d+\b",r"\1",value)
    return re.sub(r"\s+"," ",value).strip() or "architectural detail"

def alignment_feature(record, is_roof):
    element=str(record.get("element") or "").lower()
    if any(term in element for term in ("glass","glazing","pane","mullion","transom","flue opening")):return None
    if is_roof:
        match=re.search(r"roof\s+window\s+(\d+)",element)
        if match:return "roof window "+match.group(1)
        if "chimney" in element or "flue" in element:return "chimney/flue"
        return None
    if "window" not in element and "door" not in element:return None
    trace_ids=record.get("trace_ids") or []
    if len(trace_ids)==1:return str(trace_ids[0])
    return str(record.get("feature_id") or record.get("trace_id") or record.get("id") or record.get("element"))

def read_optional_json(path):
    return read_json(path) if Path(path).exists() else {}

def detail_mesh_triangles(record):
    """Accept absolute triangle coordinates or indexed absolute vertex arrays."""
    raw=record.get("triangles") or []
    vertices=record.get("vertices_epsg25832_dvr90") or record.get("vertices") or []
    output=[]
    for tri in raw:
        if not isinstance(tri,(list,tuple)) or len(tri)!=3:continue
        if all(isinstance(x,(int,float,np.integer,np.floating)) for x in tri):
            if not vertices or any(int(i)<0 or int(i)>=len(vertices) for i in tri):continue
            output.append([list(map(float,vertices[int(i)][:3])) for i in tri])
        else:
            try:output.append([list(map(float,p[:3])) for p in tri])
            except (TypeError,ValueError):continue
    return output

def detail_image(path_value,preserve_alpha=False):
    if not path_value:return None
    if isinstance(path_value,dict):path_value=path_value.get("path")
    path=Path(str(path_value)).expanduser()
    if not path.is_absolute():path=DETAIL/path
    if not path.exists():return None
    try:
        with Image.open(path) as im:image=im.convert("RGBA" if preserve_alpha else "RGB")
        import io
        data=io.BytesIO();image.save(data,format="PNG",optimize=True)
        return (data.getvalue(),"image/png")
    except (OSError,ValueError):return None

def make_view_presets(buildings, scope, origin):
    by_id={b["id"]:b for b in buildings}
    hero=[by_id[k] for k in FRONTAGE_LABELS if k in by_id]
    if not hero:
        hero=buildings[:min(6,len(buildings))]
    def centroid(group):
        pts=[p for b in group for p in b["footprint_epsg25832"]]
        return [sum(p[0] for p in pts)/len(pts),sum(p[1] for p in pts)/len(pts)] if pts else [origin[0],origin[1]]
    hero_center=centroid(hero)
    opposite=[]
    for b in buildings:
        a=b.get("address") or ""
        head=a.split(",",1)[0].strip().removeprefix("Nyhavn ")
        if head in {"6","8","10","12","14"}:
            opposite.append(b)
    opposite_center=centroid(opposite) if opposite else [hero_center[0],hero_center[1]-60]
    water_center=[(hero_center[0]+opposite_center[0])/2,(hero_center[1]+opposite_center[1])/2]
    hero_local=[hero_center[0]-origin[0],-(hero_center[1]-origin[1])]
    other_local=[opposite_center[0]-origin[0],-(opposite_center[1]-origin[1])]
    water_local=[water_center[0]-origin[0],-(water_center[1]-origin[1])]
    line=scope.get("line_epsg25832") or []
    if len(line)>=2:
        ax=float(line[-1][0])-float(line[0][0]);az=-(float(line[-1][1])-float(line[0][1]))
    else:ax,az=1,0
    ln=math.hypot(ax,az) or 1;ax/=ln;az/=ln
    # DVR90 water is 0 m; 3.6 m above it is a low boat/quay-eye perspective.
    eye_y=3.6-origin[2];look_y=8.5-origin[2];wide_y=62-origin[2]
    front_dx=hero_local[0]-water_local[0];front_dz=hero_local[1]-water_local[1]
    front_len=math.hypot(front_dx,front_dz) or 1;front_dx/=front_len;front_dz/=front_len
    width=max(70,math.hypot(hero_local[0]-other_local[0],hero_local[1]-other_local[1]))
    normal_x,normal_z=-az,ax
    return {
        "default":"hero-across",
        "items":{
            "hero-across":{"label":"Across canal · Nyhavn 9–17","position":[water_local[0]-ax*15-front_dx*max(0,width*.08),eye_y,water_local[1]-az*15-front_dz*max(0,width*.08)],
                "target":[hero_local[0],look_y,hero_local[1]],"fov":44,"lens":"3.6 m above DVR90 water; photo-led frontage view",
                "focus_buildings":[b["id"] for b in hero]},
            "both-banks":{"label":"Along canal · both waterfront rows","position":[water_local[0]-ax*68,eye_y+6.5,water_local[1]-az*68],
                "target":[water_local[0]+ax*52,look_y+2.0,water_local[1]+az*52],"fov":52,"lens":"raised canal oblique with both bank facades"},
            "street-west":{"label":"Street level · west quay","position":[water_local[0]-front_dx*width*.42,eye_y,water_local[1]-front_dz*width*.42],
                "target":[hero_local[0],look_y,hero_local[1]],"fov":50,"lens":"across-water street view"},
            "district":{"label":"District overview","position":[ax*280+normal_x*195,wide_y+62,az*280+normal_z*195],
                "target":[0,5-origin[2],0],"fov":50,
                "lens":"high overview of the mapped Nyhavn context"}
        }
    }

def surface_name(v):
    low=str(v).lower()
    if low.startswith("roof"):return "RoofSurface"
    if low.startswith("ground"):return "GroundSurface"
    return "WallSurface"

def fallback_envelope(b, oldrec, rings, origin, dtm_path, measured_heights):
    """Create an explicitly inferred flat-roof envelope for records lacking a Roofer mesh.

    Prefer legacy per-building DHM eave evidence, then a nearest-neighbour fitted
    height estimate, then registered storeys. The fallback keeps the KK footprint
    and does not imply roof planes or opening geometry.
    """
    footprint=Polygon(rings[0],rings[1:])
    ground=oldrec.get("ground_dvr90")
    if ground is None or not 0.6<=float(ground)<=5.5:
        samples=[]
        with rasterio.open(dtm_path) as ds:
            edge=footprint.boundary
            for i in range(28):
                p=edge.interpolate(edge.length*(i/28))
                # Sample just outside the wall to avoid a roof/edge contamination.
                for d in (0.75,1.5,3.0):
                    q=edge.interpolate(edge.length*(i/28))
                    # Move away from the building centroid along the local radial.
                    dx=q.x-footprint.centroid.x;dy=q.y-footprint.centroid.y;ln=math.hypot(dx,dy) or 1
                    for sign in (1,-1):
                        e=q.x+sign*dx/ln*d;n=q.y+sign*dy/ln*d
                        try:
                            row,col=ds.index(e,n)
                            value=float(ds.read(1,window=((row,row+1),(col,col+1)))[0,0])
                            if math.isfinite(value) and 0.5<=value<=5.5:samples.append(value)
                        except (ValueError,IndexError):pass
        ground=float(np.median(samples)) if samples else float(origin[2])
    else:ground=float(ground)

    eaves=oldrec.get("eave_boundary_dvr90") or []
    valid_eaves=[float(h) for h in eaves if h is not None and ground+1.8<float(h)<ground+24]
    roof=oldrec.get("roof_surface") or {}
    legacy_p95=roof.get("height_p95_dvr90")
    if valid_eaves:
        top=float(np.median(valid_eaves));height_basis="legacy v1 DHM edge-interpolated eave heights"
    elif legacy_p95 is not None and ground+2.0<float(legacy_p95)<ground+24:
        top=float(legacy_p95);height_basis="legacy v1 DHM DSM 95th-percentile roof height"
    else:
        centroid=(footprint.centroid.x,footprint.centroid.y)
        near=sorted((math.hypot(x-centroid[0],y-centroid[1]),h) for x,y,h in measured_heights)
        nearby=[h for dist,h in near if dist<95][:5]
        storeys=oldrec.get("storeys_register")
        if nearby:
            relative=float(np.median(nearby));height_basis="median height of five nearest Roofer-fitted buildings"
        elif storeys is not None and 1<=int(storeys)<=8:
            relative=2.9*int(storeys)+0.8;height_basis="registered storeys at 2.9 m per floor plus 0.8 m"
        else:
            relative=8.5;height_basis="local fallback height; no DHM/storey estimate available"
        if footprint.area<12 and nearby:
            relative=min(relative,5.5)
            height_basis+="; small footprint under 12 m² without direct DHM roof evidence capped at 5.5 m"
        if relative>14.5:
            relative=14.5;height_basis+="; capped at 14.5 m"
        top=ground+relative

    # Building corners use local DHM ground samples where present; otherwise use
    # the robust landward estimate so waterfront footprints remain closed.
    with rasterio.open(dtm_path) as ds:
        bases=[]
        for e,n in rings[0]:
            values=[]
            for dist in (0.0,0.7,1.5,3.0):
                x=footprint.centroid.x+(e-footprint.centroid.x)*(1+dist/max(1e-8,math.hypot(e-footprint.centroid.x,n-footprint.centroid.y)))
                y=footprint.centroid.y+(n-footprint.centroid.y)*(1+dist/max(1e-8,math.hypot(e-footprint.centroid.x,n-footprint.centroid.y)))
                try:
                    row,col=ds.index(x,y);v=float(ds.read(1,window=((row,row+1),(col,col+1)))[0,0])
                    if math.isfinite(v) and 0.5<=v<=5.5:values.append(v)
                except (ValueError,IndexError):pass
            bases.append(float(np.median(values)) if values else ground)
    # Normalize the low wall ring and retain the bounded robust DTM estimate.
    if max(bases)-min(bases)>1.6:bases=[ground]*len(bases)
    roof_tris=[]
    result=constrained_delaunay_triangles(footprint)
    for t in (list(result.geoms) if hasattr(result,"geoms") else [result]):
        if footprint.intersection(t).area<t.area*.999:continue
        pts=list(t.exterior.coords)[:3]
        signed=(pts[1][0]-pts[0][0])*(pts[2][1]-pts[0][1])-(pts[1][1]-pts[0][1])*(pts[2][0]-pts[0][0])
        if signed<0:pts[1],pts[2]=pts[2],pts[1]
        roof_tris.append([[float(x),float(y),top] for x,y in pts])
    wall_tris=[]
    for ring_index,ring in enumerate(rings):
        for i,(p,q) in enumerate(zip(ring,ring[1:]+ring[:1])):
            if math.dist(p[:2],q[:2])<1e-5:continue
            z0=bases[i] if ring_index==0 and i<len(bases) else ground
            z1=bases[(i+1)%len(bases)] if ring_index==0 and i<len(bases) else ground
            a=[float(p[0]),float(p[1]),z0];bb=[float(q[0]),float(q[1]),z1]
            c=[float(q[0]),float(q[1]),top];d=[float(p[0]),float(p[1]),top]
            wall_tris.extend([[a,bb,c],[a,c,d]])
    return wall_tris,roof_tris,ground,top,height_basis

def surface_wire_edges(triangles):
    """Return only envelope boundaries and plane breaks for the photo overlay."""
    edges=defaultdict(list)
    def key(p):return tuple(int(round(float(x)*1000)) for x in p[:3])
    for tri in triangles:
        a,b,c=([float(x) for x in p[:3]] for p in tri)
        u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        length=math.sqrt(sum(x*x for x in n))
        if length<1e-6:continue
        n=tuple(x/length for x in n)
        for p,q in ((a,b),(b,c),(c,a)):
            kp,kq=key(p),key(q);pair=(kp,kq) if kp<kq else (kq,kp)
            edges[pair].append((p,q,n))
    keep=[];crease=math.cos(math.radians(18))
    for records in edges.values():
        sharp=len(records)==1 or any(sum(a*b for a,b in zip(records[0][2],r[2]))<crease for r in records[1:])
        if sharp:keep.append([[float(x) for x in records[0][0]],[float(x) for x in records[0][1]]])
    return keep

def run_build():
    roof_path=V2/"roofer-roofs.json";facade_path=FACADE/"manifest.json"
    if not roof_path.exists():raise FileNotFoundError(roof_path)
    if not facade_path.exists():
        # Let the hero scene be staged as soon as its licensed photo cutouts are ready.
        # The next build automatically consumes the unified per-edge manifest and aerial fills.
        facade_path=FACADE/"street-reference-manifest.json"
    if not facade_path.exists():raise FileNotFoundError("No facade-v2 manifest is available")
    base=read_json(V1/"building.json");roofdoc=read_json(roof_path);facdoc=read_json(facade_path)
    roofer_source_sha256=hashlib.sha256(roof_path.read_bytes()).hexdigest()
    facade_detail_doc=read_optional_json(DETAIL/"facades.json")
    roof_detail_doc=read_optional_json(DETAIL/"roofs.json")
    quay_detail_doc=read_optional_json(DETAIL/"quay.json")
    origin=list(map(float,roofdoc.get("frame",{}).get("origin") or roofdoc.get("origin") or base["frame"]["origin"]))
    raw_buildings=roofdoc.get("buildings",[])
    buildings=list(raw_buildings.values()) if isinstance(raw_buildings,dict) else list(raw_buildings)
    if not buildings:raise ValueError("Roofer document has an empty buildings list")
    cameras=load_photo_cameras(base);camera_by_id={c["view_id"]:c for c in cameras}
    photo_root="sources/skraafoto-native" if (SOURCES/"skraafoto-native/cameras.json").exists() else "sources/skraafoto"
    public_cameras=[{k:v for k,v in c.items() if k not in ("texture","saved_size")} for c in cameras]
    old={str(b["id"]):b for b in base.get("buildings",[])}
    facades=facdoc.get("facades",[]);facade_map={}
    for f in facades:
        prepare_facade_image(f)
        for k in {str(f.get("building_id","")),str(f.get("building_id","")).removeprefix("kk:")}:
            facade_map[(k,int(f.get("edge",0)))]=f
    replaced_facades=set()
    for record in facade_detail_doc.get("replaced_facades",[]) or []:
        bid=normalized_building_id(record.get("building_id"));edge=int(record.get("edge",-1));ring=int(record.get("ring_index",0))
        if edge>=0:replaced_facades.add((bid,ring,edge))
    roof_frontage_by_building={}
    for f in facades:
        bid=normalized_building_id(f.get("building_id"));edge=int(f.get("edge",-1));ring=int(f.get("ring_index",0))
        if ring==0 and (bid,ring,edge) in replaced_facades:roof_frontage_by_building[bid]=f
    roof_overrides=roof_detail_doc.get("roof_overrides",[]) or []
    roof_override_by_building=defaultdict(list)
    for record in roof_overrides:
        if isinstance(record,dict):roof_override_by_building[normalized_building_id(record.get("building_id"))].append(record)
    roof_material_overrides={normalized_building_id(k):str(v) for k,v in (roof_detail_doc.get("roof_material_overrides") or {}).items()}
    glb=GLB()
    wallmat=glb.material("Untextured wall shell · inferred",[.58,.54,.48,1],rough=.97)
    roofmat=glb.material("Roof without nadir photo · inferred",[.52,.25,.13,1],rough=.91)
    paving_texture=procedural_paving();import io
    paving_buffer=io.BytesIO();paving_texture.save(paving_buffer,format="PNG",optimize=True)
    groundmat=glb.material("Inferred metre-scaled stone paving",texture=(paving_buffer.getvalue(),"image/png"),rough=.96,
                           repeat_s=True,repeat_t=True)
    water_texture=procedural_water();water_buffer=io.BytesIO();water_texture.save(water_buffer,format="PNG",optimize=True)
    watermat=glb.material("Nyhavn water · inferred quiet ripple appearance",texture=(water_buffer.getvalue(),"image/png"),
                          rough=.27,repeat_s=True,repeat_t=True)
    quaymat=glb.material("Quay retaining face · inferred",[.23,.22,.19,1],rough=.96)
    cameramats={}
    for c in cameras:
        if c.get("texture"):
            cameramats[c["view_id"]]=glb.material("Skråfoto nadir "+c["view_id"],texture=c["texture"],rough=.92)
    all_detail_materials={**(roof_detail_doc.get("materials") or {}),**(facade_detail_doc.get("materials") or {}),
                          **(quay_detail_doc.get("materials") or {})}
    red11_id="kk:1202806702"
    red11_brick_materials={str(m.get("material") or m.get("material_id")) for m in facade_detail_doc.get("meshes",[])
        if normalized_building_id(m.get("building_id"))==red11_id and str(m.get("element") or "").lower()=="wall"}
    red11_sidewall_material=(facade_detail_doc.get("sidewall_materials") or {}).get(red11_id)
    if red11_sidewall_material:red11_brick_materials.add(str(red11_sidewall_material))
    detail_material_indices={};detail_material_notes={}
    for matid,spec in all_detail_materials.items():
        spec=spec if isinstance(spec,dict) else {}
        color=spec.get("color_srgb") or [.54,.27,.16]
        texture=detail_image(spec.get("texture"))
        repeat=spec.get("texture_repeat_m") or [.30,.36]
        if texture is None and str(matid) in set(roof_material_overrides.values()):
            image=procedural_roof_tiles(color);buf=io.BytesIO();image.save(buf,format="PNG",optimize=True)
            texture=(buf.getvalue(),"image/png")
        if texture is None and str(matid) in red11_brick_materials:
            image=procedural_brick(color);buf=io.BytesIO();image.save(buf,format="PNG",optimize=True)
            texture=(buf.getvalue(),"image/png");repeat=[.46,.12]
            detail_material_notes[str(matid)]="Source-sampled red11 brick color with inferred 0.23 m running-bond width and 0.06 m course height."
        roughness=float(spec.get("roughness",.9))
        if texture is None and any(term in str(matid).lower() for term in ("glass","pane")):
            lifted=[max(float(color[i]),[.27,.33,.38][i]) for i in range(3)]
            if lifted!=list(color[:3]):detail_material_notes[str(matid)]="Source-sampled blue-grey glazing lifted slightly for visibility; size and position remain photo-traced."
            color=lifted;roughness=min(roughness,.25)
        factor=[1,1,1,1] if texture else linear_srgb_rgba(color)
        detail_material_indices[str(matid)]=glb.material(
            "Inferred detail material "+str(matid),factor,texture=texture,rough=roughness,
            repeat_s=bool(texture),repeat_t=bool(texture))
    roof_tile_sizes={str(k):list(map(float,(all_detail_materials.get(str(v),{}).get("texture_repeat_m") or [.30,.36])))
                     for k,v in roof_material_overrides.items()}
    footprint_polys=[];model_buildings=[];city_faces=[];roof_count=wall_count=facade_count=0
    fallback_roof_count=fallback_wall_count=fitted_count=fallback_count=0
    facade_edges=set();facade_mesh_group_count=0
    replaced_facade_triangle_count=0;roof_source_patch_triangle_count=0;source_patch_collapsed_triangle_count=0
    roof_material_batches=defaultdict(lambda:([],[],[],[]));detail_batches=defaultdict(lambda:([],[],[],[],[]))
    measured_heights=[]
    for item in buildings:
        vv=item.get("vertices_epsg25832_dvr90") or []
        rr=item.get("footprint_rings_epsg25832") or []
        if vv and item.get("conf")=="observed" and rr:
            pp=Polygon(rr[0],rr[1:]);zz=[float(v[2]) for v in vv if len(v)>2]
            if zz and 2.5<=max(zz)-min(zz)<=26:
                measured_heights.append((pp.centroid.x,pp.centroid.y,max(zz)-min(zz)))
    for b in buildings:
        bid=str(b.get("id") or "kk:"+str(b.get("fot_id")))
        rings=b.get("footprint_rings_epsg25832") or ([b["footprint_epsg25832"]] if b.get("footprint_epsg25832") else [])
        rings=[[list(map(float,p[:2])) for p in ring] for ring in rings]
        if not rings or len(rings[0])<3:continue
        footprint=Polygon(rings[0],rings[1:]);footprint_polys.append(footprint)
        verts=[list(map(float,v[:3])) for v in (b.get("vertices_epsg25832_dvr90") or [])]; ix=b.get("triangles") or []
        fitted=bool(ix and verts)
        patched_triangles=set();patch_sources={};patched_vertex_ids=set()
        for override in roof_override_by_building.get(normalized_building_id(bid),[]):
            if override.get("type")!="source_vertex_height_patch":continue
            explicit=set(map(int,override.get("affected_triangle_ids") or []))
            updates=override.get("vertex_height_updates") or []
            for update in updates:
                vi=int(update.get("vertex",-1))
                if 0<=vi<len(verts):
                    verts[vi][2]=float(update["height_dvr90"]);patched_vertex_ids.add(vi)
            explicit.update(ti for ti,indices in enumerate(ix) if any(int(i) in patched_vertex_ids for i in indices))
            patched_triangles.update(explicit)
            provenance=strlist(override.get("src")) or ["Source-informed localized roof shape correction"]
            for ti in explicit:patch_sources[ti]=provenance
        roof_source_patch_triangle_count+=len(patched_triangles)
        roof_material_id=roof_material_overrides.get(normalized_building_id(bid))
        sidewall_material_id=(facade_detail_doc.get("sidewall_materials") or {}).get(normalized_building_id(bid))
        sidewall_material_index=detail_material_indices.get(str(sidewall_material_id))
        oldrec=old.get(bid,{})
        wall_ground=float(oldrec.get("ground_dvr90",min((v[2] for v in verts),default=origin[2])))
        fallback_ground=None;fallback_top=None;fallback_basis=None;wire_tris=[]
        if not fitted:
            fw,fr,fallback_ground,fallback_top,fallback_basis=fallback_envelope(
                b,oldrec,rings,origin,SOURCES/"dhm/dhm_dtm_nyhavn.tif",measured_heights)
            fallback_count+=1;fallback_wall_count+=len(fw);fallback_roof_count+=len(fr)
            fsrc=["KK building footprint",*strlist(oldrec.get("src")),
                  "Inferred fallback envelope; no accepted Roofer mesh",fallback_basis]
            for tri in fw:
                city_faces.append((bid,"WallSurface",tri,"inferred",fsrc))
            for tri in fr:
                city_faces.append((bid,"RoofSurface",tri,"inferred",fsrc))
            wire_tris=[*fw,*fr]
            glb.triangles(f"{bid}/WallSurface/inferred-fallback",[[local(p,origin) for p in t] for t in fw],wallmat,
                {"building_id":bid,"element":"WallSurface inferred fallback envelope","conf":"inferred","src":fsrc,
                 "confidence_basis":"footprint extruded to an estimated flat roof elevation",
                 "reason":b.get("reason") or "No accepted Roofer roof/wall mesh"})
            glb.triangles(f"{bid}/RoofSurface/inferred-fallback",[[local(p,origin) for p in t] for t in fr],roofmat,
                {"building_id":bid,"element":"RoofSurface inferred fallback cap","conf":"inferred","src":fsrc,
                 "confidence_basis":"legacy DHM eave estimate or nearby fitted height; flat cap only",
                 "reason":b.get("reason") or "No accepted Roofer roof/wall mesh"})
        else:fitted_count+=1
        sem=b.get("triangle_surface_type") or []; rix=b.get("triangle_ring_index") or []; eix=b.get("triangle_edge_index") or []
        src=strlist(b.get("source") or b.get("src")) or ["Roofer reconstruction; see model-v2/roofer-roofs.json"]
        conf=str(b.get("conf") or b.get("confidence") or "observed")
        roofs=defaultdict(lambda:([],[]));roof_plain=[];grounds=defaultdict(lambda:([],[]));ground_plain=[]
        walls_plain=defaultdict(list);walls_plain_world=defaultdict(list)
        wall_backings=defaultdict(list);facade_groups=defaultdict(lambda:([],[]));fmeta={}
        for ti,ids in enumerate(ix):
            if len(ids)!=3 or any(int(j)<0 or int(j)>=len(verts) for j in ids):continue
            tri=[list(map(float,verts[int(j)][:3])) for j in ids];kind=surface_name(sem[ti] if ti<len(sem) else "WallSurface")
            if kind=="RoofSurface":roof_count+=1
            wire_tris.append(tri)
            tri_confs=b.get("triangle_confidence") or []
            tri_sources=b.get("triangle_source") or []
            tri_conf=tri_confs[ti] if ti<len(tri_confs) else conf
            tri_src=strlist(tri_sources[ti] if ti<len(tri_sources) else src) or src
            if ti in patched_triangles:
                tri_conf="inferred"
                tri_src+=patch_sources.get(ti,[])+["Localized source-informed red 11 roof geometry correction"]
                a,bp,cp=(np.asarray(p,dtype=float) for p in tri)
                if float(np.linalg.norm(np.cross(bp-a,cp-a)))<2e-7:
                    source_patch_collapsed_triangle_count+=1
                    continue
            if kind=="RoofSurface" or kind=="GroundSurface":
                if kind=="RoofSurface" and roof_material_id:
                    uv=roof_tile_uv(tri,roof_frontage_by_building.get(normalized_building_id(bid)),footprint,
                                    roof_tile_sizes.get(roof_material_id,[.30,.36]))
                    bucket=roof_material_batches[(bid,roof_material_id,str(tri_conf))]
                    bucket[0].append([local(p,origin) for p in tri]);bucket[1].append(uv)
                    texsrc=tri_src+["inferred terracotta roof tile appearance"]
                    bucket[2].append(f"roofer:{bid}:triangle:{ti}");bucket[3].append(texsrc)
                    city_faces.append((bid,kind,tri,str(tri_conf),texsrc))
                    continue
                sel=best_camera(cameras,tri)
                if sel:
                    _,cam,uv=sel
                    texsrc=tri_src+[f"Skråfoto:{cam['view_id']}"]
                    if kind=="RoofSurface":
                        roofs[cam["view_id"]][0].append([local(p,origin) for p in tri]);roofs[cam["view_id"]][1].append(uv)
                    else:
                        grounds[cam["view_id"]][0].append([local(p,origin) for p in tri]);grounds[cam["view_id"]][1].append(uv)
                else:
                    if kind=="RoofSurface":roof_plain.append([local(p,origin) for p in tri])
                    else:ground_plain.append([local(p,origin) for p in tri])
                    texsrc=tri_src
                city_faces.append((bid,kind,tri,str(tri_conf),texsrc))
                continue
            else:
                wall_count+=1;local_tri=[local(p,origin) for p in tri]
                tri_src=tri_src+[f"Roofer shell:{bid}"]
                ri=int(rix[ti]) if ti<len(rix) else -1;ei=int(eix[ti]) if ti<len(eix) else -1
                f=facade_for_wall_triangle(bid,tri,ri,ei,facade_map,facades)
                replacement_edge=ei if ei>=0 else (int(f.get("edge",-1)) if f else -1)
                if (normalized_building_id(bid),max(0,ri),replacement_edge) in replaced_facades:
                    replaced_facade_triangle_count+=1
                    continue
                city_faces.append((bid,kind,tri,str(tri_conf),tri_src))
                if not f:
                    wall_material=sidewall_material_index if sidewall_material_index is not None else -1
                    walls_plain[wall_material].append(local_tri);walls_plain_world[wall_material].append(tri)
                    continue
                ei=int(f.get("edge",ei))
                k=f"{bid}:{ri}:{ei}";wall_backings[k].append(local_tri)
                facade_groups[k][0].append(local_tri)
                # Move the transparent photo overlay 2 cm out of the inferred wall
                # to avoid z-fighting in standard GLB viewers.
                norm=f.get("normal_xy") or f.get("normal") or [0,0]
                nl=math.hypot(float(norm[0]),float(norm[1]))
                if nl<1e-8:
                    start=f["coordinates"]["start"];end=f["coordinates"]["end"]
                    dx=float(end[0])-float(start[0]);dy=float(end[1])-float(start[1]);ln=math.hypot(dx,dy) or 1
                    center=(footprint.centroid.x,footprint.centroid.y)
                    mid=((float(start[0])+float(end[0]))/2,(float(start[1])+float(end[1]))/2)
                    nx,ny=-dy/ln,dx/ln
                    if (center[0]-mid[0])*nx+(center[1]-mid[1])*ny>0:nx,ny=-nx,-ny
                else:nx,ny=float(norm[0])/nl,float(norm[1])/nl
                overlay_tri=[[p[0]+nx*.02,p[1]+ny*.02,p[2]] for p in tri]
                facade_groups[k][0][-1]=[local(p,origin) for p in overlay_tri]
                facade_groups[k][1].append([face_uv(f,p) for p in tri]);fmeta[k]=f
        for cid,(tris,uvs) in roofs.items():
            glb.triangles(f"{bid}/RoofSurface/Skråfoto-{cid}",tris,cameramats[cid],
                {"building_id":bid,"element":"RoofSurface photo","conf":"observed" if conf in ("observed","high","measured") else "inferred",
                 "src":src+[f"Skråfoto:{cid}"],"confidence_basis":b.get("confidence_basis"),
                 "reason":b.get("reason"),"appearance":"nadir photo; Roofer supplies geometry","appearance_only":True},uvs)
        for cid,(tris,uvs) in grounds.items():
            glb.triangles(f"{bid}/GroundSurface/Skråfoto-{cid}",tris,cameramats[cid],
                {"building_id":bid,"element":"GroundSurface photo","conf":"observed",
                 "src":src+[f"Skråfoto:{cid}"],"appearance":"nadir photo; Roofer supplies geometry","appearance_only":True},uvs)
        if ground_plain:
            glb.triangles(f"{bid}/GroundSurface/no-photo",ground_plain,groundmat,
                {"building_id":bid,"element":"GroundSurface","conf":"inferred","src":src,"reason":"No nadir photo crop covers triangle"})
        if roof_plain:glb.triangles(f"{bid}/RoofSurface/no-photo",roof_plain,roofmat,
                {"building_id":bid,"element":"RoofSurface","conf":"inferred","src":src,"reason":"No saved nadir crop covers triangle"})
        for k,tris in wall_backings.items():
            f=fmeta[k];paint=f.get("_paint_linear") or [.58,.54,.48,1]
            base_mat=glb.material("Photo-derived facade paint backing "+k,paint,rough=.96)
            attribution=[str(f.get("view_id") or "facade photograph")]
            attribution+=strlist(f.get("source_attribution"))+strlist(f.get("source_photo"))
            glb.triangles(f"{k}/WallSurface/paint-backing",tris,base_mat,
                {"building_id":bid,"element":"WallSurface photo-derived paint backing","conf":"inferred",
                 "src":attribution,"confidence_basis":"wall paint tone estimated from visible source pixels",
                 "reason":"A single paint tone sampled from this facade photo fills transparent foreground masks only; it adds no window detail"})
        for wall_material,plain_tris in walls_plain.items():
            if plain_tris:
                material=wall_material if wall_material>=0 else wallmat
                wall_src=(src+["Facade-v3 source-sampled hero sidewall paint"] if wall_material>=0 else src)
                world_tris=walls_plain_world[wall_material]
                wall_uvs=([wall_metric_uv(t,rings[0],wall_ground,[.46,.12]) for t in world_tris]
                          if wall_material>=0 and sidewall_material_id in red11_brick_materials else None)
                glb.triangles(f"{bid}/WallSurface/shell",plain_tris,material,
                    {"building_id":bid,"element":"WallSurface shell","conf":"inferred","src":wall_src,
                     "confidence_basis":b.get("confidence_basis"),
                     "reason":"Envelope wall triangulation; no usable matching-edge photo texture",
                     "material_adjustment":detail_material_notes.get(str(sidewall_material_id))},wall_uvs)
        for k,(tris,uvs) in facade_groups.items():
            f=fmeta[k];mat=glb.material("Rectified Skråfoto facade "+k,texture=(f["_bytes"],f["_mime"]),rough=.98,alpha="BLEND")
            provenance=f.get("provenance",{})
            srcf=[str(f.get("view_id") or provenance.get("view_id") or f.get("_image_source_type") or "facade rectification")]
            srcf+=strlist(provenance)+strlist(f.get("source_attribution"))+strlist(f.get("source_photo"))
            if f.get("source_date"):srcf.append("date:"+str(f["source_date"]))
            if f.get("method"):srcf.append("method:"+str(f["method"]))
            if f.get("_composite_sources"):srcf+=["source:"+json.dumps(x,ensure_ascii=False,sort_keys=True) for x in f["_composite_sources"]]
            if f.get("_composite_method"):srcf.append("appearance composite: "+f["_composite_method"])
            glb.triangles(f"{k}/FacadePhoto",tris,mat,
                {"building_id":bid,"element":"Facade photo texture","conf":str(f.get("source_confidence") or "observed"),
                 "src":srcf,"coverage":f.get("coverage"),"occlusion":f.get("occlusion"),
                 "effective_gsd_m_px":f.get("meters_per_pixel") or f.get("image",{}).get("meters_per_pixel"),
                 "appearance_only":True},uvs)
            facade_edges.add((bid,int(f.get("ring_index",0)),int(f.get("edge",0))))
            facade_mesh_group_count+=1
        ground=float(fallback_ground if fallback_ground is not None else oldrec.get("ground_dvr90",min([v[2] for v in verts]) if verts else origin[2]))
        eaves=b.get("eave_by_ring_edge_dvr90") or []
        edgevals=eaves[0] if eaves and eaves[0] else []
        top=[]
        for vi in range(len(rings[0])):
            values=[]
            edge=edgevals[vi] if vi<len(edgevals) else None
            prev=edgevals[(vi-1)%len(edgevals)] if edgevals else None
            if edge and edge[0] is not None:values.append(float(edge[0]))
            if prev and prev[1] is not None:values.append(float(prev[1]))
            top.append(sum(values)/len(values) if values else (fallback_top if fallback_top is not None else ground+10))
        model_buildings.append({"id":bid,"fot_id":b.get("fot_id"),"address":b.get("address") or oldrec.get("address") or bid,
            "frontage_label":FRONTAGE_LABELS.get(bid),
            "year":b.get("year") or oldrec.get("year"),"storeys_register":b.get("storeys_register") or oldrec.get("storeys_register"),
            "footprint_rings_epsg25832":rings,"footprint_epsg25832":rings[0],"footprint_holes_epsg25832":rings[1:],
            "footprint_local_xz":[[p[0]-origin[0],-(p[1]-origin[1])] for p in rings[0]],
            "ground_dvr90":ground,"eave_boundary_dvr90":top,"src":src,"conf":conf,
            "confidence_basis":b.get("confidence_basis") if fitted else "Inferred footprint envelope; flat cap, no Roofer mesh",
            "reason":b.get("reason"),"triangle_count":len(ix) if fitted else 0,
            "source_vertex_patch_triangle_count":len(patched_triangles),
            "source_vertex_patch_triangle_ids":sorted(patched_triangles),
            "geometry_status":"roofer_fit" if fitted else "inferred_fallback_envelope",
            "fallback_top_dvr90":fallback_top,"fallback_height_basis":fallback_basis,
            "surface_wire_edges_epsg25832_dvr90":surface_wire_edges(wire_tris)})

    # Source-sampled tile material replaces hero roof photo appearance while
    # leaving every unpatched Roofer roof vertex in the source file untouched.
    for (bid,matid,geometry_conf),(tris,uvs,source_ids,triangle_sources) in roof_material_batches.items():
        source_union=[]
        for values in triangle_sources:
            for value in values:
                if value not in source_union:source_union.append(value)
        glb.triangles(f"{bid}/Roof material/{matid}/{geometry_conf}",tris,detail_material_indices[matid],
            {"building_id":bid,"element":"Terracotta roof tiles",
             "conf":geometry_conf,"src":source_union+["Danish clay tile colour sampled from licensed Nyhavn street reference",
                 "Procedural repeating tile relief; tile spacing inferred at metre scale"],
             "appearance_confidence":"inferred","feature_ids":source_ids,"source_triangle_ids":source_ids,"triangle_sources":triangle_sources,
             "texture_repeat_m":roof_tile_sizes.get(matid,[.30,.36])},uvs)

    detail_sources=((facade_detail_doc,True,False),(roof_detail_doc,True,True),(quay_detail_doc,False,False))
    detail_alignment_tris=defaultdict(lambda:defaultdict(list))
    detail_alignment_edges=defaultdict(list)
    for trace in facade_detail_doc.get("traces",[]) or []:
        if str(trace.get("element") or "").lower() not in {"window","door","round_window"}:continue
        bid=normalized_building_id(trace.get("building_id"));edge=int(trace.get("edge",-1))
        face=facade_map.get((bid,edge)) or facade_map.get((bid.removeprefix("kk:"),edge))
        quad=trace.get("source_quad_world_uv") or []
        if not face or len(quad)<3:continue
        start=face["coordinates"]["start"];end=face["coordinates"]["end"]
        dx=float(end[0])-float(start[0]);dy=float(end[1])-float(start[1]);length=math.hypot(dx,dy) or 1
        normal=face.get("normal_xy") or face.get("normal") or [0,0]
        nl=math.hypot(float(normal[0]),float(normal[1])) or 1
        points=[[float(start[0])+dx/length*float(u)+float(normal[0])/nl*.025,
                 float(start[1])+dy/length*float(u)+float(normal[1])/nl*.025,
                 float(z)] for u,z in quad]
        for i,p0 in enumerate(points):detail_alignment_edges[bid].append([p0,points[(i+1)%len(points)]])
    detail_feature_ids=set();detail_triangle_count=0;detail_roof_triangle_count=0;detail_facade_triangle_count=0;detail_context_triangle_count=0
    for doc,include_cityjson,is_roof_doc in detail_sources:
        for record in doc.get("meshes",[]) or []:
            bid=normalized_building_id(record.get("building_id"));matid=str(record.get("material") or record.get("material_id") or "")
            if not bid or not matid:continue
            matindex=detail_material_indices.get(matid)
            if matindex is None:
                spec=all_detail_materials.get(matid,{})
                color=spec.get("color_srgb") or record.get("color_srgb") or [.54,.27,.16]
                matindex=glb.material("Inferred detail material "+matid,linear_srgb_rgba(color),rough=float(spec.get("roughness",.9)))
                detail_material_indices[matid]=matindex
            original_element=str(record.get("element") or "architectural detail")
            element=detail_element_class(original_element)
            conf=str(record.get("conf") or "inferred")
            src=strlist(record.get("src") or record.get("source")) or ["Photo-traced detail; see detail-v3 source manifest"]
            feature=str(record.get("feature_id") or record.get("trace_id") or record.get("id") or original_element)
            trace_ids=list(map(str,record.get("trace_ids") or []))
            per_triangle_features=record.get("triangle_feature_ids") or []
            per_triangle_traces=record.get("triangle_trace_ids") or []
            semantic=str(record.get("surface_type") or record.get("semantic") or "")
            if not semantic:
                semantic="RoofSurface" if any(x in original_element.lower() for x in ("roof","dormer","chimney","flue")) else "WallSurface"
            record_tris=detail_mesh_triangles(record)
            align_feature=alignment_feature(record,is_roof_doc)
            if align_feature and is_roof_doc and bid!="context":
                detail_alignment_tris[bid][align_feature].extend(record_tris)
            for tri_index,tri in enumerate(record_tris):
                local_tri=[local(p,origin) for p in tri]
                key=(bid,matid,element,conf,semantic)
                batch=detail_batches[key]
                triangle_feature=(per_triangle_features[tri_index] if tri_index<len(per_triangle_features) else
                                  (trace_ids[0] if len(trace_ids)==1 else feature))
                triangle_trace=(per_triangle_traces[tri_index] if tri_index<len(per_triangle_traces) else trace_ids)
                batch[0].append(local_tri);batch[1].append(str(triangle_feature));batch[2].append(src)
                batch[3].append(list(map(str,triangle_trace)));batch[4].append(tri)
                detail_feature_ids.add(f"{bid}/{feature}");detail_triangle_count+=1
                if bid=="context":detail_context_triangle_count+=1
                elif semantic=="RoofSurface":detail_roof_triangle_count+=1
                else:detail_facade_triangle_count+=1
                if include_cityjson:
                    face_src=src+["detail feature:"+str(triangle_feature)]+["trace:"+str(t) for t in triangle_trace]
                    if matid in detail_material_notes:face_src.append("appearance adjustment:"+detail_material_notes[matid])
                    city_faces.append((bid,semantic,tri,conf,face_src))
    detail_batch_count=0
    detail_building_by_id={b["id"]:b for b in model_buildings}
    for (bid,matid,element,conf,semantic),(tris,features,sources,trace_ids,world_tris) in detail_batches.items():
        source_union=[]
        for values in sources:
            for value in values:
                if value not in source_union:source_union.append(value)
        material_spec=all_detail_materials.get(matid,{})
        source_union+=strlist(material_spec.get("src"))+strlist(material_spec.get("sample"))
        detail_building=detail_building_by_id.get(bid,{})
        detail_rings=detail_building.get("footprint_rings_epsg25832") or []
        detail_ground=float(detail_building.get("ground_dvr90",origin[2]))
        detail_uvs=([wall_metric_uv(t,detail_rings[0],detail_ground,[.46,.12]) for t in world_tris]
                    if matid in red11_brick_materials and detail_rings else None)
        glb.triangles(f"{bid}/detail/{element}/{matid}",tris,detail_material_indices[matid],
            {"building_id":bid,"element":element,"conf":conf,"src":source_union,
             "feature_ids":features,"triangle_sources":sources,
             "triangle_trace_ids":trace_ids,
             "material_adjustment":detail_material_notes.get(matid),
             "confidence_basis":"photo-traced or source-informed supplemental detail; dimensions inferred"},
            detail_uvs,vertex_normals=None)
        detail_batch_count+=1

    label_count=0;label_sources=[]
    for label in facade_detail_doc.get("labels",[]) or []:
        bid=normalized_building_id(label.get("building_id"));quad=label.get("world_quad_epsg25832_dvr90") or []
        texture=detail_image(label.get("texture_path"),preserve_alpha=True)
        if len(quad)!=4 or not texture:continue
        points=[list(map(float,p[:3])) for p in quad]
        normal=label.get("normal_xy") or [0,0];length=math.hypot(float(normal[0]),float(normal[1])) or 1
        points=[[p[0]+float(normal[0])/length*.012,p[1]+float(normal[1])/length*.012,p[2]] for p in points]
        tris=[[points[0],points[1],points[2]],[points[0],points[2],points[3]]]
        uv_triangles=[[[0,1],[1,1],[1,0]],[[0,1],[1,0],[0,0]]]
        mat=glb.material("Photo-derived storefront lettering "+str(label.get("text") or bid),[1,1,1,1],
            texture=texture,rough=.92,alpha="BLEND")
        src=strlist(label.get("source")) or ["Licensed Nyhavn street-reference sign crop"]
        feature=str(label.get("text") or "storefront lettering")
        glb.triangles(f"{bid}/detail/storefront lettering",[[local(p,origin) for p in tri] for tri in tris],mat,
            {"building_id":bid,"element":"Photo-traced storefront lettering","conf":"inferred","src":src,
             "feature_ids":[feature,feature],"triangle_sources":[src,src],
             "appearance_only":True,
             "confidence_basis":"lettering crop traced to the facade; world dimensions inferred"},uv_triangles)
        label_sources+=src;label_count+=1;detail_feature_ids.add(f"{bid}/{feature}");detail_triangle_count+=2
        detail_facade_triangle_count+=2
        for tri in tris:city_faces.append((bid,"WallSurface",tri,"inferred",src+["storefront lettering:"+feature]))
    facade_feature_counts=(facade_detail_doc.get("validation",{}).get("feature_counts") or {})
    facade_opening_count=sum(int(v) for v in facade_feature_counts.values())
    roof_metrics=roof_detail_doc.get("metrics",{})
    roof_window_feature_count=int(roof_metrics.get("roof_window_features",0))
    chimney_feature_count=int(roof_metrics.get("chimney_flue_features",0))
    reported_detail_feature_count=facade_opening_count+roof_window_feature_count+chimney_feature_count+label_count

    for record in model_buildings:
        by_feature=detail_alignment_tris.get(record["id"],{})
        detail_edges=list(detail_alignment_edges.get(record["id"],[]))
        for triangles in by_feature.values():detail_edges.extend(surface_wire_edges(triangles))
        record["detail_wire_edges_epsg25832_dvr90"]=detail_edges
    if not model_buildings:raise ValueError("No Roofer records had usable footprints")
    footprint_union=unary_union(footprint_polys)
    water,water_src=parse_water(SOURCES/"context/osm-nyhavn.osm")
    with rasterio.open(SOURCES/"dhm/dhm_dtm_nyhavn.tif") as ds:db=ds.bounds
    bounds=(max(db.left,footprint_union.bounds[0]-26),max(db.bottom,footprint_union.bounds[1]-24),
            min(db.right,footprint_union.bounds[2]+26),min(db.top,footprint_union.bounds[3]+24))
    ground,ground_inferred,terrain_repaired_vertex_count,shoreline_segments=mesh_terrain(
        SOURCES/"dhm/dhm_dtm_nyhavn.tif",footprint_union,water,bounds)
    watermesh=mesh_water(water)
    hero_parts=[Polygon(b.get("footprint_rings_epsg25832",[])[0]) for b in buildings
                if str(b.get("id") or "kk:"+str(b.get("fot_id"))) in FRONTAGE_LABELS and b.get("footprint_rings_epsg25832")]
    hero_frontage=unary_union(hero_parts) if hero_parts else None
    quay_plain,quay_photo,quay_photo_uvs=mesh_quay(water,shoreline_segments,hero_frontage)
    quay_texture=make_quay_texture()
    quay_photo_mat=glb.material("Observed timber quay texture · News Øresund 2022",
        texture=quay_texture,rough=.93,repeat_s=True) if quay_texture else None
    def add_photos(label,tris,plainmat,src,conf,photo=True,photo_filter=None,inferred_mask=None,normals=None,plain_uv_callback=None):
        groups=defaultdict(lambda:([],[],[]));plain={False:([],[],[]),True:([],[],[])}
        for ti,tri in enumerate(tris):
            is_inferred=bool(inferred_mask[ti]) if inferred_mask is not None and ti<len(inferred_mask) else False
            selected=best_camera(cameras,tri) if photo and (photo_filter is None or photo_filter(tri)) else None
            local_tri=[local(p,origin) for p in tri]
            local_normals=normals[ti] if normals is not None and ti<len(normals) else None
            if selected:
                _,cam,uv=selected;bucket=groups[(cam["view_id"],is_inferred)]
                bucket[0].append(local_tri);bucket[1].append(uv);bucket[2].append(local_normals)
            else:
                bucket=plain[is_inferred];bucket[0].append(local_tri)
                bucket[1].append(plain_uv_callback(tri) if plain_uv_callback else None)
                bucket[2].append(local_normals)
        for (cid,is_inferred),(ts,uv,norms) in groups.items():
            material=cameramats[cid]
            extra_src=src+[f"Skråfoto:{cid}"]
            if is_inferred:extra_src.append("DHM near-shore zero sample replaced with nearby positive land elevation")
            smooth=norms if all(n is not None for n in norms) else None
            glb.triangles(f"Context/{label}/{cid}"+("/inferred-shore" if is_inferred else ""),ts,material,
                {"building_id":"context","element":label,"conf":"inferred" if is_inferred else conf,"src":extra_src,
                 "confidence_basis":"near-shore DTM zero replaced by median nearby positive land samples" if is_inferred else "DHM DTM geometry",
                 "appearance":"calibrated nadir photo projected to the source geometry"},uv,smooth)
        for is_inferred,(plain_tris,plain_uvs,plain_normals) in plain.items():
            if plain_tris:
                extra_src=src+["DHM near-shore zero sample replaced with nearby positive land elevation"] if is_inferred else src
                reason=("Near-shore DTM zero sample replaced with a median of nearby positive land samples; material is inferred stone color"
                        if is_inferred else "No calibrated nadir photo coverage; material is inferred stone color")
                uvs=plain_uvs if all(uv is not None for uv in plain_uvs) else None
                smooth=plain_normals if all(n is not None for n in plain_normals) else None
                glb.triangles(f"Context/{label}/fallback"+("/inferred-shore" if is_inferred else ""),plain_tris,plainmat,
                    {"building_id":"context","element":label,"conf":"inferred","src":extra_src,"reason":reason},uvs,smooth)
    hero_zone=hero_frontage.buffer(26) if hero_frontage is not None else None
    def keep_nadir_ground(tri):
        if hero_zone is None:return True
        center=Point(sum(p[0] for p in tri)/3,sum(p[1] for p in tri)/3)
        return not hero_zone.covers(center)
    _,terrain_normals=smooth_vertex_normals(ground,origin)
    add_photos("DHM terrain",ground,groundmat,["DHM Terræn 1 m","Jenny Andersson / News Øresund 2022, CC BY 2.0 (stone colour reference)"],
        "observed",photo_filter=keep_nadir_ground,inferred_mask=ground_inferred,normals=terrain_normals,
        plain_uv_callback=lambda tri:metric_uv([tri],[.55,.55],[origin[0],origin[1]])[0])
    # Nadir water pixels contain boats and quay clutter that become false, flat
    # geometry at water level. Use the mapped OSM surface with a restrained
    # procedural ripple appearance instead of projecting those objects.
    axis_line=base.get("scope",{}).get("line_epsg25832") or []
    if len(axis_line)>=2:
        wa=np.asarray(axis_line[-1][:2],dtype=float)-np.asarray(axis_line[0][:2],dtype=float)
    else:wa=np.asarray([1.0,0.0])
    wa=wa/(np.linalg.norm(wa) or 1);wn=np.asarray([-wa[1],wa[0]])
    water_uv_origin=np.asarray(axis_line[0][:2],dtype=float) if axis_line else np.asarray(origin[:2],dtype=float)
    def water_uv(tri):
        result=[]
        for p in tri:
            delta=np.asarray(p[:2],dtype=float)-water_uv_origin
            result.append([float(np.dot(delta,wa)/4.0),float(np.dot(delta,wn)/1.4)])
        return result
    add_photos("Nyhavn water",watermesh,watermat,["OSM water relation 6476337","water level 0 m DVR90",
        "Procedural calm ripples; appearance inferred, no vessel geometry"],"observed",photo=False,plain_uv_callback=water_uv)
    if quay_plain:
        glb.triangles("Context/Quay retaining faces · inferred",[[local(p,origin) for p in t] for t in quay_plain],quaymat,
            {"building_id":"context","element":"Quay retaining face","conf":"inferred",
             "src":["OSM Nyhavn water boundary 6476337","DHM Terræn landward samples"],
             "reason":"Waterline is mapped; face profile is interpolated from nearby terrain"})
    if quay_photo and quay_photo_mat is not None:
        glb.triangles("Context/Quay timber face · 2022 photo",[[local(p,origin) for p in t] for t in quay_photo],quay_photo_mat,
            {"building_id":"context","element":"Timber quay face","conf":"inferred",
             "src":["OSM Nyhavn water boundary 6476337","DHM Terræn landward samples",
                    "Jenny Andersson / News Øresund 2022, CC BY 2.0"],
             "appearance_only":True,
             "appearance":"street-reference timber texture repeated at approximately 5.5 m per source crop",
             "reason":"Observed timber construction; wall elevations and texture scale are contextual approximations"},
            quay_photo_uvs)

    # CityJSON stores the roofer building shell with per-face semantics/provenance.
    city_vertices=[];lookup={};city_objects={}
    def vid(p):
        key=tuple(int(round((float(p[i])-origin[i])*1000)) for i in range(3))
        if key not in lookup:lookup[key]=len(city_vertices);city_vertices.append(list(key))
        return lookup[key]
    face_groups=defaultdict(list)
    for item in city_faces:face_groups[item[0]].append(item[1:])
    source_by={str(b.get("id") or "kk:"+str(b.get("fot_id"))):b for b in buildings}
    for bid,faces in face_groups.items():
        bounds0=[];types=[];values=[]
        for typ,tri,conf,src in faces:
            bounds0.append([[vid(p) for p in tri]])
            types.append({"type":typ,"attributes":{"confidence":conf,"source":src}})
            values.append(len(types)-1)
        b=source_by.get(bid,{})
        city_objects[bid]={"type":"Building","attributes":{"address":b.get("address"),"fot_id":b.get("fot_id"),
            "source":strlist(b.get("source") or b.get("src")),"confidence":b.get("conf") or "inferred",
            "confidence_basis":b.get("confidence_basis"),"reason":b.get("reason")},
            "geometry":[{"type":"MultiSurface","lod":"2.2","boundaries":bounds0,
                         "semantics":{"surfaces":types,"values":values}}]}
    all_positions=[[origin[0]+v[0]*.001,origin[1]+v[1]*.001,origin[2]+v[2]*.001] for v in city_vertices]
    ext=[min((p[0] for p in all_positions),default=0),min((p[1] for p in all_positions),default=0),
         min((p[2] for p in all_positions),default=0),max((p[0] for p in all_positions),default=0),
         max((p[1] for p in all_positions),default=0),max((p[2] for p in all_positions),default=0)]
    city={"type":"CityJSON","version":"2.0","metadata":{"referenceSystem":"https://www.opengis.net/def/crs/EPSG/0/25832",
        "title":"Nyhavn Roofer fits, source-informed details and inferred fallback envelopes","geographicalExtent":ext},
        "transform":{"scale":[.001,.001,.001],"translate":origin},"CityObjects":city_objects,"vertices":city_vertices}
    glb.save(V2/"building.glb")
    (V2/"building.city.json").write_text(json.dumps(city,ensure_ascii=False,separators=(",",":")))
    model={"version":"nyhavn-waterfront/3","generated":datetime.now(timezone.utc).isoformat(),
        "frame":{"epsg":25832,"vertical":"DVR90","origin":origin,"axes_glb":"x=east, y=up, z=south","axes_cityjson":"x=east, y=north, z=up"},
        "scope":base.get("scope",{}),"cameras":public_cameras,"buildings":model_buildings,
        "viewer_presets":make_view_presets(model_buildings,base.get("scope",{}),origin),
        "methods":{"building_geometry":f"{fitted_count} Roofer roof and wall fits plus {fallback_count} inferred fallback envelopes; localized red 11 source-vertex roof correction affects {roof_source_patch_triangle_count} Roofer triangles; raw roofer-roofs.json is preserved",
            "facade_appearance":f"{len(facade_edges)} remaining photo-textured frontage edges plus {len(replaced_facades)} hero fronts replaced by photo-traced inferred wall/opening detail meshes; Nyhavn 11 uses low-contrast inferred running-bond brick coursing over source-sampled red brick color",
            "roof_appearance":f"{len(roof_material_overrides)} hero roofs use inferred metre-scaled terracotta tile appearance; {detail_roof_triangle_count} photo-traced roof details supplement source geometry; other roofs use calibrated nadir Skråfoto where visible",
            "ground_context":"DHM Terræn geometry clipped to footprints and mapped water; near-shore zero samples are replaced with nearby positive land elevations and marked inferred; calibrated nadir texture away from the hero quay, inferred matte stone material near the hero photo frontage",
            "water_context":"OSM relation 6476337 water polygon at 0 m DVR90; a restrained procedural ripple texture avoids ghosted nadir boats and implies no vessel geometry",
            "quay_context":"OSM shoreline, landward DHM elevations, attributed timber reference texture, and source-observed café parasols at inferred placements",
            "openings":"photo-traced facade windows, doors, cornices and storefront details are supplemental inferred geometry on five hero fronts; no generic neighboring windows are invented"},
        "sources":{"roofer":"model-v2/roofer-roofs.json","roofer_sha256":roofer_source_sha256,"facades":"facade-v2/manifest.json",
            "facade_details":"detail-v3/facades.json","roof_details":"detail-v3/roofs.json","quay_details":"detail-v3/quay.json",
            "kk":"sources/kk/kk_bygning_corridor.geojson","dhm":"sources/dhm/dhm_dtm_nyhavn.tif",
            "skraafoto":photo_root+"/cameras.json","osm":"sources/context/osm-nyhavn.osm",
            "street_references":"sources/street-reference/sources.json"},
        "context":{"water_relation":water_src,"water_level_dvr90":0,"terrain_bounds_epsg25832":list(bounds),
                   "terrain_grid_m":4,"near_shore_dtm_zero_repair_m":8.0,
                   "terrain_edge_interpolation":"median of nearest positive land DTM samples; affected triangles flagged inferred",
                   "confidence":"DHM/OSM source geometry with inferred near-shore repairs and quay profiles"},
        "facade_coverage":{"usable_source_edges":len(facades),"photo_textured_edges":len(facade_edges),
            "modeled_replacement_fronts":len(replaced_facades),"photo_texture_mesh_groups":facade_mesh_group_count,
            "unavailable_edges":facdoc.get("unavailable_facades",[]),"unavailable_count":len(facdoc.get("unavailable_facades",[]))},
        "detail_v3":{"facade_openings":facade_opening_count,"roof_window_features":roof_window_feature_count,
            "chimney_flue_features":chimney_feature_count,"storefront_signs":label_count,"mesh_batches":detail_batch_count,
            "triangles":detail_triangle_count,"facade_triangles":detail_facade_triangle_count,
            "roof_triangles":detail_roof_triangle_count,"context_triangles":detail_context_triangle_count,
            "red11_brick_repeat_m":[.46,.12],
            "storefront_labels":label_count,
            "photo_alignment_detail_edges":sum(len(b.get("detail_wire_edges_epsg25832_dvr90",[])) for b in model_buildings),
            "inference":"Supplemental facade/roof dimensions and tile pattern are inferred from licensed street references and visible aerial evidence."},
        "metrics":{"building_count":len(model_buildings),"roofer_fit_count":fitted_count,"inferred_fallback_count":fallback_count,
            "roofer_source_sha256":roofer_source_sha256,
            "facade_texture_count":len(facade_edges),"facade_mesh_group_count":facade_mesh_group_count,
            "facade_unavailable_count":len(facdoc.get("unavailable_facades",[])),
            "facade_photo_edge_count":len(facade_edges),"facade_detail_front_count":len(replaced_facades),
            "facade_manifest_usable_count":len(facades),"facade_replaced_source_triangle_count":replaced_facade_triangle_count,
            "roof_triangle_count":roof_count,"roofer_roof_triangle_count":roof_count,"wall_triangle_count":wall_count,
            "roofer_wall_triangle_count":wall_count,"source_roof_patch_triangle_count":roof_source_patch_triangle_count,
            "source_patch_collapsed_triangle_count":source_patch_collapsed_triangle_count,
            "roof_material_override_count":len(roof_material_overrides),"roof_tile_triangle_count":sum(len(v[0]) for v in roof_material_batches.values()),
            "detail_feature_count":reported_detail_feature_count,"detail_opening_count":facade_opening_count,
            "roof_window_feature_count":roof_window_feature_count,"chimney_feature_count":chimney_feature_count,
            "detail_triangle_count":detail_triangle_count,
            "detail_facade_triangle_count":detail_facade_triangle_count,"detail_roof_triangle_count":detail_roof_triangle_count,
            "detail_context_triangle_count":detail_context_triangle_count,
            "detail_mesh_batch_count":detail_batch_count,"detail_label_count":label_count,
            "photo_alignment_detail_edge_count":sum(len(b.get("detail_wire_edges_epsg25832_dvr90",[])) for b in model_buildings),
            "fallback_roof_triangle_count":fallback_roof_count,"fallback_wall_triangle_count":fallback_wall_count,
            "terrain_triangle_count":len(ground),"terrain_interpolated_vertex_count":terrain_repaired_vertex_count,
            "terrain_interpolated_triangle_count":sum(ground_inferred),
            "water_triangle_count":len(watermesh),"quay_triangle_count":len(quay_plain)+len(quay_photo),
            "quay_photo_triangle_count":len(quay_photo),"glb_mesh_count":len(glb.meshes)}}
    (V2/"building.json").write_text(json.dumps(model,ensure_ascii=False,separators=(",",":")))
    (V2/"building.mesh.json").write_text(json.dumps({"frame":model["frame"],"source":"building.json",
        "note":"Roofer surfaces, photo textures and mapped context are embedded in building.glb; provenance is recorded on nodes."},separators=(",",":")))
    return model,city

def validate(model,city):
    raw=(V2/"building.glb").read_bytes()
    if len(raw)<20 or raw[:4]!=b"glTF" or struct.unpack("<I",raw[4:8])[0]!=2:raise ValueError("Invalid GLB header/version")
    if struct.unpack("<I",raw[8:12])[0]!=len(raw):raise ValueError("GLB declared file length mismatch")
    jl=struct.unpack("<I",raw[12:16])[0]
    if raw[16:20]!=b"JSON":raise ValueError("GLB JSON chunk absent")
    gltf=json.loads(raw[20:20+jl]);bl=struct.unpack("<I",raw[20+jl:24+jl])[0]
    for v in gltf.get("bufferViews",[]):
        if v.get("byteOffset",0)+v["byteLength"]>bl:raise ValueError("GLB view exceeds binary payload")
    for n in gltf.get("nodes",[]):
        if "conf" not in n.get("extras",{}) or "src" not in n.get("extras",{}):raise ValueError("Node provenance absent: "+n["name"])
    count=0
    for obj in city.get("CityObjects",{}).values():
        for g in obj.get("geometry",[]):
            if len(g["semantics"]["surfaces"])!=len(g["boundaries"]):raise ValueError("CityJSON semantics count mismatch")
            count+=len(g["boundaries"])
            for face in g["boundaries"]:
                for ring in face:
                    if any(x<0 or x>=len(city["vertices"]) for x in ring):raise ValueError("CityJSON vertex index invalid")
    metrics={**model["metrics"],"glb_bytes":len(raw),"glb_mesh_count":len(gltf.get("meshes",[])),
        "glb_image_count":len(gltf.get("images",[])),"glb_texture_count":len(gltf.get("textures",[])),
        "glb_has_embedded_textures":bool(gltf.get("images")),"glb_structural_load":"passed",
        "all_nodes_have_provenance":True,"cityjson_objects":len(city.get("CityObjects",{})),
        "cityjson_surfaces":count,"cityjson_vertex_count":len(city["vertices"]),"cityjson_semantics_valid":True,
        "limitations":[
        "Five hero front walls use photo-traced supplemental openings, reveals, cornices and storefront details whose world dimensions are inferred.",
        "The red 11 roof source-vertex patch is a localized source-informed correction; the original Roofer document remains unchanged.",
        "The repeating clay tile and stone paving textures are procedural appearance detail with inferred metre-scale spacing.",
        "Nyhavn 11 brick coursing follows source-sampled red wall color; 0.23 m brick width and 0.06 m course height are inferred.",
        "Café parasol shapes are photo-observed; their size and placement on the quay are inferred.",
        "Remaining photo layers use matching-edge aerial fills and source-sampled wall paint; source photo masks are not extended across unavailable areas.",
        "Near-shore DTM zero elevations within 8 m of the mapped shoreline are replaced by nearby positive land samples and flagged inferred.",
        "Wall envelope and quay vertical profiles are inferred where direct height evidence is absent.",
        "The model is a source-linked visual reconstruction, not survey-grade geometry."]}
    VALIDATION.mkdir(parents=True,exist_ok=True)
    (VALIDATION/"metrics.json").write_text(json.dumps(metrics,indent=2,ensure_ascii=False))
    return metrics

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("command",choices=("build",),nargs="?",default="build");parser.parse_args()
    for p in (V2,VIEWER,VALIDATION):p.mkdir(parents=True,exist_ok=True)
    model,city=run_build();metrics=validate(model,city)
    target=OUT/"scripts/build_v2.py";target.parent.mkdir(parents=True,exist_ok=True)
    if Path(__file__).resolve()!=target.resolve():shutil.copy2(__file__,target)
    print(f"Built v2: {metrics['building_count']} buildings, {metrics['facade_texture_count']} photo facades, {metrics['roof_triangle_count']:,} roof triangles.")
    print(f"GLB {metrics['glb_bytes']:,} bytes; {metrics['glb_mesh_count']} meshes; {metrics['glb_image_count']} images; CityJSON {metrics['cityjson_surfaces']:,} surfaces.")

if __name__=="__main__":main()
