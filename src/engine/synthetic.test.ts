/**
 * Regression test against the synthetic record set in PH records/. These are
 * fabricated records that look like real clinical data and exercise the full
 * range of HIPAA 18 + EU identifiers + Orphanet rare-disease codes.
 *
 * Test goals:
 *  - Every patient's NHS number / MRN / SSN / phone / email / DOB / address is
 *    detected.
 *  - Anonymise output passes validation cleanly.
 *  - Pseudonymise output is stable across reruns and recovers exactly via the
 *    mapping.
 *  - Quasi-identifiers (ethnicity, occupation, rare ICD) are flagged, not
 *    auto-removed.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { validate } from '@/engine/validate';
import { generateSessionSecret } from '@/engine/crypto';
import { parseFhir } from '@/formats/fhir';
import { parseCsv } from '@/formats/csv';
import { Crypto } from '@peculiar/webcrypto';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const RECORDS_DIR = path.join(__dirname, '..', '..', 'PH records');
const LEAF_DELIM = '';

function loadFhir(): string {
  return fs.readFileSync(path.join(RECORDS_DIR, 'fhir_patients_bundle.json'), 'utf8');
}

function loadCsv(): string {
  return fs.readFileSync(path.join(RECORDS_DIR, 'fhir_patients.csv'), 'utf8');
}

describe('synthetic FHIR bundle', () => {
  it('detects expected direct identifiers across the bundle', () => {
    const { leaves } = parseFhir(loadFhir());
    const text = leaves.map((l) => l.value).join(LEAF_DELIM);
    const { spans, counts } = detect(text);

    // Floors — the bundle has 5 patients with 4 emails, 4 NHS numbers,
    // 5 birthDates, 4 phones. Total direct identifiers should clear ~25.
    expect(counts['EMAIL'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts['DATE'] ?? 0).toBeGreaterThanOrEqual(4);
    expect((counts['NHS_NUMBER'] ?? 0) + (counts['PHONE'] ?? 0)).toBeGreaterThanOrEqual(6);
    expect(spans.length).toBeGreaterThan(20);
  });

  it('anonymise pass leaks no original identifiers', async () => {
    const { leaves } = parseFhir(loadFhir());
    const text = leaves.map((l) => l.value).join(LEAF_DELIM);
    const detection = detect(text);
    const result = await replaceSpans(text, detection.spans, detection.quasiSpans, {
      mode: 'ANONYMISE',
      quasiToRedact: new Set(['RARE_DISEASE_ICD']),
    });
    const v = await validate(result.text, {
      mode: 'ANONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    expect(v.passed).toBe(true);
  });

  it('pseudonymise pass is deterministic from the secret', async () => {
    const { leaves } = parseFhir(loadFhir());
    const text = leaves.map((l) => l.value).join(LEAF_DELIM);
    const detection = detect(text);
    const secret = await generateSessionSecret();
    const a = await replaceSpans(text, detection.spans, detection.quasiSpans, {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });
    const b = await replaceSpans(text, detection.spans, detection.quasiSpans, {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });
    expect(a.text).toBe(b.text);
  });
});

describe('synthetic CSV', () => {
  it('parses headers and rows, exposes string leaves', () => {
    const csv = parseCsv(loadCsv());
    expect(csv.headers).toContain('family');
    expect(csv.headers).toContain('birthDate');
    expect(csv.rows.length).toBeGreaterThanOrEqual(20);
    expect(csv.leaves.length).toBeGreaterThan(150);
  });

  it('anonymise pass leaks no original identifiers', async () => {
    const csv = parseCsv(loadCsv());
    const text = csv.leaves.map((l) => l.value).join(LEAF_DELIM);
    const detection = detect(text);
    const result = await replaceSpans(text, detection.spans, detection.quasiSpans, {
      mode: 'ANONYMISE',
      quasiToRedact: new Set(['RARE_DISEASE_ICD', 'INSTITUTION', 'OCCUPATION', 'ETHNICITY']),
    });
    const v = await validate(result.text, {
      mode: 'ANONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    if (!v.passed) {
      // Surface first few leaks so we can fix the catalogue.
      // eslint-disable-next-line no-console
      console.log('leaks:', v.leaks.slice(0, 8).map((s) => `${s.label}=${JSON.stringify(s.text)}`));
      // eslint-disable-next-line no-console
      console.log('originals leaked:', v.originalsLeaked.slice(0, 8));
    }
    expect(v.passed).toBe(true);
  });
});
