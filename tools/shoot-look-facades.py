#!/usr/bin/env python3
"""Facade look checks: uv run --with playwright python tools/shoot-look-facades.py --out docs/look/facades/x [--query tex=0] [--views a,b] [--perf]
Boots the twin with ?hooks, flies a free camera to each view (x, z, look-x, look-z, eye height) and saves JPEGs;
prints console errors and, with --perf, unthrottled frame times at street level."""
import argparse, json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/look/facades/tmp')
ap.add_argument('--query', default='')
ap.add_argument('--views', default='')
ap.add_argument('--perf', action='store_true')
ap.add_argument('--wait', type=int, default=7000)
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
VIEWS = json.load(open(os.path.join(root, 'docs/look/facades/views.json')))
names = [v for v in args.views.split(',') if v] or list(VIEWS)
os.makedirs(args.out, exist_ok=True)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] + (['--disable-frame-rate-limit', '--disable-gpu-vsync'] if args.perf else []))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'http://127.0.0.1:{port}/index.html?hooks&{args.query.lstrip("&")}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
        page.wait_for_timeout(3000)
        page.evaluate("(id) => document.querySelector(`[data-time=\"${id}\"]`).click()", 'midday')
        def free(v):
            page.evaluate('''([p,l,f]) => { const t = globalThis.__twin.world.terrain; const g = (x, z) => (t && !t.flat) ? t.heightAt(x, z) : 0;
              globalThis.__twin.freeCam = {pos:[p[0], p[1] + g(p[0], p[2]), p[2]], target:[l[0], l[1] + g(l[0], l[2]), l[2]], fov:f}; }''', [v['pos'], v['look'], v.get('fov', 62)])
        for n in names:
            v = VIEWS[n]
            free(v)
            page.wait_for_timeout(args.wait)
            page.screenshot(path=f'{args.out}/{n}.jpg', type='jpeg', quality=88)
            if args.perf:
                fps = page.evaluate('''() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 3000) res(n / 3); else requestAnimationFrame(f); }; f(); })''')
                print('fps', n, round(fps, 1))
            print('shot', n)
        st = page.evaluate('() => { const b = globalThis.__twin.world.buildings; const t = b && b.texManager; return t ? { resident: t.state.resident.size, loaded: t.state.loaded, look: t.state.look, raw: t.state.raw, failed: t.state.failed.size, enabled: t.state.enabled } : null; }')
        print('tex', st)
        errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
        print('\n'.join(errs[:25]))
        browser.close()
finally:
    server.terminate()
