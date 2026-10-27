#!/usr/bin/env python3
"""Facade photo churn: atlas loads, decodes and GPU uploads while the camera stands still or drives slowly.

    uv run --with playwright python tools/perf/facade-churn.py --label after [--data ./.context/packs/cph-packs-1] [--out .context/churn]

Boots the twin (?hooks), then for each stop teleports the car there with the real teleport button (chase cam, car at rest), lets the
streamer and the photo band settle (--warm seconds), and counts for --measure seconds what the photo budget does
(createPhotoBudget().stats, js/facade-lod.js): plans, new loads, quality replacements, tier flips between plans, density changes,
createImageBitmap decodes and GPU uploads, plus frame-time p95 and the in-band / resident counts. The aerial stop uses the free camera.
`drive` teleports to Frederiksberg Allé and holds the car at about --speed m/s along the avenue for the measured window.

The page is served by tools/hosting/serve_range.py on SHOOT_PORT (default 8000: the r2.dev CORS rules allow localhost:8000).
"""
import argparse, json, math, os, socket, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='', help='data base (?data=): a path under the repo or an http(s) URL; default the repo ./data')
ap.add_argument('--label', default='churn')
ap.add_argument('--out', default='.context/churn')
ap.add_argument('--query', default='')
ap.add_argument('--stops', default='frballe,rhus,nyhavn,aerial,drive')
ap.add_argument('--warm', type=float, default=25.0, help='seconds after arriving before counting')
ap.add_argument('--measure', type=float, default=60.0, help='seconds counted per stop')
ap.add_argument('--speed', type=float, default=6.0, help='m/s for the drive stop')
ap.add_argument('--size', default='1600x900')
args = ap.parse_args()
here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out = os.path.join(args.out if os.path.isabs(args.out) else os.path.join(here, args.out), args.label)
os.makedirs(out, exist_ok=True)
W, H = (int(v) for v in args.size.split('x'))

port = int(os.environ.get('SHOOT_PORT', 8000))
server = subprocess.Popen([sys.executable, os.path.join(here, 'tools/hosting/serve_range.py'), '--port', str(port), '--dir', here],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(50):
    try:
        socket.create_connection(('127.0.0.1', port), timeout=0.2).close()
        break
    except OSError:
        time.sleep(0.1)

from playwright.sync_api import sync_playwright  # noqa: E402

STATS = '''() => { const t = globalThis.__twin; const b = t.world.buildings && t.world.buildings.photoBudget; if (!b) return null;
  const c = t.cameraSystem.camera.position; const s = t.stream && t.stream.snapshot();
  const { log, ...counts } = b.stats; const m = b.memory();
  return { counts, logLength: log.length, band: b.band(c.x, c.y, c.z), resident: m.residentCount, pending: m.pendingCount, wanted: m.wanted,
    density: m.density, residentMiB: +(m.residentBytes / 1048576).toFixed(1), cam: [c.x, c.y, c.z].map((v) => +v.toFixed(2)),
    stream: s ? { fetching: s.fetching, building: s.building } : null,
    car: (() => { const e = t.controllerManager.getActiveEntity(); return { x: e.position.x, z: e.position.z, speed: e.speed }; })() }; }'''
LOG = '() => globalThis.__twin.world.buildings.photoBudget.stats.log.slice()'

# frame times sampled in the page for the measured window
FRAMES_START = '''() => { const f = globalThis.__frames = []; let last = performance.now(); const tick = (t) => { if (globalThis.__frames !== f) return;
  f.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }'''
FRAMES_STOP = '''() => { const d = (globalThis.__frames || []).slice(1).sort((a, b) => a - b); globalThis.__frames = null; if (!d.length) return null;
  const q = (p) => +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1);
  return { n: d.length, fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50: q(0.5), p95: q(0.95), max: q(1) }; }'''

PRESETS = {'rhus': (437.9, 723.6, -2.42), 'nyhavn': (1881.4, 217.6, 2.76), 'frballe': (-1305.4, 1024.2, -1.69)}
AERIAL = ([300, 520, 1500], [1000, 0, 500])
KEYS = ('plans', 'newLoads', 'replacements', 'upgrades', 'downgrades', 'decodes', 'uploads', 'discarded', 'aborted', 'densityChanges', 'tierFlips', 'evictions')

res = {'label': args.label, 'data': args.data or './data', 'stops': []}
code = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': W, 'height': H})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        q = 'hooks' + (f'&data={args.data}' if args.data else '') + (f'&{args.query}' if args.query else '')
        t0 = time.time()
        page.goto(f'http://localhost:{port}/index.html?{q}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=600000)
        print(f'boot {time.time() - t0:.1f} s', flush=True)
        page.evaluate('() => document.querySelector(\'[data-time="midday"]\')?.click()')

        def teleport(name):
            page.evaluate('() => { globalThis.__twin.freeCam = null; }')
            page.evaluate('(n) => document.querySelector(`[data-teleport="${n}"]`).click()', name)

        def hold_speed(target):
            page.evaluate('''(v) => { const cm = globalThis.__twin.controllerManager; const e = cm.getActiveEntity();
              cm.setTouchInput('forward', v > 0 && e.speed < v ? Math.min(1, 0.25 + (v - e.speed) * 0.2) : 0); }''', target)

        for name in [s for s in args.stops.split(',') if s]:
            if name == 'aerial':
                page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', list(AERIAL))
            elif name.endswith('@free'):  # the free camera 12 m up, looking along the preset (tools/hosting/measure_visit.py street views)
                x, z, h = PRESETS[name[:-5]]
                page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [[x, 12, z], [x + 40 * math.sin(h), 6, z + 40 * math.cos(h)]])
            elif name.startswith('fly-'):  # fly the free camera there at 90 m (as tools/hosting/measure_visit.py does), then the street view
                x, z, h = PRESETS[name[4:]]
                a = page.evaluate('() => { const c = globalThis.__twin.cameraSystem.camera.position; return [c.x, c.y, c.z]; }')
                for i in range(1, 61):
                    f = i / 60
                    pos = [a[0] + (x - a[0]) * f, 90, a[2] + (z - a[2]) * f]
                    page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [pos, [pos[0] + (x - a[0]) * 0.1, 20, pos[2] + (z - a[2]) * 0.1]])
                    page.wait_for_timeout(200)
                page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [[x, 12, z], [x + 40 * math.sin(h), 6, z + 40 * math.cos(h)]])
            elif name.endswith('@walk'):  # on foot (chase cam behind the pedestrian)
                teleport(name[:-5])
                page.evaluate('() => globalThis.__twin.controllerManager.setMode("person")')
                teleport(name[:-5])
            else:
                teleport('frballe' if name == 'drive' else name)
            # warm: the streamer and the photo band settle
            t_arrive = time.time()
            quiet = 0
            last_new = None
            while time.time() - t_arrive < args.warm or (quiet < 10 and time.time() - t_arrive < args.warm + 90):
                page.wait_for_timeout(500)
                w = page.evaluate(STATS)
                quiet = quiet + 1 if (w['pending'] == 0 and w['counts']['newLoads'] == last_new) else 0
                last_new = w['counts']['newLoads']
            print(f'{name}: warmed {time.time() - t_arrive:.0f} s (quiet {quiet})', flush=True)
            page.wait_for_function('() => { const s = globalThis.__twin.stream && globalThis.__twin.stream.snapshot(); return !s || (!s.fetching && !s.building); }', timeout=180000)
            a = page.evaluate(STATS)
            page.evaluate(FRAMES_START)
            series = []
            tm = time.time()
            while time.time() - tm < args.measure:
                if name == 'drive':
                    hold_speed(args.speed)
                page.wait_for_timeout(250)
                if len(series) * 2.5 < time.time() - tm:
                    s = page.evaluate(STATS)
                    series.append({'t': round(time.time() - tm, 1), **{k: s['counts'][k] - a['counts'][k] for k in ('replacements', 'newLoads', 'uploads')},
                                   'band': s['band'], 'cam': s['cam'], 'density': s['density']})
            if name == 'drive':
                page.evaluate('() => { globalThis.__twin.controllerManager.setTouchInput("forward", 0); }')
            frames = page.evaluate(FRAMES_STOP)
            b = page.evaluate(STATS)
            secs = time.time() - tm
            delta = {k: b['counts'][k] - a['counts'][k] for k in KEYS}
            per_min = {k: round(v * 60 / secs, 1) for k, v in delta.items()}
            moved = math.hypot(b['car']['x'] - a['car']['x'], b['car']['z'] - a['car']['z']) if name == 'drive' else 0
            # last-third replacements: does it settle?
            tail = [x for x in series if x['t'] >= secs * 2 / 3]
            late = (series[-1]['replacements'] - tail[0]['replacements']) if len(tail) > 1 else None
            rec = {'stop': name, 'seconds': round(secs, 1), 'delta': delta, 'perMin': per_min, 'lateReplacements': late, 'frames': frames,
                   'band': b['band'], 'resident': b['resident'], 'wanted': b['wanted'], 'density': b['density'], 'residentMiB': b['residentMiB'],
                   'movedM': round(moved, 1), 'series': series}
            log = page.evaluate(LOG)
            json.dump(log, open(os.path.join(out, f'{name}-log.json'), 'w'), indent=0)
            res['stops'].append(rec)
            print(f"{name}: repl/min {per_min['replacements']} (late {late}), new/min {per_min['newLoads']}, decodes/min {per_min['decodes']}, uploads/min {per_min['uploads']}, "
                  f"evictions/min {per_min['evictions']}, tierFlips/min {per_min['tierFlips']}, density changes {delta['densityChanges']}, frames {frames}, band {b['band']}, resident {b['resident']}, "
                  f"density {b['density']}, {b['residentMiB']} MiB" + (f', moved {moved:.0f} m' if name == 'drive' else ''), flush=True)
            try:
                page.screenshot(path=os.path.join(out, f'{name}.png'), timeout=120000)
            except Exception as e:
                print(f'{name}: screenshot failed: {str(e)[:120]}', flush=True)
        res['errors'] = [l for l in logs if l.startswith(('error', 'pageerror')) and 'Failed to load resource' not in l][:30]
        browser.close()
finally:
    server.terminate()
json.dump(res, open(os.path.join(out, 'churn.json'), 'w'), indent=1)
print(f"errors: {len(res.get('errors', []))}", *res.get('errors', []), sep='\n')
raise SystemExit(1 if res.get('errors') else 0)
