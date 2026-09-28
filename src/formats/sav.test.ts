/**
 * SPSS .sav reader tests. The writer below produces minimal but valid system
 * files (per the PSPP system-file specification) with fictitious data.
 */

import { describe, expect, it } from 'vitest';
import { readSav } from '@/formats/sav';
import { parseCsv } from '@/formats/csv';

interface Var { name: string; width: number; label?: string; format?: number }

const SPSS_EPOCH_OFFSET = 12219379200;
const spssDate = (iso: string) => Date.parse(iso) / 1000 + SPSS_EPOCH_OFFSET;

class Writer {
  private chunks: number[] = [];
  int32(v: number) { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, v, true); this.push(b); }
  float64(v: number) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); this.push(b); }
  text(s: string, len: number) {
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < len; i++) this.chunks.push(i < bytes.length ? bytes[i] : 0x20);
  }
  raw(bytes: Uint8Array) { this.chunks.push(...bytes); }
  private push(v: DataView) { for (let i = 0; i < v.byteLength; i++) this.chunks.push(v.getUint8(i)); }
  buffer(): ArrayBuffer { return new Uint8Array(this.chunks).buffer; }
}

export function buildSav(vars: Var[], rows: Array<Array<number | string | null>>, compressed: boolean): ArrayBuffer {
  const w = new Writer();
  const segs = (v: Var) => (v.width === 0 ? 1 : Math.ceil(v.width / 8));
  w.text('$FL2', 4);
  w.text('@(#) SPSS DATA FILE test', 60);
  w.int32(2);
  w.int32(vars.reduce((n, v) => n + segs(v), 0));
  w.int32(compressed ? 1 : 0);
  w.int32(0);
  w.int32(rows.length);
  w.float64(100);
  w.text('01 Jan 26', 9); w.text('10:00:00', 8); w.text('', 64); w.text('', 3);

  vars.forEach((v, i) => {
    const short = `V${i}`;
    const labelBytes = v.label ? new TextEncoder().encode(v.label) : null;
    w.int32(2); w.int32(v.width); w.int32(labelBytes ? 1 : 0); w.int32(0);
    const fmt = ((v.format ?? (v.width ? 1 : 5)) << 16) | ((v.width || 8) << 8) | 0;
    w.int32(fmt); w.int32(fmt);
    w.text(short, 8);
    if (labelBytes) {
      w.int32(labelBytes.length);
      w.raw(labelBytes);
      w.raw(new Uint8Array((4 - (labelBytes.length % 4)) % 4));
    }
    for (let s = 1; s < segs(v); s++) {
      w.int32(2); w.int32(-1); w.int32(0); w.int32(0); w.int32(0); w.int32(0); w.text('', 8);
    }
  });
  // 7.13 long variable names, 7.20 encoding.
  const longNames = vars.map((v, i) => `V${i}=${v.name}`).join('\t');
  w.int32(7); w.int32(13); w.int32(1); w.int32(longNames.length); w.text(longNames, longNames.length);
  w.int32(7); w.int32(20); w.int32(1); w.int32(5); w.text('UTF-8', 5);
  w.int32(999); w.int32(0);

  if (!compressed) {
    for (const row of rows) {
      vars.forEach((v, i) => {
        const val = row[i];
        if (v.width === 0) w.float64(val === null ? -Number.MAX_VALUE : (val as number));
        else w.text(String(val ?? ''), segs(v) * 8);
      });
    }
    return w.buffer();
  }

  // Bytecode compression: 8 command bytes, then any raw 8-byte values.
  let codes: number[] = [];
  let data: Uint8Array[] = [];
  const flush = () => {
    while (codes.length < 8) codes.push(0);
    w.raw(new Uint8Array(codes));
    for (const d of data) w.raw(d);
    codes = [];
    data = [];
  };
  const emit = (code: number, raw?: Uint8Array) => {
    codes.push(code);
    if (raw) data.push(raw);
    if (codes.length === 8) flush();
  };
  for (const row of rows) {
    vars.forEach((v, i) => {
      const val = row[i];
      if (v.width === 0) {
        if (val === null) emit(255);
        else if (Number.isInteger(val) && (val as number) + 100 >= 1 && (val as number) + 100 <= 251) emit((val as number) + 100);
        else { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, val as number, true); emit(253, new Uint8Array(b.buffer)); }
      } else {
        const bytes = new TextEncoder().encode(String(val ?? ''));
        for (let s = 0; s < segs(v); s++) {
          const chunk = new Uint8Array(8).fill(0x20);
          chunk.set(bytes.slice(s * 8, s * 8 + 8));
          if (chunk.every((b) => b === 0x20)) emit(254);
          else emit(253, chunk);
        }
      }
    });
  }
  emit(252);
  if (codes.length) flush();
  return w.buffer();
}

const VARS: Var[] = [
  { name: 'participant_name', width: 16, label: 'Participant name' },
  { name: 'age', width: 0, label: 'What is your age?' },
  { name: 'date_of_birth', width: 0, label: 'Date of birth', format: 20 },
  { name: 'satisfaction', width: 0, label: 'How satisfied are you?' },
  { name: 'bmi', width: 0 },
];
const ROWS: Array<Array<number | string | null>> = [
  ['Zoë Müller', 34, spssDate('1990-05-17'), 4, 22.5],
  ['Tom Jones', 71, spssDate('1953-01-02'), null, 31.25],
];

describe.each([false, true])('readSav (compressed=%s)', (compressed) => {
  const result = readSav(buildSav(VARS, ROWS, compressed));
  const csv = parseCsv(result.csv);

  it('uses long variable names and keeps labels as question text', () => {
    expect(csv.headers).toEqual(['participant_name', 'age', 'date_of_birth', 'satisfaction', 'bmi']);
    expect(result.labels.age).toBe('What is your age?');
    expect(result.caseCount).toBe(2);
  });

  it('decodes UTF-8 strings, numbers, dates and system-missing', () => {
    expect(csv.rows[0]).toEqual({
      participant_name: 'Zoë Müller', age: '34', date_of_birth: '1990-05-17', satisfaction: '4', bmi: '22.5',
    });
    expect(csv.rows[1].satisfaction).toBe('');
    expect(csv.rows[1].bmi).toBe('31.25');
  });
});

describe('readSav errors', () => {
  it('explains ZSAV files instead of failing obscurely', () => {
    const buf = new TextEncoder().encode('$FL3' + ' '.repeat(200)).buffer;
    expect(() => readSav(buf)).toThrow(/ZSAV/);
  });
  it('rejects non-SPSS files', () => {
    expect(() => readSav(new TextEncoder().encode('hello world, not spss at all').buffer)).toThrow(/not an SPSS/);
  });
});
