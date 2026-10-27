#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "rasterio", "shapely", "pyproj"]
# ///
"""Five individually traced 2022 cafe parasols; no chairs, people or guessed row.
World placement and dimensions are inferred; footprint clearance is checked
against municipal buildings and the local OSM water polygon before exporting.
"""
from pathlib import Path
import argparse,json,math,shutil,xml.etree.ElementTree as ET
import numpy as np
import rasterio
from PIL import Image,ImageDraw
from pyproj import Transformer
from shapely.geometry import Polygon,Point,shape
from shapely.ops import unary_union

DEFAULT=Path.home()/'.local/share/building-case-3d/nyhavn'
# Five separate visible peaks; folded and heavily hidden umbrellas are omitted.
FEATURES=[
 {'id':'parasol-01','frontage':'kk:1202806702','fraction':.12,'outward':4.7,'radius':2.,'height':2.72,'angle':-8,'box':[1010,1890,1650,2055],'peak':[1330,1900]},
 {'id':'parasol-02','frontage':'kk:1202806702','fraction':.59,'outward':4.2,'radius':1.85,'height':2.68,'angle':4,'box':[1510,1910,1905,2050],'peak':[1710,1925]},
 {'id':'parasol-03','frontage':'kk:1111146131','fraction':.18,'outward':4.6,'radius':1.95,'height':2.76,'angle':0,'box':[1790,1915,2300,2075],'peak':[2005,1930]},
 {'id':'parasol-04','frontage':'kk:1064715124','fraction':.43,'outward':4.5,'radius':1.8,'height':2.70,'angle':8,'box':[2460,1935,2950,2080],'peak':[2700,1947]},
 {'id':'parasol-05','frontage':'kk:1088186424','fraction':.72,'outward':4.6,'radius':1.9,'height':2.65,'angle':-6,'box':[3050,1940,3535,2080],'peak':[3315,1959]},
]

def water_polygon(path):
 root=ET.parse(path).getroot();nodes={n.get('id'):(float(n.get('lon')),float(n.get('lat'))) for n in root.findall('node')};ways={w.get('id'):[n.get('ref') for n in w.findall('nd')] for w in root.findall('way')}
 rel=next(r for r in root.findall('relation') if r.get('id')=='6476337');rings=[list(ways[m.get('ref')]) for m in rel.findall('member') if m.get('type')=='way' and m.get('role')=='outer'];complete=[]
 while rings:
  r=rings.pop(0)
  while r[0]!=r[-1]:
   for i,q in enumerate(rings):
    if r[-1]==q[0]:r.extend(q[1:]);rings.pop(i);break
    if r[-1]==q[-1]:r.extend(q[-2::-1]);rings.pop(i);break
   else:raise ValueError('OSM water ring cannot be closed')
  complete.append(r)
 tr=Transformer.from_crs(4326,25832,always_xy=True)
 return unary_union([Polygon([tr.transform(*nodes[i]) for i in ring]) for ring in complete])


def main():
 ap=argparse.ArgumentParser();ap.add_argument('--project',type=Path,default=DEFAULT);a=ap.parse_args();p=a.project;out=p/'detail-v3';diag=out/'quay-diagnostics';diag.mkdir(parents=True,exist_ok=True)
 manifest=json.loads((p/'facade-v2/manifest.json').read_text());facades={f['building_id']:f for f in manifest['facades']}
 raw=json.loads((p/'sources/kk/kk_bygning_corridor.geojson').read_text());buildings=unary_union([shape(f['geometry']) for f in raw['features']]);water=water_polygon(p/'sources/context/osm-nyhavn.osm')
 source=Image.open(p/'sources/street-reference/nyhavn-9-17-2022.jpg').convert('RGB');assert source.size==(4032,3024)
 patch=np.asarray(source.crop((1260,1930,1410,1970))).reshape(-1,3)/255;cloth=np.median(patch[(patch.min(1)>.5)&(patch.max(1)-patch.min(1)<.25)],axis=0).tolist()
 materials={'cream_canvas':{'color_srgb':cloth,'roughness':.96},'cream_valance':{'color_srgb':[float(v*.94) for v in cloth],'roughness':.98},'parasol_pole':{'color_srgb':[.72,.69,.59],'roughness':.76}}
 meshes=[];traces=[];places=[]
 def add(name,mat,triangles,src):
  arr=np.asarray(triangles,dtype=float);assert np.isfinite(arr).all()
  meshes.append({'building_id':'context','element':name,'material':mat,'triangles':arr.tolist(),'conf':'inferred','src':src})
 with rasterio.open(p/'sources/dhm/dhm_dtm_nyhavn.tif') as ds:
  for f in FEATURES:
   edge=facades[f['frontage']];start=np.array(edge['coordinates']['start']);end=np.array(edge['coordinates']['end']);u=(end-start)/np.linalg.norm(end-start);n=np.array([u[1],-u[0]])
   center=start+(end-start)*f['fraction']+n*f['outward'];r=f['radius'];foot=Point(center).buffer(r,resolution=32)
   if foot.intersection(buildings).area>1e-6 or foot.intersection(water).area>1e-6:raise ValueError(f['id']+' canopy intrudes into water/building')
   ground=float(next(ds.sample([center]))[0]);assert math.isfinite(ground) and ground>.1
   base=ground;top=ground+f['height'];eave=top-.48;angle=math.atan2(u[1],u[0])+math.radians(f['angle']);N=8
   ring=[np.array([center[0]+r*math.cos(angle+2*math.pi*i/N),center[1]+r*math.sin(angle+2*math.pi*i/N),eave]) for i in range(N)]
   mid=[np.array([center[0]+r*.36*math.cos(angle+2*math.pi*i/N),center[1]+r*.36*math.sin(angle+2*math.pi*i/N),top-.12]) for i in range(N)];peak=np.array([*center,top]);canopy=[];valance=[]
   for i in range(N):
    j=(i+1)%N;canopy.extend([[peak,mid[i],mid[j]],[mid[i],ring[i],ring[j]],[mid[i],ring[j],mid[j]]]);lowi=ring[i]-np.array([0,0,.14]);lowj=ring[j]-np.array([0,0,.14]);valance.extend([[ring[i],lowi,lowj],[ring[i],lowj,ring[j]]])
   box=f['box'];src=[f'photo:nyhavn-9-17-2022.jpg#px={",".join(map(str,box))}@4032x3024','OSM:relation:6476337:land-clearance','DHM:terraen:1m:ground-sample']
   add(f['id']+' faceted cloth','cream_canvas',canopy,src);add(f['id']+' hanging edge','cream_valance',valance,src)
   pole=[];rad=.026
   for i in range(12):
    aa=angle+2*math.pi*i/12;bb=angle+2*math.pi*(i+1)/12;pa=np.array([center[0]+rad*math.cos(aa),center[1]+rad*math.sin(aa),base-.04]);pb=np.array([center[0]+rad*math.cos(bb),center[1]+rad*math.sin(bb),base-.04]);qa=pa.copy();qb=pb.copy();qa[2]=qb[2]=top-.045;pole.extend([[pa,pb,qb],[pa,qb,qa]])
   add(f['id']+' narrow pole','parasol_pole',pole,src)
   traces.append({'id':f['id'],'source_file':'sources/street-reference/nyhavn-9-17-2022.jpg','source_box_px':box,'source_peak_px':f['peak'],'source_size_px':[4032,3024],'presence':'observed','placement_dimensions':'inferred','src':src})
   places.append({'id':f['id'],'matching_frontage':f['frontage'],'center_epsg25832':center.tolist(),'ground_dvr90':ground,'peak_dvr90':top,'canopy_radius_m':r,'water_clearance_m':float(foot.distance(water)),'building_clearance_m':float(foot.distance(buildings)),'building_intersection_area_m2':float(foot.intersection(buildings).area),'water_intersection_area_m2':float(foot.intersection(water).area),'ground_resolution_m':list(ds.res),'conf':'inferred'})
 doc={'schema':'nyhavn-quay-parasols/1','crs':{'horizontal':'EPSG:25832','vertical':'DVR90'},'materials':materials,'meshes':meshes,'traces':traces,'placements':places,'metrics':{'observed_parasol_count':len(FEATURES),'mesh_count':len(meshes),'triangle_count':sum(len(m['triangles']) for m in meshes),'all_canopies_on_land':all(x['water_intersection_area_m2']<1e-6 and x['building_intersection_area_m2']<1e-6 for x in places),'all_vertices_finite':all(np.isfinite(np.asarray(m['triangles'])).all() for m in meshes)},'limitations':['Five clearly separable open parasols observed in the 2022 photo only; folded and heavily obscured canopies are omitted.','World centers, canopy spans, peak height, pole thickness and construction are inferred context, not surveyed fixtures.','The 2022 arrangement need not match the 2025 aerial photograph.','No chairs, people, cafe furniture or additional context was generated.']}
 tmp=out/'quay.json.tmp';tmp.write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')));tmp.replace(out/'quay.json')
 annotated=source.copy();draw=ImageDraw.Draw(annotated)
 for f in FEATURES:draw.rectangle(f['box'],outline=(240,180,40),width=6);draw.text((f['box'][0]+5,f['box'][1]+5),f['id'],fill=(150,25,15),stroke_width=1)
 annotated.crop((750,1780,3750,2200)).save(diag/'traced-five-parasols.png')
 scripts=p/'scripts';scripts.mkdir(exist_ok=True);dest=scripts/'quay_parasols.py'
 if Path(__file__).resolve()!=dest.resolve():shutil.copy2(__file__,dest)
 print(json.dumps(doc['metrics'],indent=2));print(json.dumps(places,indent=2))
if __name__=='__main__':main()
