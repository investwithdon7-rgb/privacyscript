'use client';

import type { OriginSuggestion } from '@/engine/jurisdiction';
import { COMPLIANCE_PROFILES, type ComplianceProfileId, type Mode } from '@/lib/constants';

/** Profile family a regime's rules belong to, keeping the chosen mode. */
function profileFor(regime: OriginSuggestion['regime'], mode: Mode): ComplianceProfileId | null {
  if (regime === 'US') return 'HIPAA_SAFE_HARBOR';
  if (regime === 'EU' || regime === 'UK') return mode === 'PSEUDONYMISE' ? 'GDPR_PSEUDO' : 'GDPR_ANON';
  return null;
}

const isHipaa = (id: ComplianceProfileId) => id.startsWith('HIPAA');

/**
 * Detected language and likely origin, with the rules that would usually
 * apply. A suggestion only: the user confirms or switches.
 */
export function OriginBanner({
  origin,
  profile,
  mode,
  onSwitch,
}: {
  origin: OriginSuggestion;
  profile: ComplianceProfileId;
  mode: Mode;
  onSwitch: (id: ComplianceProfileId) => void;
}) {
  const suggested = profileFor(origin.regime, mode);
  const mismatch =
    origin.confident &&
    suggested !== null &&
    (origin.regime === 'US' ? !isHipaa(profile) : isHipaa(profile));

  const where = origin.confident && origin.countryName
    ? `Looks like a record from ${origin.countryName}${origin.reasons.length ? ` (${origin.reasons.join(', ')})` : ''}.`
    : origin.languageName
    ? 'No clue to the country (such as an ID number or phone code) was found.'
    : '';

  return (
    <div className="surface rounded-2xl px-6 py-4 mt-4 text-sm">
      <div className="font-semibold">
        {origin.languageName ? `Language: ${origin.languageName}` : 'Language: not enough text to tell'}
      </div>
      {where && <p className="text-[color:var(--color-muted)] mt-1">{where}</p>}
      {origin.confident && origin.lawNote && <p className="text-[color:var(--color-muted)] mt-1">{origin.lawNote}</p>}
      <p className="text-[color:var(--color-muted)] mt-1">
        Rules in use: {COMPLIANCE_PROFILES[profile].label}. The law that applies depends on where your organisation and
        the patients are, not on the language, so check this is right.
      </p>
      {mismatch && suggested && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span>
            Records from {origin.countryName} usually follow {origin.regime === 'US' ? 'HIPAA' : 'GDPR'}.
          </span>
          <button type="button" className="btn-secondary" onClick={() => onSwitch(suggested)}>
            Use {COMPLIANCE_PROFILES[suggested].label}
          </button>
        </div>
      )}
    </div>
  );
}
