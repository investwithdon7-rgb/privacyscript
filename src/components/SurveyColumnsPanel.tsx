'use client';

import { useMemo, useState } from 'react';
import type { Mode } from '@/lib/constants';
import {
  autoFix,
  defaultGeneraliser,
  generalisersFor,
  displayName,
  inferKind,
  measureRisk,
  GENERALISER_LABELS,
  ROLE_LABELS,
  type ColumnPlan,
  type ColumnRole,
  type Generaliser,
  type TabularState,
} from '@/engine/tabular';

interface SurveyColumnsPanelProps {
  tabular: TabularState;
  dataRows: Record<string, string>[];
  mode: Mode;
  kThreshold: number;
  /** Set when the upload was converted to CSV for processing. */
  convertedFrom?: 'XLSX' | 'SPSS';
  onChange: (next: TabularState) => void;
  onConfirm: () => void;
}

const ROLES: ColumnRole[] = ['DIRECT', 'QUASI', 'SENSITIVE', 'FREE_TEXT', 'KEEP'];

const ROLE_COLOR: Record<ColumnRole, string> = {
  DIRECT: 'var(--color-danger)',
  QUASI: 'var(--color-warning)',
  SENSITIVE: 'var(--color-warning)',
  FREE_TEXT: 'var(--color-primary)',
  KEEP: 'var(--color-muted)',
};

function effectText(p: ColumnPlan, mode: Mode): string {
  switch (p.role) {
    case 'DIRECT':
      return mode === 'ANONYMISE' ? 'Removed from the output' : 'Replaced with a consistent code';
    case 'QUASI':
      return p.generaliser === 'suppress' ? 'Removed from the output' : GENERALISER_LABELS[p.generaliser];
    case 'SENSITIVE':
      return 'Kept, and checked that it can’t be guessed from the group';
    case 'FREE_TEXT':
      return 'Scanned, and any identifiers replaced';
    case 'KEEP':
      return 'Kept, and still scanned for identifiers';
  }
}

function samples(rows: Record<string, string>[], column: string): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = (r[column] ?? '').trim();
    if (v && !seen.has(v)) seen.add(v);
    if (seen.size >= 3) break;
  }
  return Array.from(seen).map((v) => (v.length > 28 ? `${v.slice(0, 27)}…` : v));
}

const selectClass =
  'surface-2 rounded-lg px-2 py-1.5 text-sm w-full border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-primary)]';

export function SurveyColumnsPanel({
  tabular,
  dataRows,
  mode,
  kThreshold,
  convertedFrom,
  onChange,
  onConfirm,
}: SurveyColumnsPanelProps) {
  const [showAll, setShowAll] = useState(false);

  const risk = useMemo(
    () => measureRisk(dataRows, tabular.plans, kThreshold, tabular.suppressedRows),
    [dataRows, tabular.plans, tabular.suppressedRows, kThreshold]
  );

  const safe = !isFinite(risk.k) || risk.k >= kThreshold;
  const blocked = mode === 'ANONYMISE' && !safe;
  const riskColor = safe
    ? 'var(--color-success)'
    : risk.k >= 3
      ? 'var(--color-warning)'
      : 'var(--color-danger)';

  const needsDecision = tabular.plans.filter((p) => p.role !== 'KEEP');
  const visible = showAll ? tabular.plans : needsDecision;
  const directCount = tabular.plans.filter((p) => p.role === 'DIRECT').length;

  // Any manual change invalidates rows hidden by a previous auto-fix — they
  // were chosen for the old plan.
  const updatePlan = (column: string, patch: Partial<ColumnPlan>) => {
    onChange({
      ...tabular,
      plans: tabular.plans.map((p) => (p.column === column ? { ...p, ...patch } : p)),
      suppressedRows: [],
      fixNotes: [],
    });
  };

  const changeRole = (p: ColumnPlan, role: ColumnRole) => {
    if (role === 'QUASI') {
      const kind = inferKind(p.column, dataRows.map((r) => r[p.column] ?? ''), p.question);
      updatePlan(p.column, { role, kind, generaliser: defaultGeneraliser(kind, mode) });
    } else {
      updatePlan(p.column, { role });
    }
  };

  const runAutoFix = () => {
    const result = autoFix(dataRows, tabular.plans, kThreshold, mode);
    onChange({
      ...tabular,
      plans: result.plans,
      suppressedRows: result.suppressedRows,
      fixNotes: result.notes.length ? result.notes : ['Nothing could be improved automatically.'],
    });
  };

  return (
    <div className="surface rounded-2xl p-6 mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 className="text-lg font-semibold">Survey columns</h2>
        <span className="tag">
          {tabular.platform.label} · {risk.totalRows} responses · {tabular.plans.length} columns
        </span>
      </div>
      <p className="text-sm text-[color:var(--color-muted)]">
        Each row is a person. We&apos;ve suggested how to handle each column. Check the ones
        below, then confirm.
        {tabular.platform.id !== 'GENERIC' && directCount > 0
          ? ` We recognised this ${tabular.platform.label.replace(' export', '')} export and marked ${directCount} column${directCount === 1 ? '' : 's'} that identify people, including platform data such as IP addresses and locations.`
          : ''}
        {convertedFrom === 'XLSX' && ' The first worksheet is used, and the result downloads as a CSV file.'}
        {convertedFrom === 'SPSS' &&
          ' SPSS variable labels are used to understand each question. The result downloads as a CSV file with the original codes (value labels are not included).'}
      </p>

      {/* Live re-identification risk */}
      <div
        className="surface-2 rounded-xl p-4 mt-5"
        style={{ borderLeft: `3px solid ${riskColor}` }}
        aria-live="polite"
      >
        <div className="mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted)]">
          Can anyone be singled out?
        </div>
        {risk.quasiColumns.length === 0 ? (
          <div className="mt-1 text-sm">
            No columns that identify people in combination are kept, so nobody can be singled out by them.
          </div>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
              <span className="text-2xl font-bold mono" style={{ color: riskColor }}>
                {isFinite(risk.k) ? risk.k : risk.totalRows}
              </span>
              <span className="text-sm">
                people in the smallest group that share the same{' '}
                {risk.quasiColumns.join(', ')} (need at least {kThreshold})
              </span>
            </div>
            {risk.rowsAtRisk > 0 ? (
              <div className="text-sm mt-2">
                {risk.rowsAtRisk} of {risk.totalRows} responses could be singled out.
                {risk.riskiestGroups.length > 0 && (
                  <div className="mono text-xs text-[color:var(--color-muted)] mt-1">
                    Rarest combinations:{' '}
                    {risk.riskiestGroups
                      .slice(0, 3)
                      .map((g) => `${g.description} (${g.size})`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm mt-2" style={{ color: 'var(--color-success)' }}>
                Every response is in a group of at least {kThreshold}.
              </div>
            )}
            {risk.l !== null && risk.l < 2 && (
              <div className="text-sm mt-2" style={{ color: 'var(--color-warning)' }}>
                In at least one group everyone gave the same sensitive answer, so that answer
                can be guessed about them. Try wider groups (e.g. 10-year age bands).
              </div>
            )}
          </>
        )}

        {!safe && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={runAutoFix} className="btn-secondary">
              Fix automatically
            </button>
            <span className="text-xs text-[color:var(--color-muted)]">
              Widens groups step by step (e.g. exact age → age bands). It never removes a column
              without asking.
            </span>
          </div>
        )}
        {tabular.fixNotes.length > 0 && (
          <ul className="mt-3 text-xs space-y-1">
            {tabular.fixNotes.map((n, i) => (
              <li key={i} className="mono text-[color:var(--color-muted)]">
                • {n}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Column table */}
      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Column filter">
        <button
          type="button"
          role="tab"
          aria-selected={!showAll}
          onClick={() => setShowAll(false)}
          className={`tag ${!showAll ? 'ring-1 ring-[color:var(--color-primary)]' : ''}`}
        >
          Need a decision ({needsDecision.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={showAll}
          onClick={() => setShowAll(true)}
          className={`tag ${showAll ? 'ring-1 ring-[color:var(--color-primary)]' : ''}`}
        >
          All columns ({tabular.plans.length})
        </button>
      </div>

      <ul className="mt-3 divide-y divide-[color:var(--color-border)]">
        {visible.length === 0 && (
          <li className="py-4 text-sm text-[color:var(--color-muted)]">
            No columns look identifying. Check “All columns” to be sure.
          </li>
        )}
        {visible.map((p) => {
          const options = generalisersFor(p.kind, mode);
          return (
            <li key={p.column} className="py-4 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-start">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ background: ROLE_COLOR[p.role] }}
                    aria-hidden
                  />
                  <span className="mono text-sm font-semibold truncate" title={p.column}>
                    {p.column}
                  </span>
                </div>
                {p.question && (
                  <div className="text-sm mt-1 line-clamp-2" title={p.question}>{p.question}</div>
                )}
                <div className="text-xs text-[color:var(--color-muted)] mt-1">{p.reason}</div>
                <div className="mono text-xs text-[color:var(--color-muted)] mt-1 truncate">
                  e.g. {samples(dataRows, p.column).join(' · ') || '(empty)'}
                </div>
              </div>

              <label className="block">
                <span className="sr-only">What is in {p.column}?</span>
                <select
                  className={selectClass}
                  value={p.role}
                  onChange={(e) => changeRole(p, e.target.value as ColumnRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                {p.role === 'QUASI' ? (
                  <label className="block">
                    <span className="sr-only">How to protect {p.column}</span>
                    <select
                      className={selectClass}
                      value={options.includes(p.generaliser) ? p.generaliser : options[0]}
                      onChange={(e) =>
                        updatePlan(p.column, { generaliser: e.target.value as Generaliser })
                      }
                    >
                      {options.map((g) => (
                        <option key={g} value={g}>
                          {GENERALISER_LABELS[g]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="text-sm py-1.5 text-[color:var(--color-muted)]">
                    {effectText(p, mode)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {blocked && (
          <span className="text-sm" style={{ color: 'var(--color-danger)' }}>
            Anonymised output needs every group to have at least {kThreshold} people.
          </span>
        )}
        {!blocked && !safe && (
          <span className="text-sm" style={{ color: 'var(--color-warning)' }}>
            Pseudonymised data is still personal data. Small groups are allowed but recorded in
            the audit log.
          </span>
        )}
        <button type="button" onClick={onConfirm} disabled={blocked} className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
          Confirm columns and continue
        </button>
      </div>
    </div>
  );
}
