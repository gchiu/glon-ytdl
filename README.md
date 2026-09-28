# glon-ytdl

A very small, local proof-of-concept: paste a YouTube URL into a Glon page,
press **Download**, and a localhost Python server downloads the video with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), using ffmpeg to merge/convert when
required.

Intended for downloading material you own or have permission to save.

```
browser / Glon page
        |  POST /download   (text/plain body = one URL)
        v
    server.py  (127.0.0.1 only)
        |
        v
      yt-dlp (Python API)
        |
        v
      ffmpeg / ffprobe
        |
        v
    downloads/
```

The same Python process also serves the page and its assets from `web/`, so the
page is same-origin with the API.

## Detected environment

This repository was developed in **WSL2 (Ubuntu 22.04)**, which is the supported
setup below:

- Python 3.10 (`/usr/bin/python3`)
- `yt-dlp`, `ffmpeg`, `ffprobe`: **not** installed in WSL initially
- `deno`: **not** installed in WSL
- The Windows host *does* have `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe` and
  `deno.exe` (via WinGet), but this project uses the Linux/WSL tools so the
  server and its subprocesses stay in one environment.

> yt-dlp 2026.x prints a deprecation warning on Python 3.10. It still works
> (the download above succeeded), but Python 3.11+ is recommended for yt-dlp.

## Quick start (WSL / Linux)

```bash
# 1. Create a virtual environment.
#    On a fresh Ubuntu, `python3 -m venv` needs the venv module:
sudo apt-get install -y python3.10-venv      # once, if missing
python3 -m venv .venv
#    If you cannot use sudo, virtualenv works without it:
#    python3 -m pip install --user virtualenv && python3 -m virtualenv .venv

# 2. Install Python requirements (yt-dlp, Flask, static-ffmpeg).
.venv/bin/pip install -r requirements.txt

# 3. Run the server.
.venv/bin/python server.py

# 4. Open the page.
#    http://127.0.0.1:8000
```

The page shows a readiness line from `GET /status`. A green/complete line means
the toolchain is ready.

### ffmpeg / ffprobe

`static-ffmpeg` (a declared requirement) provides self-contained Linux
`ffmpeg` + `ffprobe` binaries. `server.py` calls `static_ffmpeg.add_paths()`
when the system has no ffmpeg, so the **first run downloads the binaries once**
(needs network). Alternatively install the system packages:

```bash
sudo apt-get install -y ffmpeg
```

### Deno (recommended, not required)

yt-dlp 2026.x enables **Deno by default** as its JavaScript runtime for YouTube
support (`--js-runtimes deno`). Without it, some YouTube formats can be
unavailable. `GET /status` reports whether `deno` is on `PATH`. To install it in
WSL:

```bash
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"     # add to ~/.bashrc to persist
```

### yt-dlp upgrades

YouTube changes frequently; keep yt-dlp current:

```bash
.venv/bin/pip install -U yt-dlp
```

## HTTP interface

| Method | Path        | Purpose |
|--------|-------------|---------|
| `GET`  | `/`         | The Glon page (`web/index.html`) |
| `GET`  | `/status`   | `{"yt_dlp": "...", "ffmpeg": bool, "ffprobe": bool, "deno": bool}` |
| `POST` | `/download` | Body is one YouTube URL; downloads it into `downloads/` and returns `{"ok": bool, "message": "...", "file": "..."}` |

Only `youtube.com` / `youtu.be` hosts are accepted. The request body is parsed
strictly as a URL: yt-dlp is driven through its **Python API**, never a shell,
and `shell=True` is not used anywhere.

The server binds to **127.0.0.1 only** and is not exposed on the LAN.

## The Glon UI

The page is a real Glon page, reusing the existing browser pattern from the
sibling `rebol-substrate-experiment` repository
(`demo/shop/`: `<script type="application/glon">` blocks + a handwritten
`*-host.js` + a compiled `glon.wasm`). No new Glon syntax was invented.

| File | Role |
|------|------|
| `glon/common.glon` | Vendored view dialect + string primitives (`emit-*`, `button`, `str-eq`, `mk-string`) from `rebol-substrate-experiment/demo/shop/common.glon` |
| `glon/app.glon` | This application: URL/status/readiness state, the view, and the event dispatcher |
| `web/glon.wasm` | Vendored G1A runtime from `rebol-substrate-experiment/demo/shop/glon.wasm` (exports `glon_init/load/route/event/event_value`) |
| `web/ytdl-host.js` | Browser host bridge: loads the blocks, writes rendered HTML, forwards events, performs the rendered request, fetches `/status` |
| `web/index.html` | Generated bundle (do not edit by hand) |
| `build_page.py` | Bundles `glon/*.glon` into `web/index.html` |

How the download request crosses the boundary, without any app logic in JS:

1. Glon renders a hidden marker while a download is pending:
   `<span data-glon-request='/download' data-glon-request-event='download-done'>URL</span>`
2. The host turns the marker into `POST /download` and, when the reply arrives,
   calls `glon_event_value('download-done', message)`.
3. Glon decides what the result means and re-renders.

Rebuild the generated page after editing the `.glon` source:

```bash
.venv/bin/python build_page.py
```

### Headless verification

`tools/glon_smoke.py` instantiates the real `glon.wasm`, loads the same blocks
the browser loads, and drives the event bridge (no browser needed):

```bash
.venv/bin/pip install wasmtime      # developer-only, not a runtime dependency
.venv/bin/python tools/glon_smoke.py
```

## Notes and limits (first milestone)

- One download at a time; no auth, database, queue, playlists, or WebSockets.
- No live progress bar; the status line reads `Downloading...` then the result.
- `glon_event_value` carries at most **200 bytes**, so URLs and status messages
  are kept short.
- The Glon view dialect does not HTML-escape data; this local single-user POC
  does not accept untrusted multi-user input.
- Prefer MP4: `merge_output_format = "mp4"` remuxes where the codecs allow it
  and deliberately does **not** transcode to force MP4.

## Legal

Use only for material you own or have permission to save. Respect YouTube's
Terms of Service and applicable copyright law.
