# Compliance Check Design

Date: 2026-06-05
Product: PrivacyScript by TekDruid
Status: Approved for implementation planning

## Purpose

Add a third core capability to PrivacyScript: a non-destructive Compliance Check
that scans an uploaded or pasted health document and tells the user whether it
appears safe to distribute or upload to an AI processor.

The feature exists for users who do not yet know whether they need
anonymisation or pseudonymisation. It should answer the practical question:

> Can I safely share this document or upload it to an AI tool?

The checker does not provide legal advice and must not claim formal legal
certification. It provides client-side risk screening based on detected
identifiers, health data signals, jurisdiction profile, and conservative
AI-upload safety rules.

## Product Model

The landing page should present two top-level jobs:

1. Check Compliance
   - Assess whether a document appears safe to share or upload to AI.
   - Scan for PII, PHI, health data, direct identifiers, quasi-identifiers, and
     rare/high-risk health clues.
   - Produce a report and recommended next actions without modifying the
     document.

2. De-identify
   - Make a document safer by transforming it.
   - Offer two sub-modes:
     - Anonymise: irreversible removal/generalisation, recommended for external
       sharing and AI upload where no compliant processor relationship exists.
     - Pseudonymise: reversible tokenisation with a user-held key, recommended
       for internal analytics or research where the controller keeps the key.

This structure frames the app around two user intents: assess risk, then fix the
document if necessary.

## Jurisdiction Profiles

V1 includes four user-selected profiles. PrivacyScript should not infer country
from IP, locale, browser settings, or telemetry.

1. EU
   - Primary concerns: GDPR, EU AI Act, EHDS secondary use.
   - Health data is treated as special-category data.
   - AI upload should be considered unsafe when identifiable health data is
     present unless the user has a compliant legal basis and processor/provider
     arrangement.

2. UK
   - Primary concerns: UK GDPR, Data Protection Act 2018, ICO AI/data protection
     and anonymisation guidance.
   - Health data is treated as special-category data.
   - AI upload should be considered unsafe when identifiable health data is
     present unless the user has an appropriate legal basis and processor
     arrangement.

3. US
   - Primary concerns: HIPAA de-identification, PHI sharing, and AI processor
     caution.
   - Strong identifiers or health data should trigger a warning that upload is
     unsafe unless the recipient is covered by a suitable agreement such as a
     BAA or equivalent compliant arrangement.

4. General / International
   - Conservative global profile for users unsure of jurisdiction.
   - Any direct identifier plus health context should lead to a recommendation
     to anonymise before public distribution or AI upload.

Future profiles may add China, South Korea, Japan, US state-specific AI/privacy
rules, or sector-specific frameworks. They are out of scope for v1.

## Verdict Levels

Compliance Check returns exactly one of three verdict levels:

1. Safe
   - No meaningful sensitive data was detected.
   - User-friendly description: "No obvious personal or health identifiers were
     found. Review the document manually before sharing."

2. Needs de-identification
   - Sensitive data was detected, but risk appears reducible through
     anonymisation or pseudonymisation.
   - User-friendly description: "This document contains personal or health
     information. De-identify it before distribution or AI upload."

3. Do not upload/share
   - Strong direct identifiers, health data, rare disease clues, or unsafe
     jurisdiction/profile conditions were detected.
   - User-friendly description: "This document appears unsafe to share or upload
     to AI unless you have a compliant legal basis and processor agreement."

The verdict should be conservative. When in doubt, prefer "Needs
de-identification" over "Safe" and "Do not upload/share" over "Needs
de-identification" for strong identifiers plus health context.

## Findings Model

The report should include a findings table with:

- Identifier or data type, such as NAME, EMAIL, NHS_NUMBER, MRN, DATE,
  HEALTH_CONTEXT, RARE_DISEASE_ICD, INSTITUTION, OCCUPATION, ETHNICITY.
- Count.
- Severity: low, medium, high.
- Legal/compliance concern for the selected profile.
- Short context snippet.
- Exact detected value hidden by default.

Exact detected values are reveal-on-click only. The default report view must not
casually re-display sensitive data.

## Recommended Actions

The report should offer:

- Anonymise this document.
- Pseudonymise this document.
- Download compliance report.

When the verdict is "Do not upload/share" or the report says "unsafe for AI
upload", "Anonymise this document" should be the primary recommended action.

The action buttons should reuse the current document and detection results where
safe to do so, instead of forcing a second upload. The transition into
de-identification should preserve the selected jurisdiction/profile and preselect
risky fields for suppression when possible.

## Architecture

Add a compliance-check path that reuses existing engine pieces but remains
non-destructive:

1. Ingest
   - Reuse existing format ingestion where practical.
   - For v1, compliance checking can operate on extracted text and parsed
     structured leaves, just like the current detect stage.

2. Detect
   - Reuse `detect` and `runClinicalNER`.
   - Add health-data signal detection if current identifiers do not expose
     enough clinical context for AI-upload safety decisions.

3. Assess Compliance
   - Add a new compliance assessment module that maps detection results and the
     selected profile to:
     - verdict
     - AI upload safety conclusion
     - distribution safety conclusion
     - findings
     - recommended actions
     - plain-language explanation

4. Report
   - Add a compliance report screen or mode-specific report panel.
   - Downloadable report must contain no original values unless the user
     explicitly chooses an export that includes revealed findings. The default
     downloadable report should be safe to share and include only types, counts,
     severity, and explanations.

5. Action path
   - "Anonymise this document" and "Pseudonymise this document" should route
     into the existing de-identification flow.
   - The document should not be uploaded again.

## UI Flow

Landing:

- Two top-level choices:
  - Check Compliance
  - De-identify
- De-identify expands or routes to:
  - Anonymise
  - Pseudonymise

Check Compliance screen:

- Jurisdiction selector with four profiles: EU, UK, US, General / International.
- Upload/paste control.
- Persistent notice: processing happens entirely on this device.

Compliance report screen:

- Verdict badge.
- Short user-friendly verdict explanation.
- "Safe for distribution?" conclusion.
- "Safe to upload to AI?" conclusion.
- Selected jurisdiction/profile.
- Findings table with hidden exact values and reveal-on-click.
- Recommended action buttons.

## Error Handling

- If ingestion fails, show a plain-language error and allow the user to start
  again.
- If NER fails or is unavailable, continue with rule-based detection and show
  a warning that the scan is less complete.
- If a binary format cannot expose text for compliance checking, show a clear
  limitation rather than marking it safe.
- Never transmit the document, extracted text, findings, or report content to a
  server.

## Testing

Unit tests:

- Verdict mapping for each jurisdiction profile.
- Safe / Needs de-identification / Do not upload/share thresholds.
- Hidden-value finding representation.
- AI-upload safety conclusions.

Integration tests:

- Synthetic text with no identifiers returns Safe.
- Synthetic clinical text with names, dates, MRNs, and health context returns
  Do not upload/share for EU, UK, US, and General profiles.
- Direct identifiers without health context return at least Needs
  de-identification.
- Report generation excludes exact values by default.
- Recommended action for unsafe AI upload is Anonymise.

Manual UI checks:

- Landing page makes Check Compliance and De-identify distinct.
- Report language is user-friendly and not legalistic.
- Reveal-on-click does not expose values by default.
- Action buttons route to the existing de-identification flow.

## Source Notes

The regulatory framing should stay conservative and cite official or primary
sources in product copy or documentation where appropriate:

- GDPR Regulation (EU) 2016/679, including Article 9 special-category data.
- EU AI Act official European Commission / digital strategy materials.
- HIPAA de-identification guidance from HHS.
- UK ICO anonymisation and AI/data protection guidance.

The app should avoid legal-advice phrasing. Use wording like "appears unsafe",
"recommended", "review manually", and "unless you have a compliant legal basis
and processor agreement."
