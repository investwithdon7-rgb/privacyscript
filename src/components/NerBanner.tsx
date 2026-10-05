'use client';

import { useEffect, useState } from 'react';
import {
  preloadNer,
  getNerStatus,
  subscribeNerStatus,
  getThoroughCheck,
  setThoroughCheck,
  subscribeThoroughCheck,
  NER_MODELS,
  type NERStatus,
} from '@/engine/ner';

export function NerBanner() {
  const [status, setStatus] = useState<NERStatus>(getNerStatus());
  const [thorough, setThorough] = useState(false);

  useEffect(() => subscribeNerStatus(setStatus), []);
  useEffect(() => {
    setThorough(getThoroughCheck());
    return subscribeThoroughCheck(setThorough);
  }, []);

  const trigger = () => preloadNer();

  const thoroughToggle = (
    <label className="flex items-start gap-3 mt-3 pt-3 border-t border-[color:var(--color-border)] cursor-pointer">
      <input
        type="checkbox"
        className="mt-1"
        checked={thorough}
        onChange={(e) => setThoroughCheck(e.target.checked)}
      />
      <span>
        <span className="text-sm font-semibold">Thorough check for English records</span>
        <span className="block text-xs text-[color:var(--color-muted)] mt-1 mono">
          Adds a second model trained on clinical notes. It finds some names the main model misses.
          Downloads once (~{NER_MODELS.clinical.sizeMb} MB) and takes about 1.5 times as long.
        </span>
      </span>
    </label>
  );

  if (status.loaded && status.loadProgress >= 100) {
    return (
      <div className="surface rounded-xl px-4 py-3 mt-6">
        <div className="flex items-center justify-between">
          <span className="mono text-xs text-[color:var(--color-muted)]">
            Name detection active · names, places, organisations{thorough ? ' · thorough check on' : ''}.
          </span>
          <span
            className="mono text-[10px] uppercase tracking-widest"
            style={{ color: 'var(--color-success)' }}
          >
            ready on this device
          </span>
        </div>
        {thoroughToggle}
      </div>
    );
  }

  return (
    <div className="surface rounded-xl px-4 py-3 mt-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold">Name detection</div>
          <div className="text-xs text-[color:var(--color-muted)] mt-1 mono">
            {status.error
              ? `Could not load the name-detection model. The rule engine is running on its own. (${status.error})`
              : status.loadProgress > 0
              ? `Loading model… ${status.loadProgress}%`
              : `Finds names, places and organisations in English, Dutch, German, Spanish and more. Downloads once (~${NER_MODELS.multilingual.sizeMb} MB) and runs on this device; later visits load it instantly.`}
          </div>
        </div>
        {status.loadProgress > 0 && status.loadProgress < 100 ? null : (
          <button type="button" className="btn-secondary" onClick={trigger}>
            {status.error ? 'Retry' : 'Enable'}
          </button>
        )}
      </div>
      {thoroughToggle}
    </div>
  );
}
