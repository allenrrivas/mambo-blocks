"""
serve.py — classroom server for Mambo Blocks.

Serves the app to student iPads over the local network and collects the
programs they submit into a queue the teacher flies one at a time.

    python tools/serve.py [port]

Students open   http://<this-machine-ip>:8777/         (plain Safari is fine)
Teacher opens   http://localhost:8777/teacher.html

Nothing leaves the room: no cloud, no accounts, works with the internet down.

Caching is disabled deliberately. python -m http.server sends Last-Modified,
so browsers heuristically cache the ES modules and you end up testing old code
while the app still loads and mostly works, which is very hard to spot.
"""

import functools
import http.server
import json
import os
import pathlib
import socket
import sys
import threading
import time
import uuid

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = pathlib.Path(__file__).resolve().parent.parent
QUEUE_FILE = ROOT / "submissions.jsonl"
MAX_BODY = 256 * 1024  # a Blockly program is a few KB; this is generous

_lock = threading.Lock()
_queue = []


def load_queue():
    """Restore the queue so a server restart mid-lesson is not a disaster."""
    if not QUEUE_FILE.exists():
        return
    for line in QUEUE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            _queue.append(json.loads(line))
        except json.JSONDecodeError:
            continue


def append_queue(item):
    with QUEUE_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(item) + "\n")


def rewrite_queue():
    with QUEUE_FILE.open("w", encoding="utf-8") as fh:
        for item in _queue:
            fh.write(json.dumps(item) + "\n")


def lan_ip():
    """Best-effort outward-facing IP, so we can print the URL for students."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    # ---- helpers ----------------------------------------------------------

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def log_message(self, fmt, *args):
        status = str(args[1]) if len(args) > 1 else ""
        if not status.startswith("2"):
            super().log_message(fmt, *args)

    # ---- routing ----------------------------------------------------------

    def do_GET(self):
        if self.path.startswith("/api/queue"):
            with _lock:
                return self._json({"queue": _queue})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/submit":
            return self._submit()
        if self.path.startswith("/api/status/"):
            return self._set_status(self.path.rsplit("/", 1)[-1])
        if self.path == "/api/clear":
            return self._clear()
        return self._json({"error": "unknown endpoint"}, 404)

    # ---- endpoints --------------------------------------------------------

    def _submit(self):
        data = self._read_json()
        if not isinstance(data, dict):
            return self._json({"error": "expected a JSON object"}, 400)

        name = str(data.get("name") or "").strip()[:40] or "anonymous"
        mode = data.get("mode") if data.get("mode") in ("blocks", "python") else "blocks"
        program = data.get("program")
        if program is None:
            return self._json({"error": "missing program"}, 400)

        # We are Python, so we can check a student's syntax with the real
        # parser for free and tell them before it ever reaches the drone.
        # Beats finding out when the teacher tries to fly it.
        if mode == "python":
            if not isinstance(program, str):
                return self._json({"error": "python program must be text"}, 400)
            try:
                compile(program, "<student>", "exec")
            except SyntaxError as exc:
                return self._json({
                    "error": "syntax",
                    "line": exc.lineno,
                    "message": exc.msg,
                }, 400)

        item = {
            "id": uuid.uuid4().hex[:10],
            "name": name,
            "mode": mode,
            "program": program,
            "submitted_at": time.time(),
            "status": "waiting",
        }
        with _lock:
            # One pending submission per student: resubmitting replaces the
            # old one rather than letting a kid spam the queue.
            for i, existing in enumerate(_queue):
                if existing["name"] == name and existing["status"] == "waiting":
                    _queue[i] = item
                    rewrite_queue()
                    break
            else:
                _queue.append(item)
                append_queue(item)
        print(f"  submission from {name} ({mode})")
        return self._json({"ok": True, "id": item["id"]})

    def _set_status(self, item_id):
        data = self._read_json() or {}
        status = data.get("status")
        if status not in ("waiting", "flown", "skipped"):
            return self._json({"error": "bad status"}, 400)
        with _lock:
            for item in _queue:
                if item["id"] == item_id:
                    item["status"] = status
                    rewrite_queue()
                    return self._json({"ok": True})
        return self._json({"error": "no such submission"}, 404)

    def _clear(self):
        with _lock:
            _queue.clear()
            rewrite_queue()
        return self._json({"ok": True})


def main():
    os.chdir(ROOT)
    load_queue()
    handler = functools.partial(Handler, directory=str(ROOT))
    # Threading matters: browsers hold several keep-alive connections open, and
    # a single-threaded server deadlocks behind the first one.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", PORT), handler) as httpd:
        ip = lan_ip()
        print(f"Mambo Blocks classroom server  (caching disabled)")
        print(f"  students -> http://{ip}:{PORT}/")
        print(f"  teacher  -> http://localhost:{PORT}/teacher.html")
        if _queue:
            waiting = sum(1 for i in _queue if i["status"] == "waiting")
            print(f"  restored {len(_queue)} submissions ({waiting} waiting)")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
