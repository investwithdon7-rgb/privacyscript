'use client';

import type { Mode } from '@/lib/constants';

interface ModeSelectorProps {
  value: Mode | null;
  onChange: (mode: Mode) => void;
}

export function ModeSelector({ value, onChange }: ModeSelectorProps) {
  return (
    <div className="grid md:grid-cols-2 gap-4 mt-8">
      <ModeCard
        active={value === 'PSEUDONYMISE'}
        onClick={() => onChange('PSEUDONYMISE')}
        title="Pseudonymise"
        legal="GDPR Article 4(5)"
        bullet1="Identifiers replaced with consistent tokens. Same patient → same pseudonym."
        bullet2="A re-identification key file is generated. You hold the key, not us."
        bullet3="Data remains personal data. Suitable for analytics, research cohorts, internal sharing."
      />
      <ModeCard
        active={value === 'ANONYMISE'}
        onClick={() => onChange('ANONYMISE')}
        title="Anonymise"
        legal="GDPR Recital 26"
        bullet1="One-way replacement. No key. No re-linkability."
        bullet2="Dates reduced to year. Postcodes generalised. Quasi-identifiers suppressed."
        bullet3="Suitable for feeding to AI tools without a BAA/DPA, or public research datasets."
      />
    </div>
  );
}

interface ModeCardProps {
  active: boolean;
  onClick: () => void;
  title: string;
  legal: string;
  bullet1: string;
  bullet2: string;
  bullet3: string;
}

function ModeCard({ active, onClick, title, legal, bullet1, bullet2, bullet3 }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-6 rounded-2xl transition-colors ${
        active
          ? 'bg-[color:var(--color-surface-2)] border-2 border-[#4F46E5]'
          : 'surface hover:bg-[color:var(--color-surface-2)] border-2'
      }`}
      style={!active ? { borderColor: 'var(--color-border)' } : undefined}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-2xl font-bold">{title}</h3>
        <span className="tag">{legal}</span>
      </div>
      <ul className="space-y-2 text-sm text-[color:var(--color-muted)] leading-relaxed">
        <li>• {bullet1}</li>
        <li>• {bullet2}</li>
        <li>• {bullet3}</li>
      </ul>
    </button>
  );
}
