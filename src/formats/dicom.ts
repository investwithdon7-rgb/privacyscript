/**
 * DICOM de-identification — DICOM PS3.15 Annex E
 * "Basic Application Level Confidentiality Profile" with the
 *   - Clean Descriptors Option          (free text runs through the span engine)
 *   - Retain Longitudinal Temporal Information, Modified Dates Option
 *                                        (pseudonymise: dates shifted)
 *   - Retain Patient Characteristics Option (sex, age ≤ 89, size, weight kept)
 *
 * The file is parsed into an element tree by a small built-in codec and
 * WRITTEN AGAIN, never patched in place: removing elements, replacing UIDs and
 * changing value lengths all need re-encoding to keep the file valid.
 *
 *  - Private tags, overlays, curves and the Annex E "remove" list are dropped.
 *  - Instance UIDs are replaced with 2.25.<HMAC> UIDs: the same original UID
 *    always gets the same new UID, so studies, series and references stay
 *    linked across files. Pseudonymise uses the session secret (mapping goes
 *    into the key file); anonymise uses a throwaway in-memory key.
 *  - Dates are shifted (pseudonymise) or reduced to the year (anonymise).
 *  - Person names, IDs and free text go through the same span engine as every
 *    other format (as "leaves"), so review, validation and audit work the same.
 *  - Pixel data is copied unchanged. Burned-in text is reported, not removed.
 *
 * Supported encodings: implicit / explicit VR little endian, deflated (via
 * DecompressionStream) and every encapsulated (compressed) transfer syntax,
 * whose pixel fragments are copied byte for byte. Big endian is refused.
 */

import type { IdentifierLabel } from '@/lib/identifiers';
import type { Mode } from '@/lib/constants';
import { generateSessionSecret, type SessionSecret } from '@/engine/crypto';

/* ----------------------------------------------------------------------------
 * Codec
 * --------------------------------------------------------------------------*/

export interface DicomElement {
  /** (group << 16 | element), unsigned. */
  tag: number;
  /** Two-letter VR; '' when the file is implicit VR and the tag is unknown. */
  vr: string;
  value?: Uint8Array;
  /** Sequence items (each item is a dataset). */
  items?: DicomElement[][];
  /** Encapsulated pixel data: raw item fragments incl. sequence delimiter. */
  encapsulated?: Uint8Array;
}

export interface DicomFile {
  meta: DicomElement[];
  dataset: DicomElement[];
  transferSyntax: string;
  /** Dataset encoding of the file we write back. */
  explicit: boolean;
}

const TS_IMPLICIT = '1.2.840.10008.1.2';
const TS_EXPLICIT = '1.2.840.10008.1.2.1';
const TS_DEFLATE = '1.2.840.10008.1.2.1.99';
const TS_BIG_ENDIAN = '1.2.840.10008.1.2.2';

const ITEM = 0xfffee000;
const ITEM_DELIM = 0xfffee00d;
const SEQ_DELIM = 0xfffee0dd;
const UNDEFINED = 0xffffffff;
const PIXEL_DATA = 0x7fe00010;

const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV']);
const BINARY_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'FL', 'FD', 'SL', 'SS', 'UL', 'US', 'SV', 'UV', 'AT', 'UN']);
/** VRs whose bytes depend on Specific Character Set. */
const CHARSET_VRS = new Set(['SH', 'LO', 'ST', 'LT', 'PN', 'UC', 'UT']);
/** Free-text-ish VRs the span engine reads. */
const ENGINE_VRS = new Set(['SH', 'LO', 'ST', 'LT', 'UC', 'UT', 'UR']);
const MAX_LEN: Record<string, number> = { SH: 16, LO: 64, PN: 64, CS: 16, ST: 1024, LT: 10240 };

/**
 * VRs for implicit-VR files. Covers every tag the profile acts on plus the
 * common ones; an unknown tag is copied as-is, and if it holds printable text
 * it is still read by the span engine.
 */
const DICT: Record<string, string> = {};
function dict(group: string, entries: string) {
  for (const e of entries.trim().split(/\s+/)) {
    const [el, vr] = e.split(':');
    DICT[(group + el).toLowerCase()] = vr;
  }
}
dict('0008', '0005:CS 0008:CS 0012:DA 0013:TM 0014:UI 0016:UI 0018:UI 001A:UI 0020:DA 0021:DA 0022:DA 0023:DA 0024:DA 0025:DA 002A:DT 0030:TM 0031:TM 0032:TM 0033:TM 0034:TM 0035:TM 0050:SH 0054:AE 0056:CS 0058:UI 0060:CS 0064:CS 0070:LO 0080:LO 0081:ST 0082:SQ 0090:PN 0092:ST 0094:SH 0096:SQ 009C:PN 009D:SQ 0100:SH 0102:SH 0103:SH 0104:LO 0105:CS 010C:UI 0201:SH 1010:SH 1030:LO 1032:SQ 103E:LO 1040:LO 1041:SQ 1048:PN 1049:SQ 1050:PN 1052:SQ 1060:PN 1062:SQ 1070:PN 1072:SQ 1080:LO 1084:SQ 1090:LO 1110:SQ 1111:SQ 1115:SQ 1120:SQ 1140:SQ 1150:UI 1155:UI 1195:UI 2111:ST 2112:SQ 4000:LT 9123:UI');
dict('0010', '0010:PN 0020:LO 0021:LO 0022:CS 0024:SQ 0030:DA 0032:TM 0040:CS 0050:SQ 0101:SQ 0102:SQ 1000:LO 1001:PN 1002:SQ 1005:PN 1010:AS 1020:DS 1030:DS 1040:LO 1050:LO 1060:PN 1080:LO 1081:LO 1090:LO 1100:SQ 2000:LO 2110:LO 2150:LO 2152:LO 2154:SH 2155:SQ 2160:SH 2180:SH 21A0:CS 21B0:LT 21C0:US 21D0:DA 21F0:LO 2203:CS 2297:PN 2299:LO 4000:LT');
dict('0012', '0010:LO 0020:LO 0021:LO 0030:LO 0031:LO 0040:LO 0042:LO 0050:LO 0051:ST 0060:LO 0062:CS 0063:LO 0064:SQ 0071:LO 0072:LO 0081:LO 0082:LO');
dict('0018', '0010:LO 0015:CS 0022:CS 0024:SH 1000:LO 1002:UI 1004:LO 1005:LO 1007:LO 1008:LO 1010:LO 1012:DA 1014:TM 1016:LO 1018:LO 1019:LO 1020:LO 1030:LO 1200:DA 1201:TM 1210:SH 1400:LO 4000:LT 700A:SH 700C:DA 700E:TM 9074:DT 9151:DT 9424:LT 9516:DT 9517:DT 9804:DT A002:DT A003:ST');
dict('0020', '000D:UI 000E:UI 0010:SH 0011:IS 0013:IS 0052:UI 0200:UI 4000:LT 9158:LT 9161:UI 9164:UI');
dict('0028', '0301:CS 0303:CS 1055:LO 1199:UI 1214:UI 3003:LO 4000:LT');
dict('0032', '000A:CS 0012:LO 0032:DA 0033:TM 0034:DA 0035:TM 1000:DA 1001:TM 1010:DA 1011:TM 1020:LO 1021:AE 1030:LO 1032:PN 1033:LO 1040:DA 1041:TM 1050:DA 1051:TM 1060:LO 1064:SQ 1070:LO 4000:LT');
dict('0038', '0004:SQ 0010:LO 0011:LO 0014:SQ 001A:DA 001B:TM 001C:DA 001D:TM 001E:LO 0020:DA 0021:TM 0030:DA 0031:TM 0032:DA 0033:TM 0040:LO 0050:LO 0060:LO 0061:LO 0062:LO 0300:LO 0400:LO 0500:LO 1234:SQ 4000:LT');
dict('0040', '0001:AE 0002:DA 0003:TM 0004:DA 0005:TM 0006:PN 0007:LO 0009:SH 000B:SQ 0010:SH 0011:SH 0012:LO 0241:AE 0242:SH 0243:SH 0244:DA 0245:TM 0250:DA 0251:TM 0253:SH 0254:LO 0275:SQ 0280:ST 0310:ST 0400:LT 050A:LO 1001:SH 1002:LO 1004:LO 1005:LO 1010:PN 1011:SQ 1101:SQ 1102:ST 1103:LO 1400:LT 2001:LO 2004:DA 2005:TM 2008:PN 2009:SH 2010:SH 2016:LO 2017:LO 2400:LT 3001:LO 4023:UI 4025:SQ 4027:SQ 4030:SQ 4034:SQ 4035:SQ 4036:LO 4037:PN A027:LO A030:DT A032:DT A073:SQ A075:PN A078:SQ A088:SQ A120:DT A121:DA A122:TM A123:PN A124:UI A160:UT A730:SQ DB0C:UI DB0D:UI');
dict('0070', '0084:PN 0086:SQ');
dict('0088', '0140:UI 0200:SQ 0904:LO 0906:ST 0910:LO 0912:LO');
dict('0400', '0100:UI 0402:SQ 0403:SQ 0404:OB 0550:SQ 0561:SQ 0562:DT 0563:LO 0564:LO 0565:CS');
dict('3006', '0002:SH 0004:LO 0006:ST 0008:DA 0009:TM 0024:UI 00A6:PN 00C2:UI');
dict('300A', '0002:SH 0003:LO 0004:ST 0006:DA 0007:TM 000E:ST 0013:UI 0016:LO 00B2:SH');
dict('300E', '0004:DA 0005:TM 0008:PN');
dict('7FE0', '0010:OW');

const tagKey = (tag: number) => tag.toString(16).padStart(8, '0');
const groupOf = (tag: number) => tag >>> 16;
const T = (hex: string) => parseInt(hex, 16) >>> 0;

class Reader {
  pos = 0;
  private view: DataView;
  constructor(private bytes: Uint8Array, start = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }
  get length() {
    return this.bytes.length;
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  tag() {
    const g = this.u16();
    const e = this.u16();
    return ((g << 16) | e) >>> 0;
  }
  peekTag() {
    if (this.pos + 4 > this.bytes.length) return null;
    const g = this.view.getUint16(this.pos, true);
    const e = this.view.getUint16(this.pos + 2, true);
    return ((g << 16) | e) >>> 0;
  }
  take(n: number) {
    if (this.pos + n > this.bytes.length) throw new Error('DICOM file is truncated.');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  ascii(n: number) {
    return String.fromCharCode(...this.take(n));
  }

  readDataset(end: number, explicit: boolean, untilItemDelim: boolean): DicomElement[] {
    const out: DicomElement[] = [];
    while (this.pos < end && this.pos + 8 <= this.bytes.length) {
      const next = this.peekTag();
      if (next === ITEM_DELIM) {
        this.pos += 8;
        if (untilItemDelim) break;
        continue;
      }
      if (next === SEQ_DELIM) break; // malformed: let the sequence reader consume it
      out.push(this.readElement(explicit));
    }
    return out;
  }

  readElement(explicit: boolean): DicomElement {
    const tag = this.tag();
    let vr = '';
    let length: number;
    if (explicit) {
      vr = this.ascii(2);
      if (LONG_VRS.has(vr)) {
        this.pos += 2;
        length = this.u32();
      } else if (/^[A-Z]{2}$/.test(vr)) {
        length = this.u16();
      } else {
        // Not a VR: an implicit element inside an explicit file. Re-read.
        this.pos -= 2;
        vr = DICT[tagKey(tag)] ?? '';
        length = this.u32();
      }
    } else {
      length = this.u32();
      vr = DICT[tagKey(tag)] ?? '';
    }

    if (tag === PIXEL_DATA && length === UNDEFINED) {
      const start = this.pos;
      for (;;) {
        const t = this.tag();
        const len = this.u32();
        if (t === SEQ_DELIM) break;
        if (t !== ITEM) throw new Error('Malformed encapsulated pixel data.');
        this.take(len);
      }
      return { tag, vr: vr || 'OB', encapsulated: this.bytes.subarray(start, this.pos) };
    }

    // A standard tag sent as UN: read it with its real VR so names, dates and
    // UIDs in it are handled like any other.
    if (explicit && vr === 'UN' && DICT[tagKey(tag)]) {
      vr = DICT[tagKey(tag)];
      if (vr === 'SQ') return { tag, vr, items: this.readSequence(length, false) };
    }

    const looksLikeSequence =
      vr === 'SQ' ||
      length === UNDEFINED ||
      (vr === '' && length >= 8 && this.peekTag() === ITEM);
    if (looksLikeSequence) {
      // UN with undefined length = a sequence encoded implicit (CP-246).
      const itemsExplicit = explicit && vr !== 'UN' && vr !== '';
      return { tag, vr: 'SQ', items: this.readSequence(length, itemsExplicit) };
    }
    return { tag, vr, value: this.take(length) };
  }

  readSequence(length: number, explicit: boolean): DicomElement[][] {
    const items: DicomElement[][] = [];
    const end = length === UNDEFINED ? Infinity : this.pos + length;
    while (this.pos < end && this.pos + 8 <= this.bytes.length) {
      const t = this.tag();
      const len = this.u32();
      if (t === SEQ_DELIM) break;
      if (t !== ITEM) throw new Error('Malformed DICOM sequence.');
      items.push(
        len === UNDEFINED
          ? this.readDataset(Infinity, explicit, true)
          : this.readDataset(this.pos + len, explicit, false)
      );
    }
    return items;
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read deflated DICOM files.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when the bytes carry the DICM marker at offset 128. */
export function looksLikeDicom(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 132) return false;
  const view = new Uint8Array(bytes, 128, 4);
  return view[0] === 0x44 && view[1] === 0x49 && view[2] === 0x43 && view[3] === 0x4d; // 'DICM'
}

export async function parseDicom(buffer: ArrayBuffer): Promise<DicomFile> {
  const bytes = new Uint8Array(buffer);
  let start = 0;
  if (looksLikeDicom(buffer)) start = 132;
  else if (bytes.length >= 4 && bytes[0] === 0x44 && bytes[1] === 0x49 && bytes[2] === 0x43 && bytes[3] === 0x4d) start = 4;

  const r = new Reader(bytes, start);
  const meta: DicomElement[] = [];
  while (r.pos + 8 <= r.length && r.peekTag() !== null && groupOf(r.peekTag()!) === 0x0002) {
    meta.push(r.readElement(true));
  }
  const tsEl = meta.find((e) => e.tag === T('00020010'));
  // No meta header (raw dataset): tell implicit from explicit VR by whether a
  // two-letter VR follows the first tag, and spot big endian by its group.
  let transferSyntax = tsEl?.value ? decodeAscii(tsEl.value) : TS_IMPLICIT;
  if (!tsEl?.value && r.pos + 6 <= r.length) {
    const b = bytes.subarray(r.pos, r.pos + 6);
    const hasVr = /^[A-Z]{2}$/.test(String.fromCharCode(b[4], b[5]));
    if (b[0] === 0 && b[1] !== 0 && hasVr) transferSyntax = TS_BIG_ENDIAN;
    else if (hasVr) transferSyntax = TS_EXPLICIT;
  }

  if (transferSyntax === TS_BIG_ENDIAN) {
    throw new Error(
      'This DICOM file uses big-endian encoding (retired in 2004). Convert it to little endian with your PACS or a DICOM tool, then try again.'
    );
  }
  if (start === 0 && meta.length === 0 && !isPlausibleDataset(bytes)) {
    throw new Error('Not a valid DICOM file.');
  }

  let dataset: DicomElement[];
  let explicit = transferSyntax !== TS_IMPLICIT;
  try {
    if (transferSyntax === TS_DEFLATE) {
      const inflated = await inflateRaw(bytes.subarray(r.pos));
      dataset = new Reader(inflated).readDataset(Infinity, true, false);
      explicit = true;
    } else {
      dataset = r.readDataset(Infinity, explicit, false);
    }
  } catch (err) {
    throw new Error(`Not a valid DICOM file: ${(err as Error).message}`);
  }
  if (dataset.length === 0) throw new Error('Not a valid DICOM file: no data elements found.');
  return { meta, dataset, transferSyntax, explicit };
}

function isPlausibleDataset(bytes: Uint8Array): boolean {
  // Raw implicit datasets start with a low even group (usually 0x0008).
  const g = bytes[0] | (bytes[1] << 8);
  return g === 0x0008 || g === 0x0010 || g === 0x0018 || g === 0x0020;
}

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  push(b: Uint8Array) {
    this.chunks.push(b);
    this.size += b.length;
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  tag(t: number) {
    this.u16(t >>> 16);
    this.u16(t & 0xffff);
  }
  ascii(s: string) {
    this.push(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  element(el: DicomElement, explicit: boolean) {
    this.tag(el.tag);
    if (el.items) {
      if (explicit) {
        this.ascii('SQ');
        this.u16(0);
      }
      this.u32(UNDEFINED);
      for (const item of el.items) {
        this.tag(ITEM);
        this.u32(UNDEFINED);
        for (const child of item) this.element(child, explicit);
        this.tag(ITEM_DELIM);
        this.u32(0);
      }
      this.tag(SEQ_DELIM);
      this.u32(0);
      return;
    }
    if (el.encapsulated) {
      if (explicit) {
        this.ascii(el.vr === 'OW' ? 'OW' : 'OB');
        this.u16(0);
      }
      this.u32(UNDEFINED);
      this.push(el.encapsulated);
      return;
    }
    let value = el.value ?? new Uint8Array(0);
    if (value.length % 2 === 1) {
      const padded = new Uint8Array(value.length + 1);
      padded.set(value);
      padded[value.length] = el.vr === 'UI' || BINARY_VRS.has(el.vr) ? 0 : 0x20;
      value = padded;
    }
    if (explicit) {
      let vr = el.vr || 'UN';
      if (!LONG_VRS.has(vr) && value.length > 0xffff) vr = 'UN';
      this.ascii(vr);
      if (LONG_VRS.has(vr)) {
        this.u16(0);
        this.u32(value.length);
      } else {
        this.u16(value.length);
      }
    } else {
      this.u32(value.length);
    }
    this.push(value);
  }
}

export function writeDicom(file: DicomFile): Uint8Array {
  const w = new Writer();
  w.push(new Uint8Array(128));
  w.ascii('DICM');

  const metaBody = new Writer();
  for (const el of file.meta) {
    if (el.tag === T('00020000')) continue;
    metaBody.element(el, true);
  }
  const metaBytes = metaBody.bytes();
  w.element({ tag: T('00020000'), vr: 'UL', value: u32Bytes(metaBytes.length) }, true);
  w.push(metaBytes);
  for (const el of file.dataset) w.element(el, file.explicit);
  return w.bytes();
}

function u32Bytes(v: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

/* ----------------------------------------------------------------------------
 * Text values
 * --------------------------------------------------------------------------*/

type Charset = { decode: (b: Uint8Array) => string; encode: (s: string) => Uint8Array; utf8: boolean };

const LATIN1: Charset = {
  decode: (b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return s;
  },
  encode: (s) => Uint8Array.from(s, (c) => (c.charCodeAt(0) <= 0xff ? c.charCodeAt(0) : 0x3f)),
  utf8: false,
};
const UTF8: Charset = {
  decode: (b) => new TextDecoder('utf-8').decode(b),
  encode: (s) => new TextEncoder().encode(s),
  utf8: true,
};
const DECODER_FOR: Record<string, string> = {
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  'ISO_IR 166': 'windows-874',
  'ISO_IR 13': 'shift_jis',
  'ISO 2022 IR 87': 'iso-2022-jp',
  'ISO 2022 IR 149': 'euc-kr',
  GB18030: 'gb18030',
  GBK: 'gbk',
};

function decodeAscii(b: Uint8Array) {
  return LATIN1.decode(b).replace(/[\0 ]+$/, '').trim();
}

/** Charset the input is read with; the output is UTF-8 unless it was Latin-1/ASCII. */
function charsetsFor(dataset: DicomElement[]): { input: Charset; output: Charset; outputTerm: string | null } {
  const el = dataset.find((e) => e.tag === T('00080005'));
  const terms = el?.value ? decodeAscii(el.value).split('\\').map((t) => t.trim()) : [];
  const term = terms.find((t) => t) ?? terms[1] ?? '';
  if (terms.includes('ISO_IR 192')) return { input: UTF8, output: UTF8, outputTerm: null };
  if (!term || term === 'ISO_IR 100' || term === 'ISO 2022 IR 100' || term === 'ISO 2022 IR 6') {
    return { input: LATIN1, output: LATIN1, outputTerm: null };
  }
  const label = DECODER_FOR[terms.find((t) => DECODER_FOR[t]) ?? ''];
  if (label) {
    try {
      const dec = new TextDecoder(label);
      return {
        input: { decode: (b) => dec.decode(b), encode: UTF8.encode, utf8: true },
        output: UTF8,
        outputTerm: 'ISO_IR 192',
      };
    } catch {
      /* unsupported decoder: fall through */
    }
  }
  return { input: LATIN1, output: LATIN1, outputTerm: null };
}

function cleanString(s: string) {
  return s.replace(/[\0\s]+$/, '');
}

function isPrintable(b: Uint8Array) {
  if (b.length === 0) return false;
  for (const c of b) if (c !== 0 && c !== 0x0a && c !== 0x0d && c !== 0x09 && (c < 0x20 || c === 0x7f)) return false;
  return true;
}

/* ----------------------------------------------------------------------------
 * Profile
 * --------------------------------------------------------------------------*/

/** Annex E "X" (remove) entries that the per-VR rules below don't cover. */
const REMOVE = new Set(
  (
    '00080081 00080082 00080092 00080094 00080096 0008009D 00080080 00080201 00081010 00081040 00081041 ' +
    '00081049 00081052 00081062 00081072 00081080 00081084 00081120 00084000 ' +
    '00100021 00100024 00100032 00100050 00100101 00100102 00101000 00101001 00101002 00101005 00101040 ' +
    '00101050 00101060 00101080 00101081 00101090 00101100 00102000 00102110 00102150 00102152 00102154 ' +
    '00102155 00102160 00102180 001021B0 001021F0 00102297 00102299 00104000 ' +
    '00181000 00181004 00181005 00181007 00181008 00184000 0018700A 0018A003 ' +
    '00204000 00209158 00284000 ' +
    '00320012 00321020 00321021 00321030 00321033 00324000 ' +
    '00380004 00380011 0038001E 00380040 00380050 00380060 00380061 00380062 00380300 00380400 00380500 ' +
    '00381234 00384000 ' +
    '00400010 00400011 00400012 00400242 00400243 00400253 00400275 00400280 00400310 00400400 0040050A ' +
    '00401001 00401002 00401004 00401005 00401011 00401101 00401102 00401103 00401400 00402001 00402009 ' +
    '00402010 00402016 00402017 00402400 00403001 00404036 0040A027 0040A078 0040A088 ' +
    '00700086 00880200 00880904 00880906 00880910 00880912 ' +
    '04000402 04000403 04000404 04000550 04000561 FFFAFFFA 20300020 40000010 40004000'
  )
    .split(/\s+/)
    .map(T)
);

/** UID tags that name a class or syntax, never an instance: kept. */
const KEEP_UIDS = new Set(
  ['00020002', '00020010', '00080016', '0008001A', '00080062', '0008010C', '00081150', '00041510', '00041512'].map(T)
);

/** Technical descriptors and coded vocabulary: not identifying, not scanned. */
const KEEP_TEXT = new Set(
  [
    '00080070', '00081090', '00181020', '00180024', '00181016', '00181018', '00181019', '00181210',
    '00080100', '00080102', '00080103', '00080104', '00281055', '00283003', '00120063',
  ].map(T)
);

/** Direct identifiers stored in LO/SH: always replaced. */
const FORCED_LABEL: Record<number, IdentifierLabel> = {
  [T('00100020')]: 'MRN', // Patient ID
  [T('00080050')]: 'REFERENCE_ID', // Accession Number
  [T('00200010')]: 'REFERENCE_ID', // Study ID
  [T('00380010')]: 'REFERENCE_ID', // Admission ID
};

const TAG_NAMES: Record<number, string> = {
  [T('00100010')]: 'Patient name',
  [T('00100020')]: 'Patient ID',
  [T('00080050')]: 'Accession number',
  [T('00200010')]: 'Study ID',
  [T('00380010')]: 'Admission ID',
  [T('00080090')]: 'Referring physician',
  [T('00081030')]: 'Study description',
  [T('0008103E')]: 'Series description',
  [T('00181030')]: 'Protocol name',
  [T('00081050')]: 'Performing physician',
  [T('00081070')]: 'Operator',
  [T('00081060')]: 'Reading physician',
  [T('00321032')]: 'Requesting physician',
};

type Action = 'remove' | 'keep' | 'uid' | 'date' | 'datetime' | 'time' | 'age' | 'leaf' | 'birthdate';

function actionFor(el: DicomElement): Action {
  const g = groupOf(el.tag);
  if (g === 0x0002) return 'keep';
  if (g % 2 === 1) return 'remove'; // private
  if ((g & 0xff00) === 0x5000 || (g & 0xff00) === 0x6000) return 'remove'; // curves, overlays
  if (g === 0x4008 || g === 0x0000) return 'remove'; // results (retired), command group
  if (REMOVE.has(el.tag)) return 'remove';
  if (el.items || el.encapsulated) return 'keep';
  switch (el.vr) {
    case 'AE':
      return 'remove';
    case 'UI':
      return KEEP_UIDS.has(el.tag) ? 'keep' : 'uid';
    case 'DA':
      return el.tag === T('00100030') ? 'birthdate' : 'date';
    case 'DT':
      return 'datetime';
    case 'TM':
      return 'time';
    case 'AS':
      return 'age';
    case 'PN':
      return 'leaf';
  }
  if (FORCED_LABEL[el.tag]) return 'leaf';
  if (KEEP_TEXT.has(el.tag)) return 'keep';
  if (ENGINE_VRS.has(el.vr)) return 'leaf';
  if (el.vr === '' && el.value && isPrintable(el.value)) {
    // Unknown tag holding a UID: replace it like one rather than let the
    // text rules mangle "1.2.3.4".
    return /^[\d.]+(\\[\d.]+)*[\0 ]*$/.test(LATIN1.decode(el.value)) ? 'uid' : 'leaf';
  }
  return 'keep';
}

/* ----------------------------------------------------------------------------
 * Ingest
 * --------------------------------------------------------------------------*/

export interface DicomLeaf {
  el: DicomElement;
  /** Decoded value the span engine reads. */
  value: string;
  /** Structural label: the whole value is an identifier. */
  label: IdentifierLabel | null;
  /** Human tag name when known (for the review screen). */
  name: string;
}

export type BurnedInStatus = 'YES' | 'LIKELY' | 'NO' | 'UNKNOWN' | 'NO_IMAGE';

export interface DicomIngest {
  file: DicomFile;
  leaves: DicomLeaf[];
  burnedIn: BurnedInStatus;
  modality: string;
  /** Short counts for the audit log; never values. */
  privateTags: number;
}

export async function ingestDicom(buffer: ArrayBuffer): Promise<DicomIngest> {
  const file = await parseDicom(buffer);
  const { input } = charsetsFor(file.dataset);
  const leaves: DicomLeaf[] = [];
  let privateTags = 0;

  const walk = (elements: DicomElement[]) => {
    for (const el of elements) {
      const action = actionFor(el);
      if (action === 'remove') {
        if (groupOf(el.tag) % 2 === 1) privateTags++;
        continue;
      }
      if (el.items) {
        for (const item of el.items) walk(item);
        continue;
      }
      if (action !== 'leaf' || !el.value) continue;
      const value = cleanString(el.vr === '' ? LATIN1.decode(el.value) : input.decode(el.value));
      if (!value.trim()) continue;
      leaves.push({
        el,
        value,
        label: el.vr === 'PN' ? 'NAME' : FORCED_LABEL[el.tag] ?? null,
        name: TAG_NAMES[el.tag] ?? `(${tagKey(el.tag).slice(0, 4)},${tagKey(el.tag).slice(4)})`.toUpperCase(),
      });
    }
  };
  walk(file.dataset);

  const str = (hex: string) => {
    const el = file.dataset.find((e) => e.tag === T(hex));
    return el?.value ? decodeAscii(el.value).toUpperCase() : '';
  };
  const hasPixels = file.dataset.some((e) => e.tag === PIXEL_DATA);
  const modality = str('00080060');
  const flag = str('00280301');
  let burnedIn: BurnedInStatus;
  if (!hasPixels) burnedIn = 'NO_IMAGE';
  else if (flag === 'YES') burnedIn = 'YES';
  else if (
    ['US', 'XC', 'ES', 'OT', 'DOC', 'SC', 'GM', 'SM', 'IVUS'].includes(modality) ||
    str('00080016').startsWith('1.2.840.10008.5.1.4.1.1.7') || // secondary capture
    str('00080016').startsWith('1.2.840.10008.5.1.4.1.1.6') // ultrasound
  ) {
    burnedIn = flag === 'NO' ? 'NO' : 'LIKELY';
  } else burnedIn = flag === 'NO' ? 'NO' : 'UNKNOWN';

  return { file, leaves, burnedIn, modality, privateTags };
}

/** Plain-language burned-in text warning, or null when there's nothing to say. */
export function burnedInWarning(status: BurnedInStatus): string | null {
  switch (status) {
    case 'YES':
      return 'The file says the image has text burned into the pixels (for example a name or date on an ultrasound). Header details were removed, but the picture itself still shows that text. Check the image before sharing.';
    case 'LIKELY':
      return 'This kind of image (ultrasound, screenshot or scanned document) often has names or dates burned into the picture. Header details were removed, but the picture itself was not changed. Check the image before sharing.';
    default:
      return null;
  }
}

/* ----------------------------------------------------------------------------
 * Rebuild
 * --------------------------------------------------------------------------*/

/* ----------------------------------------------------------------------------
 * Pixels (burned-in text)
 * --------------------------------------------------------------------------*/

export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PixelInfo {
  rows: number;
  cols: number;
  frames: number;
  samples: number;
  bitsAllocated: 8 | 16;
  signed: boolean;
  photometric: string;
  /** 1 = colour planes stored one after the other. */
  planar: number;
  frameBytes: number;
  value: Uint8Array;
}

/**
 * Uncompressed pixel data this module can read and black out, or null
 * (compressed transfer syntax, unusual bit depth, or no image).
 */
export function nativePixels(file: DicomFile): PixelInfo | null {
  const el = (hex: string) => file.dataset.find((e) => e.tag === T(hex));
  const pixel = el('7FE00010');
  if (!pixel?.value || pixel.encapsulated) return null;
  const us = (hex: string) => {
    const v = el(hex)?.value;
    return v && v.length >= 2 ? v[0] | (v[1] << 8) : undefined;
  };
  const rows = us('00280010');
  const cols = us('00280011');
  const bits = us('00280100');
  const samples = us('00280002') ?? 1;
  if (!rows || !cols || (bits !== 8 && bits !== 16) || (samples !== 1 && samples !== 3)) return null;
  const framesEl = el('00280008')?.value;
  const frames = Math.max(1, framesEl ? parseInt(decodeAscii(framesEl), 10) || 1 : 1);
  const frameBytes = rows * cols * samples * (bits / 8);
  if (pixel.value.length < frameBytes * frames) return null;
  return {
    rows,
    cols,
    frames,
    samples,
    bitsAllocated: bits,
    signed: us('00280103') === 1,
    photometric: el('00280004')?.value ? decodeAscii(el('00280004')!.value!).toUpperCase() : 'MONOCHROME2',
    planar: us('00280006') ?? 0,
    frameBytes,
    value: pixel.value,
  };
}

function sampleAt(info: PixelInfo, frame: number, pixel: number, sample: number): number {
  const base = frame * info.frameBytes;
  const index =
    info.samples === 1
      ? pixel
      : info.planar === 1
      ? sample * info.rows * info.cols + pixel
      : pixel * info.samples + sample;
  if (info.bitsAllocated === 8) return info.value[base + index];
  const o = base + index * 2;
  const v = info.value[o] | (info.value[o + 1] << 8);
  return info.signed && v > 0x7fff ? v - 0x10000 : v;
}

/**
 * One frame as 8-bit greyscale for OCR, auto-windowed to the frame's own
 * range (burned-in text is usually the brightest thing in the picture).
 */
export function frameToGrey(info: PixelInfo, frame = 0): Uint8ClampedArray {
  const n = info.rows * info.cols;
  const raw = new Float64Array(n);
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < n; p++) {
    let v: number;
    if (info.samples === 3 && info.photometric === 'RGB') {
      v = 0.299 * sampleAt(info, frame, p, 0) + 0.587 * sampleAt(info, frame, p, 1) + 0.114 * sampleAt(info, frame, p, 2);
    } else {
      v = sampleAt(info, frame, p, 0); // grey, or the Y (luma) of YBR
    }
    raw[p] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const out = new Uint8ClampedArray(n);
  const invert = info.photometric === 'MONOCHROME1';
  for (let p = 0; p < n; p++) {
    const g = ((raw[p] - min) / range) * 255;
    out[p] = invert ? 255 - g : g;
  }
  return out;
}

/** Copy of the pixel data with every box painted black in every frame. */
export function blackOutPixels(info: PixelInfo, boxes: PixelBox[]): Uint8Array {
  const out = info.value.slice();
  const bytes = info.bitsAllocated / 8;
  // "Black" per colour model: lowest value (or highest for MONOCHROME1);
  // YBR black keeps the colour channels at mid-range.
  const blackFor = (frame: number, sample: number): number => {
    if (info.samples === 3) return info.photometric.startsWith('YBR') && sample > 0 ? 128 : 0;
    if (!info.signed) return info.photometric === 'MONOCHROME1' ? (1 << info.bitsAllocated) - 1 : 0;
    let m = info.photometric === 'MONOCHROME1' ? -Infinity : Infinity;
    for (let p = 0; p < info.rows * info.cols; p++) {
      const v = sampleAt(info, frame, p, 0);
      m = info.photometric === 'MONOCHROME1' ? Math.max(m, v) : Math.min(m, v);
    }
    return m;
  };
  for (let f = 0; f < info.frames; f++) {
    const base = f * info.frameBytes;
    for (let s = 0; s < info.samples; s++) {
      const black = blackFor(f, s);
      const lo = black & 0xff;
      const hi = (black >> 8) & 0xff;
      for (const b of boxes) {
        const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(info.cols, Math.ceil(b.x1));
        const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(info.rows, Math.ceil(b.y1));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = y * info.cols + x;
            const index =
              info.samples === 1 ? p : info.planar === 1 ? s * info.rows * info.cols + p : p * info.samples + s;
            const o = base + index * bytes;
            out[o] = lo;
            if (bytes === 2) out[o + 1] = hi;
          }
        }
      }
    }
  }
  return out;
}

export interface DicomRebuildOptions {
  mode: Mode;
  /** Pseudonymise: session secret (UIDs then go into the key file). */
  secret?: SessionSecret;
  /** Pseudonymise: per-session date shift in days. */
  dateShiftDays?: number;
  /** Burned-in text to black out, in pixel coordinates (every frame). */
  pixelBoxes?: PixelBox[];
  /**
   * New uncompressed 8-bit pixels (decoded from a compressed image and
   * already blacked out). Written as explicit VR little endian.
   */
  replacePixels?: { data: Uint8Array; samples: 1 | 3 };
}

/** Transfer syntaxes whose frames the browser's own JPEG decoder can read. */
export const BROWSER_DECODABLE_TS = new Set(['1.2.840.10008.1.2.4.50']); // JPEG baseline (8-bit)

/**
 * The compressed frames of encapsulated pixel data (one JPEG per frame).
 * Uses the basic offset table when present; otherwise one fragment per
 * frame, or all fragments joined for a single frame.
 */
export function encapsulatedFrames(file: DicomFile): Uint8Array[] | null {
  const pixel = file.dataset.find((e) => e.tag === PIXEL_DATA);
  if (!pixel?.encapsulated) return null;
  const b = pixel.encapsulated;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const items: Array<{ offset: number; data: Uint8Array }> = [];
  let p = 0;
  while (p + 8 <= b.length) {
    const tag = ((v.getUint16(p, true) << 16) | v.getUint16(p + 2, true)) >>> 0;
    const len = v.getUint32(p + 4, true);
    if (tag === SEQ_DELIM) break;
    items.push({ offset: p, data: b.subarray(p + 8, p + 8 + len) });
    p += 8 + len;
  }
  if (items.length < 2) return null;
  const [bot, ...fragments] = items;
  const framesEl = file.dataset.find((e) => e.tag === T('00280008'))?.value;
  const frames = Math.max(1, framesEl ? parseInt(decodeAscii(framesEl), 10) || 1 : 1);
  const join = (list: Uint8Array[]) => {
    const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of list) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  if (frames === 1) return [join(fragments.map((f) => f.data))];
  if (fragments.length === frames) return fragments.map((f) => f.data);
  if (bot.data.length >= frames * 4) {
    // Offsets are measured from the first fragment's item tag.
    const first = fragments[0].offset;
    const starts = Array.from({ length: frames }, (_, i) => new DataView(bot.data.buffer, bot.data.byteOffset).getUint32(i * 4, true));
    return starts.map((s, i) => {
      const end = i + 1 < frames ? starts[i + 1] : Infinity;
      return join(fragments.filter((f) => f.offset - first >= s && f.offset - first < end).map((f) => f.data));
    });
  }
  return null;
}

export interface DicomRebuildResult {
  bytes: Uint8Array;
  /** Original UID -> new UID (pseudonymise only; goes into the key file). */
  uidMapping: Record<string, string>;
  /** Originals that must not appear anywhere in the output. */
  originals: string[];
  notes: string[];
}

let anonUidKey: Promise<SessionSecret> | null = null;

/** HMAC-derived UID under the 2.25 (UUID-derived) root. */
async function newUid(secret: SessionSecret, uid: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', secret.hmacKey, new TextEncoder().encode(`dicom-uid:${uid}`));
  const b = new Uint8Array(sig).subarray(0, 16);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return `2.25.${n.toString()}`;
}

const PRIVACYSCRIPT_IMPLEMENTATION_UID = '2.25.302875411947301852873658211304183259402';

function shiftDa(da: string, days: number): string | null {
  const m = da.replace(/\./g, '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear().toString().padStart(4, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function mapValues(raw: string, fn: (v: string) => string): string {
  return raw
    .split('\\')
    .map((v) => {
      const t = v.trim();
      return t ? fn(t) : '';
    })
    .join('\\');
}

function fitToVr(value: string, vr: string): string {
  const max = MAX_LEN[vr];
  if (!max || value.length <= max) return value;
  // "[REFERENCE_ID-AB12CD34]" is too long for a 16-char SH: keep the code.
  const code = value.match(/^\[[A-Z_]+-([0-9A-F]{8})\]$/);
  if (code) return code[1];
  return value.slice(0, max);
}

/**
 * Write the de-identified file. `leafValues[i]` is the engine's output for
 * `ingest.leaves[i]`. The ingest tree is not modified.
 */
export async function rebuildDicom(
  ingest: DicomIngest,
  leafValues: string[],
  opts: DicomRebuildOptions
): Promise<DicomRebuildResult> {
  const pseudo = opts.mode === 'PSEUDONYMISE';
  if (pseudo && (!opts.secret || opts.dateShiftDays === undefined)) {
    throw new Error('Pseudonymise mode needs the session secret and date shift.');
  }
  const uidSecret = pseudo ? opts.secret! : await (anonUidKey ??= generateSessionSecret());
  const { input, output, outputTerm } = charsetsFor(ingest.file.dataset);
  const leafOut = new Map<DicomElement, { leaf: DicomLeaf; next: string }>();
  ingest.leaves.forEach((leaf, i) => leafOut.set(leaf.el, { leaf, next: leafValues[i] ?? leaf.value }));

  const uidMapping: Record<string, string> = {};
  const originals = new Set<string>();
  const counts = { removed: 0, privates: 0, uids: 0, dates: 0, times: 0, ages: 0, text: 0, shortened: 0 };
  const pixelInfo = opts.pixelBoxes?.length ? nativePixels(ingest.file) : null;
  const topPixel = ingest.file.dataset.find((e) => e.tag === PIXEL_DATA);

  // UIDs are hashed in parallel; collect first, then fill.
  const uidCache = new Map<string, Promise<string>>();
  const uid = (u: string) => {
    if (u.startsWith('1.2.840.10008.')) return Promise.resolve(u); // standard, not an instance
    let p = uidCache.get(u);
    if (!p) {
      p = newUid(uidSecret, u);
      uidCache.set(u, p);
    }
    return p;
  };

  const str = (el: DicomElement) => decodeAscii(el.value ?? new Uint8Array(0));
  const ascii = (s: string) => LATIN1.encode(s);

  const transform = async (elements: DicomElement[]): Promise<DicomElement[]> => {
    const out: DicomElement[] = [];
    for (const el of elements) {
      const action = actionFor(el);
      if (action === 'remove') {
        counts.removed++;
        if (groupOf(el.tag) % 2 === 1) counts.privates++;
        continue;
      }
      if (el.items) {
        out.push({ ...el, items: await Promise.all(el.items.map(transform)) });
        continue;
      }
      if (el === topPixel && opts.replacePixels) {
        out.push({ tag: PIXEL_DATA, vr: 'OB', value: opts.replacePixels.data });
        continue;
      }
      if (el === topPixel && pixelInfo) {
        out.push({ ...el, value: blackOutPixels(pixelInfo, opts.pixelBoxes!) });
        continue;
      }
      if (!el.value || el.value.length === 0 || action === 'keep') {
        out.push(recode(el));
        continue;
      }
      const raw = str(el);
      switch (action) {
        case 'uid': {
          const parts = await Promise.all(raw.split('\\').map((u) => (u.trim() ? uid(u.trim()) : Promise.resolve(''))));
          raw.split('\\').forEach((u, i) => {
            if (u.trim() && parts[i] !== u.trim()) {
              originals.add(u.trim());
              if (pseudo) uidMapping[u.trim()] = parts[i];
            }
          });
          counts.uids++;
          out.push({ ...el, value: ascii(parts.join('\\')) });
          break;
        }
        case 'date':
        case 'birthdate': {
          counts.dates++;
          let v: string;
          if (action === 'birthdate' && !pseudo) v = '';
          else
            v = mapValues(raw, (d) =>
              // Date ranges (A-B) are shifted end by end.
              d
                .split('-')
                .map((part) => {
                  if (!part) return '';
                  if (pseudo) {
                    if (/^\d{8}$/.test(part.replace(/\./g, ''))) originals.add(part.replace(/\./g, ''));
                    return shiftDa(part, opts.dateShiftDays!) ?? '';
                  }
                  const y = part.match(/^(\d{4})/);
                  return y ? `${y[1]}0101` : '';
                })
                .join('-')
            );
          out.push({ ...el, value: ascii(v) });
          break;
        }
        case 'datetime': {
          counts.dates++;
          const v = mapValues(raw, (dt) => {
            const core = dt.replace(/[+-]\d{4}$/, ''); // timezone offset hints at location
            const m = core.match(/^(\d{8})(.*)$/);
            if (pseudo && m) return (shiftDa(m[1], opts.dateShiftDays!) ?? '') + (shiftDa(m[1], 0) ? m[2] : '');
            return core.slice(0, 4);
          });
          out.push({ ...el, value: ascii(v) });
          break;
        }
        case 'time': {
          if (pseudo) {
            out.push(recode(el));
          } else {
            counts.times++;
            out.push({ ...el, value: ascii(mapValues(raw, () => '000000')) });
          }
          break;
        }
        case 'age': {
          const v = mapValues(raw, (a) => {
            const m = a.match(/^(\d{3})Y$/);
            if (m && +m[1] > 89) {
              counts.ages++;
              return '090Y';
            }
            return a;
          });
          out.push({ ...el, value: ascii(v) });
          break;
        }
        case 'leaf': {
          const found = leafOut.get(el);
          if (!found || found.next === found.leaf.value) {
            out.push(recode(el));
            break;
          }
          const { leaf, next } = found;
          counts.text++;
          if (leaf.label) originals.add(leaf.value);
          const fitted = fitToVr(next, el.vr);
          if (fitted !== next) counts.shortened++;
          out.push({ ...el, value: el.vr === '' ? LATIN1.encode(fitted) : output.encode(fitted) });
          break;
        }
        default:
          out.push(recode(el));
      }
    }
    return out;
  };

  /** Re-encode text when the output charset differs from the input's. */
  const recode = (el: DicomElement): DicomElement => {
    if (!outputTerm || !el.value || !CHARSET_VRS.has(el.vr)) return el;
    return { ...el, value: output.encode(cleanString(input.decode(el.value))) };
  };

  const dataset = await transform(ingest.file.dataset);

  // ── De-identification markers (PS3.15 E.1.1, PS3.3 C.12.1.1) ───────────
  const methodCodes: Array<[string, string]> = [
    ['113100', 'Basic Application Confidentiality Profile'],
    ['113105', 'Clean Descriptors Option'],
    ['113108', 'Retain Patient Characteristics Option'],
  ];
  if (pseudo) methodCodes.push(['113107', 'Retain Longitudinal Temporal Information Modified Dates Option']);
  const code = (v: string, meaning: string): DicomElement[] => [
    { tag: T('00080100'), vr: 'SH', value: ascii(v) },
    { tag: T('00080102'), vr: 'SH', value: ascii('DCM') },
    { tag: T('00080104'), vr: 'LO', value: ascii(meaning) },
  ];
  setElement(dataset, { tag: T('00120062'), vr: 'CS', value: ascii('YES') });
  setElement(dataset, {
    tag: T('00120063'),
    vr: 'LO',
    value: ascii(`PrivacyScript ${pseudo ? 'pseudonymised' : 'anonymised'}, PS3.15 Annex E`),
  });
  setElement(dataset, { tag: T('00120064'), vr: 'SQ', items: methodCodes.map(([v, m]) => code(v, m)) });
  setElement(dataset, { tag: T('00280303'), vr: 'CS', value: ascii('MODIFIED') });
  if (outputTerm) setElement(dataset, { tag: T('00080005'), vr: 'CS', value: ascii(outputTerm) });

  // ── File meta: new instance UID, our implementation, no source AE ──────
  const sopInstance = dataset.find((e) => e.tag === T('00080018'));
  const meta: DicomElement[] = [];
  for (const el of ingest.file.meta) {
    if (el.tag === T('00020000') || el.tag === T('00020016') || el.tag >= T('00020100')) continue;
    if (el.tag === T('00020003')) {
      if (sopInstance?.value) meta.push({ ...el, value: sopInstance.value });
      else if (el.value) meta.push({ ...el, value: ascii(await uid(str(el))) });
      continue;
    }
    if (el.tag === T('00020012') || el.tag === T('00020013')) continue;
    meta.push(el);
  }
  if (opts.replacePixels) {
    // The decoded image is written uncompressed: 8-bit, interleaved, and
    // RGB when it has colour (the browser decodes YBR to RGB).
    const rgb = opts.replacePixels.samples === 3;
    setElement(dataset, { tag: T('00280002'), vr: 'US', value: new Uint8Array([opts.replacePixels.samples, 0]) });
    setElement(dataset, { tag: T('00280004'), vr: 'CS', value: ascii(rgb ? 'RGB' : 'MONOCHROME2') });
    if (rgb) setElement(dataset, { tag: T('00280006'), vr: 'US', value: new Uint8Array([0, 0]) });
    else {
      const i = dataset.findIndex((e) => e.tag === T('00280006'));
      if (i >= 0) dataset.splice(i, 1);
    }
    setElement(dataset, { tag: T('00280100'), vr: 'US', value: new Uint8Array([8, 0]) });
    setElement(dataset, { tag: T('00280101'), vr: 'US', value: new Uint8Array([8, 0]) });
    setElement(dataset, { tag: T('00280102'), vr: 'US', value: new Uint8Array([7, 0]) });
    setElement(dataset, { tag: T('00280103'), vr: 'US', value: new Uint8Array([0, 0]) });
  }
  const outTs = opts.replacePixels
    ? TS_EXPLICIT
    : ingest.file.transferSyntax === TS_DEFLATE
    ? TS_EXPLICIT
    : ingest.file.transferSyntax;
  setElement(meta, { tag: T('00020001'), vr: 'OB', value: new Uint8Array([0, 1]) });
  setElement(meta, { tag: T('00020010'), vr: 'UI', value: ascii(outTs) });
  setElement(meta, { tag: T('00020012'), vr: 'UI', value: ascii(PRIVACYSCRIPT_IMPLEMENTATION_UID) });
  setElement(meta, { tag: T('00020013'), vr: 'SH', value: ascii('PRIVACYSCRIPT') });
  if (!meta.some((e) => e.tag === T('00020002'))) {
    const cls = dataset.find((e) => e.tag === T('00080016'));
    if (cls?.value) setElement(meta, { tag: T('00020002'), vr: 'UI', value: cls.value });
  }
  if (!meta.some((e) => e.tag === T('00020003')) && sopInstance?.value) {
    setElement(meta, { tag: T('00020003'), vr: 'UI', value: sopInstance.value });
  }

  const bytes = writeDicom({
    meta,
    dataset,
    transferSyntax: outTs,
    explicit: outTs !== TS_IMPLICIT,
  });

  const notes = [
    `DICOM: de-identified to PS3.15 Annex E (Basic Profile, Clean Descriptors, Retain Patient Characteristics${pseudo ? ', Modified Dates' : ''}).`,
    `DICOM: ${counts.removed} elements removed (${counts.privates} private), ${counts.uids} UID elements replaced, ${counts.dates} date elements ${pseudo ? `shifted by ${opts.dateShiftDays} days` : 'reduced to the year'}${pseudo ? '' : `, ${counts.times} times cleared`}, ${counts.text} text values changed.`,
  ];
  if (counts.ages) notes.push(`DICOM: ${counts.ages} ages over 89 shown as 90.`);
  if (counts.shortened) notes.push(`DICOM: ${counts.shortened} replacement codes shortened to fit the field length (8-character code kept).`);
  if (outputTerm) notes.push('DICOM: text re-encoded as UTF-8 (ISO_IR 192).');
  const burned = burnedInWarning(ingest.burnedIn);
  if (opts.replacePixels) {
    notes.push(
      `DICOM pixels: compressed (JPEG) image decoded in the browser; ${opts.pixelBoxes?.length ?? 0} identifying text area(s) blacked out in every frame; written uncompressed (no second lossy compression). Reading text from images is not perfect: the user confirmed they checked the picture.`
    );
  } else if (pixelInfo) {
    notes.push(
      `DICOM pixels: text read from the image; ${opts.pixelBoxes!.length} identifying text area(s) blacked out in all ${pixelInfo.frames} frame(s). Reading text from images is not perfect: the user confirmed they checked the picture.`
    );
  } else {
    notes.push(burned ? `DICOM pixels: ${burned}` : 'DICOM pixels: copied unchanged.');
  }

  return { bytes, uidMapping, originals: [...originals], notes };
}

function setElement(list: DicomElement[], el: DicomElement) {
  const i = list.findIndex((e) => e.tag >= el.tag);
  if (i === -1) list.push(el);
  else if (list[i].tag === el.tag) list[i] = el;
  else list.splice(i, 0, el);
}

/* ----------------------------------------------------------------------------
 * Output inspection (validation)
 * --------------------------------------------------------------------------*/

/**
 * Every text value in a written file (pixel and binary data excluded), plus
 * the subset the span engine reads. Validation runs on the REAL output bytes.
 */
export async function dicomTextValues(bytes: Uint8Array): Promise<{ all: string[]; engine: string[] }> {
  const file = await parseDicom(bytes.slice().buffer);
  const { input } = charsetsFor(file.dataset);
  const all: string[] = [];
  const engine: string[] = [];
  const walk = (elements: DicomElement[]) => {
    for (const el of elements) {
      if (el.items) {
        el.items.forEach(walk);
        continue;
      }
      if (!el.value || el.tag === PIXEL_DATA) continue;
      if (BINARY_VRS.has(el.vr) && el.vr !== 'UN') continue;
      if ((el.vr === '' || el.vr === 'UN') && !isPrintable(el.value)) continue;
      const v = cleanString(el.vr === '' || el.vr === 'UN' ? LATIN1.decode(el.value) : input.decode(el.value));
      if (!v) continue;
      all.push(v);
      if (actionFor(el) === 'leaf') engine.push(v);
    }
  };
  walk(file.meta);
  walk(file.dataset);
  return { all, engine };
}
