'use client';

import {
  COMPLIANCE_PROFILES,
  COMPLIANCE_PROFILE_IDS,
  type ComplianceProfileId,
} from '@/lib/constants';

interface ComplianceModeSelectorProps {
  value: ComplianceProfileId;
  onChange: (id: ComplianceProfileId) => void;
}

const CATEGORY_COLOURS: Record<string, string> = {
  HIPAA: '#4F46E5',
  GDPR: '#7C3AED',
  EHDS: '#0EA5E9',
};

function profileCategory(id: ComplianceProfileId): string {
  if (id.startsWith('HIPAA')) return 'HIPAA';
  if (id.startsWith('GDPR')) return 'GDPR';
  return 'EHDS';
}

export function ComplianceModeSelector({ value, onChange }: ComplianceModeSelectorProps) {
  return (
    <div className="mt-4">
      <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
        Where will this data go?
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {COMPLIANCE_PROFILE_IDS.map((id) => {
          const profile = COMPLIANCE_PROFILES[id];
          const category = profileCategory(id);
          const colour = CATEGORY_COLOURS[category] ?? '#4F46E5';
          const selected = value === id;

          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className="text-left p-4 rounded-xl border transition-all"
              style={{
                background: selected ? `${colour}18` : 'var(--color-surface)',
                borderColor: selected ? colour : 'var(--color-border)',
                boxShadow: selected ? `0 0 0 1px ${colour}44` : 'none',
              }}
            >
              {/* Header row */}
              <div className="flex items-center justify-between mb-2">
                <span
                  className="mono text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full font-semibold"
                  style={{
                    background: `${colour}22`,
                    color: colour,
                    border: `1px solid ${colour}44`,
                  }}
                >
                  {category}
                </span>
                {selected && (
                  <span
                    className="text-xs font-semibold"
                    style={{ color: colour }}
                  >
                    Selected
                  </span>
                )}
              </div>

              {/* Profile name */}
              <div className="font-semibold text-sm mb-1">{profile.label}</div>
              <div className="mono text-[10px] text-[color:var(--color-muted)] mb-2">
                {profile.regulation}
              </div>

              {/* Description */}
              <div className="text-xs text-[color:var(--color-muted)] leading-relaxed">
                {profile.description}
              </div>

              {/* Badges */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="tag text-[10px]">k≥{profile.kThreshold}</span>
                <span className="tag text-[10px]">
                  {profile.dateHandling === 'shift'
                    ? 'Shift dates'
                    : profile.dateHandling === 'year_only'
                    ? 'Year only'
                    : 'Suppress dates'}
                </span>
                <span className="tag text-[10px]">
                  {profile.suppressAllQuasi ? 'Suppress quasi-identifiers' : 'Review quasi-identifiers'}
                </span>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full border font-medium"
                  style={{ borderColor: `${colour}44`, color: colour, background: `${colour}11` }}
                >
                  {profile.recommendedMode}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
