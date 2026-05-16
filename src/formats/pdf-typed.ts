/**
 * Typed PDF pipeline.
 *
 * Parse: pdfjs-dist extracts text content per page with character-level
 * positions (transform matrix + width). We build a flat string per page and
 * remember the (itemIndex, charOffsetInItem) for every global char position so
 * we can map detected spans back to bounding boxes.
 *
 * Reconstruct: pdf-lib loads the original PDF. For each detected span we draw
 * a filled rectangle over the original text (white in light mode, with a
 * subtle indigo accent) and write the replacement text in DM Mono on top.
 *
 * v1 constraints:
 *  - Replacement text wraps to one line. If it exceeds the original width we
 *    truncate visually (it's still present in the audit log / mapping).
 *  - Font is bundled Helvetica (pdf-lib's built-in); DM Mono is not embeddable
 *    into pdf-lib without a font fetch, which would violate the no-network
 *    rule. Helvetica reads close enough for the redacted text.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface PdfPageText {
  pageIndex: number;
  /** Concatenated text for this page (items joined with '\n' on item breaks). */
  text: string;
  /** Per-character map: which item it lives in + char offset within the item. */
  charMap: Array<{ itemIdx: number; offsetInItem: number }>;
  items: PdfTextItem[];
  width: number;
  height: number;
}

export interface PdfTextItem {
  str: string;
  /** PDF user-space transform: [a, b, c, d, e, f]. e,f = bottom-left in PDF coords. */
  transform: number[];
  width: number;
  height: number;
}

export interface PdfIngest {
  pages: PdfPageText[];
  fullText: string;
  /** Map global char offset → (pageIndex, offsetWithinPageText). */
  globalMap: Array<{ pageIndex: number; offsetInPage: number }>;
  originalBytes: ArrayBuffer;
}

/**
 * Configure the pdfjs worker once. Imported lazily so the bundle stays small
 * for users who never touch a PDF.
 */
async function loadPdfjs() {
  // Dynamic import — keeps pdfjs out of the initial bundle.
  const pdfjs = await import('pdfjs-dist');
  // Static export ships the worker at <basePath>/pdf.worker.min.mjs
  // (see scripts/copy-pdf-worker.js + next.config.js basePath).
  if (typeof window !== 'undefined') {
    const { asset } = await import('@/lib/assets');
    pdfjs.GlobalWorkerOptions.workerSrc = asset('/pdf.worker.min.mjs');
  }
  return pdfjs;
}

export async function ingestPdf(bytes: ArrayBuffer): Promise<PdfIngest> {
  const pdfjs = await loadPdfjs();
  // pdfjs-dist transfers the typed-array's buffer to its worker via postMessage,
  // which detaches the original ArrayBuffer. Slice a copy so pdfjs can own the
  // clone while we retain `bytes` unmodified for pdf-lib reconstruction later.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await loadingTask.promise;

  const pages: PdfPageText[] = [];
  let fullText = '';
  const globalMap: PdfIngest['globalMap'] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();

    const items: PdfTextItem[] = (tc.items as any[])
      .filter((it) => 'str' in it)
      .map((it) => ({
        str: it.str as string,
        transform: it.transform as number[],
        width: it.width as number,
        height: it.height as number,
      }));

    let pageText = '';
    const charMap: PdfPageText['charMap'] = [];
    items.forEach((item, idx) => {
      for (let c = 0; c < item.str.length; c++) {
        charMap.push({ itemIdx: idx, offsetInItem: c });
      }
      pageText += item.str;
      // Join items with a space so identifiers don't fuse across items.
      pageText += ' ';
      charMap.push({ itemIdx: idx, offsetInItem: item.str.length });
    });

    pages.push({
      pageIndex: i - 1,
      text: pageText,
      charMap,
      items,
      width: viewport.width,
      height: viewport.height,
    });

    // Track the global offset → (page, in-page offset) mapping.
    const startGlobal = fullText.length;
    for (let k = 0; k < pageText.length; k++) {
      globalMap.push({ pageIndex: i - 1, offsetInPage: k });
    }
    fullText += pageText;
    // Page break that no regex will match across.
    fullText += '\n\n';
    for (let k = 0; k < 2; k++) {
      globalMap.push({ pageIndex: i - 1, offsetInPage: pageText.length + k });
    }
  }

  return { pages, fullText, globalMap, originalBytes: bytes };
}

export interface PdfRedaction {
  pageIndex: number;
  /** Global char offset start (into fullText). */
  start: number;
  end: number;
  replacement: string;
}

/**
 * Build a redacted PDF: draw white rectangles over the original spans and
 * write replacement text on top. Returns a Uint8Array suitable for download.
 */
export async function reconstructPdf(
  ingest: PdfIngest,
  redactions: PdfRedaction[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(ingest.originalBytes);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  // Group redactions by page so we can draw them efficiently.
  const byPage = new Map<number, PdfRedaction[]>();
  for (const r of redactions) {
    if (!byPage.has(r.pageIndex)) byPage.set(r.pageIndex, []);
    byPage.get(r.pageIndex)!.push(r);
  }

  for (const [pageIdx, reds] of byPage) {
    const ingestPage = ingest.pages[pageIdx];
    const pdfPage = pages[pageIdx];
    if (!ingestPage || !pdfPage) continue;

    for (const r of reds) {
      // Translate global offsets to per-page offsets.
      const startPage = ingest.globalMap[r.start];
      const endPage = ingest.globalMap[r.end - 1];
      if (!startPage || !endPage) continue;
      if (startPage.pageIndex !== pageIdx) continue;

      // Find the items the span covers.
      const startMap = ingestPage.charMap[startPage.offsetInPage];
      const endMap = ingestPage.charMap[endPage.offsetInPage];
      if (!startMap || !endMap) continue;

      // Collect all items the span touches (may span multiple lines).
      const startItem = ingestPage.items[startMap.itemIdx];
      if (!startItem) continue;
      const touchedItems: PdfTextItem[] = [];
      for (let ii = startMap.itemIdx; ii <= endMap.itemIdx; ii++) {
        const item = ingestPage.items[ii];
        if (item) touchedItems.push(item);
      }

      // Group touched items by y-baseline (rounded to 1 pt) so we draw one
      // rectangle per visual line. A naïve single rectangle fails when the span
      // crosses a line break: endX < startX → negative width.
      const lineMap = new Map<number, PdfTextItem[]>();
      for (const item of touchedItems) {
        const yKey = Math.round(item.transform[5]);
        if (!lineMap.has(yKey)) lineMap.set(yKey, []);
        lineMap.get(yKey)!.push(item);
      }
      // Sort lines top-to-bottom in PDF coords (higher y = higher on page).
      const lines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]);

      lines.forEach(([, lineItems], lineNum) => {
        const lx  = lineItems[0].transform[4];
        const ly  = lineItems[0].transform[5];
        const lh  = lineItems[0].height || 12;
        const lastItem = lineItems[lineItems.length - 1];
        const lw  = Math.max(20, lastItem.transform[4] + lastItem.width - lx);

        pdfPage.drawRectangle({
          x: lx - 1,
          y: ly - 1,
          width: lw + 2,
          height: lh + 2,
          color: rgb(0.93, 0.92, 0.99),
          borderColor: rgb(0.31, 0.27, 0.9),
          borderWidth: 0.5,
        });

        // Write replacement text only on the first (topmost) line so it isn't
        // repeated across every line of a multi-line span.
        if (lineNum === 0) {
          const fontSize = Math.min(lh * 0.85, 10);
          pdfPage.drawText(r.replacement, {
            x: lx,
            y: ly + 1,
            size: fontSize,
            font: helv,
            color: rgb(0.05, 0.05, 0.1),
            maxWidth: lw,
          });
        }
      });
    }
  }

  return await pdfDoc.save();
}
