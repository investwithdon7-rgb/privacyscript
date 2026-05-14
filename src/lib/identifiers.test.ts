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
