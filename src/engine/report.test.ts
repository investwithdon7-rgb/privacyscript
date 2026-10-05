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
