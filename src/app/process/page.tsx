'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brand } from '@/components/Brand';
import { JourneySteps } from '@/components/JourneySteps';
import { GuidedStep } from '@/components/GuidedStep';
import { QuasiIdentifierReview } from '@/components/QuasiIdentifierReview';
import { UncertainDetectionsPanel } from '@/components/UncertainDetectionsPanel';
import { SpanEditor } from '@/components/SpanEditor';
import { SurveyColumnsPanel } from '@/components/SurveyColumnsPanel';
import { TranscriptPanel } from '@/components/TranscriptPanel';
import { ScanStages } from '@/components/ScanStages';
import { OriginBanner } from '@/components/OriginBanner';
import { ReplacementStyleChoice } from '@/components/ReplacementStyleChoice';
import { cancelNer } from '@/engine/ner';
import type { TranscriptState } from '@/engine/transcript';
import { useSession } from '@/hooks/useSession';
import { getSession, resetSession, updateSession } from '@/state/session';
import { finalise, spansInEngineColumns, tabularDataRows } from '@/hooks/useDeidentification';
import { COMPLIANCE_PROFILES, K_ANONYMITY_THRESHOLD } from '@/lib/constants';
import type { CsvIngest } from '@/formats/csv';
import type { TabularState } from '@/engine/tabular';
import type { Span } from '@/engine/detect';
import type { ImageIngest } from '@/formats/image';

export default function ProcessPage() {
  const router = useRouter();
  const s = useSession();
  // A finished review step the user chose to reopen with "Change".
  const [reopened, setReopened] = useState<string | null>(null);

  // Redirect home if the user lands here without a staged file.
  useEffect(() => {
    if (!s.filename && !s.error) router.replace('/');
  }, [s.filename, s.error, router]);

  // Once the user confirms quasi-identifiers, run stages 3-6 and move to review.
  useEffect(() => {
    if (s.quasiConfirmed && s.stageIndex === 2) {
      void finalise().then(() => router.push('/review/'));
    }
  }, [s.quasiConfirmed, s.stageIndex, router]);

  // NOTE: every handler below reads the CURRENT session via getSession()
  // rather than the render-time snapshot `s`. Handlers that fire in rapid
  // succession (e.g. the "Redact all of these" loop calls onDecide once per
  // span, synchronously) would otherwise each spread the same stale copy and
  // overwrite one another — only the last decision survived.

  const toggleQuasi = (label: string) => {
    const next = new Set(getSession().quasiToRedact);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    updateSession({ quasiToRedact: next });
  };

  const confirmQuasi = () => updateSession({ quasiConfirmed: true });

  // ── Uncertain span decisions ──────────────────────────────────────────
  const handleUncertainDecide = (key: string, confirmed: boolean) => {
    updateSession({
      uncertainSpanDecisions: {
        ...getSession().uncertainSpanDecisions,
        [key]: confirmed,
      },
    });
  };

  // When the user clicks "Done, continue" on the uncertain panel, we also
  // auto-dismiss any spans that still have no decision (treat as rejected).
  const handleUncertainConfirmAll = () => {
    const cur = getSession();
    const auto: Record<string, boolean> = { ...cur.uncertainSpanDecisions };
    for (const sp of cur.detection?.uncertainSpans ?? []) {
      const key = `${sp.start}:${sp.end}:${sp.label}`;
      if (auto[key] === undefined) auto[key] = false;
    }
    updateSession({ uncertainSpanDecisions: auto });
  };

  // ── Manual span editor ────────────────────────────────────────────────
  const handleAddSpan = (span: Span) => {
    updateSession({ userAddedSpans: [...getSession().userAddedSpans, span] });
  };

  const handleDismissSpan = (key: string) => {
    const next = new Set(getSession().userDismissedSpanKeys);
    next.add(key);
    updateSession({ userDismissedSpanKeys: next });
  };

  const handleRestoreSpan = (key: string) => {
    const next = new Set(getSession().userDismissedSpanKeys);
    next.delete(key);
    updateSession({ userDismissedSpanKeys: next });
  };

  // ── Survey / spreadsheet column plan ──────────────────────────────────
  const tabular = s.format === 'CSV' ? s.tabular : null;
  const csv = tabular ? (s.parsedOriginal as CsvIngest | null) : null;
  const dataRows = useMemo(
    () => (csv && tabular ? tabularDataRows(csv, tabular) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [csv, tabular?.platform.metaRowCount]
  );
  const kThreshold =
    COMPLIANCE_PROFILES[s.complianceProfile ?? 'GDPR_PSEUDO']?.kThreshold ?? K_ANONYMITY_THRESHOLD;
  const columnsPending = !!tabular && !tabular.confirmed;
  const setTabular = (next: TabularState) => updateSession({ tabular: next });

  // ── Interview transcripts ─────────────────────────────────────────────
  const transcript = s.transcript;
  const transcriptPending = !!transcript && !transcript.confirmed;
  const setTranscript = (next: TranscriptState) => updateSession({ transcript: next });
  /** Column / transcript setup still open — later review steps wait for it. */
  // ── Unreadable script ─────────────────────────────────────────────────
  // UNREADABLE: nothing can be produced. PARTIAL: the user must acknowledge
  // that those passages are theirs to check before any step continues.
  const scriptWarning = s.scriptWarning;
  const scriptUnreadable = scriptWarning?.severity === 'UNREADABLE';
  const scriptBlocked = scriptUnreadable || (scriptWarning?.severity === 'PARTIAL' && !s.scriptAcknowledged);
  const setupPending = scriptBlocked || columnsPending || transcriptPending;

  // In a survey, detections inside identifier / quasi columns are handled by
  // the column plan — only show the ones in written/answer columns.
  const quasiForReview = s.detection
    ? tabular ? spansInEngineColumns(s.detection.quasiSpans) : s.detection.quasiSpans
    : [];
  const uncertainForReview = s.detection?.uncertainSpans
    ? tabular ? spansInEngineColumns(s.detection.uncertainSpans) : s.detection.uncertainSpans
    : [];

  // All active detected spans (direct + quasi, minus dismissed, plus user-added).
  const allDetectedSpans = s.detection
    ? [...s.detection.spans, ...s.detection.quasiSpans, ...s.userAddedSpans]
    : [];

  // Has the user resolved all uncertain span decisions?
  const uncertainResolved = uncertainForReview.every(
    (sp) => s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`] !== undefined
  );

  // ── Guided review: one step open at a time ────────────────────────────
  interface StepDef {
    id: string;
    title: string;
    whatToDo: string;
    done: boolean;
    summary?: string;
    onChange?: () => void;
    render: () => ReactNode;
  }
  const steps: StepDef[] = [];

  if (scriptWarning) {
    steps.push({
      id: 'script',
      title: scriptUnreadable ? 'This document cannot be checked' : 'Confirm the passages we cannot read',
      whatToDo: scriptUnreadable
        ? 'Nothing can be produced for this file. Start again with a different file.'
        : 'Tick the box to confirm you will check those passages yourself.',
      done: !scriptBlocked,
      summary: 'You will check the unreadable passages yourself',
      onChange: () => updateSession({ scriptAcknowledged: false }),
      render: () => (
        <div
          className="rounded-2xl p-6"
          style={{
            background: scriptUnreadable ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
            border: `1px solid ${scriptUnreadable ? 'var(--color-danger)' : 'var(--color-warning)'}`,
          }}
        >
          <p className="text-sm">{scriptWarning.message}</p>
          {scriptUnreadable ? (
            <>
              <p className="text-sm text-[color:var(--color-muted)] mt-2">
                PrivacyScript reads Latin-script text only. It will not produce a de-identified
                version: the result would look clean without being checked. De-identify this
                document by hand, or with a tool that supports{' '}
                {scriptWarning.scripts.join(', ') || 'this script'}.
              </p>
              <div className="mt-4">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    resetSession();
                    router.push('/');
                  }}
                >
                  Start again
                </button>
              </div>
            </>
          ) : (
            <label className="flex items-start gap-3 mt-4 cursor-pointer text-sm">
              <input
                type="checkbox"
                className="w-4 h-4 mt-0.5 accent-[#4F46E5]"
                checked={s.scriptAcknowledged}
                onChange={(e) => updateSession({ scriptAcknowledged: e.target.checked })}
              />
              <span>
                I understand the {scriptWarning.scripts.join(', ') || 'non-Latin'} passages are not checked
                automatically. I will mark any names or other identifiers in them myself in the
                next steps, or confirm they contain none. This is recorded in the audit log.
              </span>
            </label>
          )}
        </div>
      ),
    });
  }

  if (transcript && s.mode) {
    const mode = s.mode;
    steps.push({
      id: 'transcript',
      title: 'Check speakers and sensitive passages',
      whatToDo:
        'Check how each speaker will be labelled, then choose Keep or Remove for each highlighted passage. Press "Confirm and continue" when done.',
      done: !transcriptPending,
      summary: `${transcript.info.speakers.filter((sp) => sp.isName).length} speaker names replaced · ${
        Object.values(transcript.flagDecisions).filter((d) => d === 'remove').length
      } passages removed`,
      onChange: () => setTranscript({ ...transcript, confirmed: false }),
      render: () => (
        <TranscriptPanel
          transcript={transcript}
          mode={mode}
          onChange={setTranscript}
          onConfirm={() => updateSession({ transcript: { ...transcript, confirmed: true } })}
        />
      ),
    });
  }

  if (tabular && s.mode) {
    const mode = s.mode;
    steps.push({
      id: 'columns',
      title: 'Check your survey columns',
      whatToDo:
        'Check what each column contains. If the box says people can still be singled out, press "Fix automatically". Then confirm.',
      done: !columnsPending,
      summary: `${tabular.plans.filter((p) => p.role === 'DIRECT').length} identifying columns · ${
        tabular.plans.filter((p) => p.role === 'QUASI').length
      } generalised`,
      onChange: () => setTabular({ ...tabular, confirmed: false }),
      render: () => (
        <SurveyColumnsPanel
          tabular={tabular}
          dataRows={dataRows}
          mode={mode}
          kThreshold={kThreshold}
          convertedFrom={
            /\.xlsx$/i.test(s.filename ?? '') ? 'XLSX' : /\.sav$/i.test(s.filename ?? '') ? 'SPSS' : undefined
          }
          onChange={setTabular}
          onConfirm={() => updateSession({ tabular: { ...tabular, confirmed: true } })}
        />
      ),
    });
  }

  if (uncertainForReview.length > 0) {
    const decided = uncertainForReview.map((sp) => s.uncertainSpanDecisions[`${sp.start}:${sp.end}:${sp.label}`]);
    steps.push({
      id: 'uncertain',
      title: `Decide on ${uncertainForReview.length} possible name${uncertainForReview.length === 1 ? '' : 's'}`,
      whatToDo:
        'For each word, choose Redact if it could be a real person, place or organisation. Choose Keep if it is an ordinary word.',
      done: uncertainResolved && reopened !== 'uncertain',
      summary: `${decided.filter((d) => d === true).length} redacted · ${decided.filter((d) => d === false).length} kept`,
      onChange: () => setReopened('uncertain'),
      render: () => (
        <UncertainDetectionsPanel
          spans={uncertainForReview}
          decisions={s.uncertainSpanDecisions}
          onDecide={handleUncertainDecide}
          onConfirmAll={() => {
            handleUncertainConfirmAll();
            setReopened(null);
          }}
        />
      ),
    });
  }

  steps.push({
    id: 'finish',
    title: 'Create your de-identified file',
    whatToDo:
      quasiForReview.length > 0
        ? 'Choose which other details to hide, then press "Create de-identified file".'
        : 'Everything is checked. Press "Create de-identified file".',
    done: false,
    render: () => (
      <>
        {s.format === 'IMAGE' && (s.parsedOriginal as ImageIngest | null)?.faces?.length ? (
          <label className="surface rounded-2xl px-6 py-4 mt-4 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={s.coverFaces}
              onChange={(e) => updateSession({ coverFaces: e.target.checked })}
            />
            <span>
              <span className="text-sm font-semibold">
                {(s.parsedOriginal as ImageIngest).faces!.length} face(s) found in the picture: cover them
              </span>
              <span className="block text-xs text-[color:var(--color-muted)] mt-1">
                A full-face photo identifies a person. Covering puts a black box over each face and re-saves the
                picture. Hidden details are removed either way.
              </span>
            </span>
          </label>
        ) : null}
        {!s.transcript && s.format !== 'IMAGE' && s.format !== 'DICOM' && s.mode && (
          <ReplacementStyleChoice
            value={s.replacementStyle}
            mode={s.mode}
            onChange={(v) => updateSession({ replacementStyle: v })}
          />
        )}
        <QuasiIdentifierReview
          quasiSpans={quasiForReview}
          redactSet={s.quasiToRedact}
          onToggle={toggleQuasi}
          onConfirm={confirmQuasi}
          confirmLabel="Create de-identified file →"
        />
        {s.originalText && (
          <details className="surface rounded-2xl px-6 py-4 mt-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Spotted something we missed? Mark it yourself (optional)
            </summary>
            <SpanEditor
              text={s.originalText}
              spans={allDetectedSpans}
              dismissedKeys={s.userDismissedSpanKeys}
              onAddSpan={handleAddSpan}
              onDismissSpan={handleDismissSpan}
              onRestoreSpan={handleRestoreSpan}
            />
          </details>
        )}
      </>
    ),
  });

  const activeIndex = steps.findIndex((st) => !st.done);
  const finalising = s.quasiConfirmed;

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6 pb-16">
      <Brand subtitle="Processing" />

      <section className="mt-10">
        <h1 className="text-3xl font-bold">
          {s.detection ? 'Review before we create your file' : tabular ? 'Scanning your survey' : transcript ? 'Scanning your transcript' : 'Scanning your document'}
        </h1>
        <p className="text-[color:var(--color-muted)] mt-2 mono text-sm">
          {s.filename ?? 'document'} · {s.mode === 'ANONYMISE' ? 'Anonymise' : 'Pseudonymise'}
        </p>
        <JourneySteps current={s.detection ? 'review' : 'scan'} />

        {s.error ? (
          <div
            className="mt-8 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-danger)' }}
          >
            <div className="font-semibold mb-1" style={{ color: 'var(--color-danger)' }}>
              Something went wrong
            </div>
            <div className="text-sm">{s.error}</div>
          </div>
        ) : null}

        {s.detection ? (
          <>
            {/* What we found, in plain words */}
            <div className="mt-8 surface rounded-2xl p-6">
              <div className="text-xl font-bold">
                We found {s.detection.spans.length + s.detection.quasiSpans.length} things that could identify someone
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {Object.entries(s.detection.counts).map(([label, count]) => (
                  <span key={label} className="tag">
                    {friendlyLabel(label)} · {count}
                  </span>
                ))}
              </div>
              <p className="text-sm text-[color:var(--color-muted)] mt-3">
                {steps.length === 1
                  ? 'One last step below.'
                  : `Work through the ${steps.length} steps below. Only the current step is open.`}
              </p>
            </div>
            {s.origin && s.mode && (
              <OriginBanner
                origin={s.origin}
                profile={s.complianceProfile ?? 'GDPR_PSEUDO'}
                mode={s.mode}
                onSwitch={(id) => {
                  // Stricter profiles hide every quasi-identifier by default.
                  const quasi = COMPLIANCE_PROFILES[id].suppressAllQuasi
                    ? new Set(s.detection!.quasiSpans.map((q) => q.label))
                    : s.quasiToRedact;
                  updateSession({ complianceProfile: id, quasiToRedact: quasi });
                }}
              />
            )}

            {finalising ? (
              <div className="rounded-2xl p-6 mt-6" style={{ border: '1px solid #4F46E5', background: 'rgba(79,70,229,0.06)' }}>
                <div className="flex items-center gap-3">
                  <span className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  <span className="font-semibold">Creating your de-identified file…</span>
                </div>
                <p className="text-sm text-[color:var(--color-muted)] mt-2">
                  Replacing what you chose, then checking the result for anything that slipped through.
                </p>
              </div>
            ) : (
              steps.map((st, i) => (
                <GuidedStep
                  key={st.id}
                  number={i + 1}
                  total={steps.length}
                  title={st.title}
                  whatToDo={st.whatToDo}
                  status={i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'upcoming'}
                  summary={st.summary}
                  onChange={st.onChange}
                >
                  {i === activeIndex ? st.render() : null}
                </GuidedStep>
              ))
            )}
          </>
        ) : (
          <ScanStages
            filename={s.filename}
            variant="deidentify"
            onCancel={() => {
              cancelNer();
              resetSession();
              router.push('/');
            }}
          />
        )}
      </section>
    </main>
  );
}

const FRIENDLY: Record<string, string> = {
  NAME: 'Names',
  ADDRESS_LINE: 'Places and addresses',
  INSTITUTION: 'Organisations',
  EMAIL: 'Email addresses',
  PHONE: 'Phone numbers',
  FAX: 'Fax numbers',
  DATE: 'Dates',
  AGE_OVER_89: 'Ages over 89',
  POSTCODE_UK: 'Postcodes',
  POSTCODE_US: 'ZIP codes',
  POSTCODE_EU: 'Postcodes',
  NHS_NUMBER: 'NHS numbers',
  MRN: 'Record numbers',
  REFERENCE_ID: 'Reference numbers',
  DEVICE_ID: 'Device serial numbers',
  URL: 'Web links',
  IP: 'IP addresses',
  ETHNICITY: 'Ethnicity',
  OCCUPATION: 'Occupations',
  RARE_DISEASE_ICD: 'Rare disease codes',
};

function friendlyLabel(label: string): string {
  if (label.startsWith('NATIONAL_ID') || label === 'SSN' || label === 'UK_NINO') return 'National ID numbers';
  if (label === 'INSURANCE_ID') return 'Insurance numbers';
  if (label === 'IBAN' || label === 'ACCOUNT_NUMBER') return 'Bank and account numbers';
  if (label === 'PASSPORT') return 'Passport numbers';
  if (label === 'LICENSE') return 'Licence and registration numbers';
  return FRIENDLY[label] ?? label.toLowerCase().replace(/_/g, ' ');
}
