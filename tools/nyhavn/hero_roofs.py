#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "shapely"]
# ///
"""Photo-traced Nyhavn 9–17 roof detail, absolute EPSG:25832 / DVR90.

Presence is observed; dimensions and hidden construction are inferred. Source
Roofer data is immutable. An explicit vertex patch corrects only the red front
strip where the fit merged four dormers into a false raised roof/wall band.
"""
from __future__ import annotations
import argparse, json, math, shutil
from collections import defaultdict
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Point, Polygon

DEFAULT = Path.home()/'.local/share/building-case-3d/nyhavn'
HERO = {'9':('1064714861',5), '11':('1202806702',20), '13':('1111146131',3),
        '15':('1064715124',12), '17':('1088186424',15)}
# Boxes below were read in the original 5760×3840 2018 photograph. Fractions
# derive from each observed window's position along its own facade, not a grid.
DORMERS = {
 '11':[(.17,.128,(885,765,1113,1014)),(.39,.132,(1128,735,1359,960)),
       (.61,.137,(1344,711,1596,930)),(.84,.136,(1596,684,1833,897))],
 '13':[(.19,.145,(1899,723,2043,870)),(.50,.149,(2169,675,2313,834)),
       (.81,.147,(2436,633,2589,795))],
 '15':[(.29,.225,(2928,1017,3135,1278)),(.69,.228,(3243,966,3459,1242))],
 '17':[(.20,.167,(3690,927,4020,1173)),(.51,.180,(4170,882,4491,1146)),
       (.82,.193,(4704,840,5016,1104))],
}
CHIMNEYS = {
 '9': {'box':(710,460,855,805),'year':'2022','center_en':(725603.5602595832,6176379.592860054),'height':4.45,'width':.88,'depth':.72},
 '11':{'box':(2133,294,2256,465),'year':'2018','fraction':.96,'inward':4.65,'height':1.45,'width':.72,'depth':.65},
 '13':{'box':(2637,144,2760,330),'year':'2018','fraction':.64,'inward':4.55,'height':1.55,'width':.72,'depth':.65},
 '15':{'box':(3294,639,3378,978),'year':'2018','fraction':.64,'inward':4.15,'height':1.85,'width':.16,'depth':.16,'kind':'metal_flue'},
 '17':{'box':(4275,363,4488,714),'year':'2018','fraction':.48,'inward':4.30,'height':2.35,'width':1.10,'depth':.85},
}


def load(path): return json.loads(path.read_text())


class Builder:
    def __init__(self, project):
        self.project=project;self.out=project/'detail-v3';self.diag=self.out/'roof-diagnostics'
        self.diag.mkdir(parents=True,exist_ok=True)
        self.roofer=load(project/'model-v2/roofer-roofs.json')['buildings']
        self.materials={
          'terracotta_tiles':{'color_srgb':[.72,.39,.25],'roughness':.9,'texture_repeat_m':[.30,.36],
            'appearance':'inferred procedural tile pattern; median hue sampled from visible terracotta'},
          'dormer_zinc':{'color_srgb':[.46,.48,.47],'roughness':.8},
          'dormer_cap':{'color_srgb':[.19,.20,.19],'roughness':.8},
          'frame_white':{'color_srgb':[.88,.87,.80],'roughness':.72},
          'frame_green':{'color_srgb':[.24,.31,.27],'roughness':.75},
          'frame_grey':{'color_srgb':[.35,.39,.39],'roughness':.75},
          'glass':{'color_srgb':[.18,.25,.27],'roughness':.24},
          'recess':{'color_srgb':[.15,.18,.17],'roughness':.85},
          'chimney_masonry':{'color_srgb':[.58,.57,.50],'roughness':.96},
          'chimney_cap':{'color_srgb':[.43,.43,.38],'roughness':.93},
          'flue_metal':{'color_srgb':[.59,.62,.61],'roughness':.48},
        }
        self.meshes=[];self.traces=[];self.overrides=[];self.frames={};self.attachment=[]
        for label,(fot,edge) in HERO.items():
            b=self.roofer[fot];ring=b['footprint_rings_epsg25832'][0];a=np.array(ring[edge]);z=np.array(ring[(edge+1)%len(ring)]);u=z-a;length=np.linalg.norm(u);u/=length
            self.frames[label]=(a,u,np.array([-u[1],u[0]]),length)
        self.patch_red()
        self.triangles={}
        for label,(fot,_) in HERO.items():
            b=self.roofer[fot];v=np.array(b['vertices_epsg25832_dvr90']);
            if label=='11':
                for upd in self.overrides[0]['vertex_height_updates']:v[upd['vertex'],2]=upd['height_dvr90']
            self.triangles[label]=[t for t,s in zip(v[np.array(b['triangles'])],b['triangle_surface_type']) if s=='RoofSurface']

    def xyz(self,label,s,d,h):
        a,u,v,_=self.frames[label];q=a+u*s+v*d;return [float(q[0]),float(q[1]),float(h)]

    def roof(self,label,s,d):
        xy=self.xyz(label,s,d,0)[:2];hs=[]
        for t in self.triangles[label]:
            n=np.cross(t[1]-t[0],t[2]-t[0])
            if abs(n[2])<1e-7:continue
            if Polygon(t[:,:2]).buffer(.002).covers(Point(xy)):
                hs.append(t[0,2]-np.dot(n[:2],np.array(xy)-t[0,:2])/n[2])
        if not hs:raise ValueError(f'No roof attachment at {label} s={s:.2f} d={d:.2f}')
        return float(max(hs))

    def trace(self,label,name,box,year='2018',extra=None):
        file=f'nyhavn-9-17-{year}.jpg';size=(5760,3840) if year=='2018' else (4032,3024)
        src=f'photo:{file}#px={",".join(map(str,box))}@{size[0]}x{size[1]}'
        record={'id':name,'building_id':'kk:'+HERO[label][0],'source_file':'sources/street-reference/'+file,
            'source_box_px':list(box),'source_image_size':list(size),'presence':'observed',
            'dimensions':'inferred from frontage span, visible proportions and roof attachment',
            'conf':'inferred','src':[src]}
        if extra:record.update(extra)
        self.traces.append(record);return [src,'roofer:2019:'+HERO[label][0]+':roof-attachment']

    def emit(self,label,element,material,tris,src):
        good=[]
        for t in tris:
            q=np.asarray(t,dtype=float)
            if not np.isfinite(q).all():raise ValueError(element+' non-finite')
            if np.linalg.norm(np.cross(q[1]-q[0],q[2]-q[0]))>1e-8:good.append(q.tolist())
        if good:self.meshes.append({'building_id':'kk:'+HERO[label][0],'element':element,'material':material,
                                  'triangles':good,'conf':'inferred','src':src})

    def quad(self,label,element,mat,points,src):
        self.emit(label,element,mat,[[points[0],points[1],points[2]],[points[0],points[2],points[3]]],src)

    def box(self,label,element,mat,s0,s1,d0,d1,z0,z1,src):
        p=[self.xyz(label,s,d,z) for z in (z0,z1) for d in (d0,d1) for s in (s0,s1)]
        # Bottom, front, back, left, right, and top, outward winding.
        faces=[(0,2,3,1),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5),(4,5,7,6)]
        self.emit(label,element,mat,[[p[f[0]],p[f[1]],p[f[2]]] for f in faces]+[[p[f[0]],p[f[2]],p[f[3]]] for f in faces],src)

    def patch_red(self):
        label='11';b=self.roofer[HERO[label][0]];a,u,v,length=self.frames[label];verts=np.array(b['vertices_epsg25832_dvr90']);updates=[]
        for i,p in enumerate(verts):
            s=float((p[:2]-a)@u);d=float((p[:2]-a)@v);target=17.277+1.12*max(0,d)
            if -.02<=s<=length+.5 and -.02<=d<=1.9 and 17.25<p[2]<19.51 and p[2]>target+.05:
                updates.append({'vertex':i,'height_dvr90':round(target,5)})
        ids={x['vertex'] for x in updates};affected=[i for i,t in enumerate(b['triangles']) if ids.intersection(t)]
        src=self.trace(label,'red11-false-roof-band',(760,650,1850,1040),extra={'decision':'Replace only the fitted flat dormer strip by the underlying front pitch; real dormers are separate meshes.'})
        self.overrides=[{'building_id':b['id'],'type':'source_vertex_height_patch','vertex_height_updates':updates,
            'affected_triangle_ids':affected,'conf':'inferred','src':src,
            'reason':'Four visible projecting dormers were flattened into a raised roof/front-wall strip. Lower source vertices locally to the front pitch z=17.277+1.12*inward_depth; preserve the rest of the compound.',
            'scope':{'front_edge':20,'u_min_m':-.02,'u_max_m':float(length+.5),'inward_depth_min_m':-.02,'inward_depth_max_m':1.9,'height_min_dvr90':17.25,'height_max_dvr90':19.51}}]

    def dormer(self,label,index,fraction,width_fraction,box):
        name=f'Nyhavn {label} roof window {index+1}';src=self.trace(label,name,box)
        _,_,_,L=self.frames[label];s=L*fraction;width=L*width_fraction
        shallow=label=='13';front=.32 if label=='11' else .46 if shallow else .62
        height=1.78 if label=='11' else 1.15 if shallow else 1.68 if label=='15' else 1.75
        if label=='17' and index==2:height=1.82
        rear=front+(.74 if shallow else 1.65 if label=='11' else 1.60)
        base=self.roof(label,s,front)-.10;cap=base+height
        # Back corners terminate in the source roof; no floating box underneath.
        s0,s1=s-width/2,s+width/2
        front_base=[self.roof(label,x,front)-.12 for x in (s0,s1)]
        rear_base=[self.roof(label,x,rear)-.12 for x in (s0,s1)]
        cap=max(cap,max(rear_base)+.08)
        pts=[self.xyz(label,s0,front,front_base[0]),self.xyz(label,s1,front,front_base[1]),
             self.xyz(label,s1,rear,rear_base[1]),self.xyz(label,s0,rear,rear_base[0])]
        top=[self.xyz(label,s0,front,cap),self.xyz(label,s1,front,cap),self.xyz(label,s1,rear,cap+.04),self.xyz(label,s0,rear,cap+.04)]
        for ids in [(3,0),(1,2),(2,3)]:
            i,j=ids;self.quad(label,name+' cheek','dormer_zinc',[pts[i],pts[j],top[j],top[i]],src)
        # Low pitched metal cap with small overhang and a real front fascia.
        over=.075;apex=.035 if shallow else .11
        q=lambda ss,dd,hh:self.xyz(label,ss,dd,hh)
        for sign in (-1,1):
            edge=s+sign*(width/2+over)
            cap_points=[q(edge,front-over,cap+.04),q(edge,rear+.04,cap+.08),q(s,rear+.04,cap+.08+apex),q(s,front-over,cap+.04+apex)]
            if sign<0:cap_points.reverse()
            self.quad(label,name+' cap','dormer_cap',cap_points,src)
        frame='frame_green' if label=='15' else 'frame_grey' if label=='17' else 'frame_white'
        sill=base+.18;windowtop=cap-.17;jamb=.095;ws0=s0+jamb;ws1=s1-jamb
        # Front is built around the recessed opening, not an opaque dark decal.
        self.box(label,name+' lower panel','dormer_zinc',s0,s1,front,front+.07,min(front_base),sill,src)
        self.box(label,name+' upper panel','dormer_zinc',s0,s1,front,front+.07,windowtop,cap,src)
        self.box(label,name+' left panel','dormer_zinc',s0,ws0,front,front+.07,sill,windowtop,src)
        self.box(label,name+' right panel','dormer_zinc',ws1,s1,front,front+.07,sill,windowtop,src)
        recess=.10
        self.quad(label,name+' recessed glazing','glass',[q(ws0,front+recess,sill),q(ws1,front+recess,sill),q(ws1,front+recess,windowtop),q(ws0,front+recess,windowtop)],src)
        for x0,x1,z0,z1 in [(ws0-.025,ws0+.045,sill-.035,windowtop+.035),(ws1-.045,ws1+.025,sill-.035,windowtop+.035),(ws0,ws1,sill-.025,sill+.045),(ws0,ws1,windowtop-.045,windowtop+.025)]:
            self.box(label,name+' frame',frame,x0,x1,front-.025,front+.09,z0,z1,src)
        columns=3 if label=='17' and index==2 else 2
        for col in range(1,columns):
            x=ws0+(ws1-ws0)*col/columns;self.box(label,name+' mullion',frame,x-.025,x+.025,front+.01,front+.095,sill,windowtop,src)
        for fraction_z in ([.48] if shallow else [.35,.69]):
            h=sill+(windowtop-sill)*fraction_z;self.box(label,name+' transom',frame,ws0,ws1,front+.01,front+.095,h-.021,h+.021,src)
        self.attachment.append({'feature':name,'roof_intersection_margin_m':.12,'front_base_dvr90':front_base,'rear_base_dvr90':rear_base,'cap_dvr90':cap,'center_u_m':s,'width_m':width,'depth_m':rear-front})

    def chimney(self,label,item):
        name=f'Nyhavn {label} '+('metal flue' if item.get('kind') else 'chimney');src=self.trace(label,name,item['box'],item['year'])
        a,u,v,L=self.frames[label]
        if item.get('center_en'):
            delta=np.array(item['center_en'])-a;s=float(delta@u);d=float(delta@v)
            self.traces[-1]['placement_evidence']='2025 north oblique: native saved pixel box [1739,2166,1757,2210]; base ray intersects Nyhavn 9 roof at [725603.56026,6176379.59286,16.54625].'
        else:s=L*item['fraction'];d=item['inward']
        center_roof=self.roof(label,s,d);w=item['width'];depth=item['depth']
        corner_heights=[self.roof(label,s+du,d+dv) for du in (-w/2,w/2) for dv in (-depth/2,depth/2)]
        z=min(corner_heights)-.18;h=center_roof+item['height']-.18-z
        if item.get('kind'):
            count=16;radius=w/2
            for i in range(count):
                ang0=2*math.pi*i/count;ang1=2*math.pi*(i+1)/count
                xy=[(s+math.cos(t)*radius,d+math.sin(t)*radius) for t in (ang0,ang1)]
                self.quad(label,name+' shaft','flue_metal',[self.xyz(label,*xy[0],z),self.xyz(label,*xy[1],z),self.xyz(label,*xy[1],z+h),self.xyz(label,*xy[0],z+h)],src)
                self.emit(label,name+' hood','flue_metal',[[self.xyz(label,s+math.cos(ang0)*radius*1.8,d+math.sin(ang0)*radius*1.8,z+h),self.xyz(label,s+math.cos(ang1)*radius*1.8,d+math.sin(ang1)*radius*1.8,z+h),self.xyz(label,s,d,z+h+.16)]],src)
        else:
            self.box(label,name+' shaft','chimney_masonry',s-w/2,s+w/2,d-depth/2,d+depth/2,z,z+h,src)
            self.box(label,name+' cap band','chimney_cap',s-w/2-.055,s+w/2+.055,d-depth/2-.055,d+depth/2+.055,z+h-.23,z+h-.07,src)
            # Two mouths are visible on blue 9 in the calibrated north crop. Do not invent mouths on the other shafts.
            for dx in ([-w*.23,w*.23] if label=='9' else []):
                self.box(label,name+' flue opening','recess',s+dx-w*.14,s+dx+w*.14,d-depth*.22,d+depth*.22,z+h+.003,z+h+.018,src)
        self.attachment.append({'feature':name,'roof_intersection_margin_m':.18,'base_dvr90':z,'top_dvr90':z+h,'center_u_m':s,'inward_depth_m':d})

    def sample_tile_color(self):
        im=Image.open(self.project/'sources/street-reference/nyhavn-9-17-2022.jpg').convert('RGB');box=(1100,465,1470,575);a=np.asarray(im.crop(box)).reshape(-1,3)/255
        mask=(a[:,0]>a[:,1]*1.18)&(a[:,1]>a[:,2]*1.08)&(a[:,0]>.35)
        rgb=np.median(a[mask],axis=0).tolist();self.materials['terracotta_tiles']['color_srgb']=rgb
        self.materials['terracotta_tiles']['src']=[f'photo:nyhavn-9-17-2022.jpg#px={box[0]},{box[1]},{box[2]},{box[3]}@4032x3024']
        self.materials['terracotta_tiles']['conf']='inferred'

    def diagnostics(self):
        for year in ['2018','2022']:
            source=self.project/f'sources/street-reference/nyhavn-9-17-{year}.jpg';im=Image.open(source).convert('RGB');draw=ImageDraw.Draw(im)
            try:font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',32)
            except OSError:font=ImageFont.load_default()
            for t in self.traces:
                if not t['source_file'].endswith(f'{year}.jpg'):continue
                box=t['source_box_px'];draw.rectangle(box,outline=(252,211,70),width=7);draw.text((box[0],box[1]-38),t['id'],fill=(252,211,70),font=font,stroke_width=1,stroke_fill=(25,25,25))
            im.thumbnail((2200,1500));im.save(self.diag/f'traced-roof-features-{year}.jpg',quality=95)

    def build(self):
        for label,records in DORMERS.items():
            for i,(f,w,b) in enumerate(records):self.dormer(label,i,f,w,b)
        for label,item in CHIMNEYS.items():self.chimney(label,item)
        self.sample_tile_color();self.diagnostics()
        count=sum(len(m['triangles']) for m in self.meshes)
        doc={'schema':'nyhavn-hero-roofs/1','crs':{'horizontal':'EPSG:25832','vertical':'DVR90'},
             'materials':self.materials,'meshes':self.meshes,'roof_overrides':self.overrides,
             'roof_material_overrides':{'kk:'+fot:'terracotta_tiles' for fot,_ in HERO.values()},
             'roof_texture_frames':{'kk:'+HERO[k][0]:{'origin_en':a.tolist(),'along_eave_xy':u.tolist(),'inward_xy':v.tolist()} for k,(a,u,v,L) in self.frames.items()},
             'traces':self.traces,'attachments':self.attachment,
             'metrics':{'roof_window_features':sum(len(v) for v in DORMERS.values()),'chimney_flue_features':len(CHIMNEYS),'mesh_count':len(self.meshes),'triangle_count':count,'all_vertices_finite':all(np.isfinite(np.array(m['triangles'])).all() for m in self.meshes),'source_trace_count':len(self.traces),'red11_height_updates':len(self.overrides[0]['vertex_height_updates']),'red11_affected_source_triangles':len(self.overrides[0]['affected_triangle_ids'])},
             'limitations':['Feature presence and counts are photo-observed; all dimensions, depth, hidden faces, frame thicknesses and materials are inferred.','Roof details reflect 2018/2022 street images cross-checked against 2025 obliques, not one survey date.','Cream 13 uses shallow mansard-window projections, not large box dormers.','Red 11 patch is restricted to the mis-fitted front strip; other compound roof planes remain unchanged.','Procedural tiles replace blurry nadir appearance to avoid painted duplicates; pattern dimensions are illustrative.']}
        target=self.out/'roofs.json';temporary=target.with_suffix('.json.tmp');temporary.write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')));temporary.replace(target)
        scripts=self.project/'scripts';scripts.mkdir(exist_ok=True);dest=scripts/'hero_roofs.py'
        if Path(__file__).resolve()!=dest.resolve():shutil.copy2(__file__,dest)
        print(json.dumps(doc['metrics'],indent=2));print(target)


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--project',type=Path,default=DEFAULT);args=ap.parse_args();Builder(args.project).build()
if __name__=='__main__':main()
