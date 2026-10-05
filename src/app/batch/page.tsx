'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { WordListPanel } from '@/components/WordListPanel';
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

const STATUS_TEXT: Record<BatchItem['status'], { label: string; colour: string }> = {
  pending: { label: 'Queued', colour: 'var(--color-muted)' },
  processing: { label: 'Working', colour: 'var(--color-muted)' },
  ready: { label: 'Scanned', colour: 'var(--color-primary)' },
  skipped: { label: 'Open on its own', colour: 'var(--color-warning)' },
  error: { label: 'Failed', colour: 'var(--color-danger)' },
  released: { label: 'Released', colour: 'var(--color-success)' },
  held: { label: 'Held back', colour: 'var(--color-danger)' },
};

function StatusIcon({ status }: { status: BatchItem['status'] }) {
  const { label, colour } = STATUS_TEXT[status];
  return (
    <span className="inline-flex items-center gap-2 mono text-xs font-semibold" style={{ color: colour }}>
      {status === 'processing' && (
        <span className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      )}
      {label}
    </span>
  );
}

function choiceClass(active: boolean, tone: 'danger' | 'neutral'): string {
  const base = 'rounded-full px-3 py-1 text-xs border transition-colors';
  if (!active) return `${base} border-[color:var(--color-border)] text-[color:var(--color-muted)] hover:text-white`;
  return tone === 'danger'
    ? `${base} border-[color:var(--color-danger)] text-white bg-[rgba(239,68,68,0.15)]`
    : `${base} border-[color:var(--color-primary)] text-white bg-[rgba(79,70,229,0.15)]`;
}

const heading = 'mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]';

export default function BatchPage() {
  const router = useRouter();
  const { state, analyse, cancel, decide, decideAll, setReadable, release, downloadZip, downloadKey, reset } =
    useBatchDeidentification();
  const [profileId, setProfileId] = useState<ComplianceProfileId>(DEFAULT_COMPLIANCE_PROFILE);
  const [showProfiles, setShowProfiles] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [hot, setHot] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [keyMessage, setKeyMessage] = useState<{ ok: boolean; text: string } | null>(null);

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

  // ── Review data ────────────────────────────────────────────────────────
  const transcripts = state.prepared.filter((p) => p.transcript);
  const allFlags = transcripts.flatMap((p) => p.transcript!.flags.map((f) => ({ file: p, flag: f })));
  const undecided = allFlags.filter(({ file, flag }) => state.decisions[file.id]?.[flag.id] === undefined).length;
  const speakers = useMemo(() => {
    const byLabel = new Map<string, { label: string; display: string; files: number; isName: boolean }>();
    for (const p of transcripts) {
      for (const sp of p.transcript!.info.speakers) {
        const key = sp.label.toLowerCase();
        const cur = byLabel.get(key);
        if (cur) cur.files++;
        else byLabel.set(key, { label: sp.label, display: sp.display, files: 1, isName: sp.isName });
      }
    }
    return Array.from(byLabel.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.prepared]);
  const processable = state.prepared.filter((p) => !p.skipReason).length;

  const released = state.finalised.filter((f) => !f.heldBack).length;
  const held = state.finalised.filter((f) => f.heldBack).length;

  const saveKey = async () => {
    setKeyMessage(null);
    if (passphrase.length < 12) return setKeyMessage({ ok: false, text: 'Use at least 12 characters.' });
    if (passphrase !== confirmPassphrase) return setKeyMessage({ ok: false, text: 'The passphrases do not match.' });
    try {
      await downloadKey(passphrase);
      setPassphrase('');
      setConfirmPassphrase('');
      setKeyMessage({ ok: true, text: 'Key file saved. Store it separately from the data. Without the passphrase it cannot be opened. Open it later from "Open a key file" on the home page.' });
    } catch (e) {
      setKeyMessage({ ok: false, text: (e as Error).message });
    }
  };

  const progressDone = state.items.filter((i) => !['pending', 'processing'].includes(i.status)).length;

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6 pb-16">
      <Brand subtitle="Batch processing" />

      <section className="mt-12">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-3xl font-bold">Batch de-identification</h1>
          <button onClick={() => router.push('/')} className="btn-secondary text-sm">
            Back to single record
          </button>
        </div>

        {state.phase === 'idle' ? (
          <>
            {/* Step 1: Compliance */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className={heading}>Step 1. Where will this data go?</h2>
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
                  <span className="font-semibold">{profile.label}</span>
                  <span className="mono text-xs text-[color:var(--color-muted)] ml-3">{profile.regulation}</span>
                </div>
              )}
            </div>

            {/* Step 2: Files */}
            <div className="mb-8">
              <h2 className={`${heading} mb-3`}>Step 2. Add files</h2>
              <WordListPanel />
              <div className="mt-4" />
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
                  accept=".txt,.md,.vtt,.srt,.json,.hl7,.docx"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <div className="text-lg font-semibold mb-2">Drop files or click to add</div>
                <div className="text-sm text-[color:var(--color-muted)]">
                  Interview transcripts (TXT, DOCX, VTT, SRT) · clinical notes · FHIR · HL7.
                  People named in several files get the same label in every file.
                </div>
                <div className="text-xs text-[color:var(--color-muted)] mt-2">
                  Surveys, PDFs, DICOM and photos need their own review. Open those one at a time.
                </div>
              </div>

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

            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="text-sm text-[color:var(--color-muted)]">
                {files.length} file{files.length !== 1 ? 's' : ''} queued. Nothing is released until you&apos;ve reviewed it.
              </div>
              <button
                onClick={() => void analyse(files, effectiveMode, profileId)}
                className="btn-primary disabled:opacity-40"
                disabled={files.length === 0}
              >
                Scan files
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Progress + file table (all later phases) */}
            <div className="surface rounded-2xl overflow-hidden mb-6">
              <div className="px-6 py-4 border-b border-[color:var(--color-border)] flex flex-wrap gap-6 items-center">
                <div>
                  <div className={heading}>
                    {state.phase === 'analysing' ? 'Scanning' : state.phase === 'releasing' ? 'Building outputs' : 'Files'}
                  </div>
                  <div className="text-xl font-bold mono">
                    {state.phase === 'analysing' ? `${progressDone}/${state.items.length}` : state.items.length}
                  </div>
                </div>
                {state.phase === 'done' && (
                  <>
                    <div>
                      <div className={heading}>Released</div>
                      <div className="text-xl font-bold mono" style={{ color: 'var(--color-success)' }}>{released}</div>
                    </div>
                    <div>
                      <div className={heading}>Held back</div>
                      <div className="text-xl font-bold mono" style={{ color: held ? 'var(--color-danger)' : 'white' }}>{held}</div>
                    </div>
                  </>
                )}
                {(state.phase === 'analysing' || state.phase === 'releasing') && (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-[color:var(--color-muted)]">Working on this device…</span>
                    {state.phase === 'analysing' && (
                      <button type="button" className="btn-secondary text-sm ml-2" onClick={cancel}>
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[color:var(--color-muted)] mono text-xs uppercase tracking-wider border-b border-[color:var(--color-border)]">
                      <th className="px-6 py-3">File</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Found</th>
                      <th className="px-3 py-3">To review</th>
                      <th className="px-3 py-3">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--color-border)]">
                    {state.items.map((item) => (
                      <tr key={item.id} className={item.status === 'processing' ? 'bg-[color:var(--color-surface-2)]' : ''}>
                        <td className="px-6 py-3 font-medium max-w-xs">
                          <div className="truncate">{item.filename}</div>
                          {item.message && (
                            <div
                              className="text-xs mt-0.5"
                              style={{ color: item.status === 'skipped' ? 'var(--color-warning)' : 'var(--color-danger)' }}
                            >
                              {item.message}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3"><StatusIcon status={item.status} /></td>
                        <td className="px-3 py-3 mono">{item.spansFound ?? '·'}</td>
                        <td className="px-3 py-3 mono">{item.flags ?? '·'}</td>
                        <td className="px-3 py-3"><RiskPill level={item.riskLevel} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Review */}
            {state.phase === 'review' && (
              <div className="surface rounded-2xl p-6">
                <h2 className="text-lg font-semibold">Review before release</h2>
                <p className="text-sm text-[color:var(--color-muted)] mt-1">
                  {processable} file{processable === 1 ? '' : 's'} ready. Check the speaker labels and decide on
                  each flagged passage. Nothing is produced until you release.
                </p>

                {speakers.length > 0 && (
                  <>
                    <h3 className={`${heading} mt-6`}>Speakers across the study</h3>
                    <ul className="mt-2 divide-y divide-[color:var(--color-border)]">
                      {speakers.map((sp) => (
                        <li key={sp.label} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="mono">{sp.label}</span>
                          <span className="text-[color:var(--color-muted)]">
                            {sp.isName ? <>becomes <span className="text-white">[{sp.display}]</span></> : 'kept as written'}
                            {' '}· in {sp.files} file{sp.files === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <h3 className={`${heading} mt-6`}>How other people and places are replaced</h3>
                    <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Replacement style">
                      <button type="button" role="radio" aria-checked={state.readable} className={choiceClass(state.readable, 'neutral')} onClick={() => setReadable(true)}>
                        Readable: [Person 1], same number in every file
                      </button>
                      <button type="button" role="radio" aria-checked={!state.readable} className={choiceClass(!state.readable, 'neutral')} onClick={() => setReadable(false)}>
                        Codes: {state.mode === 'PSEUDONYMISE' ? '[NAME-3F7A91B2]' : '[NAME]'}
                      </button>
                    </div>
                  </>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 mt-6">
                  <h3 className={heading}>Passages that could identify someone ({allFlags.length})</h3>
                  {allFlags.length > 1 && (
                    <div className="flex gap-2">
                      <button type="button" className={choiceClass(false, 'neutral')} onClick={() => decideAll('keep')}>Keep all</button>
                      <button type="button" className={choiceClass(false, 'danger')} onClick={() => decideAll('remove')}>Remove all</button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-[color:var(--color-muted)] mt-1">
                  These sentences could point to one person without naming them. Automated checks can
                  miss this kind of detail, so skim the outputs before you share them.
                  {state.mode === 'ANONYMISE' && ' Anonymised transcripts only count as anonymous after a person has checked them like this.'}
                </p>
                {allFlags.length === 0 ? (
                  <div className="text-sm mono text-[color:var(--color-muted)] mt-3">None found.</div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {allFlags.map(({ file, flag }) => {
                      const d = state.decisions[file.id]?.[flag.id];
                      return (
                        <li
                          key={`${file.id}:${flag.id}`}
                          className="surface-2 rounded-xl p-3"
                          style={{ borderLeft: `3px solid ${d === 'remove' ? 'var(--color-danger)' : d === 'keep' ? 'var(--color-success)' : 'var(--color-warning)'}` }}
                        >
                          <div className="flex flex-wrap justify-between gap-2 text-xs">
                            <span style={{ color: 'var(--color-warning)' }}>{flag.reason}</span>
                            <span className="mono text-[color:var(--color-muted)]">{file.name}</span>
                          </div>
                          <div className="text-sm mt-1" style={d === 'remove' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
                            “{flag.text}”
                          </div>
                          <div className="flex gap-2 mt-2">
                            <button type="button" className={choiceClass(d === 'keep', 'neutral')} onClick={() => decide(file.id, flag.id, 'keep')}>
                              Keep, it&apos;s fine
                            </button>
                            <button type="button" className={choiceClass(d === 'remove', 'danger')} onClick={() => decide(file.id, flag.id, 'remove')}>
                              Remove this passage
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                  <button type="button" className="btn-secondary" onClick={reset}>Start again</button>
                  <div className="flex flex-wrap items-center gap-3">
                    {undecided > 0 && (
                      <span className="text-sm" style={{ color: 'var(--color-warning)' }}>
                        Decide on {undecided} more passage{undecided === 1 ? '' : 's'} to continue.
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                      disabled={undecided > 0 || processable === 0}
                      onClick={() => void release()}
                    >
                      Release {processable} de-identified file{processable === 1 ? '' : 's'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Done */}
            {state.phase === 'done' && (
              <>
                {held > 0 && (
                  <div className="rounded-xl p-4 mb-4 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid var(--color-danger)' }}>
                    {held} file{held === 1 ? ' was' : 's were'} held back and {held === 1 ? 'is' : 'are'} not in the download. The reason is shown next to each file. Open {held === 1 ? 'it' : 'them'} on its own to fix.
                  </div>
                )}

                {state.mode === 'PSEUDONYMISE' && released > 0 && (
                  <div className="surface rounded-2xl p-6 mb-4">
                    <h2 className="text-lg font-semibold">Re-identification key</h2>
                    <p className="text-sm text-[color:var(--color-muted)] mt-1">
                      One key for the whole study, saved as a separate file and locked with your passphrase.
                      It is not in the ZIP. Keep it apart from the data.
                    </p>
                    <div className="grid gap-2 md:grid-cols-2 mt-3">
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Passphrase (12+ characters)"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="surface-2 rounded-lg px-3 py-2 text-sm border border-[color:var(--color-border)]"
                      />
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Repeat passphrase"
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        className="surface-2 rounded-lg px-3 py-2 text-sm border border-[color:var(--color-border)]"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button type="button" className="btn-secondary" onClick={() => void saveKey()}>
                        Save key file
                      </button>
                      {keyMessage && (
                        <span className="text-sm" style={{ color: keyMessage.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {keyMessage.text}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between flex-wrap gap-4 mt-2">
                  <button onClick={() => { reset(); setFiles([]); }} className="btn-secondary">
                    New batch
                  </button>
                  <button
                    onClick={() => void downloadZip()}
                    className="btn-primary disabled:opacity-40"
                    disabled={state.finalised.length === 0}
                  >
                    Download {released} file{released === 1 ? '' : 's'} + audit logs (ZIP)
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
