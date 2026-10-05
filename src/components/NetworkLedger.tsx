'use client';

import { useEffect, useState } from 'react';
import { contactedHosts, getNerStatus, subscribeNerStatus } from '@/engine/ner';

/**
 * Shows every host this tab (page and name-detection worker) fetched from
 * while the user worked, so they can see for themselves that only the app's
 * own files and the one-time model download were requested. Read from the
 * browser's own resource timeline: nothing is logged or sent anywhere.
 */
export function NetworkLedger() {
  const [hosts, setHosts] = useState<string[]>([]);

  useEffect(() => {
    const refresh = () =>
      setHosts(Array.from(new Set([...contactedHosts(), ...(getNerStatus().networkHosts ?? [])])).sort());
    refresh();
    const unsubscribe = subscribeNerStatus(refresh);
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver(refresh);
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      /* older browsers: the snapshot above is enough */
    }
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, []);

  const here = typeof window !== 'undefined' ? window.location.host : '';
  const describe = (h: string): { label: string; ok: boolean } => {
    if (h === here) return { label: 'this site (the app itself)', ok: true };
    if (/(^|\.)huggingface\.co$|(^|\.)hf\.co$/.test(h)) return { label: 'name-detection model download (once)', ok: true };
    if (h === 'cdn.jsdelivr.net') return { label: 'text-recognition language data (once)', ok: true };
    return { label: 'unexpected', ok: false };
  };

  return (
    <div className="surface rounded-2xl p-6 mt-6">
      <div className="font-semibold">Connections made while you worked</div>
      <p className="text-sm text-[color:var(--color-muted)] mt-1">
        Your file was processed in this browser tab. These are all the places this tab downloaded from,
        read from your browser&apos;s own records:
      </p>
      <ul className="mt-3 space-y-1 text-sm">
        {hosts.map((h) => {
          const d = describe(h);
          return (
            <li key={h} className="flex items-center gap-2">
              <span style={{ color: d.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{d.ok ? '●' : '▲'}</span>
              <span className="mono">{h}</span>
              <span className="text-[color:var(--color-muted)]">· {d.label}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-[color:var(--color-muted)] mt-3">
        The site&apos;s security policy lets the browser connect only to these kinds of hosts, and
        PrivacyScript only downloads from them: it never sends your file anywhere.
      </p>
    </div>
  );
}
