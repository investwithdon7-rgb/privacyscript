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
  lDiversity?: number;
  breakdown: RiskAssessment['breakdown'];
  validationPassed: boolean;
  /** Original text NEVER appears here — only labels and counts. */
  reasonsForRisk: string[];
  complianceProfile?: string;
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
  complianceProfile?: string;
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
    lDiversity: input.risk.lDiversity,
    breakdown: input.risk.breakdown,
    validationPassed: input.validationPassed,
    reasonsForRisk: input.risk.reasons,
    complianceProfile: input.complianceProfile,
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

/**
 * Generate a DPIA-style compliance report PDF client-side using pdf-lib.
 * The report contains no original PHI — only metadata, counts, risk scores,
 * and regulation references. Safe to include in ethics board submissions.
 */
const PDF_REPLACEMENTS: Record<string, string> = {
  '∞': 'infinite',
  '→': '->',
  '←': '<-',
  '≥': '>=',
  '≤': '<=',
  '✓': 'yes',
  '✗': 'no',
  '·': '-',
};

/** Text the standard (WinAnsi) PDF fonts can draw. */
export function pdfSafe(text: string): string {
  return Array.from(text)
    .map((c) => {
      if (PDF_REPLACEMENTS[c]) return PDF_REPLACEMENTS[c];
      const code = c.codePointAt(0)!;
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return c;
      // Windows-1252 extras the fonts do have: quotes, dashes, ellipsis, bullet, euro.
      if ('‘’“”–—…•€'.includes(c)) return c;
      return '?';
    })
    .join('');
}

export async function generateComplianceReportPdf(
  audit: AuditLog,
  nerLeakCount: number,
  filename: string
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, PageSizes } = await import('pdf-lib');

  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  // Colour palette (all as rgb(0..1))
  const indigo = rgb(0.31, 0.27, 0.9);
  const darkBg = rgb(0.04, 0.04, 0.08);
  // Body text is dark on the white page; white only on the dark header strip.
  const textPrimary = rgb(0.06, 0.09, 0.16);
  const textOnDark = rgb(1, 1, 1);
  const textMuted = rgb(0.58, 0.64, 0.72);
  const success = rgb(0.06, 0.73, 0.51);
  const danger = rgb(0.94, 0.27, 0.27);
  const warning = rgb(0.96, 0.62, 0.04);

  const [W, H] = PageSizes.A4;
  const margin = 48;
  const contentW = W - margin * 2;

  let page = doc.addPage([W, H]);
  let y = H - margin;
  // The standard PDF fonts only encode WinAnsi: "∞", "→" or "≥" in a note
  // made the whole report fail. Every string is cleaned where it is drawn.
  const put = (text: string, opts: Parameters<typeof page.drawText>[1]): void => page.drawText(pdfSafe(text), opts);

  const drawText = (
    text: string,
    opts: {
      size?: number;
      font?: typeof bold;
      color?: typeof indigo;
      x?: number;
      maxWidth?: number;
    } = {}
  ) => {
    const {
      size = 10,
      font = regular,
      color = textPrimary,
      x = margin,
      maxWidth = contentW,
    } = opts;

    // Simple word-wrap
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(pdfSafe(test), size) > maxWidth && line) {
        put(line, { x, y, size, font, color });
        y -= size + 4;
        checkPageBreak(size + 8);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      put(line, { x, y, size, font, color });
      y -= size + 4;
    }
  };

  const checkPageBreak = (needed = 30) => {
    if (y - needed < margin) {
      page = doc.addPage([W, H]);
      y = H - margin;
      // Repeat header strip on new pages
      page.drawRectangle({ x: 0, y: H - 28, width: W, height: 28, color: darkBg });
      put(`${ENGINE_NAME} — Compliance Report`, {
        x: margin, y: H - 19, size: 8, font: regular, color: textMuted,
      });
    }
  };

  // ── Cover strip ────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: darkBg });
  put('COMPLIANCE REPORT', {
    x: margin, y: H - 32, size: 10, font: bold, color: indigo,
  });
  put(`${ENGINE_NAME} · v${audit.engineVersion}`, {
    x: margin, y: H - 48, size: 10, font: regular, color: textOnDark,
  });
  put(`Generated: ${new Date(audit.timestamp).toLocaleString()} (UTC)`, {
    x: margin, y: H - 62, size: 8, font: regular, color: textMuted,
  });
  y = H - 100;

  // ── Section helper ─────────────────────────────────────────────────────
  const section = (title: string) => {
    y -= 14;
    checkPageBreak(30);
    page.drawRectangle({ x: margin - 4, y: y - 2, width: contentW + 8, height: 18, color: darkBg });
    put(title.toUpperCase(), {
      x: margin, y: y + 3, size: 8, font: bold, color: indigo,
    });
    y -= 20;
  };

  const row = (label: string, value: string, valueColor = textPrimary) => {
    checkPageBreak(14);
    put(label, { x: margin, y, size: 9, font: regular, color: textMuted });
    put(value, { x: margin + 170, y, size: 9, font: regular, color: valueColor });
    y -= 14;
  };

  // ── Processing metadata ────────────────────────────────────────────────
  section('1. Processing Metadata');
  row('Record (filename hashed)', filename);
  row('Input format', audit.inputFormat);
  row('Input size (bytes)', audit.inputSize.toLocaleString());
  row('Output size (bytes)', audit.outputSize.toLocaleString());
  row('Processing mode', audit.mode);
  row('Compliance target', audit.complianceProfile ?? 'GDPR_PSEUDO');
  row('Engine', `${audit.engine} v${audit.engineVersion}`);
  row('Timestamp', audit.timestamp);

  // ── Identifier counts ──────────────────────────────────────────────────
  section('2. Identifier Detection Summary');
  row('Total spans detected', String(audit.spansFound));
  row('Replacements made', String(audit.replacementsMade));
  y -= 4;

  // Table header
  const col = [margin, margin + 130, margin + 220];
  const drawRow = (a: string, b: string, c: string, hdr = false) => {
    checkPageBreak(14);
    const f = hdr ? bold : regular;
    const clr = hdr ? indigo : textPrimary;
    put(a, { x: col[0], y, size: 8, font: f, color: clr });
    put(b, { x: col[1], y, size: 8, font: f, color: clr });
    put(c, { x: col[2], y, size: 8, font: f, color: clr });
    y -= 13;
  };

  drawRow('Identifier type', 'Count', 'Action', true);
  for (const b of audit.breakdown) {
    drawRow(b.label, String(b.count), b.action);
  }

  // ── Risk assessment ───────────────────────────────────────────────────
  section('3. Risk Assessment');
  row('Risk level', audit.riskLevel, audit.riskLevel === 'HIGH' ? danger : audit.riskLevel === 'MEDIUM' ? warning : success);
  row('k-anonymity score', String(audit.kAnonymity));
  row('l-diversity', audit.lDiversity != null ? (audit.lDiversity >= 99 ? '∞ (no sensitive attrs)' : String(audit.lDiversity)) : 'N/A');
  row('Validation passed', audit.validationPassed ? 'YES' : 'NO', audit.validationPassed ? success : danger);
  if (nerLeakCount > 0) {
    row('NER second-pass warnings', String(nerLeakCount), warning);
  }
  y -= 4;
  for (const reason of audit.reasonsForRisk) {
    checkPageBreak(14);
    drawText(`• ${reason}`, { size: 9, color: textMuted });
    y -= 2;
  }

  // ── Measures applied (audit notes: counts and choices, never values) ──
  if (audit.notes?.length) {
    section('4. Measures Applied');
    for (const note of audit.notes) {
      checkPageBreak(14);
      drawText(`• ${note}`, { size: 9, color: textMuted });
      y -= 2;
    }
  }

  // ── DPIA / ethics summary ────────────────────────────────────────────
  section('5. For Your Privacy Assessment (DPIA / Ethics)');
  const pseudo = audit.mode === 'PSEUDONYMISE';
  const dpia: Array<[string, string]> = [
    [
      'Nature of processing',
      `De-identification of one ${audit.inputFormat} file in the user's web browser. The file was not uploaded or transmitted; no data processor was involved (GDPR Art. 28 not engaged for this step).`,
    ],
    [
      'Personal data found',
      audit.breakdown.length
        ? `${audit.breakdown.map((b) => `${b.label} (${b.count})`).join(', ')}. Health records are special category data (GDPR Art. 9).`
        : 'No identifiers were detected. Health records are special category data (GDPR Art. 9).',
    ],
    [
      'Outcome',
      pseudo
        ? 'Pseudonymised (GDPR Art. 4(5)): the output is still personal data. Re-identification needs the key file, held separately by the controller.'
        : `Anonymised to the tool's threshold (k = ${audit.kAnonymity}). Whether the output is anonymous under GDPR Recital 26 depends on the means reasonably likely to be used, including the context it is shared in.`,
    ],
    [
      'Residual risks',
      [
        audit.validationPassed ? 'No original identifier was found in the output.' : 'An original identifier was found in the output: do not share it.',
        ...audit.reasonsForRisk.slice(0, 3),
        'Automated detection can miss identifiers (unusual names, identifying context, text inside images).',
      ].join(' '),
    ],
    [
      'Actions for the controller',
      [
        pseudo ? 'Store the key file and its passphrase separately from the output, with restricted access.' : 'Do not keep a link between the output and the original.',
        'Have a person read the output as a "motivated intruder" before release.',
        'Record the lawful basis, the recipients and the retention period.',
        'Keep this report and the audit log with your records of processing (GDPR Art. 30).',
      ].join(' '),
    ],
  ];
  for (const [title, body] of dpia) {
    checkPageBreak(28);
    put(title, { x: margin, y, size: 9, font: bold, color: textPrimary });
    y -= 12;
    drawText(body, { size: 9, color: textMuted });
    y -= 4;
  }

  // ── Regulation references ────────────────────────────────────────────
  section('6. Regulation References');
  const regs = [
    ['GDPR Article 4(5)', 'Pseudonymisation definition'],
    ['GDPR Recital 26', 'Anonymisation standard'],
    ['HIPAA 45 CFR §164.514(b)', 'Safe Harbor de-identification'],
    ['EHDS Reg. (EU) 2025/327', 'European Health Data Space secondary use'],
    ['UK GDPR + DPA 2018', 'UK de-identification standard'],
  ];
  for (const [ref, desc] of regs) {
    checkPageBreak(14);
    put(ref, { x: margin, y, size: 9, font: bold, color: textPrimary });
    put(desc, { x: margin + 180, y, size: 9, font: regular, color: textMuted });
    y -= 13;
  }

  // ── Attribution ──────────────────────────────────────────────────────
  section('7. Attribution');
  drawText(
    `Rare disease ICD catalogue: ${audit.attribution.rareIcdCatalogue.source} · ` +
    `${audit.attribution.rareIcdCatalogue.licence} · ${audit.attribution.rareIcdCatalogue.url}`,
    { size: 8, color: textMuted }
  );

  // ── Signature block ──────────────────────────────────────────────────
  section('8. Certification');
  drawText(
    `This report certifies that the above-named record was processed by ${ENGINE_NAME} ` +
    `v${audit.engineVersion} on ${new Date(audit.timestamp).toLocaleDateString()} ` +
    `using the ${audit.complianceProfile ?? 'default'} de-identification profile. ` +
    `No original personal data values appear in this report. ` +
    `This report is machine-generated and does not constitute legal advice.`,
    { size: 9, color: textMuted }
  );
  y -= 20;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 200, y }, thickness: 0.5, color: indigo });
  y -= 14;
  put('Authorised by', { x: margin, y, size: 8, font: regular, color: textMuted });
  y -= 12;
  put('Date', { x: margin + 220, y: y + 12, size: 8, font: regular, color: textMuted });

  return doc.save();
}
