'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { Brand } from '@/components/Brand';
import { PipelineProgress } from '@/components/PipelineProgress';
import { QuasiIdentifierReview } from '@/components/QuasiIdentifierReview';
import { UncertainDetectionsPanel } from '@/components/UncertainDetectionsPanel';
import { SpanEditor } from '@/components/SpanEditor';
import { SurveyColumnsPanel } from '@/components/SurveyColumnsPanel';
import { TranscriptPanel } from '@/components/TranscriptPanel';
import type { TranscriptState } from '@/engine/transcript';
import { useSession } from '@/hooks/useSession';
import { getSession, resetSession, updateSession } from '@/state/session';
import { finalise, spansInEngineColumns, tabularDataRows } from '@/hooks/useDeidentification';
import { COMPLIANCE_PROFILES, K_ANONYMITY_THRESHOLD } from '@/lib/constants';
import type { CsvIngest } from '@/formats/csv';
import type { TabularState } from '@/engine/tabular';
import type { Span } from '@/engine/detect';

export default function ProcessPage() {
  const router = useRouter();
  const s = useSession();

  // Redirect home if the user lands here without a staged file.
  useEffect(() => {
    if (!s.filename && !s.error) router.replace('/');
  }, [s.filename, s.error, router]);

  // Once the user confirms quasi-identifiers, run stages 3-6 and move to review.
  useEffect(() => {
    if (s.quasiConfirmed && s.stageIndex === 2) {
      void finalise().then(() => router.push('/review/'));
    }
  }, [s.quasiConfirmed, s.stageIndex, router]);

  // NOTE: every handler below reads the CURRENT session via getSession()
  // rather than the render-time snapshot `s`. Handlers that fire in rapid
  // succession (e.g. the "Redact all of these" loop calls onDecide once per
  // span, synchronously) would otherwise each spread the same stale copy and
  // overwrite one another — only the last decision survived.

  const toggleQuasi = (label: string) => {
    const next = new Set(getSession().quasiToRedact);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    updateSession({ quasiToRedact: next });
  };

  const confirmQuasi = () => updateSession({ quasiConfirmed: true });

  // ── Uncertain span decisions ──────────────────────────────────────────
  const handleUncertainDecide = (key: string, confirmed: boolean) => {
    updateSession({
      uncertainSpanDecisions: {
        ...getSession().uncertainSpanDecisions,
        [key]: confirmed,
      },
    });
  };

  // When the user clicks "Done, continue" on the uncertain panel, we also
  // auto-dismiss any spans that still have no decision (treat as rejected).
  const handleUncertainConfirmAll = () => {
    const cur = getSession();
    const auto: Record<string, boolean> = { ...cur.uncertainSpanDecisions };
    for (const sp of cur.detection?.uncertainSpans ?? []) {
      const key = `${sp.start}:${sp.end}:${sp.label}`;
      if (auto[key] === undefined) auto[key] = false;
    }
    updateSession({ uncertainSpanDecisions: auto });
  };

  // ── Manual span editor ────────────────────────────────────────────────
  const handleAddSpan = (span: Span) => {
    updateSession({ userAddedSpans: [...getSession().userAddedSpans, span] });
  };

  const handleDismissSpan = (key: string) => {
    const next = new Set(getSession().userDismissedSpanKeys);
    next.add(key);
    updateSession({ userDismissedSpanKeys: next });
  };

  const handleRestoreSpan = (key: string) => {
    const next = new Set(getSession().userDismissedSpanKeys);
    next.delete(key);
    updateSession({ userDismissedSpanKeys: next });
  };

  // ── Survey / spreadsheet column plan ──────────────────────────────────
  const tabular = s.format === 'CSV' ? s.tabular : null;
  const csv = tabular ? (s.parsedOriginal as CsvIngest | null) : null;
  const dataRows = useMemo(
    () => (csv && tabular ? tabularDataRows(csv, tabular) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [csv, tabular?.platform.metaRowCount]
  );
  const kThreshold =
    COMPLIANCE_PROFILES[s.complianceProfile ?? 'GDPR_PSEUDO']?.kThreshold ?? K_ANONYMITY_THRESHOLD;
  const columnsPending = !!tabular && !tabular.confirmed;
  const setTabular = (next: TabularState) => updateSession({ tabular: next });

  // ── Interview transcripts ─────────────────────────────────────────────
  const transcript = s.transcript;
  const transcriptPending = !!transcript && !transcript.confirmed;
  const setTranscript = (next: TranscriptState) => updateSession({ transcript: next });
  /** Column / transcript setup still open — later review steps wait for it. */
  // ── Unreadable script ─────────────────────────────────────────────────
  // UNREADABLE: nothing can be produced. PARTIAL: the user must acknowledge
  // that those passages are theirs to check before any step continues.
  const scriptWarning = s.scriptWarning;
  const scriptUnreadable = scriptWarning?.severity === 'UNREADABLE';
  const scriptBlocked = scriptUnreadable || (scriptWarning?.severity === 'PARTIAL' && !s.scriptAcknowledged);
  const setupPending = scriptBlocked || columnsPending || transcriptPending;

  // In a survey, detections inside identifier / quasi columns are handled by
  // the column plan — only show the ones in written/answer columns.
  const quasiForReview = s.detection
    ? tabular ? spansInEngineColumns(s.detection.quasiSpans) : s.detection.quasiSpans
    : [];
  const uncertainForReview = s.detection?.uncertainSpans
    ? tabular ? spansInEngineColumns(s.detection.uncertainSpans) : s.detection.uncertainSpans
    : [];

  // All active detected spans (direct + quasi, minus dismissed, plus user-added).
  const allDetectedSpans = s.detection
    ? [...s.detection.spans, ...s.detection.quasiSpans, ...s.userAddedSpans]
    : [];

  // Has the user resolved all uncertain span decisions?
  const uncertainResolved = uncertainForReview.every(
    (sp) => s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`] !== undefined
  );

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Processing" />

      <section className="mt-10">
        <h1 className="text-3xl font-bold">{tabular ? 'Processing survey data' : transcript ? 'Processing transcript' : 'Processing record'}</h1>
        <p className="text-[color:var(--color-muted)] mt-2 mono text-sm">
          {s.filename ?? 'record'} · {s.format ?? 'detecting…'} · {s.mode}
        </p>
        <PipelineProgress stageIndex={s.stageIndex} />

        {s.error ? (
          <div
            className="mt-8 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
          >
            <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
              Processing error
            </div>
            <div className="text-sm">{s.error}</div>
          </div>
        ) : null}

        {s.scanProgress && !s.detection ? (
          <div className="surface rounded-2xl p-6 mt-8">
            <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-2">
              OCR progress
            </div>
            <div className="text-sm mb-4">{s.scanProgress.message}</div>
            <div className="h-2 rounded-full surface-2 overflow-hidden">
              <div
                className="h-2"
                style={{
                  background: '#4F46E5',
                  width: `${
                    s.scanProgress.pagesTotal
                      ? (s.scanProgress.pagesDone / s.scanProgress.pagesTotal) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="mono text-xs text-[color:var(--color-muted)] mt-2">
              {s.scanProgress.pagesDone}/{s.scanProgress.pagesTotal} pages
            </div>
          </div>
        ) : null}

        {s.detection ? (
          <>
            {/* Detection summary */}
            <div className="mt-8 surface rounded-2xl p-6">
              <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-2">
                Detection summary
              </div>
              <div className="text-2xl font-bold">
                {s.detection.spans.length + s.detection.quasiSpans.length} identifiers detected
              </div>
              {(s.detection.uncertainSpans?.length ?? 0) > 0 && (
                <div className="mt-2 text-sm" style={{ color: 'var(--color-warning)' }}>
                  + {s.detection.uncertainSpans!.length} uncertain detections awaiting review
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
                {Object.entries(s.detection.counts).map(([label, count]) => (
                  <div key={label} className="surface-2 rounded-lg px-3 py-2">
                    <div className="mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted)]">
                      {label}
                    </div>
                    <div className="text-lg font-semibold mono">{count}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Unreadable script comes before everything else */}
            {scriptWarning && (
              <div
                className="rounded-2xl p-6 mt-8"
                style={{
                  background: scriptUnreadable ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                  border: `1px solid ${scriptUnreadable ? 'var(--color-danger)' : 'var(--color-warning)'}`,
                }}
              >
                <h2 className="text-lg font-semibold">
                  {scriptUnreadable ? 'This document cannot be checked' : 'Part of this document cannot be checked'}
                </h2>
                <p className="text-sm mt-2">{scriptWarning.message}</p>
                {scriptUnreadable ? (
                  <>
                    <p className="text-sm text-[color:var(--color-muted)] mt-2">
                      PrivacyScript reads Latin-script text only. It will not produce a de-identified
                      version: the result would look clean without being checked. De-identify this
                      document by hand, or with a tool that supports{' '}
                      {scriptWarning.scripts.join(', ') || 'this script'}.
                    </p>
                    <div className="mt-4">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          resetSession();
                          router.push('/');
                        }}
                      >
                        Start again
                      </button>
                    </div>
                  </>
                ) : (
                  <label className="flex items-start gap-3 mt-4 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 accent-[#4F46E5]"
                      checked={s.scriptAcknowledged}
                      onChange={(e) => updateSession({ scriptAcknowledged: e.target.checked })}
                    />
                    <span>
                      I understand the {scriptWarning.scripts.join(', ') || 'non-Latin'} passages are not checked
                      automatically. I will mark any names or other identifiers in them myself in the
                      next steps, or confirm they contain none. This is recorded in the audit log.
                    </span>
                  </label>
                )}
              </div>
            )}

            {/* Transcripts: speakers + contextual passages come first */}
            {!scriptBlocked && transcript && s.mode && (
              transcriptPending ? (
                <TranscriptPanel
                  transcript={transcript}
                  mode={s.mode}
                  onChange={setTranscript}
                  onConfirm={() => {
                    const nothingElse = quasiForReview.length === 0 && uncertainForReview.length === 0;
                    updateSession({
                      transcript: { ...transcript, confirmed: true },
                      ...(nothingElse ? { quasiConfirmed: true } : {}),
                    });
                  }}
                />
              ) : (
                <div className="surface rounded-2xl px-6 py-4 mt-8 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <span style={{ color: 'var(--color-success)' }}>✓</span> Transcript reviewed
                    <span className="text-[color:var(--color-muted)]">
                      {' '}· {transcript.info.speakers.filter((sp) => sp.isName).length} speaker names replaced ·{' '}
                      {Object.values(transcript.flagDecisions).filter((d) => d === 'remove').length} passages removed
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setTranscript({ ...transcript, confirmed: false })}
                  >
                    Edit
                  </button>
                </div>
              )
            )}

            {/* Survey datasets: column plan comes first */}
            {!scriptBlocked && tabular && s.mode && (
              columnsPending ? (
                <SurveyColumnsPanel
                  tabular={tabular}
                  dataRows={dataRows}
                  mode={s.mode}
                  kThreshold={kThreshold}
                  convertedFrom={
                    /\.xlsx$/i.test(s.filename ?? '') ? 'XLSX' : /\.sav$/i.test(s.filename ?? '') ? 'SPSS' : undefined
                  }
                  onChange={setTabular}
                  onConfirm={() => {
                    // Nothing left to review in the written answers → go
                    // straight on; an empty "0 found, confirm" step is noise.
                    const nothingElse = quasiForReview.length === 0 && uncertainForReview.length === 0;
                    updateSession({
                      tabular: { ...tabular, confirmed: true },
                      ...(nothingElse ? { quasiConfirmed: true } : {}),
                    });
                  }}
                />
              ) : (
                <div className="surface rounded-2xl px-6 py-4 mt-8 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <span style={{ color: 'var(--color-success)' }}>✓</span> Survey columns confirmed
                    <span className="text-[color:var(--color-muted)]">
                      {' '}· {tabular.plans.filter((p) => p.role === 'DIRECT').length} identifying ·{' '}
                      {tabular.plans.filter((p) => p.role === 'QUASI').length} generalised
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setTabular({ ...tabular, confirmed: false })}
                  >
                    Edit columns
                  </button>
                </div>
              )
            )}

            {/* Phase 1.2: Uncertain NER detections panel */}
            {!setupPending && uncertainForReview.length > 0 && (
              <UncertainDetectionsPanel
                spans={uncertainForReview}
                decisions={s.uncertainSpanDecisions}
                onDecide={handleUncertainDecide}
                onConfirmAll={handleUncertainConfirmAll}
              />
            )}

            {/* Phase 1.3: Manual span editor, only shown once the uncertain panel is resolved.
                For surveys it is tucked away — the column plan is the main control. */}
            {!setupPending && uncertainResolved && s.originalText && (
              tabular ? (
                <details className="surface rounded-2xl px-6 py-4 mt-8">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Review individual detections in the cells (optional)
                  </summary>
                  <SpanEditor
                    text={s.originalText}
                    spans={allDetectedSpans}
                    dismissedKeys={s.userDismissedSpanKeys}
                    onAddSpan={handleAddSpan}
                    onDismissSpan={handleDismissSpan}
                    onRestoreSpan={handleRestoreSpan}
                  />
                </details>
              ) : (
                <SpanEditor
                  text={s.originalText}
                  spans={allDetectedSpans}
                  dismissedKeys={s.userDismissedSpanKeys}
                  onAddSpan={handleAddSpan}
                  onDismissSpan={handleDismissSpan}
                  onRestoreSpan={handleRestoreSpan}
                />
              )
            )}

            {/* Quasi-identifier review + confirm */}
            {!setupPending && uncertainResolved && (
              <QuasiIdentifierReview
                quasiSpans={quasiForReview}
                redactSet={s.quasiToRedact}
                onToggle={toggleQuasi}
                onConfirm={confirmQuasi}
              />
            )}
          </>
        ) : (
          <div className="mt-8 text-[color:var(--color-muted)]">Running detection…</div>
        )}
      </section>
    </main>
  );
}
