/**
 * Batch de-identification for research studies (many interviews / notes).
 *
 * Two phases, so a person reviews before anything is released:
 *
 *  1. prepareFile  — ingest + detect every file; transcripts get their
 *                    speakers and context-flagged passages.
 *     assignStudySpeakers (transcript.ts) then gives each named speaker ONE
 *     label across the whole study.
 *  2. finaliseFile — after the user has decided on every flagged passage:
 *                    replace (with a study-wide label registry, so "[Person
 *                    3]" is the same person in every file), rebuild the
 *                    output, validate THE OUTPUT ITSELF, score risk, and hold
 *                    the file back if it fails a non-negotiable check.
 *
 * Formats that need their own review screen (surveys: column plan; PDFs:
 * page pipeline; DICOM) are skipped with a plain reason, never faked.
 */

import { detect, type DetectionResult, type Span } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { assessRisk, type RiskAssessment } from '@/engine/risk';
import { validate, type ValidationResult } from '@/engine/validate';
import { buildAuditLog, type AuditLog } from '@/engine/output';
import { detectFormat, readFileAsText, type RecordFormat } from '@/engine/ingest';
import type { SessionSecret } from '@/engine/crypto';
import {
  analyseTranscript,
  contextualFlags,
  detectTranscript,
  passageSpan,
  transcriptLabeller,
  type ContextFlag,
  type LabelRegistry,
  type TranscriptInfo,
} from '@/engine/transcript';
import { COMPLIANCE_PROFILES, type ComplianceProfileId, type Mode } from '@/lib/constants';

export type NerRunner = (text: string) => Promise<Span[]>;

export interface PreparedFile {
  id: string;
  name: string;
  size: number;
  format: RecordFormat;
  /** Set when the file cannot be handled in batch; shown to the user. */
  skipReason?: string;
  text: string;
  detection?: DetectionResult;
  transcript?: { info: TranscriptInfo; flags: ContextFlag[] };
  /** Original bytes for DOCX in-place rebuild. */
  docxBytes?: ArrayBuffer;
}

export interface FinalisedFile {
  id: string;
  name: string;
  outputName: string;
  output: string | Uint8Array;
  mime: string;
  audit: AuditLog;
  risk: RiskAssessment;
  validation: ValidationResult;
  mapping: Record<string, string>;
  /** Why the file is NOT released (validation failure, k below threshold). */
  heldBack?: string;
}

const SKIP_REASONS: Partial<Record<RecordFormat, string>> = {
  CSV: 'Surveys and spreadsheets need their column review. Open this file on its own.',
  PDF_TYPED: 'PDFs go through the page-by-page pipeline. Open this file on its own.',
  PDF_SCANNED: 'PDFs go through the page-by-page pipeline. Open this file on its own.',
  DICOM: 'DICOM images need the imaging pipeline. Open this file on its own.',
};

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/** Phase 1: ingest and detect one file. Never throws for unsupported types. */
export async function prepareFile(file: File, id: string, ner: NerRunner): Promise<PreparedFile> {
  const ext = extensionOf(file.name);
  const format: RecordFormat =
    ext === 'xlsx' ? 'CSV' : detectFormat(file.name, await file.slice(0, 4096).text().catch(() => ''));
  const base = { id, name: file.name, size: file.size, format, text: '' };
  const skip = SKIP_REASONS[format];
  if (skip) return { ...base, skipReason: skip };

  let text: string;
  let docxBytes: ArrayBuffer | undefined;
  if (format === 'DOCX') {
    docxBytes = await file.arrayBuffer();
    const { ingestDocx } = await import('@/formats/docx');
    text = (await ingestDocx(docxBytes)).text;
  } else {
    text = await readFileAsText(file);
  }

  const nerSpans = await ner(text);
  const info = format === 'TEXT' || format === 'DOCX' ? analyseTranscript(text) : null;
  if (info) {
    return {
      ...base,
      text,
      docxBytes,
      detection: detectTranscript(text, info, nerSpans),
      transcript: { info, flags: contextualFlags(text, info) },
    };
  }
  return { ...base, text, docxBytes, detection: detect(text, nerSpans) };
}

export interface FinaliseOptions {
  mode: Mode;
  profileId: ComplianceProfileId;
  secret?: SessionSecret;
  /** Readable labels ("[Person 1]") for transcripts. */
  readable: boolean;
  /** Flag id → decision for THIS file's flags. */
  decisions: Record<number, 'keep' | 'remove'>;
  /** Shared across the batch for study-wide numbering. */
  registry: LabelRegistry;
  ner?: NerRunner;
}

const TEXT_MIME: Record<string, string> = {
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  json: 'application/json',
  hl7: 'application/hl7-v2',
  md: 'text/markdown',
};

/** Phase 2: replace, rebuild, validate the real output, score, decide release. */
export async function finaliseFile(p: PreparedFile, opts: FinaliseOptions): Promise<FinalisedFile> {
  if (!p.detection) throw new Error(`${p.name} was not prepared.`);
  const profile = COMPLIANCE_PROFILES[opts.profileId];
  const { detection } = p;

  const quasiToRedact = new Set<string>(
    profile.suppressAllQuasi || opts.mode === 'ANONYMISE'
      ? detection.quasiSpans.map((q) => q.label)
      : detection.quasiSpans
          .filter((q) => q.label === 'RARE_DISEASE_ICD' && q.rareTier === 'auto')
          .map((q) => q.label)
  );

  const removed = p.transcript
    ? p.transcript.flags.filter((f) => opts.decisions[f.id] === 'remove')
    : [];
  const spans = [...detection.spans, ...removed.map((f) => passageSpan(p.text, f))];

  const replacement = await replaceSpans(p.text, spans, detection.quasiSpans, {
    mode: opts.mode,
    secret: opts.secret,
    quasiToRedact,
    labeller: p.transcript
      ? transcriptLabeller(p.transcript.info, opts.readable, removed.map((f) => f.text), opts.registry)
      : undefined,
  });

  // Rebuild the output, then validate what will actually be released.
  const ext = extensionOf(p.name);
  let output: string | Uint8Array;
  let outputText: string;
  let mime: string;
  let outExt: string;
  if (p.format === 'DOCX' && p.docxBytes) {
    const { rebuildDocxInPlace, ingestDocx } = await import('@/formats/docx');
    output = await rebuildDocxInPlace(p.docxBytes, replacement.mapping);
    outputText = (await ingestDocx(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer)).text;
    mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    outExt = 'docx';
  } else {
    output = replacement.text;
    outputText = replacement.text;
    outExt = ext || 'txt';
    mime = TEXT_MIME[outExt] ?? 'text/plain';
  }

  const validation = await validate(outputText, {
    mode: opts.mode,
    originalIdentifiers: Object.keys(replacement.mapping),
    nerRunner: opts.ner,
  });

  const retainedQuasi = detection.quasiSpans.filter((q) => !quasiToRedact.has(q.label));
  const risk = assessRisk({
    detectedSpans: detection.spans,
    retainedQuasiSpans: retainedQuasi,
    recordCount: 1,
    kThreshold: profile.kThreshold,
  });

  let heldBack: string | undefined;
  if (!validation.passed) {
    heldBack = `Original identifiers still appear in the output (${validation.originalsLeaked.length}). Open this file on its own to fix it.`;
  } else if (opts.mode === 'ANONYMISE' && risk.kAnonymity < profile.kThreshold) {
    heldBack = `Too identifiable to count as anonymous (k = ${risk.kAnonymity}, needs ${profile.kThreshold}).`;
  }

  const notes: string[] = [];
  if (p.transcript) {
    const decided = Object.values(opts.decisions);
    notes.push(
      `Transcript: ${p.transcript.info.kindLabel}; ${p.transcript.info.speakers.filter((s) => s.isName).length} speaker names replaced with study-wide role labels.`,
      `Passages flagged for possible identification by context: ${p.transcript.flags.length}; reviewed by user: removed ${decided.filter((d) => d === 'remove').length}, kept ${decided.filter((d) => d === 'keep').length}.`
    );
  }
  if (heldBack) notes.push(`Held back: ${heldBack}`);

  const audit = buildAuditLog({
    mode: opts.mode,
    inputFormat: p.format,
    inputSize: p.size,
    outputSize: typeof output === 'string' ? output.length : output.byteLength,
    detectedSpans: detection.spans,
    replacementsMade: replacement.replacements.length,
    risk,
    validationPassed: validation.passed,
    complianceProfile: opts.profileId,
    notes,
  });

  return {
    id: p.id,
    name: p.name,
    outputName: `${p.name.replace(/\.[^.]+$/, '')}.deidentified.${outExt}`,
    output,
    mime,
    audit,
    risk,
    validation,
    mapping: replacement.mapping,
    heldBack,
  };
}
