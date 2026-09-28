/* docs/ytdl-host.js -- the handwritten browser half of the Glon boundary.
 *
 * JavaScript responsibilities are limited to browser capabilities Glon cannot
 * perform directly:
 *
 *   - instantiate glon.wasm and supply the host imports;
 *   - load each <script type="application/glon"> block into the machine;
 *   - write rendered HTML into [data-glon-id="<handle>"];
 *   - forward clicks on [data-glon-event] to glon_event / glon_event_value;
 *   - perform a rendered [data-glon-request] marker as a request to the
 *     explicit local API origin and deliver the reply as an event;
 *   - fetch <api>/status once at boot and deliver it as readiness.
 *
 * The API origin is explicit (never assumed same-origin), because the page is
 * usually served from GitHub Pages.  It defaults to http://127.0.0.1:8000 and
 * can be overridden with ?api=<origin> or window.YTDL_API, mirroring Live
 * Translate's ?relay=wss://localhost:8000/audio convention.
 *
 * No URL parsing, status meaning, or download policy lives here.  Glon decides
 * WHAT to request and what the result means; this file only carries bytes.
 */
(function () {
  "use strict";

  var DEFAULT_API = "http://127.0.0.1:8000";
  var OFFLINE_MESSAGE =
    "Local downloader is not running.\n" +
    "Start it with:\n" +
    ".venv/bin/python server.py";

  function apiBase() {
    var override = window.YTDL_API;
    if (!override && window.location && window.location.search) {
      override = new URLSearchParams(window.location.search).get("api");
    }
    return String(override || DEFAULT_API).replace(/\/+$/, "");
  }

  var API = apiBase();

  function apiUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return API + path;
  }

  var ex = null;
  var dec = new TextDecoder();
  var enc = new TextEncoder();
  var requestActive = false;

  function view() {
    return new Uint8Array(ex.memory.buffer);
  }

  var imports = {
    env: {
      host_print: function (ptr, len) {
        console.log("[glon]", dec.decode(view().subarray(ptr, ptr + len)));
      },
      host_set_text: function (handle, value) {
        var el = document.querySelector('[data-glon-id="' + handle + '"]');
        if (el) el.textContent = String(value);
      },
      host_set_html: function (handle, ptr, len) {
        var el = document.querySelector('[data-glon-id="' + handle + '"]');
        if (el) el.innerHTML = dec.decode(view().subarray(ptr, ptr + len));
        scanRequests();
      },
      host_canvas_script: function () { /* no canvas on this page */ }
    }
  };

  /* copy a JS string into WASM memory; returns [ptr, byteLength] */
  function alloc(str) {
    var bytes = enc.encode(str);
    var p = ex.glon_alloc(bytes.length);
    view().set(bytes, p);
    return [p, bytes.length];
  }

  function glonEvent(token) {
    if (typeof ex.glon_event !== "function") return;
    var pair = alloc(token);
    var rc = ex.glon_event(pair[0], pair[1]);
    if (rc !== 0) console.error("ytdl-host.js: glon_event('" + token + "') rc=" + rc);
  }

  /* glon_event_value accepts at most 200 BYTES.  String#slice counts UTF-16
   * code units, so a multibyte message (CJK filenames, emoji) could pass a
   * 200-"char" cut as far more than 200 bytes and be rejected by the import
   * (rc=-1), silently dropping the completion event.  Truncate on a real
   * UTF-8 boundary instead: encode, cut to the byte budget, back up over any
   * split continuation byte, then decode. */
  var EVENT_VALUE_MAX_BYTES = 200;

  function clampEventUtf8(value) {
    var str = String(value == null ? "" : value);
    var bytes = enc.encode(str);
    if (bytes.length <= EVENT_VALUE_MAX_BYTES) return str;
    var end = EVENT_VALUE_MAX_BYTES;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return dec.decode(bytes.subarray(0, end));
  }

  function glonEventValue(token, value) {
    if (typeof ex.glon_event_value !== "function") return;
    var t = alloc(token);
    var v = alloc(clampEventUtf8(value));
    var rc = ex.glon_event_value(t[0], t[1], v[0], v[1]);
    if (rc !== 0) console.error("ytdl-host.js: glon_event_value('" + token + "') rc=" + rc);
  }

  /* A rendered [data-glon-request] marker names a same-origin path and the
   * event that should receive the reply.  The element's text is the request
   * body (for /download, the URL).  This is the one generic outbound
   * capability: JS moves bytes, Glon decides what they mean. */
  function scanRequests() {
    if (requestActive) return;
    var el = document.querySelector("[data-glon-request]");
    if (!el) return;

    requestActive = true;
    var path = el.getAttribute("data-glon-request");
    var event = el.getAttribute("data-glon-request-event") || "request-done";
    var body = (el.textContent || "").trim();

    fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: body
    })
      .then(function (resp) {
        return resp.json().catch(function () {
          return { message: "HTTP " + resp.status };
        });
      })
      .then(function (data) {
        requestActive = false;
        var message = data && data.message ? data.message : "Done";
        glonEventValue(event, message);
      })
      .catch(function () {
        requestActive = false;
        glonEventValue(event, OFFLINE_MESSAGE);
      });
  }

  function checkStatus() {
    fetch(API + "/status")
      .then(function (resp) { return resp.json(); })
      .then(function (s) {
        var parts = [
          s.yt_dlp ? "yt-dlp " + s.yt_dlp : "yt-dlp missing",
          s.ffmpeg ? "ffmpeg" : "ffmpeg MISSING",
          s.ffprobe ? "ffprobe" : "ffprobe MISSING",
          s.deno ? "deno" : "deno absent (optional)"
        ];
        glonEventValue("readiness", parts.join("  |  "));
      })
      .catch(function () { glonEventValue("ready-failed", OFFLINE_MESSAGE); });
  }

  function boot() {
    if (ex.glon_init() !== 0) {
      console.error("ytdl-host.js: glon_init failed");
      return;
    }

    var blocks = document.querySelectorAll('script[type="application/glon"]');
    for (var i = 0; i < blocks.length; i++) {
      var pair = alloc(blocks[i].textContent);
      if (ex.glon_load(pair[0], pair[1]) !== 0) {
        console.error("ytdl-host.js: glon_load failed for block " + i);
        return;
      }
    }

    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-glon-event]") : null;
      if (!el) return;
      e.preventDefault();
      var token = el.getAttribute("data-glon-event");
      var value = null;
      if (el.hasAttribute("data-glon-value")) {
        value = el.getAttribute("data-glon-value");
      } else {
        /* An event element may name the input it reads from with
         * data-glon-input; otherwise the event token names it. */
        var inputName = el.getAttribute("data-glon-input") || token;
        var input = document.querySelector('[data-glon-input="' + inputName + '"]');
        if (input && input.value !== undefined) value = input.value;
      }
      if (value !== null) glonEventValue(token, value);
      else glonEvent(token);
    });

    glonEvent("init");
    checkStatus();
  }

  function ready(result) { ex = result.instance.exports; boot(); }
  function fail(err) { console.error("ytdl-host.js: failed to load glon.wasm", err); }
  function loadBytes(bytes) { WebAssembly.instantiate(bytes, imports).then(ready).catch(fail); }

  if (typeof WebAssembly.instantiateStreaming === "function" && window.fetch) {
    WebAssembly.instantiateStreaming(fetch("glon.wasm"), imports)
      .then(ready)
      .catch(function () {
        fetch("glon.wasm").then(function (r) { return r.arrayBuffer(); }).then(loadBytes).catch(fail);
      });
  } else if (window.fetch) {
    fetch("glon.wasm").then(function (r) { return r.arrayBuffer(); }).then(loadBytes).catch(fail);
  } else {
    fail(new Error("no fetch / WebAssembly support"));
  }
})();
