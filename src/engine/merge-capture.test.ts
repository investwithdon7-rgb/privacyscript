import { describe, expect, it } from 'vitest';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';

/** A context rule merged with a model detection replaces only the name. */
async function anonymise(text: string, name: string) {
  const i = text.indexOf(name);
  const det = detect(text, [{ start: i, end: i + name.length, text: name, label: 'NAME', category: 'HIPAA', source: 'ner', confidence: 0.99 }]);
  return (await replaceSpans(text, det.spans, det.quasiSpans, { mode: 'ANONYMISE', quasiToRedact: new Set() })).text;
}

describe('merged spans keep their context words', () => {
  it('relationship context', async () => {
    expect(await anonymise('Her daughter Amira drives her to clinic.', 'Amira')).toBe('Her daughter [NAME] drives her to clinic.');
  });
  it('field label', async () => {
    expect(await anonymise('PATIENT NAME: JOHN BAKER\nSeen today.', 'JOHN BAKER')).toBe('PATIENT NAME: [NAME]\nSeen today.');
  });
});
