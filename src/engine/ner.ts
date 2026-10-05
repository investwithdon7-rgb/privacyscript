/**
 * Transformers.js NER integration.
 *
 * - Always: multilingual PER / LOC / ORG model (`NER_MODELS.multilingual`).
 * - Optional "thorough check" for English records: a clinical
 *   de-identification model (`NER_MODELS.clinical`, BERT fine-tuned on the
 *   i2b2 2014 de-identification corpus) runs as well and its findings are
 *   added. On test notes the two models miss DIFFERENT names (together they
 *   miss fewer than either alone) but the clinical one is ~1.5x slower and
 *   another ~110 MB, so it is off unless the user turns it on.
 *   (`d4data/biomedical-ner-all`, the earlier plan, tags diseases and drugs,
 *   not identifiers, so it would not help de-identification.)
 *
 * Caching: Transformers.js caches model files in the browser cache
 *   (`env.useBrowserCache = true`). Later loads are instant.
 *
 * The pipeline accepts the model being absent — detection still runs purely
 * from regex if the model fails to load (offline first-load with no cache).
 */

import type { Span } from '@/engine/detect';
import type { IdentifierLabel } from '@/lib/identifiers';
import { BASE_PATH } from '@/lib/assets';

export interface NERStatus {
  available: boolean;
  modelName: string;
  loaded: boolean;
  loadProgress: number;
  message: string;
  error: string | null;
  /** Hosts the background worker fetched from (model files), for the network ledger. */
  networkHosts?: string[];
}

/** Hosts this context (page or worker) has fetched resources from. */
export function contactedHosts(): string[] {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
  const hosts = new Set<string>();
  for (const e of performance.getEntriesByType('resource')) {
    try {
      hosts.add(new URL(e.name).host);
    } catch {
      /* blob: / data: entries */
    }
  }
  return Array.from(hosts);
}

export const NER_STATUS_INITIAL: NERStatus = {
  available: typeof window !== 'undefined',
  modelName: '',
  loaded: false,
  loadProgress: 0,
  message: 'Generic NER model not loaded yet.',
  error: null,
};

interface NerTokenizer {
  (text: string, options?: unknown): { input_ids: { data: ArrayLike<number | bigint> } };
  model: { convert_ids_to_tokens(ids: number[]): string[] };
}

type NerPipeline = ((text: string, options?: unknown) => Promise<NerOutput[]>) & {
  tokenizer?: NerTokenizer;
};

interface NerOutput {
  entity: string;
  entity_group?: string;
  word: string;
  /**
   * Token position in the model input ([CLS] = 0). transformers.js v2
   * always reports start/end as null, so offsets are rebuilt from this.
   */
  index?: number;
  start: number | null;
  end: number | null;
  score: number;
}

/**
 * Character offsets for each WordPiece token of `text`, by walking the text
 * with a cursor. Special tokens map to null. Needed because transformers.js
 * v2 returns `start: null, end: null` for every entity; the engine used to
 * treat null as 0, which pinned every detected name onto the first word of
 * the chunk ("Another", "But") and left the real names unredacted.
 */
export function wordPieceOffsets(tokens: string[], text: string): Array<[number, number] | null> {
  let cursor = 0;
  return tokens.map((t) => {
    if (t === '[CLS]' || t === '[SEP]' || t === '[PAD]') return null;
    if (t === '[UNK]') {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (cursor >= text.length) return null;
      const s = cursor;
      while (cursor < text.length && !/\s/.test(text[cursor])) cursor++;
      return [s, cursor];
    }
    const piece = t.startsWith('##') ? t.slice(2) : t;
    const idx = text.indexOf(piece, cursor);
    if (idx < 0) return null;
    // Normally only whitespace separates a token from the cursor. A few
    // stray characters mean an earlier token didn't line up (a symbol the
    // tokenizer rewrote); step over them so one miss can't derail every
    // token after it. A distant match is a different occurrence: skip it.
    if (text.slice(cursor, idx).replace(/\s+/g, '').length > 6) return null;
    cursor = idx + piece.length;
    return [idx, cursor];
  });
}

/** An entity whose character offsets are known. */
export type PositionedNer = NerOutput & { start: number; end: number };

/** Fill in start/end from token indices when the pipeline did not. */
export function withOffsets(raw: NerOutput[], offsets: Array<[number, number] | null>): NerOutput[] {
  const out: NerOutput[] = [];
  for (const e of raw) {
    if (typeof e.start === 'number' && typeof e.end === 'number') {
      out.push(e);
      continue;
    }
    const o = e.index !== undefined ? offsets[e.index] : null;
    // No reliable position: drop it rather than pin it to the wrong word.
    if (o) out.push({ ...e, start: o[0], end: o[1] });
  }
  return out;
}

const pipelinePromises = new Map<NerModelKey, Promise<NerPipeline | null>>();
let currentStatus: NERStatus = { ...NER_STATUS_INITIAL };
const listeners = new Set<(s: NERStatus) => void>();

export function getNerStatus(): NERStatus {
  return currentStatus;
}

export function subscribeNerStatus(fn: (s: NERStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(patch: Partial<NERStatus>) {
  currentStatus = { ...currentStatus, ...patch };
  for (const fn of listeners) fn(currentStatus);
}

/**
 * Multilingual PER / ORG / LOC model (English, German, Dutch, Spanish,
 * French, Italian, Portuguese, Arabic, Chinese, Latvian). A distilled BERT:
 * 6 layers instead of 12, so roughly twice as fast as bert-base-NER, which
 * was English-only and mis-tagged ordinary Spanish words as names.
 */
export const NER_MODEL_ID = 'Xenova/distilbert-base-multilingual-cased-ner-hrl';

export type NerModelKey = 'clinical' | 'multilingual';

export interface NerModel {
  id: string;
  /** Download size of the quantised weights, for the one-time notice. */
  sizeMb: number;
  /** Plain-language name for status messages. */
  title: string;
  labels: Record<string, IdentifierLabel | null>;
}

export const NER_MODELS: Record<NerModelKey, NerModel> = {
  clinical: {
    // obi/deid_bert_i2b2 (MIT), ONNX export by the onnx-community org.
    id: 'onnx-community/deid_bert_i2b2-ONNX',
    sizeMb: 110,
    title: 'clinical name-detection model',
    labels: {
      PATIENT: 'NAME',
      STAFF: 'NAME',
      LOC: 'ADDRESS_LINE',
      HOSP: 'INSTITUTION',
      PATORG: 'INSTITUTION',
      ID: 'REFERENCE_ID',
      OTHERPHI: 'REFERENCE_ID',
      PHONE: 'PHONE',
      EMAIL: 'EMAIL',
      // Exact dates and ages over 89 come from the rules; the model also tags
      // ordinary ages and vague dates, which are not identifiers.
      DATE: null,
      AGE: null,
    },
  },
  multilingual: {
    id: NER_MODEL_ID,
    sizeMb: 135,
    title: 'multilingual name-detection model',
    labels: {
      PER: 'NAME',
      LOC: 'ADDRESS_LINE',
      ORG: 'INSTITUTION',
      MISC: null,
      // The multilingual model also tags dates, including vague ones ("last
      // summer"). Exact dates are caught by the rule engine; redacting every
      // time phrase would strip context researchers need.
      DATE: null,
    },
  },
};

const STOPWORDS: Record<string, string[]> = {
  en: 'the and of to with is was in for on she he her his patient had has be are this that at by from were not no'.split(' '),
  es: 'el la de que y en los las del por con una para es se su al lo como más pero'.split(' '),
  de: 'der die und das ist nicht mit sie ich ein eine den von zu auf für dem des sich auch'.split(' '),
  fr: 'le la les et des est une pour que dans pas qui sur avec il elle du au ce'.split(' '),
  nl: 'de het een en van is dat niet ik zijn op te met voor ze die er ook maar'.split(' '),
  it: 'il la di che e non è per una sono con mi si lo gli della anche ma'.split(' '),
  pt: 'o a de que e do da em um para é com não uma os no se na por mais'.split(' '),
};

/**
 * True when the text reads as English, or has too few words to tell (a DICOM
 * header, a terse note). The clinical model only knows English.
 */
export function readsAsEnglish(text: string): boolean {
  const words = text.slice(0, 20000).toLowerCase().match(/\p{L}+/gu) ?? [];
  const score: Record<string, number> = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    score[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  const other = Math.max(...Object.entries(score).filter(([l]) => l !== 'en').map(([, n]) => n));
  return other < 5 || score.en >= other;
}

// ─── Thorough check (per-device preference, not data) ───────────────────
const THOROUGH_KEY = 'privacyscript.thoroughNames';
let thorough: boolean | null = null;
const thoroughListeners = new Set<(on: boolean) => void>();

export function getThoroughCheck(): boolean {
  if (thorough === null) {
    try {
      thorough = typeof localStorage !== 'undefined' && localStorage.getItem(THOROUGH_KEY) === '1';
    } catch {
      thorough = false;
    }
  }
  return thorough;
}

export function setThoroughCheck(on: boolean): void {
  thorough = on;
  try {
    localStorage.setItem(THOROUGH_KEY, on ? '1' : '0');
  } catch {
    /* private mode: setting lasts for this visit */
  }
  for (const fn of thoroughListeners) fn(on);
  if (on) preloadNer();
}

export function subscribeThoroughCheck(fn: (on: boolean) => void): () => void {
  thoroughListeners.add(fn);
  return () => thoroughListeners.delete(fn);
}

/** Models to run on this text. */
export function modelsFor(text: string, thoroughOn = getThoroughCheck()): NerModelKey[] {
  return thoroughOn && readsAsEnglish(text) ? ['multilingual', 'clinical'] : ['multilingual'];
}

export function downloadNotice(key: NerModelKey): string {
  const m = NER_MODELS[key];
  return `Downloading the ${m.title} (~${m.sizeMb} MB, once)…`;
}

/**
 * Load the token-classification pipeline. Shared by the background worker
 * and the in-page fallback; works in either context (no window access).
 */
export async function loadNerPipeline(
  key: NerModelKey,
  onProgress?: (pct: number, message: string) => void
): Promise<NerPipeline> {
  const tx = await import('@xenova/transformers');

  // Point ORT at our statically-served WASM binaries (copied to public/wasm/
  // by scripts/copy-ort-wasm.js). Without this, ORT defaults to looking
  // next to the webpack chunk URL (/_next/static/chunks/…wasm) which 404s.
  tx.env.backends.onnx.wasm.wasmPaths = `${BASE_PATH}/wasm/`;

  // Threads need cross-origin isolation (COOP/COEP, sent in production by
  // public/_headers; the model download is a CORS fetch, so it still works).
  // Leave one core for the page. Without isolation: one thread.
  const isolated = typeof self !== 'undefined' && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1;
  tx.env.backends.onnx.wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores - 1)) : 1;

  // Allow remote model fetch; cache in IndexedDB.
  tx.env.allowLocalModels = false;
  tx.env.useBrowserCache = typeof caches !== 'undefined';
  const pipeline = await tx.pipeline('token-classification', NER_MODELS[key].id, {
    quantized: true,
    progress_callback: (p: { progress?: number; status?: string }) => {
      if (typeof p.progress === 'number') {
        onProgress?.(Math.min(100, Math.round(p.progress)), p.status ?? 'Loading model…');
      }
    },
  });
  return pipeline as unknown as NerPipeline;
}

/**
 * In-page fallback: lazily load the pipeline on the main thread. Used only
 * when a background worker cannot be created. Returns null where
 * Transformers cannot run (SSR / Node tests). Memoised.
 */
export function ensureNerLoaded(key: NerModelKey): Promise<NerPipeline | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const existing = pipelinePromises.get(key);
  if (existing) return existing;

  const promise = (async () => {
    setStatus({ modelName: NER_MODELS[key].id, message: downloadNotice(key), loadProgress: 0 });
    try {
      const pipeline = await loadNerPipeline(key, (pct, message) =>
        setStatus({ loadProgress: pct, message })
      );
      setStatus({
        loaded: true,
        loadProgress: 100,
        message: 'NER model ready.',
        error: null,
      });
      return pipeline;
    } catch (err) {
      const msg = (err as Error).message;
      setStatus({
        loaded: false,
        error: msg,
        message: `NER unavailable — regex engine running standalone (${msg}).`,
      });
      return null;
    }
  })();
  pipelinePromises.set(key, promise);
  return promise;
}

interface EntityGroup {
  type: string;
  start: number;
  end: number;
  score: number;
}

/**
 * Aggregate per-token BIO output into whole entities.
 *
 * transformers.js's token-classification pipeline emits one entry PER TOKEN
 * (B-PER, I-PER…) — unlike the Python library it does not implement the
 * `aggregation_strategy` option, so "Anjula" arrives as three tokens
 * ("An", "##ju", "##la"), each of which used to become its own span. That is
 * where the meaningless 1-2 character detections ("An", "Co", "N") came from.
 *
 * A token extends the current group when it has the same entity type AND is a
 * continuation: an I- tag, or a zero-gap subword, separated from the group by
 * at most one whitespace character. Scores are averaged across the group.
 */
export function aggregateEntities(raw: PositionedNer[], text: string): EntityGroup[] {
  const groups: EntityGroup[] = [];
  let current: (EntityGroup & { sum: number; n: number }) | null = null;

  for (const e of raw) {
    const tag = e.entity_group ?? e.entity;
    // BIO (multilingual) and BILOU (clinical) tags: I- and L- continue.
    const type = tag.replace(/^[BILU]-/, '');
    const isContinuation =
      tag.startsWith('I-') || tag.startsWith('L-') || (current !== null && e.start === current.end);
    const gap = current ? text.slice(current.end, e.start) : '';

    if (current && type === current.type && isContinuation && /^\s?$/.test(gap)) {
      current.end = e.end;
      current.sum += e.score;
      current.n += 1;
      current.score = current.sum / current.n;
    } else {
      if (current) groups.push({ type: current.type, start: current.start, end: current.end, score: current.score });
      current = { type, start: e.start, end: e.end, score: e.score, sum: e.score, n: 1 };
    }
  }
  if (current) groups.push({ type: current.type, start: current.start, end: current.end, score: current.score });
  return groups;
}

/**
 * Generic clinical-document vocabulary the NER model regularly mistakes for
 * entities (all-caps headings confuse bert-base-NER). A span consisting of
 * exactly one of these words identifies nobody — drop it. Multi-word spans
 * ("St Mary's Discharge Unit") are never filtered by this list.
 */
const NER_DOCUMENT_WORDS = new Set([
  'discharge', 'summary', 'admission', 'diagnosis', 'assessment', 'plan',
  'history', 'medication', 'medications', 'allergies', 'referral', 'report',
  'ward', 'clinic', 'hospital', 'patient', 'doctor', 'nurse', 'dob', 'nhs',
  // Anatomy and imaging labels: burned into ultrasound pictures and used as
  // report headings ("LT KIDNEY", "LIVER"); without a sentence around them
  // the models take them for names.
  'kidney', 'kidneys', 'liver', 'spleen', 'pancreas', 'gallbladder', 'bladder', 'thyroid', 'uterus',
  'ovary', 'ovaries', 'prostate', 'testis', 'testes', 'aorta', 'carotid', 'heart', 'lung', 'lungs',
  'breast', 'abdomen', 'pelvis', 'chest', 'head', 'neck', 'knee', 'shoulder', 'hip', 'wrist', 'ankle',
  'spine', 'brain', 'fetal', 'fetus', 'foetal', 'placenta', 'renal', 'hepatic', 'cardiac', 'vascular',
  'sagittal', 'transverse', 'axial', 'coronal', 'doppler', 'left', 'right', 'bilateral',
]);

/**
 * Convert raw pipeline output into engine spans: aggregate BIO tokens, snap
 * span edges to word boundaries (a fragment like "Weer" inside "Weeranayake"
 * expands to the whole word so the redaction never leaves half a name behind),
 * and drop anything under 3 characters — those are stray subword tokens with
 * no identifying value, pure noise in the review UI.
 */
export function rawNerToSpans(
  raw: PositionedNer[],
  text: string,
  offset: number,
  labels: Record<string, IdentifierLabel | null> = NER_MODELS.multilingual.labels
): Span[] {
  const spans: Span[] = [];
  for (const g of aggregateEntities(raw, text)) {
    const label = labels[g.type] ?? null;
    if (!label) continue;

    let start = g.start;
    let end = g.end;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;

    const value = text.slice(start, end);
    if (value.trim().length < 3) continue;
    if (NER_DOCUMENT_WORDS.has(value.trim().toLowerCase())) {
      // On its own "WARD" is a heading; straight after a name ("DR SUSAN
      // WARD") it is the surname: extend that name instead of dropping it.
      const prev = spans[spans.length - 1];
      if (prev && prev.label === label && /^ ?$/.test(text.slice(prev.end - offset, start))) {
        prev.end = end + offset;
        prev.text = text.slice(prev.start - offset, end);
      }
      continue;
    }

    spans.push({
      start: start + offset,
      end: end + offset,
      text: value,
      label,
      category: label === 'INSTITUTION' ? 'QUASI' : 'HIPAA',
      source: 'ner',
      confidence: g.score,
    });
  }
  return spans;
}

export interface NerRunOptions {
  /**
   * Ranges the model need not read (caption timings, cue IDs, speaker
   * labels already handled by rules). They are blanked with spaces, which
   * keeps every offset intact and removes their tokens from the workload.
   */
  skip?: Array<{ start: number; end: number }>;
  /** Called after each chunk: done of total. */
  onProgress?: (done: number, total: number) => void;
  /** Force the models; by default see modelsFor(). */
  models?: NerModelKey[];
}

export class NerCancelledError extends Error {
  constructor() {
    super('Name detection was cancelled.');
    this.name = 'NerCancelledError';
  }
}

/** Blank the given ranges with spaces (newlines kept), preserving offsets. */
export function maskRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const { start, end } of ranges) {
    for (let i = Math.max(0, start); i < Math.min(chars.length, end); i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * Rewrite ALL-CAPS lines in title case for the model ("DR SUSAN WARD" →
 * "Dr Susan Ward"). Cased models barely recognise names in capitals, and
 * clinical headers are full of them. Every character keeps its position, so
 * spans still map onto the original text.
 */
export function softenCaps(text: string): string {
  return text.replace(/[^\n]+/g, (line) => {
    const letters = line.match(/\p{L}/gu) ?? [];
    if (letters.length < 4) return line;
    const upper = letters.filter((c) => c !== c.toLowerCase()).length;
    if (upper / letters.length < 0.8) return line;
    const soft = line.replace(/\p{L}+/gu, (w) => w[0] + w.slice(1).toLowerCase());
    return soft.length === line.length ? soft : line;
  });
}

/**
 * Run the model over `text`, chunk by chunk. Shared core of the worker and
 * the in-page fallback. Chunks run one after another so progress is real and
 * cancellation takes effect between chunks.
 */
export async function nerOnText(
  pipe: NerPipeline,
  text: string,
  opts: {
    onProgress?: (done: number, total: number) => void;
    isCancelled?: () => boolean;
    model?: NerModelKey;
  } = {}
): Promise<Span[]> {
  const labels = NER_MODELS[opts.model ?? 'multilingual'].labels;
  // The character budget assumes ~4 chars per token, which fails badly for
  // timestamp- or number-heavy text (a caption timing line is ~20 tokens).
  // Anything past 512 tokens is silently truncated by the model, so split
  // each chunk further until it really fits.
  // Generous character budget: masked (blank) text costs no tokens, and
  // fitToModel below splits anything that exceeds the real token window.
  const original = text;
  text = softenCaps(text);
  const chunks = splitForNer(text, 4000)
    .flatMap((c) => fitToModel(pipe, c))
    .filter((c) => c.text.trim().length > 0);

  // Dedupe by (start, end, label): the same entity can surface twice at a
  // chunk boundary.
  const seen = new Set<string>();
  const out: Span[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (opts.isCancelled?.()) throw new NerCancelledError();
    for (const s of await nerOneChunk(pipe, chunks[i].text, chunks[i].offset, labels)) {
      const key = `${s.start}|${s.end}|${s.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...s, text: original.slice(s.start, s.end) });
    }
    opts.onProgress?.(i + 1, chunks.length);
  }
  return out;
}

// ─── Background worker client ────────────────────────────────────────────
//
// The model runs in a Web Worker so long documents never freeze the page.
// If a worker cannot be created, the same code runs in-page instead.

type WorkerMessage =
  | { type: 'status'; patch: Partial<NERStatus> }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; spans: Span[] }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };

let nerWorker: Worker | null | undefined;
let nextRequestId = 0;
const pendingRuns = new Map<
  number,
  { resolve: (s: Span[]) => void; reject: (e: Error) => void; onProgress?: (d: number, t: number) => void }
>();

function failAllPending(err: Error): void {
  for (const p of Array.from(pendingRuns.values())) p.reject(err);
  pendingRuns.clear();
}

function getNerWorker(): Worker | null {
  if (nerWorker !== undefined) return nerWorker;
  try {
    nerWorker = new Worker(new URL('../workers/ner.worker.ts', import.meta.url));
    nerWorker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'status') {
        setStatus(m.patch);
        return;
      }
      const p = pendingRuns.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.done, m.total);
      else {
        pendingRuns.delete(m.id);
        if (m.type === 'result') p.resolve(m.spans);
        else if (m.type === 'cancelled') p.reject(new NerCancelledError());
        else p.reject(new Error(m.message));
      }
    };
    nerWorker.onerror = () => {
      // The worker itself failed (e.g. blocked script). Use in-page next time.
      nerWorker?.terminate();
      nerWorker = null;
      failAllPending(new Error('Background name detection stopped. Please try again.'));
    };
  } catch {
    nerWorker = null;
  }
  return nerWorker;
}

/**
 * Detect names, places and organisations. Runs in a background worker, so
 * the page stays responsive; reports progress; can be cancelled with
 * cancelNer(). Returns [] where the model cannot run (SSR / Node tests).
 */
export async function runClinicalNER(text: string, opts: NerRunOptions = {}): Promise<Span[]> {
  if (typeof window === 'undefined') return [];
  const input = opts.skip?.length ? maskRanges(text, opts.skip) : text;
  const models = opts.models ?? modelsFor(input);
  // Models run one after the other; progress spans all of them. Their spans
  // are simply concatenated: detect() merges overlaps.
  const out: Span[] = [];
  for (let m = 0; m < models.length; m++) {
    const onProgress = opts.onProgress
      ? (done: number, total: number) => opts.onProgress!(m * total + done, models.length * total)
      : undefined;
    out.push(...(await runOneModel(input, models[m], onProgress)));
  }
  return models.length > 1 ? dropCoveredSpans(out) : out;
}

/**
 * Two models often find the same thing: "JOHN BAKER" (sure) and "BAKER"
 * (unsure). A span lying inside a more confident one adds nothing and would
 * only put an extra question to the user, so it is dropped.
 */
export function dropCoveredSpans(spans: Span[]): Span[] {
  return spans.filter(
    (s) =>
      !spans.some(
        (t) =>
          t !== s &&
          t.start <= s.start &&
          t.end >= s.end &&
          ((t.confidence ?? 0) > (s.confidence ?? 0) ||
            ((t.confidence ?? 0) === (s.confidence ?? 0) && t.end - t.start > s.end - s.start))
      )
  );
}

async function runOneModel(
  input: string,
  model: NerModelKey,
  onProgress?: (done: number, total: number) => void
): Promise<Span[]> {
  const worker = getNerWorker();
  if (!worker) {
    const pipe = await ensureNerLoaded(model);
    if (!pipe) return [];
    return nerOnText(pipe, input, { onProgress, model });
  }
  return new Promise<Span[]>((resolve, reject) => {
    const id = ++nextRequestId;
    pendingRuns.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type: 'run', id, text: input, model });
  });
}

/**
 * Start loading the model in the background worker ahead of use, so the
 * first document doesn't wait for it. Never loads on the page thread when a
 * worker is available (that froze the page and loaded the model twice).
 */
export function preloadNer(): void {
  if (typeof window === 'undefined') return;
  const models: NerModelKey[] = getThoroughCheck() ? ['multilingual', 'clinical'] : ['multilingual'];
  const worker = getNerWorker();
  for (const model of models) {
    if (worker) worker.postMessage({ type: 'load', model });
    else void ensureNerLoaded(model);
  }
}

/** Stop any running detection. Pending calls reject with NerCancelledError. */
export function cancelNer(): void {
  if (!nerWorker) return;
  for (const id of Array.from(pendingRuns.keys())) nerWorker.postMessage({ type: 'cancel', id });
}

async function nerOneChunk(
  pipe: NerPipeline,
  text: string,
  offset: number,
  labels: Record<string, IdentifierLabel | null>
): Promise<Span[]> {
  if (text.trim().length === 0) return [];
  try {
    let raw = (await pipe(text)) as NerOutput[];
    if (raw.some((e) => typeof e.start !== 'number') && pipe.tokenizer) {
      // Tokenise exactly as the pipeline does, then align tokens to text.
      const { input_ids } = pipe.tokenizer(text, { truncation: true });
      const ids = Array.from(input_ids.data, (v) => Number(v));
      const tokens = pipe.tokenizer.model.convert_ids_to_tokens(ids);
      raw = withOffsets(raw, wordPieceOffsets(tokens, text));
    }
    const positioned = raw.filter(
      (e): e is PositionedNer => typeof e.start === 'number' && typeof e.end === 'number'
    );
    return rawNerToSpans(positioned, text, offset, labels);
  } catch (err) {
    // In the worker, setStatus only updates the worker's own copy; the error
    // is surfaced to the page through the returned (empty) result instead.
    setStatus({ error: (err as Error).message });
    return [];
  }
}

interface NerChunk {
  text: string;
  /** Offset of this chunk's first character in the original full text. */
  offset: number;
}

/** Model window (512) minus [CLS]/[SEP] and a small margin. */
const MAX_MODEL_TOKENS = 500;

/**
 * Split a chunk (at whitespace, near the middle) until each piece fits the
 * model's token window. Uses the pipeline's own tokenizer to count.
 */
export function fitToModel(
  pipe: { tokenizer?: NerTokenizer },
  chunk: NerChunk,
  depth = 0
): NerChunk[] {
  if (!pipe.tokenizer || depth > 8) return [chunk];
  const count = pipe.tokenizer(chunk.text, { truncation: false }).input_ids.data.length;
  if (count <= MAX_MODEL_TOKENS) return [chunk];
  const mid = Math.floor(chunk.text.length / 2);
  let cut = chunk.text.lastIndexOf('\n', mid);
  if (cut < chunk.text.length / 4) cut = chunk.text.lastIndexOf(' ', mid);
  if (cut <= 0) cut = mid;
  return [
    ...fitToModel(pipe, { text: chunk.text.slice(0, cut), offset: chunk.offset }, depth + 1),
    ...fitToModel(pipe, { text: chunk.text.slice(cut), offset: chunk.offset + cut }, depth + 1),
  ];
}

/**
 * Greedy chunker. Walks forward, taking up to maxChars at a time and snapping
 * the boundary back to the latest paragraph break, sentence end, or word
 * boundary so identifiers don't get split across chunks. Each chunk includes
 * its trailing delimiter so global offsets line up exactly with the original.
 */
function splitForNer(text: string, maxChars: number): NerChunk[] {
  if (text.length <= maxChars) return [{ text, offset: 0 }];
  const chunks: NerChunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (text.length - pos <= maxChars) {
      chunks.push({ text: text.slice(pos), offset: pos });
      break;
    }
    const hardLimit = pos + maxChars;
    // Don't snap further back than half the chunk size, or we waste capacity.
    const softFloor = pos + Math.floor(maxChars / 2);
    let end = hardLimit;
    const para = text.lastIndexOf('\n\n', hardLimit);
    if (para >= softFloor) {
      end = para + 2;
    } else {
      const sent = text.lastIndexOf('. ', hardLimit);
      if (sent >= softFloor) {
        end = sent + 2;
      } else {
        const space = text.lastIndexOf(' ', hardLimit);
        if (space >= softFloor) end = space + 1;
      }
    }
    chunks.push({ text: text.slice(pos, end), offset: pos });
    pos = end;
  }
  return chunks;
}
