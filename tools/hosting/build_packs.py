#!/usr/bin/env python3
"""Build the packed data layout of the Copenhagen twin (js/data-packs.js) into a directory any uploader can sync.

    python3 tools/hosting/build_packs.py [--out .context/packs/<stamp>] [--groups split|single] [--core-block 2] [--detail-block 2]
                                         [--chunk 1048576] [--no-atlases] [--offline]

A visit used to cost 1.5-3k requests (about 12 files per tile, one webp per facade atlas); static hosts with per-IP or per-bucket request
limits (r2.dev, a Hugging Face dataset: 3,000 resolve requests per 5 min per IP) cannot serve that. This packs the same bytes into a few
hundred content-hashed files (measured on boot + Rådhuspladsen + Nyhavn + Frederiksberg Allé + an aerial: 5.4k requests -> 171):

    manifest.json        the root (serve it no-cache): which pack holds which file, the packs of every tile
    c/<hash>.pack        city packs: tiles/index.json + the city files the index and post.json name (one), city/streets.json (another)
    t/<hash>.pack        core layers (js/tile-rings.js RING_LAYERS.mid + lod2.bin) and `atlas.index` of a block of
                         --core-block x --core-block tiles (entries '<tile>/<layer>')
    d/<hash>.pack        detail layers (what only the near ring adds) of a block of --detail-block x --detail-block tiles;
                         --groups single puts every layer in t/
    a/<hash>.pack        a tile's facade atlases, ordered by a quadtree over the building centroids and cut into chunks of at most
                         --chunk bytes (one chunk = one HTTP Range request; a host without Range serves the whole file, at most ~6 MB)

Container: "CPHPACK1", u32 LE header length, JSON header { format: 'cph-pack/1', entries: [{ name, type, enc, offset, length, size }],
chunks? }, payloads. JSON and binary entries are gzip'd inside the pack (the host need not set Content-Encoding), webp is stored.
Names are the first 20 hex digits of the SHA-256 of the pack, so packs are immutable (Cache-Control: immutable) and an unchanged pack keeps
its name across builds: an upload only adds what changed, and the old manifest's packs stay valid until they are pruned.

Atlases come from gs://lun-integrations-dev-cph-twin/skraafoto/tex-look (only the ones a tile's appearance.json describes), cached in
~/.cache/cph-twin/tex-look (by GCS md5); atlases only the local data/tex-look has are taken from there (GCS wins on a clash, as in
upload_r2.py). GCS is read over REST with an ADC token (`gcloud auth application-default print-access-token`), never the gcloud CLI.
"""
import argparse, base64, concurrent.futures as cf, gzip, hashlib, json, os, re, subprocess, sys, threading, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GCS_BUCKET, GCS_PREFIX = 'lun-integrations-dev-cph-twin', 'skraafoto/tex-look/'
MAGIC = b'CPHPACK1'
PACK_FORMAT, MANIFEST_FORMAT = 'cph-pack/1', 'cph-packs/1'
HASH_LEN = 20


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------------------------------------------- container
def encode_pack(files, chunks=None):
    """files: [(name, type, bytes, gzip?)]; chunks: [(first entry index, count)] -> pack bytes."""
    payloads, entries = [], []
    for name, typ, data, z in files:
        body = gzip.compress(data, 9, mtime=0) if z else data
        enc = 'gzip' if z else 'identity'
        if z and len(body) >= len(data) and typ == 'bin':  # incompressible binary: store it
            body, enc = data, 'identity'
        payloads.append(body)
        entries.append({'name': name, 'type': typ, 'enc': enc, 'offset': 0, 'length': len(body), 'size': len(data)})
    head = b''
    for _ in range(6):  # the header length moves the offsets: iterate until stable
        o = 12 + len(head)
        for e in entries:
            e['offset'] = o
            o += e['length']
        header = {'format': PACK_FORMAT, 'entries': entries}
        if chunks:
            header['chunks'] = [[entries[a]['offset'], entries[a + n - 1]['offset'] + entries[a + n - 1]['length'] - entries[a]['offset']] for a, n in chunks]
        nxt = json.dumps(header, separators=(',', ':')).encode()
        if len(nxt) == len(head):
            head = nxt
            break
        head = nxt
    else:
        raise RuntimeError('pack header did not settle')
    return MAGIC + len(head).to_bytes(4, 'little') + head + b''.join(payloads), header


def read_pack(buf):
    assert buf[:8] == MAGIC, 'not a pack'
    n = int.from_bytes(buf[8:12], 'little')
    return json.loads(buf[12:12 + n])


class Writer:
    def __init__(self, out):
        self.out, self.files, self.bytes, self.lock = out, {}, 0, threading.Lock()

    def put(self, kind, data):
        name = f'{kind}/{hashlib.sha256(data).hexdigest()[:HASH_LEN]}.pack'
        p = os.path.join(self.out, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if not os.path.exists(p) or os.path.getsize(p) != len(data):
            with open(p + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(p + '.tmp', p)
        with self.lock:
            self.files[name] = len(data)
            self.bytes += len(data)
        return name


# ------------------------------------------------------------------------------------------------------------------ groups
def ring_layers():
    """RING_LAYERS.near / .mid of js/tile-rings.js (the layers each streamer ring fetches)."""
    src = open(os.path.join(ROOT, 'js/tile-rings.js')).read()
    block = re.search(r'export const RING_LAYERS = Object\.freeze\(\{(.*?)\}\);', src, re.S).group(1)
    out = {}
    for ring, items in re.findall(r"(\w+):\s*\[([^\]]*)\]", block):
        out[ring] = re.findall(r"'([^']+)'", items)
    return out


def tile_layers(index, post, tid):
    """Layer names a tile has (what js/tile-store.js hasLayer says), 'lod2.bin' included."""
    names = [n for n, b in index['tiles'][tid].get('layers', {}).items() if b]
    for sec in ('streets', 'water', 'appearance'):
        if (post or {}).get(sec, {}).get('tiles', {}).get(tid):
            names.append(sec)
    return sorted(set(names))


# ----------------------------------------------------------------------------------------------------------------- atlases
def adc_token():
    return subprocess.check_output(['gcloud', 'auth', 'application-default', 'print-access-token'], text=True).strip()


def gcs_list(token):
    items, page = [], ''
    while True:
        q = {'prefix': GCS_PREFIX, 'maxResults': 1000, 'fields': 'items(name,size,md5Hash),nextPageToken'}
        if page:
            q['pageToken'] = page
        req = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{GCS_BUCKET}/o?' + urllib.parse.urlencode(q), headers={'Authorization': 'Bearer ' + token})
        d = json.load(urllib.request.urlopen(req, timeout=120))
        items += d.get('items', [])
        page = d.get('nextPageToken')
        if not page:
            return items


class AtlasSource:
    """Atlas bytes by file name (<stem>.webp): GCS through a local md5-checked cache, else data/tex-look."""

    def __init__(self, cache, wanted, workers=48, offline=False):
        self.cache, self.local = cache, os.path.join(ROOT, 'data/tex-look')
        os.makedirs(cache, exist_ok=True)
        self.gcs = {}
        if offline:
            log('atlases: --offline, using the cache and data/tex-look only')
        else:
            self.token, self.t_token, self.lock = adc_token(), time.time(), threading.Lock()
            log(f'listing gs://{GCS_BUCKET}/{GCS_PREFIX} ...')
            for o in gcs_list(self.token):
                fn = o['name'][len(GCS_PREFIX):]
                if fn in wanted:
                    self.gcs[fn] = (int(o['size']), base64.b64decode(o['md5Hash']).hex() if o.get('md5Hash') else None)
            todo = [fn for fn in self.gcs if not self._cached(fn)]
            log(f'atlases: {len(wanted)} described, {len(self.gcs)} in GCS ({sum(s for s, _ in self.gcs.values()) / 1e6:.0f} MB), {len(todo)} to download')
            done = [0]
            t0 = time.time()

            def get(fn):
                self._download(fn)
                with self.lock:
                    done[0] += 1
                    if done[0] % 5000 == 0:
                        log(f'  downloaded {done[0]}/{len(todo)} ({done[0] / (time.time() - t0):.0f}/s)')
            with cf.ThreadPoolExecutor(workers) as ex:
                list(ex.map(get, todo))

    def _token(self):
        with self.lock:
            if time.time() - self.t_token > 1800:
                self.token, self.t_token = adc_token(), time.time()
            return self.token

    def _cached(self, fn):
        p = os.path.join(self.cache, fn)
        size, md5 = self.gcs[fn]
        if not os.path.exists(p) or os.path.getsize(p) != size:
            return False
        meta = p + '.md5'
        return md5 is None or (os.path.exists(meta) and open(meta).read() == md5)

    def _download(self, fn):
        url = f'https://storage.googleapis.com/storage/v1/b/{GCS_BUCKET}/o/{urllib.parse.quote(GCS_PREFIX + fn, safe="")}?alt=media'
        for attempt in range(6):
            try:
                req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self._token()})
                body = urllib.request.urlopen(req, timeout=120).read()
                size, md5 = self.gcs[fn]
                if len(body) != size or (md5 and hashlib.md5(body).hexdigest() != md5):
                    raise IOError('size/md5 mismatch')
                p = os.path.join(self.cache, fn)
                with open(p + '.tmp', 'wb') as f:
                    f.write(body)
                os.replace(p + '.tmp', p)
                if md5:
                    open(p + '.md5', 'w').write(md5)
                return
            except Exception as e:  # network hiccup
                err = e
                time.sleep(min(30, 2 ** attempt))
        raise SystemExit(f'giving up on {fn}: {err}')

    def get(self, fn):
        if fn in self.gcs or (not self.gcs and os.path.exists(os.path.join(self.cache, fn))):
            return open(os.path.join(self.cache, fn), 'rb').read()
        p = os.path.join(self.local, fn)
        return open(p, 'rb').read() if os.path.exists(p) else None


def quadtree_chunks(items, bounds, cap):
    """items: [(cx, cz, nbytes, payload)] -> list of chunks (lists of items), each a quadtree cell of at most `cap` bytes (or one item)."""
    if sum(i[2] for i in items) <= cap or len(items) <= 1:
        return [items] if items else []
    x0, z0, x1, z1 = bounds
    if x1 - x0 < 1:  # degenerate (many atlases at one point): cut by order
        out, cur, n = [], [], 0
        for it in items:
            if cur and n + it[2] > cap:
                out.append(cur)
                cur, n = [], 0
            cur.append(it)
            n += it[2]
        return out + ([cur] if cur else [])
    mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
    quads = [[], [], [], []]
    for it in items:
        quads[(it[0] >= mx) + 2 * (it[1] >= mz)].append(it)
    sub = [(x0, z0, mx, mz), (mx, z0, x1, mz), (x0, mz, mx, z1), (mx, mz, x1, z1)]
    out = []
    for q, b in zip((0, 1, 3, 2), (sub[0], sub[1], sub[3], sub[2])):  # Hilbert-ish order keeps neighbouring chunks adjacent in the file
        out += quadtree_chunks(quads[q], b, cap)
    # merge small neighbouring cells back up to the cap (fewer, still compact, chunks)
    merged = []
    for c in out:
        if merged and sum(i[2] for i in merged[-1]) + sum(i[2] for i in c) <= cap:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged


def centroid(b):
    r = b.get('ring') or []
    xs, zs = r[0::2], r[1::2]
    return (sum(xs) / len(xs), sum(zs) / len(zs)) if xs else (0.0, 0.0)


def build_atlas_pack(writer, tid, tile_dir, local_bounds, atlases, cap):
    """-> (atlas.index dict, pack name, atlases missing) or (None, None, 0) for a tile without atlases."""
    app_p = os.path.join(tile_dir, 'appearance.json')
    if not os.path.exists(app_p):
        return None, None, 0
    app = json.load(open(app_p))['buildings']
    blds = {b['id']: b for b in json.load(open(os.path.join(tile_dir, 'buildings.json')))['buildings']} if os.path.exists(os.path.join(tile_dir, 'buildings.json')) else {}
    items, missing = [], 0
    for bid in sorted(app):
        if not app[bid].get('atlas'):
            continue
        stem = bid.replace(':', '_')
        data = atlases.get(stem + '.webp')
        if data is None:
            missing += 1
            continue
        cx, cz = centroid(blds[bid]) if bid in blds else ((local_bounds[0] + local_bounds[2]) / 2, (local_bounds[1] + local_bounds[3]) / 2)
        items.append((cx, cz, len(data), (stem, data)))
    if not items:
        return None, None, 0
    chunks = quadtree_chunks(items, local_bounds, cap)
    files, spans = [], []
    for c in chunks:
        spans.append((len(files), len(c)))
        files += [(f'tex-look/{stem}.webp', 'webp', data, False) for _, _, _, (stem, data) in c]
    body, header = encode_pack(files, spans)
    name = writer.put('a', body)
    entries = header['entries']
    idx = {'file': name, 'size': len(body), 'chunks': header['chunks'], 'atlases': {}}
    for ci, (a, n) in enumerate(spans):
        for e in entries[a:a + n]:
            idx['atlases'][e['name'][len('tex-look/'):-len('.webp')]] = [ci, e['offset'], e['length']]
    return idx, name, missing


# -------------------------------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=os.path.join(ROOT, 'data'))
    ap.add_argument('--out', default=None, help='output dir (default .context/packs/<UTC stamp>)')
    ap.add_argument('--groups', choices=('split', 'single'), default='split', help='split: core (mid ring) + detail (near only) per tile')
    ap.add_argument('--chunk', type=int, default=1 << 20, help='atlas chunk cap in bytes (one Range request each)')
    ap.add_argument('--no-atlases', action='store_true')
    ap.add_argument('--core-block', type=int, default=2, help='tiles per side packed together in one core pack')
    ap.add_argument('--detail-block', type=int, default=2, help='tiles per side packed together in one detail pack')
    ap.add_argument('--offline', action='store_true', help='atlases from the cache and data/tex-look only (no GCS listing)')
    ap.add_argument('--atlas-cache', default=os.path.expanduser('~/.cache/cph-twin/tex-look'))
    ap.add_argument('--tiles', default='', help='comma separated tile ids (default: every tile of the index)')
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 8)
    ap.add_argument('--fallback', default=None, help='base-relative unpacked tile directory the client may fall back to (e.g. tiles)')
    a = ap.parse_args()
    t0 = time.time()
    out = a.out or os.path.join(ROOT, '.context/packs', time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    os.makedirs(out, exist_ok=True)
    tiles_dir, city_dir = os.path.join(a.data, 'tiles'), os.path.join(a.data, 'city')
    index = json.load(open(os.path.join(tiles_dir, 'index.json')))
    post_p = os.path.join(city_dir, 'post.json')
    post = json.load(open(post_p)) if os.path.exists(post_p) else None
    tids = sorted(a.tiles.split(',')) if a.tiles else sorted(index['tiles'])
    rings = ring_layers()
    core = list(dict.fromkeys(rings['mid'] + ['lod2.bin']))
    detail = [l for l in rings['near'] if l not in core]
    groups = [{'name': 'core', 'layers': core, 'block': a.core_block}] + ([{'name': 'detail', 'layers': detail, 'block': a.detail_block}] if a.groups == 'split' else [])
    if a.groups == 'single':
        groups[0]['layers'] = list(dict.fromkeys(core + detail))
    known = {l for g in groups for l in g['layers']}
    w = Writer(out)

    # city packs: everything the boot reads in one, the whole-city street layout (only loadArea reads it) in another
    city_names = ['post.json'] + [os.path.basename(v) for k, v in sorted(index.get('city', {}).items()) if isinstance(v, str) and k != 'streets']
    if post:
        for sec, keys in (('far', ('header', 'bin')), ('streets', ('graph',)), ('water', ('header',))):
            for k in keys:
                if isinstance(post.get(sec, {}).get(k), str):
                    city_names.append(post[sec][k])
    city_files = [('tiles/index.json', 'json', open(os.path.join(tiles_dir, 'index.json'), 'rb').read(), True)]
    for n in dict.fromkeys(city_names):
        p = os.path.join(city_dir, n)
        if os.path.exists(p):
            city_files.append((f'city/{n}', 'json' if n.endswith('.json') else 'bin', open(p, 'rb').read(), True))
        else:
            log(f'warning: data/city/{n} is named by the index but missing locally')
    files_map = {}
    body, _ = encode_pack(city_files)
    cname = w.put('c', body)
    for f in city_files:
        files_map[f[0]] = cname
    log(f'city pack {cname}: {len(city_files)} files, {len(body) / 1e6:.1f} MB')
    streets = index.get('city', {}).get('streets')
    if streets and os.path.exists(os.path.join(city_dir, os.path.basename(streets))):
        body, _ = encode_pack([(f'city/{os.path.basename(streets)}', 'json', open(os.path.join(city_dir, os.path.basename(streets)), 'rb').read(), True)])
        files_map[f'city/{os.path.basename(streets)}'] = w.put('c', body)

    # atlases
    atlases = None
    if not a.no_atlases:
        wanted = set()
        for tid in tids:
            p = os.path.join(tiles_dir, tid, 'appearance.json')
            if os.path.exists(p):
                wanted |= {bid.replace(':', '_') + '.webp' for bid, b in json.load(open(p))['buildings'].items() if b.get('atlas')}
        atlases = AtlasSource(a.atlas_cache, wanted, offline=a.offline)

    tiles_out = {tid: [None] * (len(groups) + 1) for tid in tids}
    unknown, missing_total, atlas_idx = set(), [0], {}
    lock = threading.Lock()

    # 1. atlas packs, one per tile (their index goes into the tile's core entries)
    def atlas(tid):
        r = build_atlas_pack(w, tid, os.path.join(tiles_dir, tid), index['tiles'][tid]['local'], atlases, a.chunk)
        if r[0]:
            with lock:
                atlas_idx[tid] = r[0]
                tiles_out[tid][len(groups)] = r[1]
                missing_total[0] += r[2]
    if atlases:
        with cf.ThreadPoolExecutor(a.workers) as ex:
            list(ex.map(atlas, tids))
        log(f'  atlas packs: {len(atlas_idx)} tiles ({w.bytes / 1e6:.0f} MB so far)')

    # 2. layer packs per group, one per block of N x N tiles (--core-block / --detail-block): entries '<tile>/<layer>'
    def tile_entries(tid, g, gi):
        tdir = os.path.join(tiles_dir, tid)
        names = tile_layers(index, post, tid)
        with lock:
            unknown.update(n for n in names if n not in known)
        fs = []
        for n in g['layers']:
            if n not in names:
                continue
            fn = n if n.endswith('.bin') else f'{n}.json'
            p = os.path.join(tdir, fn)
            if not os.path.exists(p):
                raise SystemExit(f'{tid}: layer {n} is in the index but {p} is missing')
            fs.append((f'{tid}/{n}', 'bin' if n.endswith('.bin') else 'json', open(p, 'rb').read(), True))
        if gi == 0 and tid in atlas_idx:
            fs.append((f'{tid}/atlas.index', 'json', json.dumps(atlas_idx[tid], separators=(',', ':')).encode(), True))
        return fs

    def block_of(tid, n):
        ie, inn = (int(v) for v in tid.split('_'))
        return (ie // n, inn // n)

    for gi, g in enumerate(groups):
        n = g['block']
        blocks = {}
        for tid in tids:
            blocks.setdefault(block_of(tid, n), []).append(tid)

        def one(members):
            fs, has = [], []
            for tid in members:
                e = tile_entries(tid, g, gi)
                if e:
                    fs += e
                    has.append(tid)
            if not fs:
                return
            name = w.put('t' if gi == 0 else 'd', encode_pack(fs)[0])
            with lock:
                for tid in has:
                    tiles_out[tid][gi] = name
        with cf.ThreadPoolExecutor(a.workers) as ex:
            list(ex.map(one, blocks.values()))
        log(f'  {g["name"]} packs: {len(blocks)} blocks of {n} x {n} tiles ({w.bytes / 1e6:.0f} MB so far)')
    for row in tiles_out.values():
        while row and row[-1] is None:
            row.pop()
    if unknown:
        raise SystemExit(f'layers in no group (add them to js/tile-rings.js RING_LAYERS): {sorted(unknown)}')

    manifest = {
        'format': MANIFEST_FORMAT,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': {'tiles': index.get('generated'), 'post': (post or {}).get('generated'), 'version': index.get('version')},
        'groups': groups,
        'atlasIndex': 'atlas.index',
        'files': files_map,
        'tiles': tiles_out,
    }
    if a.fallback:
        manifest['fallback'] = a.fallback
    mbytes = json.dumps(manifest, separators=(',', ':')).encode()
    open(os.path.join(out, 'manifest.json'), 'wb').write(mbytes)

    # report: file counts per folder, bytes per kind
    per = {}
    for name, n in w.files.items():
        k = name.split('/')[0]
        c, b, mx = per.get(k, (0, 0, 0))
        per[k] = (c + 1, b + n, max(mx, n))
    report = {'out': out, 'files': len(w.files) + 1, 'bytes': sum(w.files.values()) + len(mbytes), 'manifestBytes': len(mbytes),
              'folders': {k: {'files': c, 'bytes': b, 'largest': mx} for k, (c, b, mx) in sorted(per.items())},
              'tiles': len(tiles_out), 'atlasesMissing': missing_total[0], 'chunkCap': a.chunk, 'groups': groups, 'seconds': round(time.time() - t0)}
    json.dump(report, open(os.path.join(out, 'build-report.json'), 'w'), indent=1)
    log(json.dumps({k: v for k, v in report.items() if k != 'groups'}, indent=1))
    # stale files of an earlier build into the same dir are left alone (an uploader syncs what the manifest names)


if __name__ == '__main__':
    main()
