# CLAUDE.md — PrivacyScript by TekDruid

**Health Record De-identification Tool**

## Project Overview

PrivacyScript by TekDruid is a **fully client-side, browser-based** health record
de-identification tool. It allows healthcare professionals, pharma organisations,
researchers, and clinicians to pseudonymise or anonymise health records before sharing
them for analytics, research, or feeding to AI tools — without the record ever leaving
their device.

**Core compliance targets**: GDPR (Article 4(5), 9, Recital 26), HIPAA §164.514(a),
EHDS Regulation (EU) 2025/327, UK GDPR + DPA 2018, NIS2.

**Deployment**: Static site (Cloudflare Pages). Zero server-side data processing. Zero telemetry.

---

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js (static export) | Same stack as CareCompanion; `next export` = zero server |
| Hosting | Cloudflare Pages | Free, global CDN, zero backend |
| NER Engine | Transformers.js (ONNX) | Clinical NER in the browser, no API call |
| Rule Engine | Custom TypeScript | Presidio-equivalent regex for HIPAA 18 + EU identifiers |
| Crypto | Web Crypto API (native) | HMAC-SHA256 for pseudonym generation, no library needed |
| PDF (typed) | pdf-lib + pdf.js | Parse and rebuild PDFs with redacted text layer |
| OCR (scanned PDF) | Tesseract.js (WASM) | Runs in browser, slow on mobile — flag to user |
| FHIR parsing | fhir.js | Parse and reconstruct FHIR R4 JSON |
| Styling | Tailwind CSS | Consistent with existing TekDruid stack |
| Fonts | DM Sans + DM Mono | Consistent with CareCompanion / TekDruid design system |
| Analytics | None | Zero telemetry — deliberate compliance decision |

---

## Design System

Inherit from TekDruid / CareCompanion baseline.

```
Primary:       indigo-600   (#4F46E5)
Background:    near-black   (#0A0B14)
Surface:       slate-900    (#0F172A)
Surface-2:     slate-800    (#1E293B)
Text primary:  white        (#FFFFFF)
Text muted:    slate-400    (#94A3B8)
Success:       emerald-500  (#10B981)
Warning:       amber-500    (#F59E0B)
Danger:        red-500      (#EF4444)
Border:        slate-700    (#334155)
```

**Typography**
- Headings: DM Sans, 700
- Body: DM Sans, 400
- Code / tokens / identifiers: DM Mono
- No box-shadow. Use border + background contrast for depth.
- Pill-shaped buttons (rounded-full) for primary CTAs.

**Aesthetic direction**: Premium dark clinical. Feels like a serious compliance tool, not a
consumer app. No gradients. No decorative noise. Clean grid. Status indicators use colour
purposefully (green = safe, amber = review, red = risk).

---

## Core Concepts

### Two Output Modes

The mode is selected by the user before processing. It changes what the engine does.

**1. Pseudonymise Mode**
- Identifiers replaced with consistent HMAC-SHA256 tokens keyed to a session secret.
- Same patient maps to same pseudonym across multiple records in a session.
- Dates shifted by a per-record consistent offset (not randomised per field).
- A re-identification key file is generated at the end of the session.
- User downloads and stores the key themselves. Never persisted by the app.
- Output suitable for: analytics pipelines, research cohorts, internal data sharing.
- Compliance basis: GDPR Article 4(5) pseudonymisation. Data remains personal data.
  The key holder is the data controller.

**2. Anonymise Mode**
- One-way replacement. No key generated. No re-linkability.
- Dates generalised (year only, or suppressed if age > 89).
- Quasi-identifiers (postcode, occupation, ethnicity) suppressed or generalised.
- k-anonymity score computed. Record flagged if k < 5.
- Output suitable for: feeding to AI tools without a BAA/DPA, public research datasets.
- Compliance basis: GDPR Recital 26 anonymisation threshold (no reasonably likely
  re-identification means available to any party).

**The UI must make this distinction unmistakably clear to the user before they proceed.**

---

## Identifier Detection Catalogue

### HIPAA Safe Harbor (18 identifiers)
1. Names (first, last, initials)
2. Geographic subdivisions smaller than state (street, city, postcode/ZIP)
3. Dates except year (DOB, admission, discharge, death, any age > 89)
4. Phone numbers
5. Fax numbers
6. Email addresses
7. Social Security Numbers
8. Medical record numbers (MRNs)
9. Health plan beneficiary numbers
10. Account numbers
11. Certificate / licence numbers
12. Vehicle identifiers and serial numbers
13. Device identifiers and serial numbers
14. Web URLs
15. IP addresses
16. Biometric identifiers (fingerprint, voice descriptions)
17. Full-face photographs and comparable images (flag only; cannot redact images in v1)
18. Any other unique identifying number or code

### EU / UK additions
- NHS Number (UK): `\d{3}[- ]\d{3}[- ]\d{4}` pattern
- National Insurance Number (UK NINO)
- EU national ID patterns: CPR (DK), BSN (NL), NIE/DNI (ES), CNS (IT), AHV (CH)
- IBAN / bank details
- EU postcode generalisation rules per member state
- Passport numbers (regex per issuing country)

### Clinical quasi-identifiers (flag, do not auto-remove)
- Rare disease codes (ICD-10 codes with prevalence < 1:1000 — flag for user review)
- Treating institution name
- Treating physician name + specialty combination
- Ethnicity / race fields
- Occupation

---

## Processing Pipeline

Every record goes through these stages in order. Each stage is independently logged.

```
[1] INGEST
    → Detect format: FHIR R4 JSON | HL7 v2 | Plain text | Typed PDF | Scanned PDF
    → Parse into internal representation (span-indexed token list for text,
      field map for FHIR/HL7)

[2] DETECT
    → Run regex rule engine (HIPAA 18 + EU catalogue) → produces span list with labels
    → Run NER model (Transformers.js / ONNX) → produces entity spans with confidence
    → Merge: union of both, with source tagged per span
    → Flag quasi-identifiers separately (user must confirm handling)

[3] REPLACE
    → Pseudonymise mode: HMAC(secret, label+originalToken) → deterministic pseudonym
    → Anonymise mode: generalise or suppress per label type
    → Date handling: shift (pseudonymise) or generalise to year (anonymise)
    → Age > 89: always render as "90+" in both modes

[4] RISK SCORE
    → Compute k-anonymity on remaining quasi-identifiers
    → Compute l-diversity if sensitive attribute fields present
    → Assign overall risk level: LOW / MEDIUM / HIGH
    → HIGH = block output and require user to confirm or suppress more fields

[5] VALIDATE
    → Re-run detection engine on the de-identified output
    → Any identifier found = leak → surface to user, do not emit output

[6] OUTPUT
    → Reconstruct in original format
    → Generate audit log (JSON): timestamp, engine version, spans found,
      replacements made, risk score, mode used
    → Pseudonymise mode only: generate re-identification key file (JSON, encrypted
      with user passphrase via AES-GCM + PBKDF2)
    → Offer download: de-identified record + audit log [+ key file]
```

---

## File Format Handling

| Format | Parse | Reconstruct | Notes |
|---|---|---|---|
| Plain text (.txt) | Direct | String replacement | Full support v1 |
| FHIR R4 JSON | fhir.js | Field-level replacement, re-serialise | Full support v1 |
| HL7 v2 | Custom parser | Pipe-delimited field replacement | Full support v1 |
| Typed PDF | pdf.js extract → process → pdf-lib rebuild | Text layer replacement preserving layout | v1 |
| Scanned PDF (image) | Tesseract.js OCR → process → overlay | v1 with optimisation (see below) | v1 |
| DOCX | mammoth.js → text → process → reassemble OR export to MD/HTML | User chooses output format | v1 |
| HL7 FHIR XML | xml2js + FHIR logic | v2 | |
| CSV (structured records) | Papa Parse | Column-level replacement | v2 |

### Scanned PDF optimisation strategy

Tesseract.js is the bottleneck. To make it usable, the v1 pipeline uses these techniques:

1. **Web Worker offload** — OCR runs in a Web Worker so the UI stays responsive.
2. **Page parallelisation** — multiple Tesseract workers run concurrent pages
   (cap at `navigator.hardwareConcurrency - 1` to leave a core for UI).
3. **Resolution downsampling** — render pages at 200 DPI (not 300) for OCR. Sufficient
   for clinical document text in most cases. Fall back to 300 DPI if confidence < 80%.
4. **Pre-processing** — convert to greyscale and apply binarisation before OCR. Removes
   noise from scan artefacts and speeds recognition.
5. **Language pack scoping** — load only English + relevant LATEX traineddata, not the
   full multi-language pack. Saves ~30MB and speeds initialisation.
6. **Streaming output** — display redacted pages as they complete, do not wait for full
   document.
7. **Cancellation** — user can abort a slow OCR run without losing already-processed pages.

Output for scanned PDF: a new PDF with redaction boxes drawn over identifier locations
(coordinate-based, since we have OCR bounding boxes), plus the extracted de-identified text
as a separate searchable layer. Original image is not preserved — user is informed.

### DOCX dual output

User selects one of two output formats on the output screen:

**Option A — DOCX (similar to input)**
- mammoth.js extracts text, identifier replacement runs, then docx library rebuilds.
- Formatting is approximate: headings preserved, basic paragraph structure preserved,
  complex layouts (tables, images, comments) flattened or lost.
- Best for: handing back to the same workflow the original came from.

**Option B — Markdown or HTML (more readable)**
- mammoth.js converts DOCX to clean Markdown or styled HTML.
- Identifier replacement runs on the converted text.
- Output is more readable, easier to feed to AI tools, easier to view in any tool.
- Best for: research, AI ingestion, sharing for review.

Default selection: Option A. User can toggle on the output screen before download.

---

## NER Model

**Primary model**: `d4data/biomedical-ner-all` — a biomedical/clinical NER model trained
on medical text. Recognises entities including: disease, sign/symptom, medication, dosage,
biological structure, lab values, severity, history, family history, age, sex, clinical event,
duration, frequency, therapeutic procedure, diagnostic procedure, and more.

Exported to ONNX for Transformers.js. Quantised to INT8 to keep bundle under ~120MB.

**Generic entity fallback**: `Xenova/bert-base-NER` for PER / LOC / ORG entities the
clinical model may miss. Run both, union the results, deduplicate overlapping spans
(longest match wins, clinical model takes priority on ties).

**Model loading strategy**:
- Lazy-load on first use. Show download progress (this will be the first-load bottleneck).
- Cache in IndexedDB via Transformers.js built-in caching after first download.
- Show user a one-time "downloading clinical model (~120MB)" notice on first session.
- Subsequent sessions load from cache in under 2 seconds.

**Inference performance budget**:
- Plain text record (2-3 pages): under 5 seconds on modern desktop
- Long discharge summary (10+ pages): under 20 seconds
- If a record exceeds budget, chunk by paragraph and run sequentially with progress bar.

---

## Crypto Design

```typescript
// Pseudonym generation
// secret = 32-byte random key generated at session start, stored in memory only
async function generatePseudonym(secret: CryptoKey, label: string, token: string): Promise<string> {
  const data = new TextEncoder().encode(`${label}:${token}`);
  const sig = await crypto.subtle.sign('HMAC', secret, data);
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `[${label.toUpperCase()}-${hex.slice(0, 8).toUpperCase()}]`;
  // Output example: [NAME-3F7A91B2]
}

// Re-identification key file encryption
// Passphrase → PBKDF2 → AES-GCM → encrypted key blob → user downloads as .privacyscript.key
```

Session secret lives in memory only. On tab close it is gone.
The key file download is the only persistence mechanism. The user owns it entirely.

---

## UI / UX Flow

### Screen 1: Landing / Upload
- Headline: "De-identify health records. In your browser. Nothing leaves your device."
- Two large mode cards: **Pseudonymise** / **Anonymise** with plain-English explanation
  of the legal difference and when to use each.
- File drop zone: accepts .txt, .json (FHIR), .hl7, .pdf, .docx
- "No data is uploaded. Processing happens entirely on this device." — persistent notice.

### Screen 2: Processing
- Progress bar across the 6 pipeline stages.
- Live count: "X identifiers detected"
- Quasi-identifier review panel: list of flagged quasi-identifiers with suppress / keep toggle.
  User must confirm before pipeline proceeds past stage 3.

### Screen 3: Risk Assessment
- Risk level badge (LOW / MEDIUM / HIGH) with explanation.
- Table: identifier type | count found | action taken.
- k-anonymity score with brief explanation.
- HIGH risk: red banner, must confirm to proceed.

### Screen 4: Output
- Download buttons:
  - De-identified record (original format, or alternate format for DOCX inputs)
  - Audit log (.json)
  - Re-identification key (pseudonymise mode only, requires passphrase)
- **DOCX-specific**: format toggle (Rebuild as DOCX | Convert to Markdown | Convert to HTML)
- Preview panel: side-by-side diff view (original left, de-identified right).
  Redacted spans highlighted in indigo.
- "What can I do with this output?" — expandable guidance per mode.

### No account. No login. No history. Every session starts clean.

---

## Compliance Mapping

| Control | Regulation | Implementation |
|---|---|---|
| Special category data protection | GDPR Article 9 | Client-side processing; no transmission |
| Pseudonymisation definition met | GDPR Article 4(5) | HMAC with separate key; key stays with controller |
| Anonymisation threshold | GDPR Recital 26 | k-anonymity score + validation pass |
| HIPAA Safe Harbor path | §164.514(b) | All 18 identifiers detected and removed |
| Secondary use de-identification | EHDS Art. 50 | Anonymise mode output compliant with secondary use requirements |
| Audit trail | GDPR Article 30, HIPAA Accountability | Audit log generated per session |
| Age suppression | HIPAA §164.514(b)(2)(i) | Ages > 89 always rendered as "90+" |
| No data processor relationship | GDPR Article 28 | Client-side only; no DPA required between user and tool |
| Supply chain security | NIS2 Article 21 | Open source; no third-party API calls; auditable pipeline |

---

## Project Structure

```
privacyscript/
├── CLAUDE.md                        ← this file
├── public/
│   └── models/                      ← cached ONNX model files (gitignored if large)
├── src/
│   ├── app/
│   │   ├── page.tsx                 ← landing + upload (Screen 1)
│   │   ├── process/page.tsx         ← processing (Screen 2)
│   │   ├── review/page.tsx          ← risk assessment (Screen 3)
│   │   └── output/page.tsx          ← download (Screen 4)
│   ├── engine/
│   │   ├── ingest.ts                ← format detection and parsing
│   │   ├── detect.ts                ← regex rule engine (HIPAA 18 + EU)
│   │   ├── ner.ts                   ← Transformers.js NER wrapper
│   │   ├── replace.ts               ← pseudonymise / anonymise logic
│   │   ├── risk.ts                  ← k-anonymity, l-diversity scoring
│   │   ├── validate.ts              ← post-processing leak detection
│   │   ├── output.ts                ← format reconstruction
│   │   └── crypto.ts                ← HMAC pseudonym gen, AES-GCM key encryption
│   ├── formats/
│   │   ├── fhir.ts                  ← FHIR R4 parser / reconstructor
│   │   ├── hl7.ts                   ← HL7 v2 parser / reconstructor
│   │   ├── pdf-typed.ts             ← pdf.js + pdf-lib pipeline for typed PDFs
│   │   ├── pdf-scanned.ts           ← Tesseract.js OCR pipeline with Web Worker
│   │   └── docx.ts                  ← mammoth.js with dual output (rebuild or convert)
│   ├── components/
│   │   ├── ModeSelector.tsx
│   │   ├── DropZone.tsx
│   │   ├── PipelineProgress.tsx
│   │   ├── QuasiIdentifierReview.tsx
│   │   ├── RiskBadge.tsx
│   │   ├── DiffViewer.tsx
│   │   └── DownloadPanel.tsx
│   ├── hooks/
│   │   ├── useDeidentification.ts   ← orchestrates the pipeline
│   │   └── useSessionKey.ts         ← manages in-memory session secret
│   ├── workers/
│   │   └── ocr.worker.ts            ← Tesseract.js Web Worker for scanned PDF OCR
│   └── lib/
│       ├── identifiers.ts           ← full regex catalogue
│       └── constants.ts             ← k-anonymity thresholds, model URLs, etc.
├── next.config.js                   ← output: 'export', no server-side features
├── tailwind.config.js
└── package.json
```

---

## Build Sessions (Claude Code Plan)

| Session | Deliverable |
|---|---|
| 1 | Project scaffold, Next.js static export config, Tailwind + DM Sans/Mono, design tokens, TekDruid branding shell |
| 2 | `identifiers.ts` — full regex catalogue for HIPAA 18 + EU identifiers with unit tests |
| 3 | `detect.ts` — rule engine, span merging, quasi-identifier flagging |
| 4 | `ner.ts` — Transformers.js integration with `d4data/biomedical-ner-all`, ONNX loading, IndexedDB caching, generic NER fallback |
| 5 | `crypto.ts` — session key generation, HMAC pseudonym, AES-GCM key file encryption |
| 6 | `replace.ts` + `risk.ts` — pseudonymise/anonymise logic, k-anonymity scoring |
| 7 | `validate.ts` + `output.ts` — leak detection, audit log generation |
| 8 | Text formats: `fhir.ts`, `hl7.ts`, plain text |
| 9 | PDF pipeline: typed PDF via pdf.js + pdf-lib |
| 10 | Scanned PDF pipeline: Tesseract.js with Web Worker, parallel pages, downsampling, streaming |
| 11 | DOCX pipeline: mammoth.js with dual output (DOCX rebuild + MD/HTML export option) |
| 12 | Full UI: all 4 screens, DiffViewer, QuasiIdentifierReview, DownloadPanel, mode toggle |
| 13 | Integration: `useDeidentification.ts` hook wiring pipeline to UI |
| 14 | End-to-end testing with synthetic records (FHIR, HL7, plain text, typed PDF, scanned PDF, DOCX) |
| 15 | Compliance audit pass, README, Cloudflare Pages deployment |

---

## Resolved Decisions

1. **NER model**: `d4data/biomedical-ner-all` (clinical) as primary, `Xenova/bert-base-NER`
   as generic fallback. Both run, results unioned. Quantised to INT8 for browser delivery.
2. **Scanned PDF**: in v1. Optimised via Web Worker, parallel pages, downsampling,
   binarisation, streaming output, and cancellation. Slow on weak hardware — user warned.
3. **DOCX output**: user chooses between DOCX rebuild (approximate) or Markdown/HTML
   (more readable, AI-friendly). Default is DOCX rebuild.
4. **Branding**: PrivacyScript by TekDruid.

## Open Decisions

None blocking. v2 considerations (CSV support, HL7 FHIR XML, fine-tuned clinical model
retraining on a labelled dataset) deferred until v1 is shipped and tested.

---

## Non-negotiables (never compromise these)

- The original record must never be transmitted to any server, API, or third-party service.
- No analytics, no error tracking, no session logging of any kind.
- The re-identification key must never be stored by the app. Download only.
- If k-anonymity score is below 5, the tool must block output with a clear explanation.
- The compliance mode labels (Pseudonymise / Anonymise) must match their legal definitions
  under GDPR. Do not use them interchangeably in the UI.
- Audit log must be generated for every processing run and offered for download.
