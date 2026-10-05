import { describe, expect, it } from 'vitest';
import { flexibleWhitespacePattern, OriginalFinder } from '@/engine/replace';

/**
 * The one-pass finder must give exactly the answers of the per-original
 * regexes it replaced (the leak check depends on it). Random texts mix
 * names, emails, phone numbers, punctuation, accents and odd spacing.
 */

const PIECES = [
  'Karoline', 'Stenberg', 'José', 'Müller', "O'Brien", 'k.stenberg@example.org', '+44 131 496 0827',
  '(0131) 496', 'MRN-4471902', '4471902', 'St', "Mary's", 'Hospital', 'the', 'and', 'Stenbergs',
  'xKaroline', 'Karoline_2', '[NAME-3F7A91B2]', 'Leith,', 'Leith.', '\n', '  ', '\t', '-', '/',
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const ORIGINALS = [
  'Karoline', 'Karoline Stenberg', 'Stenberg', 'José', 'Müller', "O'Brien", 'k.stenberg@example.org',
  '+44 131 496 0827', '(0131) 496', 'MRN-4471902', '4471902', "St Mary's Hospital", 'Leith', 'Hospital',
];

function oldValidate(text: string, originals: string[]) {
  return originals.filter((o) =>
    new RegExp(`(?:^|\\b|\\s)${flexibleWhitespacePattern(o)}(?:$|\\b|\\s)`).test(text)
  );
}

function oldSweepMatches(text: string, original: string) {
  return [...text.matchAll(new RegExp(`(?<!\\w)${flexibleWhitespacePattern(original)}(?!\\w)`, 'g'))].map((m) => m.index);
}

describe('OriginalFinder', () => {
  it('agrees with the per-original regexes on random texts', () => {
    const r = rng(42);
    for (let n = 0; n < 2000; n++) {
      const words = Array.from({ length: 4 + Math.floor(r() * 12) }, () => PIECES[Math.floor(r() * PIECES.length)]);
      const text = words.join(r() < 0.5 ? ' ' : '');
      const found = new Set(new OriginalFinder(ORIGINALS, 'validate').findAll(text).map((h) => h.original));
      expect(ORIGINALS.filter((o) => found.has(o)), text).toEqual(oldValidate(text, ORIGINALS));

      const sweep = new OriginalFinder(ORIGINALS, 'sweep').findAll(text);
      for (const o of ORIGINALS) {
        const mine = sweep.filter((h) => h.original === o).map((h) => h.start).sort((a, b) => a - b);
        expect(mine, `${o} in ${JSON.stringify(text)}`).toEqual(oldSweepMatches(text, o));
      }
    }
  });
});
