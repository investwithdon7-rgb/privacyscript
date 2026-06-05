'use client';

import { useState } from 'react';
import type {
  ComplianceFinding,
  ComplianceReport,
  ComplianceVerdict,
} from '@/engine/compliance';

interface ComplianceReportPanelProps {
  report: ComplianceReport;
  onAnonymise: () => void;
  onPseudonymise: () => void;
  onDownloadReport: () => void;
}

const VERDICT_COLOURS: Record<
  ComplianceVerdict,
  { bg: string; border: string; text: string }
> = {
  SAFE: {
    bg: 'rgba(16,185,129,0.14)',
    border: '#10B981',
    text: '#10B981',
  },
  NEEDS_DEIDENTIFICATION: {
    bg: 'rgba(245,158,11,0.14)',
    border: '#F59E0B',
    text: '#F59E0B',
  },
  DO_NOT_UPLOAD: {
    bg: 'rgba(239,68,68,0.14)',
    border: '#EF4444',
    text: '#EF4444',
  },
};

const SEVERITY_COLOURS: Record<string, string> = {
  HIGH: '#EF4444',
  MEDIUM: '#F59E0B',
  LOW: '#10B981',
};

export function ComplianceReportPanel({
  report,
  onAnonymise,
  onPseudonymise,
  onDownloadReport,
}: ComplianceReportPanelProps) {
  const colour = VERDICT_COLOURS[report.verdict];

  return (
    <div className="space-y-6">
      <section
        className="rounded-2xl p-6 border"
        style={{ background: colour.bg, borderColor: colour.border }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="mono text-xs uppercase tracking-widest mb-2" style={{ color: colour.text }}>
              Compliance verdict
            </div>
            <h1 className="text-3xl font-bold">{report.verdictLabel}</h1>
            <p className="text-sm text-[color:var(--color-muted)] mt-3 max-w-3xl">
              {report.verdictDescription}
            </p>
          </div>
          <span
            className="mono text-xs font-semibold px-3 py-1 rounded-full tracking-widest"
            style={{ color: colour.text, border: `1px solid ${colour.border}` }}
          >
            {report.jurisdictionLabel}
          </span>
        </div>
      </section>

      <section className="grid md:grid-cols-2 gap-4">
        <SafetyCard
          title="Safe for distribution?"
          safe={report.distributionSafety.safe}
          label={report.distributionSafety.label}
          description={report.distributionSafety.description}
        />
        <SafetyCard
          title="Safe to upload to AI?"
          safe={report.aiUploadSafety.safe}
          label={report.aiUploadSafety.label}
          description={report.aiUploadSafety.description}
        />
      </section>

      <section className="surface rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold">Findings</h2>
            <p className="text-sm text-[color:var(--color-muted)] mt-1">
              Exact values are hidden by default. Reveal only when you need to verify a match.
            </p>
          </div>
          <span className="tag">{report.findings.length} type{report.findings.length === 1 ? '' : 's'}</span>
        </div>

        {report.findings.length === 0 ? (
          <div className="surface-2 rounded-xl p-4 text-sm text-[color:var(--color-muted)]">
            No obvious personal or health identifiers were found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[color:var(--color-muted)] mono text-xs uppercase tracking-wider">
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Count</th>
                  <th className="pb-2">Severity</th>
                  <th className="pb-2">Concern</th>
                  <th className="pb-2">Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-border)]">
                {report.findings.map((finding) => (
                  <FindingRow key={finding.label} finding={finding} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold">Recommended actions</h2>
        <p className="text-sm text-[color:var(--color-muted)] mt-1 mb-4">
          The checker does not modify the document. Use one of these actions to continue.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={onAnonymise} className="btn-primary">
            Anonymise this document
          </button>
          <button type="button" onClick={onPseudonymise} className="btn-secondary">
            Pseudonymise this document
          </button>
          <button type="button" onClick={onDownloadReport} className="btn-secondary">
            Download compliance report
          </button>
        </div>
      </section>

      <section className="surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold">Notes</h2>
        <ul className="mt-3 text-sm text-[color:var(--color-muted)] space-y-2">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SafetyCard({
  title,
  safe,
  label,
  description,
}: {
  title: string;
  safe: boolean;
  label: string;
  description: string;
}) {
  const colour = safe ? '#10B981' : '#EF4444';
  return (
    <div className="surface rounded-2xl p-5">
      <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
        {title}
      </div>
      <div className="font-semibold mt-2" style={{ color: colour }}>
        {label}
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mt-2">
        {description}
      </p>
    </div>
  );
}

function FindingRow({ finding }: { finding: ComplianceFinding }) {
  const [revealed, setRevealed] = useState(false);
  const severityColour = SEVERITY_COLOURS[finding.severity] ?? '#94A3B8';

  return (
    <tr>
      <td className="py-3 mono font-semibold">{finding.label}</td>
      <td className="py-3 mono">{finding.count}</td>
      <td className="py-3">
        <span
          className="mono text-[10px] uppercase px-2 py-0.5 rounded-full border"
          style={{ color: severityColour, borderColor: severityColour }}
        >
          {finding.severity}
        </span>
      </td>
      <td className="py-3 text-[color:var(--color-muted)] max-w-sm">
        {finding.concern}
      </td>
      <td className="py-3 min-w-52">
        {revealed ? (
          <div className="space-y-1">
            {finding.values.map((value) => (
              <div key={value} className="mono text-xs surface-2 rounded-lg px-2 py-1">
                {value}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRevealed(false)}
              className="mono text-xs text-[color:var(--color-muted)] hover:text-white"
            >
              Hide values
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="btn-secondary text-xs px-3 py-2"
          >
            Reveal values
          </button>
        )}
      </td>
    </tr>
  );
}
