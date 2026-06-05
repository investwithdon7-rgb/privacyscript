import type { DetectionResult, Span } from '@/engine/detect';
import { ENGINE_NAME, ENGINE_VERSION } from '@/lib/constants';

export type ComplianceJurisdiction = 'EU' | 'UK' | 'US' | 'GENERAL';
export type ComplianceVerdict =
  | 'SAFE'
  | 'NEEDS_DEIDENTIFICATION'
  | 'DO_NOT_UPLOAD';
export type ComplianceSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type ComplianceAction = 'NONE' | 'ANONYMISE' | 'PSEUDONYMISE';

export interface ComplianceSafetyConclusion {
  safe: boolean;
  label: string;
  description: string;
}

export interface ComplianceFinding {
  label: string;
  count: number;
  severity: ComplianceSeverity;
  concern: string;
  valueHidden: true;
  values: string[];
  contexts: string[];
}

export interface ComplianceReport {
  engine: string;
  engineVersion: string;
  timestamp: string;
  jurisdiction: ComplianceJurisdiction;
  jurisdictionLabel: string;
  verdict: ComplianceVerdict;
  verdictLabel: string;
  verdictDescription: string;
  distributionSafety: ComplianceSafetyConclusion;
  aiUploadSafety: ComplianceSafetyConclusion;
  findings: ComplianceFinding[];
  healthDataDetected: boolean;
  recommendedPrimaryAction: ComplianceAction;
  recommendedActions: ComplianceAction[];
  notes: string[];
}

export interface ShareSafeComplianceReport
  extends Omit<ComplianceReport, 'findings'> {
  findings: Array<Omit<ComplianceFinding, 'values' | 'contexts'>>;
}

interface AssessComplianceInput {
  jurisdiction: ComplianceJurisdiction;
  text: string;
  detection: DetectionResult;
}

const JURISDICTION_LABELS: Record<ComplianceJurisdiction, string> = {
  EU: 'EU: GDPR + EU AI Act + EHDS',
  UK: 'UK: UK GDPR + DPA 2018 + ICO guidance',
  US: 'US: HIPAA + AI processor caution',
  GENERAL: 'General / International AI upload safety',
};

const STRONG_IDENTIFIER_LABELS = new Set<string>([
  'NAME',
  'MRN',
  'NHS_NUMBER',
  'SSN',
  'UK_NINO',
  'NATIONAL_ID_DK_CPR',
  'NATIONAL_ID_NL_BSN',
  'NATIONAL_ID_ES',
  'NATIONAL_ID_IT_CF',
  'NATIONAL_ID_CH_AHV',
  'PASSPORT',
  'IBAN',
  'INSURANCE_ID',
  'ACCOUNT_NUMBER',
]);

const HIGH_SEVERITY_LABELS = new Set<string>([
  ...STRONG_IDENTIFIER_LABELS,
  'RARE_DISEASE_ICD',
  'BIOMETRIC',
]);

const MEDIUM_SEVERITY_LABELS = new Set<string>([
  'EMAIL',
  'PHONE',
  'FAX',
  'DATE',
  'ADDRESS_LINE',
  'POSTCODE_UK',
  'POSTCODE_US',
  'POSTCODE_EU',
  'INSTITUTION',
  'OCCUPATION',
  'ETHNICITY',
  'DEVICE_ID',
  'REFERENCE_ID',
  'LICENSE',
]);

const HEALTH_CONTEXT_RE =
  /\b(?:patient|diagnos(?:is|ed)|condition|symptom|clinic|clinical|treatment|therapy|medicine|medication|prescription|dose|surgery|admission|discharge|ward|consultant|doctor|nurse|hospital|mrn|nhs|diabetes|cancer|asthma|hypertension|infection|disease|icd-?10|lab|blood|scan|x-?ray|mri|ct)\b/i;

export function assessCompliance(
  input: AssessComplianceInput
): ComplianceReport {
  const allSpans = [...input.detection.spans, ...input.detection.quasiSpans];
  const findings = buildFindings(allSpans, input.text, input.jurisdiction);
  const hasDirectIdentifiers = input.detection.spans.length > 0;
  const hasStrongIdentifier = input.detection.spans.some((s) =>
    STRONG_IDENTIFIER_LABELS.has(s.label)
  );
  const hasHighRiskQuasi = input.detection.quasiSpans.some((s) =>
    s.label === 'RARE_DISEASE_ICD'
  );
  const healthDataDetected =
    HEALTH_CONTEXT_RE.test(input.text) ||
    hasHighRiskQuasi ||
    input.detection.quasiSpans.some((s) =>
      ['ETHNICITY', 'INSTITUTION', 'OCCUPATION'].includes(s.label)
    );

  let verdict: ComplianceVerdict;
  if (findings.length === 0 && !healthDataDetected) {
    verdict = 'SAFE';
  } else if (hasHighRiskQuasi || (healthDataDetected && hasStrongIdentifier)) {
    verdict = 'DO_NOT_UPLOAD';
  } else if (healthDataDetected && hasDirectIdentifiers) {
    verdict = 'DO_NOT_UPLOAD';
  } else {
    verdict = 'NEEDS_DEIDENTIFICATION';
  }

  const aiUnsafe = verdict !== 'SAFE' || healthDataDetected || hasDirectIdentifiers;
  const distributionUnsafe = verdict !== 'SAFE';
  const primaryAction: ComplianceAction = aiUnsafe ? 'ANONYMISE' : 'NONE';

  return {
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    jurisdiction: input.jurisdiction,
    jurisdictionLabel: JURISDICTION_LABELS[input.jurisdiction],
    verdict,
    verdictLabel: labelForVerdict(verdict),
    verdictDescription: descriptionForVerdict(verdict),
    distributionSafety: {
      safe: !distributionUnsafe,
      label: distributionUnsafe ? 'Not safe for distribution' : 'Appears safe for distribution',
      description: distributionUnsafe
        ? 'Personal or health-related data was detected. De-identify before sharing outside a controlled workflow.'
        : 'No obvious personal or health identifiers were found. Review manually before sharing.',
    },
    aiUploadSafety: {
      safe: !aiUnsafe,
      label: aiUnsafe ? 'Not safe for AI upload' : 'Appears safe for AI upload',
      description: aiUnsafe
        ? aiUnsafeDescription(input.jurisdiction)
        : 'No obvious personal or health identifiers were found. Confirm the document manually before upload.',
    },
    findings,
    healthDataDetected,
    recommendedPrimaryAction: primaryAction,
    recommendedActions:
      primaryAction === 'NONE' ? ['NONE'] : ['ANONYMISE', 'PSEUDONYMISE'],
    notes: notesFor(input.jurisdiction, verdict, healthDataDetected),
  };
}

export function buildShareSafeComplianceReport(
  report: ComplianceReport
): ShareSafeComplianceReport {
  return {
    ...report,
    findings: report.findings.map(({ values: _values, contexts: _contexts, ...f }) => f),
  };
}

function buildFindings(
  spans: Span[],
  text: string,
  jurisdiction: ComplianceJurisdiction
): ComplianceFinding[] {
  const grouped = new Map<string, Span[]>();
  for (const span of spans) {
    if (!grouped.has(span.label)) grouped.set(span.label, []);
    grouped.get(span.label)!.push(span);
  }

  return Array.from(grouped.entries())
    .map(([label, group]) => ({
      label,
      count: group.length,
      severity: severityFor(label),
      concern: concernFor(label, jurisdiction),
      valueHidden: true as const,
      values: unique(group.map((s) => s.text)).slice(0, 10),
      contexts: group.map((s) => contextFor(text, s)).slice(0, 5),
    }))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityFor(label: string): ComplianceSeverity {
  if (HIGH_SEVERITY_LABELS.has(label)) return 'HIGH';
  if (MEDIUM_SEVERITY_LABELS.has(label)) return 'MEDIUM';
  return 'LOW';
}

function severityRank(severity: ComplianceSeverity): number {
  return severity === 'HIGH' ? 3 : severity === 'MEDIUM' ? 2 : 1;
}

function concernFor(label: string, jurisdiction: ComplianceJurisdiction): string {
  if (label === 'RARE_DISEASE_ICD') {
    return 'Rare disease information can identify a person even after direct identifiers are removed.';
  }
  if (STRONG_IDENTIFIER_LABELS.has(label)) {
    return jurisdiction === 'US'
      ? 'Strong PHI identifier under HIPAA-style sharing rules.'
      : 'Strong personal-data identifier under the selected profile.';
  }
  if (label === 'DATE') {
    return 'Dates can identify patients when combined with care events or location.';
  }
  if (label.startsWith('POSTCODE') || label === 'ADDRESS_LINE') {
    return 'Location data can identify people when combined with health context.';
  }
  if (['ETHNICITY', 'OCCUPATION', 'INSTITUTION'].includes(label)) {
    return 'Quasi-identifier that can re-identify a person in combination.';
  }
  return 'Potential personal or sensitive data detected.';
}

function labelForVerdict(verdict: ComplianceVerdict): string {
  switch (verdict) {
    case 'SAFE':
      return 'Safe';
    case 'NEEDS_DEIDENTIFICATION':
      return 'Needs de-identification';
    case 'DO_NOT_UPLOAD':
      return 'Do not upload/share';
  }
}

function descriptionForVerdict(verdict: ComplianceVerdict): string {
  switch (verdict) {
    case 'SAFE':
      return 'No obvious personal or health identifiers were found. Review the document manually before sharing.';
    case 'NEEDS_DEIDENTIFICATION':
      return 'This document contains personal or health information. De-identify it before distribution or AI upload.';
    case 'DO_NOT_UPLOAD':
      return 'This document appears unsafe to share or upload to AI unless you have a compliant legal basis and processor agreement.';
  }
}

function aiUnsafeDescription(jurisdiction: ComplianceJurisdiction): string {
  switch (jurisdiction) {
    case 'EU':
      return 'Identifiable health or personal data was detected. AI upload is unsafe unless GDPR, EU AI Act, EHDS, and processor obligations are satisfied.';
    case 'UK':
      return 'Identifiable health or personal data was detected. AI upload is unsafe unless UK GDPR/DPA obligations and processor arrangements are satisfied.';
    case 'US':
      return 'PHI or identifiers were detected. AI upload is unsafe unless the recipient is covered by a suitable compliant arrangement such as a BAA.';
    case 'GENERAL':
      return 'Personal or health-related data was detected. Use anonymisation before AI upload unless you have a compliant processor arrangement.';
  }
}

function notesFor(
  jurisdiction: ComplianceJurisdiction,
  verdict: ComplianceVerdict,
  healthDataDetected: boolean
): string[] {
  const notes = [
    'This screening is not legal advice. It is a conservative client-side risk check.',
  ];
  if (healthDataDetected) {
    notes.push('Health-data context was detected or inferred from the document.');
  }
  if (verdict !== 'SAFE') {
    notes.push('Recommended next step: de-identify the document before sharing.');
  }
  notes.push(`Profile used: ${JURISDICTION_LABELS[jurisdiction]}.`);
  return notes;
}

function contextFor(text: string, span: Span): string {
  const start = Math.max(0, span.start - 36);
  const end = Math.min(text.length, span.end + 36);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
