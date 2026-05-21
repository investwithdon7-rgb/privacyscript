/**
 * Copy onnxruntime-web WASM binaries into public/wasm/ so they are served as
 * static assets by Cloudflare Pages.
 *
 * PrivacyScript is a fully static Next.js export — node_modules is not
 * available at request time. @xenova/transformers (Transformers.js) relies on
 * onnxruntime-web, which must fetch its WASM binaries from a known URL.
 * env.backends.onnx.wasm.wasmPaths is set in ner.ts to point here.
 *
 * Threading is disabled (numThreads=1 in ner.ts), so only the two
 * non-threaded variants are needed:
 *   ort-wasm.wasm          — fallback (no SIMD)
 *   ort-wasm-simd.wasm     — preferred (SIMD, ~10 % faster)
 */
const fs   = require('node:fs');
const path = require('node:path');

const srcDir  = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const destDir = path.join(__dirname, '..', 'public', 'wasm');

const FILES = [
  'ort-wasm.wasm',
  'ort-wasm-simd.wasm',
];

if (!fs.existsSync(srcDir)) {
  console.warn('[copy-ort-wasm] onnxruntime-web not found — skipping.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src  = path.join(srcDir, f);
  const dest = path.join(destDir, f);
  if (!fs.existsSync(src)) {
    console.warn('[copy-ort-wasm] not found:', src);
    continue;
  }
  fs.copyFileSync(src, dest);
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`[copy-ort-wasm] ${f}  (${kb} KB)`);
  copied++;
}

console.log(`[copy-ort-wasm] done — ${copied}/${FILES.length} files copied to public/wasm/`);
