/**
 * End-to-end pipeline smoke test using a synthetic clinical record. Verifies
 * detect → replace → validate produces leak-free output in both modes.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { validate } from '@/engine/validate';
import { generateSessionSecret } from '@/engine/crypto';
import { Crypto } from '@peculiar/webcrypto';

// Polyfill Web Crypto for Node test env.
if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const SAMPLE = `
PATIENT DISCHARGE SUMMARY

Name: John Smith
DOB: 12/03/1955
NHS no: 943 476 5919
Address: 10 Downing St, London SW1A 2AA
Email: john.smith@example.com
Phone: +44 20 7946 0123
MRN: ABC-12345

Admitted on 2024-03-15, seen by Dr. Patel at St Mary's Hospital.
Discharged 2024-03-20. Diagnoses include I10 (HTN) and Q90.0.

Next of kin contact: 555-123-4567.
`.trim();

afterAll(() => { /* nothing to clean up */ });

describe('end-to-end pipeline', () => {
  it('pseudonymise mode produces leak-free, key-recoverable output', async () => {
    const detection = detect(SAMPLE);
    expect(detection.spans.length).toBeGreaterThan(5);

    const secret = await generateSessionSecret();
    const result = await replaceSpans(SAMPLE, detection.spans, detection.quasiSpans, {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(['RARE_DISEASE_ICD']),
    });

    const v = validate(result.text, {
      mode: 'PSEUDONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    expect(v.passed).toBe(true);
    expect(result.mapping).toBeTruthy();

    // Pseudonyms are deterministic for the same (label, token) pair under one secret.
    const second = await replaceSpans(SAMPLE, detection.spans, detection.quasiSpans, {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(['RARE_DISEASE_ICD']),
    });
    expect(second.text).toBe(result.text);
  });

  it('anonymise mode replaces direct identifiers and passes validation', async () => {
    const detection = detect(SAMPLE);
    const result = await replaceSpans(SAMPLE, detection.spans, detection.quasiSpans, {
      mode: 'ANONYMISE',
      quasiToRedact: new Set(['RARE_DISEASE_ICD']),
    });
    const v = validate(result.text, {
      mode: 'ANONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    expect(v.passed).toBe(true);
    // Year-only date generalisation: "1955" or "2024" should appear, but not "12/03/1955".
    expect(result.text).not.toContain('12/03/1955');
  });
});
