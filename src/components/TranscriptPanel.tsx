'use client';

import type { Mode } from '@/lib/constants';
import { useSession } from '@/hooks/useSession';
import { updateSession } from '@/state/session';
import { relabelSpeakers, type SpeakerRole, type TranscriptState } from '@/engine/transcript';

interface TranscriptPanelProps {
  transcript: TranscriptState;
  mode: Mode;
  onChange: (next: TranscriptState) => void;
  onConfirm: () => void;
}

const inputClass =
  'surface-2 rounded-lg px-2 py-1.5 text-sm w-full border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-primary)]';

function choiceClass(active: boolean, tone: 'danger' | 'neutral'): string {
  const base = 'rounded-full px-3 py-1 text-xs border transition-colors';
  if (!active) return `${base} border-[color:var(--color-border)] text-[color:var(--color-muted)] hover:text-white`;
  return tone === 'danger'
    ? `${base} border-[color:var(--color-danger)] text-white bg-[rgba(239,68,68,0.15)]`
    : `${base} border-[color:var(--color-primary)] text-white bg-[rgba(79,70,229,0.15)]`;
}

export function TranscriptPanel({ transcript, mode, onChange, onConfirm }: TranscriptPanelProps) {
  const realistic = useSession().replacementStyle === 'realistic';
  const { info, flags, flagDecisions } = transcript;
  const named = info.speakers.filter((s) => s.isName);
  const undecided = flags.filter((f) => flagDecisions[f.id] === undefined).length;

  const setDisplay = (label: string, display: string) =>
    onChange({
      ...transcript,
      info: {
        ...info,
        speakers: info.speakers.map((s) => (s.label === label ? { ...s, display } : s)),
      },
    });

  // Changing a role renumbers everyone: "Interviewer", "Participant 1, 2…".
  const setRole = (label: string, role: SpeakerRole) =>
    onChange({
      ...transcript,
      info: {
        ...info,
        speakers: relabelSpeakers(info.speakers.map((s) => (s.label === label ? { ...s, role } : s))),
      },
    });

  const decide = (id: number, d: 'keep' | 'remove') =>
    onChange({ ...transcript, flagDecisions: { ...flagDecisions, [id]: d } });

  const decideAll = (d: 'keep' | 'remove') =>
    onChange({
      ...transcript,
      flagDecisions: Object.fromEntries(flags.map((f) => [f.id, d])),
    });

  const blankDisplay = named.some((s) => !s.display.trim());

  return (
    <div className="surface rounded-2xl p-6 mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 className="text-lg font-semibold">Interview transcript</h2>
        <span className="tag">
          {info.kindLabel} · {info.speakers.length} speakers · {info.turnCount} turns
        </span>
      </div>
      <p className="text-sm text-[color:var(--color-muted)]">
        Timestamps are kept as they are. Speaker names are replaced everywhere they appear,
        including in lower case.
      </p>
      {info.language === 'other' && (
        <p
          className="text-sm mt-3 rounded-lg px-3 py-2"
          style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid var(--color-warning)' }}
        >
          We couldn&apos;t tell which language this transcript is in. Name detection is trained on
          English, Dutch, German, Spanish, French, Italian and Portuguese; in other languages some
          names may be missed. Check the names offered for review, and read the result before
          sharing it.
        </p>
      )}

      {/* Speakers */}
      <h3 className="mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted)] mt-6">
        Speakers
      </h3>
      <ul className="mt-2 divide-y divide-[color:var(--color-border)]">
        {info.speakers.map((s) => (
          <li key={s.label} className="py-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
            <div className="min-w-0">
              <div className="mono text-sm font-semibold truncate" title={s.label}>{s.label}</div>
              <div className="text-xs text-[color:var(--color-muted)] mt-0.5">
                {s.turns} turn{s.turns === 1 ? '' : 's'} ·{' '}
                {s.isName ? 'Looks like a real name, so it will be replaced' : 'Already anonymous, so it will be kept'}
              </div>
            </div>
            {s.isName ? (
              <div>
                <label className="block">
                  <span className="sr-only">Replace {s.label} with</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[color:var(--color-muted)] shrink-0">becomes</span>
                    <input
                      className={inputClass}
                      value={s.display}
                      onChange={(e) => setDisplay(s.label, e.target.value)}
                      maxLength={40}
                    />
                  </div>
                </label>
                <div className="flex gap-2 mt-2" role="radiogroup" aria-label={`Role of ${s.label}`}>
                  {(['INTERVIEWER', 'PARTICIPANT'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={s.role === r}
                      className={choiceClass(s.role === r, 'neutral')}
                      onClick={() => setRole(s.label, r)}
                    >
                      {r === 'INTERVIEWER' ? 'Interviewer' : 'Participant'}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-sm text-[color:var(--color-muted)]">Kept as “{s.label}”</div>
            )}
          </li>
        ))}
      </ul>

      {/* Replacement style */}
      <h3 className="mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted)] mt-6">
        How other people and places are replaced
      </h3>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Replacement style">
        <button
          type="button"
          role="radio"
          aria-checked={transcript.readable}
          className={choiceClass(transcript.readable, 'neutral')}
          onClick={() => {
            updateSession({ replacementStyle: 'codes' });
            onChange({ ...transcript, readable: true });
          }}
        >
          Readable: [Person 1], [Organisation 2]
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!transcript.readable && realistic}
          className={choiceClass(!transcript.readable && realistic, 'neutral')}
          onClick={() => {
            updateSession({ replacementStyle: 'realistic' });
            onChange({ ...transcript, readable: false });
          }}
        >
          Realistic: Laura Bennett, Ashbury
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!transcript.readable && !realistic}
          className={choiceClass(!transcript.readable && !realistic, 'neutral')}
          onClick={() => {
            updateSession({ replacementStyle: 'codes' });
            onChange({ ...transcript, readable: false });
          }}
        >
          Codes: {mode === 'PSEUDONYMISE' ? '[NAME-3F7A91B2]' : '[NAME]'}
        </button>
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-2">
        Readable labels are numbered in the order people are mentioned, and the same person
        keeps the same number. Best for coding in NVivo or pasting into an AI tool. Realistic fake
        names read like the original conversation; speakers keep their Interviewer / Participant labels.
      </p>

      {/* Contextual passages */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-6">
        <h3 className="mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted)]">
          Passages that could identify someone ({flags.length})
        </h3>
        {flags.length > 1 && (
          <div className="flex gap-2">
            <button type="button" className={choiceClass(false, 'neutral')} onClick={() => decideAll('keep')}>
              Keep all
            </button>
            <button type="button" className={choiceClass(false, 'danger')} onClick={() => decideAll('remove')}>
              Remove all
            </button>
          </div>
        )}
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mt-1">
        A sentence can identify someone without a name in it, such as “the only Somali nurse on
        the ward”. We found these for you to decide on. Automated checks can miss this kind of
        detail, so skim the result before you share it.
        {mode === 'ANONYMISE' &&
          ' An anonymised transcript only counts as anonymous once a person has checked it like this.'}
      </p>

      {flags.length === 0 ? (
        <div className="text-sm mono text-[color:var(--color-muted)] mt-3">None found.</div>
      ) : (
        <ul className="mt-3 space-y-2">
          {flags.map((f) => {
            const d = flagDecisions[f.id];
            return (
              <li
                key={f.id}
                className="surface-2 rounded-xl p-3"
                style={{
                  borderLeft: `3px solid ${
                    d === 'remove' ? 'var(--color-danger)' : d === 'keep' ? 'var(--color-success)' : 'var(--color-warning)'
                  }`,
                }}
              >
                <div className="text-xs text-[color:var(--color-warning)]">{f.reason}</div>
                <div
                  className="text-sm mt-1"
                  style={d === 'remove' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}
                >
                  “{f.text}”
                </div>
                <div className="flex gap-2 mt-2">
                  <button type="button" className={choiceClass(d === 'keep', 'neutral')} onClick={() => decide(f.id, 'keep')}>
                    Keep, it&apos;s fine
                  </button>
                  <button type="button" className={choiceClass(d === 'remove', 'danger')} onClick={() => decide(f.id, 'remove')}>
                    Remove this passage
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {undecided > 0 && (
          <span className="text-sm" style={{ color: 'var(--color-warning)' }}>
            Decide on {undecided} more passage{undecided === 1 ? '' : 's'} to continue.
          </span>
        )}
        {blankDisplay && (
          <span className="text-sm" style={{ color: 'var(--color-danger)' }}>
            Give every named speaker a replacement label.
          </span>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={undecided > 0 || blankDisplay}
          className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm and continue
        </button>
      </div>
    </div>
  );
}
