import { describe, expect, it } from 'vitest';
import {
  assessCompliance,
  buildShareSafeComplianceReport,
} from '@/engine/compliance';
import type { DetectionResult, Span } from '@/engine/detect';

function span(
  label: Span['label'],
  text: string,
  category: Span['category'] = 'HIPAA'
): Span {
  return {
    start: 0,
    end: text.length,
    text,
    label,
    category,
    source: 'rule',
    confidence: 1,
  };
}

function detection(spans: Span[], quasiSpans: Span[] = []): DetectionResult {
  const counts: Record<string, number> = {};
  for (const s of [...spans, ...quasiSpans]) {
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }
  return {
    spans,
    quasiSpans,
    counts,
    uncertainSpans: [],
  };
}

describe('assessCompliance', () => {
  it('returns Safe when no identifiers or health data are found', () => {
    const report = assessCompliance({
      jurisdiction: 'GENERAL',
      text: 'Meeting notes about office furniture.',
      detection: detection([]),
    });

    expect(report.verdict).toBe('SAFE');
    expect(report.aiUploadSafety.safe).toBe(true);
    expect(report.distributionSafety.safe).toBe(true);
    expect(report.recommendedPrimaryAction).toBe('NONE');
  });

  it('returns Needs de-identification for direct identifiers without health context', () => {
    const report = assessCompliance({
      jurisdiction: 'EU',
      text: 'Contact Alex at alex@example.com.',
      detection: detection([span('EMAIL', 'alex@example.com')]),
    });

    expect(report.verdict).toBe('NEEDS_DEIDENTIFICATION');
    expect(report.distributionSafety.safe).toBe(false);
    expect(report.aiUploadSafety.safe).toBe(false);
    expect(report.recommendedPrimaryAction).toBe('ANONYMISE');
  });

  it('returns Do not upload/share for health data with strong identifiers', () => {
    const report = assessCompliance({
      jurisdiction: 'US',
      text: 'Patient John Smith has diabetes. MRN: ABC12345.',
      detection: detection([
        span('NAME', 'John Smith'),
        span('MRN', 'ABC12345'),
      ]),
    });

    expect(report.verdict).toBe('DO_NOT_UPLOAD');
    expect(report.aiUploadSafety.safe).toBe(false);
    expect(report.recommendedPrimaryAction).toBe('ANONYMISE');
  });

  it('hides exact values in share-safe report output', () => {
    const report = assessCompliance({
      jurisdiction: 'UK',
      text: 'Email: patient@example.com. Diagnosis: asthma.',
      detection: detection([span('EMAIL', 'patient@example.com')]),
    });

    const safe = buildShareSafeComplianceReport(report);

    expect(JSON.stringify(safe)).not.toContain('patient@example.com');
    expect(safe.findings[0].valueHidden).toBe(true);
    expect(safe.findings[0]).not.toHaveProperty('values');
  });

  it('flags rare disease quasi-identifiers as do not upload/share', () => {
    const report = assessCompliance({
      jurisdiction: 'GENERAL',
      text: 'Diagnosis Q91.0 discussed in clinic.',
      detection: detection([], [
        span('RARE_DISEASE_ICD', 'Q91.0', 'QUASI'),
      ]),
    });

    expect(report.verdict).toBe('DO_NOT_UPLOAD');
    expect(report.findings[0].severity).toBe('HIGH');
  });
});
