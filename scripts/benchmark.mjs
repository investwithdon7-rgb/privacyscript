/**
 * Benchmark: scores the rule engine against public, synthetic, labelled
 * de-identification datasets kept in benchmark-data/ (git-ignored; never
 * committed or shipped). Rules only; the name model runs in the browser.
 *
 * Usage:
 *   node scripts/benchmark.mjs                 # tuning split, all datasets
 *   node scripts/benchmark.mjs --split test    # held-out split (final scores only)
 *   node scripts/benchmark.mjs --only de-letters --limit 300 --examples 15
 *
 * Datasets (all synthetic; download into benchmark-data/, which is git-ignored):
 *   de-letters  LukasKunhardt/synthetic-german-clinical-letters (CC BY 4.0)
 *               → de-letters/train.jsonl  (huggingface.co/datasets/…/resolve/main/data/train.jsonl)
 *   meddocan    MEDDOCAN, Zenodo record 4279323 (CC BY 4.0)
 *               → meddocan/meddocan.zip, unzipped in place (meddocan/meddocan/{train,dev,test}/brat)
 *   nl-meddeid  stighellemans/meddeid-dutch-synthetic-corpus (CC BY 4.0)
 *               → nl-meddeid/train.jsonl  (…/resolve/main/data/train.jsonl)
 *   nl-careons  careons/dutch-healthcare-pii-ner (MIT)
 *               → nl-careons/data.json    (…/resolve/main/data.json)
 *   multi-xx    masterofaudio2077/medical-pii-multilingual (Apache 2.0)
 *               → multi-pii/{de,en,es,fr,nl}.jsonl  (…/resolve/main/data/<lang>.jsonl)
 * Not used: microsoft/MDeID (CC BY-NC 4.0, non-commercial only).
 * A missing dataset is skipped.
 *
 * Split: MEDDOCAN uses its own train+dev vs test. Others: 1 in 5 documents
 * (by a hash of the document id) is held out as "test".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(root, 'benchmark-data');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(root, 'node_modules/esbuild'));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const SPLIT = opt('split', 'dev');
const ONLY = opt('only', null);
const LIMIT = Number(opt('limit', '0')) || Infinity;
const EXAMPLES = Number(opt('examples', '6'));

const outfile = path.join(root, '.benchmark.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'scripts/benchmark-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['@xenova/transformers'],
  alias: { '@': path.join(root, 'src') },
  loader: { '.json': 'json' },
  logLevel: 'error',
});
const { scoreDoc } = require(outfile);

// ─── Label classes ──────────────────────────────────────────────────────────
// direct: must be hidden (HIPAA Safe Harbor / GDPR direct identifiers).
// quasi: should be hidden or generalised (age, profession, institution).
// clinical: medical content that must stay readable (hiding it is a cost).
// ignore: neither (titles, gender, country, times).
const CLASSES = {
  'de-letters': {
    direct: ['NAME_PATIENT', 'NAME_DOCTOR', 'NAME_RELATIVE', 'NAME_EXT', 'NAME_USERNAME', 'ID', 'LOCATION_STREET', 'LOCATION_ZIP', 'LOCATION_CITY', 'CONTACT_PHONE', 'CONTACT_FAX', 'CONTACT_EMAIL', 'CONTACT_URL', 'DATE'],
    quasi: ['AGE', 'PROFESSION', 'LOCATION_HOSPITAL'],
    ignore: ['NAME_TITLE'],
  },
  meddocan: {
    direct: ['NOMBRE_SUJETO_ASISTENCIA', 'NOMBRE_PERSONAL_SANITARIO', 'FAMILIARES_SUJETO_ASISTENCIA', 'ID_SUJETO_ASISTENCIA', 'ID_TITULACION_PERSONAL_SANITARIO', 'ID_ASEGURAMIENTO', 'ID_CONTACTO_ASISTENCIAL', 'ID_EMPLEO_PERSONAL_SANITARIO', 'CALLE', 'TERRITORIO', 'FECHAS', 'CORREO_ELECTRONICO', 'NUMERO_TELEFONO', 'NUMERO_FAX', 'OTROS_SUJETO_ASISTENCIA', 'URL_WEB', 'DIREC_PROT_INTERNET'],
    quasi: ['EDAD_SUJETO_ASISTENCIA', 'PROFESION', 'HOSPITAL', 'INSTITUCION', 'CENTRO_SALUD'],
    ignore: ['SEXO_SUJETO_ASISTENCIA', 'PAIS'],
  },
  'nl-meddeid': {
    direct: ['Date', 'Contactdetails', 'Name:Patient', 'Name:Caregiver', 'Name:Other', 'ID:Patient', 'ID:Caregiver', 'Address_Location:Patient', 'Address_Location:Caregiver', 'Address_Location:Other'],
    quasi: ['Age_Birthdate', 'Profession', 'Organization:Healthcare', 'Organization:Other'],
    ignore: [],
  },
  'nl-careons': {
    direct: ['PERSON', 'LOCATION', 'ZIPCODE', 'BSN', 'DATE', 'GPS_COORDINATES', 'CREDIT_CARD', 'PHONE_NUMBER', 'EMAIL_ADDRESS', 'ZORGPOLIS_NUMBER', 'IBAN_CODE', 'LICENCE_PLATE', 'URL', 'CVV', 'MAC_ADDRESS', 'IP_ADDRESS', 'PASSPORT', 'IMEI'],
    quasi: [],
    ignore: ['TIME'],
  },
  multi: {
    direct: ['NAME', 'DATE', 'CITY', 'ZIPCODE', 'STREET', 'PHONE', 'EMAIL', 'URL', 'MEDICALRECORDNUM', 'INSZ', 'RIZIV', 'RPPS', 'NIR', 'BSN', 'KVNR', 'LANR', 'STEUER_ID', 'DNI', 'NIE', 'COLEGIADO', 'NHS_NUMBER', 'GMC', 'SSN', 'NPI', 'BTW', 'IBAN'],
    quasi: ['AGE', 'ORGANIZATION'],
    ignore: ['GENDER'],
    // everything else (DIAGNOSIS, MEDICATION, …) is clinical
  },
};

function classify(family, label) {
  const c = CLASSES[family];
  if (c.direct.includes(label)) return 'direct';
  if (c.quasi.includes(label)) return 'quasi';
  if (c.ignore.includes(label)) return 'ignore';
  return family === 'multi' ? 'clinical' : 'direct'; // unknown identifier labels count
}

// ─── Loaders ────────────────────────────────────────────────────────────────
function hashSplit(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 5 === 0 ? 'test' : 'dev';
}
const jsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// PrivacyScript follows HIPAA Safe Harbor: a year on its own and an age of
// 89 or under may stay (ages over 89 become "90+"). The datasets label them
// anyway, so they are not counted as misses here.
const AGE_LABELS = new Set(['AGE', 'Age_Birthdate', 'EDAD_SUJETO_ASISTENCIA']);
const DATE_LABELS = new Set(['DATE', 'Date', 'FECHAS']);
function allowedByPolicy(label, text) {
  const t = text.trim();
  if (DATE_LABELS.has(label) && /^(?:(?:in|im|en|el|año|jaar|year|en el año|anno)\s+)?(?:19|20)\d{2}$/i.test(t)) return true;
  if (AGE_LABELS.has(label)) {
    const n = /\d{1,3}/.exec(t);
    if (n && Number(n[0]) <= 89 && !/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(t)) return true;
  }
  return false;
}
const gold = (family, list) => list.map((s) => ({ ...s, cls: classify(family, s.label) }));

const DATASETS = {
  'de-letters': () =>
    jsonl(path.join(DATA, 'de-letters/train.jsonl')).map((r) => ({
      id: r.doc_id, lang: 'de', split: hashSplit(r.doc_id), text: r.text,
      gold: gold('de-letters', r.spans.map((s) => ({ start: s.start, end: s.end, label: s.label }))),
    })),
  meddocan: () => {
    const out = [];
    for (const part of ['train', 'dev', 'test']) {
      const dir = path.join(DATA, 'meddocan/meddocan', part, 'brat');
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const ann = fs.readFileSync(path.join(dir, f.replace(/\.txt$/, '.ann')), 'utf8');
        const spans = [];
        for (const line of ann.split('\n')) {
          const m = /^T\d+\t(\S+) ([\d ;]+)\t/.exec(line);
          if (!m) continue;
          for (const frag of m[2].split(';')) {
            const [a, b] = frag.trim().split(' ').map(Number);
            spans.push({ start: a, end: b, label: m[1] });
          }
        }
        out.push({ id: f, lang: 'es', split: part === 'test' ? 'test' : 'dev', text, gold: gold('meddocan', spans) });
      }
    }
    return out;
  },
  'nl-meddeid': () =>
    jsonl(path.join(DATA, 'nl-meddeid/train.jsonl')).map((r) => ({
      id: r.document_id, lang: 'nl', split: hashSplit(r.document_id), text: r.text,
      gold: gold('nl-meddeid', r.spans.map((s) => ({ start: s.begin, end: s.end, label: s.label }))),
    })),
  'nl-careons': () =>
    JSON.parse(fs.readFileSync(path.join(DATA, 'nl-careons/data.json'), 'utf8')).map((r, i) => ({
      id: `careons-${i}`, lang: 'nl', split: hashSplit(`careons-${i}`), text: r.text,
      gold: gold('nl-careons', r.entities.map((s) => ({ start: s.start, end: s.end, label: s.entity_type }))),
    })),
  ...Object.fromEntries(
    ['de', 'en', 'es', 'fr', 'nl'].map((l) => [
      `multi-${l}`,
      () =>
        jsonl(path.join(DATA, `multi-pii/${l}.jsonl`)).map((r) => ({
          id: r.id, lang: l, split: hashSplit(r.id), text: r.text,
          gold: gold('multi', JSON.parse(r.entities).map((s) => ({ start: s.start, end: s.end, label: s.label }))),
        })),
    ])
  ),
};

// ─── Run ────────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1).padStart(5) + '%' : '    –');
const summary = [];
const details = {};

for (const [name, load] of Object.entries(DATASETS)) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  let docs;
  try {
    docs = load().filter((d) => d.split === SPLIT).slice(0, LIMIT);
  } catch (e) {
    console.log(`\n${name}: not available (${e.message.split('\n')[0]})`);
    continue;
  }
  const byLabel = new Map();
  const extra = new Map();
  const clinical = new Map();
  let offered = 0;
  let ms = 0;
  for (const d of docs) {
    for (const g of d.gold) {
      if (g.cls !== 'clinical' && allowedByPolicy(g.label, d.text.slice(g.start, g.end))) g.cls = 'ignore';
    }
    const r = scoreDoc(d.text, d.gold);
    ms += r.ms;
    offered += r.offered;
    for (const g of r.gold) {
      if (g.cls === 'ignore' || g.cls === 'clinical') continue;
      const e = byLabel.get(g.label) ?? { cls: g.cls, n: 0, hidden: 0, partial: 0, missed: [], partials: [] };
      e.n++;
      if (g.status === 'hidden') e.hidden++;
      else if (g.status === 'partial') { e.partial++; e.partials.push(g.text); }
      else e.missed.push(g.text);
      byLabel.set(g.label, e);
    }
    for (const x of r.extra) {
      const e = extra.get(x.label) ?? [];
      e.push(x.text);
      extra.set(x.label, e);
    }
    for (const x of r.clinicalHit) {
      const k = `${x.label}→${x.goldLabel}`;
      const e = clinical.get(k) ?? [];
      e.push(x.text);
      clinical.set(k, e);
    }
  }

  console.log(`\n━━ ${name} (${SPLIT}, ${docs.length} docs, ${(ms / Math.max(1, docs.length)).toFixed(1)} ms/doc, ${offered} possible names offered)`);
  console.log('  label                              n   hidden  partial   missed   [class]');
  const tot = { direct: [0, 0], quasi: [0, 0] };
  for (const [label, e] of Array.from(byLabel.entries()).sort((a, b) => b[1].n - a[1].n)) {
    tot[e.cls][0] += e.hidden;
    tot[e.cls][1] += e.n;
    console.log(
      `  ${label.padEnd(32)} ${String(e.n).padStart(5)}  ${pct(e.hidden, e.n)}  ${pct(e.partial, e.n)}  ${pct(e.missed.length, e.n)}   ${e.cls}`
    );
    if (EXAMPLES > 0 && e.hidden < e.n) {
      const ex = [...e.missed.slice(0, EXAMPLES).map((t) => JSON.stringify(t)), ...e.partials.slice(0, Math.ceil(EXAMPLES / 2)).map((t) => `~${JSON.stringify(t)}`)];
      console.log(`      e.g. ${ex.join('  ').replace(/\\n/g, '⏎').slice(0, 400)}`);
    }
  }
  const nExtra = Array.from(extra.values()).reduce((n, v) => n + v.length, 0);
  const nClin = Array.from(clinical.values()).reduce((n, v) => n + v.length, 0);
  console.log(`  ALL direct: ${pct(tot.direct[0], tot.direct[1])} hidden   quasi: ${pct(tot.quasi[0], tot.quasi[1])} hidden   unlabelled hits: ${nExtra}   clinical text hidden: ${nClin}`);
  if (EXAMPLES > 0) {
    for (const [k, v] of Array.from(extra.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
      console.log(`    unlabelled ${k} ×${v.length}: ${v.slice(0, EXAMPLES).map((t) => JSON.stringify(t)).join('  ').slice(0, 300)}`);
    }
    for (const [k, v] of Array.from(clinical.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
      console.log(`    clinical ${k} ×${v.length}: ${v.slice(0, EXAMPLES).map((t) => JSON.stringify(t)).join('  ').slice(0, 300)}`);
    }
  }
  summary.push({ name, docs: docs.length, direct: tot.direct, quasi: tot.quasi, extra: nExtra, clinical: nClin });
  details[name] = Object.fromEntries(Array.from(byLabel.entries()).map(([k, e]) => [k, { ...e, missed: e.missed.slice(0, 200), partials: e.partials.slice(0, 100) }]));
}

console.log('\n══ Summary (' + SPLIT + ')');
console.log('  dataset          docs   direct hidden   quasi hidden   unlabelled   clinical hidden');
for (const s of summary) {
  console.log(`  ${s.name.padEnd(15)} ${String(s.docs).padStart(5)}   ${pct(...s.direct).padStart(13)}   ${pct(...s.quasi).padStart(12)}   ${String(s.extra).padStart(10)}   ${String(s.clinical).padStart(15)}`);
}
if (fs.existsSync(DATA)) fs.writeFileSync(path.join(DATA, `report-${SPLIT}.json`), JSON.stringify({ summary, details }, null, 1));
