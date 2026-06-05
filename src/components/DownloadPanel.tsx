'use client';

import { useState } from 'react';
import type { Mode } from '@/lib/constants';
import { downloadBlob, downloadJSON, downloadText, generateComplianceReportPdf } from '@/engine/output';
import { encryptKeyFile } from '@/engine/crypto';
import { useSession } from '@/hooks/useSession';
import { updateSession } from '@/state/session';
import { rerenderDocxOutput } from '@/hooks/useDeidentification';
import type { DocxOutputFormat } from '@/formats/docx';

const FORMAT_EXT: Record<string, string> = {
  TEXT: 'txt',
  FHIR_R4: 'json',
  HL7_V2: 'hl7',
  DOCX: 'docx',
  PDF_TYPED: 'pdf',
  PDF_SCANNED: 'pdf',
  CSV: 'csv',
  DICOM: 'dcm',
};

const MIME: Record<string, string> = {
  TEXT: 'text/plain',
  FHIR_R4: 'application/json',
  HL7_V2: 'application/hl7-v2',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF_TYPED: 'application/pdf',
  PDF_SCANNED: 'application/pdf',
  CSV: 'text/csv',
  DICOM: 'application/dicom',
};

export function DownloadPanel({ mode }: { mode: Mode }) {
  const s = useSession();
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyDownloaded, setKeyDownloaded] = useState(false);

  if ((!s.deidentifiedOutput && !s.deidentifiedBytes) || !s.audit) return null;

  const baseName = (s.filename ?? 'record').replace(/\.[^.]+$/, '');
  const isDocx = s.format === 'DOCX';
  const ext = isDocx
    ? docxExt(s.docxFormat)
    : FORMAT_EXT[s.format ?? 'TEXT'] ?? 'txt';
  const mime = isDocx
    ? docxMime(s.docxFormat)
    : MIME[s.format ?? 'TEXT'] ?? 'text/plain';

  const downloadRecord = () => {
    const filename = `${baseName}.deidentified.${ext}`;
    // DICOM: the cleaned binary is stored in sourceBytes (set by the ingest step)
    if (s.format === 'DICOM' && s.sourceBytes) {
      downloadBlob(new Blob([s.sourceBytes], { type: 'application/dicom' }), filename);
    } else if (s.deidentifiedBytes) {
      downloadBlob(new Blob([s.deidentifiedBytes], { type: mime }), filename);
    } else if (s.deidentifiedOutput !== null) {
      downloadText(s.deidentifiedOutput, filename, mime);
    }
  };

  const downloadAudit = () => downloadJSON(s.audit, `${baseName}.audit.json`);

  const downloadComplianceReport = async () => {
    if (!s.audit) return;
    const nerLeakCount = s.validation?.nerLeaks?.length ?? 0;
    const bytes = await generateComplianceReportPdf(
      s.audit,
      nerLeakCount,
      baseName
    );
    downloadBlob(
      new Blob([bytes], { type: 'application/pdf' }),
      `${baseName}.compliance-report.pdf`
    );
  };

  const onDocxFormatChange = async (next: DocxOutputFormat) => {
    updateSession({ docxFormat: next });
    await rerenderDocxOutput();
  };

  const downloadKey = async () => {
    setKeyError(null);
    if (passphrase.length < 12) {
      setKeyError('Passphrase must be at least 12 characters.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setKeyError('Passphrases do not match.');
      return;
    }
    if (!s.secret || !s.replacement) {
      setKeyError('No session key available — re-run the pipeline.');
      return;
    }
    try {
      const blob = await encryptKeyFile(
        s.secret.rawKey,
        s.replacement.mapping,
        passphrase
      );
      downloadJSON(blob, `${baseName}.privacyscript.key`);
      setKeyDownloaded(true);
      setPassphrase('');
      setConfirmPassphrase('');
    } catch (e) {
      setKeyError((e as Error).message);
    }
  };

  return (
    <div className="surface rounded-2xl p-6 mt-6">
      <h2 className="text-lg font-semibold mb-4">Downloads</h2>

      {isDocx ? (
        <div className="surface-2 rounded-xl p-4 mb-4">
          <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
            DOCX output format
          </div>
          <div className="flex gap-2 flex-wrap">
            {(['DOCX', 'MARKDOWN', 'HTML'] as DocxOutputFormat[]).map((f) => (
              <button
                key={f}
                onClick={() => onDocxFormatChange(f)}
                className={`px-4 py-2 rounded-full text-sm border ${
                  s.docxFormat === f
                    ? 'bg-[#4F46E5] text-white border-[#4F46E5]'
                    : 'border-[color:var(--color-border)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-2)]'
                }`}
              >
                {f === 'DOCX'
                  ? 'Rebuild .docx'
                  : f === 'MARKDOWN'
                  ? 'Convert to Markdown'
                  : 'Convert to HTML'}
              </button>
            ))}
          </div>
          <div className="text-xs text-[color:var(--color-muted)] mt-3">
            {s.docxFormat === 'DOCX'
              ? 'Best for handing back to the same workflow. Formatting is approximate.'
              : s.docxFormat === 'MARKDOWN'
              ? 'Best for AI ingestion and reviewing in any text tool.'
              : 'Styled HTML — preserves more layout than Markdown.'}
          </div>
        </div>
      ) : null}

      <div className="grid md:grid-cols-3 gap-4">
        <button onClick={downloadRecord} className="btn-primary">
          De-identified record (.{ext})
        </button>
        <button onClick={downloadAudit} className="btn-secondary">
          Audit log (.json)
        </button>
        <button onClick={() => void downloadComplianceReport()} className="btn-secondary">
          Compliance report (.pdf)
        </button>
      </div>

      {mode === 'PSEUDONYMISE' ? (
        <div className="mt-6 surface-2 rounded-xl p-4">
          <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
            Re-identification key
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mb-4">
            Your key is encrypted with this passphrase using PBKDF2 + AES-GCM (600k iterations).
            The passphrase is never stored. <strong>If you lose it, the data is unrecoverable.</strong>
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <input
              type="password"
              placeholder="Passphrase (≥ 12 chars)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="password"
              placeholder="Confirm passphrase"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              className="bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {keyError ? (
            <div className="text-sm mt-3" style={{ color: 'var(--color-danger)' }}>
              {keyError}
            </div>
          ) : null}
          <button
            type="button"
            onClick={downloadKey}
            disabled={!passphrase || !confirmPassphrase}
            className="btn-primary mt-4"
          >
            {keyDownloaded ? 'Download again' : 'Download encrypted key'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function docxExt(f: DocxOutputFormat): string {
  return f === 'DOCX' ? 'docx' : f === 'MARKDOWN' ? 'md' : 'html';
}

function docxMime(f: DocxOutputFormat): string {
  return f === 'DOCX'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : f === 'MARKDOWN'
    ? 'text/markdown'
    : 'text/html';
}
