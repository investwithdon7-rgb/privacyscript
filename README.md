# PrivacyScript by TekDruid

**Client-side health record de-identification.** GDPR, HIPAA, EHDS, UK GDPR, NIS2.

Live at **[tekdruid.com/privacyscript](https://tekdruid.com/privacyscript)**.

PrivacyScript pseudonymises or anonymises clinical records — FHIR R4 JSON, HL7 v2,
CSV, plain text, typed PDF, scanned PDF, DOCX — entirely in the browser. No upload.
No telemetry. No account. Every session starts clean and the original record never
leaves the device.

## Why client-side

Running detection, redaction, and (optional) NER in the browser is the only way to
guarantee under GDPR Article 9 / HIPAA Safe Harbor that the special-category data
never passes through a third-party processor. There is no DPA / BAA to negotiate with
us because we never see your data.

The compliance basis is mapped per control in [CLAUDE.md](./CLAUDE.md).

## Modes

| Mode | Legal basis | What it does | When to use |
|---|---|---|---|
| **Pseudonymise** | GDPR Art. 4(5) | Identifiers replaced with consistent HMAC-SHA256 tokens. Per-record date shift derived from the session secret. Re-identification key file downloadable, AES-GCM encrypted with your passphrase. | Analytics pipelines, research cohorts, internal data sharing where you remain the controller. |
| **Anonymise** | GDPR Recital 26 | One-way replacement. Dates → year only. Postcodes generalised. k-anonymity scored, output blocked if k < 5. | Feeding to AI tools without a BAA/DPA, public research datasets. |

The UI keeps the legal distinction unmistakable — these are not interchangeable.

## Identifier coverage

- **HIPAA Safe Harbor (18 identifiers)** — names, geographic subdivisions, dates,
  phone/fax, email, SSN, MRN, insurance number, account number, licence number, VIN,
  device serials, URLs, IPs, biometric descriptors, photographs (flagged only), and
  the catch-all unique identifier.
- **EU / UK** — NHS number, UK NINO, UK postcode, Denmark CPR, Netherlands BSN,
  Spain DNI/NIE, Italy CF, Switzerland AHV, IBAN, passport.
- **Quasi-identifiers** — ethnicity, occupation, institution, rare-disease ICD-10.
  Default-suppressed for codes in the Orphanet rare set; surfaced for user review
  otherwise.

## NER

In addition to regex detection, PrivacyScript runs **`Xenova/bert-base-NER`** via
Transformers.js (ONNX, INT8) to catch free-text **PER / LOC / ORG** entities the regex
layer cannot. The model loads lazily on first detection, caches in IndexedDB after
first download (~50MB), and runs entirely on-device. If the model fails to load (e.g.
offline first session) the regex catalogue carries detection alone.

The clinical model `d4data/biomedical-ner-all` is the v2 target — it requires ONNX
conversion + hosting on a bundled CDN before we ship.

## Rare-disease ICD-10 catalogue

The rare-disease catalogue ships as a static JSON file generated at build time from
**[Orphadata](https://www.orphadata.com)**:

- `en_product1.xml` — disease → ICD-10 alignments.
- `en_product9_prev.xml` — point prevalence per disease.

The build pipeline (`scripts/build-rare-icd.js --refresh`) joins these on Orpha code,
normalises prevalence to cases-per-million, and emits two tiers in
`src/lib/rare-icd10.json`:

- **`flag`** — prevalence ≤ 1:10,000. Surface for user review.
- **`auto`** — prevalence ≤ 1:100,000. Auto-suppress by default in the UI.

The current snapshot covers ~912 ICD-10 head codes derived from ~7,500 disorders.

### Attribution (CC BY 4.0)

> Rare disease ICD-10 catalogue derived from Orphanet/Orphadata (INSERM US14),
> licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
> [orphadata.com](https://www.orphadata.com).

This attribution is also embedded in the engine source and surfaces in the per-record
audit log.

## Pipeline

```
[1] INGEST     → format detection, parse into spans / leaves / pages
[2] DETECT     → regex catalogue ∪ NER, span merge, quasi-identifier flag
[3] REPLACE    → HMAC pseudonym or generalisation, date shift, age >89 → "90+"
[4] RISK       → k-anonymity heuristic, l-diversity (sensitive attrs)
[5] VALIDATE   → re-scan output for original-value or residual regex leaks
[6] OUTPUT     → reconstruct in original format + audit log [+ key file]
```

Every stage is independently logged. The audit log is downloadable and contains
**no original identifier values** — only labels, counts, and risk metadata.

## Network policy

PrivacyScript makes **no** request to a backend run by us. The only network calls in
the lifetime of a session are:

1. The static asset bundle (HTML, JS, CSS, fonts, PDF worker) from Cloudflare Pages.
2. The Orphanet ICD-10 catalogue, **already shipped inside the bundle** — no runtime
   fetch.
3. **First-load only**: the NER model files from Hugging Face's CDN
   (`huggingface.co` and `cdn-lfs.huggingface.co`), cached in IndexedDB after.
   Subsequent sessions are fully offline-capable.

No record content is ever transmitted. The CSP in `public/_headers` enforces this.

## Development

```bash
npm install
npm run dev               # http://localhost:3000/privacyscript
npm test                  # vitest
npm run build             # → out/
node scripts/build-rare-icd.js --refresh   # regenerate Orphanet catalogue
```

For a root-mount dev experience (no `/privacyscript` prefix locally):

```bash
NEXT_PUBLIC_BASE_PATH= npm run dev
```

## Deployment

PrivacyScript ships as a single **Cloudflare Worker with Static Assets**,
routed at `tekdruid.com/privacyscript` — single origin with the rest of
TekDruid, no separate Pages project.

### Topology

```
tekdruid.com/*               → Bluehost (existing marketing site)
tekdruid.com/privacyscript*  → Cloudflare Worker "privacyscript" (serves out/ as static assets)
```

The static export is built with `basePath=/privacyscript`, so every URL the
app emits carries the prefix, while the files live unprefixed in the asset
store. The tiny script in `cloudflare/worker.js` strips the prefix before
asset lookup. Configuration lives in `wrangler.jsonc` (worker name, assets
directory, route).

### Automatic deploys (Workers Builds)

The Worker is connected to this GitHub repository. Every push to `main`
builds and deploys production; non-production branches get preview versions.

| Field | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

`NEXT_PUBLIC_BASE_PATH` defaults to `/privacyscript` via `.env.production` —
no dashboard variables required.

### Manual deploy

```bash
npm run build
npx wrangler deploy
```

Requires `wrangler login` or `CLOUDFLARE_API_TOKEN`. Validate config changes
without deploying: `npx wrangler deploy --dry-run`.

## Non-negotiables

These constraints are binding (see CLAUDE.md):

1. The original record never leaves the device.
2. No analytics, no error tracking, no session logging.
3. The re-identification key is never stored by the app. Download only.
4. k-anonymity < 5 in Anonymise mode → output blocked with explanation.
5. Pseudonymise / Anonymise labels must match their GDPR legal definitions.
6. Audit log generated every run, no original identifier values.
7. Ages > 89 always rendered as "90+" (HIPAA §164.514(b)(2)(i)).

## Licence

Source code: see [LICENSE](./LICENSE) (TBD).

Rare-disease catalogue: derived from Orphanet/Orphadata (INSERM US14),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
