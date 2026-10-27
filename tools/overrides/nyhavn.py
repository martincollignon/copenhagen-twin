#!/usr/bin/env python3
"""Nyhavn (PR #15, tools/nyhavn) -> detail-override source set (docs/detail-overrides.md, cph-detail-source/1).

    python3 tools/overrides/nyhavn.py [--project ~/.local/share/building-case-3d/nyhavn] [--data data]
                                      [--out ~/.local/share/cph-twin/overrides/nyhavn] [--atlas-max 1024]

Reads model-v2/building.glb + building.json (Roofer-fitted and inferred buildings on KK footprints) and detail-v3 (photo-traced openings,
cornices, roof windows, chimneys), maps every KK footprint to the GeoDanmark building of the twin's tiles by overlap, and writes per
GeoDanmark building one compact GLB (quantised attributes, one webp atlas of the roof crop and the baked facade photos, vertex colours for the
modelled detail, tiling textures where the source tiles them) plus the parametric details (b) of the photo-traced fronts.

What is published, and what is not (licences, tools/nyhavn/FACADE.md):
  kept     Roofer roofs and walls (DHM Punktsky 2019), Skråfoto 2025 roof and facade pixels (SDFI attribution), GeoDanmark footprints (the
           KK `bygning` objects carry the GeoDanmark id and geometry, IoU ~1), hero openings / dormers / chimneys measured from the 2022
           street photo (Jenny Andersson / News Øresund, CC BY 2.0) and, for dimensions and colours only, the 2018 photo (CC BY-SA 3.0)
  dropped  the two storefront lettering textures (pixel crops of the 2018 CC BY-SA 3.0 photo: the share-alike licence would bind the
           texture), the context (DHM terrain, OSM water, quay faces with the 2022 timber texture, paving, parasols: the twin has its own
           ground, water and quay), and the 19 inferred fallback envelopes (KK footprint extruded to a DSM height with a flat cap: the
           twin's generated building, with its own LoD2 roof and Skråfoto atlas, is at least as good, so it stays)
Walls are sunk to 0.25 m under the twin's lowest terrain along the footprint (js/building-geometry.js groundLow), so an override sits on
the twin's terrain exactly as a generated building does.
"""
from __future__ import annotations

import argparse, hashlib, json, math, re, sys, time
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import (SOURCE_FORMAT, Glb, GlbWriter, TwinFrame, albedo_from_linear, albedo_image, flat_to_pts, linear_to_srgb,  # noqa: E402
                           match_footprints, paste_padded, shelf_pack, srgb_to_linear, texture_bytes, write_json)

ROOT = Path(__file__).resolve().parents[2]

ATTRIBUTION = {
    'geodanmark': {'text': 'Footprints: GeoDanmark Bygning (Klimadatastyrelsen), via Københavns Kommune bygning (same objects)', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk/'},
    'dhm-punktsky': {'text': 'Roofs and walls: DHM Punktsky 2019 (Klimadatastyrelsen), fitted with Roofer', 'licence': 'CC BY 4.0',
                     'url': 'https://dataforsyningen.dk/'},
    'skraafoto-2025': {'text': 'Roof and facade photos: Skråfoto 2025. Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur',
                       'licence': 'CC BY 4.0', 'url': 'https://dataforsyningen.dk/'},
    'street-2022': {'text': 'Nyhavn 9-17 openings, chimneys and colours traced from a 2022 photo by Jenny Andersson / News Øresund', 'licence': 'CC BY 2.0',
                    'url': 'https://commons.wikimedia.org/wiki/File:Nyhavn_9-17_(Copenhagen)_01.jpg'},
    'street-2018': {'text': 'Nyhavn 9-17 roof windows and dimensions measured on a 2018 photo by Liberaler Humanist (reference only, no pixels used)',
                    'licence': 'CC BY-SA 3.0', 'url': 'https://commons.wikimedia.org/wiki/File:Nyhavn_9,11,13,15_and_17_with_boats,_K%C3%B8benhavn.jpg'},
    'nyhavn-reconstruction': {'text': 'Nyhavn reconstruction (tools/nyhavn, copenhagen-twin PR #15)', 'licence': 'MIT', 'url': 'https://github.com/martincollignon/copenhagen-twin'},
}
EXCLUDE_ELEMENTS = {'Photo-traced storefront lettering'}


def attribution_of(extras, image_name=''):
    s = json.dumps(extras.get('src', [])) + json.dumps(extras.get('triangle_sources', [])) + image_name
    keys = {'geodanmark', 'nyhavn-reconstruction'}
    if re.search(r'PUNKTSKY|Punktsky|roofer', s):
        keys.add('dhm-punktsky')
    if re.search(r'Skr.foto|skraafotos2025', s):
        keys.add('skraafoto-2025')
    if re.search(r'2022|Jenny|News', s):
        keys.add('street-2022')
    if re.search(r'2018|Liberaler', s):
        keys.add('street-2018')
    return keys


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--project', default=str(Path.home() / '.local/share/building-case-3d/nyhavn'))
    ap.add_argument('--data', default=str(ROOT / 'data'), help='the twin data dir (tiles/index.json, tiles/<id>/buildings.json + terrain.json)')
    ap.add_argument('--out', default=str(Path.home() / '.local/share/cph-twin/overrides/nyhavn'))
    ap.add_argument('--atlas-max', type=int, default=1024, help='largest side of a building atlas (px)')
    ap.add_argument('--roof-texel', type=float, default=0.15, help='m per texel of the roof crops (the nadir is 0.10 m)')
    ap.add_argument('--keep-fallbacks', action='store_true', help='also publish the inferred fallback envelopes')
    ap.add_argument('--select', choices=('traced', 'photo', 'all'), default='traced',
                    help='which Roofer-fitted buildings replace the generated one: traced (photo-traced fronts and roofs, default), '
                         'photo (also every building with a rectified facade photo), all')
    a = ap.parse_args()
    t0 = time.time()
    proj, out = Path(a.project).expanduser(), Path(a.out).expanduser()
    frame = TwinFrame(Path(a.data))
    model = json.loads((proj / 'model-v2/building.json').read_text())
    glb = Glb(proj / 'model-v2/building.glb')
    facades = json.loads((proj / 'detail-v3/facades.json').read_text())
    roofs = json.loads((proj / 'detail-v3/roofs.json').read_text())
    O = model['frame']['origin']
    oe, on, oh = frame.origin

    def glb_to_local(p):  # glb: x east, y up, z south around O -> twin local (x east, y up, z south)
        return p + np.array([O[0] - oe, O[2] - oh, on - O[1]])

    def en_to_local(e, n):
        return (e - oe, on - n)

    # ------------------------------------------------------------------------------------------------ mapping
    recs = {b['id']: b for b in model['buildings']}
    sources = []
    for b in model['buildings']:
        rings = b['footprint_rings_epsg25832']
        sources.append({'id': b['id'], 'gdk_hint': f"gdk:{b['fot_id']}" if b.get('fot_id') else None,
                        'ring': [en_to_local(*p) for p in rings[0]], 'holes': [[en_to_local(*p) for p in r] for r in rings[1:]]})
    matches, report, _ = match_footprints(sources, frame)

    # ------------------------------------------------------------------------------------------------ glb nodes by source building
    nodes_of = defaultdict(list)
    for nd in glb.json['nodes']:
        if 'mesh' in nd:
            nodes_of[nd.get('extras', {}).get('building_id')].append(nd)
    images = glb.json['images']
    tex_image = [t.get('source', t.get('extensions', {}).get('EXT_texture_webp', {}).get('source')) for t in glb.json['textures']]
    tex_sampler = [t.get('sampler') for t in glb.json['textures']]
    repeat_sampler = {i for i, s in enumerate(glb.json['samplers']) if s.get('wrapS') == 10497 and s.get('wrapT') == 10497}
    image_cache = {}

    def image(i):
        if i not in image_cache:
            image_cache[i] = glb.image(i).convert('RGBA')
        return image_cache[i]

    traced = {t['building_id'] for t in facades['traces']} | {t['building_id'] for t in roofs.get('traces', [])}
    photo = {nd.get('extras', {}).get('building_id') for nd in glb.json['nodes'] if nd.get('extras', {}).get('element') == 'Facade photo texture'}
    targets = defaultdict(list)  # gdk id -> source ids
    skipped = []
    for sid, m in matches.items():
        r = recs[sid]
        if m['kind'] == 'unmatched':
            skipped.append({'source': sid, 'address': r.get('address'), 'reason': 'no GeoDanmark building under the footprint'})
        elif r['geometry_status'] != 'roofer_fit' and not a.keep_fallbacks:
            skipped.append({'source': sid, 'gdk': m['gdk'], 'address': r.get('address'), 'reason': 'inferred fallback envelope: the generated building is kept'})
        elif a.select == 'traced' and sid not in traced or a.select == 'photo' and sid not in traced | photo:
            # the same Roofer roof is the twin's LoD2, and the same Skråfoto 2025 is its facade atlas, with procedural windows close up and the
            # facade shader's shading: without traced detail the generated building is at least as good (docs/detail-overrides.md)
            skipped.append({'source': sid, 'gdk': m['gdk'], 'address': r.get('address'),
                            'reason': f'no traced detail (--select {a.select}): the generated building (same Roofer roof, same Skråfoto source) is kept'})
        else:
            targets[m['gdk']].append(sid)

    out.mkdir(parents=True, exist_ok=True)
    (out / 'meshes').mkdir(exist_ok=True)
    buildings, excluded, lifts = {}, defaultdict(int), []

    hero_traces = defaultdict(list)
    for t in facades['traces']:
        hero_traces[t['building_id']].append(t)
    roof_frames = roofs.get('roof_texture_frames', {})
    roof_attach = {x['feature']: x for x in roofs.get('attachments', [])}
    roof_meshes = defaultdict(list)
    for mm in roofs['meshes']:
        roof_meshes[mm['element']].append(mm)
    roof_traces = defaultdict(list)
    for t in roofs.get('traces', []):
        if t['id'] in roof_attach:
            roof_traces[t['building_id']].append(t)

    appearance_cache = {}

    def wall_tones(tid, gid):
        """{(ring key, edge): linear albedo} of the twin's measured wall tones (calibrated when present), and the building median."""
        if tid not in appearance_cache:
            p = Path(a.data) / 'tiles' / tid / 'appearance.json'
            appearance_cache[tid] = json.loads(p.read_text())['buildings'] if p.exists() else {}
        rec = appearance_cache[tid].get(gid) or {}
        out = {}
        seen = []
        for w in rec.get('walls') or []:
            t = w.get('tone_cal') or w.get('tone')
            if not t:
                continue
            lin = albedo_from_linear(srgb_to_linear(t))
            out[(w.get('ring', 0), w['edge'])] = lin
            if w.get('conf') != 'inferred':
                seen.append(t)
        med = albedo_from_linear(srgb_to_linear(np.median(np.array(seen), axis=0))) if seen else None
        if med is None and (rec.get('summary') or {}).get('wall'):
            med = albedo_from_linear(srgb_to_linear(rec['summary']['wall']))
        return out, med

    def shell_colours(pr, rec, tones, med):
        """Per-vertex colours of a wall shell: the twin's tone of the footprint edge each triangle stands on (nearest, parallel)."""
        edges = []
        for rk, ring in [(0, rec['ring'])] + [(f'hole_{k}', h) for k, h in enumerate(rec.get('holes') or [])]:
            pts = flat_to_pts(ring)
            for i in range(len(pts)):
                edges.append((rk, i, pts[i], pts[(i + 1) % len(pts)]))
        pos, nor = pr['pos'], pr['nor']
        col = np.zeros((len(pos), 4))
        col[:, 3] = 1
        base = med if med is not None else albedo_from_linear(np.array(pr['color'][:3]))
        for t in range(0, len(pos), 3):
            c = pos[t:t + 3].mean(0)
            n = nor[t]
            best, tone = 2.5, base
            for rk, i, p, q in edges:
                dx, dz = q[0] - p[0], q[1] - p[1]
                L2 = dx * dx + dz * dz or 1
                u = max(0, min(1, ((c[0] - p[0]) * dx + (c[2] - p[1]) * dz) / L2))
                d = math.hypot(p[0] + dx * u - c[0], p[1] + dz * u - c[2])
                L = math.sqrt(L2)
                par = abs(n[0] * dz - n[2] * dx) / L / (math.hypot(n[0], n[2]) or 1)  # |cos| of the wall normal and the edge normal
                if d < best and par > 0.6 and (rk, i) in tones:
                    best, tone = d, tones[(rk, i)]
            col[t:t + 3, :3] = tone
        return col

    for gid, sids in sorted(targets.items()):
        m0 = matches[sids[0]]
        tid = m0['tile']
        rec = frame.buildings(tid)[gid]
        low = frame.ground_low(rec)
        tones, tone_med = wall_tones(tid, gid)
        prims, attrib, elements, confs = [], set(), set(), set()
        for sid in sids:
            for nd in nodes_of.get(sid, []):
                ex = nd.get('extras', {})
                if ex.get('element') in EXCLUDE_ELEMENTS:
                    excluded[ex['element']] += 1
                    continue
                for p in glb.json['meshes'][nd['mesh']]['primitives']:
                    mat = glb.json['materials'][p['material']]
                    pbr = mat.get('pbrMetallicRoughness', {})
                    pos, nor, uv = glb.triangles(p)
                    if nor is None:
                        e1, e2 = pos[1::3] - pos[0::3], pos[2::3] - pos[0::3]
                        nor = np.repeat(np.cross(e1, e2), 3, axis=0)
                    t = pbr.get('baseColorTexture')
                    img = tex_image[t['index']] if t else None
                    pr = {'name': nd['name'], 'element': ex.get('element', ''), 'pos': glb_to_local(pos), 'nor': nor, 'uv': uv, 'image': img,
                          'repeat': bool(t) and tex_sampler[t['index']] in repeat_sampler, 'blend': mat.get('alphaMode') == 'BLEND',
                          'color': pbr.get('baseColorFactor', [1, 1, 1, 1]), 'rough': pbr.get('roughnessFactor', 0.85)}
                    prims.append(pr)
                    attrib |= attribution_of(ex, images[img]['name'] if img is not None else '')
                    elements.add(pr['element'])
                    confs.add(ex.get('conf', 'inferred'))
        if not prims:
            skipped.append({'source': sids, 'gdk': gid, 'reason': 'no mesh in the GLB'})
            continue

        # walls stand on the twin's terrain: every vertex on the bottom of the building moves to 0.25 m under the lowest ground
        bottom = min(pr['pos'][:, 1].min() for pr in prims)
        target = low - 0.25
        lift = bottom - target
        lifts.append(lift)
        if bottom > target:
            for pr in prims:
                sel = pr['pos'][:, 1] <= bottom + 0.03
                pr['pos'][sel, 1] = target
        # photo overlays: baked over their paint backing (same triangles, 2 cm in front); the backing goes
        backing = {pr['name'][:-len('/WallSurface/paint-backing')]: pr for pr in prims if pr['name'].endswith('/WallSurface/paint-backing')}
        used_backing = set()
        atlas_regions = []  # (key, PIL image)
        region_of = {}
        for pr in prims:
            if pr['image'] is None or pr['repeat']:
                continue
            if pr['blend']:
                key = pr['name'][:-len('/FacadePhoto')] if pr['name'].endswith('/FacadePhoto') else pr['name']
                bk = backing.get(key)
                tone = linear_to_srgb(bk['color'][:3]) if bk else np.array([0.6, 0.55, 0.5])
                if bk:
                    used_backing.add(bk['name'])
                rk = ('facade', pr['image'], tuple(np.round(tone, 3)))
                if rk not in region_of:
                    src = image(pr['image'])
                    base = Image.new('RGBA', src.size, tuple(int(round(c * 255)) for c in tone) + (255,))
                    region_of[rk] = len(atlas_regions)
                    atlas_regions.append((rk, albedo_image(Image.alpha_composite(base, src)), (0, 0) + src.size))
                pr['uv'] = np.clip(pr['uv'], 0, 1)
                pr['region'] = region_of[rk]
            else:  # a clamped photo (the nadir): this building's crop of it
                rk = ('crop', pr['image'])
                pr['region_key'] = rk
        crops = defaultdict(list)
        for pr in prims:
            if 'region_key' in pr:
                crops[pr['region_key']].append(pr)
        for rk, prs in crops.items():
            src = image(rk[1])
            W, H = src.size
            uv = np.concatenate([np.clip(p['uv'], 0, 1) for p in prs])
            x0, y0 = max(0, int(math.floor(uv[:, 0].min() * W)) - 1), max(0, int(math.floor(uv[:, 1].min() * H)) - 1)
            x1, y1 = min(W, int(math.ceil(uv[:, 0].max() * W)) + 1), min(H, int(math.ceil(uv[:, 1].max() * H)) + 1)
            region_of[rk] = len(atlas_regions)
            crop = albedo_image(src.crop((x0, y0, x1, y1)))
            f = min(1.0, 0.10 / a.roof_texel)  # Skråfoto nadir GSD 0.10 m
            if f < 1:
                crop = crop.resize((max(1, round(crop.size[0] * f)), max(1, round(crop.size[1] * f))), Image.LANCZOS)
            atlas_regions.append((rk, crop, (x0, y0, W, H, f)))
            for p in prs:
                p['uv'] = np.clip(p['uv'], 0, 1)
                p['region'] = region_of[rk]
        prims = [pr for pr in prims if pr['name'] not in used_backing]

        w = GlbWriter()
        children, stats = [], {'triangles': 0, 'gpuBytes': 0, 'textures': [], 'textureBytes': 0, 'webpBytes': 0}
        ex_common = {'building_id': gid, 'source_ids': sids, 'attribution': sorted(attrib)}
        # 1. the atlas
        atlas_prims = [pr for pr in prims if 'region' in pr]
        if atlas_prims:
            sizes = [im.size for _, im, _ in atlas_regions]
            AW, AH, place = shelf_pack(sizes, max_w=a.atlas_max)
            scale = min(1.0, a.atlas_max / max(AW, AH))
            atlas = Image.new('RGB', (AW, AH), (128, 128, 128))
            for (rk, im, _), (x, y) in zip(atlas_regions, place):
                paste_padded(atlas, im, x, y, 2)
            for pr in atlas_prims:
                rk, im, box = atlas_regions[pr['region']]
                x, y = place[pr['region']]
                if rk[0] == 'facade':
                    px, py = pr['uv'][:, 0] * im.size[0], pr['uv'][:, 1] * im.size[1]
                else:
                    cx0, cy0, W, H, f = box
                    px, py = (pr['uv'][:, 0] * W - cx0) * f, (pr['uv'][:, 1] * H - cy0) * f
                pr['auv'] = np.stack([(x + px) / AW, (y + py) / AH], axis=1)
            if scale < 1:
                atlas = atlas.resize((max(1, round(AW * scale)), max(1, round(AH * scale))), Image.LANCZOS)
            ti, size, nbytes = w.texture(atlas, f'{gid} atlas: Skråfoto 2025 roof crop and rectified facades')
            stats['textures'].append(list(size))
            stats['webpBytes'] += nbytes
            mi = w.material('atlas', texture=ti, roughness=0.86, extras={'attribution': ['skraafoto-2025', 'dhm-punktsky'], 'conf': 'observed'})
            pos = np.concatenate([p['pos'] for p in atlas_prims])
            nor = np.concatenate([p['nor'] for p in atlas_prims])
            auv = np.concatenate([p['auv'] for p in atlas_prims])
            ni, st = w.mesh(f'{gid}/photo', pos, nor, uv=auv, material=mi,
                            extras={**ex_common, 'part': 'photo', 'elements': sorted({p['element'] for p in atlas_prims}), 'conf': 'observed'})
            children.append(ni)
            stats['triangles'] += st['triangles']
            stats['gpuBytes'] += st['gpuBytes']
        # 2. tiling textures (procedural roof tiles, brick, paint), one material each
        by_img = defaultdict(list)
        for pr in prims:
            if pr['image'] is not None and pr['repeat']:
                by_img[pr['image']].append(pr)
        for img, prs in by_img.items():
            im = image(img)
            if max(im.size) > 512:
                im = im.resize((max(1, im.size[0] * 512 // max(im.size)), max(1, im.size[1] * 512 // max(im.size))), Image.LANCZOS)
            ti, size, nbytes = w.texture(albedo_image(im), images[img]['name'], repeat=True)
            stats['textures'].append(list(size))
            stats['webpBytes'] += nbytes
            c = prs[0]['color']
            mi = w.material(images[img]['name'], texture=ti, color=c, roughness=prs[0]['rough'], extras={'conf': 'inferred', 'attribution': ['street-2022', 'street-2018']})
            ni, st = w.mesh(f'{gid}/tiled-{img}', np.concatenate([p['pos'] for p in prs]), np.concatenate([p['nor'] for p in prs]),
                            uv=np.concatenate([p['uv'] for p in prs]), uv_tiling=True, material=mi,
                            extras={**ex_common, 'part': 'tiled', 'elements': sorted({p['element'] for p in prs}), 'conf': 'inferred'})
            children.append(ni)
            stats['triangles'] += st['triangles']
            stats['gpuBytes'] += st['gpuBytes']
        # 3. untextured: vertex colours (linear), matte and glossy (glass) apart
        for glossy in (False, True):
            prs = [pr for pr in prims if pr['image'] is None and (pr['rough'] < 0.55) == glossy]
            if not prs:
                continue
            col = np.concatenate([shell_colours(p, rec, tones, tone_med) if p['element'] == 'WallSurface shell'
                                  else np.repeat([list(albedo_from_linear(np.array(p['color'][:3]))) + [1.0]], len(p['pos']), axis=0) for p in prs])
            mi = w.material('glass' if glossy else 'painted', roughness=0.35 if glossy else 0.86, metallic=0.0,
                            extras={'conf': 'inferred', 'note': 'vertex colours (linear) of the source materials'})
            ni, st = w.mesh(f'{gid}/{"glass" if glossy else "painted"}', np.concatenate([p['pos'] for p in prs]), np.concatenate([p['nor'] for p in prs]),
                            color=col, material=mi,
                            extras={**ex_common, 'part': 'glass' if glossy else 'painted', 'elements': sorted({p['element'] for p in prs}),
                                    'conf': sorted({'inferred'} | ({'observed'} if any('Surface' in p['element'] for p in prs) else set()))})
            children.append(ni)
            stats['triangles'] += st['triangles']
            stats['gpuBytes'] += st['gpuBytes']
        allpos = np.concatenate([p['pos'] for p in prims])
        bounds = [round(float(v), 2) for v in list(allpos.min(0)) + list(allpos.max(0))]
        confidence = 'observed' if 'observed' in confs else 'inferred'
        details = hero_details(gid, sids, recs, rec, facades, hero_traces, roof_frames, roof_attach, roof_meshes, roof_traces, glb_to_local, en_to_local, frame)
        root_extras = {**ex_common, 'format': 'cph-detail/1', 'confidence': confidence, 'match': {k: m0[k] for k in ('kind', 'iou', 'hausdorff', 'covers')},
                       'licences': {k: ATTRIBUTION[k]['licence'] for k in sorted(attrib)}}
        w.root(gid, children, extras=root_extras)
        body = w.bytes(asset_extras={'frame': {'epsg': 25832, 'vertical': 'DVR90', 'origin': frame.origin, 'axes': 'x=east, y=up, z=south (the twin tile frame)'},
                                     'attribution': {k: ATTRIBUTION[k]['text'] for k in sorted(attrib)}})
        stem = gid.replace(':', '_')
        (out / 'meshes' / f'{stem}.glb').write_bytes(body)
        stats['textureBytes'] = sum(texture_bytes(*s) for s in stats['textures'])
        entry = {
            'tile': tid, 'mode': 'replace', 'covers': m0['covers'],
            'source': {'set': 'nyhavn', 'ids': sids, 'kind': 'kk-bygning', 'reconstruction': model.get('version')},
            'match': {k: m0[k] for k in ('kind', 'iou', 'hausdorff')},
            'footprint': {'use': m0['footprint']},
            'confidence': confidence,
            'attribution': sorted(attrib),
            'bounds': bounds,
            'ground': rec['ground'], 'low': round(low, 3), 'sunk': round(float(lift), 3),
            'mesh': {'path': f'meshes/{stem}.glb', 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], 'triangles': stats['triangles'],
                     'textures': stats['textures'], 'textureBytes': stats['textureBytes'], 'gpuBytes': stats['gpuBytes']},
        }
        if m0['footprint'] == 'override':
            from shapely.geometry import Polygon
            from shapely.ops import unary_union
            u = unary_union([Polygon([en_to_local(*p) for p in recs[s]['footprint_rings_epsg25832'][0]]) for s in sids]).buffer(0)
            if u.geom_type == 'Polygon':
                entry['footprint']['ring'] = [round(v, 2) for p in list(u.exterior.coords)[:-1] for v in p]
                entry['footprint']['holes'] = [[round(v, 2) for p in list(h.coords)[:-1] for v in p] for h in u.interiors]
        if details:
            entry['details'] = details
        buildings[gid] = entry

    used_attr = sorted({k for b in buildings.values() for k in b['attribution']})
    doc = {
        'format': SOURCE_FORMAT, 'name': 'nyhavn', 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'description': f'Nyhavn waterfront (--select {a.select}): Roofer-fitted buildings with photo-traced fronts and roofs (Nyhavn 9-17)'
                       + ('' if a.select == 'traced' else ', and Skråfoto 2025 roof and facade photos'),
        'select': a.select,
        'frame': {'epsg': 25832, 'vertical': 'DVR90', 'origin': frame.origin, 'tiles': frame.index.get('generated')},
        'source': {'project': str(proj), 'reconstruction': model.get('version'), 'generated': model.get('generated'),
                   'glb_sha256': hashlib.sha256((proj / 'model-v2/building.glb').read_bytes()).hexdigest()[:16]},
        'attribution': {k: ATTRIBUTION[k] for k in used_attr},
        'buildings': buildings,
        'skipped': skipped,
        'excluded': [{'element': k, 'nodes': v, 'reason': 'pixel crop of the 2018 CC BY-SA 3.0 photo (share-alike would bind the texture)'} for k, v in excluded.items()]
                    + [{'element': 'context (terrain, water, quay, paving, parasols)', 'reason': 'the twin has its own ground, water and quay'}],
    }
    write_json(out / 'overrides.json', doc)
    tot = lambda k: sum(b['mesh'][k] for b in buildings.values())
    report.update({
        'published': len(buildings), 'skipped': len(skipped), 'skippedReasons': {r: sum(1 for s in skipped if s['reason'] == r) for r in {s['reason'] for s in skipped}},
        'tiles': {t: sum(1 for b in buildings.values() if b['tile'] == t) for t in sorted({b['tile'] for b in buildings.values()})},
        'sizes': {'glbBytes': tot('bytes'), 'triangles': tot('triangles'), 'textureBytes': tot('textureBytes'), 'gpuBytes': tot('gpuBytes'),
                  'largestGlb': max(b['mesh']['bytes'] for b in buildings.values()), 'largestTextureBytes': max(b['mesh']['textureBytes'] for b in buildings.values())},
        'sunk_m': {'min': round(min(lifts), 3), 'max': round(max(lifts), 3), 'median': round(sorted(lifts)[len(lifts) // 2], 3),
                   'note': 'source wall bottom minus (twin groundLow - 0.25 m); > 0: walls extended down to the twin terrain'},
        'details': {'buildings': sum(1 for b in buildings.values() if b.get('details')),
                    **{k: sum(len(b.get('details', {}).get(k, [])) for b in buildings.values()) for k in ('openings', 'cornices', 'dormers', 'chimneys')}},
        'seconds': round(time.time() - t0, 1),
    })
    write_json(out / 'mapping-report.json', report)
    print(json.dumps({k: v for k, v in report.items() if k != 'cases'}, indent=1))
    if report['cases']:
        print(f"{len(report['cases'])} non-1:1 or out-of-tolerance cases: see {out / 'mapping-report.json'}")


def ring_edges(flat):
    pts = flat_to_pts(flat)
    return [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]


def gdk_edge(rec, a, b):
    """Index of the gdk ring edge that carries the source edge a -> b (local x, z), and the u offset of a along it."""
    best = None
    for i, (p, q) in enumerate(ring_edges(rec['ring'])):
        dx, dz = q[0] - p[0], q[1] - p[1]
        L = math.hypot(dx, dz)
        if L < 1e-6:
            continue
        ux, uz = dx / L, dz / L
        # distance of a and b from the edge line, and direction agreement
        da = abs((a[0] - p[0]) * uz - (a[1] - p[1]) * ux)
        db = abs((b[0] - p[0]) * uz - (b[1] - p[1]) * ux)
        bl = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
        cos = ((b[0] - a[0]) * ux + (b[1] - a[1]) * uz) / bl
        score = da + db + (0 if cos > 0.9 else 100)
        if best is None or score < best[0]:
            best = (score, i, (a[0] - p[0]) * ux + (a[1] - p[1]) * uz, L)
    return (best[1], best[2], best[3]) if best and best[0] < 1.0 else (None, 0, 0)


def hero_details(gid, sids, recs, rec, facades, hero_traces, roof_frames, roof_attach, roof_meshes, roof_traces, glb_to_local, en_to_local, frame):
    """The photo-traced fronts as parametric details (b): openings and cornices on gdk wall edges, dormers on the eave edge, chimneys at a point.
    v is metres above the gdk record's `ground` (local frame); u metres from the edge's first vertex. `baked`: the mesh carries them already."""
    oh = frame.origin[2]
    ground = rec['ground']
    openings, cornices, dormers, chimneys = [], [], [], []
    kind_of = {'window': 'window', 'storefront': 'shopfront', 'door': 'door', 'arched_door': 'door', 'round_window': 'round'}
    pts_of = defaultdict(list)  # trace id -> mesh points [E, N, H] (traces without a world quad: bands and cornices)
    for mm in facades['meshes']:
        for tr in mm.get('trace_ids') or []:
            pts_of[(mm['building_id'], tr)] += [p for t3 in mm['triangles'] for p in t3]
    for sid in sids:
        src = recs[sid]
        ring = src['footprint_rings_epsg25832'][0]
        for t in hero_traces.get(sid, []):
            el = t['element']
            if el not in kind_of and el not in ('cornice', 'storey_band'):
                continue
            k = t['edge']
            a, b = en_to_local(*ring[k]), en_to_local(*ring[(k + 1) % len(ring)])
            ei, u0, L = gdk_edge(rec, a, b)
            if ei is None:
                continue
            q = t.get('source_quad_world_uv') or []
            if q:
                us, hs = [p[0] + u0 for p in q], [p[1] for p in q]
            else:  # measured on the traced mesh: u along the gdk edge, v the height
                pts = pts_of.get((sid, t.get('feature_id')))
                if not pts:
                    continue
                pe = flat_to_pts(rec['ring'])[ei]
                qn = flat_to_pts(rec['ring'])[(ei + 1) % (len(rec['ring']) // 2)]
                L2 = math.hypot(qn[0] - pe[0], qn[1] - pe[1]) or 1
                dx, dz = (qn[0] - pe[0]) / L2, (qn[1] - pe[1]) / L2
                loc = [en_to_local(p[0], p[1]) for p in pts]
                us = [(x - pe[0]) * dx + (z - pe[1]) * dz for x, z in loc]
                hs = [p[2] for p in pts]
            u = [round(min(us), 3), round(max(us), 3)]
            v = [round(min(hs) - oh - ground, 3), round(max(hs) - oh - ground, 3)]
            srcs = ['street-2022' if '2022' in t.get('source', '') else 'street-2018']
            if el in kind_of:
                openings.append({'edge': ei, 'u': u, 'v': v, 'kind': kind_of[el], 'id': t.get('feature_id'), 'conf': t.get('conf', 'inferred'), 'src': srcs})
            else:
                cornices.append({'edge': ei, 'u': u, 'v': v[0], 'height': round(v[1] - v[0], 3), 'depth': 0.18 if el == 'cornice' else 0.08,
                                 'kind': el, 'conf': t.get('conf', 'inferred'), 'src': srcs})
        fr = roof_frames.get(sid)
        for t in roof_traces.get(sid, []):
            at = roof_attach[t['id']]
            srcs = ['street-2022' if '2022' in t.get('source_file', '') else 'street-2018']
            parts = [mm for k, v in roof_meshes.items() if k.startswith(t['id'] + ' ') for mm in v]
            if not parts or not fr:
                continue
            tri = np.array([p for mm in parts for tr in mm['triangles'] for p in tr])
            loc = np.stack([tri[:, 0] - frame.origin[0], tri[:, 2] - oh, frame.origin[1] - tri[:, 1]], axis=1)
            mn, mx = loc.min(0), loc.max(0)
            if 'base_dvr90' in at:  # chimney / flue
                chimneys.append({'at': [round(float((mn[0] + mx[0]) / 2), 3), round(float((mn[2] + mx[2]) / 2), 3)],
                                 'size': [round(float(mx[0] - mn[0]), 3), round(float(mx[2] - mn[2]), 3)],
                                 'base': round(at['base_dvr90'] - oh - ground, 3), 'top': round(float(mx[1]) - ground, 3),
                                 'kind': 'flue' if 'flue' in t['id'] else 'chimney', 'id': t['id'], 'conf': 'inferred', 'src': srcs})
            else:
                o = en_to_local(*fr['origin_en'])
                al = fr['along_eave_xy']
                a = o
                b = (o[0] + al[0], o[1] - al[1])
                ei, u0, L = gdk_edge(rec, a, b)
                if ei is None:
                    continue
                c, wdt = at['center_u_m'], at['width_m']
                dormers.append({'edge': ei, 'u': [round(u0 + c - wdt / 2, 3), round(u0 + c + wdt / 2, 3)],
                                'base': [round(sum(at['front_base_dvr90']) / 2 - oh - ground, 3), round(sum(at['rear_base_dvr90']) / 2 - oh - ground, 3)],
                                'top': round(at['cap_dvr90'] - oh - ground, 3), 'depth': at['depth_m'], 'kind': 'roof-window', 'id': t['id'],
                                'conf': 'inferred', 'src': srcs})
    if not (openings or cornices or dormers or chimneys):
        return None
    return {'baked': True, 'openings': openings, 'cornices': cornices, 'dormers': dormers, 'chimneys': chimneys}


if __name__ == '__main__':
    main()
