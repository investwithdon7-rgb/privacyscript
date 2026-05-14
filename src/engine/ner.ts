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

type NerPipeline = (text: string, options?: unknown) => Promise<NerOutput[]>;

interface NerOutput {
  entity: string;
  entity_group?: string;
  word: string;
  start: number;
  end: number;
  score: number;
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

function tagFor(entity: string): IdentifierLabel | null {
  const bare = entity.replace(/^[BI]-/, '');
  return NER_LABEL_MAP[bare] ?? null;
}

/**
 * Run NER on the given text. Returns spans aligned to the regex engine's Span
 * shape. Performs aggregation of B-/I- subword tokens into entities.
 */
export async function runClinicalNER(text: string): Promise<Span[]> {
  const pipe = await ensureNerLoaded();
  if (!pipe) return [];

  try {
    const raw = (await pipe(text, { aggregation_strategy: 'simple' } as unknown)) as NerOutput[];
    const spans: Span[] = [];
    for (const e of raw) {
      const label = tagFor(e.entity_group ?? e.entity);
      if (!label) continue;
      const category = label === 'INSTITUTION' ? 'QUASI' : 'HIPAA';
      spans.push({
        start: e.start,
        end: e.end,
        text: e.word,
        label,
        category,
        source: 'ner',
        confidence: e.score,
      });
    }
    return spans;
  } catch (err) {
    setStatus({ error: (err as Error).message });
    return [];
  }
}
