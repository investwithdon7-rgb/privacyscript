/**
 * Minimal SPSS .sav reader (system files), for survey datasets.
 *
 * Supports: uncompressed and bytecode-compressed files (SPSS's default
 * "compressed" save), either byte order, variable labels, long variable
 * names (record 7.13), very long strings (7.14), character encoding (7.20),
 * and SPSS date/time formats (converted to ISO text so the date generalisers
 * work). ZSAV (zlib, .zsav) is not supported — the user is told how to save
 * a compatible file.
 *
 * Output is CSV text plus each variable's label, which is used like a
 * Qualtrics question row to classify columns. Value labels are not applied:
 * codes are kept so the output stays compatible with the analysis syntax.
 */

export interface SavResult {
  csv: string;
  /** Variable name → variable label (question text). */
  labels: Record<string, string>;
  caseCount: number;
}

interface Variable {
  shortName: string;
  name: string;
  /** 0 = numeric, >0 = string width in bytes. */
  width: number;
  label: string;
  /** SPSS print format type (20 = DATE, 22 = DATETIME, …). */
  formatType: number;
  decimals: number;
  /** Number of 8-byte segments this variable occupies in a case. */
  segments: number;
}

/** SPSS epoch is 1582-10-14; seconds between it and the Unix epoch. */
const SPSS_EPOCH_OFFSET = 12219379200;
const DATE_FORMATS = new Set([20, 23, 24, 28, 29, 30, 38, 39]);
const DATETIME_FORMATS = new Set([22]);

class Reader {
  pos = 0;
  constructor(readonly view: DataView, readonly little: boolean) {}
  int32(): number { const v = this.view.getInt32(this.pos, this.little); this.pos += 4; return v; }
  float64(): number { const v = this.view.getFloat64(this.pos, this.little); this.pos += 8; return v; }
  bytes(n: number): Uint8Array {
    const b = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return b;
  }
  skip(n: number): void { this.pos += n; }
  get eof(): boolean { return this.pos >= this.view.byteLength; }
}

/** One char per byte (true ISO-8859-1), so raw bytes survive concatenation. */
function ascii(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function readSav(buffer: ArrayBuffer): SavResult {
  const view = new DataView(buffer);
  const magic = ascii(new Uint8Array(buffer, 0, 4));
  if (magic === '$FL3') {
    throw new Error('This is a ZSAV (.zsav) file. In SPSS, save it as a .sav file with "Compress" set to standard or none, then try again.');
  }
  if (magic !== '$FL2') throw new Error('This is not an SPSS .sav file.');

  // Byte order from the layout code (always 2 or 3).
  const layoutLE = view.getInt32(64, true);
  const little = layoutLE === 2 || layoutLE === 3;
  const r = new Reader(view, little);
  r.pos = 64;
  r.int32(); // layout code
  r.int32(); // nominal case size
  const compression = r.int32();
  r.int32(); // weight index
  const ncases = r.int32();
  const bias = r.float64();
  r.skip(9 + 8 + 64 + 3); // creation date/time, file label, padding
  if (compression === 2) {
    throw new Error('This .sav file uses ZLIB compression. In SPSS, save it with "Compress" set to standard or none, then try again.');
  }

  const vars: Variable[] = [];
  let current: Variable | null = null;
  let encoding = 'windows-1252';
  const longNames = new Map<string, string>();
  const veryLong = new Map<string, number>();
  const rawLabels: Array<{ v: Variable; bytes: Uint8Array }> = [];

  for (;;) {
    if (r.eof) throw new Error('The .sav file ended before its data section.');
    const recType = r.int32();
    if (recType === 2) {
      const type = r.int32();
      const hasLabel = r.int32();
      const nMissing = r.int32();
      const print = r.int32();
      r.int32(); // write format
      const shortName = ascii(r.bytes(8)).trim();
      let labelBytes: Uint8Array | null = null;
      if (hasLabel === 1) {
        const len = r.int32();
        labelBytes = r.bytes(len);
        r.skip((4 - (len % 4)) % 4);
      }
      if (nMissing !== 0) r.skip(8 * Math.abs(nMissing));
      if (type === -1) {
        if (current) current.segments++;
        continue;
      }
      current = {
        shortName,
        name: shortName,
        width: type,
        label: '',
        formatType: (print >> 16) & 0xff,
        decimals: print & 0xff,
        segments: 1,
      };
      vars.push(current);
      if (labelBytes) rawLabels.push({ v: current, bytes: labelBytes });
    } else if (recType === 3) {
      const count = r.int32();
      for (let i = 0; i < count; i++) {
        r.skip(8);
        const len = r.bytes(1)[0];
        r.skip(len + ((8 - ((len + 1) % 8)) % 8));
      }
      if (r.int32() !== 4) throw new Error('Malformed value-label record in .sav file.');
      const n = r.int32();
      r.skip(4 * n);
    } else if (recType === 6) {
      r.skip(80 * r.int32());
    } else if (recType === 7) {
      const subtype = r.int32();
      const size = r.int32();
      const count = r.int32();
      const data = r.bytes(size * count);
      if (subtype === 13) {
        for (const pair of ascii(data).split('\t')) {
          const eq = pair.indexOf('=');
          if (eq > 0) longNames.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      } else if (subtype === 14) {
        for (const entry of ascii(data).split(/[\0\t]+/)) {
          const eq = entry.indexOf('=');
          if (eq > 0) veryLong.set(entry.slice(0, eq).trim(), parseInt(entry.slice(eq + 1), 10));
        }
      } else if (subtype === 20) {
        encoding = ascii(data).trim() || encoding;
      }
    } else if (recType === 999) {
      r.int32();
      break;
    } else {
      throw new Error(`Unrecognised record type ${recType} in .sav file.`);
    }
  }

  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding.toLowerCase());
  } catch {
    decoder = new TextDecoder('windows-1252');
  }
  for (const { v, bytes } of rawLabels) v.label = decoder.decode(bytes).trim();
  for (const v of vars) v.name = longNames.get(v.shortName) ?? v.shortName;

  // Very long strings are stored as consecutive 255-byte segment variables;
  // fold the ghosts into the first one.
  const columns: Array<{ v: Variable; parts: Variable[] }> = [];
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    const total = veryLong.get(v.shortName);
    if (total && total > 255) {
      const nSeg = Math.ceil(total / 252);
      columns.push({ v, parts: vars.slice(i, i + nSeg) });
      i += nSeg - 1;
    } else {
      columns.push({ v, parts: [v] });
    }
  }

  // ── Data ──────────────────────────────────────────────────────────────
  const nextSegment = makeSegmentSource(r, compression === 1, bias);
  const rows: string[][] = [];
  const header = columns.map((c) => c.v.name);
  for (let c = 0; ncases < 0 || c < ncases; c++) {
    const row: string[] = [];
    let ended = false;
    for (const col of columns) {
      let str = '';
      let numeric: number | null = null;
      col.parts.forEach((part, pi) => {
        if (ended) return;
        let partStr = '';
        for (let s = 0; s < part.segments; s++) {
          const seg = nextSegment(part.width === 0);
          if (seg === null) { ended = true; return; }
          if (part.width === 0) numeric = seg.num;
          else partStr += seg.text;
        }
        // Very long strings: every segment but the last carries 252 bytes.
        const useful = pi < col.parts.length - 1 ? Math.min(part.width, 252) : part.width;
        str += partStr.slice(0, useful);
      });
      if (ended) break;
      row.push(col.v.width === 0 ? formatNumber(numeric, col.v) : decoder.decode(latin1Bytes(str)).replace(/\s+$/, ''));
    }
    if (ended) break;
    rows.push(row);
  }

  const labels: Record<string, string> = {};
  for (const c of columns) if (c.v.label) labels[c.v.name] = c.v.label;
  return { csv: toCsv([header, ...rows]), labels, caseCount: rows.length };
}

/** Bytes are carried as a latin1 string so multi-segment strings concatenate cheaply. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

interface Segment { num: number | null; text: string }

/** Yields one 8-byte case segment at a time, decoding bytecode compression. */
function makeSegmentSource(r: Reader, compressed: boolean, bias: number): (numeric: boolean) => Segment | null {
  if (!compressed) {
    return (numeric) => {
      if (r.pos + 8 > r.view.byteLength) return null;
      if (numeric) {
        const n = r.float64();
        return { num: isSysmis(n) ? null : n, text: '' };
      }
      return { num: null, text: ascii(r.bytes(8)) };
    };
  }
  let codes: Uint8Array | null = null;
  let ci = 8;
  return (numeric) => {
    for (;;) {
      if (ci >= 8) {
        if (r.pos + 8 > r.view.byteLength) return null;
        codes = r.bytes(8);
        ci = 0;
      }
      const code = codes![ci++];
      if (code === 0) continue; // padding
      if (code === 252) return null; // end of data
      if (code === 253) {
        if (numeric) {
          const n = r.float64();
          return { num: isSysmis(n) ? null : n, text: '' };
        }
        return { num: null, text: ascii(r.bytes(8)) };
      }
      if (code === 254) return { num: null, text: '        ' };
      if (code === 255) return { num: null, text: '' };
      return { num: code - bias, text: '' };
    }
  };
}

function isSysmis(n: number): boolean {
  return !Number.isFinite(n) || n <= -1.7976931348623157e308;
}

function formatNumber(n: number | null, v: Variable): string {
  if (n === null) return '';
  if (DATE_FORMATS.has(v.formatType) || DATETIME_FORMATS.has(v.formatType)) {
    const d = new Date((n - SPSS_EPOCH_OFFSET) * 1000);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString();
      return DATETIME_FORMATS.has(v.formatType) ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
    }
  }
  if (Number.isInteger(n)) return String(n);
  return v.decimals > 0 ? n.toFixed(v.decimals) : String(n);
}

function toCsv(grid: string[][]): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return grid.map((r) => r.map(cell).join(',')).join('\n');
}
