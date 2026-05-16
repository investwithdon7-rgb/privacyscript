import {
  IDENTIFIER_RULES,
  type IdentifierLabel,
  type IdentifierCategory,
  rareIcdTier,
  type RareIcdTier,
} from '@/lib/identifiers';

export interface Span {
  start: number;
  end: number;
  text: string;
  label: IdentifierLabel;
  category: IdentifierCategory;
  source: 'rule' | 'ner';
  confidence?: number; // 0..1 for NER; rules default to 1.
  /** Optional captured group offset (for patterns where the identifier is a sub-capture). */
  captureStart?: number;
  captureEnd?: number;
  /** Set on RARE_DISEASE_ICD spans to carry the Orphanet prevalence tier. */
  rareTier?: RareIcdTier;
}

export interface DetectionResult {
  spans: Span[];
  /** Counts grouped by label, after dedupe. */
  counts: Record<string, number>;
  /** Quasi-identifier spans that need user confirmation before redaction. */
  quasiSpans: Span[];
}

/**
 * Run all regex rules over the text and return raw spans.
 * The engine handles overlap reconciliation downstream.
 */
export function runRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of IDENTIFIER_RULES) {
    // Reset lastIndex so the same rule can be reused safely.
    rule.pattern.lastIndex = 0;
    const matches = text.matchAll(rule.pattern);
    for (const m of matches) {
      if (m.index === undefined) continue;

      // If the rule captures a sub-group, prefer the capture as the redaction
      // target (e.g. "MRN: 12345" -> redact only "12345"). Some patterns
      // alternate between capture groups (e.g. AGE_OVER_89 has both
      // "age: X" and "X years old" forms) — pick the first non-undefined.
      const capture = m.slice(1).find((g) => g !== undefined);
      // captureIdx: find the capture within the full match string. If the same
      // substring appears twice in m[0] this picks the first occurrence, which
      // is correct for all current patterns (captures always appear at the end:
      // "MRN: 12345" → 12345, "age 99 years" → 99). lastIndexOf is used as a
      // tiebreaker-safe fallback for patterns where the capture trails the match.
      const captureIdx = capture
        ? (m[0].lastIndexOf(capture) >= 0 ? m[0].lastIndexOf(capture) : m[0].indexOf(capture))
        : -1;
      const captureStart =
        capture && captureIdx >= 0 ? m.index + captureIdx : undefined;
      const captureEnd =
        capture && captureIdx >= 0 ? captureStart! + capture.length : undefined;

      // Special filter: ICD-10 — only flag if it's a rare-disease code.
      let rareTier: RareIcdTier | undefined;
      if (rule.label === 'RARE_DISEASE_ICD') {
        rareTier = rareIcdTier(m[0]) ?? undefined;
        if (!rareTier) continue;
      }

      // Special filter: AGE_OVER_89 — only flag if the number is >= 90.
      if (rule.label === 'AGE_OVER_89') {
        const num = parseInt(capture ?? m[0].match(/\d+/)?.[0] ?? '0', 10);
        if (num < 90 || num > 130) continue;
      }

      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        label: rule.label,
        category: rule.category,
        source: 'rule',
        confidence: 1,
        captureStart,
        captureEnd,
        rareTier,
      });
    }
  }
  return spans;
}

/**
 * Merge overlapping spans. Strategy:
 *  - Group spans by overlap.
 *  - Within an overlap group, pick the highest-priority rule. If tied, prefer
 *    the longest span. If still tied, prefer NER over rule.
 */
export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];

  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (!last || s.start >= last.end) {
      merged.push(s);
      continue;
    }
    // Overlap — pick the higher-priority span as the label/source winner but
    // expand the redaction region to the UNION of both spans so no PII falls
    // in the gap between them (e.g. "John Smith" where "John" and "Smith" are
    // detected by different rules with slightly different boundaries).
    const winner = pickWinner(last, s);
    merged[merged.length - 1] = {
      ...winner,
      start: Math.min(last.start, s.start),
      end:   Math.max(last.end,   s.end),
      text:  winner.text, // keep winner's label text; full span text is recomputed from source
    };
  }
  return merged;
}

function pickWinner(a: Span, b: Span): Span {
  const pa = priorityOf(a);
  const pb = priorityOf(b);
  if (pa !== pb) return pa > pb ? a : b;
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return la > lb ? a : b;
  // Tie — prefer NER (it has semantic context).
  return a.source === 'ner' ? a : b;
}

function priorityOf(span: Span): number {
  const rule = IDENTIFIER_RULES.find((r) => r.label === span.label);
  return rule?.priority ?? 50;
}

/**
 * Full detection pass for a text string. Combines rule output (and NER output
 * if provided), reconciles overlaps, and separates direct from quasi spans.
 */
export function detect(text: string, nerSpans: Span[] = []): DetectionResult {
  const ruleSpans = runRules(text);
  const all = [...ruleSpans, ...nerSpans];
  const merged = mergeSpans(all);

  const direct = merged.filter((s) => s.category !== 'QUASI');
  const quasi = merged.filter((s) => s.category === 'QUASI');

  const counts: Record<string, number> = {};
  for (const s of merged) {
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }

  return {
    spans: direct,
    counts,
    quasiSpans: quasi,
  };
}
