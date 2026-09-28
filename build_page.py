#!/usr/bin/env python3
"""build_page.py -- bundle glon/*.glon into docs/index.html.

The .glon files stay the authoritative source.  This script inlines them into
docs/index.html as two separate <script type="application/glon"> blocks (common
first, then the app), exactly the shape the browser host loads in order.  The
source is NOT HTML-escaped: a <script> element's content is raw text, and the
browser's script.textContent must reach glon_load byte-for-byte.

docs/ is both the folder served locally by server.py and the folder published
as the static GitHub Pages site (branch master, folder /docs).

Run:  python3 build_page.py
"""

import pathlib

HERE = pathlib.Path(__file__).resolve().parent


def strip_comments(text: str) -> str:
    """Strip ``;;`` line comments (the Glon reader also does this at load)."""
    return "\n".join(line.split(";;", 1)[0] for line in text.splitlines())


def main() -> None:
    common = strip_comments((HERE / "glon" / "common.glon").read_text(encoding="utf-8"))
    app = strip_comments((HERE / "glon" / "app.glon").read_text(encoding="utf-8"))

    # common.glon is a top-level sequence; wrap it in one block so its masm/raw
    # forms parse in block context.  app.glon carries its own outer [ ... ].
    common_block = "[ " + common + " ]"

    for name, src in (("common", common_block), ("app", app)):
        if "</script" in src.lower():
            raise SystemExit(f"{name}: source contains '</script', cannot inline")

    page = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>Glon yt-dlp</title>\n"
        '<link rel="stylesheet" href="style.css">\n'
        "</head>\n"
        "<body>\n"
        '<div id="app" data-glon-id="1"></div>\n'
        f'<script type="application/glon" data-env="common">{common_block}</script>\n'
        f'<script type="application/glon" data-env="app">{app}</script>\n'
        '<script src="ytdl-host.js"></script>\n'
        "</body>\n"
        "</html>\n"
    )

    out = HERE / "docs" / "index.html"
    out.write_text(page, encoding="utf-8")
    print(
        f"wrote {out} "
        f"({len(common_block)} bytes common + {len(app)} bytes app)"
    )


if __name__ == "__main__":
    main()
