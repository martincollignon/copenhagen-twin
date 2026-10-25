import json, sys
d=json.load(open('../../../data/cph-geodata.json'))
ox,oy,_=d['frame']['origin']
def ring(flat):
    pts=[(flat[i]+ox, -flat[i+1]+oy) for i in range(0,len(flat),2)]
    pts.append(pts[0]); return [list(p) for p in pts]
x0,y0,x1,y1=723010,6176010,723990,6176990
feats=[]
for b in d['buildings']:
    r=ring(b['ring'])
    xs=[p[0] for p in r]; ys=[p[1] for p in r]
    if min(xs)<x0 or max(xs)>x1 or min(ys)<y0 or max(ys)>y1: continue
    rings=[r]+[ring(h) for h in b.get('holes',[])]
    feats.append({"type":"Feature","properties":{"id":b['id'].replace('gdk:',''),"eave":b['eave']+6.84,"ridge":b['ridge']+6.84,"ground":b['ground']+6.84,"roof":b['roof']},"geometry":{"type":"Polygon","coordinates":rings}})
json.dump({"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25832"}},"features":feats},open('work/footprints.geojson','w'))
print(len(feats))
