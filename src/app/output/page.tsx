'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Brand } from '@/components/Brand';
import { JourneySteps } from '@/components/JourneySteps';
import { DiffViewer } from '@/components/DiffViewer';
import { DownloadPanel } from '@/components/DownloadPanel';
import { useSession } from '@/hooks/useSession';
import { resetSession } from '@/state/session';

export default function OutputPage() {
  const router = useRouter();
  const s = useSession();

  useEffect(() => {
    // Only redirect home if there's truly nothing to show AND no error to display.
    if (!s.deidentifiedOutput && !s.deidentifiedBytes && !s.error) router.replace('/');
  }, [s.deidentifiedOutput, s.deidentifiedBytes, s.error, router]);

  // Show a visible error page rather than silently redirecting.
  if (!s.deidentifiedOutput && !s.deidentifiedBytes) {
    if (!s.mode && !s.error) return null; // redirect in flight
    return (
      <main className="min-h-screen max-w-5xl mx-auto px-6">
        <Brand subtitle="Output" />
        <div
          className="mt-10 p-5 rounded-xl"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
        >
          <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
            {s.error ? 'Output error' : 'No output available'}
          </div>
          <div className="text-sm">{s.error ?? 'The pipeline did not produce output. Try re-processing the record.'}</div>
        </div>
        <div className="mt-6">
          <button onClick={() => router.push('/')} className="btn-secondary">
            Start over
          </button>
        </div>
      </main>
    );
  }

  if (!s.mode) return null;

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-6">
      <Brand subtitle="Output" />

      <section className="mt-10">
        <JourneySteps current="download" />
        <div className="flex items-center justify-between flex-wrap gap-3 mt-8">
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
        ) : s.format === 'IMAGE' && s.deidentifiedBytes ? (
          <PhotoPreview bytes={s.deidentifiedBytes} filename={s.filename ?? ''} />
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
            {(s.transcript || s.tabular) && (
              <div className="surface-2 rounded-xl p-4 space-y-2">
                <p className="text-white font-semibold">For research use</p>
                {s.transcript && (
                  <p>
                    You decided on {s.transcript.flags.length} flagged passage
                    {s.transcript.flags.length === 1 ? '' : 's'}. Automated checks cannot promise a
                    conversation is anonymous, so read the output once more and ask whether someone
                    who knows the participant (a colleague, a relative) could recognise them. The UK
                    ICO calls this the &ldquo;motivated intruder&rdquo; test.
                  </p>
                )}
                {s.tabular && s.risk && (
                  <p>
                    Re-identification risk was measured across all responses (k = {s.risk.kAnonymity};
                    see the risk report). If you later join this file with other data, run it
                    through again: new columns can make people unique.
                  </p>
                )}
                <p>
                  Check that your ethics approval (REC / IRB) and data management plan cover
                  sharing this output, especially with an AI tool. Keep the audit log with your
                  study records: it shows what was changed and contains no identifiers.
                </p>
              </div>
            )}
            {s.mode === 'PSEUDONYMISE' ? (
              <>
                <p>
                  <strong className="text-white">Pseudonymise mode (GDPR Article 4(5))</strong>: data
                  remains personal data. You hold the re-identification key, so keep it under access
                  control. Suitable for analytics pipelines, research cohorts, and internal data
                  sharing where the data controller is the key holder.
                </p>
                <p>
                  Do <em>not</em> share this output with an AI tool covered by a no-PHI policy. For
                  that, run the source through the tool again in Anonymise mode.
                </p>
                <p>
                  Store the key file apart from the data, with access limited to the named key
                  holder in your data management plan. Anyone with the key and the passphrase can
                  reverse the codes.
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

/** The cleaned photo, shown so the user can check what the picture itself shows. */
function PhotoPreview({ bytes, filename }: { bytes: Uint8Array; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const u = URL.createObjectURL(new Blob([bytes], { type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, filename]);
  return (
    <div className="surface rounded-2xl p-6 mt-4">
      <p className="text-sm text-[color:var(--color-muted)]">
        Hidden details are removed. The picture is unchanged: check it shows no face, name, wristband, screen or document.
      </p>
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Cleaned photo" className="mt-4 max-h-[480px] rounded-xl border border-[color:var(--color-border)]" />
      )}
    </div>
  );
}
