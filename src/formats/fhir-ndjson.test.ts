import { describe, expect, it } from 'vitest';
import { forcedLabelForFhirPath, isNdjson, parseFhir, reconstructFhir } from '@/formats/fhir';
import { detectFormat } from '@/engine/ingest';

const NDJSON = [
  '{"resourceType":"Patient","id":"p1","name":[{"family":"Stenberg","given":["Karoline"]}]}',
  '{"resourceType":"Observation","id":"o1","subject":{"reference":"Patient/p1"},"valueString":"Seen by Dr House"}',
  '{"resourceType":"Patient","id":"p2","name":[{"family":"Nowak","given":["Tomasz"]}]}',
].join('\n');

describe('FHIR bulk export (NDJSON)', () => {
  it('is recognised by content and extension', () => {
    expect(isNdjson(NDJSON)).toBe(true);
    expect(isNdjson('{"resourceType":"Patient"}')).toBe(false);
    expect(detectFormat('Patient.ndjson', NDJSON.slice(0, 200))).toBe('FHIR_R4');
  });

  it('reads every line, forces names, and writes one resource per line', () => {
    const { resource, leaves, ndjson } = parseFhir(NDJSON);
    expect(ndjson).toBe(true);
    const names = leaves.filter((l) => forcedLabelForFhirPath(l.path) === 'NAME').map((l) => l.value);
    expect(names).toEqual(['Stenberg', 'Karoline', 'Nowak', 'Tomasz']);
    const out = reconstructFhir(
      resource,
      leaves.map((l) => ({ path: l.path, replacement: forcedLabelForFhirPath(l.path) ? '[NAME]' : l.value, referencePrefix: l.referencePrefix }))
    , true);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).name[0].family).toBe('[NAME]');
    expect(JSON.parse(lines[1]).subject.reference).toBe('Patient/p1');
    expect(out).not.toContain('Nowak');
  });
});
