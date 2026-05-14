/**
 * Copy the pdfjs-dist worker into public/ so it can be served as a static
 * asset by Cloudflare Pages. PrivacyScript is a static export — there is no
 * Node runtime to resolve node_modules at request time.
 */
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(
  __dirname,
  '..',
  'node_modules',
  'pdfjs-dist',
  'build',
  'pdf.worker.min.mjs'
);
const destDir = path.join(__dirname, '..', 'public');
const dest = path.join(destDir, 'pdf.worker.min.mjs');

if (!fs.existsSync(src)) {
  console.error('[copy-pdf-worker] source not found:', src);
  process.exit(0); // Don't fail install — user can run manually later.
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('[copy-pdf-worker] copied to', dest);
