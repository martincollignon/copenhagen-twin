#!/usr/bin/env python3
"""Measure the full city, including settled streaming, at real gameplay cameras.

uv run --with playwright python tools/perf/frame-budget.py --out .context/fps/after
Add --baseline-ref HEAD to serve the committed code against the same city data.
"""
import argparse
import functools
import http.server
import json
from pathlib import Path
import subprocess
import threading
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from playwright.sync_api import sync_playwright


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data', default='https://pub-d3c994d177d048d5b64ecfc3df496b48.r2.dev')
    ap.add_argument('--query', default='')
    ap.add_argument('--out', default='.context/fps/current')
    ap.add_argument('--baseline-ref', default=None)
    ap.add_argument('--size', default='1920x1080')
    ap.add_argument('--scenes', default='spawn,cargo,lake,aerial')
    ap.add_argument('--seconds', type=float, default=5)
    ap.add_argument('--warm', type=float, default=8)
    ap.add_argument('--min-fps', type=float, default=30)
    ap.add_argument('--port', type=int, default=8000, help='R2 CORS permits localhost:8000')
    args = ap.parse_args()
    width, height = (int(n) for n in args.size.split('x'))
    if min(width, height, args.seconds) <= 0 or args.warm < 0:
        ap.error('size and seconds must be positive; warm must be nonnegative')
    scenes = args.scenes.split(',')
    if any(s not in ('spawn', 'cargo', 'lake', 'aerial', 'drive') for s in scenes):
        ap.error('scenes: spawn,cargo,lake,aerial,drive')
    root = Path(__file__).resolve().parents[2]
    if args.baseline_ref:
        result = subprocess.run(['git', 'rev-parse', '--verify', f'{args.baseline_ref}^{{commit}}'], cwd=root, capture_output=True, text=True)
        if result.returncode:
            ap.error('baseline-ref must name an existing commit')
        args.baseline_ref = result.stdout.strip()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Handler, directory=str(root)))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    report = {'baselineRef': args.baseline_ref, 'data': args.data, 'size': [width, height], 'results': [], 'errors': errors}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                '--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist',
                '--disable-frame-rate-limit', '--disable-gpu-vsync'
            ])
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and not m.text.startswith('Failed to load resource:') else None)
            if args.baseline_ref:
                # Serve committed application files through the same origin and asset paths.
                committed = {}

                def baseline(route):
                    path = unquote(urlsplit(route.request.url).path).lstrip('/') or 'index.html'
                    if path == 'index.html' or path.startswith(('js/', 'css/')):
                        if path not in committed:
                            result = subprocess.run(['git', 'show', f'{args.baseline_ref}:{path}'], cwd=root, capture_output=True)
                            committed[path] = result.stdout if result.returncode == 0 else None
                        if committed[path] is not None:
                            mime = 'text/javascript' if path.endswith('.js') else 'text/css' if path.endswith('.css') else 'text/html'
                            route.fulfill(body=committed[path], content_type=mime)
                            return
                    route.continue_()

                page.route(f'http://localhost:{args.port}/**', baseline)
            query = dict(parse_qsl(args.query, keep_blank_values=True))
            query.update(hooks='', data=args.data, heroes='0')
            page.goto(f'http://localhost:{args.port}/?{urlencode(query)}')
            page.wait_for_selector('#loading-overlay.hidden', state='attached', timeout=240000)
            page.wait_for_function('() => !!globalThis.__twin?.stream', timeout=5000)
            print('Full city ready', flush=True)

            def settle():
                page.wait_for_timeout(args.warm * 1000)
                page.wait_for_function('''() => {
                  const t = __twin, s = t.stream.snapshot(), b = t.world.buildings.photoBudget?.memory();
                  return s.fetching === 0 && s.building === 0 && (!b || b.pendingCount === 0);
                }''', timeout=180000)

            for scene in scenes:
                if scene in ('cargo', 'drive'):
                    page.evaluate('''mode => {
                      __twin.freeCam = null;
                      document.querySelector(`[data-mode="${mode === 'cargobike' ? 'cyclist' : 'car'}"]`).click();
                      if (mode === 'cargobike') document.querySelector('[data-bike-type="cargobike"]').click();
                      document.querySelector('[data-teleport="ns37"]').click();
                    }''', 'cargobike' if scene == 'cargo' else 'car')
                elif scene in ('lake', 'aerial'):
                    page.evaluate('''name => {
                      __twin.freeCam = name === 'lake'
                        ? {pos:[91,10,-467],target:[-20,7,-250],fov:62}
                        : {pos:[-420,330,380],target:[20,0,-20],fov:50};
                    }''', scene)
                settle()
                page.evaluate('() => { __twin.frameLog.length = 0; }')
                if scene == 'drive':
                    page.keyboard.down('w')
                sample = page.evaluate('''seconds => new Promise(resolve => {
                  const times = [], start = performance.now();
                  let last = start;
                  const tick = now => {
                    times.push(now-last); last = now;
                    if (now-start < seconds*1000) { requestAnimationFrame(tick); return; }
                    times.sort((a,b) => a-b);
                    const t = __twin, stream = t.stream.snapshot();
                    resolve({fps:times.length*1000/(now-start), medianMs:times[times.length>>1],
                      p95Ms:times[Math.floor(times.length*.95)], frames:times.length,
                      drawCalls:t.renderer.info.render.drawCalls, triangles:t.renderer.info.render.triangles,
                      rendererBytes:t.renderer.info.memory.total, facade:t.world.buildings.texManager?.memory,
                      resident:{near:stream.resident.near,mid:stream.resident.mid},
                      backend:t.renderer.backend.isWebGPUBackend ? 'webgpu':'webgl',
                      streamErrors:stream.errors, slowFrames:t.frameLog.slice(-10)});
                  };
                  requestAnimationFrame(tick);
                })''', args.seconds)
                if scene == 'drive':
                    page.keyboard.up('w')
                sample['scene'] = scene
                report['results'].append(sample)
                page.screenshot(path=str(out / f'{scene}.png'))
                print(scene, json.dumps({k: sample[k] for k in ('fps', 'medianMs', 'p95Ms', 'drawCalls', 'triangles')}), flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        (out / 'frames.json').write_text(json.dumps(report, indent=2) + '\n')
    failures = [s['scene'] for s in report['results'] if s['fps'] < args.min_fps or s['streamErrors']]
    if errors or failures:
        print(f'FAIL: below {args.min_fps:g} FPS or streaming errors: {failures}; rendering errors: {len(errors)}')
        for error in errors[:5]:
            print(error)
        return 1
    print(f'PASS: every measured view >= {args.min_fps:g} FPS; no rendering or streaming errors')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
