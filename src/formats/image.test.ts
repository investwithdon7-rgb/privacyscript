import { describe, expect, it } from 'vitest';
import { ingestImage, stripImage } from '@/formats/image';
import { JPEG_B64, PNG_B64, WEBP_B64 } from '@/formats/image.fixtures';

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/**
 * Bytes from the last start-of-scan marker (JPEG; an embedded thumbnail has
 * its own earlier one) or the image data chunk (PNG): the picture itself.
 */
function pictureData(b: Uint8Array, marker: string): string {
  const s = latin1(b);
  return s.slice(s.lastIndexOf(marker));
}

describe('photo metadata', () => {
  it('JPEG: finds and removes EXIF (GPS, owner, serial, thumbnail) and comments, keeps orientation', () => {
    const img = ingestImage(bytes(JPEG_B64).buffer);
    const fields = img.findings.map((f) => f.field);
    expect(fields).toEqual(
      expect.arrayContaining(['GPS location', 'Camera owner', 'Camera serial number', 'Artist', 'Date taken', 'Embedded thumbnail', 'Comment', 'Image description'])
    );
    expect(img.findings.find((f) => f.field === 'GPS location')!.value).toBe('51.50737, -0.12767');
    expect(img.orientation).toBe(6);

    const out = stripImage(img);
    const again = ingestImage(out.slice().buffer);
    expect(again.findings).toEqual([]);
    expect(again.orientation).toBe(6);
    const text = latin1(out);
    for (const s of ['Stenberg', 'House', 'SN-99812', 'iPhone', '2024:03:12']) expect(text).not.toContain(s);
    // The compressed picture is copied byte for byte.
    expect(pictureData(out, '\xff\xda')).toBe(pictureData(bytes(JPEG_B64), '\xff\xda'));
  });

  it('PNG: removes text, eXIf and time chunks; image data unchanged', () => {
    const img = ingestImage(bytes(PNG_B64).buffer);
    expect(img.findings.map((f) => f.field)).toEqual(expect.arrayContaining(['Text: Author', 'Text: Description', 'GPS location']));
    const out = stripImage(img);
    expect(ingestImage(out.slice().buffer).findings).toEqual([]);
    expect(latin1(out)).not.toContain('Stenberg');
    expect(pictureData(out, 'IDAT')).toBe(pictureData(bytes(PNG_B64), 'IDAT'));
  });

  it('WebP: removes EXIF and fixes the container size', () => {
    const img = ingestImage(bytes(WEBP_B64).buffer);
    expect(img.findings.map((f) => f.field)).toEqual(expect.arrayContaining(['Artist', 'GPS location']));
    const out = stripImage(img);
    expect(ingestImage(out.slice().buffer).findings).toEqual([]);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it('explains unsupported formats in plain language', () => {
    expect(() => ingestImage(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]).buffer)).toThrow(/JPEG or PNG/);
  });
});
