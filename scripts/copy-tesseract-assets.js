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
 * same-origin ('self'), which the CSP allows. The binary .wasm files are
 * fetched via XHR/fetch (not importScripts), so they benefit automatically from
 * same-origin access once the .js loader is self-hosted.
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
  { src: path.join(coreSrc, 'tesseract-core-simd-lstm.wasm.js'),      dest: 'tesseract-core-simd-lstm.wasm.js' },
  { src: path.join(coreSrc, 'tesseract-core-simd-lstm.wasm'),         dest: 'tesseract-core-simd-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-lstm.wasm.js'),           dest: 'tesseract-core-lstm.wasm.js' },
  { src: path.join(coreSrc, 'tesseract-core-lstm.wasm'),              dest: 'tesseract-core-lstm.wasm' },
  { src: path.join(coreSrc, 'tesseract-core-simd.wasm.js'),           dest: 'tesseract-core-simd.wasm.js' },
  { src: path.join(coreSrc, 'tesseract-core-simd.wasm'),              dest: 'tesseract-core-simd.wasm' },
  { src: path.join(coreSrc, 'tesseract-core.wasm.js'),                dest: 'tesseract-core.wasm.js' },
  { src: path.join(coreSrc, 'tesseract-core.wasm'),                   dest: 'tesseract-core.wasm' },
];

if (!fs.existsSync(workerSrc) || !fs.existsSync(coreSrc)) {
  console.warn('[copy-tesseract-assets] tesseract.js or tesseract.js-core not found — skipping.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const { src, dest } of FILES) {
  if (!fs.existsSync(src)) {
    console.warn('[copy-tesseract-assets] not found:', src);
    continue;
  }
  const destPath = path.join(destDir, dest);
  fs.copyFileSync(src, destPath);
  const kb = Math.round(fs.statSync(destPath).size / 1024);
  console.log(`[copy-tesseract-assets] ${dest}  (${kb} KB)`);
  copied++;
}

console.log(`[copy-tesseract-assets] done — ${copied}/${FILES.length} files copied to public/tesseract/`);
