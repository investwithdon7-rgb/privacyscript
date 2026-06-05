'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Brand } from '@/components/Brand';
import { DropZone } from '@/components/DropZone';
import { NerBanner } from '@/components/NerBanner';
import { ComplianceModeSelector } from '@/components/ComplianceModeSelector';
import type { Mode } from '@/lib/constants';
import type { ComplianceProfileId } from '@/lib/constants';
import { COMPLIANCE_PROFILES, DEFAULT_COMPLIANCE_PROFILE } from '@/lib/constants';
import { resetSession, updateSession } from '@/state/session';
import { ingestAndDetect } from '@/hooks/useDeidentification';
import { ensureNerLoaded } from '@/engine/ner';

export default function LandingPage() {
  const router = useRouter();
  const [profileId, setProfileId] = useState<ComplianceProfileId>(DEFAULT_COMPLIANCE_PROFILE);
  const [showProfiles, setShowProfiles] = useState(false);
  const [activeJob, setActiveJob] = useState<'check' | 'deidentify' | null>(null);

  // Pre-warm the NER model while the user is setting up.
  useEffect(() => {
    void ensureNerLoaded();
  }, []);

  const profile = COMPLIANCE_PROFILES[profileId];
  const effectiveMode: Mode = profile.recommendedMode;

  const handleProfileChange = (id: ComplianceProfileId) => {
    setProfileId(id);
  };

  const onFile = async (file: File) => {
    resetSession();
    updateSession({ mode: effectiveMode, filename: file.name, complianceProfile: profileId });
    router.push('/process/');
    void ingestAndDetect(file);
  };

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6">
      <Brand />
      <section className="mt-16">
        <h1 className="text-4xl md:text-5xl font-bold leading-tight tracking-tight">
          Check compliance. De-identify safely.
          <br />
          <span style={{ color: '#4F46E5' }}>In your browser.</span> Nothing leaves your device.
        </h1>
        <p className="text-[color:var(--color-muted)] mt-6 max-w-2xl text-lg leading-relaxed">
          Find the personal and health information hidden in a record, and see whether it is
          risky to share or paste into an AI tool. Then remove or mask it on your own device,
          ready for GDPR, HIPAA, EHDS and research use.
        </p>

        <div className="mt-12 grid md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => {
              setActiveJob('check');
              router.push('/check/');
            }}
            className="surface rounded-2xl p-6 text-left hover:border-[#4F46E5] transition-colors"
          >
            <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
              Check
            </div>
            <h2 className="text-2xl font-bold mt-3">Is this safe to share or upload to AI?</h2>
            <p className="text-sm text-[color:var(--color-muted)] mt-3 leading-relaxed">
              See what sensitive information is hiding in a document, from names and dates to
              medical record numbers and health details, and whether it is risky to share or
              paste into an AI tool.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveJob('deidentify')}
            className="surface rounded-2xl p-6 text-left hover:border-[#4F46E5] transition-colors"
          >
            <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
              Clean up
            </div>
            <h2 className="text-2xl font-bold mt-3">Make the document safer.</h2>
            <p className="text-sm text-[color:var(--color-muted)] mt-3 leading-relaxed">
              Anonymise to remove identities for good, the safer choice for AI tools and public
              sharing. Or pseudonymise to swap them for codes you can reverse later with a key
              that only you keep.
            </p>
          </button>
        </div>

        {activeJob === null ? (
          <div className="mt-8 surface rounded-xl px-5 py-4 text-sm text-[color:var(--color-muted)]">
            Choose where to begin. If you are not sure whether a document is safe to share,
            start with Check.
          </div>
        ) : null}

        {activeJob === 'deidentify' ? (
          <>
        {/* Step 1: Compliance profile */}
        <div className="mt-12">
          <div className="flex items-center justify-between mb-3">
            <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
              Step 1. Where will this data go?
            </h2>
            <button
              type="button"
              onClick={() => setShowProfiles((p) => !p)}
              className="mono text-xs text-[color:var(--color-muted)] hover:text-white transition-colors"
            >
              {showProfiles ? '▲ hide' : '▼ show all'}
            </button>
          </div>

          {!showProfiles ? (
            // Collapsed chip showing active profile + auto-applied mode
            <button
              type="button"
              onClick={() => setShowProfiles(true)}
              className="surface rounded-xl px-5 py-3.5 text-left w-full hover:border-[#4F46E5] transition-colors group border border-[color:var(--color-border)]"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{profile.label}</div>
                  <div className="mono text-xs text-[color:var(--color-muted)] mt-0.5">
                    {profile.regulation}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Mode badge shows what will be applied */}
                  <span
                    className="mono text-xs px-2.5 py-1 rounded-full font-semibold border"
                    style={{
                      background: effectiveMode === 'PSEUDONYMISE' ? 'rgba(79,70,229,0.15)' : 'rgba(124,58,237,0.15)',
                      color: effectiveMode === 'PSEUDONYMISE' ? '#818CF8' : '#A78BFA',
                      borderColor: effectiveMode === 'PSEUDONYMISE' ? 'rgba(79,70,229,0.4)' : 'rgba(124,58,237,0.4)',
                    }}
                  >
                    {effectiveMode === 'PSEUDONYMISE' ? 'Pseudonymise' : 'Anonymise'}
                  </span>
                  <span className="mono text-xs text-[color:var(--color-muted)] group-hover:text-[#4F46E5] transition-colors">
                    Change
                  </span>
                </div>
              </div>
            </button>
          ) : (
            <ComplianceModeSelector value={profileId} onChange={handleProfileChange} />
          )}
        </div>

        {/* Step 2: Upload or paste the record */}
        <div className="mt-10">
          <h2 className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">
            Step 2. Upload or paste a record
          </h2>
          <DropZone
            accept=".txt,.json,.hl7,.pdf,.docx,.csv,.tsv,.dcm,.dicom"
            disabled={false}
            onFile={onFile}
          />
          <NerBanner />
        </div>
          </>
        ) : null}

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
        <div className="flex gap-4">
          <a href="/privacyscript/batch/" className="hover:text-white transition-colors">
            Batch processing
          </a>
          <span>v0.2 · {new Date().getUTCFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}
