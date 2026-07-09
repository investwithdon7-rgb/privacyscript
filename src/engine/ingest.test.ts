import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectFormat } from '@/engine/ingest';

describe('detectFormat', () => {
  it('recognises a FHIR bundle from a TRUNCATED 4 KB preview', () => {
    // Regression: the format sniff only sees the head of the file. A full
    // JSON.parse threw on the cut-off preview and every bundle larger than
    // the window was silently processed as plain text.
    const full = fs.readFileSync(
      path.join(__dirname, '..', '..', 'PH records', 'fhir_patients_bundle.json'),
      'utf8'
    );
    expect(full.length).toBeGreaterThan(4096);
    const preview = full.slice(0, 4096);
    expect(detectFormat('fhir_patients_bundle.json', preview)).toBe('FHIR_R4');
  });

  it('treats non-FHIR JSON as plain text', () => {
    expect(detectFormat('config.json', '{"theme": "dark", "fontSize": 14}')).toBe('TEXT');
  });

  it('detects HL7 by content', () => {
    expect(detectFormat('message', 'MSH|^~\\&|APP|FAC|...')).toBe('HL7_V2');
  });
});
