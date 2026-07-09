import {
  IDENTIFIER_RULES,
  type IdentifierLabel,
  type IdentifierCategory,
  rareIcdTier,
  type RareIcdTier,
  isValidNhsNumber,
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
  /**
   * Overrides the label-derived priority in overlap resolution. Used for
   * downgraded spans (e.g. an NHS-shaped number that fails its checksum is
   * kept as REFERENCE_ID but must lose to an overlapping PHONE match).
   */
  priorityOverride?: number;
}

export interface DetectionResult {
  spans: Span[];
  /** Counts grouped by label, after dedupe. */
  counts: Record<string, number>;
  /** Quasi-identifier spans that need user confirmation before redaction. */
  quasiSpans: Span[];
  /**
   * NER-detected spans with confidence between 0.5 and 0.85 that are not yet
   * committed to the active span list. The user reviews these per-span before
   * the replace pass runs.
   */
  uncertainSpans: Span[];
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
      let captureStart =
        capture && captureIdx >= 0 ? m.index + captureIdx : undefined;
      let captureEnd =
        capture && captureIdx >= 0 ? captureStart! + capture.length : undefined;
      let spanEnd = m.index + m[0].length;

      // Special filter: NAME captures — case-insensitive rules ('gi') lose
      // the capitalisation guard baked into the pattern, so "specialist nurse
      // home visit" captures "home visit" as a name. Trim the capture to the
      // leading run of plausible name words; drop the span if none remain.
      // Case-sensitive NAME rules keep their guard and are left alone (the
      // FHIR JSON rule's capture legitimately starts with a quote character).
      if (
        rule.label === 'NAME' &&
        rule.pattern.flags.includes('i') &&
        capture &&
        captureStart !== undefined
      ) {
        const keptLen = trimNameCapture(capture);
        if (keptLen === null) continue;
        if (keptLen < capture.length) {
          const newCaptureEnd = captureStart + keptLen;
          // The capture sits at the tail of these matches — shrink the span
          // with it so trailing non-name words are not redacted.
          if (captureEnd === spanEnd) spanEnd = newCaptureEnd;
          captureEnd = newCaptureEnd;
        }
      }

      // Special filter: NHS number — the 3-3-4 digit shape also matches phone
      // numbers; only label it NHS_NUMBER when the mod-11 checksum holds.
      // Checksum failures are still redacted (leak beats mislabel) but as
      // REFERENCE_ID with a priority below PHONE, so a phone number that
      // happens to have the NHS shape resolves to its correct PHONE label
      // while a bare 10-digit code the phone rule can't see stays covered.
      let label = rule.label;
      let category = rule.category;
      let priorityOverride: number | undefined;
      if (rule.label === 'NHS_NUMBER' && !isValidNhsNumber(m[0])) {
        label = 'REFERENCE_ID';
        category = 'HIPAA';
        priorityOverride = 65; // below PHONE (70)
      }

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
        end: spanEnd,
        text: text.slice(m.index, spanEnd),
        label,
        category,
        source: 'rule',
        confidence: 1,
        captureStart,
        captureEnd,
        rareTier,
        priorityOverride,
      });
    }
  }
  return spans;
}

// Lowercase words that may legitimately lead into a capitalised name word
// ("al-Hashimi", "van der Berg", "della Rovere").
const NAME_PARTICLES = new Set([
  'al', 'el', 'bin', 'binti', 'van', 'von', 'der', 'den', 'de', 'del',
  'della', 'di', 'da', 'ter', 'ten', 'la', 'le',
]);

/**
 * Length (in characters of the original capture) of the leading run of
 * plausible name words, or null when the capture contains none. A word
 * qualifies when it starts with a capital, or is a lowercase particle
 * (possibly hyphenated into a capitalised remainder, e.g. "al-Hashimi").
 * Trailing bare particles are dropped; at least one capitalised word must
 * survive.
 */
export function trimNameCapture(capture: string): number | null {
  const wordRe = /\S+/g;
  const words: Array<{ text: string; end: number }> = [];
  let wm: RegExpExecArray | null;
  while ((wm = wordRe.exec(capture))) {
    words.push({ text: wm[0], end: wm.index + wm[0].length });
  }

  let kept = 0;
  for (const w of words) {
    if (/^\p{Lu}/u.test(w.text)) {
      kept++;
      continue;
    }
    const base = w.text.split(/[-']/, 1)[0].toLowerCase();
    if (NAME_PARTICLES.has(base)) {
      kept++;
      continue;
    }
    break;
  }
  // Strip trailing words with no capital letter (bare particles).
  while (kept > 0 && !/\p{Lu}/u.test(words[kept - 1].text)) kept--;
  if (kept === 0) return null;
  return words[kept - 1].end;
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
  return span.priorityOverride ?? PRIORITY_BY_LABEL.get(span.label) ?? 50;
}

/**
 * Full detection pass for a text string. Combines rule output (and NER output
 * if provided), reconciles overlaps, and separates direct from quasi spans.
 *
 * NER confidence bucketing:
 *  ≥ 0.85 → auto-accepted (merged with rule spans)
 *  0.5 – 0.84 → uncertain (returned separately for per-span user review)
 *  < 0.5 → silently dropped (too noisy)
 */
export function detect(text: string, nerSpans: Span[] = []): DetectionResult {
  const NER_CONFIDENT_THRESHOLD = 0.85;
  const NER_UNCERTAIN_THRESHOLD = 0.5;

  // Split NER spans by confidence tier.
  const confidentNer = nerSpans.filter(
    (s) => (s.confidence ?? 1) >= NER_CONFIDENT_THRESHOLD
  );
  const uncertainNer = nerSpans.filter(
    (s) =>
      (s.confidence ?? 1) >= NER_UNCERTAIN_THRESHOLD &&
      (s.confidence ?? 1) < NER_CONFIDENT_THRESHOLD
  );

  const ruleSpans = runRules(text);
  const all = [...ruleSpans, ...confidentNer];
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
    uncertainSpans: uncertainNer,
  };
}
