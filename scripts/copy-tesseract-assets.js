/**
 * Copy Tesseract.js worker and core WASM assets into public/tesseract/ so they
 * can be served as static assets from the same origin.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Tesseract.js v5 spins up a Web Worker and inside that worker it calls
 * importScripts(workerPath) and importScripts(corePath + '/tesseract-core-*.wasm.js').
 * Both importScripts() calls are governed by the browser's `script-src` CSP
 * directive. Because PrivacyScript uses a strict nonce-based CSP, any script
 * loaded from a CDN (https://cdn.jsdelivr.net) is blocked.
 *
 * Solution: self-host all Tesseract files so every importScripts() call is
 * same-origin ('self'), which the CSP allows.
 *
 * Files copied
 * ------------
 * From tesseract.js/dist/:
 *   worker.min.js           — the Tesseract Web Worker bootstrap
 *
 * From tesseract.js-core/:
 *   tesseract-core-simd-lstm.wasm.js   — importScripts target (SIMD+LSTM, preferred)
 *   tesseract-core-simd-lstm.wasm      — WASM binary fetched by above
 *   tesseract-core-lstm.wasm.js        — importScripts target (LSTM, no-SIMD fallback)
 *   tesseract-core-lstm.wasm           — WASM binary fetched by above
 *   tesseract-core-simd.wasm.js        — importScripts target (SIMD, no-LSTM fallback)
 *   tesseract-core-simd.wasm           — WASM binary
 *   tesseract-core.wasm.js             — importScripts target (baseline fallback)
 *   tesseract-core.wasm                — WASM binary
 *
 * All four core variants are copied so the worker can pick the right one
 * regardless of SIMD / LSTM support in the browser environment.
 *
 * Language training data (.traineddata) is fetched on first use and cached in
 * IndexedDB; it is read from cdn.jsdelivr.net (added to connect-src in
 * public/_headers). It is not copied here because it is >10 MB and not
 * available in the npm package.
 *
 * POST-COPY PATCHES (applied after each file is copied)
 * -----------------------------------------------------
 * The tesseract-core-*.wasm.js files are Emscripten SINGLE_FILE builds: they
 * have the WASM binary inlined as a base64 data URI and load it via fetch().
 * This breaks under our CSP in two independent ways:
 *
 *   1. connect-src must include data: (we have this, but…)
 *   2. COEP require-corp blocks fetch() of data: URIs because they have an
 *      opaque origin and cannot carry Cross-Origin-Resource-Policy headers.
 *
 * The clean fix: strip the base64 inline from Ka so the Emscripten loader
 * resolves the binary from a real same-origin URL instead.
 *
 * Emscripten's path-resolution logic (in the WASM loader) is:
 *
 *   if (!Ka.startsWith("data:application/octet-stream;base64,")) {
 *     Ka = b.locateFile ? b.locateFile(Ka, f) : f + Ka;
 *   }
 *
 * When running inside a blob: Worker, Emscripten sets f="" (it sees the
 * blob: prefix and resets the script-directory to empty). The Tesseract.js
 * worker does NOT pass locateFile in the module init options. So the fallback
 * f + Ka = "" + "<filename>.wasm" = "<filename>.wasm" (a relative URL).
 *
 * To make relative resolution work we also patch worker.min.js: right before
 * importScripts(h) we inject `self._scriptDir = h.replace(/[^\/]*$/, "");`.
 * Emscripten checks _scriptDir first and uses it as f, so f becomes the
 * full directory path of the .wasm.js file (e.g. /privacyscript/tesseract/).
 * That makes f + Ka resolve to the correct absolute same-origin .wasm URL.
 */

const fs   = require('node:fs');
const path = require('node:path');

const workerSrc  = path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'dist');
const coreSrc    = path.join(__dirname, '..', 'node_modules', 'tesseract.js-core');
const destDir    = path.join(__dirname, '..', 'public', 'tesseract');

const FILES = [
  // Worker bootstrap
  { src: path.join(workerSrc, 'worker.min.js'),                       dest: 'worker.min.js' },
  // Core WASM + JS loaders — all four variants
  { src: path.join(coreSrc, 'tesseract-core-simd-lstm.wasm.js'),      dest: 'tesseract-core-simd-lstm.wasm.js', wasmFile: 'tesseract-core-simd-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-simd-lstm.wasm'),         dest: 'tesseract-core-simd-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-lstm.wasm.js'),           dest: 'tesseract-core-lstm.wasm.js',      wasmFile: 'tesseract-core-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-lstm.wasm'),              dest: 'tesseract-core-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-simd.wasm.js'),           dest: 'tesseract-core-simd.wasm.js',      wasmFile: 'tesseract-core-simd.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-simd.wasm'),              dest: 'tesseract-core-simd.wasm' },
  { src: path.join(coreSrc, 'tesseract-core.wasm.js'),                dest: 'tesseract-core.wasm.js',           wasmFile: 'tesseract-core.wasm' },
  { src: path.join(coreSrc, 'tesseract-core.wasm'),                   dest: 'tesseract-core.wasm' },
];

if (!fs.existsSync(workerSrc) || !fs.existsSync(coreSrc)) {
  console.warn('[copy-tesseract-assets] tesseract.js or tesseract.js-core not found — skipping.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

let copied = 0;
let patched = 0;
for (const { src, dest, wasmFile } of FILES) {
  if (!fs.existsSync(src)) {
    console.warn('[copy-tesseract-assets] not found:', src);
    continue;
  }
  const destPath = path.join(destDir, dest);
  fs.copyFileSync(src, destPath);
  const kb = Math.round(fs.statSync(destPath).size / 1024);
  console.log(`[copy-tesseract-assets] ${dest}  (${kb} KB)`);
  copied++;

  // ── Patch 1: strip the inlined WASM data URI from core loader files ────────
  // Each tesseract-core-*.wasm.js has the WASM binary inlined as a base64 data
  // URI in the variable Ka. We replace it with just the filename so the
  // Emscripten loader resolves it as a real URL (f + Ka) rather than fetching
  // a data: URI that COEP blocks.
  if (wasmFile) {
    let content = fs.readFileSync(destPath, 'utf8');
    const before = content.length;
    // SIMD+LSTM and LSTM variants store the binary in Ka;
    // SIMD-only and baseline variants store it in La.
    // Try Ka first, then La.
    let patchedVar = null;
    for (const varName of ['Ka', 'La']) {
      const re = new RegExp(`${varName}\\s*=\\s*"data:application\\/octet-stream;base64,[A-Za-z0-9+/=]+"`);
      if (re.test(content)) {
        content = content.replace(re, `${varName}="${wasmFile}"`);
        patchedVar = varName;
        break;
      }
    }
    if (patchedVar) {
      fs.writeFileSync(destPath, content, 'utf8');
      const kbAfter = Math.round(fs.statSync(destPath).size / 1024);
      console.log(`[copy-tesseract-assets]   patched ${patchedVar} → "${wasmFile}"  (${kbAfter} KB after strip)`);
      patched++;
    } else {
      console.warn(`[copy-tesseract-assets]   WARNING: Ka/La data-URI pattern not found in ${dest} — patch skipped`);
    }
  }

  // ── Patch 2: inject _scriptDir into worker.min.js before importScripts ─────
  // Emscripten reads self._scriptDir (if set) to determine the base directory
  // for resolving the .wasm binary. In a blob: Worker the normal detection sets
  // f="" (empty), so we must set _scriptDir to the core file's directory just
  // before importScripts(h) runs, giving Emscripten the right base path.
  if (dest === 'worker.min.js') {
    let content = fs.readFileSync(destPath, 'utf8');
    const needle = 'r.g.importScripts(h),void 0!==r.g.TesseractCore';
    const replacement = 'r.g._scriptDir=h.replace(/[^/]*$/,"");r.g.importScripts(h),void 0!==r.g.TesseractCore';
    if (content.includes(needle)) {
      content = content.replace(needle, replacement);
      fs.writeFileSync(destPath, content, 'utf8');
      console.log('[copy-tesseract-assets]   patched worker.min.js → injected _scriptDir before importScripts');
      patched++;
    } else {
      console.warn('[copy-tesseract-assets]   WARNING: importScripts needle not found in worker.min.js — patch skipped');
    }
  }
}

console.log(`[copy-tesseract-assets] done — ${copied}/${FILES.length} files copied, ${patched} patched (public/tesseract/)`);
