#!/usr/bin/env python3
"""Frame timing at named views, A/B over query strings: uv run --with playwright python tools/perf-city.py --out DIR --variant name=QUERY ... [--rounds 2] name:x,y,z>tx,ty,tz ...

Every round boots one browser per variant (variants alternate, so machine load drifts hit all of them), puts the free camera at each view, waits for the
streamer, and measures 5 s of requestAnimationFrame (unthrottled, midday, 1600 x 900). Prints the median frame time per view and variant over the rounds
and writes DIR/perf.json (+ a screenshot per view of the first round). Example:
  --variant full=reflect=full --variant new= nyhavn:1881,9,217\\>1893,2,150
"""
import argparse, json, os, socket, statistics, subprocess, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('views', nargs='+')
ap.add_argument('--out', default='.context/perf')
ap.add_argument('--variant', action='append', default=[], help='name=query (the query may be empty)')
ap.add_argument('--rounds', type=int, default=2)
ap.add_argument('--measure', type=float, default=5.0)
args = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
os.makedirs(out, exist_ok=True)
variants = [(v.split('=', 1)[0], v.split('=', 1)[1] if '=' in v else '') for v in args.variant] or [('base', '')]

s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
MEASURE = '''(ms) => new Promise((res) => { const d = []; let last = performance.now(); const end = last + ms;
  const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.shift(); d.sort((a, b) => a - b); const r = globalThis.__twin.renderer.info.render;
    res({ medianMs: +d[d.length >> 1].toFixed(2), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(2), frames: d.length, calls: r.drawCalls, triangles: r.triangles }); } };
  requestAnimationFrame(tick); })'''
res = {n: {} for n, _ in variants}
try:
    with sync_playwright() as p:
        for rnd in range(args.rounds):
            for name, query in variants:
                b = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'])
                page = b.new_page(viewport={'width': 1600, 'height': 900})
                errs = []
                page.on('console', lambda m: errs.append(m.text[:160]) if m.type == 'error' else None)
                page.goto(f'http://127.0.0.1:{port}/index.html?hooks&{query}', timeout=300000)
                page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=600000)
                page.wait_for_timeout(1500)
                page.evaluate("() => document.querySelector('[data-time=\"midday\"]')?.click()")
                for v in args.views:
                    vname, rest = v.split(':', 1)
                    a, t = rest.split('>')
                    pos = [float(x) for x in a.split(',')]; tgt = [float(x) for x in t.split(',')]
                    page.evaluate('([pos, tgt]) => { globalThis.__twin.freeCam = { pos, target: tgt, fov: 60 }; }', [pos, tgt])
                    q = 0
                    for i in range(80):
                        page.wait_for_timeout(500)
                        sn = page.evaluate('() => { const s = globalThis.__twin.stream.snapshot(); return s.fetching + s.building; }')
                        q = q + 1 if sn == 0 else 0
                        if q >= 4: break
                    page.wait_for_timeout(1500)
                    if rnd == 0: page.screenshot(path=f'{out}/{vname}-{name}.png')
                    m = page.evaluate(MEASURE, args.measure * 1000)
                    res[name].setdefault(vname, []).append(m)
                    print(f'round {rnd} {name:8} {vname:8} {m}', flush=True)
                if errs: print('errors:', errs[:3])
                b.close()
finally:
    server.terminate()
json.dump(res, open(f'{out}/perf.json', 'w'), indent=1)
print('\nmedian of the per-round median frame ms (calls of the last round):')
for vname in sorted({v.split(':')[0] for v in args.views}):
    print(f'  {vname:10}', '  '.join(f"{name}: {statistics.median(m['medianMs'] for m in res[name][vname]):.1f} ms ({res[name][vname][-1]['calls']} calls)" for name, _ in variants))
