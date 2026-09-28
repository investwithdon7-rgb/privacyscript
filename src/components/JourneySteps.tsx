'use client';

export type JourneyStage = 'upload' | 'scan' | 'review' | 'risk' | 'download';

const STAGES: Array<{ id: JourneyStage; label: string }> = [
  { id: 'upload', label: 'Upload' },
  { id: 'scan', label: 'Scan' },
  { id: 'review', label: 'Review' },
  { id: 'risk', label: 'Risk check' },
  { id: 'download', label: 'Download' },
];

/**
 * Where the user is in the whole journey, in plain words:
 * ① Upload ✓ → ② Scan ✓ → ③ Review → ④ Risk check → ⑤ Download.
 */
export function JourneySteps({ current }: { current: JourneyStage }) {
  const at = STAGES.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Progress" className="mt-6">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
        {STAGES.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'current' : 'next';
          return (
            <li key={s.id} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
              <span
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                style={
                  state === 'done'
                    ? { background: 'rgba(16,185,129,0.15)', color: 'var(--color-success)', border: '1px solid var(--color-success)' }
                    : state === 'current'
                      ? { background: '#4F46E5', color: 'white' }
                      : { border: '1px solid var(--color-border)', color: 'var(--color-muted)' }
                }
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className="text-sm"
                style={{
                  color: state === 'next' ? 'var(--color-muted)' : 'white',
                  fontWeight: state === 'current' ? 700 : 400,
                }}
              >
                {s.label}
              </span>
              {i < STAGES.length - 1 && (
                <span className="w-6 h-px mx-1 hidden sm:block" style={{ background: 'var(--color-border)' }} aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
