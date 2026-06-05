'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { ComplianceModeSelector } from '@/components/ComplianceModeSelector';
import { useBatchDeidentification, type BatchItem } from '@/hooks/useBatchDeidentification';
import type { Mode, ComplianceProfileId } from '@/lib/constants';
import { COMPLIANCE_PROFILES, DEFAULT_COMPLIANCE_PROFILE } from '@/lib/constants';

function RiskPill({ level }: { level?: string }) {
  if (!level) return null;
  const colour =
    level === 'LOW' ? '#10B981' : level === 'MEDIUM' ? '#F59E0B' : '#EF4444';
  return (
    <span
      className="mono text-[10px] px-2 py-0.5 rounded-full font-semibold"
      style={{ background: `${colour}22`, color: colour, border: `1px solid ${colour}44` }}
    >
      {level}
    </span>
  );
}

function StatusIcon({ status }: { status: BatchItem['status'] }) {
  if (status === 'pending') {
    return <span className="mono text-xs text-[color:var(--color-muted)]">Queued</span>;
  }
  if (status === 'processing') {
    return (
      <span className="inline-flex items-center gap-2 mono text-xs text-[color:var(--color-muted)]">
        <span className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        Working
      </span>
    );
  }
  if (status === 'done') {
    return <span className="mono text-xs font-semibold" style={{ color: '#10B981' }}>Done</span>;
  }
  return <span className="mono text-xs font-semibold" style={{ color: '#EF4444' }}>Failed</span>;
}

export default function BatchPage() {
  const router = useRouter();
  const { result, runBatch } = useBatchDeidentification();
  const [profileId, setProfileId] = useState<ComplianceProfileId>(DEFAULT_COMPLIANCE_PROFILE);
  const [showProfiles, setShowProfiles] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [hot, setHot] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = COMPLIANCE_PROFILES[profileId];
  const effectiveMode: Mode = profile.recommendedMode;

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const accepted = Array.from(fileList).filter((f) => f.size < 50 * 1024 * 1024);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...accepted.filter((f) => !names.has(f.name))];
    });
  };

  const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const startBatch = async () => {
    if (files.length === 0) return;
    await runBatch(files, effectiveMode, profileId);
  };

  const profileDef = profile;

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Batch processing" />

      <section className="mt-12">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-3xl font-bold">Batch de-identification</h1>
          <button
            onClick={() => router.push('/')}
            className="btn-secondary text-sm"
          >
            Back to single record
          </button>
        </div>

        {!result.isRunning && !result.isFinished ? (
          <>
            {/* Step 1: Compliance */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
                  Step 1. Where will this data go?
                </h2>
                <button
                  onClick={() => setShowProfiles((p) => !p)}
                  className="mono text-xs text-[color:var(--color-muted)] hover:text-white"
                >
                  {showProfiles ? 'Hide' : 'Change'}
                </button>
              </div>
              {showProfiles ? (
                <ComplianceModeSelector value={profileId} onChange={(id) => { setProfileId(id); }} />
              ) : (
                <div className="surface rounded-xl px-5 py-3">
                  <span className="font-semibold">{profileDef.label}</span>
                  <span className="mono text-xs text-[color:var(--color-muted)] ml-3">{profileDef.regulation}</span>
                </div>
              )}
            </div>

            {/* Step 2: Files */}
            <div className="mb-8">
              <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
                Step 2. Add files
              </h2>

              {/* Drop zone */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); setHot(true); }}
                onDragLeave={() => setHot(false)}
                onDrop={(e) => { e.preventDefault(); setHot(false); handleFiles(e.dataTransfer.files); }}
                className="surface rounded-2xl p-8 text-center border-2 border-dashed cursor-pointer transition-colors"
                style={{ borderColor: hot ? '#4F46E5' : 'var(--color-border)' }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".txt,.json,.hl7,.pdf,.docx,.csv,.tsv,.dcm"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <div className="text-lg font-semibold mb-2">Drop files or click to add</div>
                <div className="text-sm text-[color:var(--color-muted)]">
                  Add as many records as you need. Text · FHIR · HL7 · CSV · PDF · DOCX · DICOM
                </div>
              </div>

              {/* File list */}
              {files.length > 0 && (
                <ul className="mt-4 surface rounded-2xl divide-y divide-[color:var(--color-border)]">
                  {files.map((f) => (
                    <li key={f.name} className="flex items-center justify-between px-4 py-3 text-sm">
                      <div className="truncate">
                        <span className="font-medium">{f.name}</span>
                        <span className="mono text-xs text-[color:var(--color-muted)] ml-2">
                          {(f.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <button
                        onClick={() => removeFile(f.name)}
                        className="ml-4 text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)] transition-colors text-xs"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Start */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="text-sm text-[color:var(--color-muted)]">
                {files.length} file{files.length !== 1 ? 's' : ''} queued
              </div>
              <button
                onClick={() => void startBatch()}
                className="btn-primary"
                disabled={files.length === 0}
              >
                Start batch de-identification
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Progress table */}
            <div className="surface rounded-2xl overflow-hidden mb-6">
              {/* Summary bar */}
              <div className="px-6 py-4 border-b border-[color:var(--color-border)] flex flex-wrap gap-6 items-center">
                <div>
                  <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">Progress</div>
                  <div className="text-xl font-bold mono">{result.done}/{result.total}</div>
                </div>
                <div>
                  <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">Errors</div>
                  <div className="text-xl font-bold mono" style={{ color: result.errors > 0 ? '#EF4444' : 'white' }}>
                    {result.errors}
                  </div>
                </div>
                {result.isRunning && (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-[color:var(--color-muted)]">Processing…</span>
                  </div>
                )}
                {result.isFinished && !result.isRunning && (
                  <span style={{ color: '#10B981' }} className="font-semibold">Complete</span>
                )}
              </div>

              {/* Progress bar */}
              <div className="h-1.5 bg-[color:var(--color-surface-2)]">
                <div
                  className="h-1.5 transition-all"
                  style={{ background: '#4F46E5', width: `${result.total > 0 ? (result.done / result.total) * 100 : 0}%` }}
                />
              </div>

              {/* File rows */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[color:var(--color-muted)] mono text-xs uppercase tracking-wider border-b border-[color:var(--color-border)]">
                    <th className="px-6 py-3">File</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Spans</th>
                    <th className="px-3 py-3">Risk</th>
                    <th className="px-3 py-3">Valid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-border)]">
                  {result.items.map((item) => (
                    <tr key={item.id} className={item.status === 'processing' ? 'bg-[color:var(--color-surface-2)]' : ''}>
                      <td className="px-6 py-3 font-medium truncate max-w-xs">
                        {item.filename}
                        {item.error && (
                          <div className="text-xs text-[color:var(--color-danger)] mt-0.5">{item.error}</div>
                        )}
                      </td>
                      <td className="px-3 py-3"><StatusIcon status={item.status} /></td>
                      <td className="px-3 py-3 mono">{item.spansFound ?? '·'}</td>
                      <td className="px-3 py-3"><RiskPill level={item.riskLevel} /></td>
                      <td className="px-3 py-3 mono">
                        {item.validationPassed === undefined
                          ? <span className="text-[color:var(--color-muted)]">&middot;</span>
                          : item.validationPassed
                          ? <span className="text-xs font-semibold" style={{ color: '#10B981' }}>Pass</span>
                          : <span className="text-xs font-semibold" style={{ color: '#EF4444' }}>Fail</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Download ZIP */}
            {result.isFinished && result.downloadZip && (
              <div className="flex items-center justify-between flex-wrap gap-4 mt-2">
                <button onClick={() => router.push('/')} className="btn-secondary">
                  New batch
                </button>
                <button
                  onClick={() => void result.downloadZip?.()}
                  className="btn-primary"
                >
                  Download all as ZIP
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
