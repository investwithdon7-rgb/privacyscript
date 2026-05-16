'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Brand } from '@/components/Brand';
import { RiskBadge } from '@/components/RiskBadge';
import { useSession } from '@/hooks/useSession';

export default function ReviewPage() {
  const router = useRouter();
  const s = useSession();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!s.risk && !s.error) router.replace('/');
  }, [s.risk, s.error, router]);

  // Show error state even when risk is absent (finalise errored before stage 4).
  if (!s.risk) {
    if (!s.error) return null;
    return (
      <main className="min-h-screen max-w-5xl mx-auto px-6">
        <Brand subtitle="Risk assessment" />
        <div
          className="mt-10 p-5 rounded-xl"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
        >
          <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
            Processing error
          </div>
          <div className="text-sm">{s.error}</div>
        </div>
        <div className="mt-6">
          <button onClick={() => router.push('/')} className="btn-secondary">
            Start over
          </button>
        </div>
      </main>
    );
  }

  const canProceed =
    s.risk.level !== 'HIGH' || acknowledged;

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Risk assessment" />

      <section className="mt-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-3xl font-bold">Risk assessment</h1>
          <RiskBadge level={s.risk.level} />
        </div>

        {s.error ? (
          <div
            className="mt-6 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
          >
            <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
              Error during processing
            </div>
            <div className="text-sm">{s.error}</div>
          </div>
        ) : null}

        <div className="surface rounded-2xl p-6 mt-6">
          <div className="grid md:grid-cols-3 gap-6">
            <Stat
              label="k-anonymity"
              value={String(s.risk.kAnonymity)}
              hint={`Threshold ${s.risk.kAnonymity >= 5 ? 'met' : 'not met'}`}
            />
            <Stat
              label="Identifiers redacted"
              value={String(s.replacement?.replacements.length ?? 0)}
              hint={`${s.detection?.spans.length ?? 0} direct + ${s.quasiToRedact.size} quasi types`}
            />
            <Stat
              label="Validation"
              value={s.validation == null ? '…' : s.validation.passed ? 'PASS' : 'LEAK'}
              hint={
                s.validation == null
                  ? 'Still running…'
                  : s.validation.passed
                  ? `No original identifier in output${s.validation.leaks.length > 0 ? ` · ${s.validation.leaks.length} regex residual(s)` : ''}`
                  : `${s.validation.originalsLeaked.length} original(s) leaked verbatim`
              }
              tone={s.validation == null ? 'neutral' : s.validation.passed ? 'good' : 'bad'}
            />
          </div>

          <div className="mt-6 pt-6 border-t border-[color:var(--color-border)]">
            <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-2">
              Reasoning
            </div>
            <ul className="text-sm space-y-1">
              {s.risk.reasons.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="surface rounded-2xl p-6 mt-6">
          <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
            Identifier breakdown
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[color:var(--color-muted)] mono text-xs uppercase tracking-wider">
                <th className="pb-2">Type</th>
                <th className="pb-2">Count</th>
                <th className="pb-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-border)]">
              {s.risk.breakdown.map((b) => (
                <tr key={b.label}>
                  <td className="py-2 mono">{b.label}</td>
                  <td className="py-2 mono">{b.count}</td>
                  <td className="py-2 mono text-[color:var(--color-muted)]">{b.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* HIGH risk acknowledgment */}
        {s.risk.level === 'HIGH' && (s.validation?.passed ?? false) ? (
          <div
            className="mt-6 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
          >
            <div className="font-semibold" style={{ color: 'var(--color-danger)' }}>
              HIGH risk
            </div>
            <p className="text-sm mt-1 text-[color:var(--color-muted)]">
              k-anonymity is below the threshold. You may proceed only if you accept the residual
              re-identification risk.
            </p>
            <label className="flex items-center gap-2 mt-3 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="accent-[#EF4444]"
              />
              I accept the residual risk and confirm I have a lawful basis to proceed.
            </label>
          </div>
        ) : null}

        {/* Hard-fail: verbatim original leaked into output */}
        {s.validation != null && !s.validation.passed ? (
          <div
            className="mt-6 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
          >
            <div className="font-semibold" style={{ color: 'var(--color-danger)' }}>
              Validation failed — identifier leaked verbatim
            </div>
            <p className="text-sm mt-1 text-[color:var(--color-muted)]">
              {s.validation.originalsLeaked.length} original identifier value(s) were found
              unchanged in the de-identified output. Inspect the diff and re-process before sharing.
            </p>
          </div>
        ) : null}

        <div className="mt-8 flex justify-between">
          <button onClick={() => router.push('/')} className="btn-secondary">
            Start over
          </button>
          <button
            onClick={() => router.push('/output/')}
            className="btn-primary"
            disabled={
              // Blocked until all pipeline stages have completed.
              s.stageIndex < 6 ||
              // Blocked if risk is HIGH and user hasn't acknowledged.
              !canProceed ||
              // Blocked only on verbatim original identifier leaks (hard constraint).
              // Regex residuals (s.validation.leaks) are informational warnings only.
              (s.validation != null && !s.validation.passed)
            }
          >
            {s.stageIndex < 6 ? 'Processing…' : 'View output'}
          </button>
        </div>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  const colour =
    tone === 'good' ? 'var(--color-success)' : tone === 'bad' ? 'var(--color-danger)' : 'white';
  return (
    <div>
      <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
        {label}
      </div>
      <div className="text-3xl font-bold mt-1 mono" style={{ color: colour }}>
        {value}
      </div>
      {hint ? <div className="text-xs text-[color:var(--color-muted)] mt-1">{hint}</div> : null}
    </div>
  );
}
