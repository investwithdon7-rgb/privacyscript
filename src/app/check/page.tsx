'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { DropZone } from '@/components/DropZone';
import { NerBanner } from '@/components/NerBanner';
import { ensureNerLoaded } from '@/engine/ner';
import type { ComplianceJurisdiction } from '@/engine/compliance';
import { runComplianceCheck } from '@/hooks/useDeidentification';
import { useSession } from '@/hooks/useSession';

const JURISDICTIONS: Array<{
  id: ComplianceJurisdiction;
  title: string;
  subtitle: string;
  description: string;
}> = [
  {
    id: 'EU',
    title: 'EU',
    subtitle: 'GDPR + EU AI Act + EHDS',
    description: 'For European users checking health data before sharing or AI upload.',
  },
  {
    id: 'UK',
    title: 'UK',
    subtitle: 'UK GDPR + DPA 2018 + ICO',
    description: 'For UK health records and AI/data protection risk screening.',
  },
  {
    id: 'US',
    title: 'US',
    subtitle: 'HIPAA + AI processor caution',
    description: 'For PHI and identifier checks before disclosure or AI processing.',
  },
  {
    id: 'GENERAL',
    title: 'General',
    subtitle: 'International AI upload safety',
    description: 'A conservative profile when you are unsure which law applies.',
  },
];

export default function ComplianceCheckPage() {
  const router = useRouter();
  const session = useSession();
  const [jurisdiction, setJurisdiction] =
    useState<ComplianceJurisdiction>('GENERAL');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    void ensureNerLoaded();
  }, []);

  const onFile = async (file: File) => {
    setProcessing(true);
    await runComplianceCheck(file, jurisdiction);
    setProcessing(false);
    router.push('/check/report/');
  };

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand subtitle="Compliance check" />

      <section className="mt-10">
        <h1 className="text-3xl md:text-4xl font-bold">
          Check whether a document is safe to share or upload to AI.
        </h1>
        <p className="text-[color:var(--color-muted)] mt-4 max-w-3xl leading-relaxed">
          PrivacyScript scans the document in this browser for personal data, health data,
          direct identifiers, and high-risk clues. The document is not modified unless you
          choose a de-identification action after the report.
        </p>

        <div className="mt-10">
          <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-3">
            Step 1. Which rules apply to you?
          </h2>
          <div className="grid md:grid-cols-2 gap-3">
            {JURISDICTIONS.map((item) => {
              const selected = item.id === jurisdiction;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setJurisdiction(item.id)}
                  className="text-left p-5 rounded-2xl border transition-colors"
                  style={{
                    background: selected
                      ? 'rgba(79,70,229,0.15)'
                      : 'var(--color-surface)',
                    borderColor: selected ? '#4F46E5' : 'var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold">{item.title}</div>
                    {selected ? (
                      <span className="mono text-[10px] uppercase tracking-widest" style={{ color: '#818CF8' }}>
                        Selected
                      </span>
                    ) : null}
                  </div>
                  <div className="mono text-xs text-[color:var(--color-muted)] mt-1">
                    {item.subtitle}
                  </div>
                  <p className="text-sm text-[color:var(--color-muted)] mt-3">
                    {item.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-10">
          <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
            Step 2. Upload or paste a document
          </h2>
          <DropZone
            accept=".txt,.json,.hl7,.pdf,.docx,.csv,.tsv,.dcm,.dicom"
            disabled={processing}
            onFile={onFile}
          />
          <NerBanner />
        </div>

        {processing || session.stageIndex > 0 ? (
          <div className="surface rounded-xl px-4 py-3 mt-6 text-sm text-[color:var(--color-muted)]">
            {session.error
              ? session.error
              : processing
              ? 'Scanning document for compliance findings...'
              : 'Scan ready.'}
          </div>
        ) : null}
      </section>
    </main>
  );
}
