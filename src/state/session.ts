/**
 * In-memory session state. Holds the current job between screens.
 * Backed by a simple subscribe/emit store — no external library.
 *
 * Nothing here is persisted. Closing the tab clears everything.
 */

import type { Mode } from '@/lib/constants';
import type { ComplianceProfileId } from '@/lib/constants';
import type { RecordFormat } from '@/engine/ingest';
import type { DetectionResult } from '@/engine/detect';
import type { ReplacementResult } from '@/engine/replace';
import type { RiskAssessment } from '@/engine/risk';
import type { ValidationResult } from '@/engine/validate';
import type { AuditLog } from '@/engine/output';
import type { SessionSecret } from '@/engine/crypto';
import type { DocxOutputFormat } from '@/formats/docx';
import type { ScanProgress } from '@/formats/pdf-scanned';
import type {
  ComplianceJurisdiction,
  ComplianceReport,
} from '@/engine/compliance';

export interface SessionState {
  mode: Mode | null;
  complianceProfile: ComplianceProfileId;
  complianceJurisdiction: ComplianceJurisdiction;
  complianceCheck: ComplianceReport | null;
  uploadedFile: File | null;
  filename: string | null;
  format: RecordFormat | null;
  originalText: string | null;
  originalSize: number;
  detection: DetectionResult | null;
  quasiToRedact: Set<string>;
  /**
   * Per-span decisions for uncertain NER detections (confidence 0.5–0.85).
   * true = user confirmed (include in redaction), false = dismissed (skip).
   * Key = `${span.start}:${span.end}:${span.label}`.
   */
  uncertainSpanDecisions: Record<string, boolean>;
  /**
   * Spans the user manually added via the span editor.
   * These are merged into the active span list before the replace pass.
   */
  userAddedSpans: import('@/engine/detect').Span[];
  /**
   * Keys of detected spans the user manually dismissed (false-positive removal).
   * Key = `${span.start}:${span.end}:${span.label}`.
   */
  userDismissedSpanKeys: Set<string>;
  replacement: ReplacementResult | null;
  risk: RiskAssessment | null;
  validation: ValidationResult | null;
  audit: AuditLog | null;
  secret: SessionSecret | null;
  /** For FHIR / HL7 reconstruction: the original parsed structure. */
  parsedOriginal: unknown;
  /** Reconstructed de-identified output in original format (text formats). */
  deidentifiedOutput: string | null;
  /** Binary output (PDF / DOCX). */
  deidentifiedBytes: Uint8Array | null;
  /** Source bytes for binary formats (held in memory only for re-render). */
  sourceBytes: ArrayBuffer | null;
  /** DOCX output format choice on screen 4. */
  docxFormat: DocxOutputFormat;
  /** Live scanned-PDF OCR progress (PDF_SCANNED ingest only). */
  scanProgress: ScanProgress | null;
  /** Progress within the 6 pipeline stages, 0–6. */
  stageIndex: number;
  /** True once user has confirmed quasi-identifier handling on screen 2. */
  quasiConfirmed: boolean;
  error: string | null;
}

const INITIAL: SessionState = {
  mode: null,
  complianceProfile: 'GDPR_PSEUDO',
  complianceJurisdiction: 'GENERAL',
  complianceCheck: null,
  uploadedFile: null,
  filename: null,
  format: null,
  originalText: null,
  originalSize: 0,
  detection: null,
  quasiToRedact: new Set(),
  uncertainSpanDecisions: {},
  userAddedSpans: [],
  userDismissedSpanKeys: new Set(),
  replacement: null,
  risk: null,
  validation: null,
  audit: null,
  secret: null,
  parsedOriginal: null,
  deidentifiedOutput: null,
  deidentifiedBytes: null,
  sourceBytes: null,
  docxFormat: 'DOCX',
  scanProgress: null,
  stageIndex: 0,
  quasiConfirmed: false,
  error: null,
};

let state: SessionState = { ...INITIAL };
const listeners = new Set<(s: SessionState) => void>();

export function getSession(): SessionState {
  return state;
}

export function updateSession(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function resetSession(): void {
  state = {
    ...INITIAL,
    quasiToRedact: new Set(),
    uncertainSpanDecisions: {},
    userAddedSpans: [],
    userDismissedSpanKeys: new Set(),
    complianceCheck: null,
    uploadedFile: null,
  };
  for (const l of listeners) l(state);
}

export function subscribe(fn: (s: SessionState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
