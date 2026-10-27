#!/usr/bin/env python3
"""Requests and bytes of one scripted visit, for a data base (packed or unpacked, local or remote):

    uv run --with playwright python tools/hosting/measure_visit.py --label packs --data ./.context/packs/<v> [--out .context/visit]

Visit: boot (default start), Rådhuspladsen, fly to Nyhavn, fly to Frederiksberg Allé, an aerial over Indre By. After each stop it waits
for the tile streamer and the photo atlases to settle and records: time to settle, the data requests (count, bytes) of that leg, the
photo band (in band / resident), renderer numbers, and a screenshot with the moving agents hidden (for a pixel comparison between two
runs: --compare DIR). Totals: requests and bytes per visit by kind, peak requests in any 5-minute window, errors, 404s.

The page is served by tools/hosting/serve_range.py (HTTP Range), on SHOOT_PORT (default 8000: the r2.dev CORS rules allow
http://localhost:8000 and 127.0.0.1:8000, so a remote --data works too). Bytes are what came over the wire; for a local unpacked base
the JSON is counted gzip-compressed (as R2 stores and serves it, Content-Encoding: gzip) so local and remote numbers compare.
"""
import argparse, gzip, json, math, os, socket, subprocess, sys, time
from urllib.parse import urljoin, urlparse, unquote

ap = argparse.ArgumentParser()
ap.add_argument('--data', required=True, help='data base: a path under the repo (./data, ./.context/packs/v) or an http(s) URL')
ap.add_argument('--label', default='visit')
ap.add_argument('--out', default='.context/visit')
ap.add_argument('--query', default='', help='extra query string')
ap.add_argument('--settle', type=float, default=120.0)
ap.add_argument('--fly', type=float, default=12.0, help='seconds per flight leg')
ap.add_argument('--no-range', action='store_true', help='serve without Range support (whole-file fallback)')
ap.add_argument('--compare', default=None, help='a previous run dir: pixel-compare the screenshots of the same stops')
ap.add_argument('--size', default='1600x900')
ap.add_argument('--root', default=None, help='checkout to serve (default: this one), e.g. a worktree of main for the baseline')
args = ap.parse_args()
here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
root = os.path.abspath(args.root) if args.root else here
out = os.path.join(args.out if os.path.isabs(args.out) else os.path.join(here, args.out), args.label)
os.makedirs(out, exist_ok=True)
W, H = (int(v) for v in args.size.split('x'))

port = int(os.environ.get('SHOOT_PORT', 8000))
log_path = os.path.join(out, 'server.jsonl')
if os.path.exists(log_path):
    os.remove(log_path)
server = subprocess.Popen([sys.executable, os.path.join(here, 'tools/hosting/serve_range.py'), '--port', str(port), '--dir', root, '--log', log_path] + (['--no-range'] if args.no_range else []),
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(50):
    try:
        socket.create_connection(('127.0.0.1', port), timeout=0.2).close()
        break
    except OSError:
        time.sleep(0.1)

from playwright.sync_api import sync_playwright  # noqa: E402

page_url = f'http://localhost:{port}/index.html'
data_abs = args.data if args.data.startswith('http') else urljoin(page_url, args.data.rstrip('/') + '/')
data_abs = data_abs.rstrip('/') + '/'
gz_cache = {}


def wire_bytes(url, body):
    """Body bytes; a local unpacked JSON counts as its gzip size (what R2 serves)."""
    if url.startswith(f'http://localhost:{port}/') and url.split('?')[0].endswith('.json') and '/manifest.json' not in url:
        p = os.path.join(root, unquote(urlparse(url).path).lstrip('/'))
        if os.path.exists(p):
            if p not in gz_cache:
                gz_cache[p] = len(gzip.compress(open(p, 'rb').read(), 9, mtime=0))
            return gz_cache[p]
    return body


def kind(url):
    rel = url[len(data_abs):].split('?')[0]
    head = rel.split('/')[0]
    if rel == 'manifest.json':
        return 'manifest'
    if head in ('c', 't', 'd', 'a', 'x'):
        return f'pack-{head}'
    if head == 'tiles':
        return 'tiles/index' if rel.endswith('index.json') else 'tiles/layer'
    return head  # city, tex-look, tex, ...


SNAP = '''() => { const t = globalThis.__twin; const s = t.stream && t.stream.snapshot(); const r = t.renderer.info; const b = t.world.buildings && t.world.buildings.photoBudget;
  const c = t.cameraSystem.camera.position; const tm = t.world.buildings && t.world.buildings.texManager;
  return { stream: s ? { near: s.resident.near, mid: s.resident.mid, fetching: s.fetching, building: s.building, errors: s.errors, loads: s.loads } : null,
    photoBand: b && b.band ? b.band(c.x, c.y, c.z) : null, photoLoading: b ? b.loading() : 0, facadeMemory: tm ? tm.memory || null : null,
    geometries: r.memory.geometries, textures: r.memory.textures, triangles: r.render.triangles, calls: r.render.drawCalls }; }'''

# hide everything that moves on its own (cars, buses, pedestrians, cyclists, boats) for the screenshot
HIDE = '''() => { const t = globalThis.__twin; const hidden = [];
  const re = /traffic|vehicle|car|bus|pedestrian|cyclist|bike|boat|swan|agent|crowd|people/i;
  t.scene.traverse((o) => { if (o !== t.scene && o.visible && re.test(o.name || '') && !/building|road|street|tile|lane|parking|stand/i.test(o.name)) { o.visible = false; hidden.push(o); } });
  globalThis.__hidden = hidden; return hidden.length; }'''
SHOW = '''() => { for (const o of globalThis.__hidden || []) o.visible = true; globalThis.__hidden = []; }'''

PRESETS = {'rhus': (437.9, 723.6, -2.42), 'nyhavn': (1881.4, 217.6, 2.76), 'frballe': (-1305.4, 1024.2, -1.69)}


def street(p):
    x, z, h = PRESETS[p]
    return [x, 12, z], [x + 40 * math.sin(h), 6, z + 40 * math.cos(h)]


AERIAL = ([300, 520, 1500], [1000, 0, 500])

requests = []  # { t, url, kind, status, bytes }
t_start = None
res = {'label': args.label, 'data': args.data, 'stops': [], 'range': not args.no_range}
code = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'])
        ctx = browser.new_context(viewport={'width': W, 'height': H})
        page = ctx.new_page()
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))

        def finished(r):
            if not r.url.startswith(data_abs):
                return
            try:
                body = r.sizes()['responseBodySize']
                status = r.response().status if r.response() else 0
            except Exception:
                body, status = 0, 0
            requests.append({'t': time.time(), 'url': r.url, 'kind': kind(r.url), 'status': status, 'bytes': wire_bytes(r.url, body), 'range': (r.headers.get('range') or None)})

        def failed(r):
            if r.url.startswith(data_abs):
                requests.append({'t': time.time(), 'url': r.url, 'kind': kind(r.url), 'status': -1, 'bytes': 0, 'failure': r.failure})
        page.on('requestfinished', finished)
        page.on('requestfailed', failed)

        def settle(t0):
            quiet = 0
            while time.time() - t0 < args.settle:
                page.wait_for_timeout(400)
                sn = page.evaluate(SNAP)
                st = sn['stream']
                busy = (st and (st['fetching'] or st['building'])) or sn['photoLoading']
                quiet = 0 if busy else quiet + 1
                if quiet >= 5:
                    break
            return time.time() - t0 - 0.4 * quiet

        def stop(name, t0, n0):
            s = settle(t0)
            page.wait_for_timeout(800)
            sn = page.evaluate(SNAP)
            page.evaluate(HIDE)
            page.wait_for_timeout(300)
            try:
                page.screenshot(path=os.path.join(out, f'{name}.png'), timeout=120000)
            except Exception as e:  # a busy GPU process: keep measuring
                print(f'{name}: screenshot failed: {str(e)[:120]}', flush=True)
            page.evaluate(SHOW)
            leg = requests[n0:]
            rec = {'stop': name, 'settleS': round(s, 1), 'requests': len(leg), 'bytes': sum(r['bytes'] for r in leg), **sn}
            res['stops'].append(rec)
            print(f'{name}: settled {s:.1f} s, {len(leg)} requests, {rec["bytes"] / 1e6:.1f} MB, band {sn["photoBand"]}, near/mid {sn["stream"] and (sn["stream"]["near"], sn["stream"]["mid"])}', flush=True)
            return len(requests)

        def fly(a, b, secs, alt=90):
            steps = max(2, int(secs * 5))
            for i in range(1, steps + 1):
                f = i / steps
                pos = [a[0] + (b[0] - a[0]) * f, alt, a[2] + (b[2] - a[2]) * f]
                ahead = [pos[0] + (b[0] - a[0]) * 0.1, 20, pos[2] + (b[2] - a[2]) * 0.1]
                page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [pos, ahead])
                page.wait_for_timeout(200)

        q = f'hooks&data={args.data}' + (f'&{args.query}' if args.query else '')
        t_start = time.time()
        page.goto(f'{page_url}?{q}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=600000)
        res['bootS'] = round(time.time() - t_start, 1)
        print(f'boot {res["bootS"]} s', flush=True)
        page.evaluate('() => document.querySelector(\'[data-time="midday"]\')?.click()')
        n = stop('boot', time.time(), 0)
        cur = [0, 12, 0]
        for name, (pos, tgt), flight in (('rhus', street('rhus'), False), ('nyhavn', street('nyhavn'), True), ('frballe', street('frballe'), True), ('aerial', AERIAL, True)):
            t0 = time.time()
            if flight:
                fly(cur, pos, args.fly)
            page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [pos, tgt])
            n = stop(name, t0, n)
            cur = pos
        res['visitS'] = round(time.time() - t_start, 1)
        try:
            res['packStats'] = page.evaluate('async () => { try { return { ...(await import("./js/data-packs.js")).packStats }; } catch { return null; } }')
        except Exception:
            res['packStats'] = None
        errs = [l for l in logs if l.startswith(('error', 'pageerror'))]
        res['errors'] = errs[:30]
        res['warnings'] = [l for l in logs if l.startswith('warning')][:30]
        browser.close()
finally:
    server.terminate()

# ---------------------------------------------------------------------------------------------------------------- totals
by = {}
for r in requests:
    k = by.setdefault(r['kind'], {'requests': 0, 'bytes': 0})
    k['requests'] += 1
    k['bytes'] += r['bytes']
ts = sorted(r['t'] for r in requests)
peak, j = 0, 0
for i in range(len(ts)):
    while ts[i] - ts[j] > 300:
        j += 1
    peak = max(peak, i - j + 1)
res.update({
    'requests': len(requests), 'bytes': sum(r['bytes'] for r in requests), 'byKind': by, 'peak5min': peak,
    'status': {str(s): sum(1 for r in requests if r['status'] == s) for s in sorted({r['status'] for r in requests})},
    'notFound': [r['url'] for r in requests if r['status'] == 404][:20],
    'failed': [f"{r['url']} {r.get('failure')}" for r in requests if r['status'] == -1][:20],
})
if args.compare:
    try:
        from PIL import Image, ImageChops
        cmp = {}
        for s in res['stops']:
            a_p, b_p = os.path.join(out, f'{s["stop"]}.png'), os.path.join(args.compare, f'{s["stop"]}.png')
            if not os.path.exists(b_p):
                continue
            a, b = Image.open(a_p).convert('RGB'), Image.open(b_p).convert('RGB')
            d = ImageChops.difference(a, b).convert('L')
            hist = d.histogram()
            total = sum(hist)
            cmp[s['stop']] = {'identical': d.getbbox() is None, 'pixelsOver8': round(sum(hist[9:]) / total, 5), 'meanAbs': round(sum(i * c for i, c in enumerate(hist)) / total, 3)}
            d.point(lambda v: min(255, v * 8)).save(os.path.join(out, f'{s["stop"]}-diff.png'))
        res['compare'] = cmp
    except ImportError:
        res['compare'] = 'PIL not available (uv run --with pillow)'
json.dump({**res, 'log': requests}, open(os.path.join(out, 'visit.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in res.items() if k not in ('stops', 'warnings')}, indent=1))
if res['errors']:
    code = 1
raise SystemExit(code)
