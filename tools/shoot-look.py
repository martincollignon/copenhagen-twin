#!/usr/bin/env python3
"""Look shots for lakes / trees / night lighting: uv run --with playwright python tools/shoot-look.py --tag before|after [--out docs/look/lakes-trees] [--only a,b]
Writes <view>-<day|night>-<tag>.png and fps-<tag>.json (unthrottled frame timing at street level and on the lake path)."""
import argparse, json, math, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/look/lakes-trees')
ap.add_argument('--tag', default='after')
ap.add_argument('--only', default='')
ap.add_argument('--no-perf', action='store_true')
ap.add_argument('--query', default='')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(root, args.out), exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
FUR = json.load(open(os.path.join(root, 'data/cph-furniture.json')))
LAKES = json.load(open(os.path.join(root, 'data/cph-lakes.json')))

def nearest(lst, x, z, pred=lambda t: True):
    return min((t for t in lst if pred(t)), key=lambda t: math.hypot(t['x'] - x, t['z'] - z))

def tree_view(t, dist=9, h=1.7, fov=62, ax=None):
    # stand `dist` metres from the tree towards (ax) or south-east, looking at the crown middle
    dx, dz = (ax or (0.6, 0.8))
    return ([t['x'] + dx * dist, h, t['z'] + dz * dist], [t['x'], min(t['height'] * 0.55, 7), t['z']], fov)

GEO = json.load(open(os.path.join(root, 'data/cph-geodata.json')))
def street_view(name, frac=0.5, side=3.2, back=0, h=1.7, ahead=45, up=5.5, fov=64, pick=0):
    rs = sorted([r for r in GEO['roads'] if r.get('name') == name and r['class'] in ('secondary', 'primary', 'residential')], key=lambda r: -len(r['pts']))
    r = rs[pick]; p = r['pts']; k = min(max(int(len(p) // 2 * frac) * 2, 2), len(p) - 4)
    dx, dz = p[k + 2] - p[k - 2], p[k + 3] - p[k - 1]; l = math.hypot(dx, dz) or 1; ux, uz = dx / l, dz / l
    cx, cz = p[k] + uz * side - ux * back, p[k + 1] - ux * side - uz * back
    return ([cx, h, cz], [cx + ux * ahead, up, cz + uz * ahead], fov)
chestnut = nearest(FUR['trees'], -80.26, -308.44, lambda t: t['genus'] == 'chestnut')
lime = nearest(FUR['trees'], 20, 150, lambda t: t['genus'] == 'lime' and t['height'] > 10)
plane = nearest(FUR['trees'], 0, 0, lambda t: t['genus'] == 'plane')
VIEWS = {
    'lake-path': ([-70.5, 1.7, -300], [-110, 0.3, -240], 68),
    'lake-path-along': ([-60, 1.7, -330], [-100, 1.5, -260], 70),
    'lake-wall': ([-70.5, 1.5, -300], [-84, -0.5, -300], 70),
    'sotorvet': ([190, 1.7, -385], [215, 2.0, -420], 66),
    'dlb-abutment': ([140, 1.8, -415], [160, 0, -440], 66),
    'norre-sogade': street_view('Nørre Søgade', 0.35, 5.5, 20, 1.7, 55, 4.5),
    'norre-sogade-b': street_view('Nørre Søgade', 0.7, -5.5, 0, 1.7, 50, 5.5),
    'norre-sogade-lamp': ([-2, 2.4, 40], [-8, 7.5, 32], 60),
    'tree-chestnut': tree_view(chestnut, 10, 1.7),
    'tree-chestnut-far': tree_view(chestnut, 38, 3),
    'tree-lime': tree_view(lime, 10, 1.7),
    'tree-avenue': ([-45, 4, -352], [-70, 6, -300], 62),
    'aerial-lakes': ([-60, 160, -150], [-40, 0, -280], 58),
}
only = [v for v in args.only.split(',') if v]
measure = '''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 3000;
  const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ frames: d.length, medianMs: +d[d.length >> 1].toFixed(2), p95Ms: +d[Math.floor(d.length * .95)].toFixed(2), fps: +(d.length / 3).toFixed(1) }); } };
  requestAnimationFrame(tick); })'''
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'http://127.0.0.1:{port}/index.html?hooks&{args.query}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=180000)
        page.wait_for_timeout(5000)
        free = lambda pos, look, fov=60: page.evaluate('''([p,l,f]) => { const t = globalThis.__twin.world.terrain; const g = (x, z) => (t && !t.flat && p[1] < 80) ? t.heightAt(x, z) : 0;
          globalThis.__twin.freeCam = {pos:[p[0], p[1] + g(p[0], p[2]), p[2]], target:[l[0], l[1] + g(l[0], l[2]), l[2]], fov:f}; }''', [pos, look, fov])
        fps = {}
        for tag, tid in (('day', 'midday'), ('night', 'midnight')):
            page.evaluate("(id) => document.querySelector(`[data-time=\"${id}\"]`).click()", tid)
            page.wait_for_timeout(3000)
            for name, v in VIEWS.items():
                if only and name not in only: continue
                free(*v)
                page.wait_for_timeout(5500)
                page.screenshot(path=f'{root}/{args.out}/{name}-{tag}-{args.tag}.png')
                if not args.no_perf and name in ('lake-path', 'norre-sogade', 'tree-avenue'):
                    t = page.evaluate(measure)
                    info = page.evaluate('() => ({ drawCalls: globalThis.__twin.renderer.info.render.drawCalls, triangles: globalThis.__twin.renderer.info.render.triangles })')
                    fps[f'{name}-{tag}'] = {**t, **info}
                    print(name, tag, json.dumps(fps[f'{name}-{tag}']))
        if not args.no_perf: json.dump(fps, open(f'{root}/{args.out}/fps-{args.tag}.json', 'w'), indent=1)
        errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning')) and '404' not in l]
        print('\n'.join(errs[:20]))
        browser.close()
finally:
    server.terminate()
