import { describe, expect, it } from 'vitest';
import { Crypto } from '@peculiar/webcrypto';
import { replaceSpans } from '@/engine/replace';
import { validate } from '@/engine/validate';
import { generateSessionSecret } from '@/engine/crypto';
import type { Span } from '@/engine/detect';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as unknown as { crypto: Crypto }).crypto = new Crypto();
}

const nameSpan = (text: string, start: number): Span => ({
  start,
  end: start + text.length,
  text,
  label: 'NAME',
  category: 'HIPAA',
  source: 'ner',
  confidence: 0.95,
});

describe('replaceSpans — verbatim residual sweep', () => {
  it('replaces repeat occurrences no span covered, with the same token', async () => {
    // "Karoline Stenberg" detected once (span) but repeated bare later —
    // the audit finding that produced VALIDATION: LEAK on the PDF record.
    const text =
      'Seen by specialist nurse Karoline Stenberg on the ward. ' +
      'Home visit (Karoline Stenberg) arranged for next week.';
    const idx = text.indexOf('Karoline Stenberg');
    const secret = await generateSessionSecret();
    const result = await replaceSpans(text, [nameSpan('Karoline Stenberg', idx)], [], {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });

    expect(result.text).not.toContain('Karoline');
    expect(result.residualSweeps).toBe(1);
    // Both occurrences carry the SAME pseudonym.
    const token = result.mapping['Karoline Stenberg'];
    expect(result.text.split(token)).toHaveLength(3);

    const v = await validate(result.text, {
      mode: 'PSEUDONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    expect(v.passed).toBe(true);
  });

  it('sweeps longer originals before shorter overlapping ones', async () => {
    const text =
      'Northwell General Hospital admitted the patient. ' +
      'Contact Northwell General Hospital records. Northwell switchboard: ext 4471.';
    const secret = await generateSessionSecret();
    const spans: Span[] = [
      { ...nameSpan('Northwell General Hospital', 0), label: 'INSTITUTION', category: 'QUASI' },
      { ...nameSpan('Northwell', text.lastIndexOf('Northwell')), label: 'NAME', category: 'HIPAA' },
    ];
    const result = await replaceSpans(text, [spans[1]], [spans[0]], {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(['INSTITUTION']),
    });

    expect(result.text).not.toContain('Northwell');
    const v = await validate(result.text, {
      mode: 'PSEUDONYMISE',
      originalIdentifiers: Object.keys(result.mapping),
    });
    expect(v.passed).toBe(true);
  });

  it('never rewrites inside inserted replacement tokens', async () => {
    // An original that could collide with token internals (uppercase word).
    const text = 'Referred by NAME desk. Later the NAME desk confirmed.';
    const idx = text.indexOf('NAME desk');
    const secret = await generateSessionSecret();
    const result = await replaceSpans(text, [nameSpan('NAME desk', idx)], [], {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });
    // Exactly one token shape [NAME-XXXXXXXX] per occurrence, not nested mangling.
    const tokens = result.text.match(/\[NAME-[A-F0-9]{8}\]/g) ?? [];
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(1);
  });

  it('sweeps whitespace variants of a replaced original', async () => {
    // PDF text extraction yields variable spacing — "Karoline  Stenberg"
    // (double space) must be swept by the "Karoline Stenberg" mapping.
    const text = 'Nurse Karoline Stenberg attended. Visit by Karoline  Stenberg confirmed.';
    const idx = text.indexOf('Karoline Stenberg');
    const secret = await generateSessionSecret();
    const result = await replaceSpans(text, [nameSpan('Karoline Stenberg', idx)], [], {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });
    expect(result.text).not.toContain('Karoline');
    expect(result.text).not.toContain('Stenberg');
  });

  it('does not sweep very short originals', async () => {
    const text = 'Dr Ash saw the patient. Ash trees line the drive.';
    const idx = text.indexOf('Ash');
    const secret = await generateSessionSecret();
    const result = await replaceSpans(text, [nameSpan('Ash', idx)], [], {
      mode: 'PSEUDONYMISE',
      secret,
      quasiToRedact: new Set(),
    });
    // "Ash" (3 chars) is below the sweep floor — second occurrence stays.
    expect(result.text).toContain('Ash trees');
    expect(result.residualSweeps).toBe(0);
  });
});
