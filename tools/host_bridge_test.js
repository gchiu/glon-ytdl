/* tools/host_bridge_test.js -- async completion regression for the Glon host.
 *
 * Runs the REAL docs/ytdl-host.js against the REAL docs/glon.wasm with a tiny
 * DOM/fetch shim, so the browser's asynchronous path is exercised end to end:
 *   click -> Glon render -> [data-glon-request] -> fetch -> resp.json()
 *        -> glonEventValue("download-done", message) -> Glon re-render.
 *
 * This is the path tools/glon_smoke.py cannot cover (it calls the wasm bridge
 * directly and stubs the DOM), and is what a long, multibyte server message
 * (>200 UTF-8 bytes) used to break: the completion event was dropped.
 *
 * Developer-only, like wasmtime: requires Node (no npm packages). Run:
 *   node tools/host_bridge_test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = path.join(__dirname, "..");
const wasmBytes = fs.readFileSync(path.join(BASE, "docs", "glon.wasm"));
const indexHtml = fs.readFileSync(path.join(BASE, "docs", "index.html"), "utf8");
const blocks = [...indexHtml.matchAll(
  /<script type="application\/glon"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length !== 2) throw new Error("expected 2 glon blocks, got " + blocks.length);

/* ---- the long multibyte completion messages (the regression) ----------- */
const URL = "https://www.youtube.com/watch?v=GJU-ZURx_MA";
const PASTE_URL = "https://www.youtube.com/watch?v=pasted0001";
const MESSAGES = {
  audio:
    "Saved audio: 一首“差點被放棄，卻紅遍華語世界”的傳奇作品 " +
    "《明月千裡寄相思》｜聽完真的會想起一個人\ud83d\udc94 太催淚了｜經典老歌翻唱｜" +
    "微光LightCover [GJU-ZURx_MA].webm",
  video:
    "Saved video: 一首“差點被放棄，卻紅遍華語世界”的傳奇作品 " +
    "《明月千裡寄相思》｜聽完真的會想起一個人\ud83d\udc94 太催淚了｜經典老歌翻唱｜" +
    "微光LightCover [GJU-ZURx_MA].mp4",
};

/* ---- minimal DOM -------------------------------------------------------- */
let currentHtml = "";
const listeners = {};

const appEl = {
  get innerHTML() { return currentHtml; },
  set innerHTML(v) { currentHtml = v; },
};

function requestEl() {
  const m = currentHtml.match(
    /<span[^>]*data-glon-request='([^']*)'[^>]*data-glon-request-event='([^']*)'[^>]*>([\s\S]*?)<\/span>/);
  if (!m) return null;
  return {
    getAttribute(n) {
      if (n === "data-glon-request") return m[1];
      if (n === "data-glon-request-event") return m[2];
      return null;
    },
    get textContent() { return m[3]; },
  };
}

function inputEl() {
  const m = currentHtml.match(/<input[^>]*data-glon-input='download'[^>]*>/);
  if (!m) return null;
  const v = m[0].match(/value='([^']*)'/);
  return { value: v ? v[1] : "", getAttribute() { return null; }, hasAttribute() { return false; } };
}

const documentShim = {
  querySelector(sel) {
    if (sel.indexOf("[data-glon-id=") === 0) return appEl;
    if (sel === "[data-glon-request]") return requestEl();
    if (sel.indexOf("[data-glon-input=") === 0) return inputEl();
    return null;
  },
  querySelectorAll(sel) {
    if (sel === 'script[type="application/glon"]') return blocks.map((b) => ({ textContent: b }));
    return [];
  },
  addEventListener(type, fn) { listeners[type] = fn; },
};

/* ---- fetch shim: wasm bytes, /status, and the download completion ------- */
let downloadCalls = [];
function fetchShim(url) {
  const u = String(url);
  if (u.indexOf("glon.wasm") !== -1) {
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(wasmBytes) });
  }
  if (/\/status$/.test(u)) {
    return Promise.resolve({ json: () => Promise.resolve(
      { yt_dlp: "2026.08.19", ffmpeg: true, ffprobe: true, deno: false }) });
  }
  const mode = (u.match(/[?&]mode=(\w+)/) || [])[1] || "video";
  downloadCalls.push(mode);
  return new Promise((resolve) => setTimeout(() => resolve({
    json: () => Promise.resolve({ ok: true, message: MESSAGES[mode] }),
  }), 20));
}

/* ---- globals the host expects ------------------------------------------- */
global.window = global;
global.document = documentShim;
global.fetch = fetchShim;
global.URLSearchParams = URLSearchParams;
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
window.location = { search: "" };
window.YTDL_API = "http://127.0.0.1:8000";
try { WebAssembly.instantiateStreaming = undefined; } catch (e) { /* ignore */ }

/* ---- clipboard shim (a browser capability the host reads) -------------- */
const clipboard = { value: "", denied: false };
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      readText: function () {
        return clipboard.denied
          ? Promise.reject(new Error("denied"))
          : Promise.resolve(clipboard.value);
      },
    },
  },
});

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(" ")); origError(...a); };

vm.runInThisContext(fs.readFileSync(path.join(BASE, "docs", "ytdl-host.js"), "utf8"),
  { filename: "ytdl-host.js" });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function statusOf(html) {
  const m = html.match(/<div class='status'>([\s\S]*?)<\/div>/);
  return m ? m[1] : "";
}
function errorOf(html) {
  const m = html.match(/<div class='error'>([\s\S]*?)<\/div>/);
  return m ? m[1] : "";
}

function fireClick(el) {
  listeners.click({
    target: { closest: (s) => (s === "[data-glon-event]" ? el : null) },
    preventDefault() {},
  });
}

/* A clickable [data-glon-event] element with optional data-* attributes. */
function eventButton(event, attrs) {
  attrs = attrs || {};
  return {
    getAttribute(n) {
      if (n === "data-glon-event") return event;
      if (n === "data-glon-input") return attrs.input || null;
      if (n === "data-glon-value") return Object.prototype.hasOwnProperty.call(attrs, "value") ? attrs.value : null;
      if (n === "data-glon-event-error") return attrs.error || null;
      return null;
    },
    hasAttribute(n) {
      if (n === "data-glon-clipboard") return !!attrs.clipboard;
      if (n === "data-glon-value") return Object.prototype.hasOwnProperty.call(attrs, "value");
      return false;
    },
  };
}

const PASTE_BUTTON = { clipboard: true, error: "paste-failed" };

(async () => {
  await sleep(150); // boot: wasm load + init + first /status
  if (currentHtml.indexOf("Requesting") !== -1) throw new Error("unexpected pre-click state");
  if (inputEl().value !== "") throw new Error("expected an empty URL field at boot");

  // 2. empty field -> Paste fills it; 3. surrounding whitespace is trimmed.
  clipboard.value = "\n\t  " + PASTE_URL + "  \n";
  fireClick(eventButton("paste-url", PASTE_BUTTON));
  await sleep(50);
  if (inputEl().value !== PASTE_URL) {
    throw new Error("paste did not fill the empty field with trimmed text; got: " + JSON.stringify(inputEl().value));
  }
  if (downloadCalls.length !== 0) throw new Error("paste must not start a download");
  console.log("[paste] filled trimmed URL:", JSON.stringify(inputEl().value));

  // 1. existing URL present -> Paste replaces it completely.
  clipboard.value = "   " + URL + "\n";
  fireClick(eventButton("paste-url", PASTE_BUTTON));
  await sleep(50);
  if (inputEl().value !== URL) {
    throw new Error("paste did not replace the previous value; got: " + JSON.stringify(inputEl().value));
  }
  if (currentHtml.indexOf("value='" + PASTE_URL + "'") !== -1) {
    throw new Error("previous pasted value was not replaced");
  }
  if (downloadCalls.length !== 0) throw new Error("paste must not start a download");
  console.log("[paste] replaced with:", JSON.stringify(inputEl().value));

  // 5. clipboard failure leaves the previous URL intact and reports it.
  clipboard.denied = true;
  fireClick(eventButton("paste-url", PASTE_BUTTON));
  await sleep(50);
  if (inputEl().value !== URL) {
    throw new Error("clipboard failure changed the URL; got: " + JSON.stringify(inputEl().value));
  }
  if (errorOf(currentHtml).toLowerCase().indexOf("clipboard") === -1) {
    throw new Error("clipboard failure did not report a message; error=" + JSON.stringify(errorOf(currentHtml)));
  }
  clipboard.denied = false;
  console.log("[paste] failure kept URL and reported:", JSON.stringify(errorOf(currentHtml).slice(0, 60)));

  // 4+6. Download buttons still work; the pasted URL survives each rerender.
  for (const mode of ["audio", "video"]) {
    fireClick(eventButton("download-" + mode, { input: "download" }));

    const pending = statusOf(currentHtml);
    if (pending.indexOf("Requesting " + mode) !== 0) {
      throw new Error("expected 'Requesting " + mode + "...' after click, got: " + pending);
    }
    await sleep(200); // let the download fetch resolve and dispatch download-done

    const status = statusOf(currentHtml);
    console.log("[" + mode + "] status:", JSON.stringify(status.slice(0, 70)));
    if (status.indexOf("Saved " + mode) !== 0) {
      throw new Error(mode + " completion did not reach Glon; status=" + JSON.stringify(status));
    }
    if (currentHtml.indexOf("value='" + URL + "'") === -1) {
      throw new Error("URL was not retained after " + mode + " completion");
    }
    if (errors.length) throw new Error("host reported errors: " + errors.join(" | "));
  }

  console.log("download fetches:", JSON.stringify(downloadCalls));
  console.log("host errors:", errors.length ? errors : "none");
  if (downloadCalls.join(",") !== "audio,video") {
    throw new Error("unexpected download fetch sequence: " + downloadCalls.join(","));
  }

  console.log("HOST_BRIDGE_TEST PASS (paste fill/replace/trim/failure + audio+video async completion + URL retention)");
})().catch((e) => { console.error("HOST_BRIDGE_TEST FAIL: " + e.message); process.exit(1); });
