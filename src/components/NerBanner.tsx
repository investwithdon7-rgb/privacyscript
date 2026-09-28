'use client';

import { useEffect, useState } from 'react';
import {
  preloadNer,
  getNerStatus,
  subscribeNerStatus,
  type NERStatus,
} from '@/engine/ner';

export function NerBanner() {
  const [status, setStatus] = useState<NERStatus>(getNerStatus());

  useEffect(() => subscribeNerStatus(setStatus), []);

  const trigger = () => preloadNer();

  if (status.loaded) {
    return (
      <div className="surface rounded-xl px-4 py-3 mt-6 flex items-center justify-between">
        <span className="mono text-xs text-[color:var(--color-muted)]">
          NER active · names, locations, organisations.
        </span>
        <span
          className="mono text-[10px] uppercase tracking-widest"
          style={{ color: 'var(--color-success)' }}
        >
          loaded · cached
        </span>
      </div>
    );
  }

  return (
    <div className="surface rounded-xl px-4 py-3 mt-6 flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-semibold">Name detection</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 mono">
          {status.error
            ? `Could not load the name-detection model. The rule engine is running on its own. (${status.error})`
            : status.loadProgress > 0
            ? `Loading model… ${status.loadProgress}%`
            : 'Finds names, places and organisations in English, Dutch, German, Spanish and more. Downloads once (~135 MB) and runs on this device; later visits load it instantly.'}
        </div>
      </div>
      {status.loadProgress > 0 && status.loadProgress < 100 ? null : (
        <button type="button" className="btn-secondary" onClick={trigger}>
          {status.error ? 'Retry' : 'Enable'}
        </button>
      )}
    </div>
  );
}
