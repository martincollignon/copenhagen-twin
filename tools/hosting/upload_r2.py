#!/usr/bin/env python3
"""Publish the citywide data of the Copenhagen twin to Cloudflare R2 (bucket cph-twin-data) under a version prefix.

    python3 tools/hosting/upload_r2.py [--version v1] [--only tiles,city,tex-look] [--dry-run] [--workers 24]

Layout in the bucket (the engine's data base is  <public url>/<version>,  js/data-config.js):
    <version>/tiles/index.json, <version>/tiles/<id>/<layer>.json|bin     from data/tiles
    <version>/city/*                                                    the files data/tiles/index.json and data/city/post.json name
    <version>/tex-look/*.webp                                           copied from gs://lun-integrations-dev-cph-twin/skraafoto/tex-look

Idempotent: the bucket is listed first and an object whose size and MD5 already match is skipped, so the tool can be rerun after
the tiles or the atlases were regenerated. Order is chosen so a half finished run never publishes an inconsistent set: every
layer and atlas first, then the city files, the roots (tiles/index.json, city/post.json) last.

Cache headers: files under a version prefix are `public, max-age=31536000, immutable`; the roots (tiles/index.json, city/post.json,
city/meta.json) are `no-cache` so a new run is seen at once. Immutable means exactly that: to publish regenerated data to
visitors who may have cached the old files, upload under a NEW version (--version v2) and point BUILD_DATA_BASE at it.
JSON is stored gzip-compressed with Content-Encoding: gzip (R2's public endpoint serves it compressed to clients that accept it,
decompressed to those that do not).

Transport: the Cloudflare REST object API is limited to ~4 requests/s, so objects go through the ingest Worker
tools/hosting/ingest-worker (R2 binding, secret INGEST_KEY). Its URL and key live in ~/.config/cph-twin/r2-ingest.json
({"worker_url", "ingest_key", "public_url"}), never in the repo. GCS is read with an Application Default Credentials access token
(`gcloud auth application-default print-access-token`) which is handed to the Worker per batch; the gcloud CLI is used for nothing else.
"""
import argparse, base64, concurrent.futures as cf, gzip, hashlib, json, os, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CFG = os.path.expanduser(os.environ.get('CPH_R2_CONFIG', '~/.config/cph-twin/r2-ingest.json'))
GCS_BUCKET, GCS_PREFIX = 'lun-integrations-dev-cph-twin', 'skraafoto/tex-look/'
IMMUTABLE = 'public, max-age=31536000, immutable'
REVALIDATE = 'no-cache'
TYPES = {'.json': 'application/json', '.bin': 'application/octet-stream', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.md': 'text/markdown'}
ROOTS = ('tiles/index.json', 'city/post.json', 'city/meta.json')  # revalidated, uploaded last

cfg = json.load(open(CFG))
WORKER, KEY = cfg['worker_url'].rstrip('/'), cfg['ingest_key']
log_lock = threading.Lock()


def log(*a):
    with log_lock:
        print(*a, flush=True)


def call(method, path, body=None, headers=None, retries=6):
    h = {'x-ingest-key': KEY, 'user-agent': 'cph-twin-upload/1', **(headers or {})}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(WORKER + path, data=body, method=method, headers=h)
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404):
                raise SystemExit(f'worker refused {method} {path}: {e.code} {e.read()[:200]!r}')
            err = f'{e.code}'
        except Exception as e:  # network hiccup
            err = str(e)
        time.sleep(min(30, 2 ** attempt))
    raise SystemExit(f'giving up on {method} {path}: {err}')


def list_remote(prefix):
    out, cursor = {}, ''
    while True:
        page = call('GET', f'/list?prefix={urllib.parse.quote(prefix)}&cursor={urllib.parse.quote(cursor)}')
        for k, size, etag in page['keys']:
            out[k] = (size, etag)
        cursor = page['cursor']
        if not cursor:
            return out


def adc_token():
    return subprocess.check_output(['gcloud', 'auth', 'application-default', 'print-access-token'], text=True).strip()


# ------------------------------------------------------------------------------------------------------------ local sets
def local_files(version):
    """[(key, path)] for tiles and city; the city set is read off the index and post.json so it follows the compiler's output."""
    tiles_dir, city_dir = os.path.join(ROOT, 'data/tiles'), os.path.join(ROOT, 'data/city')
    files = []
    for dp, _, fns in os.walk(tiles_dir):
        for fn in fns:
            if fn.endswith(('.json', '.bin')):
                p = os.path.join(dp, fn)
                files.append((f'{version}/tiles/' + os.path.relpath(p, tiles_dir).replace(os.sep, '/'), p))
    index = json.load(open(os.path.join(tiles_dir, 'index.json')))
    names = {os.path.basename(v) for v in index.get('city', {}).values() if isinstance(v, str)}
    post_p = os.path.join(city_dir, 'post.json')
    names.add('post.json')
    if os.path.exists(post_p):
        post = json.load(open(post_p))
        for sec, keys in (('far', ('header', 'bin')), ('streets', ('graph',)), ('water', ('header',))):
            for k in keys:
                if isinstance(post.get(sec, {}).get(k), str):
                    names.add(post[sec][k])
    for n in sorted(names):
        p = os.path.join(city_dir, n)
        if os.path.exists(p):
            files.append((f'{version}/city/{n}', p))
        else:
            log(f'warning: data/city/{n} is named by the index but missing locally')
    return files


def prepare(key, path):
    """-> (body, headers, md5hex) for one local file."""
    ext = os.path.splitext(path)[1]
    body = open(path, 'rb').read()
    h = {'content-type': TYPES.get(ext, 'application/octet-stream'),
         'cache-control': REVALIDATE if key.split('/', 1)[1] in ROOTS else IMMUTABLE}
    if ext == '.json':
        z = gzip.compress(body, 9, mtime=0)
        if len(z) < len(body):
            body, h['content-encoding'] = z, 'gzip'
    return body, h, hashlib.md5(body).hexdigest()


def sync_local(files, remote, workers, dry):
    todo, skipped, total = [], 0, 0

    def check(item):
        key, path = item
        body, h, md5 = prepare(key, path)
        return key, body, h, md5

    stats = {'up': 0, 'bytes': 0}
    # roots last: sort so they come after everything else
    files = sorted(files, key=lambda f: (f[0].split('/', 1)[1] in ROOTS, f[0]))
    roots = [f for f in files if f[0].split('/', 1)[1] in ROOTS]
    rest = [f for f in files if f not in roots]
    for label, group in (('layers', rest), ('roots', roots)):
        with cf.ThreadPoolExecutor(workers) as ex:
            def work(item):
                key, body, h, md5 = check(item)
                if remote.get(key) == (len(body), md5):
                    return key, 'skip', 0
                if dry:
                    return key, 'would-upload', len(body)
                call('PUT', '/put?key=' + urllib.parse.quote(key), body, h)
                return key, 'up', len(body)
            done = 0
            for key, st, n in ex.map(work, group):
                done += 1
                if st == 'skip':
                    skipped += 1
                else:
                    stats['up'] += 1
                    stats['bytes'] += n
                if done % 500 == 0:
                    log(f'  {label}: {done}/{len(group)} (uploaded {stats["up"]}, {stats["bytes"] / 1e6:.0f} MB, skipped {skipped})')
    log(f'local sets: {stats["up"]} {"to upload" if dry else "uploaded"} ({stats["bytes"] / 1e6:.1f} MB stored), {skipped} unchanged')
    return stats


# ------------------------------------------------------------------------------------------------------------- tex-look
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


def sync_texlook(version, workers, dry, batch):
    token, t_token = adc_token(), time.time()
    log('listing gs://%s/%s ...' % (GCS_BUCKET, GCS_PREFIX))
    src = gcs_list(token)
    remote = list_remote(f'{version}/tex-look/')
    todo = []
    for o in src:
        rel = o['name'][len(GCS_PREFIX):]
        if not rel or rel.endswith('/'):
            continue
        key = f'{version}/tex-look/{rel}'
        md5 = base64.b64decode(o['md5Hash']).hex() if o.get('md5Hash') else None
        if remote.get(key) == (int(o['size']), md5):
            continue
        todo.append({'name': o['name'], 'key': key, 'contentType': TYPES.get(os.path.splitext(rel)[1], 'application/octet-stream')})
    gb = sum(int(o['size']) for o in src) / 1e9
    log(f'tex-look: {len(src)} objects in GCS ({gb:.2f} GB), {len(todo)} to copy, {len(src) - len(todo)} already in R2')
    # atlases only the local checkout has (the district set was generated before the citywide run): GCS wins on a name clash
    gcs_names = {o['name'][len(GCS_PREFIX):] for o in src}
    local_dir = os.path.join(ROOT, 'data/tex-look')
    extra = []
    if os.path.isdir(local_dir):
        for fn in sorted(os.listdir(local_dir)):
            if fn.endswith('.webp') and fn not in gcs_names:
                p = os.path.join(local_dir, fn)
                body = open(p, 'rb').read()
                if remote.get(f'{version}/tex-look/{fn}') != (len(body), hashlib.md5(body).hexdigest()):
                    extra.append((f'{version}/tex-look/{fn}', body))
    log(f'tex-look: {len(extra)} local-only atlases (data/tex-look, not in GCS) to upload')
    if dry or not (todo or extra):
        return
    h = {'content-type': 'image/webp', 'cache-control': IMMUTABLE}
    with cf.ThreadPoolExecutor(min(workers, 12)) as ex:
        list(ex.map(lambda e: call('PUT', '/put?key=' + urllib.parse.quote(e[0]), e[1], h), extra))
    lock, state = threading.Lock(), {'token': token, 't': t_token, 'done': 0, 'fail': []}
    t0 = time.time()

    def fresh_token():
        with lock:
            if time.time() - state['t'] > 1800:
                state['token'], state['t'] = adc_token(), time.time()
            return state['token']

    def run(chunk):
        body = json.dumps({'bucket': GCS_BUCKET, 'token': fresh_token(), 'cacheControl': IMMUTABLE, 'items': chunk}).encode()
        res = call('POST', '/gcs-copy', body, {'content-type': 'application/json'})['results']
        with lock:
            state['done'] += len(chunk)
            state['fail'] += [r for r in res if not r['ok']]
            if state['done'] % (batch * 20) < batch:
                log(f'  tex-look: {state["done"]}/{len(todo)} copied, {len(state["fail"])} failed, {state["done"] / max(1, time.time() - t0):.0f}/s')

    chunks = [todo[i:i + batch] for i in range(0, len(todo), batch)]
    with cf.ThreadPoolExecutor(workers) as ex:
        list(ex.map(run, chunks))
    log(f'tex-look: copied {state["done"] - len(state["fail"])}, failed {len(state["fail"])}')
    for r in state['fail'][:10]:
        log('  failed', r)
    if state['fail']:
        raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--version', default='v1', help='key prefix; bump it to publish regenerated data past browser caches')
    ap.add_argument('--only', default='tiles,city,tex-look')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--workers', type=int, default=24)
    ap.add_argument('--batch', type=int, default=40, help='tex-look objects per Worker call')
    a = ap.parse_args()
    only = set(a.only.split(','))
    t0 = time.time()
    if only & {'tiles', 'city'}:
        files = [f for f in local_files(a.version) if (('/tiles/' in f[0] and 'tiles' in only) or ('/city/' in f[0] and 'city' in only))]
        log(f'{len(files)} local files; listing {a.version}/ ...')
        remote = list_remote(f'{a.version}/')
        sync_local(files, remote, a.workers, a.dry_run)
    if 'tex-look' in only:
        sync_texlook(a.version, min(a.workers, 12), a.dry_run, a.batch)
    log(f'done in {time.time() - t0:.0f} s; data base = {cfg.get("public_url", "<public url>")}/{a.version}')


if __name__ == '__main__':
    main()
