#!/usr/bin/env python3
"""Headless WebGPU captures for M2: uv run --with playwright python tools/shoot-m2.py [--port N] [--out docs/m2]"""
import argparse, json, subprocess, sys, time, socket, os
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='docs/m2')
ap.add_argument('--shots', default='all')
ap.add_argument('--query', default='')
ap.add_argument('--verify', action='store_true', help='cleanup check: boots, asserts the HUD and the console, and captures docs/cleanup shots')
ap.add_argument('--surfaces', action='store_true', help='M4 ground-surface close-ups (pavement, cycle tracks, junction, square, aerial) into --out')
ap.add_argument('--fixes', action='store_true', help='M4 surface-fix close-ups (side-street mouth, facade sett strip, pedestrian feet, gravel polygon) into --out')
ap.add_argument('--lod2', action='store_true', help='M4 LoD2 roofs: before (?debug=nolod2, flat extrusions) and after shots of pitched roofs into --out (default docs/m4-lod2)')
ap.add_argument('--colours', action='store_true', help='M4 observed colours: before (?debug=noobserved) / after / ?tex=1 shots and fps into --out (default docs/m4-colours)')
ap.add_argument('--water', action='store_true', help='M4 lakes + calibrated facade colours: Peblinge Soe from Dronning Louises Bro day/night, lake path, Norre Sogade facades and aerial before/after into --out (default docs/m4-water-colour)')
ap.add_argument('--furniture', action='store_true', help='M4 street furniture: Nørre Søgade day+night (wire lamps), parked cars, lake-path trees, a bus stop; fps and draw calls (default out docs/m4-furniture)')
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

def surface_views():
    """Camera setups for the M4 ground-surface shots, derived from the data (so they follow the street, not fixed numbers)."""
    import math
    surf = json.load(open(os.path.join(root, 'data/cph-surfaces.json')))
    def seg_near(x, z, only=None):
        best = None
        for r in GEO['roads']:
            if r['class'] not in ('primary', 'secondary', 'residential') or (only and not only(r)): continue
            p = r['pts']
            for i in range(0, len(p) - 2, 2):
                ax, az, bx, bz = p[i], p[i+1], p[i+2], p[i+3]
                dx, dz = bx - ax, bz - az
                l2 = dx*dx + dz*dz or 1
                t = max(0, min(1, ((x-ax)*dx + (z-az)*dz) / l2))
                d = math.hypot(ax + dx*t - x, az + dz*t - z)
                if best is None or d < best[0]: best = (d, dx / l2**.5, dz / l2**.5, r)
        return best
    def pavement_point(x, z):
        # centre of the sidewalk polygon (wider than 2.5 m) nearest to x, z
        best = None
        for s in GEO['sidewalks']:
            r = s['ring']; n = len(r) // 2
            cx = sum(r[0::2]) / n; cz = sum(r[1::2]) / n
            a = abs(sum(r[2*i] * r[(2*i+3) % len(r)] - r[(2*i+2) % len(r)] * r[2*i+1] for i in range(n))) / 2
            per = sum(math.hypot(r[2*((i+1) % n)] - r[2*i], r[2*((i+1) % n)+1] - r[2*i+1]) for i in range(n)) or 1
            if a < 60 or 2 * a / per < 2.4: continue
            d = math.hypot(cx - x, cz - z)
            if best is None or d < best[0]: best = (d, cx, cz)
        return best[1], best[2]
    out = {}
    px, pz = pavement_point(0, 40)
    d, ux, uz, road = seg_near(px, pz)
    out['pavement-norre-sogade'] = ([px - ux * 3.2, 1.7, pz - uz * 3.2], [px + ux * 5, 0.2, pz + uz * 5], 62)
    out['pavement-closeup'] = ([px - ux * 1.2, 0.85, pz - uz * 1.2], [px + ux * 2.2, 0.2, pz + uz * 2.2], 62)
    out['pavement-closeup-down'] = ([px, 1.7, pz], [px + ux * 0.4, 0.2, pz + uz * 0.4], 70)
    dd, dux, duz, droad = seg_near(97, -476.7, lambda r: r['cycleTrack'] != 'none')
    out['dlb-cycle-tracks'] = ([97 - dux * 16 + duz * 0.5, 3.0, -476.7 - duz * 16 - dux * 0.5], [97 + dux * 10, 0.1, -476.7 + duz * 10], 62)
    blues = [m for m in surf['markings'] if m['kind'] == 'bluecycle']
    def cen(m): return (sum(m['ring'][0::2]) / (len(m['ring']) // 2), sum(m['ring'][1::2]) / (len(m['ring']) // 2))
    bx, bz = min((cen(m) for m in blues), key=lambda c: math.hypot(c[0] - 97, c[1] + 476.7))
    out['dlb-junction-blue'] = ([bx + 12, 5.5, bz + 12], [bx, 0, bz], 60)
    out['blagards-plads'] = ([-314.6 + 20, 9, -448 + 20], [-314.6, 0, -448], 60)
    out['blagards-plads-eye'] = ([-314.6 + 7, 1.7, -448 + 5], [-314.6 - 5, 0.3, -448 - 2], 65)
    out['aerial'] = ([-420, 330, 380], [20, 0, -20], 50)
    out['aerial-close'] = ([60, 120, 150], [30, 0, -60], 55)
    return out
def fix_views():
    """Camera setups for the M4 surface-fix shots (positions from the compiled data: see tests/junction-mouths-cph.test.mjs)."""
    out = {}
    mx, mz, dx, dz = 52.6, -95.0, 0.90, 0.43  # Kjeld Langes Gade opening on Nørre Søgade
    out['mouth-norre-sogade'] = ([mx + dx * 16, 7, mz + dz * 16], [mx, 0, mz], 62)
    out['mouth-norre-sogade-low'] = ([mx + dx * 9 + dz * 3, 1.8, mz + dz * 9 - dx * 3], [mx, 0.1, mz], 70)
    out['mouth-norre-sogade-aerial'] = ([mx + 12, 45, mz + 20], [mx, 0, mz], 55)
    # facade sett strip: the longest strip near the teleport (see tests/surface-fixes-cph.test.mjs facadeStrips)
    ux, uz, nx, nz, mx, mz = 0.903, 0.43, 0.43, -0.9, 71.3, -80.7
    out['facade-setts'] = ([mx + nx * 1.9 - ux * 2.4, 0.95, mz + nz * 1.9 - uz * 2.4], [mx + ux * 3, 0.2, mz + uz * 3], 62)
    out['facade-setts-down'] = ([mx + nx * 1.1, 1.7, mz + nz * 1.1], [mx + ux * 0.8 - nx * 0.2, 0.2, mz + uz * 0.8 - nz * 0.2], 70)
    surf = json.load(open(os.path.join(root, 'data/cph-surfaces.json')))
    g = next(s for s in surf['surfaces'] if s['id'].startswith('kk:belaegning:127103f8'))
    gx, gz = sum(g['ring'][0::2]) / (len(g['ring']) // 2), sum(g['ring'][1::2]) / (len(g['ring']) // 2)
    out['gravel-polygon'] = ([gx + 14, 22, gz + 14], [gx, 0, gz], 55)
    out['gravel-polygon-close'] = ([gx + 6, 6, gz + 6], [gx, 0, gz], 60)
    return out
def colour_views():
    """Camera setups for the observed-colour shots, derived from the data."""
    import math
    out = {'aerial': ([-420, 330, 380], [20, 0, -20], 50), 'aerial-close': ([-140, 150, 210], [-60, 8, 40], 55)}
    byid = {b['id']: b for b in GEO['buildings']}
    def cen(r): return sum(r[0::2]) / (len(r) // 2), sum(r[1::2]) / (len(r) // 2)
    rs = [r for r in GEO['roads'] if r.get('name') == 'Nørre Søgade']
    r = max(rs, key=lambda r: len(r['pts'])); p = r['pts']; k = min(max((len(p) // 4) * 2, 2), len(p) - 4)
    dx, dz = p[k + 2] - p[k - 2], p[k + 3] - p[k - 1]; l = math.hypot(dx, dz) or 1; ux, uz = dx / l, dz / l
    mx, mz = p[k], p[k + 1]
    for tag, sgn in (('a', 1), ('b', -1)):
        out[f'norre-sogade-{tag}-street'] = ([mx + uz * 20 * sgn - ux * 14, 1.7, mz - ux * 20 * sgn - uz * 14], [mx - uz * 12 * sgn + ux * 6, 11, mz + ux * 12 * sgn + uz * 6], 66)
        out[f'norre-sogade-{tag}-aerial'] = ([mx + uz * 42 * sgn, 24, mz - ux * 42 * sgn], [mx - uz * 8 * sgn, 11, mz + ux * 8 * sgn], 58)
    # a brick block: the building with the most observed brick-hued wall length near the centre
    best = None
    for b in GEO['buildings']:
        o = b.get('observed')
        if not o or abs(cen(b['ring'])[0]) > 400 or abs(cen(b['ring'])[1]) > 400: continue
        ring = b['ring']; n = len(ring) // 2; score = 0; edge = None
        for w in o['walls']:
            if w['ring'] != 0 or not w['conf'].startswith('observed'): continue
            t = w['tone']
            if not (t[0] > t[1] * 1.25 and t[1] >= t[2] * 0.9 and t[0] > 0.3): continue
            i = w['edge']; j = (i + 1) % n
            L = math.hypot(ring[2*j] - ring[2*i], ring[2*j+1] - ring[2*i+1])
            if L > 12 and w.get('sunlit') and L > score: score, edge = L, (i, j)
        if edge and (best is None or score > best[0]): best = (score, b, edge)
    def wall_view(b, edge, dist, h, fov=62, up=0):
        ring = b['ring']; i, j = edge
        x0, z0, x1, z1 = ring[2*i], ring[2*i+1], ring[2*j], ring[2*j+1]
        L = math.hypot(x1 - x0, z1 - z0); nx, nz = -(z1 - z0) / L, (x1 - x0) / L
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        return ([cx + nx * dist, 1.7 + up, cz + nz * dist], [cx, h, cz], fov)
    if best:
        out['brick-block'] = wall_view(best[1], best[2], 24, 8)
        out['brick-block-high'] = wall_view(best[1], best[2], 40, 8, 55, 18)
        print('brick block', best[1]['id'], round(best[0], 1))
    # photo close-up: the longest, mostly-valid atlas strip near the centre
    pbest = None
    for b in GEO['buildings']:
        a = (b.get('observed') or {}).get('atlas')
        if not a: continue
        c = cen(b['ring'])
        if math.hypot(*c) > 250: continue
        for w in a['walls']:
            if w['ring'] == 0 and w['filled_frac'] < 0.25 and w['len_m'] > 14 and w['h_m'] > 12 and (pbest is None or w['len_m'] > pbest[0]): pbest = (w['len_m'], b, (w['edge'], (w['edge'] + 1) % (len(b['ring']) // 2)))
    if pbest:
        out['tex-closeup'] = wall_view(pbest[1], pbest[2], 20, 9, 62)
        out['tex-closeup-street'] = wall_view(pbest[1], pbest[2], 10, 6, 70)
        print('tex wall', pbest[1]['id'], round(pbest[0], 1))
    return out
def lod2_views():
    """Camera setups for the LoD2 roof shots, derived from the road geometry of the named streets."""
    import math
    def street(name):
        rs = [r for r in GEO['roads'] if r.get('name') == name]
        r = max(rs, key=lambda r: len(r['pts']))
        p = r['pts']; k = (len(p) // 4) * 2  # a vertex near the middle
        k = min(max(k, 2), len(p) - 4)
        dx, dz = p[k + 2] - p[k - 2], p[k + 3] - p[k - 1]
        l = math.hypot(dx, dz) or 1
        return p[k], p[k + 1], dx / l, dz / l
    out = {'overview': ([-420, 330, 380], [20, 0, -20], 50), 'overview-close': ([-140, 150, 210], [-60, 8, 40], 55)}
    for name, key in (('Ravnsborggade', 'ravnsborggade'), ('Blågårdsgade', 'blagardsgade'), ('Ravnsborg Tværgade', 'ravnsborg-tvaergade')):
        mx, mz, ux, uz = street(name)
        out[f'{key}-aerial'] = ([mx - ux * 55, 38, mz - uz * 55], [mx + ux * 12, 8, mz + uz * 12], 58)
        out[f'{key}-street'] = ([mx - ux * 26, 1.7, mz - uz * 26], [mx + ux * 20, 13, mz + uz * 20], 66)
        out[f'{key}-rooftops'] = ([mx - ux * 18 + uz * 6, 22, mz - uz * 18 - ux * 6], [mx + ux * 10, 9, mz + uz * 10], 60)
    mx, mz, ux, uz = street('Nørre Søgade')
    for tag, sgn in (('a', 1), ('b', -1)):
        out[f'norre-sogade-{tag}'] = ([mx + uz * 42 * sgn, 24, mz - ux * 42 * sgn], [mx - uz * 8 * sgn, 11, mz + ux * 8 * sgn], 58)
        out[f'norre-sogade-{tag}-street'] = ([mx + uz * 20 * sgn - ux * 14, 1.7, mz - ux * 20 * sgn - uz * 14], [mx - uz * 12 * sgn + ux * 6, 13, mz + ux * 12 * sgn + uz * 6], 66)
    # close oblique shots of one pitched, multi-plane roof near each street (picked from data/lod2/index.json)
    try:
        index = json.load(open(os.path.join(root, 'data/lod2/index.json')))['buildings']
    except OSError:
        index = {}
    byid = {b['id']: b for b in GEO['buildings']}
    def area(r):
        n = len(r) // 2
        return abs(sum(r[2*i] * r[(2*i+3) % len(r)] - r[(2*i+2) % len(r)] * r[2*i+1] for i in range(n))) / 2
    def cen(r): return sum(r[0::2]) / (len(r) // 2), sum(r[1::2]) / (len(r) // 2)
    for name, key in (('Ravnsborggade', 'ravnsborggade'), ('Blågårdsgade', 'blagardsgade'), ('Nørre Søgade', 'norre-sogade'), ('Sankt Hans Gade', 'sankt-hans-gade')):
        mx, mz, ux, uz = street(name)
        cands = []
        for bid, e in index.items():
            b = byid.get(bid)
            if not b or e.get('roof_type') != 'slanted' or (e.get('planes') or 0) < 5 or 'offset' not in e: continue
            a = area(b['ring'])
            if not 120 < a < 900: continue
            cx, cz = cen(b['ring'])
            cands.append((math.hypot(cx - mx, cz - mz), bid, cx, cz))
        if not cands: continue
        _, bid, cx, cz = min(cands)
        b = byid[bid]
        dx, dz = mx - cx, mz - cz
        dl = math.hypot(dx, dz) or 1
        out[f'pitched-{key}'] = ([cx + dx / dl * 48, b['eave'] + 26, cz + dz / dl * 48], [cx, b['eave'] + 1, cz], 55)
        out[f'pitched-{key}-low'] = ([cx + dx / dl * 34, 1.7, cz + dz / dl * 34], [cx, b['eave'] + 4, cz], 66)
    return out
def water_views():
    """Camera setups for the lakes / calibrated-colour shots (positions from the data: DLB teleport, Peblinge path)."""
    import math
    out = {}
    # Dronning Louises Bro (97, -476.7): on the south parapet looking south-west down Peblinge Soe
    out['peblinge-from-dlb'] = ([97 - 6, 3.2, -476.7 + 10], [-20, -0.5, -250], 62)
    out['peblinge-from-dlb-high'] = ([60, 22, -440], [-60, -1, -250], 58)
    # lake path at eye level along Peblinge Dossering (Norre Sogade side): path at x~-60, z~-300
    out['lake-path-eye'] = ([-70.5, 1.7, -300], [-110, 0, -240], 68)
    out['lake-path-wall'] = ([-70.5, 1.5, -300], [-84, -0.5, -300], 70)
    out['under-bridge'] = ([30, 1.2, -470], [97, -0.4, -480], 70)
    return out
def facade_views():
    c = colour_views()
    return {k: c[k] for k in ('norre-sogade-a-street', 'norre-sogade-b-street', 'norre-sogade-a-aerial', 'aerial', 'aerial-close') if k in c}

def furniture_views():
    """Camera setups for the M4 street-furniture shots, chosen from the data (street names, water edge, bus stops)."""
    import math
    fur = json.load(open(os.path.join(root, 'data/cph-furniture.json')))
    rg = GEO['roadGraph']
    N = rg['nodes']
    def street_segments(name):
        idx = rg['names'].index(name)
        out = []
        for l in rg['links']:
            if l[6] == idx:
                out.append((N[2*l[0]], N[2*l[0]+1], N[2*l[1]], N[2*l[1]+1]))
        return out
    def along(name, near=(0, 0), back=22, h=2.0, fov=64, look_up=3.5, ahead=40):
        """Eye-level view along a street from `back` m before its point nearest `near`."""
        best = None
        for ax, az, bx, bz in street_segments(name):
            mx, mz = (ax + bx) / 2, (az + bz) / 2
            d = math.hypot(mx - near[0], mz - near[1])
            if best is None or d < best[0]: best = (d, ax, az, bx, bz)
        _, ax, az, bx, bz = best
        l = math.hypot(bx - ax, bz - az) or 1
        tx, tz = (bx - ax) / l, (bz - az) / l
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        return ([mx - tx * back, h, mz - tz * back], [mx + tx * ahead, look_up, mz + tz * ahead], fov)
    out = {}
    out['ns-street'] = along('Nørre Søgade', near=(0, 0), back=18, h=2.1, look_up=4.0)
    out['ns-street-up'] = along('Nørre Søgade', near=(0, 0), back=10, h=1.8, look_up=6.5, fov=72)
    out['ravnsborggade'] = along('Ravnsborggade', near=(0, 0), back=26, h=2.4, look_up=1.0, fov=60)
    # lake path: shore points ranked by the number of tall trees within 22 m; the camera stands on the path side 14 m
    # along the shore, outside every building, looking along the tree row
    lake = next(w for w in GEO['water'] if w['name'] == 'Peblinge Sø')
    r = lake['ring']
    def inside(x, z):
        for b in GEO['buildings']:
            q = b['ring']; n = len(q) // 2; c = False
            for i in range(n):
                j = (i - 1) % n
                if (q[2*i+1] > z) != (q[2*j+1] > z) and x < (q[2*j] - q[2*i]) * (z - q[2*i+1]) / (q[2*j+1] - q[2*i+1]) + q[2*i]: c = not c
            if c: return True
        return False
    cands = []
    for i in range(0, len(r), 2):
        x, z = r[i], r[i+1]
        cands.append((sum(1 for t in fur['trees'] if (t['x']-x)**2 + (t['z']-z)**2 < 22**2 and t['height'] > 8), x, z))
    cands.sort(reverse=True)
    cx = sum(r[0::2]) / (len(r) // 2); cz = sum(r[1::2]) / (len(r) // 2)
    for _, lx, lz in cands[:60]:
        dx, dz = cx - lx, cz - lz; dl = math.hypot(dx, dz)
        ux, uz = dx / dl, dz / dl
        cam = (lx - ux * 9 - uz * 16, lz - uz * 9 + ux * 16)  # on the path side (away from the lake), 16 m along the shore
        if not inside(*cam):
            break
    out['lake-trees'] = ([cam[0], 1.9, cam[1]], [lx + uz * 14 - ux * 4, 6.5, lz - ux * 14 - uz * 4], 62)
    out['lake-trees-wide'] = ([lx + ux * 30, 5.0, lz + uz * 30], [lx - ux * 20, 6.0, lz - uz * 20], 66)
    stops = [s for s in fur['busStops'] if s['shelter']] or fur['busStops']
    stops.sort(key=lambda s: math.hypot(s['x'], s['z']))
    s = stops[0]
    fx, fz = math.sin(s['yaw']), math.cos(s['yaw'])
    out['bus-stop'] = ([s['x'] + fx * 9 + s['tangent'][0] * 4, 1.7, s['z'] + fz * 9 + s['tangent'][1] * 4], [s['x'], 1.5, s['z']], 55)
    out['_bus_stop'] = s
    return out

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] + (['--disable-frame-rate-limit', '--disable-gpu-vsync'] if args.perf else []))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'http://127.0.0.1:{port}/index.html?{("hooks&" + args.query.lstrip("&")) if args.furniture else args.query.lstrip("&")}')
        page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
        page.wait_for_timeout(4000)
        view = lambda pos, look, fov=60: page.evaluate('([p,l,f]) => { globalThis.__twin.cameraSystem.debugView = {pos:p, look:l, fov:f}; }', [pos, look, fov])
        def shot(name):
            page.wait_for_timeout(2500)
            page.screenshot(path=f'{args.out}/{name}.png')
        if args.water:
            out_dir = args.out if args.out != 'docs/m2' else 'docs/m4-water-colour'
            os.makedirs(out_dir, exist_ok=True)
            def load(q):
                page.goto(f'http://127.0.0.1:{port}/index.html?{q}')
                page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
                page.wait_for_timeout(4000)
            def time_of_day(tid):
                page.evaluate("(t) => { const l = globalThis.__twin.lightingSystem; l.applyPreset(t); }", tid)
                page.wait_for_timeout(1500)
            load('hooks')
            print('lakes', json.dumps(page.evaluate('() => globalThis.__twin.world.lakes && globalThis.__twin.world.lakes.stats')))
            for tid, tag in (('midday', 'day'), ('midnight', 'night')):
                time_of_day(tid)
                for name, v in water_views().items():
                    view(*v); page.wait_for_timeout(2500)
                    page.screenshot(path=f'{out_dir}/{name}-{tag}.png')
                    print('shot', name, tag)
            fps = {}
            for variant, q in (('before', 'debug=nowater,nocal'), ('after', 'hooks')):
                load(q if 'hooks' in q else 'hooks')
                if variant == 'before':
                    load('hooks&debug=nowater,nocal')
                time_of_day('midday')
                for name, v in facade_views().items():
                    view(*v); page.wait_for_timeout(2500)
                    page.screenshot(path=f'{out_dir}/{name}-{variant}.png')
                    print('shot', name, variant)
                if variant == 'after':
                    view(*water_views()['peblinge-from-dlb'])
                    page.wait_for_timeout(2000)
                    fps['peblinge-from-dlb'] = page.evaluate('''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 3000;
                      const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ fps: +(d.length / 3).toFixed(1), medianMs: +d[d.length >> 1].toFixed(2) }); } };
                      requestAnimationFrame(tick); })''')
            # same view without lakes / with the reflection pass off, for the cost
            load('hooks&water=simple'); time_of_day('midday'); view(*water_views()['peblinge-from-dlb']); page.wait_for_timeout(2000)
            fps['peblinge-from-dlb-simple'] = page.evaluate('''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 3000;
              const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ fps: +(d.length / 3).toFixed(1), medianMs: +d[d.length >> 1].toFixed(2) }); } };
              requestAnimationFrame(tick); })''')
            json.dump(fps, open(f'{out_dir}/fps.json', 'w'), indent=1)
            print(json.dumps(fps))
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning')) and '404' not in l and 'hero' not in l]
            print('\n'.join(errs[:20]))
            browser.close()
            raise SystemExit(0)
        if args.colours:
            out_dir = args.out if args.out != 'docs/m2' else 'docs/m4-colours'
            os.makedirs(out_dir, exist_ok=True)
            views = colour_views()
            fps = {}
            for variant, q in (('before', 'debug=noobserved'), ('after', ''), ('tex', 'tex=1')):
                page.goto(f'http://127.0.0.1:{port}/index.html?{q}')
                page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
                page.wait_for_timeout(4000)
                print(variant, json.dumps(page.evaluate('() => globalThis.__twin.world.buildings && globalThis.__twin.world.buildings.stats'), default=str))
                for name, v in views.items():
                    if variant == 'tex' and not (name.startswith('tex') or name in ('norre-sogade-a-street', 'brick-block', 'aerial-close')): continue
                    view(*v); page.wait_for_timeout(5000 if variant == 'tex' else 2500)
                    page.screenshot(path=f'{out_dir}/{name}-{variant}.png')
                    t = page.evaluate('''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 2500;
                      const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ fps: +(d.length / 2.5).toFixed(1), medianMs: +d[d.length >> 1].toFixed(2) }); } };
                      requestAnimationFrame(tick); })''')
                    fps[f'{name}-{variant}'] = t
                    print('shot', name, variant, json.dumps(t))
                if variant == 'tex':
                    print('tex state', page.evaluate('() => { const m = globalThis.__twin.world.buildings.texManager; return m && { enabled: m.state.enabled, resident: m.state.resident.size, loaded: m.state.loaded, failed: m.state.failed.size }; }'))
            json.dump(fps, open(f'{out_dir}/fps.json', 'w'), indent=1)
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print('\n'.join(errs[:30]))
            browser.close()
            raise SystemExit(0)
        if args.furniture:
            out_dir = args.out if args.out != 'docs/m2' else 'docs/m4-furniture'
            os.makedirs(out_dir, exist_ok=True)
            views = furniture_views()
            print('bus stop', json.dumps(views.pop('_bus_stop'), ensure_ascii=False))
            free = lambda pos, look, fov=60: page.evaluate('([p,l,f]) => { globalThis.__twin.freeCam = {pos:p, target:l, fov:f}; }', [pos, look, fov])
            measure = '''() => new Promise((res) => { const d = []; let last = performance.now(); const end = last + 3000;
              const tick = (now) => { d.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { d.sort((a, b) => a - b); res({ frames: d.length, medianMs: +d[d.length >> 1].toFixed(2), p95Ms: +d[Math.floor(d.length * .95)].toFixed(2), fps: +(d.length / 3).toFixed(1) }); } };
              requestAnimationFrame(tick); })'''
            print('counts', json.dumps(page.evaluate('() => globalThis.__twin.world.furniture && globalThis.__twin.world.furniture.counts')))
            for variant, time_id in (('day', 'midday'), ('night', 'midnight')):
                page.evaluate("(id) => document.querySelector(`[data-time=\"${id}\"]`).click()", time_id)
                page.wait_for_timeout(2500)
                for name, v in views.items():
                    if variant == 'night' and name in ('lake-trees-wide',): continue
                    free(*v); page.wait_for_timeout(3000)
                    page.screenshot(path=f'{out_dir}/{name}-{variant}.png')
                    t = page.evaluate(measure)
                    info = page.evaluate('() => ({ drawCalls: globalThis.__twin.renderer.info.render.drawCalls, triangles: globalThis.__twin.renderer.info.render.triangles, fur: globalThis.__twin.world.furniture.stats })')
                    print(variant, name, json.dumps(t), json.dumps(info))
            print('mesh counts', json.dumps(page.evaluate('() => globalThis.__twin.world.furniture.meshCounts()')))
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print('\n'.join(errs[:30]))
            browser.close()
            raise SystemExit(0)
        if args.lod2:
            out_dir = args.out if args.out != 'docs/m2' else 'docs/m4-lod2'
            os.makedirs(out_dir, exist_ok=True)
            views = lod2_views()
            for variant, dbg in (('after', ''), ('before', 'nolod2')):
                page.goto(f'http://127.0.0.1:{port}/index.html?debug={dbg}')
                page.wait_for_function('globalThis.__twin && globalThis.__twin.world', timeout=120000)
                page.wait_for_timeout(4000)
                print(variant, json.dumps(page.evaluate('() => globalThis.__twin.world.buildings && globalThis.__twin.world.buildings.stats'), default=str))
                for name, v in views.items():
                    view(*v); page.wait_for_timeout(2500)
                    page.screenshot(path=f'{out_dir}/{name}-{variant}.png')
                    print('shot', name, variant)
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print('\n'.join(errs[:20]))
            browser.close()
            raise SystemExit(0)
        if args.fixes:
            os.makedirs(args.out, exist_ok=True)
            for name, v in fix_views().items():
                view(*v); shot(name)
                print('shot', name, v[0])
            # pedestrian feet: the placed pedestrian nearest the player, filmed at knee height; re-aimed just before the
            # capture because pedestrians keep walking
            find_ped = lambda: page.evaluate("""() => { const ps = globalThis.__twin.world.trafficSystem.peds.filter((p) => p.placed); if (!ps.length) return null;
              const e = globalThis.__twin.controllerManager.entities.car.position; ps.sort((a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z));
              const p = ps[0]; return { x: p.x, z: p.z, ux: p.ux * p.dir, uz: p.uz * p.dir }; }""")
            def ped_view(ped, dist=1.5):
                n = (ped['ux'] ** 2 + ped['uz'] ** 2) ** .5 or 1
                ux, uz = ped['ux'] / n, ped['uz'] / n
                return ([ped['x'] - uz * dist + ux * 0.4, 0.4, ped['z'] + ux * dist + uz * 0.4], [ped['x'], 0.45, ped['z']], 50)
            ped = find_ped()
            print('ped', ped)
            if ped:
                view(*ped_view(ped)); page.wait_for_timeout(1500)
                ped = find_ped(); view(*ped_view(ped)); page.wait_for_timeout(120)
                page.screenshot(path=f'{args.out}/pedestrian-feet.png')
                print('shot pedestrian-feet', ped)
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print('\n'.join(errs[:20]))
            browser.close()
            raise SystemExit(0)
        if args.surfaces:
            os.makedirs(args.out, exist_ok=True)
            for name, v in surface_views().items():
                view(*v); shot(name)
                print('shot', name, v[0])
            errs = [l for l in logs if l.startswith(('error', 'pageerror', 'warning'))]
            print('\n'.join(errs[:20]))
            browser.close()
            raise SystemExit(0)
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
            names = page.evaluate("() => globalThis.__twin.world.roadSurfaces.group.children.map((m) => m.name)")
            check('M4 ground surfaces built', all(n in names for n in ('ground-kbh_fortov', 'road-kerb', 'road-cycle', 'road-blue', 'road-paint')), ','.join(names))
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
