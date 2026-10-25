#!/usr/bin/env python3
"""Headless WebGPU captures for M2: uv run --with playwright python tools/shoot-m2.py [--port N] [--out docs/m2]"""
import argparse, json, subprocess, sys, time, socket, os
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/m2')
ap.add_argument('--shots', default='all')
ap.add_argument('--query', default='')
ap.add_argument('--perf', action='store_true', help='unthrottled frame timing instead of captures')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
SHOTS = {
    # name: (pos, look, fov)
    'aerial': ([-420, 330, 380], [20, 0, -20], 50),
    'street-ns37': ([-7.2, 1.7, -7.5], [18.2, 9, 4.3], 62),
}
GEO = json.load(open(os.path.join(root, 'data/cph-geodata.json')))
def longest_wall(building_id):
    b = next(x for x in GEO['buildings'] if x['id'] == building_id)
    r = b['ring']; n = len(r) // 2
    best = None
    for i in range(n):
        j = (i + 1) % n
        dx, dz = r[2*j] - r[2*i], r[2*j+1] - r[2*i+1]
        l = (dx*dx + dz*dz) ** .5
        if best is None or l > best[0]: best = (l, i, dx, dz)
    l, i, dx, dz = best
    mid = ((r[2*i] + r[2*(i+1) % len(r)]) / 2, (r[2*i+1] + r[(2*(i+1)+1) % len(r)]) / 2)
    nx, nz = -dz / l, dx / l
    return mid, (nx, nz), b
mid, nrm, blk = longest_wall('gdk:1064813373')
h = blk['eave'] - blk['ground']
SHOTS['angled-block'] = ([mid[0] + nrm[0] * 30, 1.7, mid[1] + nrm[1] * 30], [mid[0], h * 0.45, mid[1]], 62)
SHOTS['angled-block-up'] = ([mid[0] + nrm[0] * 45, 28, mid[1] + nrm[1] * 45], [mid[0] - nrm[0] * 10, 8, mid[1] - nrm[1] * 10], 55)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] + (['--disable-frame-rate-limit', '--disable-gpu-vsync'] if args.perf else []))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'http://127.0.0.1:{port}/index.html?city=cph{args.query}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
        page.wait_for_timeout(4000)
        view = lambda pos, look, fov=60: page.evaluate('([p,l,f]) => { globalThis.__twin.cameraSystem.debugView = {pos:p, look:l, fov:f}; }', [pos, look, fov])
        def shot(name):
            page.wait_for_timeout(2500)
            page.screenshot(path=f'{args.out}/{name}.png')
        if args.perf:
            for name, v in SHOTS.items():
                view(*v); page.wait_for_timeout(2500)
                t = page.evaluate('''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 5000;
                  const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ frames: d.length, medianMs: d[d.length >> 1], p95Ms: d[Math.floor(d.length * .95)], fps: d.length / 5 }); } };
                  requestAnimationFrame(tick); })''')
                info = page.evaluate('() => ({ ...globalThis.__twin.renderer.info.render })')
                print(name, json.dumps(t), 'drawCalls', info['drawCalls'], 'triangles', info['triangles'])
            browser.close(); raise SystemExit
        for name, v in SHOTS.items():
            if v and args.shots in ('all', name):
                view(*v); shot(name)
        if args.shots in ('all', 'info'):
            view([-7.2, 1.7, -7.5], [18.2, 9, 4.3], 62)
            page.wait_for_timeout(1500)
            for dx in (0, 3, 6, 9):
                page.mouse.move(720 + dx, 380); page.wait_for_timeout(150)
            page.wait_for_timeout(500)
            page.screenshot(path=f'{args.out}/info-panel.png')
        stats = page.evaluate('() => { const t = globalThis.__twin; const w = t.world.buildings; return { stats: w && w.stats, render: t.renderer.info.render, memory: t.renderer.info.memory }; }')
        print(json.dumps(stats, indent=1, default=str))
        print('\n'.join(logs[-40:]))
        browser.close()
finally:
    server.terminate()
