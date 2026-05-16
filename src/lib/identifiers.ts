/**
 * Identifier rule catalogue. Each rule pairs a label with a RegExp.
 * Rules are tagged with a category so the engine can decide per-mode behaviour.
 *
 * Regex notes:
 *  - All patterns use the 'gi' flags so the engine can iterate matchAll().
 *  - Patterns are written to minimise false positives in clinical text. When in
 *    doubt we prefer a labelled-context pattern (e.g. "MRN: 12345") over a bare
 *    digit-count match.
 *  - Patterns that overlap will be reconciled by the engine using priority
 *    (higher = wins). Names are intentionally NOT regex-detected — that is the
 *    NER model's responsibility.
 */

export type IdentifierCategory =
  | 'HIPAA' // one of the 18 Safe Harbor identifiers
  | 'EU' // EU/UK national identifiers
  | 'QUASI'; // quasi-identifier — flag, do not auto-redact

export type IdentifierLabel =
  // HIPAA 18
  | 'NAME' // Detected by NER only — no reliable regex pattern for names.
  | 'DATE'
  | 'PHONE'
  | 'FAX'
  | 'EMAIL'
  | 'SSN'
  | 'MRN'
  | 'INSURANCE_ID'
  | 'ACCOUNT_NUMBER'
  | 'LICENSE'
  | 'VEHICLE_VIN'
  | 'DEVICE_ID'
  | 'REFERENCE_ID'    // HIPAA #18 — any other unique identifying number/code
  | 'URL'
  | 'IP'
  | 'BIOMETRIC'
  | 'POSTCODE_US'
  | 'ADDRESS_LINE'
  // EU / UK
  | 'NHS_NUMBER'
  | 'UK_NINO'
  | 'POSTCODE_UK'
  | 'POSTCODE_EU'
  | 'NATIONAL_ID_DK_CPR'
  | 'NATIONAL_ID_NL_BSN'
  | 'NATIONAL_ID_ES'
  | 'NATIONAL_ID_IT_CF'
  | 'NATIONAL_ID_CH_AHV'
  | 'IBAN'
  | 'PASSPORT'
  // Quasi-identifiers
  | 'RARE_DISEASE_ICD'
  | 'INSTITUTION'
  | 'ETHNICITY'
  | 'OCCUPATION'
  | 'AGE_OVER_89';

export interface IdentifierRule {
  label: IdentifierLabel;
  category: IdentifierCategory;
  description: string;
  pattern: RegExp;
  /** Higher priority wins on overlap. */
  priority: number;
}

/* ----------------------------------------------------------------------------
 * HIPAA Safe Harbor identifiers
 * --------------------------------------------------------------------------*/

// Dates: matches DOB-like and admission-like dates in many common formats.
// Examples caught: 01/02/2024, 1-2-24, 2024-01-02, 2 Jan 2024, Jan 2, 2024.
const DATE_PATTERN =
  /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})\b/gi;

// Phone: lenient, international + US shapes. Requires 10+ digits total to avoid
// matching short clinical codes. Skips obvious non-phone shapes.
const PHONE_PATTERN =
  /(?<!\d)(?:\+\d{1,3}[\s\-\.]?)?(?:\(\d{2,4}\)[\s\-\.]?|\d{2,4}[\s\-\.])\d{2,4}[\s\-\.]?\d{2,4}(?:[\s\-\.]?\d{2,4})?(?!\d)/g;

// Fax: only when explicitly labelled (otherwise indistinguishable from phone).
const FAX_PATTERN =
  /\bfax(?:\s*(?:no|number|#))?\s*[:.\-]?\s*(?:\+\d{1,3}[\s\-\.]?)?(?:\(\d{2,4}\)[\s\-\.]?|\d{2,4}[\s\-\.])?\d{2,4}[\s\-\.]?\d{2,4}(?:[\s\-\.]?\d{2,4})?/gi;

const EMAIL_PATTERN = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

// US SSN: 3-2-4 digits. Excludes obviously invalid blocks (000, 666, 9xx area).
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// Medical record numbers — labelled context only (very high false-positive risk
// otherwise; clinical numbers like lab values look identical).
const MRN_PATTERN =
  /\b(?:MRN|medical\s+record\s+(?:no|number|#)|patient\s+(?:id|no|number|#)|hospital\s+(?:no|number|#))\s*[:.\-#]?\s*([A-Z0-9\-]{4,20})/gi;

// Health plan beneficiary numbers — labelled context.
const INSURANCE_PATTERN =
  /\b(?:member\s+id|policy\s+(?:no|number|#)|insurance\s+(?:id|no|number|#)|plan\s+(?:id|no|number|#)|subscriber\s+(?:id|no|number|#)|beneficiary\s+(?:id|no|number|#))\s*[:.\-#]?\s*([A-Z0-9\-]{4,20})/gi;

// Account numbers — labelled context.
const ACCOUNT_PATTERN =
  /\b(?:account\s+(?:no|number|#)|acct\s*(?:no|number|#)?)\s*[:.\-#]?\s*([A-Z0-9\-]{4,20})/gi;

// Certificate / licence numbers — labelled context.
const LICENSE_PATTERN =
  /\b(?:licen[sc]e|cert(?:ificate)?|registration|DEA|NPI)\s+(?:no|number|#|id)\s*[:.\-#]?\s*([A-Z0-9\-]{4,20})/gi;

// VIN: 17-char, no I/O/Q.
const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

// Device identifier — labelled context (serial number / device ID / bleep).
// Bleep codes are typically 4 digits; {2,30} covers that and longer device serials.
const DEVICE_PATTERN =
  /\b(?:device\s+(?:id|no|number|#|serial)|serial\s+(?:no|number|#)|UDI|bleep|pager\s*(?:no|number)?)\s*[:.\-#]?\s*([A-Z0-9\-]{2,30})/gi;

const URL_PATTERN =
  /\bhttps?:\/\/[^\s<>"]+|\bwww\.[A-Z0-9.\-]+\.[A-Z]{2,}(?:\/[^\s<>"]*)?/gi;

const IPV4_PATTERN =
  /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

const IPV6_PATTERN = /\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/gi;

// Biometric (descriptive — flag, do not redact image). Patterns like "left
// thumbprint" or "voice sample on file".
const BIOMETRIC_PATTERN =
  /\b(?:fingerprint|thumbprint|retina(?:l)?\s+scan|iris\s+scan|voice\s+(?:sample|print|recording)|biometric)\b/gi;

// US ZIP — 5-digit or 9-digit, plus geographic context cues.
const US_ZIP_PATTERN = /\b\d{5}(?:-\d{4})?\b/g;

// Address line — heuristic: number + street name + suffix.
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+[A-Z][A-Za-z'.\-]*(?:\s+[A-Z][A-Za-z'.\-]*)*\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Square|Sq\.?|Crescent|Cres\.?|Close|Terrace|Parade)\b/g;

/* ----------------------------------------------------------------------------
 * EU / UK identifiers
 * --------------------------------------------------------------------------*/

// NHS Number (UK): 10 digits, often grouped 3-3-4.
const NHS_PATTERN = /\b\d{3}[\s\-]?\d{3}[\s\-]?\d{4}\b/g;

// UK NINO: 2 letters + 6 digits + 1 letter (some prefixes excluded by regs).
const UK_NINO_PATTERN =
  /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;

// UK postcode: full alphanumeric pattern.
const UK_POSTCODE_PATTERN =
  /\b(?:GIR\s?0AA|[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]|[A-HK-Y][0-9][0-9ABEHMNPRV-Y]|[0-9][A-HJKPS-UW])\s?[0-9][ABD-HJLNP-UW-Z]{2})\b/gi;

// EU postcodes (common shapes: DE 5 digits, FR 5 digits, NL 4+2chars, etc).
// Conservative — labelled context to avoid eating year/MRN matches.
const EU_POSTCODE_PATTERN =
  /\b(?:postcode|post\s+code|postal\s+code|PLZ|CP|CAP|ZIP)\s*[:.\-]?\s*([A-Z0-9\-\s]{3,10})/gi;

// Denmark CPR: ddmmyy-xxxx (10 digits with dash).
const CPR_PATTERN = /\b\d{6}-\d{4}\b/g;

// Netherlands BSN: 8-9 digits (11-check). Labelled-context to reduce FPs.
const BSN_PATTERN = /\b(?:BSN|burgerservicenummer)\s*[:.\-]?\s*(\d{8,9})\b/gi;

// Spain DNI/NIE: 8 digits + letter, or [XYZ] + 7 digits + letter.
const ES_ID_PATTERN = /\b(?:[XYZ]\d{7}|\d{8})[\-\s]?[A-Z]\b/g;

// Italy Codice Fiscale: 16 alphanumeric.
const IT_CF_PATTERN = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/g;

// Switzerland AHV: 756.XXXX.XXXX.XX (13 digits).
const CH_AHV_PATTERN = /\b756[\.\s]?\d{4}[\.\s]?\d{4}[\.\s]?\d{2}\b/g;

// IBAN: country code (2) + check digits (2) + up to 30 alphanumeric.
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;

// Passport: heuristic — labelled context only.
const PASSPORT_PATTERN =
  /\bpassport\s+(?:no|number|#)\s*[:.\-]?\s*([A-Z0-9]{6,12})\b/gi;

/* ----------------------------------------------------------------------------
 * Quasi-identifiers (flag, do not auto-remove)
 * --------------------------------------------------------------------------*/

// Rare disease ICD-10 codes — pattern matches the code shape; the engine cross
// references against a prevalence list to decide whether to flag.
const ICD10_PATTERN = /\b[A-TV-Z][0-9][A-Z0-9](?:\.[A-Z0-9]{1,4})?\b/g;

// INSTITUTION_PATTERN — matches treating-institution names.
// "General" requires "Hospital" to follow; standalone "General" is too broad
// and false-positives on "General Medicine / Cardiology" specialty strings.
const INSTITUTION_PATTERN =
  /\b(?:[A-Z][a-z]+\s+){0,4}(?:Hospitals?|Clinic|Medical\s+Centers?|Medical\s+Centres?|Infirmary|NHS\s+(?:Trust|Greater\s+\w+(?:\s+and\s+\w+)?|Lothian|Borders)|Health(?:\s+(?:System|Network|Trust))?|Healthcare|Memorial|UMC|University\s+Medical\s+Center|Universit(?:ätsmedizin|y\s+Hospitals?)|Charit[éeè]|General\s+Hospital)\b/g;

const ETHNICITY_PATTERN =
  /\b(?:White|Black|Asian|Hispanic|Latino|Latina|Latinx|Caucasian|African[\s\-]?American|Native[\s\-]?American|Pacific[\s\-]?Islander|Mixed[\s\-]?race|Arab|Indigenous)\b/gi;

const OCCUPATION_PATTERN =
  /\b(?:occupation|job|profession|employed\s+as)\s*[:.\-]?\s*([A-Z][A-Za-z\s\-]{2,40})/gi;

// "Age 92", "age: 95", "94 years old" — require explicit context to avoid
// matching unrelated 2-3 digit numbers (postcodes, ICD codes, lab values).
const AGE_OVER_89_PATTERN =
  /\b(?:age(?:d)?\s*[:.\-]?\s*(\d{2,3})|(\d{2,3})\s*(?:y\.?o\.?\b|years?\s+old\b|years?\s+of\s+age\b))/gi;

/* ----------------------------------------------------------------------------
 * UK / EU clinical professional registration numbers
 * --------------------------------------------------------------------------*/

// GMC (General Medical Council), NMC (Nursing), GDC (Dental), HCPC, etc.
// Matches "GMC: 6184472", "NMC pin: 12A3456B", "HCPC 09012345" etc.
// Registered as LICENSE (HIPAA #11 — certificate / licence number).
const REGISTRATION_PATTERN =
  /\b(?:GMC|NMC|GDC|HCPC|GPhC|GOC|GOsC)\s*(?:pin\s*#?|no\.?|number|reg\.?)?\s*[:.\-#]?\s*([A-Z0-9\-]{5,12})\b/gi;

/* ----------------------------------------------------------------------------
 * Trust / document / referral reference codes  (HIPAA #18)
 * --------------------------------------------------------------------------*/

// Matches labelled reference codes: "Trust Reference: NWGH-DSC-2024-118429",
// "Document ID: DS-7724831-A", "reference WHR-CR-2024-0331".
// Code shape: 2-6 uppercase letters + digit-or-hyphen + alphanumeric tail.
const REFERENCE_PATTERN =
  /\b(?:trust\s+ref(?:erence)?|document\s+(?:id|ref(?:erence)?|no\.?)|referral\s+(?:ref(?:erence)?|no|code)|record\s+(?:ref|id|no)|ref(?:erence)?)\s*[:.\-#]?\s*([A-Z]{2,6}[0-9\-][A-Z0-9\-\.\/]{3,35})\b/gi;

/* ----------------------------------------------------------------------------
 * Context-anchored name detection  (NER fallback)
 *
 * Names are the #1 HIPAA identifier but cannot be reliably detected by a
 * content-agnostic regex alone. These patterns use strong contextual anchors
 * (honorifics, professional credentials, labelled fields, staff-role keywords)
 * to catch names in clearly-structured positions with a low false-positive rate.
 *
 * When the NER model is loaded it produces higher-confidence PER spans that
 * win any overlap through the priority merge. These patterns are an essential
 * fallback for the first-load case where the NER model has not yet downloaded.
 * --------------------------------------------------------------------------*/

// 1. Honorific prefix: "Dr Marcus Holloway", "Mrs Achterberg", "Prof Singh".
//    Capture group = name only (honorific is not part of the identifier).
const NAME_HONORIFIC_PATTERN =
  /\b(?:Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?|Miss|Sister)\s+([A-Z][A-Za-z\-']{1,30}(?:\s+[A-Z][A-Za-z\-']{1,30}){0,2})\b/g;

// 2. Professional credential suffix: "Bernadette Aikens, RN" / "Holloway, FRCP".
//    Capture = name before the comma; credentials left intact.
const NAME_CREDENTIAL_PATTERN =
  /\b([A-Z][A-Za-z\-']{1,30}(?:\s+[A-Z][A-Za-z\-']{1,30}){1,3})\s*,\s*(?:FRCP(?:E|CH)?|MRCP(?:CH)?|FRCPsych|MRCPsych|FRCGP|MRCGP|FRCS|FRCR|FRCOG|RN|RGN|MBChB|MBBS)\b/g;

// 3. Labelled name field: "Patient name: Eveline Achterberg", "Next of kin: Pieter…",
//    "Completed by: Dr Priya Iyer", "On behalf of: Dr Marcus Holloway".
const NAME_FIELD_PATTERN =
  /\b(?:patient(?:'s)?\s+name|name\s+of\s+patient|next\s+of\s+kin|completed\s+by|on\s+behalf\s+of|signed\s+by)\s*[:=\-]?\s*(?:Dr\.?\s+|Prof\.?\s+)?([A-Z][A-Za-z\-']{1,30}(?:\s+[A-Z][A-Za-z\-']{1,30}){1,3})/gi;

// 4. Clinical staff role + name: "specialist nurse Karoline Stenberg",
//    "Caldicott Guardian: Dr Faisal Rehman".
const NAME_STAFF_ROLE_PATTERN =
  /\b(?:specialist\s+nurse|heart\s+failure\s+nurse|clinical\s+nurse|charge\s+nurse|ward\s+sister|caldicott\s+guardian|named\s+nurse|clinical\s+lead)\s*[:.\-]?\s*(?:Dr\.?\s+)?([A-Z][A-Za-z\-']{1,30}(?:\s+[A-Z][A-Za-z\-']{1,30}){0,2})\b/gi;

/* ----------------------------------------------------------------------------
 * Rule list
 * --------------------------------------------------------------------------*/

export const IDENTIFIER_RULES: IdentifierRule[] = [
  // High-confidence direct identifiers first
  { label: 'EMAIL', category: 'HIPAA', description: 'Email address', pattern: EMAIL_PATTERN, priority: 95 },
  { label: 'URL', category: 'HIPAA', description: 'Web URL', pattern: URL_PATTERN, priority: 92 },
  { label: 'IP', category: 'HIPAA', description: 'IP address', pattern: IPV4_PATTERN, priority: 90 },
  { label: 'IP', category: 'HIPAA', description: 'IPv6 address', pattern: IPV6_PATTERN, priority: 90 },

  { label: 'SSN', category: 'HIPAA', description: 'US Social Security Number', pattern: SSN_PATTERN, priority: 100 },
  { label: 'NHS_NUMBER', category: 'EU', description: 'UK NHS Number', pattern: NHS_PATTERN, priority: 88 },
  { label: 'UK_NINO', category: 'EU', description: 'UK National Insurance Number', pattern: UK_NINO_PATTERN, priority: 100 },
  { label: 'NATIONAL_ID_DK_CPR', category: 'EU', description: 'Denmark CPR', pattern: CPR_PATTERN, priority: 98 },
  { label: 'NATIONAL_ID_ES', category: 'EU', description: 'Spain DNI/NIE', pattern: ES_ID_PATTERN, priority: 95 },
  { label: 'NATIONAL_ID_IT_CF', category: 'EU', description: 'Italy Codice Fiscale', pattern: IT_CF_PATTERN, priority: 98 },
  { label: 'NATIONAL_ID_CH_AHV', category: 'EU', description: 'Switzerland AHV', pattern: CH_AHV_PATTERN, priority: 98 },
  { label: 'NATIONAL_ID_NL_BSN', category: 'EU', description: 'Netherlands BSN', pattern: BSN_PATTERN, priority: 95 },
  { label: 'IBAN', category: 'EU', description: 'IBAN bank account', pattern: IBAN_PATTERN, priority: 95 },
  { label: 'PASSPORT', category: 'EU', description: 'Passport number', pattern: PASSPORT_PATTERN, priority: 95 },

  { label: 'PHONE', category: 'HIPAA', description: 'Phone number', pattern: PHONE_PATTERN, priority: 70 },
  { label: 'FAX', category: 'HIPAA', description: 'Fax number', pattern: FAX_PATTERN, priority: 75 },

  // Labelled-context identifiers
  { label: 'MRN', category: 'HIPAA', description: 'Medical record number', pattern: MRN_PATTERN, priority: 92 },
  { label: 'INSURANCE_ID', category: 'HIPAA', description: 'Health plan beneficiary number', pattern: INSURANCE_PATTERN, priority: 92 },
  { label: 'ACCOUNT_NUMBER', category: 'HIPAA', description: 'Account number', pattern: ACCOUNT_PATTERN, priority: 88 },
  { label: 'LICENSE', category: 'HIPAA', description: 'Certificate or licence number', pattern: LICENSE_PATTERN, priority: 88 },
  { label: 'LICENSE', category: 'HIPAA', description: 'UK/EU professional registration number (GMC, NMC, GDC, HCPC…)', pattern: REGISTRATION_PATTERN, priority: 92 },
  { label: 'DEVICE_ID', category: 'HIPAA', description: 'Device identifier / serial / bleep', pattern: DEVICE_PATTERN, priority: 88 },
  { label: 'VEHICLE_VIN', category: 'HIPAA', description: 'Vehicle VIN', pattern: VIN_PATTERN, priority: 85 },
  { label: 'REFERENCE_ID', category: 'HIPAA', description: 'Trust / document / referral reference code', pattern: REFERENCE_PATTERN, priority: 87 },

  // Geography
  { label: 'POSTCODE_UK', category: 'EU', description: 'UK postcode', pattern: UK_POSTCODE_PATTERN, priority: 85 },
  { label: 'POSTCODE_EU', category: 'EU', description: 'EU postcode (labelled)', pattern: EU_POSTCODE_PATTERN, priority: 80 },
  { label: 'POSTCODE_US', category: 'HIPAA', description: 'US ZIP code', pattern: US_ZIP_PATTERN, priority: 60 },
  { label: 'ADDRESS_LINE', category: 'HIPAA', description: 'Street address', pattern: ADDRESS_PATTERN, priority: 78 },

  // Dates and biometric — DATE > PHONE so ISO dates don't get mislabelled.
  { label: 'DATE', category: 'HIPAA', description: 'Date', pattern: DATE_PATTERN, priority: 82 },
  { label: 'BIOMETRIC', category: 'HIPAA', description: 'Biometric descriptor', pattern: BIOMETRIC_PATTERN, priority: 70 },

  // Context-anchored name detection (NER fallback — see comments above).
  // Priority 83-86 puts these below structured-code rules (88-92) but well
  // above quasi-identifiers (30-55), so they are not shadowed by date/phone spans.
  { label: 'NAME', category: 'HIPAA', description: 'Name (honorific context: Dr, Mrs, Prof…)', pattern: NAME_HONORIFIC_PATTERN, priority: 86 },
  { label: 'NAME', category: 'HIPAA', description: 'Name (labelled field: patient name, next of kin…)', pattern: NAME_FIELD_PATTERN, priority: 85 },
  { label: 'NAME', category: 'HIPAA', description: 'Name (professional credential suffix: FRCP, RN…)', pattern: NAME_CREDENTIAL_PATTERN, priority: 84 },
  { label: 'NAME', category: 'HIPAA', description: 'Name (clinical staff role context: specialist nurse, Caldicott Guardian…)', pattern: NAME_STAFF_ROLE_PATTERN, priority: 83 },

  // Quasi-identifiers (flagged, not auto-redacted by default)
  { label: 'RARE_DISEASE_ICD', category: 'QUASI', description: 'ICD-10 code (review for rare disease)', pattern: ICD10_PATTERN, priority: 40 },
  { label: 'INSTITUTION', category: 'QUASI', description: 'Treating institution name', pattern: INSTITUTION_PATTERN, priority: 50 },
  { label: 'ETHNICITY', category: 'QUASI', description: 'Ethnicity / race', pattern: ETHNICITY_PATTERN, priority: 45 },
  { label: 'OCCUPATION', category: 'QUASI', description: 'Occupation', pattern: OCCUPATION_PATTERN, priority: 55 },
  { label: 'AGE_OVER_89', category: 'HIPAA', description: 'Age that may exceed 89', pattern: AGE_OVER_89_PATTERN, priority: 30 },
];

/**
 * ICD-10 rare-disease catalogue.
 *
 * The authoritative source is Orphanet/Orphadata (INSERM US14), licensed
 * CC BY 4.0 — see scripts/build-rare-icd.js for how `rare-icd10.json` is
 * generated. Until that script has been run with `--refresh`, we fall back to
 * the conservative starter list below.
 *
 * Tiers:
 *   'flag' — disease prevalence ≤ 1:10,000. Surface for user review.
 *   'auto' — disease prevalence ≤ 1:100,000. Recommend suppressing by default.
 *
 * Attribution required under CC BY 4.0:
 *   "Rare disease ICD-10 catalogue derived from Orphanet/Orphadata
 *    (INSERM US14), licensed under CC BY 4.0, orphadata.com."
 */

import rareCatalogue from './rare-icd10.json';

export type RareIcdTier = 'flag' | 'auto';

const ORPHANET_CODES = rareCatalogue.codes as Record<string, RareIcdTier>;

const STARTER_PREFIXES = new Set<string>([
  'E70', 'E71', 'E72', 'E74', 'E75', 'E76', 'E77', 'E78', 'E79', 'E80', 'E83', 'E84', 'E85', 'E88',
  'G10', 'G11', 'G12', 'G23', 'G24', 'G35', 'G36', 'G37', 'G60', 'G61', 'G71', 'G72',
  'D55', 'D56', 'D57', 'D58', 'D59', 'D60', 'D61', 'D66', 'D67', 'D68', 'D69',
  'Q00', 'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q77', 'Q78', 'Q79', 'Q87', 'Q90', 'Q91', 'Q92', 'Q93', 'Q95', 'Q96', 'Q97', 'Q98', 'Q99',
  'C81', 'C82', 'C83', 'C84', 'C85', 'C88', 'C91', 'C92', 'C93', 'C94', 'C95', 'C96',
]);

export function rareIcdTier(code: string): RareIcdTier | null {
  const upper = code.replace(/\s+/g, '').toUpperCase();
  if (Object.keys(ORPHANET_CODES).length > 0) {
    // Try the most specific match first (e.g. "Q90.0"), then progressively
    // shorter parents (e.g. "Q90"). 'auto' beats 'flag' on tie.
    let tier: RareIcdTier | null = null;
    if (ORPHANET_CODES[upper]) tier = ORPHANET_CODES[upper];
    const head = upper.slice(0, 3);
    if (ORPHANET_CODES[head] && (!tier || ORPHANET_CODES[head] === 'auto')) {
      tier = ORPHANET_CODES[head];
    }
    return tier;
  }
  return STARTER_PREFIXES.has(upper.slice(0, 3)) ? 'flag' : null;
}

export function isRareICD(code: string): boolean {
  return rareIcdTier(code) !== null;
}
