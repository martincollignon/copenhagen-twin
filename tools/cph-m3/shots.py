import json, os
os.makedirs('/Users/martincollignon/conductor/cph-twin-m3/docs/m3', exist_ok=True)
OUT='/Users/martincollignon/conductor/cph-twin-m3/docs/m3/'
pg.goto(f'http://127.0.0.1:{port}/index.html?hooks')
pg.wait_for_function('window.__twin !== undefined', timeout=60000)
pg.wait_for_timeout(3000)
junc = pg.evaluate('''() => { const ts=window.__twin.trafficSystem; const c=ts.signalNodes.filter(n=>n.arms.filter(a=>a.lead===a).length>=4).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0]; return {x:c.x,z:c.z,n:ts.signalNodes.length,arms:c.arms.map(a=>[a.ux,a.uz])}; }''')
print('JUNCTION', junc)
def shot(name, pos, target, fov, wait=20000):
    pg.evaluate('([p,t,f]) => { window.__twin.freeCam = {pos:p, target:t, fov:f}; }', [pos,target,fov])
    pg.wait_for_timeout(wait)
    pg.screenshot(path=OUT+name)
    print('shot', name, [l for l in logs[-3:] if 'error' in l.lower()])
shot('overview.png',[0,560,330],[0,0,-80],55)
shot('dronning-louises-bro.png',[79,12,-432],[100,0,-470],55,30000)
jx,jz=junc['x'],junc['z']
shot('signalised-junction.png',[jx+22,11,jz+26],[jx,0,jz],60,25000)
shot('norre-sogade-street.png',[-22,1.8,70],[-8,1.8,36],62,25000)
for l in logs:
    if 'error' in l.lower(): print(l[:300])
