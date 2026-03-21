#!/usr/bin/env python3
"""
Dashboard local server
  Run:      python3 server.py
  Dashboard: http://localhost:8080
  Editor:    http://localhost:8080/edit
"""
import http.server
import json
import socketserver
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = Path(__file__).parent
DATA = ROOT / "data.js"

HEADER = (
    "// ================================================================\n"
    "//  DASHBOARD DATA\n"
    "//  Edit visually: http://localhost:{port}/edit\n"
    "//  or edit this file directly\n"
    "// ================================================================\n\n"
    "const DASHBOARD = "
).format(port=PORT)


def read_dashboard():
    src = DATA.read_text("utf-8")
    idx = src.find("const DASHBOARD =")
    if idx == -1:
        raise ValueError("Could not find DASHBOARD in data.js")
    raw = src[idx + len("const DASHBOARD ="):].strip().rstrip(";").strip()
    return json.loads(raw)


def write_dashboard(obj):
    DATA.write_text(
        HEADER + json.dumps(obj, indent=2, ensure_ascii=False) + ";\n",
        "utf-8"
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path in ("/api/data", "/api/data/"):
            try:
                self._json(read_dashboard())
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif self.path.rstrip("/") == "/edit":
            self.path = "/edit.html"
            super().do_GET()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path in ("/api/save", "/api/save/"):
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            try:
                obj = json.loads(body)
                write_dashboard(obj)
                self._json({"ok": True})
            except Exception as e:
                self._json({"error": str(e)}, 400)
        else:
            self.send_error(404)

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(b))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, fmt, *args):
        # Only log errors
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
    print(f"\n  Dashboard  →  http://localhost:{PORT}")
    print(f"  Editor     →  http://localhost:{PORT}/edit\n")
    print("  Press Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
