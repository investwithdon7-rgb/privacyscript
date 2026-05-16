/**
 * Scanned PDF pipeline (Session 10).
 *
 * Strategy:
 *   1. Render each PDF page to a canvas via pdfjs-dist (200 DPI by default,
 *      300 DPI fallback if OCR confidence < 80%).
 *   2. Pre-process the canvas: greyscale + binarisation to suppress scan
 *      artefacts.
 *   3. Send the page image to a Tesseract.js worker. Tesseract runs in its
 *      own Web Worker, off the main thread, so the UI stays responsive.
 *   4. Run multiple workers in parallel up to (hardwareConcurrency - 1),
 *      reserving one core for the UI.
 *   5. Stream completed pages back so the UI can render progress.
 *   6. Cancellation: each worker can be terminated cleanly. Pages already
 *      completed are kept.
 *
 * Output reconstruction:
 *   - Load original PDF with pdf-lib.
 *   - For each detected identifier, find its (page, x, y, width, height)
 *     bounding box from the Tesseract word-level result and draw a redaction
 *     rectangle on the original page.
 *   - The result is the original scan with redacted regions painted over.
 *     The new text layer (the replacement tokens) is written below each box,
 *     making the redacted document searchable post-de-identification.
 *
 * Performance:
 *   - English-only language pack (~12MB) instead of the full multi-language
 *     pack (~40MB). Saves bandwidth and load time.
 *   - Tesseract.js caches the language data in IndexedDB after first use.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
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

/**
 * Render and OCR a scanned PDF. Returns the structured ingest and an abort
 * controller so the caller can cancel mid-flight.
 *
 * @param languages - Tesseract language code(s), e.g. "eng" or "eng+fra".
 *   Defaults to English. Passed through to Tesseract.createWorker so the
 *   caller can support multi-language documents without forking the pipeline.
 */
export async function ingestScannedPdf(
  bytes: ArrayBuffer,
  onProgress: (p: ScanProgress) => void,
  languages = 'eng'
): Promise<{ result: ScannedPdfIngest; controller: ScanController }> {
  const pdfjs = await import('pdfjs-dist');
  const Tesseract = await import('tesseract.js');

  if (typeof window !== 'undefined') {
    const { asset } = await import('@/lib/assets');
    pdfjs.GlobalWorkerOptions.workerSrc = asset('/pdf.worker.min.mjs');
  }

  // Self-hosted Tesseract asset paths — required to satisfy the nonce-based CSP.
  //
  // Tesseract.js creates a blob: Worker and from within it calls importScripts()
  // twice: once for worker.min.js (workerPath) and once for the matching
  // tesseract-core-*.wasm.js (corePath + variant name). Both importScripts()
  // calls are governed by script-src; loading from cdn.jsdelivr.net would be
  // blocked. scripts/copy-tesseract-assets.js copies all required files into
  // public/tesseract/ at build time so every call is same-origin.
  //
  // Language data (.traineddata) is still fetched from cdn.jsdelivr.net on first
  // use (connect-src permits it) and cached in IndexedDB thereafter.
  const tesseractWorkerPath = asset('/tesseract/worker.min.js');
  const tesseractCorePath   = asset('/tesseract/');

  // pdfjs-dist transfers the typed-array's buffer to its worker via postMessage,
  // detaching the original. Slice a copy so pdfjs transfers the clone while
  // `bytes` stays intact for pdf-lib reconstruction in reconstructScannedPdf.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await loadingTask.promise;

  // Cap at 4 workers even on high-core machines: each worker loads a ~12 MB
  // language pack and holds a WASM module in memory. Beyond 4, RAM pressure
  // (especially on 8 GB devices) causes the tab to be killed before benefits
  // of extra parallelism kick in.
  const concurrency = Math.max(
    1,
    Math.min(pdf.numPages, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1))
  );

  let cancelled = false;
  const workers: Array<Awaited<ReturnType<typeof Tesseract.createWorker>>> = [];
  const controller: ScanController = {
    cancel: () => {
      cancelled = true;
      for (const w of workers) void w.terminate();
    },
  };

  // Pool of workers; each loads the requested language data once and is reused per page.
  const pool = await Promise.all(
    Array.from({ length: concurrency }, () =>
      Tesseract.createWorker(languages, undefined, {
        // Self-hosted paths so importScripts() satisfies the script-src CSP.
        workerPath: tesseractWorkerPath,
        corePath:   tesseractCorePath,
        logger: () => {
          // No logger — we drive progress per-page instead.
        },
      })
    )
  );
  workers.push(...pool);

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
    const worker = pool[i % concurrency];
    tasks.push(
      (async () => {
        if (cancelled) return;
        const result = await ocrPage(pdf as { getPage: (n: number) => Promise<unknown> }, i + 1, worker as TesseractWorker);
        if (cancelled) return;
        pages[i] = result;
        done += 1;
        onProgress({
          pagesDone: done,
          pagesTotal: pdf.numPages,
          currentPage: i + 1,
          message: `Page ${i + 1} done (confidence ${Math.round(result.confidence)}%).`,
        });
      })()
    );
  }
  await Promise.all(tasks);

  // Tidy workers.
  await Promise.all(pool.map((w) => w.terminate()));

  // Build globalMap + fullText.
  let fullText = '';
  const globalMap: ScannedPdfIngest['globalMap'] = [];
  pages.forEach((page) => {
    if (!page) return;
    const startGlobal = fullText.length;
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

interface TesseractWorker {
  recognize: (image: unknown) => Promise<{
    data: {
      text: string;
      confidence: number;
      words?: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }>;
    };
  }>;
  terminate: () => Promise<unknown>;
}

// PDFPageProxy is typed strictly by pdfjs-dist but the type isn't exposed
// through our dynamic import — these structural aliases are loose enough to
// work without pulling the whole types package into our public API.
type PdfPageLike = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
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

  await page.render({ canvasContext: ctx, viewport }).promise;

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

  // PDF user-space dimensions = viewport / scale.
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
  redactions: ScannedRedaction[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(ingest.originalBytes);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

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

      // Convert Tesseract pixel coords (top-left origin) to PDF coords
      // (bottom-left origin) using the OCR DPI scale.
      const scale = 72 / ingestPage.ocrDpi;
      const x = bbox.x0 * scale;
      const yTop = bbox.y0 * scale;
      const width = (bbox.x1 - bbox.x0) * scale;
      const height = (bbox.y1 - bbox.y0) * scale;
      const y = pdfPage.getHeight() - yTop - height;

      pdfPage.drawRectangle({
        x: x - 1,
        y: y - 1,
        width: width + 2,
        height: height + 2,
        color: rgb(0.05, 0.05, 0.05),
        borderColor: rgb(0.31, 0.27, 0.9),
        borderWidth: 0.5,
      });

      const fontSize = Math.min(height * 0.8, 9);
      pdfPage.drawText(r.replacement, {
        x: x + 2,
        y: y + (height - fontSize) / 2,
        size: fontSize,
        font: helv,
        color: rgb(1, 1, 1),
        maxWidth: Math.max(width - 4, 20),
      });
    }
  }

  return await pdfDoc.save();
}

function findBBoxForRange(page: ScannedPdfPage, r: ScannedRedaction) {
  const text = page.text;
  let cursor = 0;
  let union: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const word of page.words) {
    // Skip empty / whitespace-only tokens — Tesseract emits these between
    // words. `indexOf('', cursor)` always returns cursor, causing alignment
    // drift that shifts every subsequent word's bbox match.
    const token = word.text.trim();
    if (!token) continue;

    const wordStart = text.indexOf(token, cursor);
    if (wordStart < 0) continue;
    const wordEnd = wordStart + token.length;
    cursor = wordEnd;

    // Translate r.start/r.end (which are page-text offsets via globalMap) to
    // overlap with this word's range.
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
