/**
 * Photo metadata removal (JPEG, PNG, WebP). Lossless: the picture data is
 * copied byte for byte, only metadata blocks are dropped.
 *
 * Phone and camera photos (wounds, skin conditions, X-ray screenshots) can
 * carry GPS location, the owner's name, device serial numbers, dates, and an
 * embedded thumbnail of the original, uncropped picture. All of it goes:
 *   JPEG: APP1 (EXIF incl. thumbnail, XMP), APP13 (IPTC), APP3-APP12,
 *         APP15, comments. Kept: JFIF, ICC colour profile, Adobe colour
 *         info, and the orientation (re-written as a one-field EXIF, so the
 *         photo is not shown sideways).
 *   PNG:  tEXt, zTXt, iTXt, eXIf, tIME chunks.
 *   WebP: EXIF and XMP chunks.
 *
 * What is IN the picture (a face, a wristband, a name on a screen) is not
 * changed; the user is asked to check it.
 */

export type ImageKind = 'JPEG' | 'PNG' | 'WEBP';

export interface ImageFinding {
  /** Plain-language name: "GPS location", "Camera owner". */
  field: string;
  /** Readable value when there is one (for the review screen). */
  value: string;
}

export interface ImageIngest {
  kind: ImageKind;
  bytes: Uint8Array;
  findings: ImageFinding[];
  /** EXIF orientation (1-8) to keep, when the photo had one. */
  orientation: number | null;
}

export const IMAGE_MIME: Record<ImageKind, string> = { JPEG: 'image/jpeg', PNG: 'image/png', WEBP: 'image/webp' };

export function imageKind(b: Uint8Array): ImageKind | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'WEBP';
  return null;
}

function ascii(b: Uint8Array, at: number, n: number) {
  return String.fromCharCode(...b.subarray(at, at + n));
}

function latin1(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

function clean(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\0+$/, '').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim();
}

export function ingestImage(buffer: ArrayBuffer): ImageIngest {
  const bytes = new Uint8Array(buffer);
  const kind = imageKind(bytes);
  if (!kind) {
    throw new Error(
      'This picture format is not supported yet. Save it as JPEG or PNG (for example with your phone\'s "Most compatible" setting) and try again.'
    );
  }
  const findings: ImageFinding[] = [];
  let orientation: number | null = null;
  if (kind === 'JPEG') {
    for (const seg of jpegSegments(bytes)) {
      const { marker, data } = seg;
      if (marker === 0xe1 && ascii(data, 0, 6) === 'Exif\0\0') {
        const exif = readExif(data.subarray(6));
        orientation = exif.orientation;
        findings.push(...exif.findings);
      } else if (marker === 0xe1 && latin1(data.subarray(0, 40)).startsWith('http://ns.adobe.com/xap/')) {
        findings.push({ field: 'XMP metadata', value: xmpSummary(new TextDecoder().decode(data)) });
      } else if (marker === 0xed) {
        findings.push({ field: 'IPTC metadata', value: 'captions, names, places or keywords' });
      } else if (marker === 0xfe) {
        findings.push({ field: 'Comment', value: clean(latin1(data)) });
      } else if (isRemovedJpegApp(marker, data)) {
        findings.push({ field: `Application data (APP${marker - 0xe0})`, value: '' });
      }
    }
  } else if (kind === 'PNG') {
    for (const c of pngChunks(bytes)) {
      if (c.type === 'tEXt') {
        const z = c.data.indexOf(0);
        findings.push({ field: `Text: ${latin1(c.data.subarray(0, z))}`, value: clean(latin1(c.data.subarray(z + 1))) });
      } else if (c.type === 'iTXt') {
        const z = c.data.indexOf(0);
        const compressed = c.data[z + 1] === 1;
        let rest = c.data.subarray(z + 3);
        rest = rest.subarray(rest.indexOf(0) + 1); // language tag
        rest = rest.subarray(rest.indexOf(0) + 1); // translated keyword
        findings.push({
          field: `Text: ${latin1(c.data.subarray(0, z))}`,
          value: compressed ? '(compressed text)' : clean(new TextDecoder().decode(rest)),
        });
      } else if (c.type === 'zTXt') {
        findings.push({ field: `Text: ${latin1(c.data.subarray(0, c.data.indexOf(0)))}`, value: '(compressed text)' });
      } else if (c.type === 'eXIf') {
        const exif = readExif(c.data);
        findings.push(...exif.findings);
      } else if (c.type === 'tIME') {
        findings.push({ field: 'Last modified time', value: '' });
      }
    }
  } else {
    for (const c of webpChunks(bytes)) {
      if (c.fourcc === 'EXIF') {
        const d = ascii(c.data, 0, 6) === 'Exif\0\0' ? c.data.subarray(6) : c.data;
        findings.push(...readExif(d).findings);
      } else if (c.fourcc === 'XMP ') {
        findings.push({ field: 'XMP metadata', value: xmpSummary(new TextDecoder().decode(c.data)) });
      }
    }
  }
  return { kind, bytes, findings, orientation };
}

/** The photo with every metadata block removed. */
export function stripImage(img: ImageIngest): Uint8Array {
  if (img.kind === 'JPEG') return stripJpeg(img.bytes, img.orientation);
  if (img.kind === 'PNG') return stripPng(img.bytes);
  return stripWebp(img.bytes);
}

/* ── JPEG ───────────────────────────────────────────────────────────────── */

interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF marker byte. */
  start: number;
  end: number;
  data: Uint8Array;
}

/** Header segments up to (not including) start of scan. */
function jpegSegments(b: Uint8Array): JpegSegment[] {
  const out: JpegSegment[] = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error('This JPEG file is damaged.');
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = (b[p + 2] << 8) | b[p + 3];
    out.push({ marker, start: p, end: p + 2 + len, data: b.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
  }
  return out;
}

function isRemovedJpegApp(marker: number, data: Uint8Array): boolean {
  if (marker === 0xe0) return false; // JFIF / JFXX
  if (marker === 0xe2 && latin1(data.subarray(0, 12)) === 'ICC_PROFILE\0') return false;
  if (marker === 0xee && ascii(data, 0, 5) === 'Adobe') return false;
  return (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
}

function stripJpeg(b: Uint8Array, orientation: number | null): Uint8Array {
  const segs = jpegSegments(b);
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let insertedOrientation = false;
  const orientationSeg = () => {
    // "Exif\0\0" + big-endian TIFF header + IFD0 with one entry (0x0112).
    const s = new Uint8Array(2 + 2 + 6 + 8 + 2 + 12 + 4);
    const v = new DataView(s.buffer);
    v.setUint16(0, 0xffe1);
    v.setUint16(2, s.length - 2);
    s.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    s.set([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], 10);
    v.setUint16(18, 1);
    v.setUint16(20, 0x0112);
    v.setUint16(22, 3);
    v.setUint32(24, 1);
    v.setUint16(28, orientation!);
    return s;
  };
  for (const seg of segs) {
    const remove = isRemovedJpegApp(seg.marker, seg.data);
    if (remove) continue;
    kept.push(b.subarray(seg.start, seg.end));
    // Orientation goes right after JFIF (APP0) or first, before other segments.
    if (!insertedOrientation && orientation && orientation !== 1 && seg.marker === 0xe0) {
      kept.push(orientationSeg());
      insertedOrientation = true;
    }
  }
  if (!insertedOrientation && orientation && orientation !== 1) kept.splice(1, 0, orientationSeg());
  const last = segs.length ? segs[segs.length - 1].end : 2;
  kept.push(b.subarray(last)); // scan data and everything after, unchanged
  return concat(kept);
}

/* ── EXIF ───────────────────────────────────────────────────────────────── */

const EXIF_TEXT_TAGS: Record<number, string> = {
  0x010e: 'Image description',
  0x010f: 'Camera make',
  0x0110: 'Camera model',
  0x0131: 'Software',
  0x0132: 'Date modified',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x9003: 'Date taken',
  0x9004: 'Date digitised',
  0x9286: 'User comment',
  0xa420: 'Unique image ID',
  0xa430: 'Camera owner',
  0xa431: 'Camera serial number',
  0xa435: 'Lens serial number',
  0x9c9b: 'Title',
  0x9c9c: 'Comment',
  0x9c9d: 'Author',
  0x9c9e: 'Keywords',
  0x9c9f: 'Subject',
};

function readExif(tiff: Uint8Array): { findings: ImageFinding[]; orientation: number | null } {
  const findings: ImageFinding[] = [];
  let orientation: number | null = null;
  if (tiff.length < 8) return { findings, orientation };
  const le = tiff[0] === 0x49;
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  let thumbnail = false;
  let gps = false;

  const readIfd = (off: number, depth: number, isGps = false) => {
    if (depth > 4 || off + 2 > tiff.length) return 0;
    const n = u16(off);
    const gpsVals: Record<number, number[] | string> = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size > tiff.length) continue;
      const raw = tiff.subarray(at, at + size);
      if (isGps) {
        gps = true;
        if (type === 5) {
          gpsVals[tag] = Array.from({ length: count }, (_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
        } else if (type === 2) gpsVals[tag] = clean(latin1(raw));
        continue;
      }
      if (tag === 0x0112 && type === 3) orientation = u16(e + 8);
      else if (tag === 0x8769 || tag === 0xa005) readIfd(u32(e + 8), depth + 1);
      else if (tag === 0x8825) readIfd(u32(e + 8), depth + 1, true);
      else if (EXIF_TEXT_TAGS[tag]) {
        let value: string;
        if (tag >= 0x9c9b && tag <= 0x9c9f) value = new TextDecoder('utf-16le').decode(raw);
        else if (tag === 0x9286) value = latin1(raw.subarray(8)); // 8-byte charset prefix
        else value = latin1(raw);
        value = clean(value);
        if (value) findings.push({ field: EXIF_TEXT_TAGS[tag], value });
      }
    }
    if (isGps) {
      const dms = (x: number[] | string | undefined) =>
        Array.isArray(x) && x.length === 3 ? x[0] + x[1] / 60 + x[2] / 3600 : null;
      const lat = dms(gpsVals[2]);
      const lon = dms(gpsVals[4]);
      const value =
        lat !== null && lon !== null
          ? `${(gpsVals[1] === 'S' ? -lat : lat).toFixed(5)}, ${(gpsVals[3] === 'W' ? -lon : lon).toFixed(5)}`
          : 'present';
      findings.push({ field: 'GPS location', value });
    }
    return off + 2 + n * 12 + 4 <= tiff.length ? u32(off + 2 + n * 12) : 0;
  };

  const ifd1 = readIfd(u32(4), 0);
  if (ifd1) thumbnail = true; // IFD1 holds the embedded thumbnail
  if (thumbnail) findings.push({ field: 'Embedded thumbnail', value: 'small copy of the original picture' });
  void gps;
  return { findings, orientation };
}

function xmpSummary(xml: string): string {
  const picks = ['dc:creator', 'photoshop:City', 'Iptc4xmpCore:Location', 'exif:GPSLatitude', 'xmp:CreatorTool'];
  const found = picks.filter((t) => xml.includes(t)).map((t) => t.split(':')[1]);
  return found.length ? `includes ${found.join(', ')}` : 'editing history and descriptive fields';
}

/* ── PNG ────────────────────────────────────────────────────────────────── */

const PNG_REMOVE = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function pngChunks(b: Uint8Array) {
  const out: Array<{ type: string; start: number; end: number; data: Uint8Array }> = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = v.getUint32(p);
    const type = ascii(b, p + 4, 4);
    const end = p + 12 + len;
    if (end > b.length) throw new Error('This PNG file is damaged.');
    out.push({ type, start: p, end, data: b.subarray(p + 8, p + 8 + len) });
    p = end;
    if (type === 'IEND') break;
  }
  return out;
}

function stripPng(b: Uint8Array): Uint8Array {
  return concat([b.subarray(0, 8), ...pngChunks(b).filter((c) => !PNG_REMOVE.has(c.type)).map((c) => b.subarray(c.start, c.end))]);
}

/* ── WebP ───────────────────────────────────────────────────────────────── */

function webpChunks(b: Uint8Array) {
  const out: Array<{ fourcc: string; start: number; end: number; data: Uint8Array }> = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  while (p + 8 <= b.length) {
    const fourcc = ascii(b, p, 4);
    const size = v.getUint32(p + 4, true);
    const end = p + 8 + size + (size % 2);
    out.push({ fourcc, start: p, end: Math.min(end, b.length), data: b.subarray(p + 8, p + 8 + size) });
    p = end;
  }
  return out;
}

function stripWebp(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of webpChunks(b)) {
    if (c.fourcc === 'EXIF' || c.fourcc === 'XMP ') continue;
    let chunk = b.slice(c.start, c.end);
    if (c.fourcc === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
    parts.push(chunk);
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
