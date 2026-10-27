"""Shared helpers of the detail-override tools (docs/detail-overrides.md): GLB reading and writing (KHR_mesh_quantization, EXT_texture_webp),
a shelf atlas packer, the twin's tile frame and terrain, footprint matching against the GeoDanmark buildings of the tiles.

Pure Python + numpy + Pillow (+ shapely for the footprint match). No network.
"""
from __future__ import annotations

import base64, io, json, math, os, struct
from pathlib import Path

import numpy as np
from PIL import Image

SOURCE_FORMAT = 'cph-detail-source/1'
LAYER_FORMAT = 'cph-detail/1'
TILE_SIZE = 500.0


# ------------------------------------------------------------------------------------------------------------- the twin frame
class TwinFrame:
    """The tile index frame: local x = E - origin E, z = origin N - N, y = H - origin H (x east, z south, y up)."""

    def __init__(self, data_dir: Path):
        self.data = Path(data_dir)
        self.index = json.loads((self.data / 'tiles/index.json').read_text())
        self.origin = self.index['frame']['origin']
        self.meta = json.loads((self.data / 'city/meta.json').read_text())
        self.terrain_header = self.meta.get('terrain')
        self._buildings = {}
        self._terrain = {}

    def to_local(self, e, n, h=None):
        x, z = e - self.origin[0], self.origin[1] - n
        return (x, z) if h is None else (x, h - self.origin[2], z)

    def tile_of_local(self, x, z):
        e, n = x + self.origin[0], self.origin[1] - z
        return f'{int(math.floor(e / TILE_SIZE))}_{int(math.floor(n / TILE_SIZE))}'

    def tiles_around(self, x0, z0, x1, z1, margin=0.0):
        out = set()
        for x in np.arange(x0 - margin, x1 + margin + TILE_SIZE, TILE_SIZE / 2):
            for z in np.arange(z0 - margin, z1 + margin + TILE_SIZE, TILE_SIZE / 2):
                t = self.tile_of_local(min(x, x1 + margin), min(z, z1 + margin))
                if t in self.index['tiles']:
                    out.add(t)
        return sorted(out)

    def buildings(self, tid):
        """{gdk id: record} of a tile's `buildings` layer."""
        if tid not in self._buildings:
            p = self.data / 'tiles' / tid / 'buildings.json'
            self._buildings[tid] = {b['id']: b for b in json.loads(p.read_text())['buildings']} if p.exists() else {}
        return self._buildings[tid]

    # terrain: the stream terrain's sampler (js/terrain-cph.js createChunkSampler): cell centres, bilinear, 0 where no chunk
    def _chunk(self, tid):
        if tid not in self._terrain:
            p = self.data / 'tiles' / tid / 'terrain.json'
            c = json.loads(p.read_text())['chunk'] if p.exists() else None
            if c:
                g = np.frombuffer(base64.b64decode(c['data']), '<i2').astype(np.float32).reshape(c['h'], c['w']) / 100.0
                self._terrain[tid] = (c['x0'], c['z0'], c['cell'], g)
            else:
                self._terrain[tid] = None
        return self._terrain[tid]

    def _cell(self, i, j):
        h = self.terrain_header
        X0, Z0, cell = h['bbox'][0], h['bbox'][1], h['cell']
        x, z = X0 + (i + 0.5) * cell, Z0 + (j + 0.5) * cell
        c = self._chunk(self.tile_of_local(x, z))
        if not c:
            return 0.0
        x0, z0, cc, g = c
        ci, cj = int(math.floor((x - x0) / cc)), int(math.floor((z - z0) / cc))
        return float(g[cj, ci]) if 0 <= ci < g.shape[1] and 0 <= cj < g.shape[0] else 0.0

    def height_at(self, x, z):
        h = self.terrain_header
        w, hh, cell = h['width'], h['height'], h['cell']
        fx = min(max((x - h['bbox'][0]) / cell - 0.5, 0), w - 1.000001)
        fz = min(max((z - h['bbox'][1]) / cell - 0.5, 0), hh - 1.000001)
        i, j = int(math.floor(fx)), int(math.floor(fz))
        tx, tz = fx - i, fz - j
        return ((self._cell(i, j) * (1 - tx) + self._cell(i + 1, j) * tx) * (1 - tz)
                + (self._cell(i, j + 1) * (1 - tx) + self._cell(i + 1, j + 1) * tx) * tz)

    def ground_low(self, rec):
        """js/building-geometry.js groundLow: the lowest terrain along the outline (and holes), never above the record's ground."""
        low = rec['ground']
        for r in [rec['ring']] + list(rec.get('holes') or []):
            for i in range(0, len(r) - 1, 2):
                low = min(low, self.height_at(r[i], r[i + 1]))
        return low


def flat_to_pts(flat):
    return [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]


# ------------------------------------------------------------------------------------------------------------- footprint match
def match_footprints(sources, frame: TwinFrame, *, iou_ok=0.85, hausdorff_ok=1.0, min_share=0.2):
    """Maps source footprints to the GeoDanmark buildings of the tiles by overlap.

    sources: [{ id, gdk_hint (a gdk id the source names, or None), ring: [(x, z)...] local, holes: [[(x, z)...]] }]
    -> (matches, report): matches = { source id: { gdk, covers: [gdk ids], iou, hausdorff, kind, footprint: 'gdk'|'override' } }

    kind: '1:1' (one gdk building, one source), 'merge' (several sources onto one gdk building: their meshes are joined, keyed by it),
    'split' (one source over several gdk buildings: keyed by the one it overlaps most, hiding all it covers), 'unmatched' (no gdk
    building takes min_share of the source: not published, the generated city is kept there).
    A match whose IoU >= iou_ok and Hausdorff <= hausdorff_ok keeps the gdk footprint for colliders and walk space; otherwise the
    override's own footprint is used there.
    """
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    from shapely.ops import unary_union

    xs = [p[0] for s in sources for p in s['ring']]
    zs = [p[1] for s in sources for p in s['ring']]
    tiles = frame.tiles_around(min(xs), min(zs), max(xs), max(zs), margin=60)
    gdk, owner = {}, {}
    for t in tiles:
        for gid, rec in frame.buildings(t).items():
            poly = Polygon(flat_to_pts(rec['ring']), [flat_to_pts(h) for h in rec.get('holes') or []]).buffer(0)
            if poly.area > 0:
                gdk[gid], owner[gid] = poly, t
    ids = list(gdk)
    tree = STRtree([gdk[i] for i in ids])
    src_poly = {s['id']: Polygon(s['ring'], s.get('holes') or []).buffer(0) for s in sources}

    # each source's best gdk building (by share of the source area), and every gdk building it covers by more than min_share of either
    best, covers = {}, {}
    for s in sources:
        p = src_poly[s['id']]
        hits = []
        for k in tree.query(p):
            g = ids[k]
            a = p.intersection(gdk[g]).area
            if a > 0.25:
                hits.append((g, a))
        if s.get('gdk_hint') in gdk and all(h[0] != s['gdk_hint'] for h in hits):
            hits.append((s['gdk_hint'], p.intersection(gdk[s['gdk_hint']]).area))
        hits.sort(key=lambda h: -h[1])
        good = [(g, a) for g, a in hits if a >= min_share * p.area or a >= min_share * gdk[g].area]
        if not good:
            best[s['id']] = None
            continue
        # the hinted id wins a near tie (the source names its GeoDanmark object)
        top = good[0]
        if s.get('gdk_hint') and any(g == s['gdk_hint'] for g, _ in good):
            hint = next(h for h in good if h[0] == s['gdk_hint'])
            if hint[1] >= 0.8 * top[1]:
                top = hint
        best[s['id']] = top[0]
        covers[s['id']] = [g for g, a in good if a >= 0.5 * gdk[g].area or g == top[0]]

    by_gdk = {}
    for sid, g in best.items():
        if g:
            by_gdk.setdefault(g, []).append(sid)
    matches, report = {}, {'sources': len(sources), 'kinds': {}, 'cases': [], 'iou': {}, 'hausdorff_m': {}}
    for g, sids in by_gdk.items():
        union = unary_union([src_poly[s] for s in sids])
        cov = sorted(set(c for s in sids for c in covers[s]))
        target = unary_union([gdk[c] for c in cov])
        iou = union.intersection(target).area / union.union(target).area
        haus = union.hausdorff_distance(target)
        kind = 'merge' if len(sids) > 1 else 'split' if len(cov) > 1 else '1:1'
        keep = iou >= iou_ok and haus <= hausdorff_ok
        for s in sids:
            matches[s] = {'gdk': g, 'tile': owner[g], 'covers': cov, 'iou': round(iou, 4), 'hausdorff': round(haus, 3), 'kind': kind,
                          'footprint': 'gdk' if keep else 'override', 'sources': sids}
        if kind != '1:1' or not keep:
            report['cases'].append({'gdk': g, 'sources': sids, 'covers': cov, 'kind': kind, 'iou': round(iou, 4), 'hausdorff': round(haus, 3),
                                    'footprint': 'gdk' if keep else 'override'})
    for sid, g in best.items():
        if not g:
            matches[sid] = {'gdk': None, 'kind': 'unmatched'}
            report['cases'].append({'sources': [sid], 'kind': 'unmatched'})
    for m in matches.values():
        report['kinds'][m['kind']] = report['kinds'].get(m['kind'], 0) + 1
    vals = sorted(m['iou'] for m in {m['gdk']: m for m in matches.values() if m.get('gdk')}.values())
    hs = sorted(m['hausdorff'] for m in {m['gdk']: m for m in matches.values() if m.get('gdk')}.values())
    if vals:
        q = lambda a, f: a[min(len(a) - 1, int(f * (len(a) - 1) + 0.5))]
        report['iou'] = {'min': vals[0], 'p05': q(vals, .05), 'median': q(vals, .5), 'max': vals[-1], 'below_ok': sum(v < iou_ok for v in vals)}
        report['hausdorff_m'] = {'median': q(hs, .5), 'p95': q(hs, .95), 'max': hs[-1], 'above_ok': sum(v > hausdorff_ok for v in hs)}
    report['tolerance'] = {'iou': iou_ok, 'hausdorff_m': hausdorff_ok, 'min_share': min_share}
    return matches, report, gdk


# ------------------------------------------------------------------------------------------------------------------ GLB reading
_COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Glb:
    def __init__(self, path):
        b = Path(path).read_bytes()
        assert b[:4] == b'glTF', 'not a GLB'
        n = struct.unpack('<I', b[12:16])[0]
        self.json = json.loads(b[20:20 + n])
        off = 20 + n
        self.bin = b''
        if off < len(b):
            ln = struct.unpack('<I', b[off:off + 4])[0]
            self.bin = b[off + 8:off + 8 + ln]

    def accessor(self, i):
        a = self.json['accessors'][i]
        bv = self.json['bufferViews'][a['bufferView']]
        dt, nc = _COMP[a['componentType']], _NC[a['type']]
        o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride')
        item = np.dtype(dt).itemsize * nc
        if stride and stride != item:
            raw = np.frombuffer(self.bin, np.uint8, a['count'] * stride, o).reshape(a['count'], stride)[:, :item]
            arr = raw.copy().view(dt).reshape(a['count'], nc)
        else:
            arr = np.frombuffer(self.bin, dt, a['count'] * nc, o).reshape(a['count'], nc)
        arr = arr.astype(np.float64)
        if a.get('normalized'):
            arr = arr / float(np.iinfo(dt).max)
        return arr

    def image(self, i):
        im = self.json['images'][i]
        bv = self.json['bufferViews'][im['bufferView']]
        o = bv.get('byteOffset', 0)
        return Image.open(io.BytesIO(self.bin[o:o + bv['byteLength']]))

    def triangles(self, prim):
        """Expanded (non-indexed) triangle arrays of a primitive: positions (n*3, 3), normals or None, uvs or None."""
        assert prim.get('mode', 4) == 4, 'only triangle lists'
        at = prim['attributes']
        pos = self.accessor(at['POSITION'])
        nor = self.accessor(at['NORMAL']) if 'NORMAL' in at else None
        uv = self.accessor(at['TEXCOORD_0']) if 'TEXCOORD_0' in at else None
        if 'indices' in prim:
            idx = self.accessor(prim['indices']).astype(np.int64).ravel()
            pos = pos[idx]
            nor = nor[idx] if nor is not None else None
            uv = uv[idx] if uv is not None else None
        return pos, nor, uv


# ------------------------------------------------------------------------------------------------------------------- colours
def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


# The twin's albedo of a photographed colour (js/appearance.js albedoFromLinear, js/facade-photo-material.js gain): a photo pixel was lit by
# the sun and sky once already, so the linear value is scaled by 0.72 with a soft shoulder from 0.4 to at most 0.58. Applied to every
# photo-derived texture and colour of an override, so it is lit like the generated buildings around it.
ALBEDO_GAIN, ALBEDO_KNEE, ALBEDO_MAX = 0.72, 0.4, 0.58


def albedo_from_linear(v):
    x = np.asarray(v, dtype=np.float64) * ALBEDO_GAIN
    return np.where(x <= ALBEDO_KNEE, x, ALBEDO_KNEE + (ALBEDO_MAX - ALBEDO_KNEE) * (1 - np.exp(-(x - ALBEDO_KNEE) / (ALBEDO_MAX - ALBEDO_KNEE))))


def albedo_image(img):
    """The albedo mapping on an sRGB 8-bit image (RGB), through a 256-entry LUT."""
    lut = np.round(linear_to_srgb(albedo_from_linear(srgb_to_linear(np.arange(256) / 255.0))) * 255).astype(np.uint8)
    return img.convert('RGB').point(list(lut) * 3)


def texture_bytes(w, h):
    """js/facade-lod.js estimateTextureBytes: RGBA8 over the full mip chain."""
    px = 0
    while True:
        px += w * h
        if w == 1 and h == 1:
            break
        w, h = max(1, w // 2), max(1, h // 2)
    return px * 4


# ---------------------------------------------------------------------------------------------------------------- atlas packer
def shelf_pack(sizes, max_w=1024, pad=2):
    """sizes: [(w, h)] -> (W, H, [(x, y)]) with `pad` px around each region (the caller extends edges into it)."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    W = min(max_w, max([w + 2 * pad for w, _ in sizes] + [16]))
    W = max(W, max(w + 2 * pad for w, _ in sizes))
    place = [None] * len(sizes)
    x = y = shelf = 0
    for i in order:
        w, h = sizes[i][0] + 2 * pad, sizes[i][1] + 2 * pad
        if x + w > W:
            x, y, shelf = 0, y + shelf, 0
        place[i] = (x + pad, y + pad)
        x += w
        shelf = max(shelf, h)
    H = y + shelf
    return W, max(H, 4), place


def paste_padded(atlas, img, x, y, pad):
    """Pastes `img` at (x, y) and extends its border pixels `pad` px outward (no bleed of neighbours under mipmapping)."""
    w, h = img.size
    atlas.paste(img, (x, y))
    if pad <= 0:
        return
    atlas.paste(img.crop((0, 0, w, 1)).resize((w, pad)), (x, y - pad))
    atlas.paste(img.crop((0, h - 1, w, h)).resize((w, pad)), (x, y + h))
    col_l = atlas.crop((x, y - pad, x + 1, y + h + pad)).resize((pad, h + 2 * pad))
    col_r = atlas.crop((x + w - 1, y - pad, x + w, y + h + pad)).resize((pad, h + 2 * pad))
    atlas.paste(col_l, (x - pad, y - pad))
    atlas.paste(col_r, (x + w, y - pad))


# ------------------------------------------------------------------------------------------------------------------ GLB writing
class GlbWriter:
    """A small glTF 2.0 binary writer: indexed meshes with quantised attributes (KHR_mesh_quantization) and webp textures (EXT_texture_webp).

    POSITION  uint16 normalized per axis over the mesh bounds (padded to 8 bytes), dequantised by the node transform
              (translation = min, scale = extent)
    NORMAL    int8 normalized (padded to 4 bytes: WebGPU vertex formats are 4-byte multiples)
    TEXCOORD  uint16 normalized for UVs in [0, 1] (atlas), float for tiling UVs
    COLOR_0   uint16 normalized RGBA (linear)
    """

    def __init__(self, generator='cph-twin tools/overrides'):
        self.g = {'asset': {'version': '2.0', 'generator': generator}, 'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
                  'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [], 'images': [], 'textures': [], 'samplers': []}
        self.bin = bytearray()
        self.used = {'KHR_mesh_quantization'}

    def _view(self, data: bytes, target=None, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        if stride:
            v['byteStride'] = stride
        self.bin += data
        self.g['bufferViews'].append(v)
        return len(self.g['bufferViews']) - 1

    def _acc(self, view, comp, count, typ, normalized=False, mn=None, mx=None):
        a = {'bufferView': view, 'componentType': comp, 'count': int(count), 'type': typ}
        if normalized:
            a['normalized'] = True
        if mn is not None:
            a['min'], a['max'] = [float(v) for v in mn], [float(v) for v in mx]
        self.g['accessors'].append(a)
        return len(self.g['accessors']) - 1

    def sampler(self, repeat):
        key = 10497 if repeat else 33071
        for i, s in enumerate(self.g['samplers']):
            if s['wrapS'] == key:
                return i
        self.g['samplers'].append({'magFilter': 9729, 'minFilter': 9987, 'wrapS': key, 'wrapT': key})
        return len(self.g['samplers']) - 1

    def texture(self, img: Image.Image, name, repeat=False, quality=86, lossless=False):
        buf = io.BytesIO()
        img.convert('RGB').save(buf, 'WEBP', quality=quality, method=6, lossless=lossless)
        view = self._view(buf.getvalue())
        self.g['images'].append({'bufferView': view, 'mimeType': 'image/webp', 'name': name})
        self.g['textures'].append({'sampler': self.sampler(repeat), 'extensions': {'EXT_texture_webp': {'source': len(self.g['images']) - 1}}})
        self.used.add('EXT_texture_webp')
        return len(self.g['textures']) - 1, img.size, len(buf.getvalue())

    def material(self, name, *, texture=None, color=(1, 1, 1, 1), roughness=0.85, metallic=0.0, extras=None, double=True):
        pbr = {'baseColorFactor': [float(c) for c in color], 'metallicFactor': metallic, 'roughnessFactor': roughness}
        if texture is not None:
            pbr['baseColorTexture'] = {'index': texture}
        m = {'name': name, 'pbrMetallicRoughness': pbr, 'doubleSided': double}
        if extras:
            m['extras'] = extras
        self.g['materials'].append(m)
        return len(self.g['materials']) - 1

    def mesh(self, name, pos, nor, *, uv=None, uv_tiling=False, color=None, material=0, extras=None):
        """Adds a node + mesh from expanded triangles (pos (n, 3) float, n % 3 == 0); vertices are welded, attributes quantised."""
        pos = np.asarray(pos, np.float64)
        n = len(pos)
        nor = np.asarray(nor, np.float64)
        ln = np.linalg.norm(nor, axis=1, keepdims=True)
        nor = np.where(ln > 1e-9, nor / np.maximum(ln, 1e-12), np.array([[0, 1, 0]]))
        mn, mx = pos.min(0), pos.max(0)
        ext = np.maximum(mx - mn, 1e-6)
        qp = np.round((pos - mn) / ext * 65535).astype(np.uint16)
        qn = np.round(nor * 127).astype(np.int8)
        cols = [qp, qn.astype(np.int16)]
        if uv is not None:
            if uv_tiling:
                quv = np.asarray(uv, np.float32)
                cols.append(np.round(quv * 4096).astype(np.int64))  # weld key only
            else:
                quv = np.round(np.clip(uv, 0, 1) * 65535).astype(np.uint16)
                cols.append(quv)
        if color is not None:
            qc = np.round(np.clip(color, 0, 1) * 65535).astype(np.uint16)
            cols.append(qc)
        key = np.concatenate([c.astype(np.int64).reshape(n, -1) for c in cols], axis=1)
        uniq, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inverse = inverse.ravel()
        m = len(first)
        attrs = {}
        p = np.zeros((m, 4), np.uint16)  # padded to 8 bytes: WebGPU has unorm16x4, not x3
        p[:, :3] = qp[first]
        pn = p[:, :3] / 65535.0
        attrs['POSITION'] = self._acc(self._view(p.tobytes(), 34962, 8), 5123, m, 'VEC3', normalized=True, mn=pn.min(0), mx=pn.max(0))
        nn = np.zeros((m, 4), np.int8)
        nn[:, :3] = qn[first]
        attrs['NORMAL'] = self._acc(self._view(nn.tobytes(), 34962, 4), 5120, m, 'VEC3', normalized=True)
        if uv is not None:
            if uv_tiling:
                attrs['TEXCOORD_0'] = self._acc(self._view(np.asarray(uv, np.float32)[first].tobytes(), 34962), 5126, m, 'VEC2')
            else:
                attrs['TEXCOORD_0'] = self._acc(self._view(quv[first].tobytes(), 34962), 5123, m, 'VEC2', normalized=True)
        if color is not None:
            attrs['COLOR_0'] = self._acc(self._view(qc[first].tobytes(), 34962), 5123, m, 'VEC4', normalized=True)
        idx = inverse.astype(np.uint16 if m < 65536 else np.uint32)
        ia = self._acc(self._view(idx.tobytes(), 34963), 5123 if m < 65536 else 5125, n, 'SCALAR')
        self.g['meshes'].append({'name': name, 'primitives': [{'attributes': attrs, 'indices': ia, 'material': material, 'mode': 4}]})
        node = {'name': name, 'mesh': len(self.g['meshes']) - 1, 'translation': [float(v) for v in mn], 'scale': [float(v) for v in ext]}
        if extras:
            node['extras'] = extras
        self.g['nodes'].append(node)
        return len(self.g['nodes']) - 1, {'vertices': m, 'triangles': n // 3, 'gpuBytes': m * (8 + 4 + (4 if uv is not None and not uv_tiling else 8 if uv is not None else 0) + (8 if color is not None else 0)) + n * (2 if m < 65536 else 4)}

    def root(self, name, children, extras=None):
        node = {'name': name, 'children': children}
        if extras:
            node['extras'] = extras
        self.g['nodes'].append(node)
        self.g['scenes'][0]['nodes'].append(len(self.g['nodes']) - 1)

    def bytes(self, asset_extras=None):
        if asset_extras:
            self.g['asset']['extras'] = asset_extras
        for k in ('images', 'textures', 'samplers'):
            if not self.g[k]:
                del self.g[k]
        self.g['extensionsUsed'] = sorted(self.used)
        self.g['extensionsRequired'] = sorted(self.used)
        while len(self.bin) % 4:
            self.bin.append(0)
        self.g['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.g, separators=(',', ':'), ensure_ascii=False).encode()
        while len(js) % 4:
            js += b' '
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        return (b'glTF' + struct.pack('<II', 2, total) + struct.pack('<I', len(js)) + b'JSON' + js
                + struct.pack('<I', len(self.bin)) + b'BIN\x00' + bytes(self.bin))


def write_json(path, doc):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    os.replace(tmp, path)
