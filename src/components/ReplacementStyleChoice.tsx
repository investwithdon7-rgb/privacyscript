'use client';

import type { Mode } from '@/lib/constants';

function choiceClass(active: boolean): string {
  const base = 'rounded-full px-3 py-1 text-xs border transition-colors';
  return active
    ? `${base} border-[color:var(--color-primary)] text-white bg-[rgba(79,70,229,0.15)]`
    : `${base} border-[color:var(--color-border)] text-[color:var(--color-muted)] hover:text-white`;
}

/** Codes ([NAME-3F7A91B2]) or realistic fake values (Laura Bennett). */
export function ReplacementStyleChoice({
  value,
  mode,
  onChange,
}: {
  value: 'codes' | 'realistic';
  mode: Mode;
  onChange: (v: 'codes' | 'realistic') => void;
}) {
  return (
    <div className="surface rounded-2xl px-6 py-4 mt-4">
      <h3 className="mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted)]">
        How replaced details look
      </h3>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Replacement style">
        <button type="button" role="radio" aria-checked={value === 'codes'} className={choiceClass(value === 'codes')} onClick={() => onChange('codes')}>
          Codes: {mode === 'PSEUDONYMISE' ? '[NAME-3F7A91B2]' : '[NAME]'}
        </button>
        <button type="button" role="radio" aria-checked={value === 'realistic'} className={choiceClass(value === 'realistic')} onClick={() => onChange('realistic')}>
          Realistic: Laura Bennett, 07700 900123
        </button>
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-2">
        Realistic fake values read naturally for AI tools and readers, and a name the detectors missed no
        longer stands out. The same person always gets the same fake name. Fake phone and NHS numbers use
        ranges reserved for fiction, so they never belong to a real person.
        {mode === 'PSEUDONYMISE' ? ' Your key file maps them back.' : ''}
      </p>
    </div>
  );
}
