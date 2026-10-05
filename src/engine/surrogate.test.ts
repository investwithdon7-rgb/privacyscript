import { describe, expect, it } from 'vitest';
import { SurrogateRegistry } from '@/engine/surrogate';
import { replaceSpans } from '@/engine/replace';
import { detect } from '@/engine/detect';
import { validate } from '@/engine/validate';

describe('realistic surrogates', () => {
  it('keeps one person one fake name across forms, titles and case', () => {
    const r = new SurrogateRegistry('seed-1');
    const full = r.get('NAME', 'Karoline Stenberg')!;
    const [first, last] = full.split(' ');
    expect(full).not.toMatch(/Karoline|Stenberg/);
    expect(r.get('NAME', 'Mrs Stenberg')).toBe(`Mrs ${last}`);
    expect(r.get('NAME', 'KAROLINE')).toBe(first.toUpperCase());
    expect(r.get('NAME', 'STENBERG^KAROLINE')).toBe(`${last.toUpperCase()}^${first.toUpperCase()}`);
  });

  it('never gives two people the same fake name', () => {
    const r = new SurrogateRegistry('seed-2');
    const fakes = new Set<string>();
    for (let i = 0; i < 300; i++) fakes.add(r.get('NAME', `Person${i} Surname${i}`)!);
    expect(fakes.size).toBe(300);
  });

  it('uses reserved fictional ranges and keeps formats', () => {
    const r = new SurrogateRegistry('seed-3');
    expect(r.get('NHS_NUMBER', '943 476 5919')).toMatch(/^999 \d{3} \d{4}$/);
    expect(r.get('PHONE', '07700 123456')).toMatch(/^07700 900\d{3}$/);
    expect(r.get('EMAIL', 'k.stenberg@nhs.net')).toMatch(/^[a-z]+\.[a-z]+@example\.org$/);
    expect(r.get('IP', '10.1.2.3')).toMatch(/^192\.0\.2\.\d+$/);
    expect(r.get('MRN', 'MRN-4471902')).toMatch(/^[A-Z]{3}-\d{7}$/);
    expect(r.get('DATE', '12/03/2024')).toBeNull(); // dates keep their usual handling
  });

  it('runs through the pipeline: no codes, no originals, no residual warnings', async () => {
    const text = 'Mrs Karoline Stenberg, NHS 943 476 5919, phone 07700 123456, email k.stenberg@nhs.net.';
    const det = detect(text, [{ start: 4, end: 21, text: 'Karoline Stenberg', label: 'NAME', category: 'HIPAA', source: 'ner', confidence: 0.99 }]);
    const r = new SurrogateRegistry('seed-4');
    const rep = await replaceSpans(text, det.spans, det.quasiSpans, {
      mode: 'ANONYMISE',
      quasiToRedact: new Set(),
      surrogates: (label, original) => r.get(label, original),
    });
    expect(rep.text).not.toMatch(/\[|Stenberg|943 476|123456|nhs\.net/);
    const v = await validate(rep.text, { mode: 'ANONYMISE', originalIdentifiers: Object.keys(rep.mapping), ownValues: Object.values(rep.mapping) });
    expect(v.passed).toBe(true);
    expect(v.leaks).toEqual([]);
  });
});
