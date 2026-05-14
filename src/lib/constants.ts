export const ENGINE_VERSION = '0.1.0';
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
