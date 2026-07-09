import { describe, expect, it } from 'vitest';
import { validate } from '@/engine/validate';
import type { Span } from '@/engine/detect';

const nerSpan = (text: string, start: number, end: number, label: Span['label'] = 'ADDRESS_LINE'): Span => ({
  start,
  end,
  text,
  label,
  category: 'HIPAA',
  source: 'ner',
  confidence: 0.95,
});

describe('validate — NER second pass', () => {
  it('ignores NER hits that overlap the engine\'s own replacement tokens', async () => {
    const out = 'Seen at [ADDRESS_LINE-FAC59712] on discharge.';
    // The NER model fragments the token — "[ADDRESS" at offset 8.
    const v = await validate(out, {
      mode: 'ANONYMISE',
      originalIdentifiers: [],
      nerRunner: async () => [nerSpan('[ADDRESS', 8, 16)],
    });
    expect(v.nerLeaks).toHaveLength(0);
    expect(v.passed).toBe(true);
  });

  it('still reports genuine surviving names outside token ranges', async () => {
    const out = 'Seen at [ADDRESS_LINE-FAC59712] by Marcus Holloway.';
    const idx = out.indexOf('Marcus');
    const v = await validate(out, {
      mode: 'ANONYMISE',
      originalIdentifiers: [],
      nerRunner: async () => [nerSpan('Marcus Holloway', idx, idx + 15, 'NAME')],
    });
    expect(v.nerLeaks).toHaveLength(1);
    expect(v.nerLeaks[0].text).toBe('Marcus Holloway');
  });

  it('hard-fails when an original identifier survives verbatim', async () => {
    const v = await validate('Patient Eveline Achterberg discharged.', {
      mode: 'ANONYMISE',
      originalIdentifiers: ['Eveline Achterberg'],
    });
    expect(v.passed).toBe(false);
    expect(v.originalsLeaked).toContain('Eveline Achterberg');
  });
});
