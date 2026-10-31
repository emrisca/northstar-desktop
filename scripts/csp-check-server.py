#!/usr/bin/env python3
"""Serve src/ with the content security policy from src-tauri/tauri.conf.json.

A browser ignores a policy that arrives in a meta tag when a file is opened
from disk, and none of the policy is exercised until a response carries it.
This serves the interface with the same header Tauri sends, so a run here
tests the policy that ships.

    python3 scripts/csp-check-server.py 8091
"""

import functools
import http.server
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"


def policy() -> str:
    conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())
    csp = conf["app"]["security"]["csp"]
    if not isinstance(csp, str) or not csp.strip():
        sys.exit("tauri.conf.json has no csp string; there is nothing to test.")
    return csp


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", policy())
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    handler = functools.partial(Handler, directory=str(SRC))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"serving {SRC} on http://127.0.0.1:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
