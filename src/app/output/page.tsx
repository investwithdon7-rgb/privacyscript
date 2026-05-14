'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Brand } from '@/components/Brand';
import { DiffViewer } from '@/components/DiffViewer';
import { DownloadPanel } from '@/components/DownloadPanel';
import { useSession } from '@/hooks/useSession';
import { resetSession } from '@/state/session';

export default function OutputPage() {
  const router = useRouter();
  const s = useSession();

  useEffect(() => {
    if (!s.deidentifiedOutput && !s.deidentifiedBytes) router.replace('/');
  }, [s.deidentifiedOutput, s.deidentifiedBytes, router]);

  if ((!s.deidentifiedOutput && !s.deidentifiedBytes) || !s.mode) return null;

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-6">
      <Brand subtitle="Output" />

      <section className="mt-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">De-identified output ready</h1>
            <p className="text-[color:var(--color-muted)] mt-1 mono text-sm">
              {s.filename} · {s.format} · {s.mode}
            </p>
          </div>
        </div>

        <DownloadPanel mode={s.mode} />

        <h2 className="mt-10 text-lg font-semibold">Preview</h2>
        {s.deidentifiedOutput ? (
          <DiffViewer
            original={s.originalText ?? ''}
            spans={[
              ...(s.detection?.spans ?? []),
              ...(s.detection?.quasiSpans ?? []).filter((q) =>
                s.quasiToRedact.has(q.label)
              ),
            ]}
            deidentified={s.deidentifiedOutput}
          />
        ) : (
          <div className="surface rounded-2xl p-6 mt-4 text-sm text-[color:var(--color-muted)]">
            Binary output ({s.format}). Download to view in the appropriate viewer.
            Identifier counts are recorded in the audit log.
          </div>
        )}

        <details className="mt-10 surface rounded-2xl p-6">
          <summary className="cursor-pointer font-semibold">
            What can I do with this output?
          </summary>
          <div className="mt-4 text-sm text-[color:var(--color-muted)] space-y-3">
            {s.mode === 'PSEUDONYMISE' ? (
              <>
                <p>
                  <strong className="text-white">Pseudonymise mode (GDPR Article 4(5))</strong>: data
                  remains personal data. You hold the re-identification key — keep it under access
                  control. Suitable for analytics pipelines, research cohorts, and internal data
                  sharing where the data controller is the key holder.
                </p>
                <p>
                  Do <em>not</em> share this output with an AI tool covered by a no-PHI policy. For
                  that, run the source through the tool again in Anonymise mode.
                </p>
              </>
            ) : (
              <>
                <p>
                  <strong className="text-white">Anonymise mode (GDPR Recital 26)</strong>: no
                  re-linkability. Suitable for feeding to AI tools without a BAA / DPA, or
                  contributing to public research datasets.
                </p>
                <p>
                  Validation passed and k-anonymity is at or above the threshold. Still, treat the
                  output with care if you combine it with external context that could re-identify
                  individuals.
                </p>
              </>
            )}
          </div>
        </details>

        <div className="mt-10 flex justify-between">
          <button
            onClick={() => {
              resetSession();
              router.push('/');
            }}
            className="btn-secondary"
          >
            New record
          </button>
        </div>
      </section>
    </main>
  );
}
