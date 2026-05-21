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
 *
 * Implementation note
 * -------------------
 * We deliberately keep the per-rule matchAll loop (rather than a combined
 * alternation regex) because it lets every rule fire INDEPENDENTLY. mergeSpans
 * then resolves overlaps by priority. A single alternation regex would advance
 * past a low-priority broad match (e.g. POSTCODE_EU swallowing "CP… ") and
 * never give a higher-priority narrow rule starting inside that span the
 * chance to fire — a correctness regression caught by the synthetic Denmark
 * CPR test. The per-rule loop remains the right shape; what was expensive
 * about the original (the IDENTIFIER_RULES.find call inside the merge inner
 * loop) is fixed below by PRIORITY_BY_LABEL.
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
      // AGE_OVER_89_PATTERN has two mutually exclusive capture groups:
      //   group 1: "age: 95"  → digit string in m[1]
      //   group 2: "95 years old" → digit string in m[2]
      if (rule.label === 'AGE_OVER_89') {
        const ageStr = m[1] ?? m[2] ?? m[0].match(/\d+/)?.[0] ?? '0';
        const num = parseInt(ageStr, 10);
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
 * Merge overlapping spans into a union bounding box.
 *
 * When two spans overlap, we keep the span whose label has the higher priority
 * (or the longer span / NER preference on tie) BUT we expand its start/end to
 * cover the union of both spans.  This is critical: the old "pick winner and
 * discard loser" approach dropped the non-overlapping prefix of the lower-
 * priority span, leaving that text unredacted (PII leak).
 *
 * Example:
 *   Span A: start=0, end=10, priority=70 (PHONE)
 *   Span B: start=8, end=15, priority=88 (MRN)
 *   Old result → [8..15] — characters 0-7 leaked!
 *   New result → [0..15] with MRN label.
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
    // Overlap — pick the winning label/source but span the full union.
    // captureStart/captureEnd are cleared so the replacement engine always uses
    // start/end (the full union) rather than a sub-range of the winner span.
    const winner = pickWinner(last, s);
    merged[merged.length - 1] = {
      ...winner,
      start: Math.min(last.start, s.start),
      end:   Math.max(last.end,   s.end),
      captureStart: undefined,
      captureEnd: undefined,
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

/**
 * Precomputed label→priority map. The previous implementation called
 * IDENTIFIER_RULES.find(...) inside mergeSpans's inner loop, making span merge
 * O(spans × rules). With ~30 rules and hundreds of spans on a long document
 * that adds up. Computed once at module load.
 *
 * Note: a label can appear on multiple rules (e.g. IP has IPv4 and IPv6 at the
 * same priority, NAME has 4 context-anchored patterns at different priorities).
 * Keep the FIRST (highest) priority seen — matches the old .find() behaviour
 * because IDENTIFIER_RULES is ordered priority-descending per-label cluster.
 */
const PRIORITY_BY_LABEL: Map<IdentifierLabel, number> = (() => {
  const m = new Map<IdentifierLabel, number>();
  for (const r of IDENTIFIER_RULES) {
    if (!m.has(r.label)) m.set(r.label, r.priority);
  }
  return m;
})();

function priorityOf(span: Span): number {
  return PRIORITY_BY_LABEL.get(span.label) ?? 50;
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
