import { describe, expect, it } from 'vitest';
import { runRules, detect } from '@/engine/detect';

/**
 * Regression tests for the identifier catalogue. The goal is to fail loud if a
 * future change breaks one of the HIPAA 18 / EU detectors.
 *
 * Test inputs are synthetic — no real PII.
 */

describe('runRules — HIPAA 18 coverage', () => {
  it('detects US SSN', () => {
    const r = runRules('Pt SSN 123-45-6789 confirmed.');
    expect(r.map((s) => s.label)).toContain('SSN');
  });

  it('rejects obvious invalid SSN areas (000/666/9xx)', () => {
    const r = runRules('Bad: 000-12-3456 666-12-3456 900-12-3456');
    expect(r.filter((s) => s.label === 'SSN')).toHaveLength(0);
  });

  it('detects email', () => {
    const r = runRules('Email: alice@example.com');
    expect(r.find((s) => s.label === 'EMAIL')?.text).toBe('alice@example.com');
  });

  it('detects URL and IP', () => {
    const r = runRules('See https://example.org and 192.168.0.10');
    expect(r.find((s) => s.label === 'URL')).toBeTruthy();
    expect(r.find((s) => s.label === 'IP')?.text).toBe('192.168.0.10');
  });

  it('detects phone numbers in common formats', () => {
    const r = runRules('Call +44 20 7946 0123 or (555) 123-4567 today.');
    expect(r.filter((s) => s.label === 'PHONE').length).toBeGreaterThanOrEqual(2);
  });

  it('detects MRN only with labelled context', () => {
    const r = runRules('MRN: AB12-345-6789. Lab value 12345 was reported.');
    expect(r.find((s) => s.label === 'MRN')).toBeTruthy();
  });

  it('detects ISO and slashed dates', () => {
    const r = runRules('Admitted 2024-03-15, discharged 03/20/2024.');
    expect(r.filter((s) => s.label === 'DATE').length).toBeGreaterThanOrEqual(2);
  });

  it('detects month-name dates', () => {
    const r = runRules('Born on 2 Jan 1980. Seen Jan 5, 2024.');
    expect(r.filter((s) => s.label === 'DATE').length).toBeGreaterThanOrEqual(2);
  });

  it('flags ages over 89 only', () => {
    const r = runRules('Patient age 87. Mother age 94 still alive.');
    const ages = r.filter((s) => s.label === 'AGE_OVER_89');
    expect(ages).toHaveLength(1);
    expect(ages[0].text).toContain('94');
  });

  it('detects US ZIP codes', () => {
    const r = runRules('Lives at 90210 and works at 02115-1234.');
    expect(r.filter((s) => s.label === 'POSTCODE_US').length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag standards designations as ZIP codes', () => {
    const r = runRules(
      'Aligned with ISO/IEC 42001 and ISO 27001; see also IEEE 29148 and NIST SP 80053.'
    );
    expect(r.filter((s) => s.label === 'POSTCODE_US')).toHaveLength(0);
  });
});

describe('runRules — EU / UK coverage', () => {
  it('detects NHS number', () => {
    const r = runRules('NHS no: 943 476 5919.');
    expect(r.find((s) => s.label === 'NHS_NUMBER')).toBeTruthy();
  });

  it('detects UK NINO', () => {
    const r = runRules('NINO AB 12 34 56 C on file.');
    expect(r.find((s) => s.label === 'UK_NINO')).toBeTruthy();
  });

  it('detects UK postcode', () => {
    const r = runRules('Home address: 10 Downing St, SW1A 2AA.');
    expect(r.find((s) => s.label === 'POSTCODE_UK')?.text.toUpperCase()).toBe('SW1A 2AA');
  });

  it('accepts checksum-valid NHS numbers and rejects phone numbers in NHS shape', () => {
    // 943 476 5919 is the NHS Data Dictionary's synthetic example (valid mod-11).
    const r = runRules('NHS number 943 476 5919. Phone: +44 161 496 0102.');
    const nhs = r.filter((s) => s.label === 'NHS_NUMBER');
    expect(nhs).toHaveLength(1);
    expect(nhs[0].text).toBe('943 476 5919');
    // The phone still gets caught by the PHONE rule.
    expect(r.find((s) => s.label === 'PHONE')).toBeTruthy();
  });

  it('still redacts checksum-invalid 10-digit codes as REFERENCE_ID', () => {
    // 6120847732 fails the NHS mod-11 check and has no phone separators —
    // it must not slip through undetected.
    const { spans } = detect('Beneficiary code 6120847732 on file.');
    const covering = spans.find((s) => s.text.includes('6120847732'));
    expect(covering).toBeTruthy();
    expect(covering!.label).toBe('REFERENCE_ID');
  });

  it('resolves an NHS-shaped phone number to PHONE after merge', () => {
    const { spans } = detect('Call us on +44 161 496 0102 today.');
    const covering = spans.find((s) => s.text.includes('161 496 0102'));
    expect(covering).toBeTruthy();
    expect(covering!.label).toBe('PHONE');
  });

  it('captures names with lowercase particles whole (al-Hashimi, van der Berg)', () => {
    const r = runRules('Seen with Mr Yusuf al-Hashimi and Mrs Anna van der Berg today.');
    const names = r.filter((s) => s.label === 'NAME').map((s) =>
      s.captureStart !== undefined
        ? 'Seen with Mr Yusuf al-Hashimi and Mrs Anna van der Berg today.'.slice(s.captureStart, s.captureEnd)
        : s.text
    );
    expect(names).toContain('Yusuf al-Hashimi');
    expect(names).toContain('Anna van der Berg');
  });

  it('does not capture lowercase phrases as names via case-insensitive rules', () => {
    // 'gi' rules used to capture "home visit" here, missing the real name.
    const r = runRules('Heart failure specialist nurse home visit (Karoline Stenberg) arranged.');
    const badName = r.find((s) => s.label === 'NAME' && s.text.includes('home'));
    expect(badName).toBeUndefined();
  });

  it('trims trailing lowercase words from name captures', () => {
    const text = 'Reviewed by specialist nurse Karoline Stenberg on 11 February.';
    const r = runRules(text);
    const name = r.find((s) => s.label === 'NAME');
    expect(name).toBeTruthy();
    const captured = text.slice(name!.captureStart ?? name!.start, name!.captureEnd ?? name!.end);
    expect(captured).toBe('Karoline Stenberg');
  });

  it('captures names with diacritics and initials', () => {
    const text = 'Letter from Dr Ingrid Hövding. Dictated 05/03/2024, typed by S. Roussakov today.';
    const r = runRules(text);
    const names = r.filter((s) => s.label === 'NAME').map((s) =>
      text.slice(s.captureStart ?? s.start, s.captureEnd ?? s.end)
    );
    expect(names).toContain('Ingrid Hövding');
    expect(names.some((n) => n.includes('Roussakov'))).toBe(true);
  });

  it('detects secretary / case coordinator name contexts', () => {
    const r = runRules('Contact via secretary Maureen Pollock. Case coordinator: Imogen Bramwell.');
    const names = r.filter((s) => s.label === 'NAME').map((s) => s.text);
    expect(names.some((n) => n.includes('Maureen Pollock'))).toBe(true);
    expect(names.some((n) => n.includes('Imogen Bramwell'))).toBe(true);
  });

  it('detects street addresses with extended suffixes and diacritics', () => {
    const r = runRules('Lives at 288 Pilton Causeway. Office at 12 Dún Laoghaire Quay.');
    const addr = r.filter((s) => s.label === 'ADDRESS_LINE').map((s) => s.text);
    expect(addr).toContain('288 Pilton Causeway');
    expect(addr).toContain('12 Dún Laoghaire Quay');
  });

  it('detects names introduced by relationship context', () => {
    const text = 'Attended with his wife Asma al-Hashimi. Copies to her daughter, Dr Layla al-Hashimi.';
    const r = runRules(text);
    const names = r.filter((s) => s.label === 'NAME').map((s) =>
      text.slice(s.captureStart ?? s.start, s.captureEnd ?? s.end)
    );
    expect(names.some((n) => n.includes('Asma'))).toBe(true);
    expect(names.some((n) => n.includes('Layla'))).toBe(true);
  });

  it('relationship context does not fire on lowercase non-names', () => {
    const r = runRules('Discussed with his wife about medication timing.');
    expect(r.filter((s) => s.label === 'NAME')).toHaveLength(0);
  });

  it('does not let labelled names run across line breaks', () => {
    const r = runRules('Patient name: Eveline Achterberg\nDOB: 14/03/1932');
    const name = r.find((s) => s.label === 'NAME');
    expect(name).toBeTruthy();
    expect(name!.text).not.toContain('DOB');
  });

  it('does not let occupation values run across line breaks', () => {
    const r = runRules('Occupation: retired schoolteacher\nEthnicity: White');
    const occ = r.find((s) => s.label === 'OCCUPATION');
    expect(occ).toBeTruthy();
    expect(occ!.text).not.toContain('Ethnicity');
  });

  it('detects labelled EU postcodes in common national shapes', () => {
    const r = runRules(
      'PLZ: 80331. Postcode 1012 AB. CAP 20100. Postal code: 12-345.'
    );
    expect(r.filter((s) => s.label === 'POSTCODE_EU').length).toBeGreaterThanOrEqual(4);
  });

  it('does not match prose words like "capable" as EU postcodes', () => {
    const r = runRules(
      'The system is capable and well suited; its capability or capacity to act as capable tools grows.'
    );
    expect(r.filter((s) => s.label === 'POSTCODE_EU')).toHaveLength(0);
  });

  it('detects Denmark CPR', () => {
    const r = runRules('CPR 010180-1234 listed.');
    expect(r.find((s) => s.label === 'NATIONAL_ID_DK_CPR')?.text).toBe('010180-1234');
  });

  it('detects Italy CF', () => {
    const r = runRules('CF RSSMRA80A01H501Z confirmed.');
    expect(r.find((s) => s.label === 'NATIONAL_ID_IT_CF')?.text).toBe('RSSMRA80A01H501Z');
  });

  it('detects IBAN', () => {
    const r = runRules('Pay to GB29NWBK60161331926819.');
    expect(r.find((s) => s.label === 'IBAN')?.text).toBe('GB29NWBK60161331926819');
  });
});

describe('detect — quasi-identifier separation', () => {
  it('puts ethnicity / occupation in quasiSpans, not main spans', () => {
    const text = 'Patient: Asian male. Occupation: nurse. Lives in SW1A 2AA.';
    const { spans, quasiSpans } = detect(text);
    expect(quasiSpans.find((s) => s.label === 'ETHNICITY')).toBeTruthy();
    expect(quasiSpans.find((s) => s.label === 'OCCUPATION')).toBeTruthy();
    expect(spans.find((s) => s.label === 'POSTCODE_UK')).toBeTruthy();
  });

  it('does not flag common ICD-10 codes as rare', () => {
    const r = runRules('Diagnosis: I10 (hypertension), E11.9 (T2DM).');
    expect(r.filter((s) => s.label === 'RARE_DISEASE_ICD')).toHaveLength(0);
  });

  it('flags rare ICD-10 codes from the Orphanet catalogue', () => {
    // Q91.0 (Edwards syndrome / trisomy 18) is in the Orphanet rare set.
    const r = runRules('Code: Q91.0 trisomy 18.');
    expect(r.find((s) => s.label === 'RARE_DISEASE_ICD')).toBeTruthy();
  });
});
