'use client';

import { detect, type Span } from '@/engine/detect';
import { getNerStatus, modelsFor, NER_MODELS, NerCancelledError, runClinicalNER } from '@/engine/ner';
import { replaceSpans, type ReplacementResult } from '@/engine/replace';
import { assessRisk, type RiskAssessment } from '@/engine/risk';
import { validate } from '@/engine/validate';
import { buildAuditLog } from '@/engine/output';
import { detectFormat, readFileAsText, type RecordFormat } from '@/engine/ingest';
import { parseFhir, reconstructFhir, forcedLabelForFhirPath } from '@/formats/fhir';
import { parseHL7, reconstructHL7, forcedLabelForHl7Leaf, type HL7Leaf } from '@/formats/hl7';
import type { DocxIngestResult } from '@/formats/docx';
import type { PdfIngest, PdfRedaction } from '@/formats/pdf-typed';
import type { CsvIngest, CsvLeaf } from '@/formats/csv';
import type { DicomIngest, DicomRebuildResult } from '@/formats/dicom';
import type { IdentifierLabel } from '@/lib/identifiers';
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
import { assessScriptCoverage } from '@/engine/script-coverage';
import {
  analyseTranscript,
  contextualFlags,
  detectTranscript,
  nameMentionSpans,
  passageSpan,
  transcriptLabeller,
  type TranscriptState,
} from '@/engine/transcript';
import {
  applyPlans,
  detectPlatform,
  GENERALISER_LABELS,
  ROLE_LABELS,
  displayName,
  measureRisk,
  questionRow,
  suggestPlans,
  usesEngineOutput,
  type ApplyResult,
  type TabularRisk,
  type TabularState,
} from '@/engine/tabular';

/**
 * Non-printable U+001F UNIT SEPARATOR. Used as the leaf delimiter when we
 * synthesise a flat text body from a structured input. No regex rule in the
 * catalogue matches across this character, so spans cannot leak between
 * leaves.
 */
const LEAF_DELIM = '\u001F';

/**
 * Build forced detection spans from structural knowledge of the source format.
 * Structured formats tell us outright which leaves are names/addresses (FHIR
 * paths, HL7 field positions, CSV headers) — those leaves are redacted even
 * when regex and NER produce no evidence. Offsets are computed against the
 * LEAF_DELIM-joined text the detect stage runs on.
 */
function buildForcedSpans(
  values: string[],
  labelForIndex: (i: number) => IdentifierLabel | null
): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  values.forEach((v, i) => {
    const label = labelForIndex(i);
    if (label && v.trim().length > 0) {
      spans.push({
        start: offset,
        end: offset + v.length,
        text: v,
        label,
        category: 'HIPAA',
        source: 'rule',
        confidence: 1,
      });
    }
    offset += v.length + LEAF_DELIM.length;
  });
  return spans;
}

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
    let forcedSpans: Span[] = [];
    // The typed-PDF case can re-route to the scanned pipeline; the format the
    // rest of the pipeline sees (output reconstruction switches on it!) must
    // reflect that, not the pre-ingest guess.
    let effectiveFormat: RecordFormat = confirmedFormat;

    switch (confirmedFormat) {
      case 'FHIR_R4': {
        const raw = await readFileAsText(file);
        const { resource, leaves } = parseFhir(raw);
        parsedOriginal = { resource, leaves };
        text = leaves.map((l) => l.value).join(LEAF_DELIM);
        forcedSpans = buildForcedSpans(
          leaves.map((l) => l.value),
          (i) => forcedLabelForFhirPath(leaves[i].path)
        );
        break;
      }
      case 'HL7_V2': {
        const raw = await readFileAsText(file);
        const { doc, leaves } = parseHL7(raw);
        parsedOriginal = { doc, leaves };
        text = leaves.map((l) => l.value).join(LEAF_DELIM);
        forcedSpans = buildForcedSpans(
          leaves.map((l) => l.value),
          (i) => forcedLabelForHl7Leaf(doc, leaves[i])
        );
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
        // A document is treated as scanned when:
        //   - it has pages, AND
        //   - average chars/page < 60  (almost no text layer on average), AND
        //   - max chars on any single page < 120 (no page has meaningful text)
        // A pure image scan extracts ZERO text — that is the strongest scan
        // signal of all, so no minimum-content guard: requiring some text
        // used to route all-image PDFs down the typed path, producing an
        // empty document with 0 identifiers detected.
        const textLengths = typedResult.pages.map((p) => p.text.trim().length);
        const avgPerPage =
          typedResult.pages.length === 0
            ? 0
            : textLengths.reduce((s, l) => s + l, 0) / typedResult.pages.length;
        const maxPerPage = textLengths.reduce((m, l) => Math.max(m, l), 0);

        if (typedResult.pages.length > 0 && avgPerPage < 60 && maxPerPage < 120) {
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
          effectiveFormat = 'PDF_SCANNED';
        } else {
          parsedOriginal = typedResult;
          text = typedResult.fullText;
        }
        break;
      }
      case 'CSV': {
        const ext = file.name.split('.').pop()?.toLowerCase();
        // SPSS variable labels act as question text for column suggestions.
        let questions: Record<string, string> = {};
        let raw: string;
        if (ext === 'xlsx') {
          raw = await (await import('@/formats/xlsx')).xlsxToCsv(await file.arrayBuffer());
        } else if (ext === 'sav') {
          const sav = (await import('@/formats/sav')).readSav(await file.arrayBuffer());
          raw = sav.csv;
          questions = sav.labels;
        } else {
          raw = await readFileAsText(file);
        }
        const { parseCsv, forcedLabelForCsvColumn } = await import('@/formats/csv');
        const csv = parseCsv(raw);
        parsedOriginal = csv;
        updateSession({ tabular: buildTabularState(csv, getSession().mode ?? 'PSEUDONYMISE', questions) });
        text = csv.leaves.map((l) => l.value).join(LEAF_DELIM);
        forcedSpans = buildForcedSpans(
          csv.leaves.map((l) => l.value),
          (i) => forcedLabelForCsvColumn(csv.leaves[i].column)
        );
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
        // Header values the span engine reads (names, IDs, free text) become
        // leaves, like FHIR. UIDs, dates and removals are applied by the DICOM
        // profile itself when the file is rebuilt (formats/dicom.ts).
        sourceBytes = await file.arrayBuffer();
        const { ingestDicom } = await import('@/formats/dicom');
        const dicom = await ingestDicom(sourceBytes);
        parsedOriginal = dicom;
        text = dicom.leaves.map((l) => l.value).join(LEAF_DELIM);
        forcedSpans = buildForcedSpans(
          dicom.leaves.map((l) => l.value),
          (i) => dicom.leaves[i].label
        );
        break;
      }
      default:
        throw new Error(`Unknown format for ${file.name}.`);
    }

    updateSession({
      filename: file.name,
      format: effectiveFormat,
      originalText: text,
      originalSize: file.size,
      parsedOriginal,
      sourceBytes,
      stageIndex: 1,
    });

    // Interview / focus-group transcripts (plain text, captions, Word).
    const transcriptInfo =
      effectiveFormat === 'TEXT' || effectiveFormat === 'DOCX' ? analyseTranscript(text) : null;

    // Stage 2: DETECT
    // Forced spans (structural PII from FHIR paths / HL7 fields / CSV headers)
    // carry confidence 1, so they always land in the auto-accepted bucket.
    // The model reads only what people wrote or said: caption timings, cue
    // IDs and speaker labels are masked (speakers are handled by rules).
    const nerModels = modelsFor(text);
    updateSession({ nerModels: nerModels.map((m) => NER_MODELS[m].id) });
    const nerSpans = await runClinicalNER(text, {
      models: nerModels,
      skip: transcriptInfo ? [...transcriptInfo.structuralSpans, ...transcriptInfo.labelSpans] : [],
      onProgress: (done, total) => updateSession({ nerProgress: { phase: 'detect', done, total } }),
    });
    updateSession({ nerProgress: null });
    const detection = transcriptInfo
      ? detectTranscript(text, transcriptInfo, nerSpans, forcedSpans)
      : detect(text, [...nerSpans, ...forcedSpans]);
    let transcript: TranscriptState | null = null;
    if (transcriptInfo) {
      transcript = {
        info: transcriptInfo,
        readable: true,
        flags: contextualFlags(text, transcriptInfo),
        flagDecisions: {},
        confirmed: false,
      };
    }

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

    // The detectors are Latin-script only: text they cannot read yields no
    // spans and would look clean. Flag it so output is never emitted silently.
    const scriptWarning = assessScriptCoverage(text);

    updateSession({
      detection,
      transcript,
      scriptWarning,
      scriptAcknowledged: false,
      quasiToRedact: autoRedact,
      stageIndex: 2,
    });
  } catch (err) {
    // A cancelled run is not an error; the page that cancelled resets itself.
    if (err instanceof NerCancelledError) return;
    updateSession({ error: (err as Error).message, nerProgress: null });
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
    tabular: null,
    transcript: null,
    scriptWarning: null,
    scriptAcknowledged: false,
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

  // Column suggestions depend on the mode (e.g. date shifting is only offered
  // when pseudonymising), so re-suggest now that the mode is known.
  const tabular =
    s.format === 'CSV' && s.parsedOriginal
      ? buildTabularState(
          s.parsedOriginal as CsvIngest,
          mode,
          Object.fromEntries((s.tabular?.plans ?? []).filter((p) => p.question).map((p) => [p.column, p.question!]))
        )
      : s.tabular;

  updateSession({
    mode,
    complianceProfile,
    tabular,
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

/** Data rows of a parsed CSV, i.e. without platform header/meta rows. */
export function tabularDataRows(csv: CsvIngest, tabular: TabularState): Record<string, string>[] {
  return csv.rows.slice(tabular.platform.metaRowCount);
}

function buildTabularState(
  csv: CsvIngest,
  mode: Mode,
  /** Extra question text per column (e.g. SPSS variable labels). */
  questions: Record<string, string> = {}
): TabularState {
  const platform = detectPlatform(csv.headers, csv.rows);
  const dataRows = csv.rows.slice(platform.metaRowCount);
  return {
    platform,
    plans: suggestPlans(csv.headers, dataRows, mode, { ...questionRow(platform, csv.rows), ...questions }),
    suppressedRows: [],
    fixNotes: [],
    confirmed: false,
  };
}

/** Map an offset in the LEAF_DELIM-joined text to its CSV leaf index. */
function leafIndexFinder(leaves: CsvLeaf[]): (pos: number) => number {
  const starts: number[] = [];
  let offset = 0;
  for (const l of leaves) {
    starts.push(offset);
    offset += l.value.length + LEAF_DELIM.length;
  }
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/**
 * For a tabular run: keep only spans that fall in columns whose output comes
 * from the span engine. Spans inside identifier / quasi columns are handled
 * by the column plan and would otherwise be double-reported.
 */
export function spansInEngineColumns<T extends { start: number }>(spans: T[]): T[] {
  const s = getSession();
  if (s.format !== 'CSV' || !s.tabular || !s.parsedOriginal) return spans;
  const csv = s.parsedOriginal as CsvIngest;
  const find = leafIndexFinder(csv.leaves);
  const planBy = new Map(s.tabular.plans.map((p) => [p.column, p]));
  const meta = s.tabular.platform.metaRowCount;
  return spans.filter((sp) => {
    const leaf = csv.leaves[find(sp.start)];
    if (!leaf || leaf.row < meta) return true;
    const plan = planBy.get(leaf.column);
    return !plan || usesEngineOutput(plan);
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
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'sav') return 'CSV';
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

  if (s.scriptWarning?.severity === 'UNREADABLE') {
    updateSession({ error: s.scriptWarning.message });
    return;
  }
  if (s.scriptWarning?.severity === 'PARTIAL' && !s.scriptAcknowledged) return;

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
    // 4. Transcript passages the user chose to remove.
    const tr = s.transcript;
    const removedFlags = tr ? tr.flags.filter((f) => tr.flagDecisions[f.id] === 'remove') : [];
    const passageSpans = removedFlags.map((f) => passageSpan(s.originalText!, f));

    // 5. Transcripts: a name the user confirmed (from the uncertain list or by
    //    marking it) is replaced at every mention, not just the one reviewed.
    const confirmedNameSpans = tr
      ? nameMentionSpans(
          s.originalText,
          [...confirmedUncertain, ...s.userAddedSpans]
            .filter((sp) => sp.label === 'NAME')
            .map((sp) => s.originalText!.slice(sp.start, sp.end)),
          tr.info,
          [...activeSpans, ...activeQuasi, ...s.userAddedSpans, ...confirmedUncertain, ...passageSpans]
        )
      : [];

    const allSpans = [
      ...activeSpans,
      ...s.userAddedSpans,
      ...confirmedUncertain,
      ...passageSpans,
      ...confirmedNameSpans,
    ];

    const replacement = await replaceSpans(
      s.originalText,
      allSpans,
      activeQuasi,
      {
        mode: s.mode,
        secret: secret ?? undefined,
        quasiToRedact: s.quasiToRedact,
        labeller: tr
          ? transcriptLabeller(tr.info, tr.readable, removedFlags.map((f) => f.text))
          : undefined,
      }
    );
    const { COMPLIANCE_PROFILES } = await import('@/lib/constants');
    const profile = COMPLIANCE_PROFILES[s.complianceProfile ?? 'GDPR_PSEUDO'];
    const kThreshold = profile?.kThreshold ?? K_ANONYMITY_THRESHOLD;

    // Survey / spreadsheet runs: apply the confirmed column plan on top of
    // the span engine's per-cell output.
    const tab = s.format === 'CSV' && s.tabular ? s.tabular : null;
    let tabularOut: Awaited<ReturnType<typeof applyPlans>> | null = null;
    let finalReplacement = replacement;
    if (tab) {
      const csv = s.parsedOriginal as CsvIngest;
      const parts = replacement.text.split(LEAF_DELIM);
      const engineRows = csv.rows.map((r) => ({ ...r }));
      csv.leaves.forEach((leaf, i) => {
        engineRows[leaf.row][leaf.column] = parts[i] ?? leaf.value;
      });
      tabularOut = await applyPlans({
        headers: csv.headers,
        originalRows: csv.rows,
        engineRows,
        metaRowCount: tab.platform.metaRowCount,
        plans: tab.plans,
        suppressedRows: tab.suppressedRows,
        mode: s.mode,
        secret: secret ?? undefined,
        kThreshold,
        dateShiftDays: replacement.dateShiftDays,
      });
      // DIRECT-column pseudonyms belong in the re-identification key too.
      finalReplacement = {
        ...replacement,
        mapping: { ...replacement.mapping, ...tabularOut.mapping },
      };
    }
    // DICOM: rebuild the file now (UIDs, dates and removals are applied by the
    // profile); pseudonymised UIDs belong in the re-identification key.
    let dicomOut: DicomRebuildResult | null = null;
    if (s.format === 'DICOM') {
      const { rebuildDicom } = await import('@/formats/dicom');
      dicomOut = await rebuildDicom(s.parsedOriginal as DicomIngest, replacement.text.split(LEAF_DELIM), {
        mode: s.mode,
        secret: secret ?? undefined,
        dateShiftDays: replacement.dateShiftDays,
      });
      finalReplacement = {
        ...replacement,
        mapping: { ...replacement.mapping, ...dicomOut.uidMapping },
      };
    }
    updateSession({ replacement: finalReplacement, stageIndex: 3 });

    // Stage 4: RISK
    const retainedQuasi = activeQuasi.filter(
      (q) => !s.quasiToRedact.has(q.label)
    );
    let risk = assessRisk({
      detectedSpans: s.detection.spans,
      // In a survey, quasi spans inside identifier/quasi columns are governed
      // by the column plan; only free-text mentions feed the heuristic.
      retainedQuasiSpans: tab ? spansInEngineColumns(retainedQuasi) : retainedQuasi,
      recordCount: 1,
      kThreshold,
    });
    if (tab && tabularOut) {
      const csv = s.parsedOriginal as CsvIngest;
      risk = mergeTabularRisk(
        risk,
        measureRisk(tabularDataRows(csv, tab), tab.plans, kThreshold, tab.suppressedRows),
        tab,
        kThreshold,
        s.mode
      );
    }
    if (dicomOut) risk = withBurnedInRisk(risk, s.parsedOriginal as DicomIngest);
    updateSession({ risk, stageIndex: 4 });

    // Stage 5: VALIDATE
    let validationText = replacement.text;
    let originalIdentifiers = Object.keys(replacement.mapping);
    if (tab && tabularOut) {
      // Quasi columns hold deliberately kept / generalised values (governed by
      // k-anonymity above), so the verbatim leak check runs on every other
      // column. Direct-identifier originals are checked there too.
      const planBy = new Map(tab.plans.map((p) => [p.column, p]));
      const checked = tabularOut.headers.filter((h) => planBy.get(h)?.role !== 'QUASI');
      validationText = tabularOut.rows
        .flatMap((r) => checked.map((h) => r[h] ?? ''))
        .filter(Boolean)
        .join(LEAF_DELIM);
      const inEngineCols = new Set(
        spansInEngineColumns(replacement.replacements.map((r) => ({ start: r.span.start, original: r.original })))
          .map((r) => r.original)
      );
      const inPlanCols = new Set(
        replacement.replacements.map((r) => r.original).filter((o) => !inEngineCols.has(o))
      );
      originalIdentifiers = [
        ...Object.keys(replacement.mapping).filter((o) => !inPlanCols.has(o)),
        ...tabularOut.directOriginals,
      ];
    }
    // No second model pass over the output: it is the same model on almost
    // the same text, so it repeats the first pass's answers and doubled the
    // time for long transcripts. The warning it produced is derived directly
    // instead: possible names from the first pass that the user chose to keep
    // and that still appear in the output.
    const validation = await validate(validationText, {
      mode: s.mode,
      originalIdentifiers: Array.from(new Set(originalIdentifiers)),
    });
    if (dicomOut) {
      // Validate the bytes that will be downloaded: the engine's fields get the
      // usual checks, and no original name, ID, UID or date may survive in ANY
      // text field of the written file.
      const { dicomTextValues } = await import('@/formats/dicom');
      const values = await dicomTextValues(dicomOut.bytes);
      const fieldCheck = await validate(values.engine.join(LEAF_DELIM), {
        mode: s.mode,
        originalIdentifiers: Array.from(new Set(originalIdentifiers)),
      });
      const fileCheck = await validate(values.all.join(LEAF_DELIM), {
        mode: 'PSEUDONYMISE', // verbatim originals only; UIDs would trip the regex scan
        originalIdentifiers: Array.from(new Set([...originalIdentifiers, ...dicomOut.originals])),
      });
      validation.leaks = fieldCheck.leaks;
      validation.originalsLeaked = Array.from(new Set([...fieldCheck.originalsLeaked, ...fileCheck.originalsLeaked]));
      validation.passed = validation.originalsLeaked.length === 0;
    }
    validation.nerLeaks = keptPossibleNames(s, validationText);
    updateSession({ validation, stageIndex: 5 });

    // Stage 6: OUTPUT
    const { textOutput, bytesOutput } = dicomOut
      ? { textOutput: undefined, bytesOutput: dicomOut.bytes }
      : tabularOut
      ? {
          textOutput: (await import('papaparse')).default.unparse(tabularOut.rows, {
            columns: tabularOut.headers,
          }),
          bytesOutput: undefined,
        }
      : await reconstructOutput(s.format!, replacement);
    const tabularNotes = tab && tabularOut ? tabularAuditNotes(tab, tabularOut) : [];
    if (tr) tabularNotes.push(...transcriptAuditNotes(tr));
    if (dicomOut) tabularNotes.push(...dicomOut.notes);
    tabularNotes.push(
      getNerStatus().error
        ? `Name detection: model could not load (${getNerStatus().error}); rules ran alone.`
        : `Name detection models: ${s.nerModels.join(' + ') || 'none'}.`
    );
    if (s.scriptWarning) {
      tabularNotes.push(
        `Unreadable script (${s.scriptWarning.scripts.join(', ') || 'non-Latin'}): ${Math.round(s.scriptWarning.unreadableRatio * 100)}% of letters could not be checked automatically. The user confirmed they reviewed those passages manually.`
      );
    }
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
      notes: [
        ...tabularNotes,
        ...(validation.passed
          ? []
          : [`${validation.leaks.length} potential leak(s) detected — review before sharing.`]),
      ],
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

/**
 * Possible names (uncertain model detections) the user did not redact and
 * that still appear in the output. Surfaced as warnings, never a block.
 */
function keptPossibleNames(s: ReturnType<typeof getSession>, output: string) {
  const uncertain = s.detection?.uncertainSpans ?? [];
  const kept = uncertain.filter(
    (sp) =>
      (sp.label === 'NAME' || sp.label === 'ADDRESS_LINE') &&
      s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`] !== true
  );
  const seen = new Set<string>();
  return kept.filter((sp) => {
    const word = sp.text.trim();
    if (word.length < 3 || seen.has(word)) return false;
    seen.add(word);
    return new RegExp(`(?<![\\p{L}\\d])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'u').test(output);
  });
}

/**
 * Text burned into the pixels is not removed. When the file says it is there,
 * or the kind of image usually has it, the user must confirm they checked.
 */
function withBurnedInRisk(risk: RiskAssessment, dicom: DicomIngest): RiskAssessment {
  if (dicom.burnedIn !== 'YES' && dicom.burnedIn !== 'LIKELY') return risk;
  const reason =
    dicom.burnedIn === 'YES'
      ? 'The image has text burned into the pixels (the file says so). The picture was not changed: check it shows no name, date or ID before sharing.'
      : 'This kind of image (ultrasound, screenshot or scanned document) often has names or dates burned into the picture. The picture was not changed: check it before sharing.';
  return { ...risk, level: 'HIGH', reasons: [reason, ...risk.reasons] };
}

/**
 * Replace the single-record k-anonymity estimate with the empirical value
 * measured across all survey responses (keeping the free-text heuristic as a
 * floor), and describe each column decision in the breakdown table.
 */
function mergeTabularRisk(
  base: RiskAssessment,
  tabRisk: TabularRisk,
  tab: TabularState,
  kThreshold: number,
  mode: Mode
): RiskAssessment {
  const k = Math.min(base.kAnonymity, isFinite(tabRisk.k) ? tabRisk.k : base.kAnonymity);
  const reasons = base.reasons.filter((r) => r !== 'All quasi-identifiers suppressed or generalised.');
  if (tabRisk.quasiColumns.length > 0) {
    reasons.unshift(
      `Measured across ${tabRisk.totalRows} responses: the smallest group sharing the same ${tabRisk.quasiColumns.join(', ')} has ${isFinite(tabRisk.k) ? tabRisk.k : tabRisk.totalRows} ${tabRisk.k === 1 ? 'person' : 'people'}.`
    );
  }
  if (tabRisk.rowsAtRisk > 0) {
    reasons.push(`${tabRisk.rowsAtRisk} responses are in groups smaller than ${kThreshold}.`);
  }
  if (tab.suppressedRows.length > 0) {
    reasons.push(`Identifying details hidden for ${tab.suppressedRows.length} responses.`);
  }
  let l = base.lDiversity;
  if (tabRisk.l !== null) {
    l = tabRisk.l;
    if (tabRisk.l < 2) {
      reasons.push('In at least one group, everyone gave the same sensitive answer — it can be inferred about them.');
    }
  }
  if (reasons.length === 0) reasons.push('No combination of kept columns singles anyone out.');

  const breakdown = [...base.breakdown];
  for (const p of tab.plans) {
    if (p.role === 'DIRECT') {
      breakdown.push({
        label: `Column: ${displayName(p)}`,
        count: tabRisk.totalRows,
        action: mode === 'ANONYMISE' ? 'column removed' : 'replaced with codes',
      });
    } else if (p.role === 'QUASI') {
      breakdown.push({
        label: `Column: ${displayName(p)}`,
        count: tabRisk.totalRows,
        action: p.generaliser === 'suppress' ? 'column removed' : GENERALISER_LABELS[p.generaliser].toLowerCase(),
      });
    }
  }

  const level: RiskAssessment['level'] = k >= kThreshold ? 'LOW' : k >= 3 ? 'MEDIUM' : 'HIGH';
  return { ...base, level, kAnonymity: k, lDiversity: l, reasons, breakdown };
}

function transcriptAuditNotes(tr: TranscriptState): string[] {
  const decisions = Object.values(tr.flagDecisions);
  const named = tr.info.speakers.filter((sp) => sp.isName).length;
  return [
    `Source recognised as: ${tr.info.kindLabel} (${tr.info.speakers.length} speakers, ${tr.info.turnCount} turns).`,
    `Speaker names replaced with role labels: ${named}.`,
    `Replacement style: ${tr.readable ? 'readable labels ([Person 1])' : 'codes'}.`,
    `Passages flagged for possible identification by context: ${tr.flags.length}; reviewed by user: removed ${decisions.filter((d) => d === 'remove').length}, kept ${decisions.filter((d) => d === 'keep').length}.`,
  ];
}

function tabularAuditNotes(tab: TabularState, out: ApplyResult): string[] {
  const notes = [`Source recognised as: ${tab.platform.label}.`];
  if (out.removedColumns.length) notes.push(`Columns removed: ${out.removedColumns.length}.`);
  notes.push(`Cells generalised: ${out.generalisedCells}.`);
  if (tab.suppressedRows.length) notes.push(`Responses with identifying details hidden: ${tab.suppressedRows.length}.`);
  // Column names only — never values.
  for (const p of tab.plans) {
    if (p.role === 'DIRECT' || p.role === 'QUASI') {
      notes.push(`Column “${p.column}”: ${ROLE_LABELS[p.role]} → ${p.role === 'QUASI' ? GENERALISER_LABELS[p.generaliser] : 'removed or coded'}.`);
    }
  }
  return notes;
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
  if (s.scriptWarning?.severity === 'UNREADABLE') return false;
  if (s.scriptWarning?.severity === 'PARTIAL' && !s.scriptAcknowledged) return false;
  if (!s.validation.passed) return false;
  if (s.risk.kAnonymity < K_ANONYMITY_THRESHOLD && s.mode === 'ANONYMISE') return false;
  return true;
}
