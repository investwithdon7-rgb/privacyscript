# Compliance Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a non-destructive Compliance Check flow that scans a document, produces a jurisdiction-specific AI/share safety verdict, and routes users into Anonymise or Pseudonymise when needed.

**Architecture:** Reuse the existing client-side ingest and detection pipeline, then add a focused compliance assessment module that maps spans, quasi-spans, jurisdiction profile, and health-context signals into a report. UI adds a two-job landing model, a `/check/` upload flow, and a `/check/report/` report with hidden-by-default values and action buttons into the existing de-identification flow.

**Tech Stack:** Next.js static export, React client components, TypeScript, Vitest, existing PrivacyScript regex/NER engine, in-memory session store.

---

## File Structure

- Create `src/engine/compliance.ts`: jurisdiction profiles, verdict types, finding model, health-context detection, compliance assessment, safe downloadable report builder.
- Create `src/engine/compliance.test.ts`: unit tests for verdicts, findings, hidden value handling, and recommended actions.
- Modify `src/state/session.ts`: add compliance check state (`complianceCheck`, `complianceJurisdiction`, `uploadedFile`).
- Modify `src/hooks/useDeidentification.ts`: export a check-only pipeline and action helpers; fix the structured leaf delimiter to U+001F.
- Create `src/components/ComplianceReportPanel.tsx`: verdict, conclusions, findings table, reveal-on-click values, action buttons.
- Modify `src/app/page.tsx`: present two top-level jobs, Check Compliance and De-identify; preserve current de-identify upload path.
- Create `src/app/check/page.tsx`: jurisdiction selector and upload/paste entry for compliance checking.
- Create `src/app/check/report/page.tsx`: compliance report screen and action routing.

## Task 1: Compliance Assessment Core

**Files:**
- Create: `src/engine/compliance.ts`
- Test: `src/engine/compliance.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests covering:

```ts
import { describe, expect, it } from 'vitest';
import { assessCompliance, buildShareSafeComplianceReport } from '@/engine/compliance';
import type { DetectionResult, Span } from '@/engine/detect';

const span = (label: Span['label'], text: string, category: Span['category'] = 'HIPAA'): Span => ({
  start: 0,
  end: text.length,
  text,
  label,
  category,
  source: 'rule',
  confidence: 1,
});

const detection = (spans: Span[], quasiSpans: Span[] = []): DetectionResult => ({
  spans,
  quasiSpans,
  counts: [...spans, ...quasiSpans].reduce<Record<string, number>>((acc, s) => {
    acc[s.label] = (acc[s.label] ?? 0) + 1;
    return acc;
  }, {}),
  uncertainSpans: [],
});

describe('assessCompliance', () => {
  it('returns Safe when no identifiers or health data are found', () => {
    const report = assessCompliance({
      jurisdiction: 'GENERAL',
      text: 'Meeting notes about office furniture.',
      detection: detection([]),
    });
    expect(report.verdict).toBe('SAFE');
    expect(report.aiUploadSafety.safe).toBe(true);
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
  });

  it('returns Do not upload/share for health data with strong identifiers', () => {
    const report = assessCompliance({
      jurisdiction: 'US',
      text: 'Patient John Smith has diabetes. MRN: ABC12345.',
      detection: detection([span('NAME', 'John Smith'), span('MRN', 'ABC12345')]),
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
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/engine/compliance.test.ts`
Expected: FAIL because `src/engine/compliance.ts` does not exist.

- [ ] **Step 3: Implement compliance module**

Define:

```ts
export type ComplianceJurisdiction = 'EU' | 'UK' | 'US' | 'GENERAL';
export type ComplianceVerdict = 'SAFE' | 'NEEDS_DEIDENTIFICATION' | 'DO_NOT_UPLOAD';
export type ComplianceSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type ComplianceAction = 'NONE' | 'ANONYMISE' | 'PSEUDONYMISE';
```

Implement `assessCompliance(input)` to:

- detect health context from clinical keywords and rare/quasi health spans.
- group direct and quasi spans by label.
- build findings with `value` present for UI reveal, but `valueHidden: true`.
- return `SAFE` for no findings and no health context.
- return `NEEDS_DEIDENTIFICATION` for identifiers without health context.
- return `DO_NOT_UPLOAD` for strong identifiers plus health context, rare disease codes, MRN/NHS/SSN/national IDs, or health context under US/EU/UK/General AI upload safety.
- set `recommendedPrimaryAction` to `ANONYMISE` whenever AI upload is unsafe.

Implement `buildShareSafeComplianceReport(report)` to remove exact values and context snippets from downloadable default output.

- [ ] **Step 4: Run compliance tests**

Run: `npm test -- src/engine/compliance.test.ts`
Expected: PASS.

## Task 2: Session And Pipeline Wiring

**Files:**
- Modify: `src/state/session.ts`
- Modify: `src/hooks/useDeidentification.ts`

- [ ] **Step 1: Add session fields**

Add to `SessionState`:

```ts
complianceJurisdiction: import('@/engine/compliance').ComplianceJurisdiction;
complianceCheck: import('@/engine/compliance').ComplianceReport | null;
uploadedFile: File | null;
```

Set initial values:

```ts
complianceJurisdiction: 'GENERAL',
complianceCheck: null,
uploadedFile: null,
```

Reset them in `resetSession`.

- [ ] **Step 2: Fix structured leaf delimiter**

Change the delimiter in `src/hooks/useDeidentification.ts` from an empty string to:

```ts
const LEAF_DELIM = '\u001F';
```

- [ ] **Step 3: Add check-only pipeline**

Export:

```ts
export async function runComplianceCheck(
  file: File,
  jurisdiction: ComplianceJurisdiction
): Promise<void>
```

It should ingest the file using the same format switch as `ingestAndDetect`, run NER + `detect`, call `assessCompliance`, then update session with the file, extracted text, parsed original, source bytes, detection, jurisdiction, and compliance report.

- [ ] **Step 4: Add action helper**

Export:

```ts
export async function startDeidentificationFromCompliance(mode: Mode): Promise<void>
```

It should reuse the current session document/detection, set `mode`, auto-select quasi fields based on the preserved compliance profile, and leave the user ready for the existing process/review path.

## Task 3: Compliance Report UI

**Files:**
- Create: `src/components/ComplianceReportPanel.tsx`
- Create: `src/app/check/page.tsx`
- Create: `src/app/check/report/page.tsx`

- [ ] **Step 1: Build report panel**

Render verdict badge, selected jurisdiction, distribution and AI-upload safety, finding counts, hidden exact values with reveal buttons, and action buttons.

- [ ] **Step 2: Build check upload page**

Use `Brand`, `DropZone`, and `NerBanner`. Provide four jurisdiction cards: EU, UK, US, General / International. On upload, call `runComplianceCheck(file, jurisdiction)` and route to `/check/report/`.

- [ ] **Step 3: Build check report page**

Read session state. If no report exists, redirect home. Render `ComplianceReportPanel`. Wire buttons:

- Anonymise this document -> `startDeidentificationFromCompliance('ANONYMISE')`, then route `/process/`.
- Pseudonymise this document -> `startDeidentificationFromCompliance('PSEUDONYMISE')`, then route `/process/`.
- Download compliance report -> download `buildShareSafeComplianceReport(s.complianceCheck)`.

## Task 4: Landing Page Update

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Restructure landing**

Show two top-level cards:

- Check Compliance
- De-identify

Keep the existing compliance profile selector and upload/paste control inside the De-identify section so current behavior remains available.

- [ ] **Step 2: Link check flow**

The Check Compliance card should route to `/check/`.

## Task 5: Verification

**Files:**
- Existing tests and modified source files.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- src/engine/compliance.test.ts src/engine/synthetic.test.ts src/engine/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Check git diff**

Run: `git diff -- src docs/superpowers/plans/2026-06-05-compliance-check.md`
Expected: Changes are limited to compliance check feature, delimiter fix, and UI wiring.
