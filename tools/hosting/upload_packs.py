#!/usr/bin/env python3
"""Upload a pack directory (tools/hosting/build_packs.py) to an R2 bucket with wrangler.

    python3 tools/hosting/upload_packs.py --dir .context/packs/<v> [--bucket cph-twin-data] [--public-url https://pub-....r2.dev]
                                          [--prefix ''] [--jobs 8] [--dry-run]

The pack directory is host-agnostic (any static host that serves files, ideally with HTTP Range, works: sync the directory there, serve
manifest.json with `Cache-Control: no-cache` and the packs with `public, max-age=31536000, immutable`). This is the R2 uploader:

  * only the files the manifest names (plus manifest.json) are sent; a pack the bucket already holds with the same length is skipped
    (pack names are content hashes, so same name = same bytes; the bucket is listed with the Cloudflare REST API and wrangler's token);
  * packs go first, manifest.json last, so a half finished run never publishes a manifest whose packs are missing;
  * Content-Type application/octet-stream for packs (no Content-Encoding: they are gzip'd inside), application/json for the manifest.

wrangler runs with XDG_CONFIG_HOME=--wrangler-config (default ~/.config/wrangler-personal: the personal Cloudflare account that owns
the cph-twin-data bucket; never the default login). The old unpacked layout keeps its own uploader (tools/hosting/upload_r2.py).
"""
import argparse, concurrent.futures as cf, json, os, subprocess, threading, time, urllib.parse, urllib.request

IMMUTABLE = 'public, max-age=31536000, immutable'
REVALIDATE = 'no-cache'
DEFAULT_PUBLIC = 'https://pub-d3c994d177d048d5b64ecfc3df496b48.r2.dev'
DEFAULT_ACCOUNT = 'a5f130bfd0d34de38f8e77f6a0f40a27'  # the personal Cloudflare account that owns cph-twin-data
lock = threading.RLock()


def log(*a):
    with lock:
        print(*a, flush=True)


def list_bucket(account, bucket, prefix, env):
    """{key: size} of the bucket through the Cloudflare REST API with wrangler's OAuth token (refreshed by `wrangler whoami`)."""
    subprocess.run(['wrangler', 'whoami'], env=env, capture_output=True, text=True)
    cfg = os.path.join(env['XDG_CONFIG_HOME'], '.wrangler', 'config', 'default.toml')
    token = next(l.split('=', 1)[1].strip().strip('"') for l in open(cfg) if l.startswith('oauth_token'))
    out, cursor = {}, ''
    while True:
        q = urllib.parse.urlencode({'per_page': 1000, 'prefix': prefix, **({'cursor': cursor} if cursor else {})})
        req = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects?{q}',
                                     headers={'Authorization': f'Bearer {token}', 'user-agent': 'cph-twin-upload/1'})
        d = json.load(urllib.request.urlopen(req, timeout=120))
        for o in d.get('result', []):
            out[o['key']] = int(o.get('size', -1))
        info = d.get('result_info') or {}
        cursor = info.get('cursor') or ''
        if not info.get('is_truncated') or not cursor:
            return out


def put(bucket, key, path, ctype, cache, env, dry):
    cmd = ['wrangler', 'r2', 'object', 'put', f'{bucket}/{key}', '--file', path, '--content-type', ctype, '--cache-control', cache, '--remote']
    if dry:
        return True
    for attempt in range(5):
        r = subprocess.run(cmd, env=env, capture_output=True, text=True)
        if r.returncode == 0:
            return True
        err = (r.stderr or r.stdout)[-400:]
        time.sleep(min(30, 2 ** attempt))
    raise SystemExit(f'upload of {key} failed: {err}')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dir', required=True)
    ap.add_argument('--bucket', default='cph-twin-data')
    ap.add_argument('--public-url', default=DEFAULT_PUBLIC)
    ap.add_argument('--account', default=DEFAULT_ACCOUNT, help='Cloudflare account id of the bucket (for listing it)')
    ap.add_argument('--prefix', default='', help='key prefix inside the bucket (the data base is <public url>/<prefix>)')
    ap.add_argument('--jobs', type=int, default=8)
    ap.add_argument('--wrangler-config', default=os.path.expanduser(os.environ.get('CPH_WRANGLER_CONFIG', '~/.config/wrangler-personal')))
    ap.add_argument('--force', action='store_true', help='upload even when the public URL already has the file')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    d = os.path.abspath(a.dir)
    manifest = json.load(open(os.path.join(d, 'manifest.json')))
    names = set(manifest['files'].values())
    for row in manifest['tiles'].values():
        names.update(n for n in row if n)
    missing = [n for n in names if not os.path.exists(os.path.join(d, n))]
    if missing:
        raise SystemExit(f'{len(missing)} packs the manifest names are not in {d}: {missing[:5]}')
    env = {**os.environ, 'XDG_CONFIG_HOME': a.wrangler_config}
    pre = a.prefix.strip('/') + '/' if a.prefix.strip('/') else ''
    pub = a.public_url.rstrip('/') + '/' + pre
    names = sorted(names)
    total = sum(os.path.getsize(os.path.join(d, n)) for n in names)
    log(f'{len(names)} packs ({total / 1e6:.0f} MB) + manifest.json -> r2://{a.bucket}/{pre} ({pub})')
    t0 = time.time()
    stats = {'up': 0, 'skip': 0, 'bytes': 0}

    remote = {} if a.force else list_bucket(a.account, a.bucket, pre, env)
    log(f'bucket holds {len(remote)} objects under {pre or "/"}')

    def one(n):
        p = os.path.join(d, n)
        size = os.path.getsize(p)
        if remote.get(pre + n) == size:
            with lock:
                stats['skip'] += 1
            return
        put(a.bucket, pre + n, p, 'application/octet-stream', IMMUTABLE, env, a.dry_run)
        with lock:
            stats['up'] += 1
            stats['bytes'] += size
            if stats['up'] % 100 == 0:
                log(f'  {stats["up"]} uploaded ({stats["bytes"] / 1e6:.0f} MB), {stats["skip"]} already there, {time.time() - t0:.0f} s')

    with cf.ThreadPoolExecutor(a.jobs) as ex:
        list(ex.map(one, names))
    put(a.bucket, pre + 'manifest.json', os.path.join(d, 'manifest.json'), 'application/json', REVALIDATE, env, a.dry_run)
    log(f'{"would upload" if a.dry_run else "uploaded"} {stats["up"]} packs ({stats["bytes"] / 1e6:.0f} MB), {stats["skip"]} already there, '
        f'manifest last; {time.time() - t0:.0f} s. Data base: {pub.rstrip("/")}')


if __name__ == '__main__':
    main()
