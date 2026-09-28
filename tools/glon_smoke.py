#!/usr/bin/env python3
"""tools/glon_smoke.py -- headless verification of the Glon page's application.

Instantiates docs/glon.wasm with the page's host imports, loads the same two
`<script type="application/glon">` blocks the browser host loads, then drives
the real event bridge (glon_event / glon_event_value) and asserts the rendered
HTML.  The only stubbed parts are the DOM (host_set_html is captured) and the
network (the /download request is not performed).

Optional developer tool; needs `pip install wasmtime`.  It is NOT a runtime
dependency of the server.

Run:  python3 tools/glon_smoke.py
"""

import pathlib
import re
import sys

try:
    from wasmtime import Store, Module, Instance, Func, FuncType, ValType
except ImportError:
    sys.exit("wasmtime not installed; run: pip install wasmtime")

BASE = pathlib.Path(__file__).resolve().parent.parent
WASM = BASE / "docs" / "glon.wasm"
INDEX = BASE / "docs" / "index.html"

html = INDEX.read_text(encoding="utf-8")
blocks = re.findall(r'<script type="application/glon"[^>]*>(.*?)</script>', html, re.S)
if len(blocks) != 2:
    sys.exit(f"expected 2 glon blocks in index.html, found {len(blocks)}")

rendered = []
logs = []
holder = {}


def read_bytes(ptr, length):
    return bytes(holder["memory"].read(store, ptr, ptr + length))


store = Store()
module = Module.from_file(store.engine, WASM)

import_funcs = {
    "host_print": lambda ptr, ln: logs.append(read_bytes(ptr, ln).decode("utf-8")),
    "host_set_text": lambda handle, value: None,
    "host_set_html": lambda handle, ptr, ln: rendered.append(read_bytes(ptr, ln).decode("utf-8")),
    "host_canvas_script": lambda ptr, ln: None,
}

arg_types = {
    "host_print": [ValType.i32(), ValType.i32()],
    "host_set_text": [ValType.i32(), ValType.i32()],
    "host_set_html": [ValType.i32(), ValType.i32(), ValType.i32()],
    "host_canvas_script": [ValType.i32(), ValType.i32()],
}

imports = [
    Func(store, FuncType(arg_types[i.name], []), import_funcs[i.name])
    for i in module.imports
]

inst = Instance(store, module, imports)
exports = inst.exports(store)
holder["memory"] = exports.get("memory")


def call(name, *args):
    return exports.get(name)(store, *args)


def put(text):
    data = text.encode("utf-8")
    ptr = call("glon_alloc", len(data))
    holder["memory"].write(store, data, ptr)
    return ptr, len(data)


def load(src):
    p, n = put(src)
    rc = call("glon_load", p, n)
    if rc != 0:
        sys.exit(f"glon_load rc={rc}")


def event(token):
    rendered.clear()
    p, n = put(token)
    rc = call("glon_event", p, n)
    if rc != 0:
        sys.exit(f"glon_event({token!r}) rc={rc}")
    return "".join(rendered)


def event_value(token, value):
    rendered.clear()
    tp, tn = put(token)
    vp, vn = put(value)
    rc = call("glon_event_value", tp, tn, vp, vn)
    if rc != 0:
        sys.exit(f"glon_event_value({token!r}) rc={rc}")
    return "".join(rendered)


def check(name, page, *needles):
    for needle in needles:
        if needle not in page:
            sys.exit(f"FAIL {name}: missing {needle!r}\n--- page ---\n{page}")


if call("glon_init") != 0:
    sys.exit("glon_init failed")

load(blocks[0])  # common
load(blocks[1])  # app

page = event("init")
check("init", page, "Local YouTube Download", "Paste a YouTube URL",
      "data-glon-input='download'",
      "data-glon-event='download-audio'", "Download audio",
      "data-glon-event='download-video'", "Download video",
      "Checking runtime...")

page = event_value("readiness", "yt-dlp 2026.08.19  |  ffmpeg  |  ffprobe  |  deno absent")
check("readiness", page, "yt-dlp 2026.08.19")

url = "https://www.youtube.com/watch?v=abcdefghijk"
page = event_value("download-audio", url)
check("download-audio", page, "Requesting audio download...",
      "data-glon-request='/download?mode=audio'",
      "data-glon-request-event='download-done'", url)

page = event_value("download-video", url)
check("download-video", page, "Requesting video download...",
      "data-glon-request='/download?mode=video'",
      "data-glon-request-event='download-done'", url)

page = event_value("download-done", "Saved audio: clip [abcdefghijk].webm")
check("download-done", page, "Saved audio: clip [abcdefghijk].webm")
if "data-glon-request" in page:
    sys.exit("FAIL download-done: request marker was not cleared")

page = event_value("readiness", "yt-dlp 2026.08.19  |  ffmpeg MISSING")
check("readiness after", page, "ffmpeg MISSING")
if "data-glon-request" in page:
    sys.exit("FAIL readiness after: stale request marker present")

offline = (
    "Local downloader is not running.\n"
    "Start it with:\n"
    ".venv/bin/python server.py"
)
page = event_value("ready-failed", offline)
check("ready-failed", page, "Local downloader is not running.",
      ".venv/bin/python server.py")

print("GLON_SMOKE PASS (init / readiness / audio+video request markers / result / offline)")
