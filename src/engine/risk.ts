import { K_ANONYMITY_THRESHOLD, type RiskLevel } from '@/lib/constants';
import type { Span } from '@/engine/detect';

export interface RiskAssessment {
  level: RiskLevel;
  kAnonymity: number;
  /**
   * l-diversity: number of distinct sensitive attribute label types retained in
   * the output. If 0 quasi-identifiers are retained, l = Infinity. A value of
   * l < 2 means an attacker who knows the quasi-identifier combination can infer
   * the sensitive attribute (e.g. diagnosis) with certainty.
   *
   * For single-record mode this is necessarily estimated from the label count.
   */
  lDiversity: number;
  reasons: string[];
  /** Identifier-type breakdown for display. */
  breakdown: Array<{
    label: string;
    count: number;
    action: string;
  }>;
}

// Sensitive attribute labels — these carry inherent health information that
// should not be disclosed even if the quasi-identifier combination is retained.
const SENSITIVE_LABELS = new Set<string>([
  'RARE_DISEASE_ICD',
  'ETHNICITY',
  // Future: add DIAGNOSIS, MEDICATION, LAB_VALUE when biomedical NER ships
]);

interface RiskInput {
  /** Identifier spans found in the input (pre-replacement). */
  detectedSpans: Span[];
  /** Quasi-identifier spans the user chose NOT to redact. */
  retainedQuasiSpans: Span[];
  /** Number of records being processed in this batch (single-record default). */
  recordCount: number;
  /**
   * Optional k-threshold override from compliance profile.
   * When absent, falls back to K_ANONYMITY_THRESHOLD from constants.
   */
  kThreshold?: number;
}

/**
 * Compute a conservative single-record k-anonymity estimate based on the
 * quasi-identifiers that remain in the output. With a single record we cannot
 * empirically compute k, so we infer risk from the *combination* of retained
 * quasi-identifiers:
 *
 *  - 0 retained → k effectively unbounded (call it K_THRESHOLD + 5)
 *  - 1 retained → k ~ K_THRESHOLD (acceptable for low-uniqueness fields)
 *  - 2 retained → k = 3 (medium risk)
 *  - 3+ retained → k = 1 (likely unique combination)
 *
 * Also computes l-diversity: the number of distinct sensitive attribute label
 * types that survive in the retained quasi-identifier set.
 *
 * This is the same logic Presidio's risk module uses for single-document mode.
 * When the user processes a CSV-style batch (v2), we'll switch to empirical k.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const kThreshold = input.kThreshold ?? K_ANONYMITY_THRESHOLD;
  const reasons: string[] = [];
  const retainedLabels = new Set(input.retainedQuasiSpans.map((s) => s.label));
  const retainedCount = retainedLabels.size;

  let k: number;
  if (retainedCount === 0) k = kThreshold + 5;
  else if (retainedCount === 1) k = kThreshold;
  else if (retainedCount === 2) k = 3;
  else k = 1;

  if (retainedCount >= 2) {
    reasons.push(
      `${retainedCount} quasi-identifier types retained — their combination may be unique.`
    );
  }
  if (retainedLabels.has('RARE_DISEASE_ICD')) {
    reasons.push('Rare-disease ICD code retained — high re-identification risk.');
    k = Math.min(k, 2);
  }
  if (retainedLabels.has('INSTITUTION') && retainedLabels.has('OCCUPATION')) {
    reasons.push('Institution + occupation combination retained — likely unique.');
    k = Math.min(k, 2);
  }

  // ── l-diversity ──────────────────────────────────────────────────────────
  // Count distinct sensitive attribute types still present in the retained set.
  // A low l value means the quasi-identifiers already narrow the sensitive
  // attribute to near-certainty.
  const retainedSensitive = new Set<string>(
    input.retainedQuasiSpans
      .filter((s) => SENSITIVE_LABELS.has(s.label))
      .map((s) => s.label)
  );
  // Also check detected (pre-replacement) spans that weren't suppressed.
  const detectedSensitive = new Set<string>(
    input.detectedSpans
      .filter((s) => SENSITIVE_LABELS.has(s.label) && !retainedLabels.has(s.label))
      .map((s) => s.label)
  );
  const lValue = retainedCount === 0
    ? Infinity
    : retainedSensitive.size + detectedSensitive.size;

  if (isFinite(lValue) && lValue < 2) {
    reasons.push(
      `l-diversity = ${lValue} — sensitive attribute type is nearly deterministic from quasi-identifiers.`
    );
    // Downgrade k slightly when l < 2.
    k = Math.min(k, 2);
  }

  const level: RiskLevel =
    k >= kThreshold ? 'LOW' : k >= 3 ? 'MEDIUM' : 'HIGH';

  if (level === 'LOW' && reasons.length === 0) {
    reasons.push('All quasi-identifiers suppressed or generalised.');
  }

  // Breakdown for display
  const counts: Record<string, number> = {};
  for (const s of input.detectedSpans) {
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }
  for (const s of input.retainedQuasiSpans) {
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts).map(([label, count]) => ({
    label,
    count,
    action: retainedLabels.has(label as Span['label']) ? 'kept (quasi)' : 'redacted',
  }));

  return {
    level,
    kAnonymity: k,
    lDiversity: isFinite(lValue) ? lValue : 99,
    reasons,
    breakdown,
  };
}
