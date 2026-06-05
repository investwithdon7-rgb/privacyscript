export const ENGINE_VERSION = '0.2.0';
export const ENGINE_NAME = 'PrivacyScript by TekDruid';

export const K_ANONYMITY_THRESHOLD = 5;

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const MODES = ['PSEUDONYMISE', 'ANONYMISE'] as const;
export type Mode = (typeof MODES)[number];

export const ACCEPTED_FORMATS = [
  '.txt',
  '.json',
  '.hl7',
  '.pdf',
  '.docx',
] as const;

export const PIPELINE_STAGES = [
  'INGEST',
  'DETECT',
  'REPLACE',
  'RISK_SCORE',
  'VALIDATE',
  'OUTPUT',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// PBKDF2 / AES-GCM parameters for the re-identification key file.
export const KEY_FILE_PARAMS = {
  pbkdf2Iterations: 600_000,
  saltBytes: 16,
  ivBytes: 12,
  aesKeyBits: 256,
  hash: 'SHA-256' as const,
};

export const NER_MODELS = {
  clinical: 'd4data/biomedical-ner-all',
  generic: 'Xenova/bert-base-NER',
};

// ─── Compliance Profiles ───────────────────────────────────────────────────
// Each profile pre-configures the k-anonymity threshold, date handling mode,
// and whether quasi-identifiers are fully suppressed. The user selects one
// during Step 1 (landing page). Defaults to GDPR_PSEUDO (loosest setting
// compatible with GDPR pseudonymisation).

export type DateHandling = 'shift' | 'year_only' | 'suppress';

export interface ComplianceProfileDef {
  id: ComplianceProfileId;
  label: string;
  regulation: string;
  description: string;
  kThreshold: number;
  dateHandling: DateHandling;
  /** If true: all quasi-identifier types are auto-added to the redact set. */
  suppressAllQuasi: boolean;
  /** Recommended mode for this profile. */
  recommendedMode: Mode;
}

export const COMPLIANCE_PROFILE_IDS = [
  'HIPAA_SAFE_HARBOR',
  'HIPAA_EXPERT',
  'GDPR_PSEUDO',
  'GDPR_ANON',
  'EHDS_SECONDARY',
] as const;
export type ComplianceProfileId = (typeof COMPLIANCE_PROFILE_IDS)[number];

export const COMPLIANCE_PROFILES: Record<ComplianceProfileId, ComplianceProfileDef> = {
  HIPAA_SAFE_HARBOR: {
    id: 'HIPAA_SAFE_HARBOR',
    label: 'HIPAA Safe Harbor',
    regulation: '45 CFR §164.514(b)',
    description: 'Removes all 18 HIPAA identifiers. Dates generalised to year only.',
    kThreshold: 5,
    dateHandling: 'year_only',
    suppressAllQuasi: true,
    recommendedMode: 'ANONYMISE',
  },
  HIPAA_EXPERT: {
    id: 'HIPAA_EXPERT',
    label: 'HIPAA Expert Determination',
    regulation: '45 CFR §164.514(b)(1)',
    description: 'Statistical expert certifies very small re-identification risk. Stricter k = 10.',
    kThreshold: 10,
    dateHandling: 'suppress',
    suppressAllQuasi: true,
    recommendedMode: 'ANONYMISE',
  },
  GDPR_PSEUDO: {
    id: 'GDPR_PSEUDO',
    label: 'GDPR Pseudonymisation',
    regulation: 'GDPR Article 4(5)',
    description: 'Direct identifiers replaced with pseudonyms. Dates shifted. Data stays personal.',
    kThreshold: 5,
    dateHandling: 'shift',
    suppressAllQuasi: false,
    recommendedMode: 'PSEUDONYMISE',
  },
  GDPR_ANON: {
    id: 'GDPR_ANON',
    label: 'GDPR Anonymisation',
    regulation: 'GDPR Recital 26',
    description: 'Irreversible removal. No key file. Suitable for open publication.',
    kThreshold: 5,
    dateHandling: 'year_only',
    suppressAllQuasi: true,
    recommendedMode: 'ANONYMISE',
  },
  EHDS_SECONDARY: {
    id: 'EHDS_SECONDARY',
    label: 'EHDS Secondary Use',
    regulation: 'Regulation (EU) 2025/327',
    description: 'European Health Data Space secondary use. All PHI suppressed. Dates year-only.',
    kThreshold: 5,
    dateHandling: 'year_only',
    suppressAllQuasi: true,
    recommendedMode: 'ANONYMISE',
  },
};

export const DEFAULT_COMPLIANCE_PROFILE: ComplianceProfileId = 'GDPR_PSEUDO';
