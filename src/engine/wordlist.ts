/**
 * Study word list: terms the user knows identify someone (staff names, ward
 * and site names, study code names) and wants hidden in every file.
 *
 * Kept in this tab's memory only, never in browser storage: the list itself
 * identifies people, and every session starts clean. The user can save it
 * as a text file and load it next time.
 *
 * One term per line. An optional prefix sets the type:
 *   place: Kingsway        org: Harbour Road Surgery        id: STUDY-77
 * Anything else is treated as a name. Lines starting with # are notes.
 */

import type { Span } from '@/engine/detect';
import type { IdentifierLabel } from '@/lib/identifiers';
import { OriginalFinder } from '@/engine/replace';

export interface WordListTerm {
  term: string;
  label: IdentifierLabel;
}

const PREFIX: Record<string, IdentifierLabel> = {
  name: 'NAME',
  person: 'NAME',
  place: 'ADDRESS_LINE',
  address: 'ADDRESS_LINE',
  org: 'INSTITUTION',
  organisation: 'INSTITUTION',
  organization: 'INSTITUTION',
  id: 'REFERENCE_ID',
};

export function parseWordList(text: string): WordListTerm[] {
  const seen = new Set<string>();
  const out: WordListTerm[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-z]+)\s*:\s*(.+)$/i);
    const label = m && PREFIX[m[1].toLowerCase()] ? PREFIX[m[1].toLowerCase()] : 'NAME';
    const term = (m && PREFIX[m[1].toLowerCase()] ? m[2] : line).trim();
    if (term.length < 2 || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push({ term, label });
  }
  return out;
}

/**
 * Every occurrence of every term, ignoring case, at word boundaries.
 * Forced spans (confidence 1). Organisations are marked as identifiers
 * here, not quasi-identifiers: the user asked for them to go.
 */
export function wordListSpans(text: string, terms: WordListTerm[]): Span[] {
  if (terms.length === 0 || !text) return [];
  const lower = text.toLowerCase();
  const labelOf = new Map(terms.map((t) => [t.term.toLowerCase(), t.label]));
  let hits: Array<{ start: number; end: number; original: string }>;
  if (lower.length === text.length) {
    hits = new OriginalFinder(Array.from(labelOf.keys()), 'sweep').findAll(lower);
  } else {
    // Rare: lower-casing changed the length (e.g. "İ"); search term by term.
    hits = [];
    for (const key of Array.from(labelOf.keys())) {
      const re = new RegExp(`(?<!\\w)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?!\\w)`, 'giu');
      for (const m of text.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, original: key });
    }
  }
  return hits.map((h) => ({
    start: h.start,
    end: h.end,
    text: text.slice(h.start, h.end),
    label: labelOf.get(h.original)!,
    category: 'HIPAA',
    source: 'rule',
    confidence: 1,
  }));
}

// ─── In-memory store (this tab only) ─────────────────────────────────────
let current = '';
const listeners = new Set<(text: string) => void>();

export function getWordListText(): string {
  return current;
}

export function setWordListText(text: string): void {
  current = text;
  for (const fn of listeners) fn(text);
}

export function subscribeWordList(fn: (text: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentWordList(): WordListTerm[] {
  return parseWordList(current);
}
