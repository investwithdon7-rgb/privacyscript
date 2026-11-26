import { describe, expect, it } from 'vitest';
import { buildAuditLog, generateComplianceReportPdf } from '@/engine/output';

const audit = (notes: string[], l: number) =>
  buildAuditLog({
    mode: 'PSEUDONYMISE',
    inputFormat: 'CSV',
    inputSize: 1000,
    outputSize: 900,
    detectedSpans: [],
    replacementsMade: 3,
    risk: { level: 'LOW', kAnonymity: 10, lDiversity: l, reasons: ['All quasi-identifiers suppressed or generalised.'], breakdown: [{ label: 'NAME', count: 3, action: 'redacted' }] },
    validationPassed: true,
    notes,
  });

describe('compliance / DPIA report', () => {
  it('renders notes with arrows, quotes and symbols, and infinite l-diversity', async () => {
    const bytes = await generateComplianceReportPdf(
      audit(['Column “Age”: Could identify in combination → Age bands (10 years).', 'k ≥ 5 · 3 → 2 ✓ 名前'], 99),
      0,
      'survey'
    );
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes).toString('latin1')).toContain('%PDF');
  });
});

describe('compliance report filename', () => {
  it('shows a fingerprint, never the filename (it often carries the patient name)', async () => {
    const { filenameFingerprint } = await import('@/engine/output');
    const name = 'Mueller_Anna_Entlassbrief';
    const fp = await filenameFingerprint(name);
    expect(fp).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(await filenameFingerprint(name)).toBe(fp);
    // The PDF's text is compressed: read it back the way a viewer would.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = await generateComplianceReportPdf(audit([], 2), 0, name);
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ');
    }
    expect(text).toContain(fp);
    expect(text).not.toContain('Mueller');
  });
});
