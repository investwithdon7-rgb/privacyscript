'use client';

import { detect } from '@/engine/detect';
import { runClinicalNER } from '@/engine/ner';
import { replaceSpans, type ReplacementResult } from '@/engine/replace';
import { assessRisk } from '@/engine/risk';
import { validate } from '@/engine/validate';
import { buildAuditLog } from '@/engine/output';
import { detectFormat, readFileAsText, type RecordFormat } from '@/engine/ingest';
import { parseFhir, reconstructFhir } from '@/formats/fhir';
import { parseHL7, reconstructHL7, type HL7Leaf } from '@/formats/hl7';
import type { DocxIngestResult } from '@/formats/docx';
import type { PdfIngest, PdfRedaction } from '@/formats/pdf-typed';
import type { CsvIngest, CsvLeaf } from '@/formats/csv';
import type { ScannedPdfIngest, ScannedRedaction, ScanProgress } from '@/formats/pdf-scanned';
import { generateSessionSecret } from '@/engine/crypto';
import {
  COMPLIANCE_PROFILES,
  K_ANONYMITY_THRESHOLD,
  type ComplianceProfileId,
  type Mode,
} from '@/lib/constants';
import {
  assessCompliance,
  type ComplianceJurisdiction,
} from '@/engine/compliance';
import { getSession, updateSession } from '@/state/session';

/**
 * Non-printable U+001F UNIT SEPARATOR. Used as the leaf delimiter when we
 * synthesise a flat text body from a structured input. No regex rule in the
 * catalogue matches across this character, so spans cannot leak between
 * leaves.
 */
const LEAF_DELIM = '\u001F';

/**
 * Run the ingest + detect stages for a staged file. Pipeline is split here so
 * the user can review quasi-identifiers on Screen 2 before stages 3-6 run.
 */
export async function ingestAndDetect(file: File): Promise<void> {
  updateSession({ error: null, stageIndex: 0 });
  try {
    const format = detectInitialFormat(file);

    // Stage 1: INGEST
    // Re-detect format now that we can read a content preview.
    // (detectInitialFormat returns a fast extension-only guess so the process
    //  page can render immediately; we confirm the real format here before
    //  the switch.)
    const confirmedFormat = await confirmFormat(file, format);

    let text: string;
    let parsedOriginal: unknown = null;
    let sourceBytes: ArrayBuffer | null = null;

    switch (confirmedFormat) {
      case 'FHIR_R4': {
        const raw = await readFileAsText(file);
        const { resource, leaves } = parseFhir(raw);
        parsedOriginal = { resource, leaves };
        text = leaves.map((l) => l.value).join(LEAF_DELIM);
        break;
      }
      case 'HL7_V2': {
        const raw = await readFileAsText(file);
        const { doc, leaves } = parseHL7(raw);
        parsedOriginal = { doc, leaves };
        text = leaves.map((l) => l.value).join(LEAF_DELIM);
        break;
      }
      case 'TEXT': {
        text = await readFileAsText(file);
        break;
      }
      case 'DOCX': {
        sourceBytes = await file.arrayBuffer();
        const { ingestDocx } = await import('@/formats/docx');
        const docxResult = await ingestDocx(sourceBytes);
        parsedOriginal = docxResult;
        text = docxResult.text;
        break;
      }
      case 'PDF_TYPED': {
        sourceBytes = await file.arrayBuffer();
        const { ingestPdf } = await import('@/formats/pdf-typed');
        const typedResult = await ingestPdf(sourceBytes);

        // Heuristic: scanned PDFs return very little text per page.
        // A document is treated as scanned only when ALL of:
        //   - at least one page has some content to compare
        //   - average chars/page < 60  (almost no text layer on average)
        //   - max chars on any single page < 120 (no page has meaningful text)
        // Without the maxPerPage guard a mixed document (cover page with a title
        // + pure-scan pages) would incorrectly fall through to OCR.
        const textLengths = typedResult.pages.map((p) => p.text.trim().length);
        const avgPerPage =
          typedResult.pages.length === 0
            ? 0
            : textLengths.reduce((s, l) => s + l, 0) / typedResult.pages.length;
        const maxPerPage = textLengths.reduce((m, l) => Math.max(m, l), 0);
        const hasAnyContent = textLengths.some((l) => l > 0);

        if (hasAnyContent && avgPerPage < 60 && maxPerPage < 120) {
          // Treat as scanned.
          const { ingestScannedPdf } = await import('@/formats/pdf-scanned');
          const onProg = (p: ScanProgress) => {
            updateSession({
              scanProgress: p,
            });
          };
          const { result: scanned } = await ingestScannedPdf(
            sourceBytes,
            onProg
          );
          parsedOriginal = scanned;
          text = scanned.fullText;
          updateSession({ format: 'PDF_SCANNED' });
        } else {
          parsedOriginal = typedResult;
          text = typedResult.fullText;
        }
        break;
      }
      case 'CSV': {
        const raw = await readFileAsText(file);
        const { parseCsv } = await import('@/formats/csv');
        const csv = parseCsv(raw);
        parsedOriginal = csv;
        text = csv.leaves.map((l) => l.value).join(LEAF_DELIM);
        break;
      }
      case 'PDF_SCANNED': {
        // Direct route — user uploaded a known scanned PDF or the typed path
        // detected one and re-routed (handled above).
        sourceBytes = await file.arrayBuffer();
        const { ingestScannedPdf } = await import('@/formats/pdf-scanned');
        const onProg = (p: ScanProgress) => {
          updateSession({ scanProgress: p });
        };
        const { result: scanned } = await ingestScannedPdf(sourceBytes, onProg);
        parsedOriginal = scanned;
        text = scanned.fullText;
        break;
      }
      case 'DICOM': {
        // DICOM: we de-identify at the tag level first (ps3.15 Annex E), then
        // also run NER on the extracted tag text values as a second-pass catch.
        sourceBytes = await file.arrayBuffer();
        const { deidentifyDicom } = await import('@/formats/dicom');
        const dicomResult = await deidentifyDicom(sourceBytes);
        // The cleaned bytes become the output for the binary download.
        parsedOriginal = dicomResult;
        // Build a text representation for NER detection (values were already blanked,
        // so the text here is used only to surface what WAS in the file pre-clean).
        // We extract readable text from the ORIGINAL buffer for the detect pass.
        const { default: dicomParser } = await import('dicom-parser');
        const origBuf = new Uint8Array(sourceBytes);
        let dicomText = '';
        try {
          const ds = dicomParser.parseDicom(origBuf);
          const TAG_NAMES: Record<string, string> = {
            '00100010': 'PatientName', '00100020': 'PatientID',
            '00100030': 'PatientBirthDate', '00100040': 'PatientSex',
            '00080080': 'InstitutionName', '00080090': 'ReferringPhysicianName',
            '00101040': 'PatientAddress', '00102160': 'EthnicGroup',
          };
          const lines: string[] = [];
          for (const [tag, name] of Object.entries(TAG_NAMES)) {
            try {
              const val = ds.string(`x${tag}`);
              if (val) lines.push(`${name}: ${val}`);
            } catch { /* tag absent */ }
          }
          dicomText = lines.join('\n') || '(no readable tags)';
        } catch { dicomText = '(DICOM parse error)'; }
        // Store cleaned bytes for download; detect on original tag text.
        sourceBytes = dicomResult.bytes.buffer;
        text = dicomText;
        break;
      }
      default:
        throw new Error(`Unknown format for ${file.name}.`);
    }

    updateSession({
      filename: file.name,
      format: confirmedFormat,
      originalText: text,
      originalSize: file.size,
      parsedOriginal,
      sourceBytes,
      stageIndex: 1,
    });

    // Stage 2: DETECT
    const nerSpans = await runClinicalNER(text);
    const detection = detect(text, nerSpans);

    // Default-on suppression for quasi-identifiers.
    const autoRedact = new Set<string>();
    const session = getSession();
    const { COMPLIANCE_PROFILES } = await import('@/lib/constants');
    const profile = COMPLIANCE_PROFILES[session.complianceProfile ?? 'GDPR_PSEUDO'];

    if (profile?.suppressAllQuasi) {
      for (const q of detection.quasiSpans) {
        autoRedact.add(q.label);
      }
    } else {
      for (const q of detection.quasiSpans) {
        if (q.label === 'RARE_DISEASE_ICD' && q.rareTier === 'auto') {
          autoRedact.add('RARE_DISEASE_ICD');
        }
      }
    }

    updateSession({
      detection,
      quasiToRedact: autoRedact,
      stageIndex: 2,
    });
  } catch (err) {
    updateSession({ error: (err as Error).message });
  }
}

export async function runComplianceCheck(
  file: File,
  jurisdiction: ComplianceJurisdiction
): Promise<void> {
  updateSession({
    mode: null,
    complianceJurisdiction: jurisdiction,
    complianceCheck: null,
    uploadedFile: file,
    filename: file.name,
    format: null,
    originalText: null,
    originalSize: 0,
    detection: null,
    parsedOriginal: null,
    sourceBytes: null,
    scanProgress: null,
    quasiConfirmed: false,
    quasiToRedact: new Set(),
    uncertainSpanDecisions: {},
    userAddedSpans: [],
    userDismissedSpanKeys: new Set(),
    replacement: null,
    risk: null,
    validation: null,
    audit: null,
    deidentifiedOutput: null,
    deidentifiedBytes: null,
    error: null,
  });

  await ingestAndDetect(file);

  const s = getSession();
  if (s.error || !s.detection || s.originalText === null) return;

  const complianceCheck = assessCompliance({
    jurisdiction,
    text: s.originalText,
    detection: s.detection,
  });

  updateSession({
    complianceJurisdiction: jurisdiction,
    complianceCheck,
    stageIndex: 2,
  });
}

export async function startDeidentificationFromCompliance(
  mode: Mode
): Promise<void> {
  const s = getSession();
  if (!s.detection || s.originalText === null) return;

  const complianceProfile = profileForComplianceAction(
    s.complianceJurisdiction,
    mode
  );
  const profile = COMPLIANCE_PROFILES[complianceProfile];
  const quasiToRedact = new Set<string>();

  if (profile.suppressAllQuasi || mode === 'ANONYMISE') {
    for (const q of s.detection.quasiSpans) {
      quasiToRedact.add(q.label);
    }
  } else {
    for (const q of s.detection.quasiSpans) {
      if (q.label === 'RARE_DISEASE_ICD' && q.rareTier === 'auto') {
        quasiToRedact.add(q.label);
      }
    }
  }

  updateSession({
    mode,
    complianceProfile,
    quasiToRedact,
    quasiConfirmed: false,
    replacement: null,
    risk: null,
    validation: null,
    audit: null,
    deidentifiedOutput: null,
    deidentifiedBytes: null,
    stageIndex: 2,
    error: null,
  });
}

function profileForComplianceAction(
  jurisdiction: ComplianceJurisdiction,
  mode: Mode
): ComplianceProfileId {
  if (mode === 'PSEUDONYMISE') return 'GDPR_PSEUDO';
  if (jurisdiction === 'US') return 'HIPAA_SAFE_HARBOR';
  if (jurisdiction === 'EU') return 'EHDS_SECONDARY';
  return 'GDPR_ANON';
}

/**
 * Fast extension-only guess — used to set the format on the process page
 * immediately so the redirect guard doesn't fire. Binary formats (PDF, DOCX)
 * are fully determined by extension; text formats need a content preview to
 * distinguish FHIR vs HL7 vs plain text (see confirmFormat below).
 */
function detectInitialFormat(file: File): RecordFormat {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'PDF_TYPED';
  if (ext === 'docx') return 'DOCX';
  if (ext === 'hl7') return 'HL7_V2';
  if (ext === 'csv' || ext === 'tsv') return 'CSV';
  // JSON and TXT/unknown: return TEXT as a placeholder; confirmFormat will
  // upgrade to FHIR_R4 or HL7_V2 after reading the content preview.
  return 'TEXT';
}

/**
 * Read the first 4 KB of a text file and re-run format detection with real
 * content. Returns the initial guess unchanged for binary formats.
 */
async function confirmFormat(file: File, initial: RecordFormat): Promise<RecordFormat> {
  if (initial === 'PDF_TYPED' || initial === 'DOCX' || initial === 'CSV' || initial === 'HL7_V2') {
    return initial;
  }
  // Read up to 4 KB for sniffing (avoids reading a potentially large file twice).
  const preview = await file.slice(0, 4096).text();
  return detectFormat(file.name, preview);
}

export async function finalise(): Promise<void> {
  const s = getSession();
  if (!s.detection || s.originalText === null || !s.mode) return;

  try {
    updateSession({ error: null, stageIndex: 2 });

    // Stage 3: REPLACE
    let secret = s.secret;
    if (s.mode === 'PSEUDONYMISE' && !secret) {
      secret = await generateSessionSecret();
      updateSession({ secret });
    }

    // Merge HITL edits into the active span lists before replacement.
    // 1. Remove spans the user dismissed as false positives.
    const activeSpans = s.detection.spans.filter(
      (sp) => !s.userDismissedSpanKeys.has(`${sp.start}:${sp.end}:${sp.label}`)
    );
    const activeQuasi = s.detection.quasiSpans.filter(
      (sp) => !s.userDismissedSpanKeys.has(`${sp.start}:${sp.end}:${sp.label}`)
    );

    // 2. Add spans the user confirmed from the uncertain NER panel.
    const confirmedUncertain = (s.detection.uncertainSpans ?? []).filter(
      (sp) => s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`] === true
    );

    // 3. Merge in spans the user manually drew in the span editor.
    const allSpans = [...activeSpans, ...s.userAddedSpans, ...confirmedUncertain];

    const replacement = await replaceSpans(
      s.originalText,
      allSpans,
      activeQuasi,
      {
        mode: s.mode,
        secret: secret ?? undefined,
        quasiToRedact: s.quasiToRedact,
      }
    );
    updateSession({ replacement, stageIndex: 3 });

    // Stage 4: RISK
    const retainedQuasi = activeQuasi.filter(
      (q) => !s.quasiToRedact.has(q.label)
    );
    const { COMPLIANCE_PROFILES } = await import('@/lib/constants');
    const profile = COMPLIANCE_PROFILES[s.complianceProfile ?? 'GDPR_PSEUDO'];
    const risk = assessRisk({
      detectedSpans: s.detection.spans,
      retainedQuasiSpans: retainedQuasi,
      recordCount: 1,
      kThreshold: profile?.kThreshold,
    });
    updateSession({ risk, stageIndex: 4 });

    // Stage 5: VALIDATE
    const validation = await validate(replacement.text, {
      mode: s.mode,
      originalIdentifiers: Object.keys(replacement.mapping),
      nerRunner: runClinicalNER,
    });
    updateSession({ validation, stageIndex: 5 });

    // Stage 6: OUTPUT
    const { textOutput, bytesOutput } = await reconstructOutput(
      s.format!,
      replacement
    );
    const outputSize = bytesOutput?.byteLength ?? textOutput?.length ?? 0;
    const audit = buildAuditLog({
      mode: s.mode,
      inputFormat: s.format ?? 'TEXT',
      inputSize: s.originalSize,
      outputSize,
      detectedSpans: s.detection.spans,
      replacementsMade: replacement.replacements.length,
      risk,
      validationPassed: validation.passed,
      complianceProfile: s.complianceProfile ?? 'GDPR_PSEUDO',
      notes: validation.passed
        ? undefined
        : [`${validation.leaks.length} potential leak(s) detected — review before sharing.`],
    });

    updateSession({
      deidentifiedOutput: textOutput ?? null,
      deidentifiedBytes: bytesOutput ?? null,
      audit,
      stageIndex: 6,
    });
  } catch (err) {
    updateSession({ error: (err as Error).message });
  }
}

interface ReconstructOutput {
  textOutput?: string;
  bytesOutput?: Uint8Array;
}

async function reconstructOutput(
  format: RecordFormat,
  replacement: ReplacementResult
): Promise<ReconstructOutput> {
  const s = getSession();
  switch (format) {
    case 'TEXT':
      return { textOutput: replacement.text };
    case 'FHIR_R4': {
      const parsed = s.parsedOriginal as {
        resource: unknown;
        leaves: Array<{ path: string; value: string; referencePrefix?: string }>;
      };
      const parts = replacement.text.split(LEAF_DELIM);
      const replaced = parsed.leaves.map((leaf, i) => ({
        path: leaf.path,
        replacement: parts[i] ?? leaf.value,
        referencePrefix: leaf.referencePrefix,
      }));
      return { textOutput: reconstructFhir(parsed.resource, replaced) };
    }
    case 'HL7_V2': {
      const parsed = s.parsedOriginal as {
        doc: Parameters<typeof reconstructHL7>[0];
        leaves: HL7Leaf[];
      };
      const parts = replacement.text.split(LEAF_DELIM);
      const replaced = parsed.leaves.map((leaf, i) => ({
        leaf,
        replacement: parts[i] ?? leaf.value,
      }));
      return { textOutput: reconstructHL7(parsed.doc, replaced) };
    }
    case 'DOCX': {
      const parsed = s.parsedOriginal as DocxIngestResult;
      const { applyMappingToBody, rebuildDocxInPlace } = await import('@/formats/docx');
      switch (s.docxFormat) {
        case 'MARKDOWN':
          return {
            textOutput: applyMappingToBody(parsed.markdown, replacement.mapping),
          };
        case 'HTML':
          return {
            textOutput: applyMappingToBody(parsed.html, replacement.mapping),
          };
        case 'DOCX':
        default: {
          // In-place rebuild from the ORIGINAL .docx ZIP: preserves every byte
          // of formatting, styles, tables, images and theme. The mapping
          // (original→replacement) is applied inside `<w:t>` text runs only.
          const bytes = await rebuildDocxInPlace(parsed.originalBytes, replacement.mapping);
          return { bytesOutput: bytes };
        }
      }
    }
    case 'CSV': {
      const parsed = s.parsedOriginal as CsvIngest;
      const parts = replacement.text.split(LEAF_DELIM);
      const replaced: Array<{ leaf: CsvLeaf; replacement: string }> = parsed.leaves.map((leaf, i) => ({
        leaf,
        replacement: parts[i] ?? leaf.value,
      }));
      const { reconstructCsv } = await import('@/formats/csv');
      return { textOutput: reconstructCsv(parsed, replaced) };
    }
    case 'PDF_TYPED': {
      const parsed = s.parsedOriginal as PdfIngest;
      const redactions: PdfRedaction[] = replacement.replacements
        .map((r) => ({
          pageIndex: parsed.globalMap[r.span.start]?.pageIndex ?? 0,
          start: r.span.start,
          end: r.span.end,
          replacement: r.replacement,
        }))
        .filter((r) => parsed.globalMap[r.start]);
      const { reconstructPdf } = await import('@/formats/pdf-typed');
      const bytes = await reconstructPdf(parsed, redactions);
      return { bytesOutput: bytes };
    }
    case 'PDF_SCANNED': {
      const parsed = s.parsedOriginal as ScannedPdfIngest;
      const redactions: ScannedRedaction[] = replacement.replacements
        .map((r) => {
          const gm = parsed.globalMap[r.span.start];
          if (!gm) return null;
          const pageEnd = parsed.globalMap[r.span.end - 1];
          return {
            pageIndex: gm.pageIndex,
            start: gm.offsetInPage,
            end: pageEnd ? pageEnd.offsetInPage + 1 : gm.offsetInPage + (r.span.end - r.span.start),
            replacement: r.replacement,
          };
        })
        .filter((r): r is ScannedRedaction => r !== null);
      const { reconstructScannedPdf } = await import('@/formats/pdf-scanned');
      const bytes = await reconstructScannedPdf(parsed, redactions);
      return { bytesOutput: bytes };
    }
    default:
      return { textOutput: replacement.text };
  }
}

export async function rerenderDocxOutput(): Promise<void> {
  const s = getSession();
  if (s.format !== 'DOCX' || !s.replacement) return;
  const { textOutput, bytesOutput } = await reconstructOutput(
    'DOCX',
    s.replacement
  );
  updateSession({
    deidentifiedOutput: textOutput ?? null,
    deidentifiedBytes: bytesOutput ?? null,
  });
}

export function canEmitOutput(): boolean {
  const s = getSession();
  if (!s.risk || !s.validation) return false;
  if (!s.validation.passed) return false;
  if (s.risk.kAnonymity < K_ANONYMITY_THRESHOLD && s.mode === 'ANONYMISE') return false;
  return true;
}
