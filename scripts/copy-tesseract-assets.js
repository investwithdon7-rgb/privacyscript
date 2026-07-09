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
 * Language training data (eng.traineddata.gz) is vendored in
 * assets/tesseract-lang/ (committed — it is not part of any npm package) and
 * copied to public/tesseract/lang/ by this script. Self-hosting it keeps the
 * strict CSP intact and honours the zero-external-calls guarantee; letting
 * tesseract.js fall back to its CDN default made OCR hang forever wherever
 * the CDN is unreachable or blocked by CSP.
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
 *      with a JS expression that constructs the absolute WASM URL at runtime.
 *
 * WHY A STRING LITERAL IS NOT ENOUGH
 * -----------------------------------
 * Emscripten's path-resolution code (runs inside the importScripts'd .wasm.js):
 *
 *   if (!Ka.startsWith("data:application/octet-stream;base64,")) {
 *     Ka = b.locateFile ? b.locateFile(Ka, f) : f + Ka;
 *   }
 *
 * Inside a blob: Worker, Emscripten detects self.location.href = "blob:..." and
 * resets scriptDirectory f = "". Tesseract.js does not pass locateFile.
 * So: Ka = "" + Ka = Ka (unchanged).
 *
 * If Ka is a root-relative string "/privacyscript/tesseract/filename.wasm",
 * fetch(Ka) then fails with "Failed to parse URL from /privacyscript/..." because
 * fetch() in a blob Worker cannot resolve root-relative paths — the Worker's base
 * URL is the blob: URL itself, which has an opaque origin, and the URL parser
 * cannot map "/" → page-origin inside that context.
 *
 * SOLUTION: runtime expression using self.location.href
 * ------------------------------------------------------
 * We patch Ka/La to a JS expression that runs when the Emscripten IIFE executes:
 *
 *   Ka = new URL("/privacyscript/tesseract/filename.wasm",
 *               new URL(self.location.href).origin).href
 *
 * In a blob Worker, new URL("blob:https://host/uuid").origin = "https://host".
 * So the expression evaluates to "https://host/privacyscript/tesseract/filename.wasm"
 * — a fully absolute URL that fetch() can always resolve, regardless of context.
 *
 * The expression is still <= 150 bytes; files shrink from ~3.8–4.6 MB to ~122 KB.
 * The approach is origin-agnostic: it works on tekdruid.com, pages.dev, localhost.
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

  // ── Patch: replace inline WASM data URI with a runtime absolute-URL expression ─
  // SIMD+LSTM / LSTM variants use Ka for the binary; SIMD / baseline use La.
  //
  // We replace:
  //   Ka="data:application/octet-stream;base64,<4 MB>"
  // with:
  //   Ka=new URL("/privacyscript/tesseract/filename.wasm",new URL(self.location.href).origin).href
  //
  // The expression is evaluated when the Emscripten IIFE runs inside the blob
  // Worker. new URL(self.location.href).origin extracts the page origin from the
  // blob: URL at runtime, so the result is a fully absolute, same-origin URL that
  // fetch() can resolve from any Worker context. See the header comment for details.
  if (wasmFile) {
    const wasmPath = `${basePath}/tesseract/${wasmFile}`;
    // Build the replacement expression. JSON.stringify adds the required quotes
    // around the path string inside the new URL() call.
    const expr = `new URL(${JSON.stringify(wasmPath)},new URL(self.location.href).origin).href`;
    let content = fs.readFileSync(destPath, 'utf8');
    let patchedVar = null;
    for (const varName of ['Ka', 'La']) {
      const re = new RegExp(
        `${varName}\\s*=\\s*"data:application\\/octet-stream;base64,[A-Za-z0-9+/=]+"`
      );
      if (re.test(content)) {
        content = content.replace(re, `${varName}=${expr}`);
        patchedVar = varName;
        break;
      }
    }
    if (patchedVar) {
      fs.writeFileSync(destPath, content, 'utf8');
      const kbAfter = Math.round(fs.statSync(destPath).size / 1024);
      console.log(`[copy-tesseract-assets]   patched ${patchedVar} → runtime URL expr for "${wasmPath}"  (${kbAfter} KB after strip)`);
      patched++;
    } else {
      console.warn(`[copy-tesseract-assets]   WARNING: Ka/La data-URI not found in ${dest} — patch skipped`);
    }
  }
}

// ── Language data: vendored in assets/tesseract-lang/, served from
//    public/tesseract/lang/. See header comment.
const langSrcDir = path.join(__dirname, '..', 'assets', 'tesseract-lang');
const langDestDir = path.join(destDir, 'lang');
if (fs.existsSync(langSrcDir)) {
  fs.mkdirSync(langDestDir, { recursive: true });
  for (const f of fs.readdirSync(langSrcDir)) {
    const src = path.join(langSrcDir, f);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(langDestDir, f));
    const mb = (fs.statSync(src).size / 1_048_576).toFixed(1);
    console.log(`[copy-tesseract-assets] lang/${f}  (${mb} MB)`);
    copied++;
  }
} else {
  console.warn(
    '[copy-tesseract-assets] WARNING: assets/tesseract-lang/ missing — OCR language data will not be served and scanned-PDF OCR will fail.'
  );
}

console.log(`[copy-tesseract-assets] done — ${copied} files copied, ${patched} patched (public/tesseract/)`);
console.log(`[copy-tesseract-assets] basePath="${basePath}" (override with NEXT_PUBLIC_BASE_PATH)`);
