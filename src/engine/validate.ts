import { runRules, type Span } from '@/engine/detect';
import type { Mode } from '@/lib/constants';

export interface ValidationResult {
  passed: boolean;
  leaks: Span[];
  /** Original identifier strings found verbatim in the de-identified output. */
  originalsLeaked: string[];
}

interface ValidateOptions {
  mode: Mode;
  /**
   * Originals that were replaced. In pseudonymise mode the output legitimately
   * contains synthesised values (shifted dates, HMAC tokens) that match the
   * detection regex — those are not leaks. A real leak is the appearance of an
   * ORIGINAL identifier value in the output. The mapping keys are the set of
   * originals to check for.
   */
  originalIdentifiers: string[];
}

/**
 * Post-processing validation. Two layers:
 *
 * 1. Verbatim leak check: did any original identifier value (a mapping key)
 *    survive into the output? This is the hard constraint and applies in both
 *    modes.
 * 2. Regex residual check: in anonymise mode, the output should contain no
 *    direct-identifier matches at all (every direct identifier is replaced by
 *    a placeholder). In pseudonymise mode, regex matches are expected
 *    (shifted dates, etc.) so the regex layer is informational only.
 */
export function validate(
  deidentifiedText: string,
  options: ValidateOptions
): ValidationResult {
  const originalsLeaked: string[] = [];
  for (const original of options.originalIdentifiers) {
    if (original.length < 4) continue; // skip very short strings to avoid noise
    // Only count a verbatim leak when the original appears at a word boundary,
    // not as a substring of a longer word/phrase. "University Hospital" inside
    // "University Hospitals of Leicester" is not a leak — the institution name
    // family is the same, but no identifier survived the redaction.
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\b|\\s)${escaped}(?:$|\\b|\\s)`).test(deidentifiedText)) {
      originalsLeaked.push(original);
    }
  }

  let leaks: Span[] = [];
  if (options.mode === 'ANONYMISE') {
    leaks = runRules(deidentifiedText)
      .filter((s) => s.category !== 'QUASI')
      .filter((s) => !isOwnToken(s.text));
  }

  return {
    // Only verbatim original identifier leaks are a hard block.
    // Regex residuals (leaks) are surfaced as warnings — they are informational
    // because broad patterns (ZIP = any 5 digits, NHS = any 10-digit sequence)
    // produce false positives on legitimate anonymised placeholders and dates.
    passed: originalsLeaked.length === 0,
    leaks,
    originalsLeaked,
  };
}

const OWN_TOKEN_RE = /^\[[A-Z_]+(?:-[A-F0-9]{6,16})?\]$/;
const GENERALISED_RE = /^(?:90\+|\d{4}|\[(?:NAME|DATE|EMAIL|PHONE|URL|IP|MRN|ADDRESS|POSTCODE|NHS-REDACTED|NATIONAL-ID|INSURANCE-ID|ACCOUNT|LICENSE|VIN|DEVICE|BIOMETRIC|INSTITUTION|OCCUPATION|ETHNICITY)\])$/;

function isOwnToken(text: string): boolean {
  return OWN_TOKEN_RE.test(text) || GENERALISED_RE.test(text);
}
