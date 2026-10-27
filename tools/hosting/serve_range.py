#!/usr/bin/env python3
"""Static file server with HTTP Range support (python -m http.server has none), for serving a pack directory locally.

    python3 tools/hosting/serve_range.py [--port 8000] [--dir .] [--no-range] [--log requests.jsonl] [--cors]

Single byte ranges (`bytes=a-b`, `bytes=a-`, `bytes=-n`) are answered 206 with Content-Range; anything else gets the whole file (200),
as a host without Range support would (--no-range forces that, to test the client's whole-file fallback). --log appends one JSON line per
request: { t, method, path, status, bytes, range }.
"""
import argparse, functools, json, os, re, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    range_ok = True
    log_path = None
    cors = False

    def log_message(self, *a):
        pass

    def _log(self, status, n, rng=None):
        if not self.log_path:
            return
        with LOCK, open(self.log_path, 'a') as f:
            f.write(json.dumps({'t': round(time.time(), 3), 'method': self.command, 'path': self.path, 'status': status, 'bytes': n, 'range': rng}) + '\n')

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes' if self.range_ok else 'none')
        if self.cors:
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag')
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        if os.path.isdir(path) or not os.path.exists(path):
            r = super().do_GET()
            self._log(404 if not os.path.exists(path) else 200, 0)
            return r
        size = os.path.getsize(path)
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng or '') if (self.range_ok and rng) else None
        if m and (m.group(1) or m.group(2)):
            a, b = m.group(1), m.group(2)
            if a == '':
                start, end = max(0, size - int(b)), size - 1
            else:
                start, end = int(a), min(size - 1, int(b) if b else size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                self._log(416, 0, rng)
                return
            with open(path, 'rb') as f:
                f.seek(start)
                body = f.read(end - start + 1)
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self._log(206, len(body), rng)
            return
        r = super().do_GET()
        self._log(200, size, rng)
        return r


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--dir', default='.')
    ap.add_argument('--no-range', action='store_true')
    ap.add_argument('--log', default=None)
    ap.add_argument('--cors', action='store_true')
    a = ap.parse_args()
    Handler.range_ok, Handler.log_path, Handler.cors = not a.no_range, a.log, a.cors
    srv = ThreadingHTTPServer((a.bind, a.port), functools.partial(Handler, directory=os.path.abspath(a.dir)))
    srv.daemon_threads = True
    print(f'serving {os.path.abspath(a.dir)} on http://{a.bind}:{srv.server_port} (range {"on" if Handler.range_ok else "off"})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
