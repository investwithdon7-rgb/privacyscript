import { ENGINE_NAME, ENGINE_VERSION, type Mode } from '@/lib/constants';
import type { RiskAssessment } from '@/engine/risk';
import type { Span } from '@/engine/detect';
import rareCatalogue from '@/lib/rare-icd10.json';

export interface AuditLog {
  engine: string;
  engineVersion: string;
  timestamp: string;
  mode: Mode;
  inputFormat: string;
  inputSize: number;
  outputSize: number;
  spansFound: number;
  replacementsMade: number;
  riskLevel: string;
  kAnonymity: number;
  breakdown: RiskAssessment['breakdown'];
  validationPassed: boolean;
  /** Original text NEVER appears here — only labels and counts. */
  reasonsForRisk: string[];
  notes?: string[];
  /** Provenance for the rare-disease catalogue used in this run. */
  attribution: {
    rareIcdCatalogue: {
      source: 'Orphanet/Orphadata (INSERM US14)';
      licence: 'CC BY 4.0';
      url: 'https://www.orphadata.com';
      generatedAt: string;
    };
  };
}

interface BuildAuditLogInput {
  mode: Mode;
  inputFormat: string;
  inputSize: number;
  outputSize: number;
  detectedSpans: Span[];
  replacementsMade: number;
  risk: RiskAssessment;
  validationPassed: boolean;
  notes?: string[];
}

/**
 * Build the audit log JSON for a session. Contains no original identifier
 * values — only labels, counts, and risk metadata. Safe to share.
 */
export function buildAuditLog(input: BuildAuditLogInput): AuditLog {
  return {
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    mode: input.mode,
    inputFormat: input.inputFormat,
    inputSize: input.inputSize,
    outputSize: input.outputSize,
    spansFound: input.detectedSpans.length,
    replacementsMade: input.replacementsMade,
    riskLevel: input.risk.level,
    kAnonymity: input.risk.kAnonymity,
    breakdown: input.risk.breakdown,
    validationPassed: input.validationPassed,
    reasonsForRisk: input.risk.reasons,
    notes: input.notes,
    attribution: {
      rareIcdCatalogue: {
        source: 'Orphanet/Orphadata (INSERM US14)',
        licence: 'CC BY 4.0',
        url: 'https://www.orphadata.com',
        generatedAt: rareCatalogue.generatedAt,
      },
    },
  };
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJSON(data: unknown, filename: string): void {
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    filename
  );
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
