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
import { K_ANONYMITY_THRESHOLD } from '@/lib/constants';
import { getSession, updateSession } from '@/state/session';

/**
 * Non-printable U+001F UNIT SEPARATOR. Used as the leaf delimiter when we
 * synthesise a flat text body from a structured input. No regex rule in the
 * catalogue matches across this character, so spans cannot leak between
 * leaves.
 */
const LEAF_DELIM = '';

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

    // Default-on suppression for Orphanet "auto" tier rare disease codes.
    const autoRedact = new Set<string>();
    for (const q of detection.quasiSpans) {
      if (q.label === 'RARE_DISEASE_ICD' && q.rareTier === 'auto') {
        autoRedact.add('RARE_DISEASE_ICD');
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

    const replacement = await replaceSpans(
      s.originalText,
      s.detection.spans,
      s.detection.quasiSpans,
      {
        mode: s.mode,
        secret: secret ?? undefined,
        quasiToRedact: s.quasiToRedact,
      }
    );
    updateSession({ replacement, stageIndex: 3 });

    // Stage 4: RISK
    const retainedQuasi = s.detection.quasiSpans.filter(
      (q) => !s.quasiToRedact.has(q.label)
    );
    const risk = assessRisk({
      detectedSpans: s.detection.spans,
      retainedQuasiSpans: retainedQuasi,
      recordCount: 1,
    });
    updateSession({ risk, stageIndex: 4 });

    // Stage 5: VALIDATE
    const validation = validate(replacement.text, {
      mode: s.mode,
      originalIdentifiers: Object.keys(replacement.mapping),
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
