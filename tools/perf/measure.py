#!/usr/bin/env python3
"""Frame time and render counters at the fixed poses of tools/perf/poses.json, on the seeded, frozen ?bench twin.

uv run --with playwright python tools/perf/measure.py [--poses a,b] [--ms 4000] [--seed 1] [--out result.json] [--shots dir]

Per pose: switch the time of day, place the camera, advance the simulation a fixed number of 1/60 s steps (same seed,
same steps -> same traffic), then freeze it and record wall-clock frame times (vsync off) and main-thread time per frame.
Counters (draw calls, triangles, passes, pipelines, memory) depend only on the scene, so they are comparable across
machines; timings are only comparable on one machine, between interleaved runs.
"""
import argparse, json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--poses', default='', help='comma-separated subset of poses.json')
ap.add_argument('--ms', type=int, default=4000, help='measured window per pose')
ap.add_argument('--advance', type=int, default=120, help='simulation steps after placing the camera')
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--query', default='', help='extra query parameters, e.g. water=simple')
ap.add_argument('--out', default='')
ap.add_argument('--shots', default='', help='directory for one screenshot per pose')
ap.add_argument('--chromium-arg', action='append', default=[], help='extra browser flag (repeatable)')
args = ap.parse_args()

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = json.load(open(os.path.join(root, 'tools/perf/poses.json')))['poses']
names = [n for n in args.poses.split(',') if n] or list(spec)

s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
flags = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync']
if sys.platform == 'darwin': flags.append('--use-angle=metal')
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=flags + args.chromium_arg)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and not m.text.startswith('Failed to load resource') else None)
        missing = []
        page.on('response', lambda r: missing.append(r.url.split(f':{port}/')[-1]) if r.status >= 400 else None)
        t0 = time.time()
        query = f'bench={args.seed}' + (f'&{args.query.lstrip("&")}' if args.query else '')
        page.goto(f'http://127.0.0.1:{port}/index.html?{query}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.bench', timeout=180000)
        page.wait_for_function('document.getElementById("loading-overlay")?.classList.contains("hidden")', timeout=180000)
        result = {
            'boot_s': round(time.time() - t0, 1),
            'adapter': page.evaluate('async () => { const a = await navigator.gpu.requestAdapter(); return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null; }'),
            'seed': args.seed, 'query': query, 'viewport': [1440, 900], 'poses': {}
        }
        if args.shots: os.makedirs(args.shots, exist_ok=True)
        for name in names:
            pose = spec[name]
            page.evaluate("(id) => document.querySelector(`[data-time=\"${id}\"]`)?.click()", pose.get('time', 'golden'))
            page.evaluate('''(p) => { const t = globalThis.__twin.world.terrain;
              const g = (x, z) => (p.ground && t && !t.flat) ? t.heightAt(x, z) : 0;
              globalThis.__twin.bench.setPose({ pos: [p.pos[0], p.pos[1] + g(p.pos[0], p.pos[2]), p.pos[2]],
                look: [p.look[0], p.look[1] + g(p.look[0], p.look[2]), p.look[2]], fov: p.fov }); }''', pose)
            page.evaluate('(n) => globalThis.__twin.bench.advance(n)', args.advance)
            page.wait_for_timeout(1000)  # streaming / LoD rebuilds settle on the frozen scene
            result['poses'][name] = page.evaluate('(ms) => globalThis.__twin.bench.measure(ms)', args.ms)
            if args.shots: page.screenshot(path=os.path.join(args.shots, f'{name}.jpg'), type='jpeg', quality=80)
            print(name, json.dumps(result['poses'][name]), file=sys.stderr)
        result['errors'] = errors[:20]
        result['missing'] = sorted(set(missing))  # optional data (e.g. hero glTFs not linked) 404s instead of failing
        browser.close()
    text = json.dumps(result, indent=1)
    if args.out:
        open(args.out, 'w').write(text + '\n')
    else:
        print(text)
finally:
    server.terminate()
