'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Brand } from '@/components/Brand';
import { PipelineProgress } from '@/components/PipelineProgress';
import { QuasiIdentifierReview } from '@/components/QuasiIdentifierReview';
import { UncertainDetectionsPanel } from '@/components/UncertainDetectionsPanel';
import { SpanEditor } from '@/components/SpanEditor';
import { useSession } from '@/hooks/useSession';
import { getSession, updateSession } from '@/state/session';
import { finalise } from '@/hooks/useDeidentification';
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

  // All active detected spans (direct + quasi, minus dismissed, plus user-added).
  const allDetectedSpans = s.detection
    ? [...s.detection.spans, ...s.detection.quasiSpans, ...s.userAddedSpans]
    : [];

  // Has the user resolved all uncertain span decisions?
  const uncertainResolved =
    !s.detection?.uncertainSpans?.length ||
    s.detection.uncertainSpans.every(
      (sp) => s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`] !== undefined
    );

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Processing" />

      <section className="mt-10">
        <h1 className="text-3xl font-bold">Processing record</h1>
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

            {/* Phase 1.2: Uncertain NER detections panel */}
            {(s.detection.uncertainSpans?.length ?? 0) > 0 && (
              <UncertainDetectionsPanel
                spans={s.detection.uncertainSpans!}
                decisions={s.uncertainSpanDecisions}
                onDecide={handleUncertainDecide}
                onConfirmAll={handleUncertainConfirmAll}
              />
            )}

            {/* Phase 1.3: Manual span editor, only shown once the uncertain panel is resolved */}
            {uncertainResolved && s.originalText && (
              <SpanEditor
                text={s.originalText}
                spans={allDetectedSpans}
                dismissedKeys={s.userDismissedSpanKeys}
                onAddSpan={handleAddSpan}
                onDismissSpan={handleDismissSpan}
                onRestoreSpan={handleRestoreSpan}
              />
            )}

            {/* Quasi-identifier review + confirm */}
            {uncertainResolved && (
              <QuasiIdentifierReview
                quasiSpans={s.detection.quasiSpans}
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
