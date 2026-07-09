/**
 * Leak harness: runs the regex detection + replacement + validation pipeline
 * against the synthetic records in "PH records" and reports any original
 * identifier that survives into the output. Regex-only (no NER in Node), so
 * it is the worst-case floor for the engine.
 *
 * Usage: node scripts/leak-harness.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { register } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Use tsx if available, else esbuild-register — simplest: import the compiled
// engine via vitest is overkill; instead use esbuild to bundle on the fly.
const require = createRequire(import.meta.url);
const esbuild = require(path.join(root, 'node_modules/esbuild'));

// Bundle the engine entry points to a temp CJS file and require it.
const outfile = path.join(root, '.leak-harness.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'scripts/leak-harness-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['@xenova/transformers'],
  alias: { '@': path.join(root, 'src') },
  loader: { '.json': 'json' },
});

const { runLeakCheck } = require(outfile);

// Extract text from the typed PDF the same way the app does (pdf.js).
const pdfjs = await import('file://' + path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
async function pdfText(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(' '));
  }
  return pages.join('\n');
}

const mammoth = require(path.join(root, 'node_modules/mammoth'));

const dir = path.join(root, 'PH records');
const inputs = [
  {
    name: 'discharge_summary.pdf',
    text: await pdfText(path.join(dir, 'discharge_summary.pdf')),
    groundTruth: ['Eveline', 'Achterberg', 'Pieter', 'Holloway', 'Priya', 'Iyer', 'Bernadette', 'Aikens',
      'Cartwright', 'Karoline', 'Stenberg', 'Rehman', '943 476 5919', '7724831', '07700 900145',
      '07700 900146', 'eveline.achterberg', 'priya.iyer', 'faisal.rehman', 'Linden Court', 'M14 5TQ',
      'Withington', 'M16 8GB', '6184472', '7283904', 'NWGH-DSC-2024-118429', 'WHR-CR-2024-0331'],
  },
  {
    name: 'consultant_letter.docx',
    text: (await mammoth.extractRawText({ path: path.join(dir, 'consultant_letter.docx') })).value,
    groundTruth: ['Yusuf', 'al-Hashimi', 'Asma', 'Layla', 'Carmichael', 'Beatrice Lin', 'Korhonen',
      'Bramwell', 'Hövding', 'Maureen', 'Pollock', 'Roussakov', 'Mackintosh', '103 887 5520',
      'VMH-RM-882104', '25 June 1972', 'BS8 1QU', 'BS4 3JR', 'BS6 7EJ', '07700 900557', '0117 555',
      'layla.alhashimi', 'maureen.pollock', 'ingrid.hovding', '5827392', 'VMH-RESP-2024-OUT-04127',
      '23 Edenfield Road', '288 Pilton Causeway'],
  },
];

let anyLeak = false;
for (const { name, text, groundTruth } of inputs) {
  const res = await runLeakCheck(text);
  console.log(`\n===== ${name} =====`);
  console.log(`spans: ${res.spanCount}, replacements: ${res.replacementCount}`);
  console.log(`validation passed: ${res.passed}`);
  if (res.originalsLeaked.length) {
    anyLeak = true;
    console.log('LEAKED ORIGINALS (validator):');
    for (const o of res.originalsLeaked) console.log('  -', JSON.stringify(o));
  }
  const gtLeaks = groundTruth.filter((v) => res.outputText.includes(v));
  if (gtLeaks.length) {
    anyLeak = true;
    console.log('GROUND-TRUTH LEAKS (known identifiers still in output):');
    for (const v of gtLeaks) {
      const i = res.outputText.indexOf(v);
      console.log('  -', JSON.stringify(v), '…', JSON.stringify(res.outputText.slice(Math.max(0, i - 45), i + v.length + 25)));
    }
  }
}
console.log(anyLeak ? '\nRESULT: LEAKS FOUND' : '\nRESULT: CLEAN');
fs.rmSync(outfile, { force: true });
