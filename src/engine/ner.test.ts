import { describe, expect, it } from 'vitest';
import { aggregateEntities, rawNerToSpans, wordPieceOffsets, withOffsets, fitToModel, type PositionedNer } from '@/engine/ner';

/**
 * Regression tests for NER post-processing.
 *
 * transformers.js emits one entry per BERT token (no aggregation_strategy
 * support), so "Anjula Weeranayake" arrives as subword fragments. Before the
 * aggregation step, each fragment ("An", "We", "N") surfaced as its own
 * meaningless detection in the UI.
 */

const raw = (
  entity: string,
  word: string,
  start: number,
  end: number,
  score = 0.99
) => ({ entity, word, start, end, score, index: 0 });

describe('aggregateEntities', () => {
  it('merges B-/I- subword tokens into one entity', () => {
    const text = 'Anjula Weeranayake wrote this.';
    const tokens = [
      raw('B-PER', 'An', 0, 2),
      raw('I-PER', '##ju', 2, 4),
      raw('I-PER', '##la', 4, 6),
      raw('I-PER', 'We', 7, 9),
      raw('I-PER', '##era', 9, 12),
      raw('I-PER', '##nayake', 12, 18),
    ];
    const groups = aggregateEntities(tokens, text);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('PER');
    expect(text.slice(groups[0].start, groups[0].end)).toBe('Anjula Weeranayake');
  });

  it('starts a new group on a B- tag with a gap', () => {
    const text = 'Alice met Bob.';
    const tokens = [
      raw('B-PER', 'Alice', 0, 5),
      raw('B-PER', 'Bob', 10, 13),
    ];
    const groups = aggregateEntities(tokens, text);
    expect(groups).toHaveLength(2);
  });

  it('does not merge across non-whitespace gaps', () => {
    const text = 'NIST, and Microsoft';
    const tokens = [
      raw('B-ORG', 'NIST', 0, 4),
      raw('I-ORG', 'Microsoft', 10, 19),
    ];
    const groups = aggregateEntities(tokens, text);
    expect(groups).toHaveLength(2);
  });
});

describe('rawNerToSpans', () => {
  it('drops stray fragments shorter than 3 characters', () => {
    const text = 'An update on N systems.';
    const tokens = [
      raw('B-ORG', 'An', 0, 2),
      raw('B-ORG', 'N', 13, 14),
    ];
    // "An" expands to the word "An" (2 chars) and "N" to "N" — both dropped.
    expect(rawNerToSpans(tokens, text, 0)).toHaveLength(0);
  });

  it('snaps partial-word fragments to whole words', () => {
    const text = 'Signed by Weeranayake today.';
    // Model only tagged the first subword of the surname.
    const tokens = [raw('B-PER', 'We', 10, 12)];
    const spans = rawNerToSpans(tokens, text, 0);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('Weeranayake');
    expect(spans[0].label).toBe('NAME');
  });

  it('drops single generic document words like DISCHARGE', () => {
    const text = 'DISCHARGE SUMMARY for review.';
    const tokens = [raw('B-LOC', 'DISCHARGE', 0, 9)];
    expect(rawNerToSpans(tokens, text, 0)).toHaveLength(0);
  });

  it('keeps multi-word entities containing a document word', () => {
    const text = 'Seen at Manchester Discharge Unit.';
    const tokens = [
      raw('B-ORG', 'Manchester', 8, 18),
      raw('I-ORG', 'Discharge', 19, 28),
      raw('I-ORG', 'Unit', 29, 33),
    ];
    const spans = rawNerToSpans(tokens, text, 0);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('Manchester Discharge Unit');
  });

  it('applies the chunk offset to span positions', () => {
    const text = 'Dr Holloway';
    const tokens = [raw('B-PER', 'Holloway', 3, 11)];
    const spans = rawNerToSpans(tokens, text, 100);
    expect(spans[0].start).toBe(103);
    expect(spans[0].end).toBe(111);
  });
});

describe('offsets when the pipeline reports start/end as null (transformers.js v2)', () => {
  const text = 'Another test with Alicia and Bruno.';
  // What bert-base-NER's tokenizer yields for this text.
  const tokens = ['[CLS]', 'Another', 'test', 'with', 'Ali', '##ci', '##a', 'and', 'Bruno', '.', '[SEP]'];

  it('aligns WordPiece tokens to character offsets', () => {
    const o = wordPieceOffsets(tokens, text);
    expect(o[0]).toBeNull();
    expect(text.slice(...(o[4] as [number, number]))).toBe('Ali');
    expect(text.slice(...(o[6] as [number, number]))).toBe('a');
    expect(text.slice(...(o[8] as [number, number]))).toBe('Bruno');
  });

  it('puts names on the right words instead of the first word of the chunk', () => {
    const raw = [
      { entity: 'B-PER', word: 'Ali', index: 4, start: null, end: null, score: 0.99 },
      { entity: 'I-PER', word: '##ci', index: 5, start: null, end: null, score: 0.99 },
      { entity: 'I-PER', word: '##a', index: 6, start: null, end: null, score: 0.99 },
      { entity: 'B-PER', word: 'Bruno', index: 8, start: null, end: null, score: 0.99 },
    ];
    const positioned = withOffsets(raw, wordPieceOffsets(tokens, text)) as PositionedNer[];
    const names = rawNerToSpans(positioned, text, 0).map((s) => s.text);
    expect(names).toEqual(['Alicia', 'Bruno']);
  });

  it('drops an entity it cannot place rather than guessing', () => {
    const raw = [{ entity: 'B-PER', word: 'X', index: 99, start: null, end: null, score: 0.99 }];
    expect(withOffsets(raw, wordPieceOffsets(tokens, text))).toHaveLength(0);
  });
});

describe('offset alignment recovers after a token it cannot match', () => {
  it('keeps aligning later tokens when a symbol was rewritten by the tokenizer', () => {
    const text = 'We tried… then Alicia joined.';
    // Suppose the tokenizer rewrote "…" as "...": that token will not match.
    const tokens = ['[CLS]', 'We', 'tried', '...', 'then', 'Alicia', 'joined', '.', '[SEP]'];
    const o = wordPieceOffsets(tokens, text);
    expect(o[3]).toBeNull();
    expect(text.slice(...(o[5] as [number, number]))).toBe('Alicia');
  });
});

describe('fitToModel', () => {
  // Fake tokenizer: one token per whitespace-separated word.
  const tokenizer = Object.assign(
    (t: string) => ({ input_ids: { data: t.split(/\s+/).filter(Boolean) as unknown as number[] } }),
    { model: { convert_ids_to_tokens: (ids: number[]) => ids.map(String) } }
  );

  it('splits a chunk until every piece fits the token window, keeping offsets', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');
    const pieces = fitToModel({ tokenizer }, { text, offset: 100 });
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces) expect(p.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(500);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces[1].offset).toBe(100 + pieces[0].text.length);
  });
});
