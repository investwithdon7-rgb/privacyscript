'use client';

import type { Span } from '@/engine/detect';

interface QuasiIdentifierReviewProps {
  quasiSpans: Span[];
  redactSet: Set<string>;
  onToggle: (label: string) => void;
  onConfirm: () => void;
}

const LABEL_DESCRIPTIONS: Record<string, string> = {
  RARE_DISEASE_ICD:
    'Rare ICD-10 code. Keeping it strongly identifies the patient. We recommend redacting it.',
  INSTITUTION:
    'Treating institution. Combined with the date of admission, this is highly identifying.',
  ETHNICITY: 'Ethnicity or race field. A quasi-identifier under GDPR Article 9.',
  OCCUPATION:
    'Occupation. A quasi-identifier; unique combinations can identify a person.',
};

export function QuasiIdentifierReview({
  quasiSpans,
  redactSet,
  onToggle,
  onConfirm,
}: QuasiIdentifierReviewProps) {
  const byLabel = new Map<string, Span[]>();
  for (const s of quasiSpans) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label)!.push(s);
  }
  const labels = Array.from(byLabel.keys());

  return (
    <div className="surface rounded-2xl p-6 mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Quasi-identifiers detected</h2>
        <span className="tag">{labels.length} types · {quasiSpans.length} matches</span>
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mb-4">
        These fields are not direct identifiers but can re-identify a person in combination.
        Decide which to redact before the pipeline continues.
      </p>

      {labels.length === 0 ? (
        <div className="text-sm text-[color:var(--color-muted)] mono">
          None found. You can proceed.
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {labels.map((label) => {
            const spans = byLabel.get(label)!;
            const checked = redactSet.has(label);
            return (
              <li key={label} className="py-3 flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="mono text-sm font-semibold">{label}</div>
                  <div className="text-xs text-[color:var(--color-muted)] mt-1">
                    {LABEL_DESCRIPTIONS[label] ?? 'Quasi-identifier. Review for risk.'}
                  </div>
                  <div className="text-xs text-[color:var(--color-muted)] mt-1 mono">
                    {spans.length} match{spans.length === 1 ? '' : 'es'}: {spans.slice(0, 3).map((s) => `"${s.text}"`).join(', ')}
                    {spans.length > 3 ? '…' : ''}
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(label)}
                    className="w-4 h-4 accent-[#4F46E5]"
                  />
                  <span className="text-sm">Redact</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex justify-end">
        <button type="button" onClick={onConfirm} className="btn-primary">
          Confirm and continue
        </button>
      </div>
    </div>
  );
}
