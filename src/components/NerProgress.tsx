'use client';

import { useEffect, useState } from 'react';
import { getNerStatus, subscribeNerStatus, type NERStatus } from '@/engine/ner';

interface NerProgressProps {
  progress: { phase: 'detect' | 'validate'; done: number; total: number } | null;
  /** Shown when set; cancels the run. */
  onCancel?: () => void;
}

/**
 * Live progress for the background name detection: model download on first
 * use, then "part N of M". The page stays usable throughout.
 */
export function NerProgress({ progress, onCancel }: NerProgressProps) {
  const [status, setStatus] = useState<NERStatus>(getNerStatus());
  useEffect(() => subscribeNerStatus(setStatus), []);

  const downloading = !status.loaded && !status.error && status.loadProgress < 100 && !progress;
  const pct = progress
    ? Math.round((progress.done / Math.max(progress.total, 1)) * 100)
    : downloading
      ? status.loadProgress
      : 0;
  const label = progress
    ? `${progress.phase === 'detect' ? 'Finding names, places and organisations' : 'Checking the result'} · part ${progress.done} of ${progress.total}`
    : downloading
      ? `Downloading the name-detection model (first time only) · ${status.loadProgress}%`
      : 'Reading the document…';

  return (
    <div className="surface rounded-2xl p-6 mt-8" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">{label}</div>
        {onCancel && (
          <button type="button" className="btn-secondary text-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div className="h-2 rounded-full surface-2 overflow-hidden mt-3">
        <div className="h-2 transition-all" style={{ background: '#4F46E5', width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-3">
        This runs in the background on this device. Long transcripts can take a minute; you can
        keep using the page.
      </p>
    </div>
  );
}
