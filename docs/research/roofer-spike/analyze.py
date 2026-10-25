import json, glob, statistics as st, collections, sys
f=glob.glob('work/out1/*.jsonl')[0]
lines=[json.loads(l) for l in open(f)]
out=[]
for ft in lines[1:]:
    sc=ft.get('transform',{}).get('scale',[1e-4]*3); tr=ft.get('transform',{}).get('translate',[0,0,0])
    zs=[v[2]*sc[2]+tr[2] for v in ft['vertices']]
    for oid,o in ft['CityObjects'].items():
        if o['type']!='Building': continue
        a=o['attributes']
        lod22=[]
        for c in o.get('children',[]):
            for g in ft['CityObjects'][c].get('geometry',[]):
                if str(g['lod'])=='2.2': lod22.append(g)
        out.append(dict(id=oid,a=a,zmax=max(zs) if zs else None,has22=bool(lod22)))
n=len(out); print('buildings',n)
print('success',collections.Counter(o['a']['rf_success'] for o in out))
print('has LoD2.2',sum(o['has22'] for o in out))
print('roof type',collections.Counter(o['a']['rf_roof_type'] for o in out))
print('pc_select',collections.Counter(o['a']['rf_pc_select'] for o in out))
print('extrusion',collections.Counter(o['a']['rf_extrusion_mode'] for o in out))
ok=[o for o in out if o['a']['rf_success'] and o['has22'] and o['a']['rf_roof_planes'] is not None and o['a']['rf_h_roof_50p'] is not None and o['a']['rf_rmse_lod22'] is not None]
print('usable',len(ok))
planes=[o['a']['rf_roof_planes'] for o in ok]; print('planes median/p90/max',st.median(planes),sorted(planes)[int(.9*len(planes))],max(planes))
rm=sorted(o['a']['rf_rmse_lod22'] for o in ok); print('rmse22 median/p90',rm[len(rm)//2],rm[int(.9*len(rm))])
t=sorted(o['a']['rf_t_run'] or 0 for o in out); print('t_run(ms?) median/p90/max/sum',t[len(t)//2],t[int(.9*len(t))],t[-1],sum(t))
# vs DSM eave/ridge from geodata (abs DVR90 passed through as attrs)
de=[];dr=[];dz=[]
for o in ok:
    a=o['a']
    if a.get('eave') is None: continue
    de.append(a['rf_h_roof_50p']-a['eave']); dr.append(a['rf_h_roof_max']-a['ridge']); dz.append(a['rf_h_ground']-a['ground'])
def s(x): 
    ax=sorted(abs(v) for v in x); return f"median={st.median(x):+.2f} MAE={st.mean(ax):.2f} p90|e|={ax[int(.9*len(ax))]:.2f}"
print('roofer h_roof_50p - DSM eave   ',s(de)); print('roofer h_roof_max - DSM ridge  ',s(dr)); print('roofer ground - DTM ground     ',s(dz))
# LoD2.2 geometry zmax - ridge
dm=[o['zmax']-o['a']['ridge'] for o in ok if o['zmax'] is not None]; print('LoD2.2 zmax - DSM ridge',s(dm))
# roof type vs our flat/ridge-eave
pitched=[o for o in ok if o['a']['rf_roof_type']!='horizontal']; print('non-horizontal',len(pitched),'of',len(ok))
rel=[o['a']['ridge']-o['a']['eave'] for o in ok]
print('DSM ridge-eave >1.5m but roofer horizontal:',sum(1 for o in ok if o['a']['ridge']-o['a']['eave']>1.5 and o['a']['rf_roof_type']=='horizontal'))
json.dump([dict(id=o['id'],type=o['a']['rf_roof_type'],planes=o['a']['rf_roof_planes'],rmse=o['a']['rf_rmse_lod22'],dens=o['a']['rf_pt_density'],nodata=o['a']['rf_nodata_frac']) for o in out],open('out_summary.json','w'))
