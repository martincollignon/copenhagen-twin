# Headless Chromium harness for the M3 checks: uv run --with playwright python tools/cph-m3-check.py tools/cph-m3/sim.py
import sys, json, subprocess, time, socket, os, http.server, threading, functools
from playwright.sync_api import sync_playwright
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
def free_port():
    s=socket.socket(); s.bind(('127.0.0.1',0)); p=s.getsockname()[1]; s.close(); return p
port=free_port()
handler=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
handler=functools.partial(Q, directory=ROOT)
srv=http.server.ThreadingHTTPServer(('127.0.0.1',port),handler)
threading.Thread(target=srv.serve_forever,daemon=True).start()
script=sys.argv[1]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--enable-unsafe-webgpu','--use-angle=metal','--enable-features=Vulkan','--ignore-gpu-blocklist'])
    pg=b.new_page(viewport={'width':1280,'height':720})
    logs=[]
    pg.on('console',lambda m: logs.append(f'[{m.type}] {m.text}'))
    pg.on('pageerror',lambda e: logs.append('[pageerror] '+str(e)+' '+str(getattr(e,'stack',''))))
    exec(open(script).read())  # the check scripts: tools/cph-m3/*.py
    b.close()
