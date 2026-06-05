# Introducing PrivacyScript: Zero-Trust Client-Side Clinical De-Identification

In the modern healthcare landscape, data is the most valuable asset for clinical research, analytics, and powering artificial intelligence. However, sharing this data is governed by strict regulatory frameworks—such as **GDPR (Articles 4(5), 9, Recital 26)**, **HIPAA §164.514**, the **European Health Data Space (EHDS)**, and **UK GDPR**.

Historically, clinical de-identification meant deploying heavy enterprise servers, routing sensitive data through cloud APIs, and negotiating complex Data Processing Agreements (DPAs) or Business Associate Agreements (BAAs). 

**PrivacyScript by TekDruid** completely redefines this paradigm. It is a **100% client-side, browser-based, zero-trust health record de-identification tool** that ensures your clinical records never leave your local device.

---

## Why PrivacyScript is Needed: Resolving the Compliance Gridlock

For healthcare providers, medical researchers, and pharmaceutical companies, data sharing is often bottlenecked by two critical challenges:

1. **The Legal Overhead of Cloud Processors:** Standard cloud-based de-identification engines require sending data to a third-party server. Under GDPR Article 9 (special-category data) and HIPAA, this mandates extensive security audits, legal reviews, and DPAs/BAAs.
2. **The LLM & Generative AI Boom:** Organizations are eager to feed clinical notes, discharge summaries, and patient reports into Large Language Models (LLMs) to automate coding, extract insights, or draft summaries. However, sending raw Protected Health Information (PHI) to external AI APIs is an immediate compliance violation.

### The Client-Side Guarantee
PrivacyScript executes all parsing, regex-matching, cryptographic tokenization, Named Entity Recognition (NER), and risk scoring **directly inside the web browser**. 

* **No server-side uploads:** The application code is served as a static bundle via a global CDN. No backend server ever receives or processes your records.
* **No telemetry or logging:** Zero tracking, zero session logs, and zero database entries. Your data remains entirely yours.
* **No DPA/BAA required:** Because TekDruid never touches, sees, or transmits your clinical data, there is no third-party processor relationship to establish.

---

## What PrivacyScript Can Do: Key Features & Capabilities

PrivacyScript is engineered from the ground up to handle the complexity and heterogeneity of clinical documentation.

### 1. Multi-Format Ingestion & Reconstruction
PrivacyScript parses raw clinical files, runs them through the de-identification pipeline, and reconstructs them in their original structure:
* **Structured Data:** Native support for **FHIR R4 JSON** (field-level processing) and **HL7 v2** (pipe-delimited fields).
* **Unstructured Documents:** Plain text (`.txt`) and Microsoft Word (`.docx`).
* **PDF Engine:** 
  * **Typed PDFs:** Parses and rebuilds the PDF, redacting the text layer while preserving the original layout.
  * **Scanned PDFs:** Uses browser-based **Tesseract.js OCR** running in multi-threaded Web Workers to recognize text, draw coordinates, overlay black redaction boxes, and inject a clean de-identified text layer.

### 2. Dual Regulatory Compliance Modes
PrivacyScript implements two distinct, legally defined modes of operation. They are not interchangeable and are presented with clear compliance guidance:

* **Pseudonymise Mode (GDPR Art. 4(5)):** 
  * Replaces patient identifiers with consistent, deterministic **HMAC-SHA256** tokens keyed to an in-memory session secret.
  * Ensures patient records map to the same pseudonym across different documents in a single session (linkability).
  * Shifts dates consistently per record (protecting timeline logic).
  * Generates an **AES-GCM encrypted re-identification key file** (secured with a user-defined passphrase) which is downloaded locally. The key never touches our servers.
  * *Best for:* Analytics pipelines, research cohorts, and internal data sharing where you remain the data controller.

* **Anonymise Mode (GDPR Recital 26):**
  * Applies one-way, irreversible destruction of identifiers.
  * Generalizes dates to year-only, suppresses quasi-identifiers, and generalizes postcodes.
  * Evaluates a **k-anonymity scoring algorithm** to measure re-identification risk. If the score is below the safe threshold ($k < 5$), the tool blocks output to prevent accidental re-identification.
  * *Best for:* Feeding data to third-party LLMs/AI tools without a BAA, and publishing public research datasets.

### 3. Comprehensive Identifier Coverage
PrivacyScript detects and removes a vast catalog of identifiers covering global standards:
* **HIPAA Safe Harbor (All 18 Identifiers):** Names, locations, detailed dates (ages > 89 are automatically converted to "90+"), contact details, biometric descriptions, SSN, MRN, IP addresses, URLs, and unique serial numbers.
* **EU/UK Identifiers:** NHS numbers, National Insurance Numbers (NINO), EU national IDs (Denmark CPR, Netherlands BSN, Spain DNI, Italy CF, Switzerland AHV), IBANs, and passport numbers.
* **Clinical Quasi-Identifiers:** Ethnicity, race, occupation, treating institutions, and **rare diseases** (cross-referencing an offline **Orphanet ICD-10** catalog at build-time to flag or auto-suppress rare disease codes with low prevalence that could easily trigger re-identification).

### 4. Browser-Based Named Entity Recognition (NER)
A key vulnerability of rule-based de-identification is free-text clinical notes. PrivacyScript solves this by running an advanced deep learning model directly on-device using **Transformers.js (ONNX Runtime, INT8 quantised)**:
* **Primary Clinical Model:** Integrates `d4data/biomedical-ner-all` to detect clinical events, medication, dosages, diagnostic procedures, signs, and symptoms.
* **Generic Fallback:** Runs `Xenova/bert-base-NER` to capture name, location, and organization entities.
* The model loads lazily on first run and is cached inside the browser's IndexedDB (~120MB), making all subsequent sessions fully offline-capable and highly performant.

---

## How the PrivacyScript Pipeline Works

```
[1] INGEST     → Format detection (FHIR, HL7, PDF, DOCX, TXT) & parsing
[2] DETECT     → Regex Engine (HIPAA + EU) + ONNX NER (Biomedical model)
[3] REPLACE    → Pseudonymisation (HMAC) or Anonymisation (Generalisation)
[4] RISK       → Heuristic risk scoring (k-anonymity, l-diversity checks)
[5] VALIDATE   → Security re-scan on de-identified output to prevent residual leaks
[6] OUTPUT     → Reconstructed original format + clean Audit Log [+ Key File]
```

---

## Conclusion: The New Standard for Secure Health Data Sharing

PrivacyScript represents a massive leap forward in healthcare data privacy. By proving that advanced clinical parsing, Named Entity Recognition, and cryptography can be done **entirely on-device in a standard web browser**, it removes the legal friction of data sharing. 

Whether you are preparing a cohort for an oncology study, strip-mining identifiers to query clinical cases against an AI chatbot, or cleaning FHIR streams for research databases, PrivacyScript makes compliance as simple as a drag-and-drop.

*Learn more and try it today at **[tekdruid.com/privacyscript](https://tekdruid.com/privacyscript)**.*
