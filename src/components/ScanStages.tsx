'use client';

import { useEffect, useRef, useState } from 'react';
import { getNerStatus, subscribeNerStatus, type NERStatus } from '@/engine/ner';
import { useSession } from '@/hooks/useSession';

interface ScanStagesProps {
  filename: string | null;
  /** 'check' ends with the rules check; 'deidentify' with preparing the review. */
  variant: 'check' | 'deidentify';
  onCancel?: () => void;
}

type StageState = 'done' | 'active' | 'pending';

interface Stage {
  key: string;
  label: string;
  detail?: string;
  state: StageState;
  /** Share of the overall bar this stage represents. */
  weight: number;
  /** 0..1 progress within the stage while active. */
  fraction?: number;
}

function Icon({ state }: { state: StageState }) {
  if (state === 'done') {
    return (
      <span
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
        style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--color-success)', border: '1px solid var(--color-success)' }}
        aria-hidden
      >
        ✓
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="w-6 h-6 flex items-center justify-center shrink-0" aria-hidden>
        <span className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </span>
    );
  }
  return (
    <span
      className="w-6 h-6 rounded-full shrink-0"
      style={{ border: '1px solid var(--color-border)' }}
      aria-hidden
    />
  );
}

/**
 * Prominent, staged progress for scanning a document: shown in place of the
 * drop zone so the user sees at once that their file is being worked on,
 * what is happening, and roughly how far along it is.
 */
export function ScanStages({ filename, variant, onCancel }: ScanStagesProps) {
  const s = useSession();
  const [ner, setNer] = useState<NERStatus>(getNerStatus());
  useEffect(() => subscribeNerStatus(setNer), []);

  // Show the model-download stage only if the model wasn't ready when we started.
  const [needsDownload] = useState(() => !getNerStatus().loaded);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const read = s.originalText !== null;
  const detected = s.detection !== null;
  const finished = variant === 'check' ? s.complianceCheck !== null : detected;
  const modelReady = ner.loaded || !!ner.error;
  const finding = s.nerProgress?.phase === 'detect' ? s.nerProgress : null;

  const stages: Stage[] = [
    {
      key: 'read',
      label: 'Reading your file',
      detail: s.scanProgress && !read
        ? `${s.scanProgress.pagesDone} of ${s.scanProgress.pagesTotal} pages (text recognition)`
        : undefined,
      state: read ? 'done' : 'active',
      weight: s.scanProgress ? 0.4 : 0.1,
      fraction: s.scanProgress && s.scanProgress.pagesTotal
        ? s.scanProgress.pagesDone / s.scanProgress.pagesTotal
        : undefined,
    },
    ...(needsDownload
      ? [{
          key: 'model',
          label: 'Downloading the name-detection model',
          detail: ner.error ? 'Unavailable, continuing with rules only' : modelReady ? 'Ready, saved for next time' : `${ner.loadProgress}% · first time only`,
          state: (modelReady ? 'done' : 'active') as StageState,
          weight: 0.3,
          fraction: ner.loadProgress / 100,
        }]
      : []),
    {
      key: 'find',
      label: 'Finding names and personal details',
      detail: finding ? `part ${finding.done} of ${finding.total}` : detected ? undefined : read && modelReady ? 'starting…' : undefined,
      state: detected ? 'done' : read && modelReady ? 'active' : 'pending',
      weight: 0.5,
      fraction: finding ? finding.done / Math.max(finding.total, 1) : undefined,
    },
    variant === 'check'
      ? {
          key: 'rules',
          label: 'Checking against the rules you chose',
          state: finished ? 'done' : detected ? 'active' : 'pending',
          weight: 0.1,
        }
      : {
          key: 'review',
          label: 'Preparing your review',
          state: detected ? 'done' : 'pending',
          weight: 0.1,
        },
  ];

  const total = stages.reduce((a, st) => a + st.weight, 0);
  const progress = stages.reduce(
    (a, st) => a + st.weight * (st.state === 'done' ? 1 : st.state === 'active' ? st.fraction ?? 0.15 : 0),
    0
  ) / total;
  const active = stages.find((st) => st.state === 'active');

  return (
    <div
      ref={ref}
      className="rounded-2xl p-6 mt-4"
      style={{ background: 'rgba(79,70,229,0.08)', border: '1px solid #4F46E5' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold">
            {finished ? 'Done' : active ? `${active.label}…` : 'Working…'}
          </div>
          <div className="mono text-xs text-[color:var(--color-muted)] mt-1 truncate">
            {filename ?? 'your document'} · {seconds}s
          </div>
        </div>
        {onCancel && !finished && (
          <button type="button" className="btn-secondary text-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      <div className="h-2.5 rounded-full surface-2 overflow-hidden mt-5">
        <div
          className="h-2.5 transition-all duration-500"
          style={{ background: '#4F46E5', width: `${Math.max(4, Math.round(progress * 100))}%` }}
        />
      </div>

      <ol className="mt-5 space-y-3">
        {stages.map((st) => (
          <li key={st.key} className="flex items-center gap-3">
            <Icon state={st.state} />
            <span
              className="text-sm flex-1"
              style={{ color: st.state === 'pending' ? 'var(--color-muted)' : 'white', fontWeight: st.state === 'active' ? 600 : 400 }}
            >
              {st.label}
            </span>
            {st.detail && (
              <span className="mono text-xs text-[color:var(--color-muted)] text-right">{st.detail}</span>
            )}
          </li>
        ))}
      </ol>

      <p className="text-xs text-[color:var(--color-muted)] mt-5">
        🔒 Everything happens on this device. Your file is not uploaded. Long transcripts can take
        a minute; you can keep using the page.
      </p>
    </div>
  );
}
