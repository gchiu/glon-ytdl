#!/usr/bin/env python3
"""server.py -- a tiny local yt-dlp download server for the Glon page.

The server is deliberately small:

    browser / Glon page
            |  POST /download?mode=audio|video   (text/plain body = one URL)
            v
        this server (127.0.0.1 only)
            |
            v
          yt-dlp (Python API)
            |
            v
          ffmpeg (merge / remux)
            |
            v
        downloads/

It also serves the page and its assets from docs/ for local development.  The
same docs/ folder is published as the static GitHub Pages site; the remote page
calls this loopback service at an explicit origin (default
http://127.0.0.1:8000) with a CORS allow-list, mirroring the Live Translate
GitHub-Pages-to-localhost pattern (there, an explicit ?relay=wss://localhost:8000
URL with a local certificate).

Security choices:
  * binds to 127.0.0.1 only -- never exposed on the LAN;
  * the request body is treated strictly as a URL (parsed and allow-listed),
    never as command-line text;
  * yt-dlp is invoked through its Python API, never a shell, so shell=True is
    not used anywhere;
  * CORS is limited to the GitHub Pages origin plus localhost dev origins.
"""

import os
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent
WEB = BASE / "docs"
DOWNLOADS = BASE / "downloads"
DOWNLOADS.mkdir(exist_ok=True)

# Browser origins allowed to call this loopback service.  The GitHub Pages site
# is remote; the localhost entries cover local development (the server also
# serves the page).  Extra origins may be supplied via YTDL_ALLOWED_ORIGINS
# (comma-separated) for testing.
ALLOWED_ORIGINS = {
    "https://gchiu.github.io",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
}
ALLOWED_ORIGINS.update(
    origin.strip()
    for origin in os.environ.get("YTDL_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)


def ensure_ffmpeg() -> None:
    """Make ffmpeg/ffprobe discoverable.

    If the system has no ffmpeg, the `static-ffmpeg` package (a declared
    requirement) provides self-contained Linux binaries and prepends them to
    PATH.  The first call downloads them, which needs network once.
    """
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    try:
        import static_ffmpeg

        static_ffmpeg.add_paths()
    except Exception as exc:  # pragma: no cover - best effort only
        print(f"server: could not provision static ffmpeg: {exc}", file=sys.stderr)


ensure_ffmpeg()

import yt_dlp  # noqa: E402  (import after ffmpeg PATH setup)

app = Flask(__name__)


@app.before_request
def _cors_preflight():
    """Answer CORS/PNA preflights (the headers are added in _cors_headers)."""
    if request.method == "OPTIONS":
        return ("", 204)
    return None


@app.after_request
def _cors_headers(response):
    """Grant the configured browser origins access to this loopback API."""
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        # Chrome Private Network Access: an HTTPS public page (GitHub Pages)
        # reaching a loopback service must be granted this on the preflight.
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        response.headers.add("Vary", "Origin")
    return response

# The milestone is an explicit YouTube downloader; allow-list YouTube hosts.
ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}

# Video: best video + best audio, merged into MP4 where the codecs permit a
# remux.  yt-dlp falls back to a single combined stream.
VIDEO_FORMAT = "bv*+ba/b"
# Audio: the best audio-only stream, downloaded as-is so the source codec and
# quality are preserved with no lossy transcode and no ffmpeg step.
AUDIO_FORMAT = "bestaudio"


def is_youtube_url(text: str) -> bool:
    try:
        parsed = urlparse(text.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host in ALLOWED_HOSTS or host.endswith(".youtube.com")


def tool_version_flag(name: str) -> bool:
    return shutil.which(name) is not None


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:filename>")
def static_files(filename: str):
    return send_from_directory(WEB, filename)


@app.get("/status")
def status():
    """Report whether the important runtime pieces are available."""
    return jsonify(
        {
            "yt_dlp": yt_dlp.version.__version__,
            "ffmpeg": tool_version_flag("ffmpeg"),
            "ffprobe": tool_version_flag("ffprobe"),
            # yt-dlp 2026.x defaults to Deno as its JavaScript runtime for
            # YouTube support; report it because it is recommended, not required.
            "deno": tool_version_flag("deno"),
        }
    )


@app.post("/download")
def download():
    """Download one URL (the raw request body) into downloads/.

    The mode is an explicit query parameter: ?mode=audio (best audio-only
    stream, preserved as-is) or ?mode=video (the existing best video+audio
    merge).  Absent mode defaults to video, matching the previous API.
    """
    url = (request.get_data(as_text=True) or "").strip()
    mode = (request.args.get("mode") or "video").strip().lower()

    if mode not in ("audio", "video"):
        return jsonify({"ok": False, "message": "Unknown download mode."})

    if not is_youtube_url(url):
        return jsonify(
            {"ok": False, "message": "Please paste a valid YouTube URL."}
        )

    ydl_opts = {
        "format": AUDIO_FORMAT if mode == "audio" else VIDEO_FORMAT,
        "outtmpl": str(DOWNLOADS / "%(title)s [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    if mode == "video":
        ydl_opts["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        path = None
        requested = info.get("requested_downloads") or []
        if requested:
            path = requested[0].get("filepath")
        if not path:
            path = ydl.prepare_filename(info)

        name = os.path.basename(path) if path else "download"
        return jsonify(
            {"ok": True, "message": f"Saved {mode}: {name}", "file": name}
        )

    except yt_dlp.utils.DownloadError as exc:
        # yt-dlp error text can be long; the page has a 200-byte display cap.
        return jsonify(
            {"ok": False, "message": f"{mode.capitalize()} download failed: {str(exc)[:120]}"}
        )
    except Exception as exc:  # pragma: no cover - defensive
        return jsonify({"ok": False, "message": f"{mode.capitalize()} error: {str(exc)[:120]}"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    # 127.0.0.1 only: never bound to the LAN.
    app.run(host="127.0.0.1", port=port, threaded=True)
