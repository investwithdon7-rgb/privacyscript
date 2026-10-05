/**
 * Where a record probably comes from, and which rules then apply. Only a
 * SUGGESTION shown to the user: the law that applies depends on where the
 * organisation and the patients are, not on the language (a Spanish-language
 * note can come from a US hospital), so the user always confirms.
 *
 * Signals, strongest first: national ID numbers (a DNI is Spanish, a CURP
 * Mexican), phone country codes, IBAN country codes, the language.
 */

import type { Span } from '@/engine/detect';
import { detectLanguage, LANGUAGE_NAMES, type Lang } from '@/engine/language';

export type Regime = 'EU' | 'UK' | 'US' | 'OTHER';

export interface OriginSuggestion {
  country: string;
  countryName: string;
  regime: Regime;
  /** Plain-language note on the law, for countries without a built-in profile. */
  lawNote?: string;
  language: Lang | null;
  languageName: string | null;
  reasons: string[];
  /** False when only the language points to the country (Spanish ≠ Spain). */
  confident: boolean;
}

const COUNTRIES: Record<string, { name: string; regime: Regime; lawNote?: string }> = {
  DE: { name: 'Germany', regime: 'EU' },
  AT: { name: 'Austria', regime: 'EU' },
  FR: { name: 'France', regime: 'EU' },
  BE: { name: 'Belgium', regime: 'EU' },
  LU: { name: 'Luxembourg', regime: 'EU' },
  ES: { name: 'Spain', regime: 'EU' },
  IT: { name: 'Italy', regime: 'EU' },
  NL: { name: 'the Netherlands', regime: 'EU' },
  PT: { name: 'Portugal', regime: 'EU' },
  PL: { name: 'Poland', regime: 'EU' },
  SE: { name: 'Sweden', regime: 'EU' },
  DK: { name: 'Denmark', regime: 'EU' },
  FI: { name: 'Finland', regime: 'EU' },
  IE: { name: 'Ireland', regime: 'EU' },
  GB: { name: 'the United Kingdom', regime: 'UK' },
  CH: { name: 'Switzerland', regime: 'OTHER', lawNote: 'Swiss data protection law (revFADP) is close to GDPR; the GDPR rules are a sound baseline.' },
  US: { name: 'the United States', regime: 'US' },
  MX: { name: 'Mexico', regime: 'OTHER', lawNote: "Mexico's federal data protection law has no built-in profile here; the GDPR rules are a strict baseline." },
  BR: { name: 'Brazil', regime: 'OTHER', lawNote: "Brazil's LGPD has no built-in profile here; the GDPR rules are a strict baseline." },
};

const LABEL_COUNTRY: Record<string, string> = {
  NATIONAL_ID_ES: 'ES',
  NATIONAL_ID_NL_BSN: 'NL',
  NATIONAL_ID_IT_CF: 'IT',
  NATIONAL_ID_DK_CPR: 'DK',
  NATIONAL_ID_CH_AHV: 'CH',
  NHS_NUMBER: 'GB',
  UK_NINO: 'GB',
  POSTCODE_UK: 'GB',
  SSN: 'US',
};

const CALLING_CODES: Record<string, string> = {
  '34': 'ES', '52': 'MX', '49': 'DE', '33': 'FR', '39': 'IT', '31': 'NL', '351': 'PT', '32': 'BE', '43': 'AT',
  '41': 'CH', '48': 'PL', '46': 'SE', '45': 'DK', '358': 'FI', '353': 'IE', '352': 'LU', '44': 'GB', '1': 'US', '55': 'BR',
};

const LANGUAGE_HOME: Partial<Record<Lang, string>> = { de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', pt: 'PT' };

export function suggestOrigin(text: string, spans: Span[]): OriginSuggestion | null {
  const score = new Map<string, number>();
  const why = new Map<string, Set<string>>();
  const add = (country: string, weight: number, reason: string) => {
    score.set(country, (score.get(country) ?? 0) + weight);
    if (!why.has(country)) why.set(country, new Set());
    why.get(country)!.add(reason);
  };

  for (const s of spans) {
    const c = s.country ?? LABEL_COUNTRY[s.label];
    if (c) add(c, 3, 'a national ID or insurance number');
  }
  for (const m of text.matchAll(/(?<![\d\w])(?:\+|00)(\d{1,3})[\s(]/g)) {
    const code = [m[1], m[1].slice(0, 2), m[1].slice(0, 1)].find((c) => CALLING_CODES[c]);
    if (code) add(CALLING_CODES[code], 2, `a +${code} phone number`);
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\d{2}[A-Z0-9]{10,30}\b/g)) {
    if (COUNTRIES[m[1]]) add(m[1], 2, 'a bank account (IBAN)');
  }
  const { lang } = detectLanguage(text);
  const home = lang ? LANGUAGE_HOME[lang] : undefined;
  if (home) add(home, 1, `${LANGUAGE_NAMES[lang!]} text`);

  const best = Array.from(score.entries()).sort((a, b) => b[1] - a[1])[0];
  if (!best && !lang) return null;
  const info = best ? COUNTRIES[best[0]] : undefined;
  return {
    country: best?.[0] ?? '',
    countryName: info?.name ?? '',
    regime: info?.regime ?? 'OTHER',
    lawNote: info?.lawNote,
    language: lang,
    languageName: lang ? LANGUAGE_NAMES[lang] : null,
    reasons: best ? Array.from(why.get(best[0]) ?? []) : [],
    confident: (best?.[1] ?? 0) >= 2,
  };
}
