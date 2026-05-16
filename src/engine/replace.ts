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
}

interface ReplaceOptions {
  mode: Mode;
  secret?: SessionSecret; // required in pseudonymise mode
  quasiToRedact: Set<string>; // quasi-identifier labels the user opted to redact
}

/**
 * Apply replacement to text given a list of merged spans and options.
 *
 * Strategy:
 *  - Iterate spans by descending start index so offsets remain valid.
 *  - For pseudonymise: deterministic HMAC token per (label, originalToken).
 *  - For anonymise: per-label generalisation. Dates -> YEAR or [REDACTED];
 *    geographics -> first 3 digits (US) / outward code (UK); names removed.
 *  - Quasi-identifiers are only redacted if the user opted in.
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

  // Combine direct spans with opt-in quasi spans.
  const activeQuasi = quasiSpans.filter((s) =>
    options.quasiToRedact.has(s.label)
  );
  const allSpans = [...spans, ...activeQuasi].sort((a, b) => b.start - a.start);

  let out = text;
  for (const span of allSpans) {
    const start = span.captureStart ?? span.start;
    const end = span.captureEnd ?? span.end;
    const original = text.slice(start, end);

    let replacement: string;
    if (options.mode === 'PSEUDONYMISE') {
      if (!options.secret) {
        throw new Error('Pseudonymise mode requires a session secret.');
      }
      replacement = await pseudonymise(
        span.label,
        original,
        options.secret,
        dateShiftDays!
      );
    } else {
      replacement = anonymise(span.label, original);
    }

    mapping[original] = replacement;
    replacements.push({ span, original, replacement });
    out = out.slice(0, start) + replacement + out.slice(end);
  }

  return { text: out, mapping, replacements, dateShiftDays };
}

/* ----------------------------------------------------------------------------
 * Pseudonymise mode
 * --------------------------------------------------------------------------*/

async function pseudonymise(
  label: IdentifierLabel,
  token: string,
  secret: SessionSecret,
  shiftDays: number
): Promise<string> {
  // Dates: shift deterministically.
  if (label === 'DATE') {
    const shifted = shiftDate(token, shiftDays);
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

function shiftDate(token: string, shiftDays: number): string | null {
  const parsed = parseLooseDate(token);
  if (!parsed) return null;
  const ms = parsed.date.getTime() + shiftDays * 86_400_000;
  const d = new Date(ms);
  // Render in the same shape as the input where possible.
  return formatLikeInput(d, parsed.format);
}

interface ParsedDate {
  date: Date;
  format: 'ISO' | 'DMY' | 'MDY' | 'MONTH_NAME' | 'UNKNOWN';
}

function parseLooseDate(token: string): ParsedDate | null {
  // ISO yyyy-mm-dd
  let m = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return makeDate(+m[1], +m[2], +m[3], 'ISO');

  // mm/dd/yyyy or dd/mm/yyyy — assume DMY for EU/UK feel of the tool.
  m = token.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return makeDate(y, +m[2], +m[1], 'DMY');
  }

  // 2 Jan 2024
  m = token.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{2,4})$/);
  if (m) {
    const mo = monthFromName(m[2]);
    if (mo) return makeDate(+m[3], mo, +m[1], 'MONTH_NAME');
  }

  // Jan 2, 2024
  m = token.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/);
  if (m) {
    const mo = monthFromName(m[1]);
    if (mo) return makeDate(+m[3], mo, +m[2], 'MONTH_NAME');
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
    case 'MONTH_NAME':
      return `${day} ${monthName(d.getUTCMonth() + 1)} ${y}`;
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
 * Anonymise mode
 * --------------------------------------------------------------------------*/

function anonymise(label: IdentifierLabel, token: string): string {
  switch (label) {
    case 'NAME':
      return '[NAME]';
    case 'DATE': {
      const parsed = parseLooseDate(token);
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
