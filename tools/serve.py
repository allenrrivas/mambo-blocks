"""
serve.py — dev server that refuses to let the browser cache anything.

python -m http.server sends Last-Modified, so browsers heuristically cache the
ES modules and you end up testing yesterday's code. That is very hard to spot,
because the app still loads and mostly works.

    python tools/serve.py [port]

Defaults to port 8777.
"""

import functools
import http.server
import os
import pathlib
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default: only report anything that is not a 200.
        status = str(args[1]) if len(args) > 1 else ""
        if not status.startswith("2"):
            super().log_message(fmt, *args)


def main():
    os.chdir(ROOT)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    # Threading matters: browsers hold several keep-alive connections open, and
    # a single-threaded server deadlocks behind the first one.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", PORT), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{PORT}  (caching disabled)")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
