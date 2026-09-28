/**
 * Survey / tabular dataset engine.
 *
 * Clinical-record de-identification works span by span. A survey export is a
 * different problem: every row is a person, and the re-identification risk
 * lives in the COMBINATION of column values across rows (the one 87-year-old
 * woman in LS6). This module adds the column-level layer on top of the span
 * engine:
 *
 *  1. PROFILE   — recognise the export platform (Qualtrics, REDCap,
 *                 SurveyMonkey, Microsoft Forms) and suggest a role for every
 *                 column from its header and a sample of its values.
 *  2. GENERALISE — per-column transforms for quasi-identifiers (age bands,
 *                 month/year, postcode district/area, rare-category grouping).
 *  3. MEASURE   — empirical k-anonymity and l-diversity across all rows.
 *  4. AUTO-FIX  — greedy escalation of generalisation, then local suppression
 *                 of the few rows that remain unique.
 *  5. APPLY     — combine column decisions with the span engine's output.
 *
 * The span engine still scans every cell as a safety net; column decisions
 * only ever make the output MORE protective, never less, except that QUASI
 * columns are rebuilt from the original value through their generaliser.
 */

import { generatePseudonym, type SessionSecret } from '@/engine/crypto';
import type { Mode } from '@/lib/constants';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ColumnRole = 'DIRECT' | 'QUASI' | 'SENSITIVE' | 'FREE_TEXT' | 'KEEP';
export type QuasiKind = 'age' | 'date' | 'postcode' | 'category';
export type Generaliser =
  | 'none'
  | 'shift'
  | 'age_5'
  | 'age_10'
  | 'age_20'
  | 'year_month'
  | 'year'
  | 'postcode_district'
  | 'postcode_area'
  | 'rare_to_other'
  | 'suppress';

export interface ColumnPlan {
  column: string;
  role: ColumnRole;
  /** Only meaningful for QUASI columns. */
  kind: QuasiKind;
  generaliser: Generaliser;
  /** Plain-language reason the suggestion was made. */
  reason: string;
  /** Question text, when the export carries it (Qualtrics). */
  question?: string;
}

export type SurveyPlatformId = 'QUALTRICS' | 'REDCAP' | 'SURVEYMONKEY' | 'MS_FORMS' | 'GENERIC';

export interface SurveyPlatform {
  id: SurveyPlatformId;
  label: string;
  /** Header rows below the column-name row (question text, import IDs). */
  metaRowCount: number;
}

export interface TabularState {
  platform: SurveyPlatform;
  plans: ColumnPlan[];
  /** Data-row indices (excluding meta rows) whose quasi values are hidden. */
  suppressedRows: number[];
  /** Human-readable log of what "Fix automatically" changed. */
  fixNotes: string[];
  confirmed: boolean;
}

export interface RiskGroup {
  /** Generalised quasi values that define the group, e.g. "30-34 · Female". */
  description: string;
  size: number;
}

export interface TabularRisk {
  /** Smallest group size across the retained quasi-identifier combination. */
  k: number;
  /** Number of responses in groups smaller than the threshold. */
  rowsAtRisk: number;
  rowIndicesAtRisk: number[];
  /** Min distinct sensitive values in any group (null = no sensitive columns). */
  l: number | null;
  /** Display names of the quasi columns (see displayName). */
  quasiColumns: string[];
  totalRows: number;
  /** Number of distinct quasi-value combinations (fewer = more blending in). */
  groupCount: number;
  /** A few of the smallest groups, for display. */
  riskiestGroups: RiskGroup[];
}

// ─── Labels (plain language — shown in the UI) ─────────────────────────────

export const ROLE_LABELS: Record<ColumnRole, string> = {
  DIRECT: 'Identifies a person',
  QUASI: 'Could identify in combination',
  SENSITIVE: 'Sensitive answer',
  FREE_TEXT: 'Written answer',
  KEEP: 'Safe answer',
};

export const GENERALISER_LABELS: Record<Generaliser, string> = {
  none: 'Keep exact values',
  shift: 'Shift dates (keeps intervals)',
  age_5: '5-year bands',
  age_10: '10-year bands',
  age_20: '20-year bands',
  year_month: 'Month and year',
  year: 'Year only',
  postcode_district: 'District (e.g. LS6)',
  postcode_area: 'Area (e.g. LS)',
  rare_to_other: 'Group rare answers as “Other”',
  suppress: 'Remove column',
};

/** Escalation ladder per kind, least to most protective. */
export const LADDERS: Record<QuasiKind, Generaliser[]> = {
  age: ['none', 'age_5', 'age_10', 'age_20', 'suppress'],
  date: ['none', 'shift', 'year_month', 'year', 'suppress'],
  postcode: ['none', 'postcode_district', 'postcode_area', 'suppress'],
  category: ['none', 'rare_to_other', 'suppress'],
};

/** Generalisers offered for a kind in the given mode. */
export function generalisersFor(kind: QuasiKind, mode: Mode): Generaliser[] {
  const ladder = LADDERS[kind];
  // Date shifting is a pseudonymisation technique (keyed, reversible via the
  // key file). It does not generalise anything, so it has no place in
  // anonymise mode — nor does keeping exact dates.
  if (kind === 'date' && mode === 'ANONYMISE') {
    return ladder.filter((g) => g !== 'shift' && g !== 'none');
  }
  return ladder;
}

/**
 * Human-readable column name. Survey platforms use codes like "Q1"; when the
 * export carries the question text, show it alongside.
 */
export function displayName(p: Pick<ColumnPlan, 'column' | 'question'>): string {
  if (!p.question || p.question.trim() === p.column.trim()) return p.column;
  const q = p.question.trim();
  return `${p.column} “${q.length > 32 ? q.slice(0, 31) + '…' : q}”`;
}

// ─── Platform detection ─────────────────────────────────────────────────────

const has = (headers: string[], ...names: string[]) =>
  names.every((n) => headers.some((h) => h.trim().toLowerCase() === n.toLowerCase()));

/**
 * Recognise the export platform from its headers and first rows. Qualtrics
 * exports carry two extra header rows (question text, then ImportId JSON);
 * SurveyMonkey carries one ("Response" / "Open-Ended Response").
 */
export function detectPlatform(
  headers: string[],
  rows: Record<string, string>[]
): SurveyPlatform {
  if (has(headers, 'ResponseId') || has(headers, 'ResponseID')) {
    let meta = 0;
    const second = rows[1] ? Object.values(rows[1]).join(' ') : '';
    const first = rows[0] ? Object.values(rows[0]).join(' ') : '';
    if (/\{"ImportId"/.test(second)) meta = 2;
    else if (/\{"ImportId"/.test(first)) meta = 1;
    return { id: 'QUALTRICS', label: 'Qualtrics export', metaRowCount: meta };
  }
  if (has(headers, 'record_id') || headers.some((h) => /^redcap_/i.test(h))) {
    return { id: 'REDCAP', label: 'REDCap export', metaRowCount: 0 };
  }
  if (has(headers, 'Respondent ID') || has(headers, 'Collector ID')) {
    const first = rows[0] ? Object.values(rows[0]) : [];
    const meta = first.some((v) => /^(Open-Ended )?Response$/i.test(v.trim())) ? 1 : 0;
    return { id: 'SURVEYMONKEY', label: 'SurveyMonkey export', metaRowCount: meta };
  }
  if (has(headers, 'ID', 'Start time', 'Completion time')) {
    return { id: 'MS_FORMS', label: 'Microsoft Forms export', metaRowCount: 0 };
  }
  return { id: 'GENERIC', label: 'Spreadsheet', metaRowCount: 0 };
}

// ─── Column profiling ───────────────────────────────────────────────────────

interface Rule {
  test: RegExp;
  role: ColumnRole;
  kind?: QuasiKind;
  reason: string;
}

/** Known platform metadata columns (exact, case-insensitive). */
const PLATFORM_COLUMNS: Record<string, Omit<Rule, 'test'>> = {
  // Qualtrics
  ipaddress: { role: 'DIRECT', reason: 'IP address recorded by the survey platform' },
  recipientlastname: { role: 'DIRECT', reason: 'Recipient name from the distribution list' },
  recipientfirstname: { role: 'DIRECT', reason: 'Recipient name from the distribution list' },
  recipientemail: { role: 'DIRECT', reason: 'Recipient email from the distribution list' },
  externalreference: { role: 'DIRECT', reason: 'External reference can link back to a person' },
  locationlatitude: { role: 'DIRECT', reason: 'GPS location recorded by the survey platform' },
  locationlongitude: { role: 'DIRECT', reason: 'GPS location recorded by the survey platform' },
  responseid: { role: 'DIRECT', reason: 'Response ID links back to the platform record' },
  startdate: { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
  enddate: { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
  recordeddate: { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
  status: { role: 'KEEP', reason: 'Platform metadata' },
  progress: { role: 'KEEP', reason: 'Platform metadata' },
  'duration (in seconds)': { role: 'KEEP', reason: 'Platform metadata' },
  finished: { role: 'KEEP', reason: 'Platform metadata' },
  distributionchannel: { role: 'KEEP', reason: 'Platform metadata' },
  userlanguage: { role: 'KEEP', reason: 'Platform metadata' },
  // REDCap
  record_id: { role: 'DIRECT', reason: 'Record ID links back to the REDCap record' },
  redcap_survey_identifier: { role: 'DIRECT', reason: 'Survey identifier links back to a person' },
  redcap_event_name: { role: 'KEEP', reason: 'Platform metadata' },
  redcap_repeat_instrument: { role: 'KEEP', reason: 'Platform metadata' },
  redcap_repeat_instance: { role: 'KEEP', reason: 'Platform metadata' },
  redcap_data_access_group: { role: 'KEEP', reason: 'Platform metadata' },
  // SurveyMonkey
  'respondent id': { role: 'DIRECT', reason: 'Respondent ID links back to the platform record' },
  'collector id': { role: 'KEEP', reason: 'Platform metadata' },
  'ip address': { role: 'DIRECT', reason: 'IP address recorded by the survey platform' },
  'email address': { role: 'DIRECT', reason: 'Email address' },
  'first name': { role: 'DIRECT', reason: 'Name' },
  'last name': { role: 'DIRECT', reason: 'Name' },
  'custom data 1': { role: 'DIRECT', reason: 'Custom data often holds an identifier' },
  // Microsoft Forms
  'start time': { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
  'completion time': { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
  'last modified time': { role: 'QUASI', kind: 'date', reason: 'Exact time the person took the survey' },
};

/** Header keyword rules, first match wins. */
const HEADER_RULES: Rule[] = [
  { test: /date\s*of\s*birth|\bdob\b|birth\s*date|birthday/i, role: 'QUASI', kind: 'date', reason: 'Date of birth' },
  { test: /e-?mail/i, role: 'DIRECT', reason: 'Email address' },
  { test: /phone|mobile|\btel\b|telephone|contact\s*number/i, role: 'DIRECT', reason: 'Phone number' },
  { test: /\bnhs\b|\bmrn\b|hospital\s*number|\bssn\b|social\s*security|national\s*insurance|\bnino\b|passport/i, role: 'DIRECT', reason: 'Official identification number' },
  { test: /\bip\b|ip\s*address|latitude|longitude|\blat\b|\blong?\b|\bgps\b|geolocation/i, role: 'DIRECT', reason: 'Location or network identifier' },
  { test: /^(full\s*|first\s*|last\s*|sur|fore|given\s*|family\s*|middle\s*|maiden\s*)?name$|participant\s*name|respondent\s*name|patient\s*name/i, role: 'DIRECT', reason: 'Name' },
  { test: /address|street|house\s*number/i, role: 'DIRECT', reason: 'Street address' },
  { test: /\bid\b|_id$|identifier|\breference\b|\bref\b|participant\s*(no|number|code)|study\s*(no|number|code)/i, role: 'DIRECT', reason: 'Identifier that can link back to a person' },
  { test: /signature|consent\s*name|initials/i, role: 'DIRECT', reason: 'Signature or initials' },
  { test: /post\s*code|postal|zip/i, role: 'QUASI', kind: 'postcode', reason: 'Postcode — identifying in combination' },
  { test: /\bage\b|age\s*\(|age_|years\s*old/i, role: 'QUASI', kind: 'age', reason: 'Age — identifying in combination' },
  { test: /\bdate\b|timestamp|_time$|submitted\s*at|completed\s*at/i, role: 'QUASI', kind: 'date', reason: 'Date — identifying in combination' },
  { test: /gender|\bsex\b/i, role: 'QUASI', kind: 'category', reason: 'Gender — identifying in combination' },
  { test: /ethnic|\brace\b|nationality|country\s*of\s*birth|first\s*language/i, role: 'QUASI', kind: 'category', reason: 'Ethnicity or origin — identifying in combination' },
  { test: /occupation|\bjob\b|profession|employer/i, role: 'QUASI', kind: 'category', reason: 'Occupation — identifying in combination' },
  { test: /\brole\b|workplace|department|\bward\b|\bsite\b|hospital|clinic|\bpractice\b|\btrust\b|institution|school|university/i, role: 'QUASI', kind: 'category', reason: 'Work or care setting — identifying in combination' },
  { test: /\b(city|town|village|county|region|borough|district|state|country|area)\b/i, role: 'QUASI', kind: 'category', reason: 'Location — identifying in combination' },
  { test: /marital|household|children|dependants|education|qualification|income|salary|employment/i, role: 'QUASI', kind: 'category', reason: 'Demographic — identifying in combination' },
  { test: /diagnos|condition|disease|illness|disab|medication|medicine|treatment|hiv|mental\s*health|pregnan|religio|belief|sexual|orientation|trans|gender\s*identity/i, role: 'SENSITIVE', reason: 'Special-category data (health, religion, sexuality)' },
  { test: /comment|describe|explain|tell\s*us|other.*specify|please\s*specify|\bwhy\b|feedback|free\s*text|\bopen\b|\bnotes?\b|_text$|\btext\b/i, role: 'FREE_TEXT', reason: 'Open-ended written answer' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{9,}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{6,}$/i;
const UK_POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;
const US_ZIP_RE = /^(\d{3})\d{2}(-\d{4})?$/;

function sample(values: string[], n = 200): string[] {
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length <= n) return nonEmpty;
  const step = nonEmpty.length / n;
  return Array.from({ length: n }, (_, i) => nonEmpty[Math.floor(i * step)]);
}

const share = (vals: string[], test: (v: string) => boolean) =>
  vals.length === 0 ? 0 : vals.filter(test).length / vals.length;

/** "Q1_Age" → "q1 age": treat _ - . as word separators for keyword rules. */
function normalise(text: string): string {
  return text.replace(/[_.\-]+/g, ' ').toLowerCase();
}

/**
 * Rules that are reliable on free-form QUESTION text ("What is your age?").
 * The broad setting/location rules are excluded: "How satisfied were you
 * with this hospital?" is a rating, not a workplace column.
 */
const QUESTION_RULES: Rule[] = [
  { test: /date\s*of\s*birth|\bdob\b|when\s*were\s*you\s*born|birth\s*date/i, role: 'QUASI', kind: 'date', reason: 'Date of birth (from the question)' },
  { test: /\bage\b|how\s*old/i, role: 'QUASI', kind: 'age', reason: 'Age (from the question)' },
  { test: /e-?mail/i, role: 'DIRECT', reason: 'Email address (from the question)' },
  { test: /phone|mobile\s*number|contact\s*number/i, role: 'DIRECT', reason: 'Phone number (from the question)' },
  { test: /your\s*(full\s*|first\s*|last\s*|sur)?name\b/i, role: 'DIRECT', reason: 'Name (from the question)' },
  { test: /post\s*code|zip\s*code|postal\s*code/i, role: 'QUASI', kind: 'postcode', reason: 'Postcode (from the question)' },
  { test: /\bgender\b|\bsex\b/i, role: 'QUASI', kind: 'category', reason: 'Gender (from the question)' },
  { test: /ethnic|\brace\b|nationality/i, role: 'QUASI', kind: 'category', reason: 'Ethnicity or origin (from the question)' },
  { test: /occupation|\bjob\b|profession|employer/i, role: 'QUASI', kind: 'category', reason: 'Occupation (from the question)' },
  { test: /comment|describe|explain|tell\s*us|please\s*specify|\bwhy\b|anything\s*else/i, role: 'FREE_TEXT', reason: 'Open-ended question' },
];

/** Infer the quasi kind from the header, falling back to the values. */
export function inferKind(column: string, values: string[], description = ''): QuasiKind {
  const h = normalise(`${column} ${description}`);
  if (/post\s*code|postal|\bzip\b/.test(h)) return 'postcode';
  if (/\bage\b|years\s*old|how\s*old/.test(h)) return 'age';
  if (/\bdate\b|\bdob\b|birth|\btime\b|timestamp/.test(h)) return 'date';
  const vals = sample(values);
  if (share(vals, (v) => parseDate(v) !== null) > 0.8) return 'date';
  if (share(vals, (v) => UK_POSTCODE_RE.test(v.trim()) || US_ZIP_RE.test(v.trim())) > 0.8) return 'postcode';
  return 'category';
}

/**
 * Suggest a plan for one column. Header rules first (they encode intent),
 * then value-based evidence (emails, phones, IPs, long prose).
 */
export function suggestColumn(
  column: string,
  values: string[],
  mode: Mode,
  /** Question text from a platform header row (Qualtrics), if any. */
  description = ''
): ColumnPlan {
  const key = column.trim().toLowerCase();
  const vals = sample(values);

  let role: ColumnRole | null = null;
  let kind: QuasiKind = 'category';
  let reason = '';

  const platform = PLATFORM_COLUMNS[key];
  if (platform) {
    role = platform.role;
    kind = platform.kind ?? 'category';
    reason = platform.reason;
  }

  // Value evidence overrides a generic header — an "Contact" column full of
  // email addresses is an email column whatever it is called.
  if (!role) {
    if (share(vals, (v) => EMAIL_RE.test(v.trim())) > 0.5) {
      role = 'DIRECT'; reason = 'Values look like email addresses';
    } else if (share(vals, (v) => IP_RE.test(v.trim()) && v.includes('.')) > 0.5) {
      role = 'DIRECT'; reason = 'Values look like IP addresses';
    }
  }

  if (!role) {
    const header = normalise(column);
    const rule =
      HEADER_RULES.find((r) => r.test.test(header)) ??
      (description ? QUESTION_RULES.find((r) => r.test.test(description)) : undefined);
    if (rule) {
      role = rule.role;
      kind = rule.kind ?? 'category';
      reason = rule.reason;
    }
  }

  if (!role) {
    const avgLen = vals.reduce((s, v) => s + v.length, 0) / Math.max(vals.length, 1);
    const distinct = new Set(vals).size;
    if (share(vals, (v) => PHONE_RE.test(v.trim()) && v.replace(/\D/g, '').length >= 9) > 0.6) {
      role = 'DIRECT'; reason = 'Values look like phone numbers';
    } else if (share(vals, (v) => UK_POSTCODE_RE.test(v.trim())) > 0.6) {
      role = 'QUASI'; kind = 'postcode'; reason = 'Values look like postcodes';
    } else if (avgLen > 40 || (avgLen > 20 && distinct > vals.length * 0.8)) {
      role = 'FREE_TEXT'; reason = 'Long, varied answers — scanned like written text';
    } else if (vals.length >= 10 && share(vals, (v) => parseDate(v) !== null) > 0.8) {
      role = 'QUASI'; kind = 'date'; reason = 'Values look like dates';
    } else {
      role = 'KEEP'; reason = 'Short answers from a fixed set — still scanned for identifiers';
    }
  }

  if (role === 'QUASI' && kind === 'category' && !/gender|sex|ethnic|occupation/i.test(reason)) {
    kind = inferKind(column, values, description);
  }

  return {
    column, role, kind, generaliser: defaultGeneraliser(kind, mode), reason,
    ...(description ? { question: description } : {}),
  };
}

export function defaultGeneraliser(kind: QuasiKind, mode: Mode): Generaliser {
  switch (kind) {
    case 'age': return 'age_5';
    case 'date': return mode === 'ANONYMISE' ? 'year' : 'shift';
    case 'postcode': return 'postcode_district';
    case 'category': return mode === 'ANONYMISE' ? 'rare_to_other' : 'none';
  }
}

export function suggestPlans(
  headers: string[],
  dataRows: Record<string, string>[],
  mode: Mode,
  /** Question-text row (e.g. Qualtrics row 2), keyed by column. */
  descriptions: Record<string, string> = {}
): ColumnPlan[] {
  return headers.map((h) =>
    suggestColumn(h, dataRows.map((r) => r[h] ?? ''), mode, descriptions[h] ?? '')
  );
}

/** The question-text row for platforms that export one, else {}. */
export function questionRow(
  platform: SurveyPlatform,
  rows: Record<string, string>[]
): Record<string, string> {
  return platform.id === 'QUALTRICS' && platform.metaRowCount > 0 ? rows[0] ?? {} : {};
}

// ─── Generalisers ───────────────────────────────────────────────────────────

/** Parse common survey date formats. Returns year and (when unambiguous) month. */
export function parseDate(raw: string): { year: number; month: number | null } | null {
  const v = raw.trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(v);
  if (m) return { year: +m[1], month: +m[2] };
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T].*)?$/.exec(v);
  if (m) {
    const a = +m[1], b = +m[2];
    // Month known only when one side cannot be a month.
    const month = a > 12 ? b : b > 12 ? a : null;
    return { year: +m[3], month };
  }
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(v);
  if (m) return { year: +m[1], month: +m[2] };
  return null;
}

/**
 * ZIP3 prefixes with population ≤ 20,000 (US Census 2000). HIPAA Safe Harbor
 * requires these to be rendered as 000.
 */
const RESTRICTED_ZIP3 = new Set([
  '036', '059', '063', '102', '203', '556', '692', '790', '821', '823', '830',
  '831', '878', '879', '884', '890', '893',
]);

const AGE_RE = /^\s*(\d{1,3})(?:\.\d+)?\s*(?:y(?:ea)?rs?)?\s*$/i;

function ageBand(age: number, width: number): string {
  if (age >= 90) return '90+';
  const lo = Math.floor(age / width) * width;
  const hi = Math.min(lo + width - 1, 89);
  return `${lo}-${hi}`;
}

/** Cutoff year: anyone born in or before it is 90+ today. */
function over89BirthYear(now: Date): number {
  return now.getFullYear() - 90;
}

/**
 * Generalise one value. Returns null when the value cannot be interpreted
 * (e.g. "Prefer not to say" in an age column) — the caller then falls back
 * to the span engine's output for that cell.
 */
export function generaliseValue(
  value: string,
  plan: ColumnPlan,
  now: Date = new Date()
): string | null {
  const v = value.trim();
  if (!v) return '';
  switch (plan.generaliser) {
    case 'none':
    case 'shift':
    case 'rare_to_other':
      return null; // handled at column level / by the engine
    case 'suppress':
      return '';
    case 'age_5':
    case 'age_10':
    case 'age_20': {
      const m = AGE_RE.exec(v);
      if (!m) return null;
      const width = plan.generaliser === 'age_5' ? 5 : plan.generaliser === 'age_10' ? 10 : 20;
      return ageBand(+m[1], width);
    }
    case 'year_month':
    case 'year': {
      const d = parseDate(v);
      if (!d) return null;
      const isBirth = /birth|dob/i.test(plan.column);
      if (isBirth && d.year <= over89BirthYear(now)) return `${over89BirthYear(now)} or earlier`;
      if (plan.generaliser === 'year' || d.month === null) return String(d.year);
      return `${d.year}-${String(d.month).padStart(2, '0')}`;
    }
    case 'postcode_district':
    case 'postcode_area': {
      const area = plan.generaliser === 'postcode_area';
      const uk = UK_POSTCODE_RE.exec(v.toUpperCase());
      if (uk) return area ? uk[1].replace(/\d.*$/, '') : uk[1];
      const zip = US_ZIP_RE.exec(v);
      if (zip) {
        const z3 = RESTRICTED_ZIP3.has(zip[1]) ? '000' : zip[1];
        return area ? `${z3[0]}xx` : `${z3}xx`;
      }
      // Other formats (EU numeric etc.): keep the leading characters.
      const compact = v.replace(/\s+/g, '');
      if (compact.length < 3) return null;
      return area ? compact.slice(0, 1) + '…' : compact.slice(0, 2) + '…';
    }
  }
}

/**
 * Column-level generalisation. Returns one value per input value, or null in
 * a slot where the engine's output should be used instead.
 */
export function generaliseColumn(
  values: string[],
  plan: ColumnPlan,
  kThreshold: number,
  now: Date = new Date()
): Array<string | null> {
  if (plan.generaliser === 'rare_to_other') {
    const counts = new Map<string, number>();
    for (const v of values) {
      const key = v.trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return values.map((v) => {
      const key = v.trim().toLowerCase();
      if (!key) return '';
      return (counts.get(key) ?? 0) < kThreshold ? 'Other' : v.trim();
    });
  }
  if (plan.generaliser === 'none') return values.map((v) => v);
  return values.map((v) => generaliseValue(v, plan, now));
}

// ─── Risk measurement ───────────────────────────────────────────────────────

const SUPPRESSED = '*';

/**
 * Build the generalised quasi value for every row, as used for k-anonymity.
 * Values the generaliser cannot interpret are kept verbatim (conservative —
 * an uninterpretable value is still visible to an attacker).
 */
function quasiMatrix(
  dataRows: Record<string, string>[],
  plans: ColumnPlan[],
  kThreshold: number,
  cache?: Map<string, string[]>
): { columns: string[]; matrix: string[][] } {
  const quasi = plans.filter((p) => p.role === 'QUASI' && p.generaliser !== 'suppress');
  const matrix = quasi.map((p) => {
    const cacheKey = `${p.column}\u0000${p.generaliser}`;
    const hit = cache?.get(cacheKey);
    if (hit) return hit;
    const raw = dataRows.map((r) => r[p.column] ?? '');
    const gen = generaliseColumn(raw, p, kThreshold);
    const col = gen.map((g, i) => (g === null ? raw[i].trim() : g).toLowerCase());
    cache?.set(cacheKey, col);
    return col;
  });
  return { columns: quasi.map(displayName), matrix };
}

export function measureRisk(
  dataRows: Record<string, string>[],
  plans: ColumnPlan[],
  kThreshold: number,
  suppressedRows: number[] = [],
  cache?: Map<string, string[]>
): TabularRisk {
  const { columns, matrix } = quasiMatrix(dataRows, plans, kThreshold, cache);
  const suppressed = new Set(suppressedRows);
  const totalRows = dataRows.length;

  if (columns.length === 0 || totalRows === 0) {
    return { k: Infinity, rowsAtRisk: 0, rowIndicesAtRisk: [], l: null, quasiColumns: columns, totalRows, groupCount: 0, riskiestGroups: [] };
  }

  const groups = new Map<string, number[]>();
  for (let r = 0; r < totalRows; r++) {
    // A row whose quasi values are all hidden carries nothing to link on.
    if (suppressed.has(r)) continue;
    const key = matrix.map((col) => col[r]).join('\u0001');
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  let k = Infinity;
  const atRisk: number[] = [];
  const small: RiskGroup[] = [];
  for (const [key, rows] of Array.from(groups.entries())) {
    k = Math.min(k, rows.length);
    if (rows.length < kThreshold) {
      atRisk.push(...rows);
      small.push({ description: key.split('\u0001').map((v) => v || '(blank)').join(' · '), size: rows.length });
    }
  }
  small.sort((a, b) => a.size - b.size);

  // l-diversity over sensitive columns.
  const sensitive = plans.filter((p) => p.role === 'SENSITIVE');
  let l: number | null = null;
  if (sensitive.length > 0) {
    l = Infinity;
    for (const rows of Array.from(groups.values())) {
      for (const p of sensitive) {
        const distinct = new Set(rows.map((r) => (dataRows[r][p.column] ?? '').trim().toLowerCase()));
        l = Math.min(l, distinct.size);
      }
    }
    if (!isFinite(l)) l = null;
  }

  return {
    k: groups.size === 0 ? Infinity : k,
    rowsAtRisk: atRisk.length,
    rowIndicesAtRisk: atRisk.sort((a, b) => a - b),
    l,
    quasiColumns: columns,
    totalRows,
    groupCount: groups.size,
    riskiestGroups: small.slice(0, 5),
  };
}

// ─── Auto-fix ───────────────────────────────────────────────────────────────

export interface AutoFixResult {
  plans: ColumnPlan[];
  suppressedRows: number[];
  notes: string[];
  risk: TabularRisk;
}

/**
 * Progress order: fewer at-risk rows first; on a plateau (e.g. exact age →
 * 5-year bands does not yet lift anyone over the threshold), fewer distinct
 * groups still counts as progress towards it.
 */
function better(a: TabularRisk, b: TabularRisk): boolean {
  return a.rowsAtRisk < b.rowsAtRisk || (a.rowsAtRisk === b.rowsAtRisk && a.groupCount < b.groupCount);
}

/** Share of rows we are willing to hide automatically before asking the user. */
const MAX_AUTO_SUPPRESS_SHARE = 0.1;

/**
 * Greedy repair to reach k ≥ threshold with as little information loss as
 * possible:
 *  1. Repeatedly take the single one-step generalisation (never "remove
 *     column") that most reduces the number of at-risk rows.
 *  2. If a small residue of rows is still unique, hide their quasi values
 *     (local suppression) — capped at 10% of rows.
 *  3. Otherwise report which column is the biggest obstacle and let the user
 *     decide; removing a column is never done silently.
 */
export function autoFix(
  dataRows: Record<string, string>[],
  plans: ColumnPlan[],
  kThreshold: number,
  mode: Mode
): AutoFixResult {
  const cache = new Map<string, string[]>();
  let current = plans.map((p) => ({ ...p }));
  const notes: string[] = [];
  let risk = measureRisk(dataRows, current, kThreshold, [], cache);

  for (let iter = 0; iter < 40 && risk.k < kThreshold; iter++) {
    let best: { plans: ColumnPlan[]; risk: TabularRisk; note: string } | null = null;
    for (let i = 0; i < current.length; i++) {
      const p = current[i];
      if (p.role !== 'QUASI') continue;
      const ladder = generalisersFor(p.kind, mode);
      // 'none' and 'shift' hide nothing from a k-anonymity point of view, so
      // stepping between them never helps — skip to a real generalisation.
      const next = ladder
        .slice(ladder.indexOf(p.generaliser) + 1)
        .find((g) => g !== 'none' && g !== 'shift');
      if (!next || next === 'suppress') continue;
      const trial = current.map((q, j) => (j === i ? { ...q, generaliser: next } : q));
      const r = measureRisk(dataRows, trial, kThreshold, [], cache);
      if (!best || better(r, best.risk)) {
        best = {
          plans: trial,
          risk: r,
          note: `${displayName(p)}: ${GENERALISER_LABELS[p.generaliser]} → ${GENERALISER_LABELS[next]}`,
        };
      }
    }
    if (!best || !better(best.risk, risk)) break;
    current = best.plans;
    risk = best.risk;
    notes.push(best.note);
  }

  let suppressedRows: number[] = [];
  if (risk.k < kThreshold && risk.rowsAtRisk > 0) {
    if (risk.rowsAtRisk <= Math.max(1, Math.floor(dataRows.length * MAX_AUTO_SUPPRESS_SHARE))) {
      suppressedRows = risk.rowIndicesAtRisk;
      notes.push(
        `Hid the identifying details of ${suppressedRows.length} response${suppressedRows.length === 1 ? '' : 's'} that were still unique (their answers are kept).`
      );
      risk = measureRisk(dataRows, current, kThreshold, suppressedRows, cache);
    } else {
      const culprit = biggestObstacle(dataRows, current, kThreshold, cache);
      notes.push(
        culprit
          ? `Still ${risk.rowsAtRisk} responses at risk. Removing the “${culprit}” column would help most.`
          : `Still ${risk.rowsAtRisk} responses at risk. Consider removing a column that could identify people.`
      );
    }
  }

  return { plans: current, suppressedRows, notes, risk };
}

/** The quasi column whose removal reduces at-risk rows the most. */
export function biggestObstacle(
  dataRows: Record<string, string>[],
  plans: ColumnPlan[],
  kThreshold: number,
  cache?: Map<string, string[]>
): string | null {
  let best: { column: string; rows: number } | null = null;
  for (const p of plans) {
    if (p.role !== 'QUASI' || p.generaliser === 'suppress') continue;
    const trial = plans.map((q) => (q === p ? { ...q, generaliser: 'suppress' as const } : q));
    const r = measureRisk(dataRows, trial, kThreshold, [], cache);
    if (!best || r.rowsAtRisk < best.rows) best = { column: displayName(p), rows: r.rowsAtRisk };
  }
  return best?.column ?? null;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

/** Pseudonym label for a direct-identifier column: reuse engine labels where
 *  they exist so the same name gets the same token in free text and column. */
function pseudonymLabel(column: string): string {
  const h = column.toLowerCase();
  if (/e-?mail/.test(h)) return 'EMAIL';
  if (/phone|mobile|tel/.test(h)) return 'PHONE';
  if (/\bip\b|ipaddress|ip address/.test(h)) return 'IP';
  if (/name/.test(h)) return 'NAME';
  const slug = column.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
  return slug || 'ID';
}

/** Pure small numbers ("5", "3.5", "100") in a safe-answer column are scale
 *  answers, not identifiers — the engine's ZIP / ID rules must not eat them. */
const SCALE_NUMBER_RE = /^-?\d{1,4}(?:[.,]\d+)?$|^-?\d+[.,]\d+$/;

/** Does this column's output come from the span engine (vs a column rule)? */
export function usesEngineOutput(plan: ColumnPlan): boolean {
  return plan.role === 'FREE_TEXT' || plan.role === 'KEEP' || plan.role === 'SENSITIVE';
}

/**
 * Shift a survey date/timestamp by whole days, keeping its format and any
 * time-of-day suffix ("2024-03-01 10:00:00" → "2024-02-12 10:00:00"). Returns
 * null for ambiguous or unparseable values (the engine output is used then).
 */
export function shiftDateValue(
  value: string,
  days: number,
  /** Column-wide day/month order, used when a value alone is ambiguous. */
  order?: 'DMY' | 'MDY'
): string | null {
  const v = value.trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  const shift = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null; // invalid date, e.g. 31/02
    dt.setUTCDate(dt.getUTCDate() + days);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})([ T].*)?$/.exec(v);
  if (m) {
    const r = shift(+m[1], +m[2], +m[3]);
    return r ? `${r.y}-${pad(r.m)}-${pad(r.d)}${m[4] ?? ''}` : null;
  }
  m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})([ ,T].*)?$/.exec(v);
  if (m) {
    const a = +m[1], b = +m[3], sep = m[2];
    const dmy = a > 12 ? true : b > 12 ? false : order ? order === 'DMY' : null;
    if (dmy === null) return null;
    const r = dmy ? shift(+m[4], b, a) : shift(+m[4], a, b);
    if (!r) return null;
    const [first, second] = dmy ? [r.d, r.m] : [r.m, r.d];
    return `${pad(first)}${sep}${pad(second)}${sep}${r.y}${m[5] ?? ''}`;
  }
  return null;
}

export interface ApplyResult {
  headers: string[];
  /** Output rows (meta rows first, untouched by column rules). */
  rows: Record<string, string>[];
  /** Original → pseudonym entries for DIRECT columns (pseudonymise mode). */
  mapping: Record<string, string>;
  /** Original direct-identifier values, for the verbatim leak check. */
  directOriginals: string[];
  removedColumns: string[];
  generalisedCells: number;
}

/**
 * Combine column decisions with the span engine's per-cell output.
 *
 * @param originalRows all parsed rows (meta rows first)
 * @param engineRows   same shape, each cell = span-engine output
 */
export async function applyPlans(input: {
  headers: string[];
  originalRows: Record<string, string>[];
  engineRows: Record<string, string>[];
  metaRowCount: number;
  plans: ColumnPlan[];
  suppressedRows: number[];
  mode: Mode;
  secret?: SessionSecret;
  kThreshold: number;
  /** Session date offset from the span engine (pseudonymise mode). */
  dateShiftDays?: number;
}): Promise<ApplyResult> {
  const { headers, originalRows, engineRows, metaRowCount, plans, mode, secret, kThreshold } = input;
  const planBy = new Map(plans.map((p) => [p.column, p]));
  const suppressed = new Set(input.suppressedRows);
  const dataOriginal = originalRows.slice(metaRowCount);

  const removedColumns = headers.filter((h) => {
    const p = planBy.get(h);
    if (!p) return false;
    if (p.role === 'DIRECT') return mode === 'ANONYMISE';
    return p.role === 'QUASI' && p.generaliser === 'suppress';
  });
  const outHeaders = headers.filter((h) => !removedColumns.includes(h));

  // Day/month order per date-shift column, inferred from unambiguous values.
  const dateOrder = new Map<string, 'DMY' | 'MDY'>();
  for (const p of plans) {
    if (p.role !== 'QUASI' || p.generaliser !== 'shift') continue;
    for (const row of dataOriginal) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec((row[p.column] ?? '').trim());
      if (m && +m[1] > 12) { dateOrder.set(p.column, 'DMY'); break; }
      if (m && +m[2] > 12) { dateOrder.set(p.column, 'MDY'); break; }
    }
  }

  // Pre-compute generalised columns once.
  const generalised = new Map<string, Array<string | null>>();
  for (const p of plans) {
    if (p.role === 'QUASI' && p.generaliser !== 'suppress' && p.generaliser !== 'shift') {
      generalised.set(p.column, generaliseColumn(dataOriginal.map((r) => r[p.column] ?? ''), p, kThreshold));
    }
  }

  // Pseudonyms for DIRECT columns, computed once per distinct value.
  const mapping: Record<string, string> = {};
  const directOriginals: string[] = [];
  const tokens = new Map<string, string>();
  for (const p of plans) {
    if (p.role !== 'DIRECT') continue;
    const label = pseudonymLabel(p.column);
    for (const row of dataOriginal) {
      const v = (row[p.column] ?? '').trim();
      if (!v) continue;
      if (v.length >= 4 && /[A-Za-z]|\d{6,}/.test(v)) directOriginals.push(v);
      if (mode === 'PSEUDONYMISE' && !tokens.has(`${label}\u0000${v}`)) {
        if (!secret) throw new Error('Pseudonymise mode requires a session secret.');
        const token = await generatePseudonym(secret, label, v);
        tokens.set(`${label}\u0000${v}`, token);
        mapping[v] = token;
      }
    }
  }

  let generalisedCells = 0;
  const rows = originalRows.map((orig, r) => {
    const engine = engineRows[r];
    const out: Record<string, string> = {};
    const dataIdx = r - metaRowCount;
    for (const h of outHeaders) {
      const p = planBy.get(h);
      const original = orig[h] ?? '';
      const engineVal = engine[h] ?? original;
      if (dataIdx < 0 || !p) {
        out[h] = engineVal; // meta rows (question text): engine output only
        continue;
      }
      switch (p.role) {
        case 'DIRECT': {
          const v = original.trim();
          out[h] = v ? tokens.get(`${pseudonymLabel(h)}\u0000${v}`) ?? '' : '';
          break;
        }
        case 'QUASI': {
          if (suppressed.has(dataIdx)) {
            out[h] = original.trim() ? SUPPRESSED : '';
          } else if (p.generaliser === 'shift') {
            const shifted =
              input.dateShiftDays !== undefined
                ? shiftDateValue(original, input.dateShiftDays, dateOrder.get(h))
                : null;
            out[h] = shifted ?? engineVal;
          } else {
            const g = generalised.get(h)?.[dataIdx];
            if (g === null || g === undefined) {
              // Uninterpretable value — keep only if 'none' was chosen,
              // otherwise defer to the engine's (redacting) output.
              out[h] = p.generaliser === 'none' ? original : engineVal;
            } else {
              if (g !== original) generalisedCells++;
              out[h] = g;
            }
          }
          break;
        }
        case 'KEEP':
          out[h] = SCALE_NUMBER_RE.test(original.trim()) ? original : engineVal;
          break;
        default:
          out[h] = engineVal;
      }
    }
    return out;
  });

  return { headers: outHeaders, rows, mapping, directOriginals, removedColumns, generalisedCells };
}
