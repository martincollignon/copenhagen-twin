#!/usr/bin/env python3
"""Citywide probe (milestone C5): uv run --with playwright python tools/shoot-city.py --out .context/c5-shots [--query tiles=./...] SHOT...

Boots the twin with ?hooks, waits for the tile streamer to settle, then for every SHOT puts the free camera there, waits for the
streamer, and takes a screenshot with the renderer / streamer numbers. A SHOT is  name:x,y,z>tx,ty,tz  (local frame, x east,
z south, y up; the second triple is where the camera looks) or  name:@poi  with poi from the teleport presets
(js/city-config.js TELEPORT_LOCATIONS), looking along the preset's heading from 12 m up.
Prints the init timings, console warnings and errors. Exit status 1 on a console error.
"""
import argparse, json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('shots', nargs='*')
ap.add_argument('--out', default='.context/c5-shots')
ap.add_argument('--query', default='', help='extra query string, e.g. tiles=./.context/c5-tiles/tiles')
ap.add_argument('--stream', default='', help='near radius override (?stream=)')
ap.add_argument('--settle', type=float, default=45.0, help='seconds to wait for the streamer after each move')
ap.add_argument('--fov', type=float, default=60.0)
ap.add_argument('--size', default='1600x900')
ap.add_argument('--time', default='', help='time preset button id (noon, golden, ...) clicked after the boot')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
os.makedirs(out, exist_ok=True)
W, H = (int(v) for v in args.size.split('x'))

s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SNAP = '''() => { const t = globalThis.__twin; const s = t.stream && t.stream.snapshot(); const r = t.renderer.info;
  return { stream: s ? { near: s.resident.near, mid: s.resident.mid, fetching: s.fetching, building: s.building, held: s.held, errors: s.errors, loads: s.loads } : null,
    far: t.world.far ? t.world.far.stats : null, region: t.world.agents ? t.world.agents.stats : null,
    geometries: r.memory.geometries, textures: r.memory.textures, calls: r.render.drawCalls, triangles: r.render.triangles }; }'''

def parse(shot, presets):
    name, rest = shot.split(':', 1)
    if rest.startswith('@'):
        p = presets[rest[1:]]
        h = p.get('heading', 0)
        pos = [p['x'], 12, p['z']]
        tgt = [p['x'] + 40 * __import__('math').sin(h), 6, p['z'] + 40 * __import__('math').cos(h)]
        return name, pos, tgt
    a, b = rest.split('>')
    return name, [float(v) for v in a.split(',')], [float(v) for v in b.split(',')]

code = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': W, 'height': H})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        q = 'hooks' + (f'&stream={args.stream}' if args.stream else '') + (f'&{args.query}' if args.query else '')
        t0 = time.time()
        page.goto(f'http://127.0.0.1:{port}/index.html?{q}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=600000)
        print(f'boot {time.time() - t0:.1f} s')
        page.wait_for_timeout(1500)
        if args.time:
            page.evaluate(f"() => document.querySelector('[data-time={args.time!r}]')?.click()")
        presets = page.evaluate('async () => (await import("./js/city-config.js")).TELEPORT_LOCATIONS')
        for shot in args.shots:
            name, pos, tgt = parse(shot, presets)
            page.evaluate('([pos, tgt, fov]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov }; }', [pos, tgt, args.fov])
            t1 = time.time()
            quiet = 0
            while time.time() - t1 < args.settle:
                page.wait_for_timeout(400)
                sn = page.evaluate(SNAP)
                st = sn['stream']
                if st is None or (st['fetching'] == 0 and st['building'] == 0): quiet += 1
                else: quiet = 0
                if quiet >= 4: break
            page.wait_for_timeout(1200)
            sn = page.evaluate(SNAP)
            page.screenshot(path=f'{out}/{name}.png')
            print(f'{name}: settled in {time.time() - t1:.1f} s', json.dumps(sn))
        errs = [l for l in logs if l.startswith(('error', 'pageerror'))]
        print('\n'.join(l for l in logs if l.startswith(('warning', 'log: [init]')))[:3000])
        print('ERRORS:', len(errs)); print('\n'.join(errs[:20]))
        code = 1 if errs else 0
        browser.close()
finally:
    server.terminate()
raise SystemExit(code)
