#!/usr/bin/env python3
"""Tile-streaming soak test (milestone C2): uv run --with playwright python tools/shoot-stream.py [--out .context/c2-stream]

Boots the twin with ?hooks&stream=<near radius> (default 300 m, so streaming is observable inside the 2 km district), flies a free
camera along a path across the district and back, N times, and
  * logs the resident tile counts (near / mid), loads, unloads, aborts and bytes along the way,
  * measures the JS heap (CDP, after a forced GC) every time the camera is back at the start, once the streamer has settled,
  * captures a few screenshots,
  * asserts: no console errors, tiles do unload, the resident set at the far corner is smaller than the district, the heap grows
    by less than --heap-pct (default 15 %) after the first loop, the renderer's geometry / texture counts do not keep growing.
Exit status 1 when an assertion fails. The numbers are also written to <out>/stream-run.json.
"""
import argparse, json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='.context/c2-stream')
ap.add_argument('--port', type=int, default=0, help='local server port; use 8000 for the public R2 data CORS policy')
ap.add_argument('--time', default='', help='time preset clicked after boot (golden, midday, twilight, midnight)')
ap.add_argument('--stream', default='300', help='near radius in metres (?stream=)')
ap.add_argument('--mid', default='650', help='mid radius in metres (?streammid=); the district is only 2 km across')
ap.add_argument('--loops', type=int, default=3)
ap.add_argument('--speed', type=float, default=140.0, help='camera speed, m/s')
ap.add_argument('--height', type=float, default=22.0, help='camera height above the datum, m')
ap.add_argument('--heap-pct', type=float, default=15.0)
ap.add_argument('--query', default='', help='extra query string')
ap.add_argument('--profile', action='store_true', help='record a CDP CPU profile of loop 1 and print the hottest functions')
ap.add_argument('--city', action='store_true', help='a citywide index: skip the checks that assume the 16-tile district')
ap.add_argument('--shot-every', type=float, default=0.0, help='a screenshot every N seconds of the lap (loop 1)')
ap.add_argument('--path', default='', help='custom lap as x,z;x,z;... (local frame); default is the district lap')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
os.makedirs(out, exist_ok=True)

s = socket.socket(); s.bind(('127.0.0.1', args.port)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

# the lap: NS37 -> north-west (the lakes) -> north-east -> south-east -> south-west -> NS37 (local frame, x east / z south)
PATH = [(0, 0), (-620, -600), (620, -600), (620, 600), (-620, 600), (0, 0)]
if args.path:
    PATH = [tuple(float(v) for v in p.split(',')) for p in args.path.split(';')]

FLY_JS = '''([path, speed, height]) => {
  const tw = globalThis.__twin;
  tw.flyDone = null;
  const seg = [];
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) { const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]); seg.push(l); total += l; }
  const at = (d) => {
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
    const t = Math.min(1, d / seg[i]);
    const a = path[i], b = path[i + 1];
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: b[0] - a[0], dz: b[1] - a[1] };
  };
  let start = null;
  const frames = [];
  for (const observer of tw.streamPerfObservers || []) observer.disconnect();
  tw.streamPerfObservers = [];
  tw.longTasks = [];
  try { const observer = new PerformanceObserver((l) => { for (const e of l.getEntries()) tw.longTasks.push({ t: Math.round(e.startTime), ms: Math.round(e.duration) }); }); observer.observe({ type: 'longtask', buffered: false }); tw.streamPerfObservers.push(observer); } catch (e) {}
  tw.loaf = [];
  try { const observer = new PerformanceObserver((l) => { for (const e of l.getEntries()) tw.loaf.push({ t: Math.round(e.startTime), ms: Math.round(e.duration), block: Math.round(e.blockingDuration), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), scripts: (e.scripts || []).map((s) => ({ fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').pop(), d: Math.round(s.duration), inv: s.invoker })) }); }); observer.observe({ type: 'long-animation-frame', buffered: false }); tw.streamPerfObservers.push(observer); } catch (e) {}
  const tick = (now) => {
    if (start === null) start = now;
    frames.push(now);
    const d = Math.min(total, ((now - start) / 1000) * speed);
    const p = at(d);
    const l = Math.hypot(p.dx, p.dz) || 1;
    const y = height;
    tw.freeCam = { pos: [p.x, y, p.z], target: [p.x + p.dx / l * 60, y - 14, p.z + p.dz / l * 60], fov: 60 };
    if (d < total) requestAnimationFrame(tick);
    else { const dts = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b); tw.flyDone = { frames: frames.length, medianMs: dts[dts.length >> 1], p95Ms: dts[Math.floor(dts.length * 0.95)], p99Ms: dts[Math.floor(dts.length * 0.99)], maxMs: dts[dts.length - 1], over50: dts.filter((d) => d > 50).length, over100: dts.filter((d) => d > 100).length, fps: +(frames.length / ((frames[frames.length - 1] - frames[0]) / 1000)).toFixed(1) }; }
  };
  requestAnimationFrame(tick);
}'''

SNAP_JS = '''() => { const t = globalThis.__twin; const s = t.stream.snapshot(); const m = t.renderer.info.memory;
  return { resident: s.resident.near + '+' + s.resident.mid, near: s.resident.near, mid: s.resident.mid, total: s.resident.total, held: s.held, fetching: s.fetching, building: s.building,
           loads: s.loads, builds: s.builds, rebuilds: s.rebuilds, unloads: s.unloads, aborts: s.aborts, errors: s.errors, bytesMB: +(s.bytes / 1e6).toFixed(1),
           far: t.world.far ? { tiles: t.world.far.stats.tiles, visible: t.world.far.stats.visible, triangles: t.world.far.stats.triangles } : null, geometries: m.geometries, textures: m.textures, calls: t.renderer.info.render.drawCalls, triangles: t.renderer.info.render.triangles,
           ids: s.resident.ids }; }'''

fails = []
def summarize_profile(prof):
    nodes = {n['id']: n for n in prof['nodes']}
    dt = prof['timeDeltas']
    self_us = {}
    for nid, d in zip(prof['samples'], dt):
        self_us[nid] = self_us.get(nid, 0) + d
    agg = {}
    for nid, us in self_us.items():
        cf = nodes[nid]['callFrame']
        k = (cf['functionName'] or '(anon)', cf['url'].split('/')[-1], cf['lineNumber'])
        agg[k] = agg.get(k, 0) + us
    rows = [{'name': k[0], 'url': k[1], 'line': k[2], 'self_ms': v / 1000} for k, v in agg.items()]
    return sorted(rows, key=lambda r: -r['self_ms'])[:60]
def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), name, detail)
    if not ok: fails.append(name)

report = {'stream': args.stream, 'mid': args.mid, 'time': args.time, 'loops': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        cdp = page.context.new_cdp_session(page)
        cdp.send('HeapProfiler.enable')

        def heap_mb():
            cdp.send('HeapProfiler.collectGarbage')
            cdp.send('HeapProfiler.collectGarbage')
            return cdp.send('Runtime.getHeapUsage')['usedSize'] / 1e6

        def settle(timeout=90):
            t0 = time.time()
            quiet = 0
            while time.time() - t0 < timeout:
                sn = page.evaluate(SNAP_JS)
                if sn['fetching'] == 0 and sn['building'] == 0:
                    quiet += 1
                    if quiet >= 3: return sn
                else:
                    quiet = 0
                page.wait_for_timeout(300)
            return page.evaluate(SNAP_JS)

        t0 = time.time()
        page.goto(f'http://localhost:{port}/index.html?hooks&stream={args.stream}&streammid={args.mid}' + (f'&{args.query}' if args.query else ''))
        page.wait_for_function('globalThis.__twin && globalThis.__twin.stream', timeout=180000)
        print(f'boot {time.time() - t0:.1f} s')
        if args.time:
            page.locator(f'[data-time="{args.time}"]').click()
        page.wait_for_timeout(2500)
        sn = settle()
        print('boot resident', sn['resident'], 'loads', sn['loads'], 'bytes MB', sn['bytesMB'])
        report['boot'] = {k: v for k, v in sn.items() if k != 'ids'}
        if not args.city: check('boot streams a subset (stream < district)', sn['total'] < 16, str(sn['total']))
        page.screenshot(path=f'{out}/loop0-start.png')

        # a short hold at the start for the first heap sample (loop 0 = the warm state after boot)
        heaps = [heap_mb()]
        print('heap after boot MB', round(heaps[0], 1))
        smallest_far = None
        for loop in range(1, args.loops + 1):
            samples = []
            stop = {'v': False}
            # fly in the page; poll the streamer from here every ~1.5 s
            if args.profile and loop == 1:
                cdp.send('Profiler.enable'); cdp.send('Profiler.setSamplingInterval', {'interval': 500}); cdp.send('Profiler.start')
            page.evaluate(FLY_JS, [PATH, args.speed, args.height])
            t_loop = time.time()
            shots = 0
            while True:
                page.wait_for_timeout(1500)
                sn = page.evaluate(SNAP_JS)
                cam = page.evaluate('() => globalThis.__twin.freeCam.pos')
                samples.append({'t': round(time.time() - t_loop, 1), 'cam': [round(cam[0]), round(cam[2])], **{k: v for k, v in sn.items() if k != 'ids'}})
                print(f"  loop {loop} t={samples[-1]['t']:5.1f}s cam=({cam[0]:6.0f},{cam[2]:6.0f}) resident {sn['near']}n+{sn['mid']}m held {sn['held']} fetching {sn['fetching']} building {sn['building']} loads {sn['loads']} unloads {sn['unloads']} {sn['bytesMB']} MB")
                if args.shot_every:
                    if loop == 1 and samples[-1]['t'] >= (shots + 1) * args.shot_every:
                        page.screenshot(path=f'{out}/loop1-t{int(samples[-1]["t"]):03d}-x{cam[0]:.0f}z{cam[2]:.0f}.png'); shots += 1
                elif loop == 1 and shots < 3 and abs(cam[0]) > 500 and abs(cam[2]) > 500 and (shots == 0 or samples[-1]['t'] - 1 > 0):
                    page.screenshot(path=f'{out}/loop1-corner{shots}.png'); shots += 1
                if smallest_far is None or sn['total'] < smallest_far: smallest_far = sn['total']
                if page.evaluate('() => !!globalThis.__twin.flyDone'): break
                if time.time() - t_loop > 240: break
            timing = page.evaluate('() => globalThis.__twin.flyDone')
            if args.profile and loop == 1:
                prof = cdp.send('Profiler.stop')['profile']
                json.dump(prof, open(f'{out}/loop1.cpuprofile', 'w'))
                report['profile'] = summarize_profile(prof)
                for row in report['profile'][:30]: print(f"  {row['self_ms']:8.0f} ms  {row['name']}  {row['url']}:{row['line']}")
            sn = settle()
            page.screenshot(path=f'{out}/loop{loop}-return.png')
            h = heap_mb()
            heaps.append(h)
            print(f"loop {loop} back at start: resident {sn['near']}n+{sn['mid']}m, heap {h:.1f} MB, geometries {sn['geometries']}, textures {sn['textures']}, frame median {timing['medianMs']:.1f} ms p95 {timing['p95Ms']:.1f} ms p99 {timing['p99Ms']:.1f} max {timing['maxMs']:.0f} ms, {timing['fps']} fps, frames >50 ms: {timing['over50']}, >100 ms: {timing['over100']}")
            report['loops'].append({'loop': loop, 'heapMB': round(h, 1), 'frames': timing, 'samples': samples, 'end': {k: v for k, v in sn.items() if k != 'ids'}})

        final = page.evaluate(SNAP_JS)
        report['final'] = {k: v for k, v in final.items() if k != 'ids'}
        report['heapMB'] = [round(h, 1) for h in heaps]
        errs = [l for l in logs if l.startswith(('error', 'pageerror'))]
        report['consoleErrors'] = errs
        check('no console errors', not errs, '\n'.join(errs[:10]))
        check('tiles unload while flying', final['unloads'] > 0, f"unloads {final['unloads']}")
        if not args.city: check('the far corners hold fewer tiles than the district', smallest_far is not None and smallest_far < 16, f'smallest resident total {smallest_far}')
        check('no streamer errors', final['errors'] == 0, str(final['errors']))
        if len(heaps) >= 3:
            base = heaps[1]  # after the first loop: caches, shaders and pools are warm
            growth = [(h - base) / base * 100 for h in heaps[2:]]
            check(f'heap flat after the first loop (< {args.heap_pct}%)', all(g < args.heap_pct for g in growth), ' '.join(f'{g:+.1f}%' for g in growth) + f' (base {base:.1f} MB)')
        ends = [l['end'] for l in report['loops']]
        if len(ends) >= 3:
            check('renderer geometries do not keep growing', ends[-1]['geometries'] <= ends[1]['geometries'] * 1.1 + 20, f"{[e['geometries'] for e in ends]}")
            check('renderer textures do not keep growing', ends[-1]['textures'] <= ends[1]['textures'] * 1.1 + 5, f"{[e['textures'] for e in ends]}")
        print('heaps MB', report['heapMB'])
        print('layer build ms (n, avg, max):', {k: (v['n'], round(v['total'] / v['n']), round(v['max'])) for k, v in page.evaluate('() => globalThis.__twin.stream.stats.layerMs').items()})
        report['layerMs'] = page.evaluate('() => globalThis.__twin.stream.stats.layerMs')
        slow = page.evaluate('() => globalThis.__twin.stream.stats.slow')
        lt = page.evaluate('() => globalThis.__twin.longTasks || []')
        loaf = page.evaluate('() => globalThis.__twin.loaf || []')
        agg = {}
        for f in loaf:
            for sc in f['scripts']:
                k = f"{sc['url']}:{sc['fn'] or sc['inv']}"
                agg[k] = agg.get(k, 0) + sc['d']
        report['loaf'] = {'frames': len(loaf), 'over100': sum(1 for f in loaf if f['ms'] > 100), 'blockingMs': sum(f['block'] for f in loaf), 'top': sorted(agg.items(), key=lambda kv: -kv[1])[:12], 'worst': sorted(loaf, key=lambda f: -f['ms'])[:5]}
        print('long animation frames', report['loaf']['frames'], '>100 ms:', report['loaf']['over100'], 'blocking ms', report['loaf']['blockingMs'])
        print('  script time in long frames:', [(k, v) for k, v in report['loaf']['top'][:8]])
        fl = page.evaluate('() => globalThis.__twin.frameLog || []')
        report['frameLog'] = {'frames': len(fl), 'sum': {k: sum(f[k] for f in fl) for k in ('total', 'traffic', 'world', 'other', 'render')}, 'worst': sorted(fl, key=lambda f: -f['total'])[:8]}
        print('frames over 60 ms:', len(fl), 'sections (ms):', report['frameLog']['sum'])
        print('  worst:', report['frameLog']['worst'][:5])
        report['slowLayerAdds'] = sorted(slow, key=lambda x: -x['ms'])[:12]
        report['longTasks'] = {'count': len(lt), 'over50': sum(1 for x in lt if x['ms'] > 50), 'totalMs': sum(x['ms'] for x in lt), 'over100': sum(1 for x in lt if x['ms'] > 100), 'over500': sum(1 for x in lt if x['ms'] > 500), 'max': max([x['ms'] for x in lt] or [0])}
        print('long tasks', report['longTasks'], '| slowest layer adds', [(x['layer'], x['ring'], x['ms']) for x in report['slowLayerAdds'][:6]])
        print('\n'.join(l for l in logs if l.startswith(('warning', 'log: [init]')))[:1500])
        browser.close()
finally:
    server.terminate()
report['failedChecks'] = fails
json.dump(report, open(f'{out}/stream-run.json', 'w'), indent=1, default=str)
raise SystemExit(1 if fails else 0)
