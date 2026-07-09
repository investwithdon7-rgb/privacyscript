'use client';

import type { Span } from '@/engine/detect';

interface UncertainDetectionsPanelProps {
  spans: Span[];
  decisions: Record<string, boolean>;
  onDecide: (key: string, confirmed: boolean) => void;
  onConfirmAll: () => void;
}

function spanKey(s: Span): string {
  return `${s.start}:${s.end}:${s.label}`;
}

const LABEL_COLOURS: Record<string, string> = {
  NAME: '#4F46E5',
  ADDRESS_LINE: '#7C3AED',
  INSTITUTION: '#9333EA',
};

export function UncertainDetectionsPanel({
  spans,
  decisions,
  onDecide,
  onConfirmAll,
}: UncertainDetectionsPanelProps) {
  if (spans.length === 0) return null;

  const undecided = spans.filter((s) => decisions[spanKey(s)] === undefined);
  const confirmed = spans.filter((s) => decisions[spanKey(s)] === true);
  const dismissed = spans.filter((s) => decisions[spanKey(s)] === false);

  return (
    <div className="surface rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold">The engine is not sure about these</h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1">
            Each item was detected with moderate confidence (50 to 85 percent).
            Decide for each one: redact it, or keep the text as-is.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="tag">{confirmed.length} to redact</span>
          <span className="tag">{dismissed.length} kept as-is</span>
          <span className="tag">{undecided.length} to decide</span>
        </div>
      </div>

      <ul className="divide-y divide-[color:var(--color-border)] mb-4">
        {spans.map((s) => {
          const key = spanKey(s);
          const decision = decisions[key];
          const conf = s.confidence ?? 0;
          const labelColour = LABEL_COLOURS[s.label] ?? '#64748B';

          return (
            <li key={key} className="py-4" style={{ opacity: decision === undefined ? 1 : 0.75 }}>
              <div className="flex items-start gap-4">
                {/* Text snippet */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="mono text-xs px-2 py-0.5 rounded-full font-semibold"
                      style={{ background: `${labelColour}22`, color: labelColour, border: `1px solid ${labelColour}44` }}
                    >
                      {s.label}
                    </span>
                    <span
                      className="font-semibold truncate max-w-xs"
                      style={{ textDecoration: decision === false ? 'line-through' : 'none' }}
                    >
                      &ldquo;{s.text}&rdquo;
                    </span>
                    {decision !== undefined && (
                      <span className="mono text-xs text-[color:var(--color-muted)]">
                        {decision ? 'will be redacted' : 'stays as-is'}
                      </span>
                    )}
                  </div>

                  {/* Confidence bar */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full surface-2 overflow-hidden max-w-32">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{
                          width: `${Math.round(conf * 100)}%`,
                          background: conf >= 0.75 ? 'var(--color-warning)' : 'var(--color-muted)',
                        }}
                      />
                    </div>
                    <span className="mono text-xs text-[color:var(--color-muted)]">
                      {Math.round(conf * 100)}% confidence
                    </span>
                  </div>
                </div>

                {/* Decision buttons */}
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onDecide(key, true)}
                    aria-pressed={decision === true}
                    className="px-3 py-1.5 rounded-full text-xs font-semibold border transition-all"
                    style={
                      decision === true
                        ? { background: 'var(--color-primary)', color: 'white', borderColor: 'var(--color-primary)' }
                        : { borderColor: 'var(--color-border)', color: 'var(--color-muted)' }
                    }
                  >
                    Redact
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecide(key, false)}
                    aria-pressed={decision === false}
                    className="px-3 py-1.5 rounded-full text-xs font-semibold border transition-all"
                    style={
                      decision === false
                        ? { background: 'rgba(239,68,68,0.15)', color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }
                        : { borderColor: 'var(--color-border)', color: 'var(--color-muted)' }
                    }
                  >
                    Keep as-is
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between flex-wrap gap-3 pt-2">
        <button
          type="button"
          onClick={() => spans.forEach((s) => onDecide(spanKey(s), true))}
          className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors"
        >
          Redact all of these
        </button>
        <button
          type="button"
          onClick={onConfirmAll}
          className="btn-primary text-sm"
          disabled={undecided.length > 0}
        >
          {undecided.length > 0
            ? `${undecided.length} decision${undecided.length === 1 ? '' : 's'} remaining`
            : 'Done, continue'}
        </button>
      </div>
    </div>
  );
}
