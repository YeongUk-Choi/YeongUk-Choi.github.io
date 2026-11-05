#!/usr/bin/env python3
"""Local RSM UI verification: serves this checkout with an isolated test gate.

No production authentication request is made. Test code: rsm-local-test.
Run python3 scripts/serve_rsm_preview.py --port 8765. Binds loopback only.
"""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

class Preview(SimpleHTTPRequestHandler):
    def answer(self, data, mime):
        body = data.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == '/data/phases.js':
            return self.answer('window.SITE=window.SITE||{};window.SITE.phases={relayUrl:"/test-gate"};', 'text/javascript')
        super().do_GET()

    def do_POST(self):
        if self.path != '/test-gate':
            return self.send_error(404)
        size = int(self.headers.get('Content-Length', '0'))
        if size > 1024:
            return self.send_error(413)
        data = parse_qs(self.rfile.read(size).decode('utf-8'))
        ok = data.get('action') == ['xrdcheck'] and data.get('code') == ['rsm-local-test']
        self.answer(json.dumps({'ok': ok, 'error': '' if ok else 'Wrong code'}), 'application/json')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Preview, directory=str(root)))
    print(f'RSM local test: http://127.0.0.1:{args.port}/rsm.html (code: rsm-local-test)', flush=True)
    server.serve_forever()
