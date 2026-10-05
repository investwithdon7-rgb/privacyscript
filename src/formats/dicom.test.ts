import { describe, expect, it } from 'vitest';
import {
  dicomTextValues,
  ingestDicom,
  parseDicom,
  rebuildDicom,
  writeDicom,
  type DicomElement,
  type DicomFile,
} from '@/formats/dicom';
import { generateSessionSecret } from '@/engine/crypto';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import type { Mode } from '@/lib/constants';

const T = (hex: string) => parseInt(hex, 16) >>> 0;
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const el = (tag: string, vr: string, v: string): DicomElement => ({ tag: T(tag), vr, value: enc(v) });

const STUDY_UID = '1.3.6.1.4.1.5962.99.1.2786334768.1849416866.1385765836848.3.0';
const SOP_UID = '1.3.6.1.4.1.5962.99.1.2786334768.1849416866.1385765836848.5.0';
const CT_CLASS = '1.2.840.10008.5.1.4.1.1.2';

function sampleFile(explicit = true, ts = '1.2.840.10008.1.2.1'): DicomFile {
  return {
    transferSyntax: ts,
    explicit,
    meta: [
      el('00020001', 'OB', '\0\u0001'),
      el('00020002', 'UI', CT_CLASS),
      el('00020003', 'UI', SOP_UID),
      el('00020010', 'UI', ts),
      el('00020016', 'AE', 'ST_MARYS_CT1'),
    ],
    dataset: [
      el('00080016', 'UI', CT_CLASS),
      el('00080018', 'UI', SOP_UID),
      el('00080020', 'DA', '20240312'),
      el('00080030', 'TM', '101500'),
      el('00080050', 'SH', 'ACC99812'),
      el('00080060', 'CS', 'CT'),
      el('00080070', 'LO', 'SIEMENS'),
      el('00080080', 'LO', "St Mary's Hospital"),
      el('00080090', 'PN', 'House^Gregory^^Dr'),
      el('00081030', 'LO', 'CT CHEST WITH CONTRAST'),
      {
        tag: T('00081110'),
        vr: 'SQ',
        items: [[el('00081150', 'UI', '1.2.840.10008.3.1.2.3.1'), el('00081155', 'UI', STUDY_UID)]],
      },
      el('00100010', 'PN', 'Stenberg^Karoline'),
      el('00100020', 'LO', 'MRN-4471902'),
      el('00100030', 'DA', '19310704'),
      el('00100040', 'CS', 'F'),
      el('00101010', 'AS', '092Y'),
      el('00101040', 'LO', '12 Harbour Road, Leith'),
      {
        tag: T('00101002'),
        vr: 'SQ',
        items: [[el('00100020', 'LO', 'NHS 943 476 5919')]],
      },
      el('00104000', 'LT', 'Patient is a retired teacher from Leith'),
      el('0020000D', 'UI', STUDY_UID),
      el('00200010', 'SH', 'STUDY7781'),
      el('00290010', 'LO', 'SIEMENS CSA HEADER'),
      el('00291010', 'OB', 'Karoline Stenberg private'),
      el('00400275', 'SQ', ''),
      el('60003000', 'OW', '\0\0\0\0'),
      { tag: T('7FE00010'), vr: 'OW', value: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    ],
  };
}

/** Run the engine the way the hook does: forced leaf spans + rules, then replace. */
async function deidentify(bytes: Uint8Array, mode: Mode) {
  const ingest = await ingestDicom(bytes.slice().buffer);
  const D = '\u001F';
  const values = ingest.leaves.map((l) => l.value);
  let off = 0;
  const forced = values.flatMap((v, i) => {
    const s = off;
    off += v.length + 1;
    const label = ingest.leaves[i].label;
    return label
      ? [{ start: s, end: s + v.length, text: v, label, category: 'HIPAA' as const, source: 'rule' as const, confidence: 1 }]
      : [];
  });
  const text = values.join(D);
  const det = detect(text, forced);
  const secret = mode === 'PSEUDONYMISE' ? await generateSessionSecret() : undefined;
  const rep = await replaceSpans(text, det.spans, det.quasiSpans, { mode, secret, quasiToRedact: new Set() });
  const out = await rebuildDicom(ingest, rep.text.split(D), { mode, secret, dateShiftDays: rep.dateShiftDays });
  return { ingest, rep, out, parsed: await parseDicom(out.bytes.slice().buffer) };
}

const find = (els: DicomElement[], tag: string) => els.find((e) => e.tag === T(tag));
const str = (e?: DicomElement) => (e?.value ? String.fromCharCode(...e.value).replace(/[\0 ]+$/, '') : undefined);

describe('DICOM codec', () => {
  it('round-trips explicit and implicit VR little endian', async () => {
    for (const [explicit, ts] of [
      [true, '1.2.840.10008.1.2.1'],
      [false, '1.2.840.10008.1.2'],
    ] as const) {
      const bytes = writeDicom(sampleFile(explicit, ts));
      const file = await parseDicom(bytes.slice().buffer);
      expect(file.transferSyntax).toBe(ts);
      expect(str(find(file.dataset, '00100010'))).toBe('Stenberg^Karoline');
      const seq = find(file.dataset, '00081110');
      expect(seq?.items?.[0].length).toBe(2);
      expect(str(find(seq!.items![0], '00081155'))).toBe(STUDY_UID);
    }
  });

  it('reads a file that says explicit VR but is written implicit', async () => {
    const bytes = writeDicom(sampleFile(false, '1.2.840.10008.1.2.1'));
    const { parsed } = await deidentify(bytes, 'ANONYMISE');
    expect(str(find(parsed.dataset, '00080016'))).toBe(CT_CLASS);
    expect(str(find(parsed.dataset, '00100010'))).toBe('[NAME]');
  });

  it('copies encapsulated (compressed) pixel fragments byte for byte', async () => {
    const f = sampleFile(true, '1.2.840.10008.1.2.4.50');
    const frag = new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 4, 0, 0, 0, 0xff, 0xd8, 0xff, 0xd9]);
    const delim = new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
    const bot = new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]);
    const encapsulated = new Uint8Array([...bot, ...frag, ...delim]);
    f.dataset[f.dataset.length - 1] = { tag: T('7FE00010'), vr: 'OB', encapsulated };
    const { parsed } = await deidentify(writeDicom(f), 'ANONYMISE');
    expect(parsed.transferSyntax).toBe('1.2.840.10008.1.2.4.50');
    expect(Array.from(find(parsed.dataset, '7FE00010')!.encapsulated!)).toEqual(Array.from(encapsulated));
  });

  it('refuses big endian with a plain explanation', async () => {
    const bytes = writeDicom(sampleFile(true, '1.2.840.10008.1.2.2'));
    await expect(parseDicom(bytes.slice().buffer)).rejects.toThrow(/big-endian/);
  });
});

describe('DICOM de-identification (PS3.15 Annex E)', () => {
  it('anonymise: removes, replaces and generalises per the profile', async () => {
    const { parsed, out } = await deidentify(writeDicom(sampleFile()), 'ANONYMISE');
    const ds = parsed.dataset;

    // Private tags, overlays, address, comments, other-IDs sequence, institution: gone.
    for (const tag of ['00290010', '00291010', '60003000', '00101040', '00104000', '00101002', '00080080', '00400275']) {
      expect(find(ds, tag), tag).toBeUndefined();
    }
    // Names and IDs replaced.
    expect(str(find(ds, '00100010'))).toBe('[NAME]');
    expect(str(find(ds, '00080090'))).toBe('[NAME]');
    expect(str(find(ds, '00100020'))).not.toContain('4471902');
    expect(str(find(ds, '00080050'))).not.toBe('ACC99812');
    // Dates: year only; birth date emptied; times cleared; age capped.
    expect(str(find(ds, '00080020'))).toBe('20240101');
    expect(str(find(ds, '00100030')) ?? '').toBe('');
    expect(str(find(ds, '00080030'))).toBe('000000');
    expect(str(find(ds, '00101010'))).toBe('090Y');
    // Kept: class UIDs, sex, manufacturer, clinical description, pixels.
    expect(str(find(ds, '00080016'))).toBe(CT_CLASS);
    expect(str(find(ds, '00100040'))).toBe('F');
    expect(str(find(ds, '00080070'))).toBe('SIEMENS');
    expect(str(find(ds, '00081030'))).toBe('CT CHEST WITH CONTRAST');
    expect(Array.from(find(ds, '7FE00010')!.value!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Instance UIDs replaced, consistently, under 2.25.
    const study = str(find(ds, '0020000D'))!;
    expect(study).toMatch(/^2\.25\.\d+$/);
    expect(str(find(find(ds, '00081110')!.items![0], '00081155'))).toBe(study);
    expect(str(find(find(ds, '00081110')!.items![0], '00081150'))).toBe('1.2.840.10008.3.1.2.3.1');
    // Meta header follows the new SOP instance, drops the source AE title.
    expect(str(find(parsed.meta, '00020003'))).toBe(str(find(ds, '00080018')));
    expect(find(parsed.meta, '00020016')).toBeUndefined();
    // De-identification markers.
    expect(str(find(ds, '00120062'))).toBe('YES');
    const codes = find(ds, '00120064')!.items!.map((i) => str(find(i, '00080100')));
    expect(codes).toEqual(['113100', '113105', '113108']);
    expect(out.uidMapping).toEqual({}); // anonymise: nothing to re-link
  });

  it('pseudonymise: HMAC codes, shifted dates, UID mapping for the key file', async () => {
    const { parsed, out, rep } = await deidentify(writeDicom(sampleFile()), 'PSEUDONYMISE');
    const ds = parsed.dataset;
    expect(str(find(ds, '00100010'))).toMatch(/^\[NAME-[0-9A-F]{8}\]$/);
    expect(str(find(ds, '00100020'))).toMatch(/^\[MRN-[0-9A-F]{8}\]$/);
    // SH holds 16 characters: a long code keeps just its 8-character hash.
    expect(str(find(ds, '00080050'))!.length).toBeLessThanOrEqual(16);
    const shift = rep.dateShiftDays!;
    const expected = new Date(Date.UTC(2024, 2, 12 + shift)).toISOString().slice(0, 10).replace(/-/g, '');
    expect(str(find(ds, '00080020'))).toBe(expected);
    expect(str(find(ds, '00100030'))).toMatch(/^\d{8}$/);
    expect(str(find(ds, '00100030'))).not.toBe('19310704');
    expect(str(find(ds, '00080030'))).toBe('101500');
    expect(out.uidMapping[STUDY_UID]).toBe(str(find(ds, '0020000D')));
    expect(out.uidMapping[SOP_UID]).toBe(str(find(ds, '00080018')));
    expect(find(ds, '00120064')!.items!.map((i) => str(find(i, '00080100')))).toContain('113107');
  });

  it('no original identifier survives anywhere in the written file', async () => {
    for (const mode of ['ANONYMISE', 'PSEUDONYMISE'] as const) {
      const { out } = await deidentify(writeDicom(sampleFile()), mode);
      const { all } = await dicomTextValues(out.bytes);
      const text = all.join('\n');
      for (const original of ['Stenberg', 'Karoline', 'Gregory', '4471902', 'ACC99812', 'STUDY7781', STUDY_UID, SOP_UID, '19310704', 'Leith', 'ST_MARYS_CT1', "St Mary's"]) {
        expect(text, `${mode}: ${original}`).not.toContain(original);
      }
      expect(out.originals).toContain(STUDY_UID);
    }
  });

  it('cleans names inside nested sequences and from standard tags sent as UN', async () => {
    const f = sampleFile();
    f.dataset.splice(10, 0, {
      tag: T('00081111'),
      vr: 'SQ',
      items: [[el('00081155', 'UI', SOP_UID), el('00401010', 'PN', 'Wilson^James')]],
    });
    f.dataset.splice(2, 0, { tag: T('00081070'), vr: 'UN', value: enc('Cuddy^Lisa') });
    const { out } = await deidentify(writeDicom(f), 'ANONYMISE');
    const text = (await dicomTextValues(out.bytes)).all.join('\n');
    expect(text).not.toContain('Wilson');
    expect(text).not.toContain('Cuddy');
  });

  it('flags images that usually carry burned-in text', async () => {
    const f = sampleFile();
    f.dataset.find((e) => e.tag === T('00080060'))!.value = enc('US');
    expect((await ingestDicom(writeDicom(f).slice().buffer)).burnedIn).toBe('LIKELY');
    f.dataset.splice(f.dataset.length - 2, 0, el('00280301', 'CS', 'YES'));
    expect((await ingestDicom(writeDicom(f).slice().buffer)).burnedIn).toBe('YES');
    expect((await ingestDicom(writeDicom(sampleFile()).slice().buffer)).burnedIn).toBe('UNKNOWN');
  });
});
