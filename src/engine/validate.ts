import { runRules, type Span } from '@/engine/detect';
import { flexibleWhitespacePattern } from '@/engine/replace';
import type { Mode } from '@/lib/constants';

export interface ValidationResult {
  passed: boolean;
  leaks: Span[];
  /** Original identifier strings found verbatim in the de-identified output. */
  originalsLeaked: string[];
  /**
   * Entities detected by the NER second-pass on the de-identified output.
   * These are warnings (not hard blocks) — they indicate names/locations that
   * may have survived because no regex rule matched them.
   */
  nerLeaks: Span[];
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
  /**
   * Optional async NER runner. When provided, `validate` runs the NER model on
   * the de-identified output as a second pass and reports surviving NAME / LOC
   * entities that regex alone would have missed. This closes the gap where a
   * person's name survives because it didn't match any regex rule.
   */
  nerRunner?: (text: string) => Promise<Span[]>;
}

/**
 * Post-processing validation. Three layers:
 *
 * 1. Verbatim leak check: did any original identifier value (a mapping key)
 *    survive into the output? This is the hard constraint and applies in both
 *    modes.
 * 2. Regex residual check: in anonymise mode, the output should contain no
 *    direct-identifier matches at all (every direct identifier is replaced by
 *    a placeholder). In pseudonymise mode, regex matches are expected
 *    (shifted dates, etc.) so the regex layer is informational only.
 * 3. NER second-pass (when nerRunner provided): runs the NER model on the
 *    de-identified output and surfaces surviving PER/LOC entities. These are
 *    surfaced as warnings, not hard blocks, because the NER model can produce
 *    false positives on common words.
 */
export async function validate(
  deidentifiedText: string,
  options: ValidateOptions
): Promise<ValidationResult> {
  const originalsLeaked: string[] = [];
  for (const original of options.originalIdentifiers) {
    if (original.length < 4) continue; // skip very short strings to avoid noise
    // Only count a verbatim leak when the original appears at a word boundary,
    // not as a substring of a longer word/phrase. "University Hospital" inside
    // "University Hospitals of Leicester" is not a leak — the institution name
    // family is the same, but no identifier survived the redaction.
    // Internal whitespace matches flexibly (\s+) so extraction-spacing
    // variants ("Karoline  Stenberg") are caught too — mirrors the residual
    // sweep in replace.ts, which removes exactly this set.
    const pattern = flexibleWhitespacePattern(original);
    if (new RegExp(`(?:^|\\b|\\s)${pattern}(?:$|\\b|\\s)`).test(deidentifiedText)) {
      originalsLeaked.push(original);
    }
  }

  let leaks: Span[] = [];
  if (options.mode === 'ANONYMISE') {
    leaks = runRules(deidentifiedText)
      .filter((s) => s.category !== 'QUASI')
      .filter((s) => !isOwnToken(s.text));
  }

  // NER second-pass: run the model on the de-identified output to catch names
  // that survived because they didn't match any regex rule.
  let nerLeaks: Span[] = [];
  if (options.nerRunner) {
    try {
      // Ranges of our own replacement tokens in the output. The NER model
      // tokenises "[ADDRESS_LINE-FAC59712]" into fragments ("[ADDRESS") that
      // dodge the exact-match isOwnToken check, so any span overlapping a
      // token range positionally is discarded — it can only be the token.
      const tokenRanges: Array<[number, number]> = [];
      const tokenRe = /\[[A-Z_]+(?:-[A-F0-9]{6,16})?\]/g;
      let tm: RegExpExecArray | null;
      while ((tm = tokenRe.exec(deidentifiedText))) {
        tokenRanges.push([tm.index, tm.index + tm[0].length]);
      }
      const overlapsToken = (s: Span) =>
        tokenRanges.some(([a, b]) => s.start < b && s.end > a);

      const nerSpans = await options.nerRunner(deidentifiedText);
      nerLeaks = nerSpans.filter(
        (s) =>
          (s.label === 'NAME' || s.label === 'ADDRESS_LINE') &&
          !isOwnToken(s.text) &&
          !overlapsToken(s) &&
          s.text.trim().length >= 3
      );
    } catch {
      // NER second-pass failure is non-fatal — degrade gracefully.
      nerLeaks = [];
    }
  }

  return {
    // Only verbatim original identifier leaks are a hard block.
    // Regex residuals (leaks) are surfaced as warnings — they are informational
    // because broad patterns (ZIP = any 5 digits, NHS = any 10-digit sequence)
    // produce false positives on legitimate anonymised placeholders and dates.
    passed: originalsLeaked.length === 0,
    leaks,
    originalsLeaked,
    nerLeaks,
  };
}

const OWN_TOKEN_RE = /^\[[A-Z_]+(?:-[A-F0-9]{6,16})?\]$/;
const GENERALISED_RE = /^(?:90\+|\d{4}|\[(?:NAME|DATE|EMAIL|PHONE|URL|IP|MRN|ADDRESS|POSTCODE|NHS-REDACTED|NATIONAL-ID|INSURANCE-ID|ACCOUNT|LICENSE|VIN|DEVICE|BIOMETRIC|INSTITUTION|OCCUPATION|ETHNICITY|REF-ID)\])$/;

function isOwnToken(text: string): boolean {
  return OWN_TOKEN_RE.test(text) || GENERALISED_RE.test(text);
}
