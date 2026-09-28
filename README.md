# glon-ytdl

A very small proof-of-concept: paste a YouTube URL into a **Glon** page — served
either locally or from GitHub Pages — choose **Download audio** (the default,
primary action) or **Download video**, and a localhost Python server fetches it
with [yt-dlp](https://github.com/yt-dlp/yt-dlp), using ffmpeg to merge/convert
when required.

Intended for downloading material you own or have permission to save.

```
GitHub Pages Glon UI   (https://gchiu.github.io/glon-ytdl/)
        |  GET  http://127.0.0.1:8000/status          (readiness)
        |  POST http://127.0.0.1:8000/download?mode=audio|video
        |       (text/plain body = one URL)
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

The browser page is served statically from `docs/` (GitHub Pages). It calls the
loopback service at an **explicit origin** (default `http://127.0.0.1:8000`),
never an assumed same-origin path. The same `docs/` folder is also served by
`server.py` for local development.

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

# 4. Open the local development page.
#    http://127.0.0.1:8000
```

The same page is published to GitHub Pages (below); either UI talks to the same
local service.

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
| `GET`  | `/`         | The Glon page (`docs/index.html`) |
| `GET`  | `/status`   | `{"yt_dlp": "...", "ffmpeg": bool, "ffprobe": bool, "deno": bool}` |
| `POST` | `/download?mode=audio` | Best audio-only stream, preserved as-is (no transcode) |
| `POST` | `/download?mode=video` | Best video + audio, merged to MP4 where possible |

The `POST` body is one YouTube URL. `mode` defaults to `video` if omitted, so
the previous single-purpose API still works.

yt-dlp options per mode:

- **audio** — `format = "bestaudio"`: the best audio-only stream, downloaded
  unchanged (e.g. Opus/WebM), so the source codec/quality is preserved and no
  lossy transcode or ffmpeg step is needed.
- **video** — `format = "bv*+ba/b"` with `merge_output_format = "mp4"`: best
  video + best audio, merged to MP4 where the codecs permit a remux.

Only `youtube.com` / `youtu.be` hosts are accepted. The request body is parsed
strictly as a URL: yt-dlp is driven through its **Python API**, never a shell,
and `shell=True` is not used anywhere.

The server binds to **127.0.0.1 only** and is not exposed on the LAN.

## Remote page → local API (the Live Translate pattern)

This is the same shape already used by the sibling Live Translate project: a
page hosted remotely (there, GitHub Pages ReGlon) talks to a localhost Python
service via an explicit local origin — Live Translate passes
`?relay=wss://localhost:8000/audio` and uses a local certificate; here the page
uses `http://127.0.0.1:8000` and CORS.

- **Explicit origin.** `docs/ytdl-host.js` defaults to
  `http://127.0.0.1:8000` and never assumes same-origin. Override it with
  `?api=<origin>` on the page URL, or `window.YTDL_API`.
- **CORS + preflight.** `server.py` answers `OPTIONS` with `204` and, for an
  allowed `Origin`, adds `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and
  `Access-Control-Allow-Private-Network: true` (Chrome's Private Network Access
  requires the last one for a public HTTPS page reaching loopback).
- **Permitted origins.** Only `https://gchiu.github.io`,
  `http://127.0.0.1:8000` and `http://localhost:8000` by default. Add temporary
  test origins with `YTDL_ALLOWED_ORIGINS` (comma-separated).
- **Service not running.** If `GET /status` cannot be reached, the page shows:

      Local downloader is not running.
      Start it with:
      .venv/bin/python server.py

  and a download attempt shows the same message.

## GitHub Pages deployment

No build workflow is needed. Publish the static folder directly:

1. Push this repository to `https://github.com/gchiu/glon-ytdl`.
2. In GitHub: **Settings → Pages → Build and deployment**.
   - Source: **Deploy from a branch**
   - Branch: **`master`**, folder: **`/docs`**
   - Save.
3. Expected URL: **`https://gchiu.github.io/glon-ytdl/`**

`docs/.nojekyll` disables Jekyll so the files are served verbatim
(including `glon.wasm`). `docs/index.html` is generated from `glon/*.glon` by
`build_page.py`; commit the regenerated file when the Glon source changes.

> Mixed-content note: browsers treat `http://127.0.0.1` / `http://localhost` as
> potentially trustworthy, so an HTTPS Pages page may call the plain-HTTP
> loopback API.

## The Glon UI

The page is a real Glon page, reusing the existing browser pattern from the
sibling `rebol-substrate-experiment` repository
(`demo/shop/`: `<script type="application/glon">` blocks + a handwritten
`*-host.js` + a compiled `glon.wasm`). No new Glon syntax was invented.

| File | Role |
|------|------|
| `glon/common.glon` | Vendored view dialect + string primitives (`emit-*`, `button`, `str-eq`, `mk-string`) from `rebol-substrate-experiment/demo/shop/common.glon` |
| `glon/app.glon` | This application: URL/status/readiness state, the view, and the event dispatcher |
| `docs/glon.wasm` | Vendored G1A runtime from `rebol-substrate-experiment/demo/shop/glon.wasm` (exports `glon_init/load/route/event/event_value`) |
| `docs/ytdl-host.js` | Browser host bridge: loads the blocks, writes rendered HTML, forwards events, performs the rendered request against the explicit API origin, fetches `<api>/status` |
| `docs/index.html` | Generated bundle (do not edit by hand) |
| `docs/.nojekyll` | Disables Jekyll on GitHub Pages |
| `build_page.py` | Bundles `glon/*.glon` into `docs/index.html` |

`docs/` is both the local server root and the published GitHub Pages folder.

How the download request crosses the boundary, without any app logic in JS:

1. Glon renders a hidden marker while a download is pending:
   `<span data-glon-request='/download' data-glon-request-event='download-done'>URL</span>`
2. The host turns the marker into `POST <api>/download?mode=audio|video` and,
   when the reply arrives, calls `glon_event_value('download-done', message)`.
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

## Notes and limits

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
