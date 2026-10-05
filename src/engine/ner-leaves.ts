/**
 * Name detection for structured inputs (surveys, FHIR, HL7, DICOM headers).
 * Kept out of ner.ts, which is also bundled into the background worker and
 * should not pull in the rule catalogue.
 */

import { runRules, type Span } from '@/engine/detect';
import { runClinicalNER, type NerRunOptions } from '@/engine/ner';

/**
 * Name detection for structured formats (survey cells, FHIR / HL7 fields,
 * DICOM header values). `values` are the leaves, joined in the caller's text
 * with a delimiter of `delimLength` characters.
 *
 * Each DISTINCT value is read once (survey answers repeat thousands of
 * times); values with no word in them (numbers, codes, dates) and leaves the
 * caller already marks as identifiers by their field are not read at all.
 * Spans are then copied to every leaf holding that value. On a 20k-row
 * survey this cuts the text the model reads from 2.8 MB to the free-text
 * answers.
 */
export async function runNerOnLeaves(
  values: string[],
  delimLength: number,
  skipLeaves: Set<number>,
  opts: Omit<NerRunOptions, 'skip'> = {},
  runner: (text: string, opts: NerRunOptions) => Promise<Span[]> = runClinicalNER
): Promise<Span[]> {
  const leafStart: number[] = [];
  const byValue = new Map<string, number[]>();
  let offset = 0;
  values.forEach((v, i) => {
    leafStart.push(offset);
    offset += v.length + delimLength;
    if (skipLeaves.has(i) || !/\p{L}{2,}/u.test(v)) return;
    const list = byValue.get(v);
    if (list) list.push(i);
    else byValue.set(v, [i]);
  });
  if (byValue.size === 0) return [];

  // One distinct value per paragraph: the blank line keeps entities from
  // running across two values.
  const SEP = '\n\n';
  const distinct = Array.from(byValue.keys());
  const docStart: number[] = [];
  let pos = 0;
  for (const v of distinct) {
    docStart.push(pos);
    pos += v.length + SEP.length;
  }
  const spans = await runner(distinct.join(SEP), opts);

  const out: Span[] = [];
  for (const s of spans) {
    // Which distinct value the span sits in (binary search on start).
    let lo = 0, hi = docStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (docStart[mid] <= s.start) lo = mid;
      else hi = mid - 1;
    }
    const value = distinct[lo];
    const relStart = s.start - docStart[lo];
    const relEnd = Math.min(s.end - docStart[lo], value.length);
    if (relStart < 0 || relEnd <= relStart) continue;
    for (const leaf of byValue.get(value)!) {
      out.push({ ...s, start: leafStart[leaf] + relStart, end: leafStart[leaf] + relEnd, text: value.slice(relStart, relEnd) });
    }
  }
  return out;
}

/**
 * Leaves the rules already match in full (an email, a phone number, an NHS
 * number) gain nothing from the name model; returns their indexes so
 * runNerOnLeaves can skip them. `text` is the leaves joined by a delimiter of
 * `delimLength` characters.
 */
export function ruleCoveredLeaves(values: string[], delimLength: number, text: string): Set<number> {
  const covered = new Set<number>();
  const starts: number[] = [];
  let offset = 0;
  for (const v of values) {
    starts.push(offset);
    offset += v.length + delimLength;
  }
  for (const sp of runRules(text)) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= sp.start) lo = mid;
      else hi = mid - 1;
    }
    const v = values[lo];
    const valueStart = starts[lo] + (v.length - v.trimStart().length);
    const valueEnd = starts[lo] + v.trimEnd().length;
    if (sp.start <= valueStart && sp.end >= valueEnd) covered.add(lo);
  }
  return covered;
}
