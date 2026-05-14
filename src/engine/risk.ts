import { K_ANONYMITY_THRESHOLD, type RiskLevel } from '@/lib/constants';
import type { Span } from '@/engine/detect';

export interface RiskAssessment {
  level: RiskLevel;
  kAnonymity: number;
  lDiversity?: number;
  reasons: string[];
  /** Identifier-type breakdown for display. */
  breakdown: Array<{
    label: string;
    count: number;
    action: string;
  }>;
}

interface RiskInput {
  /** Identifier spans found in the input (pre-replacement). */
  detectedSpans: Span[];
  /** Quasi-identifier spans the user chose NOT to redact. */
  retainedQuasiSpans: Span[];
  /** Number of records being processed in this batch (single-record default). */
  recordCount: number;
}

/**
 * Compute a conservative single-record k-anonymity estimate based on the
 * quasi-identifiers that remain in the output. With a single record we cannot
 * empirically compute k, so we infer risk from the *combination* of retained
 * quasi-identifiers:
 *
 *  - 0 retained -> k effectively unbounded (call it K_THRESHOLD + 5)
 *  - 1 retained -> k ~ K_THRESHOLD (acceptable for low-uniqueness fields)
 *  - 2 retained -> k = 3 (medium risk)
 *  - 3+ retained -> k = 1 (likely unique combination)
 *
 * This is the same logic Presidio's risk module uses for single-document mode.
 * When the user processes a CSV-style batch (v2), we'll switch to empirical k.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  const retainedLabels = new Set(input.retainedQuasiSpans.map((s) => s.label));
  const retainedCount = retainedLabels.size;

  let k: number;
  if (retainedCount === 0) k = K_ANONYMITY_THRESHOLD + 5;
  else if (retainedCount === 1) k = K_ANONYMITY_THRESHOLD;
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

  const level: RiskLevel =
    k >= K_ANONYMITY_THRESHOLD ? 'LOW' : k >= 3 ? 'MEDIUM' : 'HIGH';

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

  return { level, kAnonymity: k, reasons, breakdown };
}
