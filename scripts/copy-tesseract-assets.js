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
 * POST-COPY PATCH: strip the inlined WASM data URI
 * -------------------------------------------------
 * The tesseract-core-*.wasm.js files are Emscripten SINGLE_FILE builds.
 * They inline the entire WASM binary (~2.8–3.4 MB) as a base64 data URI and
 * fetch it at runtime. This fails in two independent ways:
 *
 *   1. connect-src must allow data: (we do allow it, but…)
 *   2. COEP require-corp blocks fetch() of data: URIs: they have opaque
 *      origins and cannot carry Cross-Origin-Resource-Policy headers.
 *
 * Fix: replace Ka/La = "data:application/octet-stream;base64,<4MB>"
 *      with  Ka/La = "<basePath>/tesseract/<filename>.wasm"
 *
 * Emscripten's path-resolution code is:
 *
 *   if (!Ka.startsWith("data:application/octet-stream;base64,")) {
 *     Ka = b.locateFile ? b.locateFile(Ka, f) : f + Ka;
 *   }
 *
 * Inside a blob: Worker, _scriptDir is a LOCAL closure var (set by the IIFE
 * that wraps the module at importScripts load time). At that moment document
 * is undefined and __filename doesn't exist in a browser Worker, so _scriptDir
 * stays undefined. Emscripten then falls back to self.location.href (the blob:
 * URL), sees the "blob:" prefix, and resets f = "". Tesseract.js does not pass
 * locateFile. So the resolution is: Ka = "" + Ka = Ka (unchanged).
 *
 * Solution: set Ka/La to the FULL absolute root-relative path at patch time:
 *   Ka = "/privacyscript/tesseract/tesseract-core-simd-lstm.wasm"
 *
 * f + Ka = "" + "/privacyscript/tesseract/filename.wasm"
 *        = "/privacyscript/tesseract/filename.wasm"   ← root-relative, valid URL
 *
 * Chrome resolves root-relative URLs against the document origin in blob Workers,
 * so fetch("/privacyscript/tesseract/filename.wasm") resolves to the correct
 * same-origin URL. Files shrink from ~3.8–4.6 MB to ~122 KB after stripping.
 *
 * BASEPATH: read from NEXT_PUBLIC_BASE_PATH env var (defaults to /privacyscript,
 * matching next.config.js).
 */

const fs       = require('node:fs');
const path     = require('node:path');

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/privacyscript';

const workerSrc  = path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'dist');
const coreSrc    = path.join(__dirname, '..', 'node_modules', 'tesseract.js-core');
const destDir    = path.join(__dirname, '..', 'public', 'tesseract');

const FILES = [
  // Worker bootstrap — no patch needed
  { src: path.join(workerSrc, 'worker.min.js'),                       dest: 'worker.min.js' },
  // Core WASM + JS loaders — all four variants (wasmFile triggers the patch)
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

  // ── Patch: replace inline WASM data URI with absolute root-relative path ───
  // SIMD+LSTM / LSTM variants use Ka for the binary; SIMD / baseline use La.
  // We replace the entire base64 blob with the absolute URL to the .wasm file.
  if (wasmFile) {
    const absoluteWasmPath = `${basePath}/tesseract/${wasmFile}`;
    let content = fs.readFileSync(destPath, 'utf8');
    let patchedVar = null;
    for (const varName of ['Ka', 'La']) {
      const re = new RegExp(
        `${varName}\\s*=\\s*"data:application\\/octet-stream;base64,[A-Za-z0-9+/=]+"`
      );
      if (re.test(content)) {
        content = content.replace(re, `${varName}="${absoluteWasmPath}"`);
        patchedVar = varName;
        break;
      }
    }
    if (patchedVar) {
      fs.writeFileSync(destPath, content, 'utf8');
      const kbAfter = Math.round(fs.statSync(destPath).size / 1024);
      console.log(`[copy-tesseract-assets]   patched ${patchedVar} → "${absoluteWasmPath}"  (${kbAfter} KB after strip)`);
      patched++;
    } else {
      console.warn(`[copy-tesseract-assets]   WARNING: Ka/La data-URI not found in ${dest} — patch skipped`);
    }
  }
}

console.log(`[copy-tesseract-assets] done — ${copied}/${FILES.length} files copied, ${patched} patched (public/tesseract/)`);
console.log(`[copy-tesseract-assets] basePath="${basePath}" (override with NEXT_PUBLIC_BASE_PATH)`);
