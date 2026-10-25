import json
pg.goto(f'http://127.0.0.1:{port}/index.html?hooks')
pg.wait_for_function('window.__twin !== undefined', timeout=60000)
pg.wait_for_timeout(4000)
FOCI = json.loads(sys.argv[2]) if len(sys.argv)>2 else [[0,0],[150,-300]]
res = pg.evaluate('''async (foci) => {
  const t = window.__twin; const ts = t.trafficSystem;
  const out = [];
  for (const f of foci) {
    const focus = {x:f[0], z:f[1]};
    let clock = 1000 + out.length*1000, dt = 0.05;
    const st = {focus:f, maxWaitCar:0, maxWaitBus:0, stuckCars:0, overlaps:0, moving:0, samples:0, maxWaitPed:0, bikeMaxWait:0, bikeStuck:0, bikeOffLane:0, bikeKinds:{} , nearCars:0, nearBikes:0, nearPeds:0};
    const t0 = performance.now();
    for (let i = 0; i < 600/dt; i++) {
      clock += dt;
      try { ts.update(dt, clock, focus, null, 'car', null); } catch (e) { return [{error: e.stack}]; }
      if (i % 100 === 0) {
        st.samples++;
        const veh = [...ts.cars, ...ts.buses].filter(v => v.edge && Math.hypot(v.x-focus.x, v.z-focus.z) < 350);
        st.nearCars = veh.length;
        let mv=0;
        for (const v of veh) { st.maxWaitCar = Math.max(st.maxWaitCar, v.wait); if (v.speed > 0.5) mv++; }
        st.moving += mv/Math.max(1,veh.length);
        for (let a=0;a<veh.length;a++) for (let b=a+1;b<veh.length;b++) {
          const A=veh[a],B=veh[b]; const d=Math.hypot(A.x-B.x,A.z-B.z);
          if (d < 1.6) st.overlaps++;
        }
        const bikes = ts.cyclists.filter(c => c.placed);
        st.nearBikes = bikes.length;
        for (const c of bikes) { st.bikeMaxWait=Math.max(st.bikeMaxWait,c.wait); st.bikeKinds[c.lane.kind]=(st.bikeKinds[c.lane.kind]||0)+1; }
      }
    }
    const veh = [...ts.cars, ...ts.buses].filter(v => v.edge);
    st.stuckCars = veh.filter(v => v.wait > 180).length;
    st.bikeStuck = ts.cyclists.filter(c => c.placed && c.wait > 150).length;
    st.nearPeds = ts.peds.filter(p => p.placed).length;
    st.jam = ts.jamRetired; st.simMs = Math.round(performance.now() - t0);
    st.movingShare = st.moving / st.samples;
    out.push(st);
  }
  return out;
}''', FOCI)
for r in res:
  if 'error' in r: print(r['error']); continue
  print('SIM', json.dumps({k:r[k] for k in ['focus','nearCars','maxWaitCar','stuckCars','overlaps','movingShare','bikeMaxWait','bikeStuck','simMs','jam','nearPeds','nearBikes','bikeKinds']}))
for l in logs[-6:]: print(l[:300])
