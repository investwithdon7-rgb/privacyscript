import { describe, expect, it } from 'vitest';
import { blackOutPixels, frameToGrey, nativePixels, type DicomElement, type DicomFile } from '@/formats/dicom';
import { boxesForRedactions, groupOcrLines, safetyNetRanges } from '@/formats/dicom-ocr';

const T = (hex: string) => parseInt(hex, 16) >>> 0;
const us = (v: number) => new Uint8Array([v & 0xff, v >> 8]);
const el = (tag: string, vr: string, value: Uint8Array): DicomElement => ({ tag: T(tag), vr, value });
const str = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function image(opts: { rows: number; cols: number; samples: 1 | 3; bits: 8 | 16; frames?: number; photometric: string; pixels: Uint8Array }): DicomFile {
  return {
    meta: [],
    transferSyntax: '1.2.840.10008.1.2.1',
    explicit: true,
    dataset: [
      el('00280002', 'US', us(opts.samples)),
      el('00280004', 'CS', str(opts.photometric)),
      ...(opts.frames ? [el('00280008', 'IS', str(String(opts.frames)))] : []),
      el('00280010', 'US', us(opts.rows)),
      el('00280011', 'US', us(opts.cols)),
      el('00280100', 'US', us(opts.bits)),
      el('00280103', 'US', us(0)),
      el('7FE00010', opts.bits === 8 ? 'OB' : 'OW', opts.pixels),
    ],
  };
}

describe('DICOM pixels', () => {
  it('reads 8-bit greyscale and blacks out a box in every frame', () => {
    const pixels = new Uint8Array(2 * 4 * 4).fill(200);
    const info = nativePixels(image({ rows: 4, cols: 4, samples: 1, bits: 8, frames: 2, photometric: 'MONOCHROME2', pixels }))!;
    expect(info.frames).toBe(2);
    const out = blackOutPixels(info, [{ x0: 1, y0: 1, x1: 3, y1: 2 }]);
    for (const f of [0, 1]) {
      const frame = Array.from(out.subarray(f * 16, f * 16 + 16));
      expect(frame).toEqual([200, 200, 200, 200, 200, 0, 0, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    }
  });

  it('blacks out interleaved RGB on all three channels', () => {
    const pixels = new Uint8Array(2 * 2 * 3).fill(255);
    const info = nativePixels(image({ rows: 2, cols: 2, samples: 3, bits: 8, photometric: 'RGB', pixels }))!;
    const out = blackOutPixels(info, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
    expect(Array.from(out.subarray(0, 6))).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('windows 16-bit frames to 0-255 for OCR', () => {
    const pixels = new Uint8Array([...us(100), ...us(4100)]);
    const info = nativePixels(image({ rows: 1, cols: 2, samples: 1, bits: 16, photometric: 'MONOCHROME2', pixels }))!;
    expect(Array.from(frameToGrey(info))).toEqual([0, 255]);
  });

  it('skips compressed pixel data', () => {
    const f = image({ rows: 2, cols: 2, samples: 1, bits: 8, photometric: 'MONOCHROME2', pixels: new Uint8Array(4) });
    f.dataset[f.dataset.length - 1] = { tag: T('7FE00010'), vr: 'OB', encapsulated: new Uint8Array(8) };
    expect(nativePixels(f)).toBeNull();
  });
});

describe('burned-in text lines', () => {
  const w = (text: string, x0: number, y0: number, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1: x0 + text.length * 6, y1: y0 + 10 } });

  it('groups words into lines in reading order and drops noise', () => {
    const lines = groupOcrLines([w('4471902', 80, 2), w('SMITH', 2, 1), w('JOHN', 40, 3), w('~', 200, 2, 12), w('LT', 2, 100), w('KIDNEY', 20, 101)]);
    expect(lines.map((l) => l.text)).toEqual(['SMITH JOHN 4471902', 'LT KIDNEY']);
    expect(lines[0].words.map((x) => [x.start, x.end])).toEqual([[0, 5], [6, 10], [11, 18]]);
  });

  it('splits a row at a wide gap (name left, hospital right)', () => {
    const lines = groupOcrLines([w('STENBERG,', 4, 3), w('KAROLINE', 60, 3), w('HOSPITAL', 300, 3)]);
    expect(lines.map((l) => l.text)).toEqual(['STENBERG, KAROLINE', 'HOSPITAL']);
  });

  it('safety net: misread header ID, long numbers and institution lines; clinical words stay', () => {
    // As OCR read a real test image: "4471902" came back as "4471802".
    const lines = groupOcrLines([
      w('STENBERG,', 4, 3), w('ST', 300, 3), w("MARY'S", 320, 3), w('HOSPITAL', 360, 3),
      w('ID', 4, 30), w('4471802', 30, 30), w('LT', 4, 160), w('KIDNEY', 24, 160),
    ]);
    const starts = [0, 100, 200, 300];
    const hits = safetyNetRanges(lines, starts, ['STENBERG^KAROLINE', '4471902']).map((r) => {
      const i = starts.findIndex((s, k) => r.start >= s && (k === starts.length - 1 || r.start < starts[k + 1]));
      return lines[i].text.slice(r.start - starts[i], r.end - starts[i]);
    });
    expect(hits).toEqual(['STENBERG,', 'ST', "MARY'S", 'HOSPITAL', '4471802']);
  });

  it('maps redacted character ranges back to padded word boxes', () => {
    const lines = groupOcrLines([w('SMITH', 2, 1), w('JOHN', 40, 1), w('LT', 2, 100), w('KIDNEY', 20, 100)]);
    // Lines start at 50 and 61 in the joined text; "SMITH JOHN" is redacted.
    const boxes = boxesForRedactions(lines, [50, 61], [{ start: 50, end: 60 }]);
    expect(boxes).toEqual([
      { x0: 0, y0: -1, x1: 34, y1: 13 },
      { x0: 38, y0: -1, x1: 66, y1: 13 },
    ]);
  });
});
