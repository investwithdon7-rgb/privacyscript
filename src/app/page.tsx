'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Brand } from '@/components/Brand';
import { ModeSelector } from '@/components/ModeSelector';
import { DropZone } from '@/components/DropZone';
import { NerBanner } from '@/components/NerBanner';
import type { Mode } from '@/lib/constants';
import { resetSession, updateSession } from '@/state/session';
import { ingestAndDetect } from '@/hooks/useDeidentification';
import { ensureNerLoaded } from '@/engine/ner';

export default function LandingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);

  // Pre-warm the NER model the moment the landing page mounts. The 50 MB
  // download happens while the user is choosing a mode + picking a file, so
  // by the time they click "process" the model is already cached in
  // IndexedDB. Fire-and-forget — `ensureNerLoaded` is internally memoised and
  // swallows its own errors, so if the model can't load the engine simply
  // falls back to regex-only detection on Screen 2.
  useEffect(() => {
    void ensureNerLoaded();
  }, []);

  const onFile = async (file: File) => {
    resetSession();
    // Set filename + mode BEFORE navigating so the process page's redirect
    // guard (`!s.filename`) does not fire while ingestAndDetect is still running.
    updateSession({ mode, filename: file.name });
    router.push('/process/');
    // Kick off detection — Screen 2 listens to session state.
    void ingestAndDetect(file);
  };

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand />
      <section className="mt-16">
        <h1 className="text-4xl md:text-5xl font-bold leading-tight tracking-tight">
          De-identify health records.
          <br />
          <span style={{ color: '#4F46E5' }}>In your browser.</span> Nothing leaves your device.
        </h1>
        <p className="text-[color:var(--color-muted)] mt-6 max-w-2xl text-lg leading-relaxed">
          Built for healthcare professionals, pharma teams, researchers and clinicians who need
          GDPR / HIPAA / EHDS-compliant de-identification before sharing records for analytics,
          research, or feeding to AI tools.
        </p>

        <div className="mt-10">
          <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
            Step 1 — choose mode
          </h2>
          <ModeSelector value={mode} onChange={setMode} />
        </div>

        <div className={`mt-10 transition-opacity ${mode ? '' : 'opacity-50 pointer-events-none'}`}>
          <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
            Step 2 — upload a record
          </h2>
          <DropZone
            accept=".txt,.json,.hl7,.pdf,.docx,.csv,.tsv"
            disabled={!mode}
            onFile={onFile}
          />
          <NerBanner />
        </div>

        <ComplianceStrip />
      </section>
      <Footer />
    </main>
  );
}

function ComplianceStrip() {
  const items = [
    { label: 'GDPR Article 4(5)', tag: 'Pseudonymisation' },
    { label: 'GDPR Recital 26', tag: 'Anonymisation' },
    { label: 'HIPAA §164.514', tag: 'Safe Harbor' },
    { label: 'EHDS Reg. 2025/327', tag: 'Secondary use' },
    { label: 'UK GDPR + DPA 2018', tag: 'UK' },
    { label: 'NIS2', tag: 'Supply chain' },
  ];
  return (
    <div className="mt-16 grid grid-cols-2 md:grid-cols-3 gap-3">
      {items.map((i) => (
        <div key={i.label} className="surface rounded-xl px-4 py-3">
          <div className="text-sm font-semibold">{i.label}</div>
          <div className="mono text-xs text-[color:var(--color-muted)] mt-1">{i.tag}</div>
        </div>
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-24 mb-12 pt-8 border-t border-[color:var(--color-border)] text-xs text-[color:var(--color-muted)] mono">
      <div className="flex flex-wrap gap-x-6 gap-y-2 justify-between">
        <span>PrivacyScript by TekDruid · client-side only · zero telemetry</span>
        <span>v0.1 · {new Date().getUTCFullYear()}</span>
      </div>
    </footer>
  );
}
