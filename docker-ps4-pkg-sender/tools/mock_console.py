#!/usr/bin/env python3
"""Local mock console for testing the web UI.

  python3 tools/mock_console.py            # PS5 pkg-receiver mode (port 12800)
  python3 tools/mock_console.py rpi        # PS4 RPI mode
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else "receiver"
BUSY_UNTIL = 0.0
LOCK = threading.Lock()
TASKS = {}


class H(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def _text(self, s, code=200):
        out = s.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        if MODE == "rpi":
            if self.path == "/api":
                return self._json({"status": "fail", "error": "Unsupported method: use POST /api/install"})
            if self.path.startswith("/api/get_task_progress"):
                return self._json({"status": "success", "progress": {"rest": 0, "total": 100}})
            return self._json({"status": "fail", "error": "not found"}, 404)

        if self.path.startswith("/api/status"):
            with LOCK:
                busy = time.time() < BUSY_UNTIL
            return self._json({"busy": busy, "active": 1 if busy else 0, "pull": False})
        if self.path.startswith("/api/space"):
            return self._json({"free": 412 * 1024 ** 3, "total": 850 * 1024 ** 3})
        if self.path.startswith("/api/version"):
            return self._json({"build": "mock-receiver 1.0"})
        if self.path == "/api":
            return self._json({"status": "fail", "error": "Unsupported method: use POST /api/install"})
        return self._json({"status": "fail", "error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace")
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if self.path.startswith("/api/install"):
            pkgs = data.get("packages", [])
            name = data.get("name", "")
            print(f"[{MODE}] install name={name!r} -> {pkgs}", flush=True)
            global BUSY_UNTIL
            with LOCK:
                BUSY_UNTIL = time.time() + 2.0
            if MODE == "rpi":
                return self._json({"status": "success", "task_ids": [len(TASKS) + 100]})
            return self._json({"status": "success", "task_ids": [1]})

        if self.path.startswith("/api/uninstall"):
            print(f"[{MODE}] {self.path} {body}", flush=True)
            return self._json({"status": "success"})

        if self.path.startswith("/api/stop_task") or self.path.startswith("/api/pause_task"):
            return self._json({"status": "success"})

        return self._json({"status": "fail", "error": "not found"}, 404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"mock console ({MODE}) on 127.0.0.1:12800")
    HTTPServer(("127.0.0.1", 12800), H).serve_forever()
