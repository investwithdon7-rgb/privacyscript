#!/usr/bin/env node
/**
 * Build the rare-disease ICD-10 catalogue from Orphadata.
 *
 * Sources (CC BY 4.0, INSERM US14 / Orphanet):
 *   - https://sciences.orphadata.com/alignments/  (ORPHA <-> ICD-10 mapping)
 *   - https://sciences.orphadata.com/epidemiology/ (prevalence per disease)
 *
 * Process:
 *   1. Download both JSON releases.
 *   2. Build a Map: orphaCode -> { icd10: string[], prevalence: number | null }.
 *      Prevalence is normalised to "cases per million" so a single threshold
 *      compares cleanly across the dataset.
 *   3. Filter to codes with prevalence <= 100 cases / million (i.e. 1:10,000
 *      or rarer). This is the "flag for review" threshold.
 *   4. Tag codes with prevalence <= 10 / million (1:100,000) as 'auto-suppress'.
 *   5. Emit src/lib/rare-icd10.json with shape:
 *      { generatedAt, sourceVersion, threshold, codes: { [code3]: tier } }
 *      where tier ∈ 'flag' | 'auto'.
 *
 * Usage:
 *   node scripts/build-rare-icd.js                  # use cached download
 *   node scripts/build-rare-icd.js --refresh        # re-download from Orphadata
 *
 * The script writes/reads cached raw downloads at:
 *   .cache/orphadata-alignments.json
 *   .cache/orphadata-epidemiology.json
 *
 * Run this in CI or manually before a release. The runtime never touches the
 * network — it imports the static JSON only.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_PATH = path.join(ROOT, 'src', 'lib', 'rare-icd10.json');

const ALIGNMENTS_URL =
  'https://www.orphadata.com/data/xml/en_product1.xml'; // alignments incl. ICD-10
const EPIDEMIOLOGY_URL =
  'https://www.orphadata.com/data/xml/en_product9_prev.xml'; // prevalence

// Thresholds (cases per million population).
const FLAG_THRESHOLD = 100;   // <= 1:10,000 → flag for user review
const AUTO_THRESHOLD = 10;    // <= 1:100,000 → recommend auto-suppress

const PREVALENCE_CLASS_TO_PER_MILLION = {
  '>1 / 1000': 2000,
  '1-5 / 10 000': 300,
  '1-9 / 100 000': 50,
  '1-9 / 1 000 000': 5,
  '<1 / 1 000 000': 0.5,
  'Unknown': null,
  'Not yet documented': null,
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

async function ensureCache(refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const alignXml = path.join(CACHE_DIR, 'orphadata-alignments.xml');
  const epiXml = path.join(CACHE_DIR, 'orphadata-epidemiology.xml');
  if (refresh || !fs.existsSync(alignXml)) await download(ALIGNMENTS_URL, alignXml);
  if (refresh || !fs.existsSync(epiXml)) await download(EPIDEMIOLOGY_URL, epiXml);
  return { alignXml, epiXml };
}

/**
 * Minimal XML scraper for Orphadata. The schema is deeply nested but we only
 * need (ORPHAcode, ICD-10 codes, prevalence class). A dependency-free
 * regex-based pass is fast and avoids pulling in a full XML parser at build
 * time.
 */
function extractAlignments(xml) {
  const map = new Map(); // orphaCode -> Set<icd10>
  const disorderRe = /<Disorder[^>]*>([\s\S]*?)<\/Disorder>/g;
  let m;
  while ((m = disorderRe.exec(xml))) {
    const block = m[1];
    const orphaMatch = block.match(/<OrphaCode>(\d+)<\/OrphaCode>/);
    if (!orphaMatch) continue;
    const orpha = orphaMatch[1];
    const icds = new Set();
    const refRe = /<ExternalReference[^>]*>([\s\S]*?)<\/ExternalReference>/g;
    let r;
    while ((r = refRe.exec(block))) {
      const ref = r[1];
      if (/<Source>ICD-10<\/Source>/.test(ref)) {
        const codeMatch = ref.match(/<Reference>([^<]+)<\/Reference>/);
        if (codeMatch) icds.add(codeMatch[1].trim());
      }
    }
    if (icds.size > 0) map.set(orpha, icds);
  }
  return map;
}

function extractPrevalence(xml) {
  const map = new Map(); // orphaCode -> minPerMillion (lowest = rarest)
  const disorderRe = /<Disorder[^>]*>([\s\S]*?)<\/Disorder>/g;
  let m;
  while ((m = disorderRe.exec(xml))) {
    const block = m[1];
    const orphaMatch = block.match(/<OrphaCode>(\d+)<\/OrphaCode>/);
    if (!orphaMatch) continue;
    const orpha = orphaMatch[1];
    const classes = [];
    const prevRe = /<PrevalenceClass[^>]*>([\s\S]*?)<\/PrevalenceClass>/g;
    let p;
    while ((p = prevRe.exec(block))) {
      const nameMatch = p[1].match(/<Name[^>]*>([^<]+)<\/Name>/);
      if (nameMatch) classes.push(nameMatch[1].trim());
    }
    let best = null;
    for (const cls of classes) {
      const v = PREVALENCE_CLASS_TO_PER_MILLION[cls];
      if (typeof v === 'number') {
        if (best === null || v < best) best = v;
      }
    }
    if (best !== null) map.set(orpha, best);
  }
  return map;
}

function normaliseIcd(code) {
  // Strip subcategory variants like "Q90.0+Q90.9" / "Q90.* / E70-E90" to head.
  return code.replace(/\s+/g, '').toUpperCase().split(/[+*\/,;\-]/)[0];
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  console.log('[orphanet] preparing cache (refresh=' + refresh + ')…');
  const { alignXml, epiXml } = await ensureCache(refresh);

  const alignXmlText = fs.readFileSync(alignXml, 'utf8');
  const epiXmlText = fs.readFileSync(epiXml, 'utf8');

  console.log('[orphanet] parsing alignments…');
  const alignments = extractAlignments(alignXmlText);
  console.log('[orphanet] parsing epidemiology…');
  const prevalence = extractPrevalence(epiXmlText);

  console.log(`[orphanet] ${alignments.size} disorders with ICD-10, ${prevalence.size} with prevalence data.`);

  // Build per-ICD10 tier. If multiple Orphanet disorders share the same ICD-10
  // head, take the rarest tier.
  const codes = {};
  for (const [orpha, icds] of alignments) {
    const perMillion = prevalence.get(orpha);
    if (perMillion === undefined) continue;
    if (perMillion > FLAG_THRESHOLD) continue;
    const tier = perMillion <= AUTO_THRESHOLD ? 'auto' : 'flag';
    for (const icd of icds) {
      const head = normaliseIcd(icd);
      if (!head.match(/^[A-Z]\d{2}/)) continue;
      const existing = codes[head];
      if (!existing || (existing === 'flag' && tier === 'auto')) {
        codes[head] = tier;
      }
    }
  }

  const total = Object.keys(codes).length;
  console.log(`[orphanet] writing ${total} ICD-10 heads (${Object.values(codes).filter((t) => t === 'auto').length} auto-suppress, ${Object.values(codes).filter((t) => t === 'flag').length} flag).`);

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        $comment:
          'Generated by scripts/build-rare-icd.js from Orphadata (INSERM US14, CC BY 4.0). Do not edit by hand.',
        generatedAt: new Date().toISOString(),
        sourceURLs: [ALIGNMENTS_URL, EPIDEMIOLOGY_URL],
        thresholds: { flag: `<= 1:${Math.round(1_000_000 / FLAG_THRESHOLD)}`, auto: `<= 1:${Math.round(1_000_000 / AUTO_THRESHOLD)}` },
        codes,
      },
      null,
      2
    )
  );
  console.log('[orphanet] wrote', OUT_PATH);
}

main().catch((err) => {
  console.error('[orphanet] failed:', err.message);
  process.exit(1);
});
