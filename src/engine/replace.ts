import type { Mode } from '@/lib/constants';
import type { IdentifierLabel } from '@/lib/identifiers';
import type { Span } from '@/engine/detect';
import { generatePseudonym, type SessionSecret } from '@/engine/crypto';

export interface ReplacementResult {
  text: string;
  /** Original -> replacement mapping for the audit / re-id key file. */
  mapping: Record<string, string>;
  /** Span-by-span replacement record for diff display. */
  replacements: Array<{
    span: Span;
    original: string;
    replacement: string;
  }>;
  /** Per-record date shift in days (pseudonymise mode only, undefined otherwise). */
  dateShiftDays?: number;
  /** The DMY/MDY interpretation chosen for this document. Exposed for the audit log. */
  dateFormatHint?: DateFormatHint;
  /**
   * Count of verbatim residual replacements made by the consistency sweep —
   * occurrences of an already-replaced original that no detection span
   * covered (e.g. a name caught once via "Dr X" context but repeated bare
   * elsewhere). Always replaced with the same token as the spanned occurrence.
   */
  residualSweeps?: number;
}

interface ReplaceOptions {
  mode: Mode;
  secret?: SessionSecret; // required in pseudonymise mode
  quasiToRedact: Set<string>; // quasi-identifier labels the user opted to redact
}

/**
 * Apply replacement to text given a list of merged spans and options.
 *
 * Pipeline (four passes — each O(N), so total is linear in document length):
 *  1. INFER DATE FORMAT — scan all DATE spans, decide DMY vs MDY for the
 *     document. A single date with day > 12 resolves the ambiguity; we don't
 *     re-derive per-date because a clinical record's dates are nearly always
 *     in one locale.
 *  2. COMPUTE REPLACEMENTS — collect unique (label, original) pairs and run
 *     HMAC pseudonym computation IN PARALLEL via Promise.all. This replaces
 *     the previous serial `await` per span (which was ~10× slower on docs
 *     with many identifiers).
 *  3. ASSEMBLE OUTPUT — walk the original text once forward, pushing
 *     (untouched-prefix | replacement) pairs into a string[] and joining at
 *     the end. O(N) instead of the previous O(N²) slice-and-concat loop.
 */
export async function replaceSpans(
  text: string,
  spans: Span[],
  quasiSpans: Span[],
  options: ReplaceOptions
): Promise<ReplacementResult> {
  const mapping: Record<string, string> = {};
  const replacements: ReplacementResult['replacements'] = [];

  const dateShiftDays =
    options.mode === 'PSEUDONYMISE'
      ? await deriveDateShift(options.secret!)
      : undefined;

  // Combine direct spans with opt-in quasi spans. Sort ASCENDING so we can
  // walk the document once forward in the assembly pass.
  const activeQuasi = quasiSpans.filter((s) =>
    options.quasiToRedact.has(s.label)
  );
  const allSpans = [...spans, ...activeQuasi].sort(
    (a, b) => a.start - b.start || b.end - a.end
  );

  // ── Pass 1: infer DMY vs MDY from the document's own dates ──────────────
  const dateStrings: string[] = [];
  for (const span of allSpans) {
    if (span.label !== 'DATE') continue;
    const s = span.captureStart ?? span.start;
    const e = span.captureEnd ?? span.end;
    dateStrings.push(text.slice(s, e));
  }
  const dateFormatHint = inferDateFormat(dateStrings);

  // ── Pass 2: extract token spans (start, end, original) ──────────────────
  interface TokenSpec {
    start: number;
    end: number;
    original: string;
    span: Span;
  }
  const tokenSpecs: TokenSpec[] = allSpans.map((span) => {
    const start = span.captureStart ?? span.start;
    const end = span.captureEnd ?? span.end;
    return { start, end, original: text.slice(start, end), span };
  });

  // ── Pass 3: parallel replacement computation, deduped per (label, token) ─
  // Same (label, original) → same replacement, so we hash each unique pair
  // exactly once. Anonymise replacements are synchronous and need no Promise
  // round-trip; only pseudonyms (HMAC) get awaited. All pseudonyms run in
  // parallel via Promise.all — previously they were awaited serially, which
  // dominated runtime on documents with many identifiers.
  const cache = new Map<string, string>();
  const seenKeys = new Set<string>();
  const pseudoPending: Array<Promise<{ key: string; replacement: string }>> = [];

  const keyOf = (label: IdentifierLabel, original: string) => `${label}\0${original}`;

  for (const t of tokenSpecs) {
    const key = keyOf(t.span.label, t.original);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (options.mode === 'PSEUDONYMISE') {
      if (!options.secret) {
        throw new Error('Pseudonymise mode requires a session secret.');
      }
      pseudoPending.push(
        pseudonymise(
          t.span.label,
          t.original,
          options.secret,
          dateShiftDays!,
          dateFormatHint
        ).then((replacement) => ({ key, replacement }))
      );
    } else {
      cache.set(key, anonymise(t.span.label, t.original, dateFormatHint));
    }
  }

  // Resolve all pseudonyms in parallel.
  if (pseudoPending.length > 0) {
    const settled = await Promise.all(pseudoPending);
    for (const { key, replacement } of settled) cache.set(key, replacement);
  }

  // ── Pass 4: assemble output linearly (single forward walk) ──────────────
  // Untouched-text segment indexes are tracked so the residual sweep below
  // can never touch an inserted replacement token.
  const segments: string[] = [];
  const untouchedIdx: number[] = [];
  let cursor = 0;
  for (const t of tokenSpecs) {
    if (t.start < cursor) {
      // Overlap — the merge step in detect.ts is supposed to prevent this,
      // but if a residual overlap slips through we keep the earlier
      // replacement and skip this span. Still record it for the audit log.
      const replacement = cache.get(keyOf(t.span.label, t.original))!;
      mapping[t.original] = replacement;
      replacements.push({ span: t.span, original: t.original, replacement });
      continue;
    }
    const replacement = cache.get(keyOf(t.span.label, t.original))!;
    if (t.start > cursor) {
      untouchedIdx.push(segments.length);
      segments.push(text.slice(cursor, t.start));
    }
    segments.push(replacement);
    cursor = t.end;
    mapping[t.original] = replacement;
    replacements.push({ span: t.span, original: t.original, replacement });
  }
  if (cursor < text.length) {
    untouchedIdx.push(segments.length);
    segments.push(text.slice(cursor));
  }

  // ── Pass 5: verbatim residual sweep ──────────────────────────────────────
  // A replaced original that appears AGAIN outside any detection span is a
  // verbatim leak (a name caught once via "Dr X" context but bare elsewhere;
  // an MRN embedded in a document reference). Every remaining word-bounded
  // occurrence is replaced with the same token, longest original first so
  // "Northwell General Hospital" is swept before "Northwell". Same length
  // floor (≥ 4 chars) as the validation stage — by construction validation
  // can no longer find a mapping original in the output.
  const sweepable = Object.entries(mapping)
    .filter(([orig]) => orig.trim().length >= 4)
    .sort((a, b) => b[0].length - a[0].length)
    // Whitespace inside an original is matched flexibly (\s+): PDF text
    // extraction produces variable spacing, so "Karoline Stenberg" must also
    // sweep "Karoline  Stenberg" and "Karoline\nStenberg".
    .map(([orig, repl]) => ({
      repl,
      probe: orig.trim().split(/\s+/)[0],
      re: new RegExp(`(?<!\\w)${flexibleWhitespacePattern(orig)}(?!\\w)`, 'g'),
    }));
  let residualSweeps = 0;
  if (sweepable.length > 0) {
    for (const idx of untouchedIdx) {
      let seg = segments[idx];
      for (const { re, repl, probe } of sweepable) {
        if (!seg.includes(probe)) continue;
        re.lastIndex = 0;
        seg = seg.replace(re, () => {
          residualSweeps++;
          return repl;
        });
      }
      segments[idx] = seg;
    }
  }

  return {
    text: segments.join(''),
    mapping,
    replacements,
    dateShiftDays,
    dateFormatHint,
    residualSweeps,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape an original for regex use, with any internal whitespace run matching \s+. */
export function flexibleWhitespacePattern(original: string): string {
  return original
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
}

/* ----------------------------------------------------------------------------
 * Pseudonymise mode
 * --------------------------------------------------------------------------*/

async function pseudonymise(
  label: IdentifierLabel,
  token: string,
  secret: SessionSecret,
  shiftDays: number,
  dateFormatHint: DateFormatHint
): Promise<string> {
  // Dates: shift deterministically.
  if (label === 'DATE') {
    const shifted = shiftDate(token, shiftDays, dateFormatHint);
    return shifted ?? (await generatePseudonym(secret, label, token));
  }
  // Age over 89: always render as "90+" per HIPAA.
  if (label === 'AGE_OVER_89') {
    return '90+';
  }
  return generatePseudonym(secret, label, token);
}

/**
 * Derive the per-record date shift deterministically from the session secret.
 * Same secret → same shift, so re-runs on the same record produce identical
 * output (useful for verification and reproducible audit trails). Range is
 * [-365, +365] excluding 0.
 */
async function deriveDateShift(secret: SessionSecret): Promise<number> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    secret.hmacKey,
    new TextEncoder().encode('date-shift')
  );
  const view = new DataView(sig);
  const v = (view.getUint32(0) % 730) - 365;
  return v === 0 ? 1 : v;
}

function shiftDate(token: string, shiftDays: number, hint: DateFormatHint): string | null {
  const parsed = parseLooseDate(token, hint);
  if (!parsed) return null;
  const ms = parsed.date.getTime() + shiftDays * 86_400_000;
  const d = new Date(ms);
  return formatLikeInput(d, parsed.format);
}

interface ParsedDate {
  date: Date;
  format: 'ISO' | 'DMY' | 'MDY' | 'MONTH_NAME_DMY' | 'MONTH_NAME_MDY' | 'UNKNOWN';
}

/**
 * One regex covering all four loose-date shapes the catalogue can produce:
 *   - ISO   yyyy-mm-dd            → groups iso_y / iso_m / iso_d
 *   - DMY-or-MDY  d/m/y           → groups num_a / num_b / num_y
 *                                    (disambiguated by `hint`)
 *   - "2 Jan 2024"                → groups bmn_d / bmn_name / bmn_y
 *   - "Jan 2, 2024"               → groups amn_name / amn_d / amn_y
 *
 * Anchored to ^...$ so a single token from the engine's match is matched
 * end-to-end, with no partial-prefix surprises.
 */
const DATE_LOOSE_RE = new RegExp(
  '^(?:' +
    '(?<iso_y>\\d{4})-(?<iso_m>\\d{1,2})-(?<iso_d>\\d{1,2})' +
    '|' +
    '(?<num_a>\\d{1,2})[\\/\\-\\.](?<num_b>\\d{1,2})[\\/\\-\\.](?<num_y>\\d{2,4})' +
    '|' +
    '(?<bmn_d>\\d{1,2})\\s+(?<bmn_name>[A-Za-z]+)\\.?\\s+(?<bmn_y>\\d{2,4})' +
    '|' +
    '(?<amn_name>[A-Za-z]+)\\.?\\s+(?<amn_d>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?<amn_y>\\d{2,4})' +
  ')$'
);

function parseLooseDate(token: string, hint: DateFormatHint = 'DMY'): ParsedDate | null {
  const m = token.match(DATE_LOOSE_RE);
  if (!m || !m.groups) return null;
  const g = m.groups;

  if (g.iso_y) {
    return makeDate(+g.iso_y, +g.iso_m, +g.iso_d, 'ISO');
  }
  if (g.num_a !== undefined) {
    const a = +g.num_a;
    const b = +g.num_b;
    const y = +g.num_y < 100 ? 2000 + +g.num_y : +g.num_y;
    // Disambiguate using the document-wide hint, falling back to DMY (UK/EU
    // bias matching the previous implementation). If the literal slots make
    // one interpretation impossible (e.g. first slot > 12 means it must be
    // a day), trust that signal regardless of hint.
    let useMdy: boolean;
    if (a > 12) useMdy = false;       // first slot is a day → DMY
    else if (b > 12) useMdy = true;   // second slot is a day → MDY
    else useMdy = hint === 'MDY';
    return useMdy
      ? makeDate(y, a, b, 'MDY')
      : makeDate(y, b, a, 'DMY');
  }
  if (g.bmn_d) {
    const mo = monthFromName(g.bmn_name!);
    if (!mo) return null;
    return makeDate(+g.bmn_y!, mo, +g.bmn_d, 'MONTH_NAME_DMY');
  }
  if (g.amn_name) {
    const mo = monthFromName(g.amn_name);
    if (!mo) return null;
    return makeDate(+g.amn_y!, mo, +g.amn_d!, 'MONTH_NAME_MDY');
  }
  return null;
}

function makeDate(y: number, m: number, d: number, format: ParsedDate['format']): ParsedDate | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  return { date, format };
}

function formatLikeInput(d: Date, format: ParsedDate['format']): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  switch (format) {
    case 'ISO':
      return `${y}-${m}-${day}`;
    case 'DMY':
      return `${day}/${m}/${y}`;
    case 'MDY':
      return `${m}/${day}/${y}`;
    case 'MONTH_NAME_DMY':
      return `${day} ${monthName(d.getUTCMonth() + 1)} ${y}`;
    case 'MONTH_NAME_MDY':
      return `${monthName(d.getUTCMonth() + 1)} ${day}, ${y}`;
    default:
      return `${y}-${m}-${day}`;
  }
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function monthName(m: number): string {
  return MONTH_NAMES[m - 1];
}

function monthFromName(name: string): number | null {
  const idx = MONTH_NAMES.findIndex(
    (n) => n.toLowerCase() === name.slice(0, 3).toLowerCase()
  );
  return idx >= 0 ? idx + 1 : null;
}

/* ----------------------------------------------------------------------------
 * Document-wide date format inference
 *
 * Clinical documents use one date format throughout. A US discharge summary
 * is MDY end-to-end; a UK referral letter is DMY end-to-end. We scan all
 * d/m/y-shape dates: any date with first-slot > 12 proves DMY; any with
 * second-slot > 12 proves MDY. Conflicting evidence or no evidence at all
 * falls back to DMY (the UK/EU bias matching the previous default).
 * --------------------------------------------------------------------------*/

export type DateFormatHint = 'DMY' | 'MDY' | 'AMBIGUOUS';

const NUMERIC_DATE_RE = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.]\d{2,4}$/;

export function inferDateFormat(dateStrings: string[]): DateFormatHint {
  let dmyEvidence = 0;
  let mdyEvidence = 0;
  for (const s of dateStrings) {
    const m = s.match(NUMERIC_DATE_RE);
    if (!m) continue;
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) dmyEvidence++;
    if (b > 12 && a <= 12) mdyEvidence++;
  }
  if (dmyEvidence > 0 && mdyEvidence === 0) return 'DMY';
  if (mdyEvidence > 0 && dmyEvidence === 0) return 'MDY';
  return 'AMBIGUOUS';
}

/* ----------------------------------------------------------------------------
 * Anonymise mode
 * --------------------------------------------------------------------------*/

function anonymise(label: IdentifierLabel, token: string, dateFormatHint: DateFormatHint): string {
  switch (label) {
    case 'NAME':
      return '[NAME]';
    case 'DATE': {
      const parsed = parseLooseDate(token, dateFormatHint);
      if (parsed) return String(parsed.date.getUTCFullYear());
      return '[DATE]';
    }
    case 'AGE_OVER_89':
      return '90+';
    case 'POSTCODE_US': {
      // HIPAA: keep first 3 digits unless population for that prefix < 20,000.
      // We conservatively keep first 3 only when length permits.
      const z = token.match(/^(\d{3})/);
      return z ? `${z[1]}**` : '[POSTCODE]';
    }
    case 'POSTCODE_UK': {
      // Keep outward code only (e.g. "SW1A 1AA" -> "SW1A").
      const m = token.match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)/i);
      return m ? `${m[1]} ***` : '[POSTCODE]';
    }
    case 'POSTCODE_EU':
      return '[POSTCODE]';
    case 'NHS_NUMBER':
      return '[NHS-REDACTED]';
    case 'EMAIL':
      return '[EMAIL]';
    case 'PHONE':
    case 'FAX':
      return '[PHONE]';
    case 'URL':
      return '[URL]';
    case 'IP':
      return '[IP]';
    case 'SSN':
    case 'UK_NINO':
    case 'NATIONAL_ID_DK_CPR':
    case 'NATIONAL_ID_NL_BSN':
    case 'NATIONAL_ID_ES':
    case 'NATIONAL_ID_IT_CF':
    case 'NATIONAL_ID_CH_AHV':
    case 'PASSPORT':
    case 'IBAN':
      return '[NATIONAL-ID]';
    case 'MRN':
      return '[MRN]';
    case 'INSURANCE_ID':
      return '[INSURANCE-ID]';
    case 'ACCOUNT_NUMBER':
      return '[ACCOUNT]';
    case 'LICENSE':
      return '[LICENSE]';
    case 'VEHICLE_VIN':
      return '[VIN]';
    case 'DEVICE_ID':
      return '[DEVICE]';
    case 'REFERENCE_ID':
      return '[REF-ID]';
    case 'ADDRESS_LINE':
      return '[ADDRESS]';
    case 'BIOMETRIC':
      return '[BIOMETRIC]';
    case 'INSTITUTION':
      return '[INSTITUTION]';
    case 'OCCUPATION':
      return '[OCCUPATION]';
    case 'ETHNICITY':
      return '[ETHNICITY]';
    case 'RARE_DISEASE_ICD':
      // Generalise to the 3-char block (e.g. "Q90.1" -> "Q90").
      return token.split('.')[0].toUpperCase();
    default:
      return `[${label}]`;
  }
}
