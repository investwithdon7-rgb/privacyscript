'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { ComplianceReportPanel } from '@/components/ComplianceReportPanel';
import { buildShareSafeComplianceReport } from '@/engine/compliance';
import { downloadJSON } from '@/engine/output';
import { startDeidentificationFromCompliance } from '@/hooks/useDeidentification';
import { useSession } from '@/hooks/useSession';

export default function ComplianceReportPage() {
  const router = useRouter();
  const s = useSession();

  useEffect(() => {
    if (!s.complianceCheck && !s.error) router.replace('/check/');
  }, [s.complianceCheck, s.error, router]);

  const runAction = async (mode: 'ANONYMISE' | 'PSEUDONYMISE') => {
    await startDeidentificationFromCompliance(mode);
    router.push('/process/');
  };

  const downloadReport = () => {
    if (!s.complianceCheck) return;
    const baseName = (s.filename ?? 'record').replace(/\.[^.]+$/, '');
    downloadJSON(
      buildShareSafeComplianceReport(s.complianceCheck),
      `${baseName}.compliance-check.json`
    );
  };

  if (!s.complianceCheck) {
    if (!s.error) return null;
    return (
      <main className="min-h-screen max-w-5xl mx-auto px-6">
        <Brand subtitle="Compliance report" />
        <div
          className="mt-10 p-5 rounded-xl"
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid var(--color-danger)',
          }}
        >
          <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
            Compliance check error
          </div>
          <div className="text-sm">{s.error}</div>
        </div>
        <div className="mt-6">
          <button onClick={() => router.push('/check/')} className="btn-secondary">
            Start over
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-6">
      <Brand subtitle="Compliance report" />

      <section className="mt-10">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <div>
            <h1 className="text-3xl font-bold">Compliance check report</h1>
            <p className="text-[color:var(--color-muted)] mt-1 mono text-sm">
              {s.filename} · {s.format ?? 'TEXT'}
            </p>
          </div>
          <button onClick={() => router.push('/check/')} className="btn-secondary">
            Check another document
          </button>
        </div>

        <ComplianceReportPanel
          report={s.complianceCheck}
          onAnonymise={() => void runAction('ANONYMISE')}
          onPseudonymise={() => void runAction('PSEUDONYMISE')}
          onDownloadReport={downloadReport}
        />
      </section>
    </main>
  );
}
