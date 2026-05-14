'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Brand } from '@/components/Brand';
import { PipelineProgress } from '@/components/PipelineProgress';
import { QuasiIdentifierReview } from '@/components/QuasiIdentifierReview';
import { useSession } from '@/hooks/useSession';
import { updateSession } from '@/state/session';
import { finalise } from '@/hooks/useDeidentification';

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

  const toggleQuasi = (label: string) => {
    const next = new Set(s.quasiToRedact);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    updateSession({ quasiToRedact: next });
  };

  const confirmQuasi = () => updateSession({ quasiConfirmed: true });

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Processing" />

      <section className="mt-10">
        <h1 className="text-3xl font-bold">Processing record</h1>
        <p className="text-[color:var(--color-muted)] mt-2 mono text-sm">
          {s.filename ?? '—'} · {s.format ?? 'detecting…'} · {s.mode}
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
            <div className="mt-8 surface rounded-2xl p-6">
              <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-2">
                Detection summary
              </div>
              <div className="text-2xl font-bold">
                {s.detection.spans.length + s.detection.quasiSpans.length} identifiers detected
              </div>
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

            <QuasiIdentifierReview
              quasiSpans={s.detection.quasiSpans}
              redactSet={s.quasiToRedact}
              onToggle={toggleQuasi}
              onConfirm={confirmQuasi}
            />
          </>
        ) : (
          <div className="mt-8 text-[color:var(--color-muted)]">Running detection…</div>
        )}
      </section>
    </main>
  );
}
