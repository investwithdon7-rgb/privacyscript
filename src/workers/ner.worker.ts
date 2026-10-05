/**
 * Name-detection worker. Runs the NER models off the main thread so long
 * transcripts never freeze the page. Each model is loaded once (on first
 * use) and reused for every document (batch files included), cached by the
 * browser.
 *
 * Messages in:  { type: 'run', id, text, model } | { type: 'cancel', id } | { type: 'load', model }
 * Messages out: status | progress | result | cancelled | error
 *
 * Nothing leaves the device: the text stays in this worker's memory; only
 * the model files are fetched (once) from the model host.
 */

import {
  contactedHosts,
  downloadNotice,
  loadNerPipeline,
  nerOnText,
  NerCancelledError,
  NER_MODELS,
  type NerModelKey,
} from '@/engine/ner';

type Ctx = {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const ctx = self as unknown as Ctx;

const pipelines = new Map<NerModelKey, ReturnType<typeof loadNerPipeline>>();
const cancelled = new Set<number>();

function pipeline(key: NerModelKey) {
  let p = pipelines.get(key);
  if (!p) {
    ctx.postMessage({
      type: 'status',
      patch: { modelName: NER_MODELS[key].id, message: downloadNotice(key), loadProgress: 0 },
    });
    p = loadNerPipeline(key, (loadProgress, message) =>
      ctx.postMessage({ type: 'status', patch: { loadProgress, message } })
    ).then(
      (pipe) => {
        ctx.postMessage({
          type: 'status',
          patch: { loaded: true, loadProgress: 100, message: 'NER model ready.', error: null, networkHosts: contactedHosts() },
        });
        return pipe;
      },
      (err: Error) => {
        pipelines.delete(key); // allow a retry on the next document
        ctx.postMessage({
          type: 'status',
          patch: {
            loaded: false,
            error: err.message,
            message: `NER unavailable — regex engine running standalone (${err.message}).`,
          },
        });
        throw err;
      }
    );
    pipelines.set(key, p);
  }
  return p;
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as {
    type: 'run' | 'cancel' | 'load';
    id: number;
    text?: string;
    model?: NerModelKey;
  };
  const model = msg.model ?? 'multilingual';
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === 'load') {
    // Warm-up only; failures are reported through status messages.
    pipeline(model).catch(() => undefined);
    return;
  }
  if (msg.type !== 'run') return;

  const { id } = msg;
  let pipe;
  try {
    pipe = await pipeline(model);
  } catch {
    // Model unavailable (e.g. offline on first use): rules still run.
    ctx.postMessage({ type: 'result', id, spans: [] });
    return;
  }
  try {
    const spans = await nerOnText(pipe, msg.text ?? '', {
      model,
      onProgress: (done, total) => ctx.postMessage({ type: 'progress', id, done, total }),
      isCancelled: () => cancelled.has(id),
    });
    ctx.postMessage({ type: 'result', id, spans });
  } catch (err) {
    if (err instanceof NerCancelledError) ctx.postMessage({ type: 'cancelled', id });
    else ctx.postMessage({ type: 'error', id, message: (err as Error).message });
  } finally {
    cancelled.delete(id);
  }
};
