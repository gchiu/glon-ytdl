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

const renders = [];
const appEl = {
  get innerHTML() { return currentHtml; },
  set innerHTML(v) { currentHtml = v; renders.push(v); },
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

/* ---- fetch shim: wasm bytes, /status, /progress, and /download ---------- */
let downloadCalls = [];
let progressCalls = 0;
let progressSeq = [];
let downloadDelayMs = 20;
let downloadFail = false;

function fetchShim(url) {
  const u = String(url);
  if (u.indexOf("glon.wasm") !== -1) {
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(wasmBytes) });
  }
  if (/\/status$/.test(u)) {
    return Promise.resolve({ json: () => Promise.resolve(
      { yt_dlp: "2026.08.19", ffmpeg: true, ffprobe: true, deno: false }) });
  }
  if (/\/progress$/.test(u)) {
    const snapshot = progressSeq.length
      ? progressSeq[Math.min(progressCalls, progressSeq.length - 1)]
      : {};
    progressCalls++;
    return Promise.resolve({ json: () => Promise.resolve(snapshot) });
  }
  const mode = (u.match(/[?&]mode=(\w+)/) || [])[1] || "video";
  downloadCalls.push(mode);
  return new Promise((resolve) => setTimeout(() => resolve({
    json: () => Promise.resolve(downloadFail
      ? { ok: false, message: mode + " download failed: boom" }
      : { ok: true, message: MESSAGES[mode] }),
  }), downloadDelayMs));
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
async function waitFor(pred, timeout) {
  const end = Date.now() + (timeout || 5000);
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
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

  // 4+6. Download buttons still work; the pasted URL survives each rerender;
  // progress and postprocessing phases are delivered while the request runs.
  const progressPhase = { audio: "Converting to MP3...", video: "Merging audio and video..." };
  const progressLine = {
    audio: "Downloading audio... 37%",
    video: "Downloading video... 37%",
  };
  for (const mode of ["audio", "video"]) {
    renders.length = 0;
    progressCalls = 0;
    downloadDelayMs = 3200;
    progressSeq = [
      { active: true, mode: mode, state: "downloading", percent: 37,
        downloaded_bytes: 432013312, total_bytes: 1181116006,
        speed: 19300000, eta: 2537 },
      { active: true, mode: mode, state: "downloading",
        downloaded_bytes: 12345678, total_bytes: null, speed: null, eta: null },
      { active: true, mode: mode, state: "postprocessing", percent: 100,
        phase: progressPhase[mode] },
    ];

    fireClick(eventButton("download-" + mode, { input: "download" }));

    const pending = statusOf(currentHtml);
    if (pending.indexOf("Requesting " + mode) !== 0) {
      throw new Error("expected 'Requesting " + mode + "...' after click, got: " + pending);
    }

    const done = await waitFor(
      () => statusOf(currentHtml).indexOf("Saved " + mode) === 0, 8000);
    if (!done) {
      throw new Error(mode + " completion did not reach Glon; status=" + JSON.stringify(statusOf(currentHtml)));
    }

    const sawPercent = renders.some(
      (h) => statusOf(h).indexOf(progressLine[mode]) === 0 && h.indexOf("412 MB / 1.1 GB") !== -1);
    if (!sawPercent) {
      throw new Error(mode + " percent/bytes progress never rendered; got " +
        JSON.stringify(renders.map(statusOf).filter(Boolean).slice(-6)));
    }
    const sawUnknown = renders.some((h) => {
      const s = statusOf(h);
      return s.indexOf("Downloading " + mode + "...") === 0
        && s.indexOf(" / ") === -1;
    });
    if (!sawUnknown) {
      throw new Error(mode + " unknown-total progress did not render");
    }
    if (renders.some((h) => /NaN|undefined/.test(statusOf(h)))) {
      throw new Error(mode + " progress produced NaN/undefined");
    }
    if (!renders.some((h) => statusOf(h).indexOf(progressPhase[mode]) === 0)) {
      throw new Error(mode + " postprocessing phase never rendered");
    }
    if (currentHtml.indexOf("value='" + URL + "'") === -1) {
      throw new Error("URL was not retained after " + mode + " completion");
    }
    if (errors.length) throw new Error("host reported errors: " + errors.join(" | "));

    // 6. Polling stops on success.
    const callsAtFinish = progressCalls;
    await sleep(1300);
    if (progressCalls !== callsAtFinish) {
      throw new Error("progress polling continued after " + mode + " finished");
    }
    console.log("[" + mode + "] progress+phase delivered; polling stopped (" + progressCalls + " polls)");
  }

  // 7. Polling stops on failure, and the failure message reaches Glon.
  downloadFail = true;
  downloadDelayMs = 1200;
  renders.length = 0;
  progressCalls = 0;
  progressSeq = [{ active: true, mode: "video", state: "downloading", percent: 10,
    downloaded_bytes: 1000, total_bytes: 10000, speed: 500, eta: 18 }];
  fireClick(eventButton("download-video", { input: "download" }));
  const failed = await waitFor(
    () => statusOf(currentHtml).indexOf("download failed") !== -1, 4000);
  if (!failed) {
    throw new Error("failure message did not reach Glon; status=" + JSON.stringify(statusOf(currentHtml)));
  }
  const callsAtFail = progressCalls;
  await sleep(1300);
  if (progressCalls !== callsAtFail) {
    throw new Error("progress polling continued after a failed download");
  }
  console.log("[failure] polling stopped (" + progressCalls + " polls); status:",
    JSON.stringify(statusOf(currentHtml).slice(0, 60)));
  downloadFail = false;

  console.log("download fetches:", JSON.stringify(downloadCalls));
  console.log("host errors:", errors.length ? errors : "none");
  if (downloadCalls.join(",") !== "audio,video,video") {
    throw new Error("unexpected download fetch sequence: " + downloadCalls.join(","));
  }

  console.log("HOST_BRIDGE_TEST PASS (paste + progress/phase/poll-stop + audio+video completion + URL retention)");
})().catch((e) => { console.error("HOST_BRIDGE_TEST FAIL: " + e.message); process.exit(1); });
