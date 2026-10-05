/**
 * Text burned into DICOM pixels (ultrasound banners, screenshots): read it
 * with OCR, turn it into reviewable lines, and map redacted words back to
 * pixel boxes for formats/dicom.ts to black out.
 *
 * Only the first frame is read: burned-in banners sit at the same place in
 * every frame, and the boxes are blacked out in all of them.
 */

import { frameToGrey, type PixelBox, type PixelInfo } from '@/formats/dicom';

export interface OcrWord {
  text: string;
  bbox: PixelBox;
  confidence: number;
}

export interface OcrLine {
  text: string;
  /** Words with their character range inside `text`. */
  words: Array<OcrWord & { start: number; end: number }>;
}

/** Words below this confidence are noise (speckle, ultrasound texture). */
const MIN_CONFIDENCE = 40;

/** Group OCR words into reading-order lines by vertical overlap. */
export function groupOcrLines(words: OcrWord[]): OcrLine[] {
  const kept = words.filter((w) => w.text.trim() && w.confidence >= MIN_CONFIDENCE);
  kept.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows: OcrWord[][] = [];
  for (const w of kept) {
    const mid = (w.bbox.y0 + w.bbox.y1) / 2;
    const row = rows.find((r) => mid >= r[0].bbox.y0 && mid <= r[0].bbox.y1);
    if (row) row.push(w);
    else rows.push([w]);
  }
  // A wide gap splits a row: banners put separate fields (name on the left,
  // hospital on the right) on the same row.
  const split = rows.flatMap((r) => {
    r.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const height = r.reduce((n, w) => n + (w.bbox.y1 - w.bbox.y0), 0) / r.length;
    const parts: OcrWord[][] = [[r[0]]];
    for (let i = 1; i < r.length; i++) {
      if (r[i].bbox.x0 - r[i - 1].bbox.x1 > 3 * height) parts.push([]);
      parts[parts.length - 1].push(r[i]);
    }
    return parts;
  });
  return split.map((r) => {
    let text = '';
    const lineWords = r.map((w) => {
      if (text) text += ' ';
      const start = text.length;
      text += w.text.trim();
      return { ...w, text: w.text.trim(), start, end: text.length };
    });
    return { text, words: lineWords };
  });
}

/**
 * Pixel boxes for every OCR word touched by a redaction. `lineStarts[i]` is
 * where line i starts in the joined text the engine read; `ranges` are the
 * replaced character ranges in that text.
 */
export function boxesForRedactions(
  lines: OcrLine[],
  lineStarts: number[],
  ranges: Array<{ start: number; end: number }>,
  pad = 2
): PixelBox[] {
  const boxes: PixelBox[] = [];
  lines.forEach((line, i) => {
    const L = lineStarts[i];
    for (const w of line.words) {
      const ws = L + w.start;
      const we = L + w.end;
      if (ranges.some((r) => r.start < we && r.end > ws)) {
        boxes.push({ x0: w.bbox.x0 - pad, y0: w.bbox.y0 - pad, x1: w.bbox.x1 + pad, y1: w.bbox.y1 + pad });
      }
    }
  });
  return boxes;
}

/** Same length and at most one character different (OCR reads 9 as 8). */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length || a.length < 5) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return true;
}

const INSTITUTION_WORD = /^(?:hospitals?|clinics?|infirmary|cent(?:er|re)|medical|health|trust|surgery|university|institute|imaging|radiology|nhs)$/i;

/**
 * Words in the picture blacked out whatever the text engine decided,
 * because OCR misreads and banners reprint the header:
 *  - parts of the patient's name or ID from the header, allowing one
 *    misread character;
 *  - any number of 5+ digits (IDs, accession and phone numbers);
 *  - a line naming an institution ("ST MARY'S HOSPITAL"): the header copy is
 *    removed by Annex E, so the burned-in copy goes too.
 */
export function safetyNetRanges(
  lines: OcrLine[],
  lineStarts: number[],
  headerValues: string[]
): Array<{ start: number; end: number }> {
  const tokens = headerValues
    .flatMap((v) => v.split(/[\\^\s,]+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  const ranges: Array<{ start: number; end: number }> = [];
  lines.forEach((line, i) => {
    const institution = line.words.some((w) => INSTITUTION_WORD.test(w.text.replace(/[^\p{L}]/gu, '')));
    for (const w of line.words) {
      const bare = w.text.replace(/[^\p{L}\p{N}-]/gu, '').toLowerCase();
      if (institution || /\d{5,}/.test(bare.replace(/-/g, '')) || tokens.some((t) => nearlyEqual(bare, t))) {
        ranges.push({ start: lineStarts[i] + w.start, end: lineStarts[i] + w.end });
      }
    }
  });
  return ranges;
}

/**
 * OCR the first frame (browser only). The frame is scaled up 2x, made dark
 * text on white (burned-in text is usually light on a dark image) and
 * thresholded, which is what Tesseract reads best. Boxes come back in the
 * image's own pixel coordinates.
 */
export async function readBurnedInText(info: PixelInfo): Promise<OcrLine[]> {
  const SCALE = 2;
  const grey = frameToGrey(info, 0);
  let sum = 0;
  for (const g of grey) sum += g;
  const darkBackground = sum / grey.length < 128;

  const src = document.createElement('canvas');
  src.width = info.cols;
  src.height = info.rows;
  const sctx = src.getContext('2d')!;
  const img = sctx.createImageData(info.cols, info.rows);
  for (let p = 0; p < grey.length; p++) {
    let g = darkBackground ? 255 - grey[p] : grey[p];
    g = g > 128 ? 255 : 0;
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = g;
    img.data[p * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);

  const big = document.createElement('canvas');
  big.width = info.cols * SCALE;
  big.height = info.rows * SCALE;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(src, 0, 0, big.width, big.height);

  const { recogniseCanvas } = await import('@/formats/pdf-scanned');
  const words = await recogniseCanvas(big);
  return groupOcrLines(
    words.map((w) => ({
      text: w.text,
      confidence: w.confidence,
      bbox: { x0: w.bbox.x0 / SCALE, y0: w.bbox.y0 / SCALE, x1: w.bbox.x1 / SCALE, y1: w.bbox.y1 / SCALE },
    }))
  );
}
