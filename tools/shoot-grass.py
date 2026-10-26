#!/usr/bin/env python3
"""Grass close-ups and cost: uv run --with playwright python tools/shoot-grass.py [--out docs/grass]

Eye-level and aerial shots over the measured lawns (data/cph-vegetation.json) with the tufts (default) and without
(?debug=nograss), plus tufts in view, draw calls, triangles and an unthrottled frame time at one lawn.
"""
import argparse, json, math, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/grass')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(root, args.out), exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
veg = json.load(open(os.path.join(root, 'data/cph-vegetation.json')))
lawns = sorted((r for r in veg['surfaces'] if r['kind'] == 'lawn'), key=lambda r: -r['area_m2'])

def centroid(r):
    return sum(r['ring'][0::2]) / (len(r['ring']) // 2), sum(r['ring'][1::2]) / (len(r['ring']) // 2)

big = lawns[0]
cx, cz = centroid(big)
VIEWS = {
    'lawn-eye': ([cx, 1.7, cz], [cx + 14, 0.6, cz + 9], 62),
    'lawn-low': ([cx, 0.45, cz], [cx + 6, 0.2, cz + 4], 60),
    'lawn-aerial': ([cx - 60, 60, cz - 60], [cx, 0, cz], 55),
    'park-aerial': ([260, 150, 330], [300, 0, 120], 55),
}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'])
        for variant, query in (('tufts', 'hooks'), ('plain', 'hooks&debug=nograss')):
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            logs = []
            page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
            page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
            page.goto(f'http://127.0.0.1:{port}/index.html?{query}')
            page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
            page.wait_for_timeout(4000)
            page.evaluate("() => document.querySelector('[data-time=\"midday\"]').click()")
            for name, (pos, look, fov) in VIEWS.items():
                page.evaluate('''([p,l,f]) => { const t = globalThis.__twin.world.terrain; const g = (x, z) => (t && !t.flat && p[1] < 80) ? t.heightAt(x, z) : 0;
                  globalThis.__twin.freeCam = {pos:[p[0], p[1] + g(p[0], p[2]), p[2]], target:[l[0], l[1] + g(l[0], l[2]), l[2]], fov:f}; }''', [pos, look, fov])
                page.wait_for_timeout(3500)
                page.screenshot(path=f'{args.out}/{variant}-{name}.png')
                info = page.evaluate('() => ({ drawCalls: globalThis.__twin.renderer.info.render.drawCalls, triangles: globalThis.__twin.renderer.info.render.triangles, tufts: globalThis.__twin.world.grass ? globalThis.__twin.world.grass.tufts : 0 })')
                print(variant, name, json.dumps(info))
            # frame time at the eye-level lawn view
            page.evaluate('''([p,l,f]) => { const t = globalThis.__twin.world.terrain; globalThis.__twin.freeCam = {pos:[p[0], p[1] + t.heightAt(p[0], p[2]), p[2]], target:[l[0], l[1] + t.heightAt(l[0], l[2]), l[2]], fov:f}; }''', list(VIEWS['lawn-eye']))
            page.wait_for_timeout(2000)
            ms = page.evaluate('() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { if (++n === 120) res((performance.now() - t0) / 120); else requestAnimationFrame(f); }; requestAnimationFrame(f); })')
            print(variant, 'frame ms at lawn-eye', round(ms, 2))
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print(variant, 'console problems:', errs[:8])
            page.close()
        browser.close()
finally:
    server.terminate()
