import { describe, it, expect } from 'vitest';
import { detect } from '@/engine/detect';
import { assessCompliance } from '@/engine/compliance';
import { assessScriptCoverage } from '@/engine/script-coverage';

/** Fully identifiable Tamil record: name, NIC, address, diagnosis. */
const TAMIL_RECORD = `
நோயாளியின் பெயர்: திருநாவுக்கரசு கனகசபை
அடையாள அட்டை எண்: 851234567V
முகவரி: இல. 25/3, பேஸ்லைன் வீதி, கொழும்பு 09
நோய் கண்டறிதல்: நீரிழிவு நோய் மற்றும் சிறுநீரக செயலிழப்பு
`;

/** Fully identifiable Sinhala record. */
const SINHALA_RECORD = `
රෝගියාගේ නම: නිමල් පෙරේරා
ජාතික හැඳුනුම්පත් අංකය: 851234567V
ලිපිනය: අංක 25/3, බේස්ලයින් මාවත, කොළඹ 09
`;

/** Latin, no identifiers, no health context — must still be able to pass. */
const BENIGN_ENGLISH = `
The meeting notes from Tuesday were circulated to the working group.
Everyone agreed the revised wording was clearer than the previous draft.
`;

function report(text: string) {
  return assessCompliance({
    jurisdiction: 'GENERAL',
    text,
    detection: detect(text),
  });
}

describe('assessScriptCoverage', () => {
  it('returns null for Latin-only text', () => {
    expect(assessScriptCoverage(BENIGN_ENGLISH)).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(assessScriptCoverage('')).toBeNull();
  });

  it('flags a Tamil document as UNREADABLE and names the script', () => {
    const w = assessScriptCoverage(TAMIL_RECORD);
    expect(w).not.toBeNull();
    expect(w!.severity).toBe('UNREADABLE');
    expect(w!.scripts).toContain('Tamil');
    expect(w!.unreadableRatio).toBeGreaterThan(0.15);
  });

  it('flags a Sinhala document as UNREADABLE and names the script', () => {
    const w = assessScriptCoverage(SINHALA_RECORD);
    expect(w).not.toBeNull();
    expect(w!.severity).toBe('UNREADABLE');
    expect(w!.scripts).toContain('Sinhala');
  });

  it('flags a mostly-English document with an embedded foreign passage as PARTIAL', () => {
    const mixed =
      BENIGN_ENGLISH.repeat(3) +
      '\nநோயாளியின் பெயர் திருநாவுக்கரசு கனகசபை முகவரி கொழும்பு வீதி\n';
    const w = assessScriptCoverage(mixed);
    expect(w).not.toBeNull();
    expect(w!.severity).toBe('PARTIAL');
  });
});

describe('compliance verdict under unreadable script', () => {
  // The regression this whole module exists for: before the gate, a fully
  // identifiable Tamil record returned SAFE / "Appears safe for AI upload".
  it('never returns SAFE for an identifiable Tamil record', () => {
    const r = report(TAMIL_RECORD);
    expect(r.verdict).not.toBe('SAFE');
    expect(r.verdict).toBe('CANNOT_ASSESS');
    expect(r.distributionSafety.safe).toBe(false);
    expect(r.aiUploadSafety.safe).toBe(false);
  });

  it('never returns SAFE for an identifiable Sinhala record', () => {
    expect(report(SINHALA_RECORD).verdict).toBe('CANNOT_ASSESS');
  });

  it('surfaces the script warning on the report and in the notes', () => {
    const r = report(TAMIL_RECORD);
    expect(r.scriptWarning).not.toBeNull();
    expect(r.scriptWarning!.scripts).toContain('Tamil');
    expect(r.notes.some((n) => n.includes('Tamil'))).toBe(true);
    expect(r.verdictDescription).toContain('Tamil');
  });

  it('tells the user to review by hand rather than to de-identify', () => {
    const notes = report(TAMIL_RECORD).notes.join(' ');
    expect(notes).toContain('review it by hand');
    expect(notes).not.toContain('Recommended next step: de-identify');
  });

  it('leaves Latin-script assessment unchanged', () => {
    const r = report(BENIGN_ENGLISH);
    expect(r.scriptWarning).toBeNull();
    expect(r.verdict).toBe('SAFE');
  });

  it('keeps DO_NOT_UPLOAD when identifiers were actually found', () => {
    // Latin identifiers plus English health context inside a Tamil document:
    // we know it is unsafe, so the definite verdict must win over uncertainty.
    const r = report(
      TAMIL_RECORD +
        '\nPatient name: Nimal Perera\nEmail: nimal@example.lk\nDiagnosis: diabetes\n'
    );
    expect(r.verdict).toBe('DO_NOT_UPLOAD');
    // The script caveat is still attached even though the verdict is definite.
    expect(r.scriptWarning).not.toBeNull();
  });
});
