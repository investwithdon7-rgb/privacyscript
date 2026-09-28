'use client';

import type { ReactNode } from 'react';

export type GuidedStepStatus = 'done' | 'active' | 'upcoming';

interface GuidedStepProps {
  number: number;
  total: number;
  title: string;
  /** One plain sentence: what the user should do in this step. */
  whatToDo?: string;
  status: GuidedStepStatus;
  /** Shown on a finished step, e.g. "2 speaker names replaced". */
  summary?: ReactNode;
  /** Reopens a finished step. */
  onChange?: () => void;
  children?: ReactNode;
}

function Badge({ number, status }: { number: number; status: GuidedStepStatus }) {
  const style =
    status === 'done'
      ? { background: 'rgba(16,185,129,0.15)', color: 'var(--color-success)', border: '1px solid var(--color-success)' }
      : status === 'active'
        ? { background: '#4F46E5', color: 'white' }
        : { border: '1px solid var(--color-border)', color: 'var(--color-muted)' };
  return (
    <span className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0" style={style}>
      {status === 'done' ? '✓' : number}
    </span>
  );
}

/**
 * One step of the review checklist. Only the active step is open; finished
 * steps collapse to a summary with "Change"; later steps show what comes next.
 */
export function GuidedStep({ number, total, title, whatToDo, status, summary, onChange, children }: GuidedStepProps) {
  if (status === 'done') {
    return (
      <div className="surface rounded-2xl px-5 py-4 mt-4 flex flex-wrap items-center gap-4">
        <Badge number={number} status="done" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          {summary && <div className="text-xs text-[color:var(--color-muted)] mt-0.5">{summary}</div>}
        </div>
        {onChange && (
          <button type="button" className="btn-secondary text-sm" onClick={onChange}>
            Change
          </button>
        )}
      </div>
    );
  }

  if (status === 'upcoming') {
    return (
      <div className="rounded-2xl px-5 py-4 mt-4 flex items-center gap-4 border border-dashed border-[color:var(--color-border)]">
        <Badge number={number} status="upcoming" />
        <div className="text-sm text-[color:var(--color-muted)]">
          {title} <span className="mono text-xs">· comes next</span>
        </div>
      </div>
    );
  }

  return (
    <section
      className="rounded-2xl mt-6 p-5 md:p-6"
      style={{ border: '1px solid #4F46E5', background: 'rgba(79,70,229,0.06)' }}
      aria-labelledby={`step-${number}-title`}
    >
      <div className="flex items-start gap-4">
        <Badge number={number} status="active" />
        <div className="min-w-0">
          <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
            Step {number} of {total}
          </div>
          <h2 id={`step-${number}-title`} className="text-xl font-bold mt-1">
            {title}
          </h2>
          {whatToDo && (
            <p className="text-sm mt-2">
              <span className="font-semibold" style={{ color: '#A5B4FC' }}>What to do: </span>
              {whatToDo}
            </p>
          )}
        </div>
      </div>
      <div className="[&>*:first-child]:mt-4">{children}</div>
    </section>
  );
}
