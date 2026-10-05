import { describe, expect, it } from 'vitest';
import { parseWordList, wordListSpans } from '@/engine/wordlist';

describe('study word list', () => {
  it('parses one term per line with optional type prefixes', () => {
    expect(parseWordList('# staff\nSiobhan Kelly\nplace: Kingsway\norg: Harbour Road Surgery\nid: STUDY-77\nsiobhan kelly\n\nx')).toEqual([
      { term: 'Siobhan Kelly', label: 'NAME' },
      { term: 'Kingsway', label: 'ADDRESS_LINE' },
      { term: 'Harbour Road Surgery', label: 'INSTITUTION' },
      { term: 'STUDY-77', label: 'REFERENCE_ID' },
    ]);
  });

  it('finds every mention regardless of case, only as whole words', () => {
    const text = 'SIOBHAN KELLY saw her on Kingsway. Siobhan  Kelly again; Kingswayside is elsewhere.';
    const spans = wordListSpans(text, parseWordList('Siobhan Kelly\nplace: Kingsway'));
    expect(spans.map((s) => [s.text, s.label])).toEqual([
      ['SIOBHAN KELLY', 'NAME'],
      ['Kingsway', 'ADDRESS_LINE'],
      ['Siobhan  Kelly', 'NAME'],
    ]);
    expect(spans.every((s) => s.confidence === 1 && s.category === 'HIPAA')).toBe(true);
  });
});
