#!/usr/bin/env python3
"""Measured window layouts (docs/facade-layout.md): before (?windows=0) / after street shots, close-ups against the Skråfoto atlas, fps and memory.

    uv run --with playwright --with pillow --with numpy --with pyproj python tools/shoot-windows.py --data https://pub-....r2.dev [--out docs/windows]

Per place (PLACES, lat / lon) the stop is computed from the local data: the nearest wall with a confident measured layout whose front is clear
(no other footprint within the camera's sight line); a street shot from 25 m at an angle and a close-up from 12 m square on, both at eye
height. Each stop waits for the tile streamer and the photo atlases, hides what moves, and shoots. `--pairs` composes before | after JPEGs
(and the close-up next to the atlas strip with the fitted grid drawn on it) under --out/pairs. fps: three 5 s windows at two stops.
Served by tools/hosting/serve_range.py on SHOOT_PORT (default 8000: the r2.dev CORS rules allow it).
"""
import argparse, json, math, os, socket, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='', help='data base (?data=); empty: the repo ./data')
ap.add_argument('--out', default='docs/windows')
ap.add_argument('--query', default='')
ap.add_argument('--runs', default='before,after', help='before (?windows=0), after, main (the checkout at --main-root, e.g. a worktree of main: perf and compatibility baseline)')
ap.add_argument('--main-root', default='')
ap.add_argument('--settle', type=float, default=150.0)
ap.add_argument('--size', default='1600x900')
ap.add_argument('--places', default='')
ap.add_argument('--pairs', action='store_true', help='only compose the pairs from existing runs')
ap.add_argument('--plan', action='store_true', help='only print the stops')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(root, 'tools/cph-geodata'))
out = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
W, H = (int(v) for v in args.size.split('x'))
TILES = os.path.join(root, 'data/tiles')

PLACES = {  # name: (lat, lon) of a point on the street
    'frederiksberg-alle': (55.67437, 12.54130),
    'istedgade': (55.66920, 12.55400),
    'stroget': (55.67830, 12.57520),
    'osterbrogade-trianglen': (55.69960, 12.57720),
    'norrebrogade': (55.68700, 12.55900),
    'christianshavn': (55.67290, 12.59180),
    'nyhavn-north': (55.67985, 12.58960),
}
PERF_AT = ('stroget-street', 'nyhavn-north-street')
FADE_AT = ('nyhavn-north', 'frederiksberg-alle', 'stroget')


def to_local(lat, lon):
    from pyproj import Transformer
    x, y = Transformer.from_crs(4326, 25832, always_xy=True).transform(lon, lat)
    idx = json.load(open(os.path.join(TILES, 'index.json')))
    ox, oy = idx['frame']['origin'][:2]
    return x - ox, -(y - oy), idx


def seg_cross(p, q, r, s):
    d = lambda a, b, c: (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])  # noqa: E731
    return d(p, q, r) * d(p, q, s) < 0 and d(r, s, p) * d(r, s, q) < 0


def plan_place(name, lat, lon):
    x, z, idx = to_local(lat, lon)
    tids = [t for t, v in idx['tiles'].items() if v['local'][0] - 150 <= x <= v['local'][2] + 150 and v['local'][1] - 150 <= z <= v['local'][3] + 150]
    blds, lays, apps = {}, {}, {}
    for t in tids:
        for b in json.load(open(os.path.join(TILES, t, 'buildings.json')))['buildings']:
            blds[b['id']] = b
        p = os.path.join(TILES, t, 'windows.json')
        if os.path.exists(p):
            lays.update(json.load(open(p))['buildings'])
        for k, v in json.load(open(os.path.join(TILES, t, 'appearance.json')))['buildings'].items():
            if v.get('atlas'):
                apps[k] = v['atlas']
    edges_all = []
    for b in blds.values():
        r = b['ring']
        n = len(r) // 2
        edges_all += [((r[2 * i], r[2 * i + 1]), (r[2 * ((i + 1) % n)], r[2 * ((i + 1) % n) + 1]), b['id']) for i in range(n)]
    best = None
    for bid, walls in lays.items():
        b = blds.get(bid)
        if not b:
            continue
        r = b['ring']
        n = len(r) // 2
        for key, L in walls.items():
            ring, edge = key.split(':')
            if ring != '0' or L['conf'] < 0.7 or L['rows'] * bin(L['cm']).count('1') < 6:
                continue
            e = int(edge)
            a = (r[2 * e], r[2 * e + 1])
            c = (r[2 * ((e + 1) % n)], r[2 * ((e + 1) % n) + 1])
            ln = math.hypot(c[0] - a[0], c[1] - a[1])
            if ln < 8:
                continue
            tx, tz = (c[0] - a[0]) / ln, (c[1] - a[1]) / ln
            nx, nz = -tz, tx  # outward (rings CCW in x / north)
            mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
            d = math.hypot(mid[0] - x, mid[1] - z)
            if d > 140:
                continue
            clear = 0.0  # how far in front of the wall the view is free of other footprints (narrow streets: 10-15 m)
            for dist in (7.0, 9.0, 12.0, 16.0, 22.0):
                cam = (mid[0] + nx * dist, mid[1] + nz * dist)
                if any(seg_cross((mid[0] + nx * 0.3, mid[1] + nz * 0.3), cam, p, q) for p, q, ob in edges_all):
                    break
                clear = dist
            if clear >= 7 and (best is None or d + (22 - clear) * 5 < best[0]):
                best = (d + (22 - clear) * 5, bid, key, a, c, (tx, tz), (nx, nz), mid, b, L, clear)
    if not best:
        return None
    d, bid, key, a, c, (tx, tz), (nx, nz), mid, b, L, clear = best
    g = b['ground']
    eye = g + 1.7
    look_h = g + min(L['g'] + L['f'] * L['rows'] * 0.5, 9.0)
    # street: from the clear distance and 15 m along the street (15-27 m to the wall's centre); close-up square on from 9-12 m
    street = ([mid[0] + nx * clear - tx * 15, eye, mid[1] + nz * clear - tz * 15], [mid[0], look_h, mid[1]], 60)
    cd = min(clear, 12.0)
    close = ([mid[0] + nx * cd, eye, mid[1] + nz * cd], [mid[0], g + min(L['g'] + L['f'] * 0.8, 7.0), mid[1]], 66)
    stops = {f'{name}-street': street, f'{name}-close': close}
    if name in FADE_AT:  # the photo half faded in (js/facade-lod.js PHOTO.close0 / close1: 45-80 m): windows must sit on the photo's
        for dist, side in ((58, -8), (58, 8), (52, -20), (52, 20), (48, 0)):
            cam = (mid[0] + nx * dist + tx * side, mid[1] + nz * dist + tz * side)
            if not any(seg_cross((mid[0] + nx * 0.3, mid[1] + nz * 0.3), cam, p, q) for p, q, ob in edges_all):
                stops[f'{name}-fade'] = ([cam[0], eye + 3, cam[1]], [mid[0], look_h, mid[1]], 30)
                break
    return {'place': name, 'building': bid, 'wall': key, 'dist': round(d, 1), 'atlas': apps.get(bid), 'layout': L, 'stops': stops}


SNAP = '''() => { const t = globalThis.__twin; const s = t.stream && t.stream.snapshot(); const r = t.renderer.info; const w = t.world.buildings;
  const b = w && w.photoBudget; const c = t.cameraSystem.camera.position;
  return { stream: s ? { near: s.resident.near, mid: s.resident.mid, fetching: s.fetching, building: s.building, errors: s.errors } : null,
    photoLoading: b ? b.loading() : 0, photoMemory: w && w.texManager ? w.texManager.memory : null,
    geometries: r.memory.geometries, textures: r.memory.textures, triangles: r.render.triangles,
    calls: r.render.drawCalls, heap: performance.memory ? performance.memory.usedJSHeapSize : null, walls: (() => { let v = 0, bytes = 0, all = 0;
      t.scene.traverse((o) => { const g = o.geometry; if (!g || !g.attributes) return; for (const a of Object.values(g.attributes)) all += a.array ? a.array.byteLength : 0;
        if (g.attributes.facadeTop) { v += g.attributes.facadeTop.count; for (const a of Object.values(g.attributes)) bytes += a.array ? a.array.byteLength : 0; } });
      return { vertices: v, attributeBytes: bytes, allAttributeBytes: all }; })() }; }'''
HIDE = '''() => { const t = globalThis.__twin; const hidden = [];
  const re = /traffic|vehicle|car|bus|pedestrian|cyclist|bike|boat|swan|agent|crowd|people/i;
  t.scene.traverse((o) => { if (o !== t.scene && o.visible && re.test(o.name || '') && !/building|road|street|tile|lane|parking|stand|override/i.test(o.name)) { o.visible = false; hidden.push(o); } });
  globalThis.__hidden = hidden; return hidden.length; }'''
SHOW = '''() => { for (const o of globalThis.__hidden || []) o.visible = true; globalThis.__hidden = []; }'''
FPS = '''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 5000;
  const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b);
  res({ frames: d.length, medianMs: +d[d.length >> 1].toFixed(2), p95Ms: +d[Math.floor(d.length * .95)].toFixed(2), fps: +(d.length / 5).toFixed(1) }); } };
  requestAnimationFrame(tick); })'''


def atlas_panel(plan, height):
    """The wall's atlas strip (as the engine maps it) with the fitted grid drawn on it."""
    import numpy as np
    from PIL import Image, ImageDraw
    import facade_layout as FLY
    at = plan['atlas']
    if not at:
        return None
    ring, edge = plan['wall'].split(':')
    w = next((x for x in at['walls'] if str(x['ring']) == ring and str(x['edge']) == edge), None)
    p = FLY.look_path(at['file'])
    if not w or not p:
        return None
    im = np.asarray(Image.open(p).convert('RGBA'))
    x, y, pw, ph = w['px']
    s = im[y:y + ph, x:x + pw]
    rgb = Image.fromarray(s[..., :3])
    S = height / ph
    rgb = rgb.resize((max(1, int(pw * S)), height), Image.BILINEAR)
    ov = rgb.copy()
    d = ImageDraw.Draw(ov)
    sx, sy = rgb.width / w['len_m'], height / w['h_m']
    for o in FLY.layout_openings(plan['layout'], w['len_m']):
        col = (0, 255, 0) if o['kind'] == 'window' else (255, 200, 0)
        d.rectangle([o['u'][0] * sx, (w['h_m'] - o['v'][1]) * sy, o['u'][1] * sx, (w['h_m'] - o['v'][0]) * sy], outline=col, width=2)
    out = Image.new('RGB', (rgb.width * 2 + 6, height), (20, 20, 20))
    out.paste(rgb, (0, 0))
    out.paste(ov, (rgb.width + 6, 0))
    return out


def label(im, x, t):
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    d.rectangle([x - 4, 6, x + 7 * len(t) + 6, 24], fill=(0, 0, 0))
    d.text((x, 9), t, fill=(255, 255, 255))


def pairs(plans):
    from PIL import Image
    os.makedirs(os.path.join(out, 'pairs'), exist_ok=True)
    made = []
    for pl in plans:
        for name in pl['stops']:
            a, b = os.path.join(out, 'before', f'{name}.png'), os.path.join(out, 'after', f'{name}.png')
            if not (os.path.exists(a) and os.path.exists(b)):
                continue
            A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
            w = 800
            A, B = A.resize((w, A.height * w // A.width)), B.resize((w, B.height * w // B.width))
            panel = atlas_panel(pl, A.height) if name.endswith('-close') else None
            width = 2 * w + 8 + ((panel.width + 8) if panel else 0)
            im = Image.new('RGB', (width, A.height), (20, 20, 20))
            im.paste(A, (0, 0))
            im.paste(B, (w + 8, 0))
            label(im, 10, 'before: guessed grid')
            label(im, w + 18, 'after: measured windows')
            if panel:
                im.paste(panel, (2 * w + 16, 0))
                label(im, 2 * w + 26, 'Skraafoto atlas | fitted grid')
            p = os.path.join(out, 'pairs', f'{name}.jpg')
            im.save(p, quality=80)
            made.append(p)
    print('\n'.join(made))


places = {k: v for k, v in PLACES.items() if not args.places or k in args.places.split(',')}
plans = [p for p in (plan_place(k, *v) for k, v in places.items()) if p]
os.makedirs(out, exist_ok=True)
json.dump([{k: v for k, v in p.items() if k != 'atlas'} for p in plans], open(os.path.join(out, 'stops.json'), 'w'), indent=1)
for p in plans:
    print(p['place'], p['building'], p['wall'], p['dist'], 'm from the point', json.dumps(p['stops']))
missing = set(places) - {p['place'] for p in plans}
if missing:
    print('no measured wall found near:', sorted(missing))
if args.plan:
    raise SystemExit
if args.pairs:
    pairs(plans)
    raise SystemExit

port = int(os.environ.get('SHOOT_PORT', 8000))
server = None


def serve(directory):
    global server
    if server:
        server.terminate()
        server.wait()
    server = subprocess.Popen([sys.executable, os.path.join(root, 'tools/hosting/serve_range.py'), '--port', str(port), '--dir', directory], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)


from playwright.sync_api import sync_playwright  # noqa: E402

results = {}
code = 0
try:
    with sync_playwright() as pw:
        for run in args.runs.split(','):
            serve(os.path.abspath(args.main_root) if run == 'main' else root)
            browser = pw.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info'])
            page = browser.new_context(viewport={'width': W, 'height': H}).new_page()
            logs = []
            page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
            page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
            q = ['hooks']
            if args.data:
                q.append(f'data={args.data}')
            if run == 'before':
                q.append('windows=0')
            if args.query:
                q.append(args.query.lstrip('&?'))
            t0 = time.time()
            page.goto(f'http://localhost:{port}/index.html?{"&".join(q)}')
            page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=600000)
            page.evaluate('() => document.querySelector(\'[data-time="midday"]\')?.click()')
            run_dir = os.path.join(out, run)
            os.makedirs(run_dir, exist_ok=True)
            res = {'run': run, 'query': '&'.join(q), 'bootS': round(time.time() - t0, 1), 'stops': {}}

            def settle():
                t1, quiet, last = time.time(), 0, None
                while time.time() - t1 < args.settle:
                    page.wait_for_timeout(500)
                    sn = page.evaluate(SNAP)
                    st = sn['stream']
                    busy = (st and (st['fetching'] or st['building'])) or sn['photoLoading'] or sn['geometries'] != last
                    last = sn['geometries']
                    quiet = 0 if busy else quiet + 1
                    if quiet >= 6:
                        break
                return round(time.time() - t1, 1)

            for pl in plans:
                for name, (pos, tgt, fov) in pl['stops'].items():
                    page.evaluate('([pos, tgt, fov]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov }; }', [pos, tgt, fov])
                    s = settle()
                    page.wait_for_timeout(1200)
                    sn = page.evaluate(SNAP)
                    page.evaluate(HIDE)
                    page.wait_for_timeout(400)
                    page.screenshot(path=os.path.join(run_dir, f'{name}.png'), timeout=120000)
                    page.evaluate(SHOW)
                    rec = {'settleS': s, **sn}
                    if name in PERF_AT:
                        page.evaluate(HIDE)
                        samples = [page.evaluate(FPS) for _ in range(3)]
                        page.evaluate(SHOW)
                        fps = sorted(x['fps'] for x in samples)
                        rec['fps'] = {'fps': fps[1], 'samples': fps, 'medianMs': sorted(x['medianMs'] for x in samples)[1], 'p95Ms': max(x['p95Ms'] for x in samples)}
                    res['stops'][name] = rec
                    print(f"{run} {name}: settled {s}s, calls {sn['calls']}, tris {sn['triangles']}, textures {sn['textures']}" + (f", fps {rec['fps']}" if 'fps' in rec else ''), flush=True)
            res['errors'] = [l for l in logs if l.startswith(('error', 'pageerror')) and 'Failed to load resource' not in l][:20]
            res['warnings'] = [l for l in logs if l.startswith('warning')][:20]
            if res['errors']:
                code = 1
            results[run] = res
            json.dump(res, open(os.path.join(run_dir, 'stats.json'), 'w'), indent=1)
            browser.close()
finally:
    if server:
        server.terminate()
if 'before' in results and 'after' in results:
    pairs(plans)
summary = {r: {'errors': v['errors'], 'fps': {k: s.get('fps') for k, s in v['stops'].items() if s.get('fps')},
               'calls': {k: s['calls'] for k, s in v['stops'].items()}, 'heapMB': {k: round((s['heap'] or 0) / 1e6) for k, s in v['stops'].items()}}
           for r, v in results.items()}
print(json.dumps(summary, indent=1))
raise SystemExit(code)
