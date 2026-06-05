'use client';

/**
 * Batch de-identification hook.
 *
 * Accepts a FileList (from a folder drop or ZIP). For each file it runs the
 * full detect → replace → validate pipeline, collects results, and makes them
 * available for download as a ZIP archive (using JSZip, lazily imported).
 *
 * The hook is entirely client-side — no data leaves the browser.
 */

import { useState, useCallback } from 'react';
import { detect } from '@/engine/detect';
import { runClinicalNER } from '@/engine/ner';
import { replaceSpans } from '@/engine/replace';
import { assessRisk } from '@/engine/risk';
import { validate } from '@/engine/validate';
import { buildAuditLog } from '@/engine/output';
import { detectFormat, readFileAsText } from '@/engine/ingest';
import { generateSessionSecret } from '@/engine/crypto';
import type { Mode, ComplianceProfileId } from '@/lib/constants';
import { COMPLIANCE_PROFILES } from '@/lib/constants';

export type BatchItemStatus = 'pending' | 'processing' | 'done' | 'error';

export interface BatchItem {
  id: string;
  filename: string;
  size: number;
  status: BatchItemStatus;
  error?: string;
  spansFound?: number;
  riskLevel?: string;
  validationPassed?: boolean;
}

export interface BatchResult {
  items: BatchItem[];
  total: number;
  done: number;
  errors: number;
  isRunning: boolean;
  isFinished: boolean;
  downloadZip: (() => Promise<void>) | null;
}

/**
 * Process multiple files through the de-identification pipeline.
 * Returns live status for each file and a downloadZip function when complete.
 */
export function useBatchDeidentification() {
  const [result, setResult] = useState<BatchResult>({
    items: [],
    total: 0,
    done: 0,
    errors: 0,
    isRunning: false,
    isFinished: false,
    downloadZip: null,
  });

  const runBatch = useCallback(
    async (files: File[], mode: Mode, profileId: ComplianceProfileId) => {
      const profile = COMPLIANCE_PROFILES[profileId];

      // Build initial item list
      const items: BatchItem[] = files.map((f, i) => ({
        id: String(i),
        filename: f.name,
        size: f.size,
        status: 'pending',
      }));
      setResult({ items: [...items], total: files.length, done: 0, errors: 0, isRunning: true, isFinished: false, downloadZip: null });

      // Shared pseudonymisation secret for the batch (all files get the same mapping).
      const secret = mode === 'PSEUDONYMISE' ? await generateSessionSecret() : undefined;

      // Output store: filename → Blob for zip bundling.
      const outputs: Array<{ name: string; blob: Blob; audit: object }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const item = items[i];

        // Mark as processing
        item.status = 'processing';
        setResult((prev) => ({ ...prev, items: [...items] }));

        try {
          // Ingest
          let text: string;
          const format = detectFormat(file.name, '');
          if (format === 'PDF_TYPED' || format === 'PDF_SCANNED' || format === 'DOCX' || format === 'DICOM') {
            // Binary formats: use a plain text extraction for batch mode.
            // (Full binary reconstruction is a v2 feature for batch.)
            text = `[Binary format ${format} — text extraction not available in batch mode. File: ${file.name}]`;
          } else {
            text = await readFileAsText(file);
          }

          // NER + detect
          const nerSpans = await runClinicalNER(text);
          const detection = detect(text, nerSpans);

          // Replace
          const autoRedact = new Set(
            profile.suppressAllQuasi
              ? detection.quasiSpans.map((q) => q.label)
              : detection.quasiSpans
                  .filter((q) => q.label === 'RARE_DISEASE_ICD' && q.rareTier === 'auto')
                  .map((q) => q.label)
          );

          const replacement = await replaceSpans(
            text,
            detection.spans,
            detection.quasiSpans,
            { mode, secret, quasiToRedact: autoRedact }
          );

          // Risk + validate
          const retainedQuasi = detection.quasiSpans.filter((q) => !autoRedact.has(q.label));
          const risk = assessRisk({
            detectedSpans: detection.spans,
            retainedQuasiSpans: retainedQuasi,
            recordCount: 1,
            kThreshold: profile.kThreshold,
          });
          const validation = await validate(replacement.text, {
            mode,
            originalIdentifiers: Object.keys(replacement.mapping),
          });

          const audit = buildAuditLog({
            mode,
            inputFormat: format,
            inputSize: file.size,
            outputSize: replacement.text.length,
            detectedSpans: detection.spans,
            replacementsMade: replacement.replacements.length,
            risk,
            validationPassed: validation.passed,
            complianceProfile: profileId,
          });

          // Store output
          outputs.push({
            name: file.name.replace(/\.[^.]+$/, '') + '.deidentified.txt',
            blob: new Blob([replacement.text], { type: 'text/plain' }),
            audit,
          });

          item.status = 'done';
          item.spansFound = detection.spans.length;
          item.riskLevel = risk.level;
          item.validationPassed = validation.passed;
        } catch (err) {
          item.status = 'error';
          item.error = (err as Error).message;
        }

        const done = items.filter((x) => x.status === 'done').length;
        const errors = items.filter((x) => x.status === 'error').length;
        setResult((prev) => ({ ...prev, items: [...items], done, errors }));
      }

      // Build downloadZip closure
      const downloadZip = async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        const deIdFolder = zip.folder('deidentified')!;
        const auditFolder = zip.folder('audits')!;

        for (const out of outputs) {
          deIdFolder.file(out.name, out.blob);
          auditFolder.file(out.name.replace('.txt', '.audit.json'), JSON.stringify(out.audit, null, 2));
        }

        // Secret mapping (pseudonymise only)
        if (mode === 'PSEUDONYMISE' && secret) {
          zip.file(
            'batch-session-secret.KEEP-SAFE.json',
            JSON.stringify({
              note: 'Keep this secret. Required to reverse pseudonyms.',
              sessionSecretHex: Array.from(secret.rawKey)
                .map((b: number) => b.toString(16).padStart(2, '0'))
                .join(''),
            }, null, 2)
          );
        }

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'privacyscript-batch.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      };

      setResult((prev) => ({
        ...prev,
        isRunning: false,
        isFinished: true,
        downloadZip,
      }));
    },
    []
  );

  return { result, runBatch };
}
