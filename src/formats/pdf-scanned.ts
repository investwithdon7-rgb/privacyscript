/**
 * Scanned PDF pipeline.
 *
 * Strategy
 * --------
 *   1. Render each PDF page to a canvas via pdfjs-dist (200 DPI by default,
 *      300 DPI fallback if OCR confidence < 80%).
 *   2. Pre-process: greyscale + binarisation to suppress scan artefacts.
 *   3. Send the page image to a Tesseract.js worker. Tesseract runs in its
 *      own Web Worker, off the main thread, so the UI stays responsive.
 *   4. Run multiple workers in parallel up to (hardwareConcurrency - 1),
 *      capped at 4 to keep RAM pressure manageable on 8 GB devices.
 *   5. Stream completed pages back so the UI can render progress.
 *
 * Worker pool singleton
 * ---------------------
 * The Tesseract worker pool is hoisted to a module-level lazy singleton
 * keyed by `(language : concurrency)`. The previous implementation built and
 * tore down workers on every document, throwing away ~12 MB of trained
 * language data per worker each time. With pooling, the second OCR run in a
 * session starts in milliseconds instead of seconds.
 *
 * Cancel semantics: `controller.cancel()` terminates the in-flight pool and
 * drops it from the singleton so the next document gets a fresh start. This
 * matches the previous behaviour for cancelled runs while keeping the
 * happy-path savings.
 *
 * Output reconstruction
 * ---------------------
 * Caller-selectable RedactionStyle (invisible / highlight / blackbar), default
 * 'invisible' so the redacted page reads like the original scan with the
 * substituted token in white space rather than a glaring black bar.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { RedactionStyle } from '@/formats/pdf-typed';
import { asset } from '@/lib/assets';

export interface ScannedPdfWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface ScannedPdfPage {
  pageIndex: number;
  text: string;
  words: ScannedPdfWord[];
  /** PDF user-space dimensions (1 DPI / 72 pt). */
  width: number;
  height: number;
  /** OCR DPI used to render this page. */
  ocrDpi: number;
  confidence: number;
}

export interface ScannedPdfIngest {
  pages: ScannedPdfPage[];
  fullText: string;
  /** Map global char offset → (pageIndex, offsetInPage). */
  globalMap: Array<{ pageIndex: number; offsetInPage: number }>;
  originalBytes: ArrayBuffer;
}

export interface ScanProgress {
  pagesDone: number;
  pagesTotal: number;
  currentPage?: number;
  message: string;
}

export interface ScanController {
  cancel: () => void;
}

const DEFAULT_DPI = 200;
const FALLBACK_DPI = 300;
const CONFIDENCE_FLOOR = 80;

/* ----------------------------------------------------------------------------
 * Worker pool singleton
 * --------------------------------------------------------------------------*/

interface TesseractWorker {
  recognize: (image: unknown) => Promise<{
    data: {
      text: string;
      confidence: number;
      words?: Array<{
        text: string;
        bbox: { x0: number; y0: number; x1: number; y1: number };
        confidence: number;
      }>;
    };
  }>;
  terminate: () => Promise<unknown>;
}

interface PoolEntry {
  key: string;
  workers: TesseractWorker[];
}

const poolPromises = new Map<string, Promise<PoolEntry>>();

async function acquirePool(
  languages: string,
  concurrency: number,
  workerPath: string,
  corePath: string,
  langPath: string
): Promise<PoolEntry> {
  const key = `${languages}:${concurrency}`;
  let p = poolPromises.get(key);
  if (!p) {
    p = (async () => {
      const Tesseract = await import('tesseract.js');
      const workers = await Promise.all(
        Array.from({ length: concurrency }, () =>
          Tesseract.createWorker(languages, undefined, {
            workerPath,
            corePath,
            // Self-hosted language data (public/tesseract/lang/). Without
            // this, tesseract.js silently fetches eng.traineddata from a
            // third-party CDN — blocked by the production CSP (OCR then
            // hangs forever with no error) and a violation of the
            // zero-external-calls guarantee.
            langPath,
            gzip: true,
            logger: (m: unknown) => {
              // Progress is driven per-page, not from tesseract's logger.
              // In dev, keep a ring buffer so a stalled engine init can be
              // diagnosed from the console (window.__tessLog).
              if (process.env.NODE_ENV !== 'production') {
                const g = globalThis as unknown as { __tessLog?: unknown[] };
                g.__tessLog = [...(g.__tessLog ?? []).slice(-49), m];
              }
            },
            errorHandler: (err: unknown) => {
              if (process.env.NODE_ENV !== 'production') {
                const g = globalThis as unknown as { __tessLog?: unknown[] };
                g.__tessLog = [...(g.__tessLog ?? []).slice(-49), { error: String(err) }];
              }
            },
          })
        )
      );
      return { key, workers: workers as unknown as TesseractWorker[] };
    })();
    poolPromises.set(key, p);
  }
  return p;
}

async function destroyPool(entry: PoolEntry): Promise<void> {
  poolPromises.delete(entry.key);
  await Promise.allSettled(entry.workers.map((w) => w.terminate()));
}

/* ----------------------------------------------------------------------------
 * Ingest
 * --------------------------------------------------------------------------*/

export async function ingestScannedPdf(
  bytes: ArrayBuffer,
  onProgress: (p: ScanProgress) => void,
  languages = 'eng'
): Promise<{ result: ScannedPdfIngest; controller: ScanController }> {
  const pdfjs = await import('pdfjs-dist');

  if (typeof window !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = asset('/pdf.worker.min.mjs');
  }

  // See scripts/copy-tesseract-assets.js — these are self-hosted to satisfy
  // the strict CSP. The paths MUST be absolute: tesseract.js loads its worker
  // via importScripts inside a blob-URL Worker, and relative URLs cannot
  // resolve against a blob: base — the worker dies during evaluation and
  // createWorker hangs forever with no error surfaced. corePath and langPath
  // are fetched from inside that same blob worker, so they need the origin too.
  const abs = (p: string) => new URL(asset(p), window.location.origin).href;
  const tesseractWorkerPath = abs('/tesseract/worker.min.js');
  const tesseractCorePath = abs('/tesseract/');
  const tesseractLangPath = abs('/tesseract/lang');

  // pdfjs-dist transfers the typed-array's buffer to its worker via postMessage,
  // detaching the original. Slice a copy so pdfjs transfers the clone while
  // `bytes` stays intact for pdf-lib reconstruction in reconstructScannedPdf.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await loadingTask.promise;

  // Cap at 4 workers even on high-core machines: each worker loads a ~12 MB
  // language pack and holds a WASM module in memory.
  const concurrency = Math.max(
    1,
    Math.min(pdf.numPages, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1))
  );

  let cancelled = false;
  let pool: PoolEntry | null = null;

  const controller: ScanController = {
    cancel: () => {
      cancelled = true;
      // Tear down the pool so in-flight OCR aborts immediately. Subsequent
      // documents will pay the cold-start cost again, which is the expected
      // behaviour after a user cancellation.
      if (pool) void destroyPool(pool);
    },
  };

  onProgress({
    pagesDone: 0,
    pagesTotal: pdf.numPages,
    message: 'Preparing the OCR engine (first run loads language data)…',
  });

  pool = await acquirePool(
    languages,
    concurrency,
    tesseractWorkerPath,
    tesseractCorePath,
    tesseractLangPath
  );

  onProgress({
    pagesDone: 0,
    pagesTotal: pdf.numPages,
    message: `Running OCR on ${pdf.numPages} page(s) with ${concurrency} worker(s)…`,
  });

  const pages: ScannedPdfPage[] = new Array(pdf.numPages);
  let done = 0;

  // Round-robin pages over workers.
  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < pdf.numPages; i++) {
    if (cancelled) break;
    const worker = pool.workers[i % concurrency];
    tasks.push(
      (async () => {
        if (cancelled) return;
        try {
          const result = await ocrPage(
            pdf as { getPage: (n: number) => Promise<unknown> },
            i + 1,
            worker
          );
          if (cancelled) return;
          pages[i] = result;
          done += 1;
          onProgress({
            pagesDone: done,
            pagesTotal: pdf.numPages,
            currentPage: i + 1,
            message: `Page ${i + 1} done (confidence ${Math.round(result.confidence)}%).`,
          });
        } catch (err) {
          // If the worker was terminated mid-OCR (cancel) the recognize call
          // rejects — swallow and let the cancel path drive the response.
          if (!cancelled) throw err;
        }
      })()
    );
  }
  await Promise.all(tasks);

  // Pool stays alive for the next document — do NOT terminate on the happy
  // path. The singleton is only torn down on explicit cancel.

  // Build globalMap + fullText.
  let fullText = '';
  const globalMap: ScannedPdfIngest['globalMap'] = [];
  pages.forEach((page) => {
    if (!page) return;
    for (let k = 0; k < page.text.length; k++) {
      globalMap.push({ pageIndex: page.pageIndex, offsetInPage: k });
    }
    fullText += page.text;
    fullText += '\n\n';
    for (let k = 0; k < 2; k++) {
      globalMap.push({ pageIndex: page.pageIndex, offsetInPage: page.text.length + k });
    }
  });

  return {
    result: {
      pages: pages.filter(Boolean),
      fullText,
      globalMap,
      originalBytes: bytes,
    },
    controller,
  };
}

// PDFPageProxy is typed strictly by pdfjs-dist but the type isn't exposed
// through our dynamic import — these structural aliases are loose enough to
// work without pulling the whole types package into our public API.
type PdfPageLike = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
    intent?: string;
  }) => { promise: Promise<void> };
};

async function ocrPage(
  pdf: { getPage: (n: number) => Promise<unknown> },
  pageNum: number,
  worker: TesseractWorker
): Promise<ScannedPdfPage> {
  const page = (await pdf.getPage(pageNum)) as PdfPageLike;
  let dpi = DEFAULT_DPI;
  let result = await renderAndRecognise(page, worker, dpi);

  if (result.confidence < CONFIDENCE_FLOOR) {
    dpi = FALLBACK_DPI;
    result = await renderAndRecognise(page, worker, dpi);
  }

  return {
    pageIndex: pageNum - 1,
    text: result.text,
    words: result.words,
    width: result.pdfWidth,
    height: result.pdfHeight,
    ocrDpi: dpi,
    confidence: result.confidence,
  };
}

async function renderAndRecognise(
  page: PdfPageLike,
  worker: TesseractWorker,
  dpi: number
) {
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;

  // intent 'print': pdf.js schedules 'display' rendering via
  // requestAnimationFrame, which never fires in a hidden tab — OCR would hang
  // forever the moment the user switches tabs while waiting. Print intent
  // uses timer-based scheduling and renders identically for OCR purposes.
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

  // Pre-process: greyscale + binarise.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const bw = grey > 180 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = bw;
  }
  ctx.putImageData(img, 0, 0);

  const ocr = await worker.recognize(canvas);
  const words: ScannedPdfWord[] = (ocr.data.words ?? []).map((w) => ({
    text: w.text,
    bbox: w.bbox,
    confidence: w.confidence,
  }));

  return {
    text: ocr.data.text,
    confidence: ocr.data.confidence,
    words,
    pdfWidth: viewport.width / scale,
    pdfHeight: viewport.height / scale,
    scale,
  };
}

/* ----------------------------------------------------------------------------
 * Reconstruction: redact + overlay
 * --------------------------------------------------------------------------*/

export interface ScannedRedaction {
  pageIndex: number;
  start: number;
  end: number;
  replacement: string;
}

export async function reconstructScannedPdf(
  ingest: ScannedPdfIngest,
  redactions: ScannedRedaction[],
  style: RedactionStyle = 'invisible'
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(ingest.originalBytes);
  // Scanned source has no usable font information (it's an image), so we use
  // Helvetica as the universal pdf-lib StandardFont. Black text on a white
  // fill (the 'invisible' default) reads cleanly against any scan.
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  const visual = visualForStyle(style);

  const byPage = new Map<number, ScannedRedaction[]>();
  for (const r of redactions) {
    if (!byPage.has(r.pageIndex)) byPage.set(r.pageIndex, []);
    byPage.get(r.pageIndex)!.push(r);
  }

  for (const [pageIdx, reds] of byPage) {
    const ingestPage = ingest.pages[pageIdx];
    const pdfPage = pages[pageIdx];
    if (!ingestPage || !pdfPage) continue;

    for (const r of reds) {
      const bbox = findBBoxForRange(ingestPage, r);
      if (!bbox) continue;

      if (/[^\x00-\xFF]/.test(r.replacement)) {
        console.warn(
          `[PrivacyScript] Replacement token "${r.replacement}" contains characters outside ` +
            'Helvetica WinAnsi range and may not render in the output PDF.'
        );
      }

      // Convert Tesseract pixel coords (top-left origin) to PDF coords
      // (bottom-left origin) using the OCR DPI scale.
      const scale = 72 / ingestPage.ocrDpi;
      const x = bbox.x0 * scale;
      const yTop = bbox.y0 * scale;
      const width = (bbox.x1 - bbox.x0) * scale;
      const height = (bbox.y1 - bbox.y0) * scale;
      const y = pdfPage.getHeight() - yTop - height;

      const rect: Parameters<typeof pdfPage.drawRectangle>[0] = {
        x: x - 1,
        y: y - 1,
        width: width + 2,
        height: height + 2,
        color: visual.fill,
      };
      if (visual.borderWidth > 0) {
        rect.borderColor = visual.border;
        rect.borderWidth = visual.borderWidth;
      }
      pdfPage.drawRectangle(rect);

      const fontSize = Math.min(height * 0.8, 9);
      pdfPage.drawText(r.replacement, {
        x: x + 2,
        y: y + (height - fontSize) / 2,
        size: fontSize,
        font: helv,
        color: visual.text,
        maxWidth: Math.max(width - 4, 20),
      });
    }
  }

  return await pdfDoc.save();
}

interface VisualSpec {
  fill: ReturnType<typeof rgb>;
  border: ReturnType<typeof rgb>;
  borderWidth: number;
  text: ReturnType<typeof rgb>;
}

function visualForStyle(style: RedactionStyle): VisualSpec {
  switch (style) {
    case 'blackbar':
      return {
        fill: rgb(0, 0, 0),
        border: rgb(0, 0, 0),
        borderWidth: 0,
        text: rgb(1, 1, 1),
      };
    case 'highlight':
      return {
        fill: rgb(0.93, 0.92, 0.99),
        border: rgb(0.31, 0.27, 0.9),
        borderWidth: 0.5,
        text: rgb(0.05, 0.05, 0.1),
      };
    case 'invisible':
    default:
      return {
        // White matches a typical scanned-paper background. The replacement
        // text reads as dark printing on the page rather than a redaction.
        fill: rgb(1, 1, 1),
        border: rgb(1, 1, 1),
        borderWidth: 0,
        text: rgb(0.05, 0.05, 0.1),
      };
  }
}

function findBBoxForRange(page: ScannedPdfPage, r: ScannedRedaction) {
  const pageText = page.text;
  let cursor = 0;
  let union: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const word of page.words) {
    const token = word.text.trim();
    if (!token) continue;
    const wordStart = pageText.indexOf(token, cursor);
    if (wordStart < 0) continue;
    const wordEnd = wordStart + token.length;
    cursor = wordEnd;

    if (wordEnd <= r.start || wordStart >= r.end) continue;
    union = union
      ? {
          x0: Math.min(union.x0, word.bbox.x0),
          y0: Math.min(union.y0, word.bbox.y0),
          x1: Math.max(union.x1, word.bbox.x1),
          y1: Math.max(union.y1, word.bbox.y1),
        }
      : { ...word.bbox };
  }
  return union;
}
