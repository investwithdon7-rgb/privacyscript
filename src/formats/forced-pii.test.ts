import { describe, expect, it } from 'vitest';
import { parseFhir, forcedLabelForFhirPath } from '@/formats/fhir';
import { parseHL7, forcedLabelForHl7Leaf } from '@/formats/hl7';
import { forcedLabelForCsvColumn } from '@/formats/csv';
import { runRules } from '@/engine/detect';

/**
 * Structural PII forcing. Names in structured formats are ground truth from
 * the schema (FHIR paths, HL7 field positions, CSV headers) — they must be
 * redacted even when regex and NER produce no evidence. Regression for the
 * audit finding where Patient.name.family survived de-identification.
 */

describe('forcedLabelForFhirPath', () => {
  it('forces NAME for HumanName leaves', () => {
    expect(forcedLabelForFhirPath('entry[0].resource.name[0].family')).toBe('NAME');
    expect(forcedLabelForFhirPath('entry[0].resource.name[0].given[0]')).toBe('NAME');
    expect(forcedLabelForFhirPath('entry[2].resource.contact[0].name.family')).toBe('NAME');
    expect(forcedLabelForFhirPath('name[0].text')).toBe('NAME');
  });

  it('forces ADDRESS_LINE for address leaves', () => {
    expect(forcedLabelForFhirPath('entry[0].resource.address[0].line[0]')).toBe('ADDRESS_LINE');
    expect(forcedLabelForFhirPath('entry[0].resource.address[0].city')).toBe('ADDRESS_LINE');
  });

  it('leaves non-PII paths alone', () => {
    expect(forcedLabelForFhirPath('entry[0].resource.identifier[0].value')).toBeNull();
    expect(forcedLabelForFhirPath('entry[0].resource.birthDate')).toBeNull();
    expect(forcedLabelForFhirPath('entry[0].resource.name[0].use')).toBeNull();
  });

  it('produces paths that match real parseFhir output', () => {
    const { leaves } = parseFhir(
      JSON.stringify({
        resourceType: 'Patient',
        name: [{ family: 'Achterberg', given: ['Eveline'] }],
        address: [{ line: ['12 Larkspur Crescent'], city: 'Manchester' }],
      })
    );
    const forced = leaves.filter((l) => forcedLabelForFhirPath(l.path));
    const values = forced.map((l) => l.value);
    expect(values).toContain('Achterberg');
    expect(values).toContain('Eveline');
    expect(values).toContain('12 Larkspur Crescent');
    expect(values).toContain('Manchester');
  });
});

describe('forcedLabelForHl7Leaf', () => {
  it('forces NAME for PID-5 components and ADDRESS_LINE for PID-11', () => {
    const msg =
      'MSH|^~\\&|APP|FAC|APP2|FAC2|202606091200||ADT^A01|MSG1|P|2.5\r' +
      'PID|1||12345||Achterberg^Eveline^^^Mrs||19320314|F|||12 Larkspur Crescent^^Manchester^^M14 5TQ';
    const { doc, leaves } = parseHL7(msg);
    const byValue = (v: string) => leaves.find((l) => l.value === v)!;
    expect(forcedLabelForHl7Leaf(doc, byValue('Achterberg'))).toBe('NAME');
    expect(forcedLabelForHl7Leaf(doc, byValue('Eveline'))).toBe('NAME');
    expect(forcedLabelForHl7Leaf(doc, byValue('12 Larkspur Crescent'))).toBe('ADDRESS_LINE');
    expect(forcedLabelForHl7Leaf(doc, byValue('Manchester'))).toBe('ADDRESS_LINE');
    // PID-3 (patient ID) is not a name field.
    expect(forcedLabelForHl7Leaf(doc, byValue('12345'))).toBeNull();
  });
});

describe('forcedLabelForCsvColumn', () => {
  it('recognises name and address columns', () => {
    expect(forcedLabelForCsvColumn('family')).toBe('NAME');
    expect(forcedLabelForCsvColumn('given')).toBe('NAME');
    expect(forcedLabelForCsvColumn('First Name')).toBe('NAME');
    expect(forcedLabelForCsvColumn('surname')).toBe('NAME');
    expect(forcedLabelForCsvColumn('address_line_1')).toBe('ADDRESS_LINE');
    expect(forcedLabelForCsvColumn('city')).toBe('ADDRESS_LINE');
  });

  it('recognises FHIR-flattened dotted column names', () => {
    expect(forcedLabelForCsvColumn('name.family')).toBe('NAME');
    expect(forcedLabelForCsvColumn('address.line')).toBe('ADDRESS_LINE');
    expect(forcedLabelForCsvColumn('address.city')).toBe('ADDRESS_LINE');
    expect(forcedLabelForCsvColumn('address.country')).toBeNull();
  });

  it('leaves clinical columns alone', () => {
    expect(forcedLabelForCsvColumn('diagnosis')).toBeNull();
    expect(forcedLabelForCsvColumn('birthDate')).toBeNull();
    expect(forcedLabelForCsvColumn('nhsNumber')).toBeNull();
  });
});

describe('raw FHIR JSON name rule (batch / paste path)', () => {
  it('catches family and given fields in raw JSON text', () => {
    const json = '{"name": [{"family": "Achterberg", "given": ["Eveline", "Marie"]}]}';
    const spans = runRules(json).filter((s) => s.label === 'NAME');
    const covered = spans.map((s) => json.slice(s.captureStart ?? s.start, s.captureEnd ?? s.end));
    expect(covered.some((c) => c.includes('Achterberg'))).toBe(true);
    expect(covered.some((c) => c.includes('Eveline'))).toBe(true);
  });
});
