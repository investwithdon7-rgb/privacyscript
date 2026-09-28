/**
 * Name-detection worker. Runs the NER model off the main thread so long
 * transcripts never freeze the page. One model instance, loaded once and
 * reused for every document (batch files included), cached by the browser.
 *
 * Messages in:  { type: 'run', id, text } | { type: 'cancel', id }
 * Messages out: status | progress | result | cancelled | error
 *
 * Nothing leaves the device: the text stays in this worker's memory; only
 * the model files are fetched (once) from the model host.
 */

import { loadNerPipeline, nerOnText, NerCancelledError } from '@/engine/ner';

type Ctx = {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const ctx = self as unknown as Ctx;

let pipelinePromise: ReturnType<typeof loadNerPipeline> | null = null;
const cancelled = new Set<number>();

function pipeline() {
  if (!pipelinePromise) {
    ctx.postMessage({
      type: 'status',
      patch: { message: 'Downloading name-detection model (~135 MB, once)…', loadProgress: 0 },
    });
    pipelinePromise = loadNerPipeline((loadProgress, message) =>
      ctx.postMessage({ type: 'status', patch: { loadProgress, message } })
    ).then(
      (p) => {
        ctx.postMessage({
          type: 'status',
          patch: { loaded: true, loadProgress: 100, message: 'NER model ready.', error: null },
        });
        return p;
      },
      (err: Error) => {
        pipelinePromise = null; // allow a retry on the next document
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
  }
  return pipelinePromise;
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: 'run' | 'cancel' | 'load'; id: number; text?: string };
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === 'load') {
    // Warm-up only; failures are reported through status messages.
    pipeline().catch(() => undefined);
    return;
  }
  if (msg.type !== 'run') return;

  const { id } = msg;
  let pipe;
  try {
    pipe = await pipeline();
  } catch {
    // Model unavailable (e.g. offline on first use): rules still run.
    ctx.postMessage({ type: 'result', id, spans: [] });
    return;
  }
  try {
    const spans = await nerOnText(pipe, msg.text ?? '', {
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
