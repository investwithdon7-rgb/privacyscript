/**
 * Transformers.js NER integration.
 *
 * Primary clinical model: `d4data/biomedical-ner-all`.
 *   This is a fine-tuned biomedical NER model with ~107 entity types
 *   (disease, sign/symptom, medication, dosage, etc). We use it when an
 *   ONNX-converted, quantised copy is available (Xenova has not uploaded one
 *   to HF as of 2026-05; the v2 plan is to convert + host on the CDN bundle).
 *
 * Generic fallback: `Xenova/bert-base-NER` — already ONNX/INT8 on HF.
 *   We use this in v1 to add PER / LOC / ORG entity coverage on top of the
 *   regex catalogue. It catches free-text names the regex layer cannot.
 *
 * Caching: Transformers.js caches model files in IndexedDB via its own
 *   `env.allowLocalModels = false; env.useBrowserCache = true` defaults.
 *   First load is ~50MB and slow. Subsequent loads are instant.
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
}

export const NER_STATUS_INITIAL: NERStatus = {
  available: typeof window !== 'undefined',
  modelName: 'Xenova/bert-base-NER',
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

let pipelinePromise: Promise<NerPipeline | null> | null = null;
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
 * Lazily load the NER pipeline. Returns null on environments where Transformers
 * cannot run (SSR / Node tests). The function memoises so repeated calls share
 * the same load.
 */
export function ensureNerLoaded(): Promise<NerPipeline | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    setStatus({ message: 'Downloading NER model (~50MB)…', loadProgress: 0 });
    try {
      const tx = await import('@xenova/transformers');

      // Point ORT at our statically-served WASM binaries (copied to public/wasm/
      // by scripts/copy-ort-wasm.js). Without this, ORT defaults to looking
      // next to the webpack chunk URL (/_next/static/chunks/…wasm) which 404s.
      tx.env.backends.onnx.wasm.wasmPaths = `${BASE_PATH}/wasm/`;

      // Disable threading — the threaded worker JS files are not bundled and
      // require an additional copy step. Single-threaded WASM is fast enough
      // for the text volumes PrivacyScript processes.
      tx.env.backends.onnx.wasm.numThreads = 1;

      // Allow remote model fetch; cache in IndexedDB.
      tx.env.allowLocalModels = false;
      tx.env.useBrowserCache = true;
      const pipeline = await tx.pipeline(
        'token-classification',
        'Xenova/bert-base-NER',
        {
          quantized: true,
          progress_callback: (p: { progress?: number; status?: string }) => {
            if (typeof p.progress === 'number') {
              setStatus({
                loadProgress: Math.min(100, Math.round(p.progress)),
                message: p.status ?? 'Loading model…',
              });
            }
          },
        }
      );
      setStatus({
        loaded: true,
        loadProgress: 100,
        message: 'NER model ready.',
        error: null,
      });
      return pipeline as unknown as NerPipeline;
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

  return pipelinePromise;
}

/**
 * Map Xenova/bert-base-NER's BIO labels (B-PER, I-PER, B-LOC, I-LOC, B-ORG, I-ORG,
 * B-MISC, I-MISC) onto our IdentifierLabel set. PER → NAME (stored as a custom
 * label in the engine since we don't auto-redact via regex; NER provides it).
 */
const NER_LABEL_MAP: Record<string, IdentifierLabel | null> = {
  PER: 'NAME',
  LOC: 'ADDRESS_LINE',
  ORG: 'INSTITUTION',
  MISC: null,
};

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
    const type = tag.replace(/^[BI]-/, '');
    const isContinuation =
      tag.startsWith('I-') || (current !== null && e.start === current.end);
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
]);

/**
 * Convert raw pipeline output into engine spans: aggregate BIO tokens, snap
 * span edges to word boundaries (a fragment like "Weer" inside "Weeranayake"
 * expands to the whole word so the redaction never leaves half a name behind),
 * and drop anything under 3 characters — those are stray subword tokens with
 * no identifying value, pure noise in the review UI.
 */
export function rawNerToSpans(raw: PositionedNer[], text: string, offset: number): Span[] {
  const spans: Span[] = [];
  for (const g of aggregateEntities(raw, text)) {
    const label = NER_LABEL_MAP[g.type] ?? null;
    if (!label) continue;

    let start = g.start;
    let end = g.end;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;

    const value = text.slice(start, end);
    if (value.trim().length < 3) continue;
    if (NER_DOCUMENT_WORDS.has(value.trim().toLowerCase())) continue;

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

/**
 * Run NER on the given text. Returns spans aligned to the regex engine's Span
 * shape. Performs aggregation of B-/I- subword tokens into entities.
 *
 * Chunking
 * --------
 * BERT models have a 512-token attention window. On English clinical text the
 * empirical token-to-char ratio is ~0.25 (4 chars / token), so we cap each
 * chunk at 1600 characters and break on paragraph → sentence → word
 * boundaries (in that priority order) to keep entities intact.
 *
 * Previously the pipeline was called with the FULL text in one shot — for any
 * document longer than ~2 KB the transformer silently truncated, so the back
 * half of long discharge summaries never saw NER. Chunking restores full
 * coverage at no extra wall-clock cost (the chunks run in parallel; the WASM
 * backend is single-threaded but the micro-task overhead of awaiting each
 * pipeline call disappears under Promise.all).
 */
export async function runClinicalNER(text: string): Promise<Span[]> {
  const pipe = await ensureNerLoaded();
  if (!pipe) return [];

  // The character budget assumes ~4 chars per token, which fails badly for
  // timestamp- or number-heavy text (a caption timing line is ~20 tokens).
  // Anything past 512 tokens is silently truncated by the model, so split
  // each chunk further until it really fits.
  const chunks = splitForNer(text, 1600).flatMap((c) => fitToModel(pipe, c));
  const all = await Promise.all(chunks.map((c) => nerOneChunk(pipe, c.text, c.offset)));

  // Dedupe by (start, end, label) — overlapping chunks could otherwise emit
  // the same entity twice. Boundaries are clean but a long sentence that
  // happens to mention the same name twice across two chunks gives identical
  // global spans which the merge step will already handle, but we filter
  // here too so the output is tidier for the diff viewer.
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const arr of all) {
    for (const s of arr) {
      const key = `${s.start} ${s.end} ${s.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

async function nerOneChunk(
  pipe: NerPipeline,
  text: string,
  offset: number
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
    return rawNerToSpans(positioned, text, offset);
  } catch (err) {
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
