#!/usr/bin/env python3
"""Detail overrides at Nyhavn: shots, fps and memory, before (?overrides=0) and after, against any data base.

    uv run --with playwright --with pillow python tools/shoot-overrides.py --data https://pub-....r2.dev [--out docs/overrides] [--query ...]

Stops (local frame, docs/detail-overrides.md): street level on the south quay looking at Nyhavn 9-17, street level on the north quay looking at
the south row, the canal from a GoBoat's height (two directions), a low and a high aerial. Each stop waits for the tile streamer, the photo
atlases and the override meshes to settle, hides what moves on its own (cars, people, boats), and shoots. Per run: draw calls, triangles,
renderer textures / geometries, the photo and override texture budgets, JS heap, and 5 s of unthrottled frame times at two stops (three windows each, the median reported).
--pairs writes before | after side by side (both runs must exist under --out).
Served by tools/hosting/serve_range.py on SHOOT_PORT (default 8000: the r2.dev CORS rules allow it).
"""
import argparse, json, os, socket, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='', help='data base (?data=); empty: the repo ./data')
ap.add_argument('--out', default='docs/overrides')
ap.add_argument('--query', default='')
ap.add_argument('--runs', default='before,after', help='before (?overrides=0), after, or both')
ap.add_argument('--settle', type=float, default=150.0)
ap.add_argument('--size', default='1600x900')
ap.add_argument('--pairs', action='store_true', help='only compose before | after images from existing runs')
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
W, H = (int(v) for v in args.size.split('x'))

STOPS = {
    # name: (pos, target, fov)
    'south-quay-nyhavn-9-17': ([1752.0, -3.2, 203.0], [1708.0, 2.5, 118.0], 55),
    'north-quay-south-row': ([1790.0, -3.2, 175.0], [1860.0, 2.0, 236.0], 60),
    'canal-goboat-west': ([1745.0, -5.5, 186.0], [1650.0, -1.0, 160.0], 62),
    'canal-goboat-east': ([1700.0, -5.5, 168.0], [1880.0, -1.5, 214.0], 62),
    'aerial-low': ([2106.5, 117.0, 479.8], [1885.2, -1.8, 220.1], 50),
    'aerial-high': ([1640.0, 330.0, 560.0], [1830.0, -2.0, 190.0], 45),
}
PERF_AT = ('south-quay-nyhavn-9-17', 'aerial-low')

SNAP = '''() => { const t = globalThis.__twin; const s = t.stream && t.stream.snapshot(); const r = t.renderer.info; const w = t.world.buildings;
  const b = w && w.photoBudget; const c = t.cameraSystem.camera.position;
  const st = w ? w.stats : null;
  return { stream: s ? { near: s.resident.near, mid: s.resident.mid, fetching: s.fetching, building: s.building, errors: s.errors } : null,
    photoLoading: b ? b.loading() : 0, photoBand: b && b.band ? b.band(c.x, c.y, c.z) : null, photoMemory: w && w.texManager ? w.texManager.memory : null,
    overrides: st ? st.overrides : null, buildings: st ? { buildings: st.buildings, cells: st.cells, triangles: st.triangles, meshes: st.meshes } : null,
    geometries: r.memory.geometries, textures: r.memory.textures, texturesSize: r.memory.texturesSize ?? null, triangles: r.render.triangles,
    calls: r.render.drawCalls, heap: performance.memory ? performance.memory.usedJSHeapSize : null }; }'''
HIDE = '''() => { const t = globalThis.__twin; const hidden = [];
  const re = /traffic|vehicle|car|bus|pedestrian|cyclist|bike|boat|swan|agent|crowd|people/i;
  t.scene.traverse((o) => { if (o !== t.scene && o.visible && re.test(o.name || '') && !/building|road|street|tile|lane|parking|stand|override/i.test(o.name)) { o.visible = false; hidden.push(o); } });
  globalThis.__hidden = hidden; return hidden.length; }'''
SHOW = '''() => { for (const o of globalThis.__hidden || []) o.visible = true; globalThis.__hidden = []; }'''
FPS = '''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 5000;
  const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b);
  res({ frames: d.length, medianMs: +d[d.length >> 1].toFixed(2), p95Ms: +d[Math.floor(d.length * .95)].toFixed(2), fps: +(d.length / 5).toFixed(1) }); } };
  requestAnimationFrame(tick); })'''


def pairs():
    from PIL import Image, ImageDraw
    os.makedirs(os.path.join(out, 'pairs'), exist_ok=True)
    made = []
    for name in STOPS:
        a, b = os.path.join(out, 'before', f'{name}.png'), os.path.join(out, 'after', f'{name}.png')
        if not (os.path.exists(a) and os.path.exists(b)):
            continue
        A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
        w = A.width // 2
        A, B = A.resize((w, A.height * w // A.width)), B.resize((w, B.height * w // B.width))
        im = Image.new('RGB', (2 * w + 8, A.height), (20, 20, 20))
        im.paste(A, (0, 0))
        im.paste(B, (w + 8, 0))
        d = ImageDraw.Draw(im)
        for x, t in ((10, 'before: generated'), (w + 18, 'after: detail overrides')):
            d.rectangle([x - 4, 6, x + 7 * len(t) + 6, 24], fill=(0, 0, 0))
            d.text((x, 9), t, fill=(255, 255, 255))
        p = os.path.join(out, 'pairs', f'{name}.png')
        im.save(p)
        made.append(p)
    print('\n'.join(made))


if args.pairs:
    pairs()
    raise SystemExit

port = int(os.environ.get('SHOOT_PORT', 8000))
server = subprocess.Popen([sys.executable, os.path.join(root, 'tools/hosting/serve_range.py'), '--port', str(port), '--dir', root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    with sync_playwright() as p:
        for run in args.runs.split(','):
            browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info'])
            ctx = browser.new_context(viewport={'width': W, 'height': H})
            page = ctx.new_page()
            logs = []
            page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
            page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
            q = ['hooks']
            if args.data:
                q.append(f'data={args.data}')
            if run == 'before':
                q.append('overrides=0')
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
                    ov = sn['overrides'] or {}
                    key = (ov.get('shown'), ov.get('failed'), sn['geometries'])
                    busy = (st and (st['fetching'] or st['building'])) or sn['photoLoading'] or key != last
                    last = key
                    quiet = 0 if busy else quiet + 1
                    if quiet >= 6:
                        break
                return round(time.time() - t1, 1)

            for name, (pos, tgt, fov) in STOPS.items():
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
                    samples = [page.evaluate(FPS) for _ in range(3)]  # three 5 s windows: headless frame pacing is noisy
                    page.evaluate(SHOW)
                    fps = sorted(x['fps'] for x in samples)
                    rec['fps'] = {'fps': fps[1], 'samples': fps, 'medianMs': sorted(x['medianMs'] for x in samples)[1], 'p95Ms': max(x['p95Ms'] for x in samples)}
                res['stops'][name] = rec
                ov = sn['overrides'] or {}
                print(f"{run} {name}: settled {s}s, calls {sn['calls']}, tris {sn['triangles']}, textures {sn['textures']}, overrides shown {ov.get('shown')} failed {ov.get('failed')} details {ov.get('details')}"
                      + (f", fps {rec['fps']}" if 'fps' in rec else ''), flush=True)
            res['budget'] = page.evaluate('() => { const w = globalThis.__twin.world.buildings; return { overrides: w.overrideBudget ? w.overrideBudget.memory() : null, photo: w.texManager ? w.texManager.memory : null }; }')
            res['errors'] = [l for l in logs if l.startswith(('error', 'pageerror')) and 'Failed to load resource' not in l][:20]
            res['warnings'] = [l for l in logs if l.startswith('warning')][:20]
            if res['errors']:
                code = 1
            results[run] = res
            json.dump(res, open(os.path.join(run_dir, 'stats.json'), 'w'), indent=1)
            browser.close()
finally:
    server.terminate()
if 'before' in results and 'after' in results:
    pairs()
summary = {r: {'errors': v['errors'], 'budget': v['budget'], 'fps': {k: s.get('fps') for k, s in v['stops'].items() if s.get('fps')},
               'calls': {k: s['calls'] for k, s in v['stops'].items()}, 'textures': {k: s['textures'] for k, s in v['stops'].items()},
               'heapMB': {k: round((s['heap'] or 0) / 1e6) for k, s in v['stops'].items()}} for r, v in results.items()}
print(json.dumps(summary, indent=1))
raise SystemExit(code)
