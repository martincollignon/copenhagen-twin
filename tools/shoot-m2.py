#!/usr/bin/env python3
"""Headless WebGPU captures for M2: uv run --with playwright python tools/shoot-m2.py [--port N] [--out docs/m2]"""
import argparse, json, subprocess, sys, time, socket, os
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/m2')
ap.add_argument('--shots', default='all')
ap.add_argument('--query', default='')
ap.add_argument('--verify', action='store_true', help='cleanup check: boots, asserts the HUD and the console, and captures docs/cleanup shots')
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
        page.goto(f'http://127.0.0.1:{port}/index.html?{args.query.lstrip("&")}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
        page.wait_for_timeout(4000)
        view = lambda pos, look, fov=60: page.evaluate('([p,l,f]) => { globalThis.__twin.cameraSystem.debugView = {pos:p, look:l, fov:f}; }', [pos, look, fov])
        def shot(name):
            page.wait_for_timeout(2500)
            page.screenshot(path=f'{args.out}/{name}.png')
        if args.verify:
            os.makedirs(args.out, exist_ok=True)
            errors = []
            fails = []
            def check(name, ok, detail=''):
                print(('PASS' if ok else 'FAIL'), name, detail)
                if not ok: fails.append(name)
            page.wait_for_function('globalThis.__twin.trafficSystem && globalThis.__twin.trafficSystem.cars.some((c) => c.edge)', timeout=120000)
            page.wait_for_timeout(5000)
            check('title', page.title() == 'Copenhagen Twin', page.title())
            check('brand h1', page.text_content('.brand h1') == 'Copenhagen Twin')
            check('speed unit km/h', page.text_content('.gauge-unit') == 'km/h')
            check('altitude unit m', page.text_content('.gauge-alt').strip().endswith('m'), page.text_content('.gauge-alt'))
            body = page.inner_text('body').replace('Based on Slop New York by mrdoob (MIT)', '')
            check('no NYC strings in the HUD', not any(k in body for k in ('mph', 'NYC', 'New York', 'Manhattan', 'Taxi', 'Empire', 'Times Square')))
            check('vehicle label', page.text_content('#hud-active-mode') == 'Car', page.text_content('#hud-active-mode'))
            check('teleports', page.eval_on_selector_all('.tp-btn', 'els => els.map(e => e.querySelector(".pop-name").textContent)') == ['Nørre Søgade 37', 'Dronning Louises Bro', 'Peblinge Sø', 'Nørrebrogade', 'Blågårds Plads'])
            info = page.evaluate("""() => { const t = globalThis.__twin; const ts = t.trafficSystem;
              return { buildings: t.world.buildings && t.world.buildings.stats, cars: ts.cars.filter((c) => c.edge).length, buses: ts.buses.filter((c) => c.edge).length,
                       cyclists: (ts.cyclists || []).length, drawCalls: t.renderer.info.render.drawCalls, location: document.querySelector('#hud-location').textContent }; }""")
            print(json.dumps(info, default=str))
            check('buildings render', bool(info['buildings']) and info['buildings'].get('buildings', 0) > 100)
            check('cars on the road', info['cars'] > 10, str(info['cars']))
            check('buses on the road', info['buses'] > 0, str(info['buses']))
            check('cyclists exist', info['cyclists'] > 0, str(info['cyclists']))
            page.screenshot(path=f'{args.out}/hud-default.png')
            page.click('#btn-teleport'); page.wait_for_timeout(600)
            page.screenshot(path=f'{args.out}/hud-teleport-menu.png')
            page.keyboard.press('Escape'); page.wait_for_timeout(300)
            # teleport to Dronning Louises Bro, then to Nørrebrogade and capture the chase view with traffic around
            for key, shot in (('dlb', 'teleport-dronning-louises-bro'), ('nbro', 'teleport-norrebrogade'), ('blaag', 'teleport-blagards-plads')):
                page.click('#btn-teleport'); page.wait_for_timeout(300)
                page.click(f'#tp-{key}'); page.wait_for_timeout(5000)
                page.screenshot(path=f'{args.out}/{shot}.png')
                print(shot, 'location sign:', page.inner_text('#hud-location').replace('\n', ' | '))
            # chase a car and a cyclist from the live simulation
            page.evaluate("""() => { const t = globalThis.__twin; t.cameraSystem.debugView = null; }""")
            def follow(expr, name, back=14, up=5):
                pos = page.evaluate("""(expr) => { const ts = globalThis.__twin.trafficSystem; const v = eval(expr);
                  return v ? { x: v.x, z: v.z, yaw: (v.yaw ?? 0) + (v.yawOffset ?? 0) } : null; }""", expr)
                if not pos: print('no actor for', name); return
                import math
                fx, fz = math.sin(pos['yaw']), math.cos(pos['yaw'])
                view([pos['x'] - fx * back, up, pos['z'] - fz * back], [pos['x'] + fx * 6, 1.2, pos['z'] + fz * 6], 60)
                page.wait_for_timeout(1500); page.screenshot(path=f'{args.out}/{name}.png')
            follow("ts.cars.find((c) => c.edge && !c.bus && Math.hypot(c.x, c.z) < 300) || ts.cars.find((c) => c.edge)", 'traffic-car')
            follow("ts.buses.find((c) => c.edge)", 'traffic-bus', 22, 6)
            follow("(() => { const p = globalThis.__twin.controllerManager.getActiveEntity().position; return (ts.cyclists || []).filter((c) => c.placed).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0]; })()", 'cyclist', 7, 2.4)
            # every mode and scenic camera runs without errors
            page.evaluate("() => { globalThis.__twin.cameraSystem.debugView = null; }")
            for key in ('1', '3', '4', '2'):
                page.keyboard.press(key); page.wait_for_timeout(1200)
            check('mode label after 2', page.text_content('#hud-active-mode') == 'Car')
            for key, shot in (('8', 'camera-dronning-louises-bro'), ('9', 'camera-ns37'), ('0', 'camera-peblinge')):
                page.keyboard.press(key); page.wait_for_timeout(2500)
                page.screenshot(path=f'{args.out}/{shot}.png')
                check(f'camera {key}', page.text_content('#hud-active-camera') != '3rd-Person Chase', page.text_content('#hud-active-camera'))
            page.click('#cam-menu-btn'); page.click('#cam-drone'); page.wait_for_timeout(2500)
            page.screenshot(path=f'{args.out}/camera-drone.png')
            page.keyboard.press('5')
            view([-420, 330, 380], [20, 0, -20], 50); page.wait_for_timeout(2500); page.screenshot(path=f'{args.out}/aerial.png')
            errs = [l for l in logs if l.startswith(('error', 'pageerror'))]
            check('no console errors', not errs, '\n'.join(errs[:10]))
            print('\n'.join(l for l in logs if l.startswith(('warning', '[init]', 'log: [init]')))[:2000])
            browser.close()
            raise SystemExit(1 if fails else 0)
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
