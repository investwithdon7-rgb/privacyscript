'use client';

/**
 * Batch de-identification hook for research studies.
 *
 * Phases: idle → analysing → review → releasing → done.
 *
 * - analysing: every file is ingested and scanned; transcripts get speakers
 *   and flagged passages; named speakers get ONE label across the study.
 * - review:    the user decides on every flagged passage (all files, one
 *   screen) before anything is produced.
 * - releasing: outputs are built with a shared label registry and session
 *   secret, and each output is validated as released. Files failing a
 *   non-negotiable check are HELD BACK, not zipped.
 * - done:      ZIP of released files + audits + a batch summary. The
 *   re-identification key (pseudonymise) is a separate, passphrase-encrypted
 *   download — never inside the ZIP next to the data it unlocks.
 *
 * Entirely client-side — no data leaves the browser.
 */

import { useCallback, useRef, useState } from 'react';
import { cancelNer, NerCancelledError, runClinicalNER } from '@/engine/ner';
import { generateSessionSecret, encryptKeyFile, type SessionSecret } from '@/engine/crypto';
import { downloadBlob, downloadJSON } from '@/engine/output';
import { finaliseFile, prepareFile, type FinalisedFile, type PreparedFile } from '@/engine/batch';
import { assignStudySpeakers, createLabelRegistry } from '@/engine/transcript';
import { ENGINE_NAME, ENGINE_VERSION, type ComplianceProfileId, type Mode } from '@/lib/constants';

export type BatchPhase = 'idle' | 'analysing' | 'review' | 'releasing' | 'done';

export type BatchItemStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'skipped'
  | 'error'
  | 'released'
  | 'held';

export interface BatchItem {
  id: string;
  filename: string;
  size: number;
  status: BatchItemStatus;
  /** Skip / error / hold-back reason, in plain language. */
  message?: string;
  spansFound?: number;
  flags?: number;
  riskLevel?: string;
  validationPassed?: boolean;
}

export type FlagDecisions = Record<string, Record<number, 'keep' | 'remove'>>;

export interface BatchState {
  phase: BatchPhase;
  mode: Mode;
  profileId: ComplianceProfileId;
  items: BatchItem[];
  prepared: PreparedFile[];
  decisions: FlagDecisions;
  readable: boolean;
  finalised: FinalisedFile[];
}

const INITIAL: BatchState = {
  phase: 'idle',
  mode: 'PSEUDONYMISE',
  profileId: 'GDPR_PSEUDO',
  items: [],
  prepared: [],
  decisions: {},
  readable: true,
  finalised: [],
};

export function useBatchDeidentification() {
  const [state, setState] = useState<BatchState>(INITIAL);
  // The secret lives only in memory for this batch; never serialised in clear.
  const secretRef = useRef<SessionSecret | null>(null);
  const cancelledRef = useRef(false);

  const patchItem = (id: string, patch: Partial<BatchItem>) =>
    setState((s) => ({ ...s, items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));

  const analyse = useCallback(async (files: File[], mode: Mode, profileId: ComplianceProfileId) => {
    const items: BatchItem[] = files.map((f, i) => ({
      id: String(i), filename: f.name, size: f.size, status: 'pending',
    }));
    secretRef.current = null;
    setState({ ...INITIAL, phase: 'analysing', mode, profileId, items });

    cancelledRef.current = false;
    const prepared: PreparedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      // Cancelled: stop scanning and go back to the start. Nothing was produced.
      if (cancelledRef.current) {
        setState(INITIAL);
        return;
      }
      const id = String(i);
      patchItem(id, { status: 'processing' });
      try {
        const p = await prepareFile(files[i], id, (text, opts) =>
          runClinicalNER(text, {
            ...opts,
            onProgress: (done, total) =>
              patchItem(id, { message: `Finding names… part ${done} of ${total}` }),
          })
        );
        patchItem(id, { message: undefined });
        prepared.push(p);
        patchItem(
          id,
          p.skipReason
            ? { status: 'skipped', message: p.skipReason }
            : {
                status: 'ready',
                message: p.scriptWarning
                  ? `Part is in ${p.scriptWarning.scripts.join(', ') || 'a script'} that cannot be checked. It will be held back; open it on its own.`
                  : undefined,
                spansFound: (p.detection?.spans.length ?? 0) + (p.detection?.quasiSpans.length ?? 0),
                flags: p.transcript?.flags.length ?? 0,
              }
        );
      } catch (err) {
        if (err instanceof NerCancelledError) {
          setState(INITIAL);
          return;
        }
        patchItem(id, { status: 'error', message: (err as Error).message });
      }
    }

    // One label per named speaker across the whole study.
    assignStudySpeakers(prepared.flatMap((p) => (p.transcript ? [p.transcript.info] : [])));
    setState((s) => ({ ...s, phase: 'review', prepared }));
  }, []);

  const decide = useCallback((fileId: string, flagId: number, d: 'keep' | 'remove') => {
    setState((s) => ({
      ...s,
      decisions: { ...s.decisions, [fileId]: { ...(s.decisions[fileId] ?? {}), [flagId]: d } },
    }));
  }, []);

  const decideAll = useCallback((d: 'keep' | 'remove') => {
    setState((s) => ({
      ...s,
      decisions: Object.fromEntries(
        s.prepared
          .filter((p) => p.transcript)
          .map((p) => [p.id, Object.fromEntries(p.transcript!.flags.map((f) => [f.id, d]))])
      ),
    }));
  }, []);

  const setReadable = useCallback((readable: boolean) => setState((s) => ({ ...s, readable })), []);

  const release = useCallback(async () => {
    const s = state;
    setState((x) => ({ ...x, phase: 'releasing' }));
    if (s.mode === 'PSEUDONYMISE' && !secretRef.current) {
      secretRef.current = await generateSessionSecret();
    }
    const registry = createLabelRegistry();
    const finalised: FinalisedFile[] = [];
    // Files in the original order so numbering follows the study order.
    for (const p of s.prepared) {
      if (p.skipReason) continue;
      patchItem(p.id, { status: 'processing' });
      try {
        const f = await finaliseFile(p, {
          mode: s.mode,
          profileId: s.profileId,
          secret: secretRef.current ?? undefined,
          readable: s.readable,
          decisions: s.decisions[p.id] ?? {},
          registry,
        });
        finalised.push(f);
        patchItem(p.id, {
          status: f.heldBack ? 'held' : 'released',
          message: f.heldBack,
          riskLevel: f.risk.level,
          validationPassed: f.validation.passed,
        });
      } catch (err) {
        patchItem(p.id, { status: 'error', message: (err as Error).message });
      }
    }
    setState((x) => ({ ...x, phase: 'done', finalised }));
  }, [state]);

  const downloadZip = useCallback(async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const released = state.finalised.filter((f) => !f.heldBack);
    for (const f of released) {
      zip.folder('deidentified')!.file(f.outputName, f.output);
    }
    // Audits for every processed file, including held-back ones (they say why).
    for (const f of state.finalised) {
      zip.folder('audits')!.file(`${f.name}.audit.json`, JSON.stringify(f.audit, null, 2));
    }
    zip.file(
      'batch-summary.json',
      JSON.stringify(
        {
          engine: ENGINE_NAME,
          engineVersion: ENGINE_VERSION,
          timestamp: new Date().toISOString(),
          mode: state.mode,
          complianceProfile: state.profileId,
          replacementStyle: state.readable ? 'readable labels' : 'codes',
          released: released.map((f) => f.name),
          heldBack: state.finalised.filter((f) => f.heldBack).map((f) => ({ file: f.name, reason: f.heldBack })),
          notProcessed: state.items
            .filter((i) => i.status === 'skipped' || i.status === 'error')
            .map((i) => ({ file: i.filename, reason: i.message })),
          // Labels only — never original values.
          note: 'No original identifiers are stored in this archive. The re-identification key, if any, is a separate encrypted file.',
        },
        null,
        2
      )
    );
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, 'privacyscript-batch.zip');
  }, [state]);

  /** Pseudonymise only: one encrypted key file for the whole study. */
  const downloadKey = useCallback(
    async (passphrase: string) => {
      if (!secretRef.current) throw new Error('No session key. Run the batch again.');
      const mapping = Object.assign({}, ...state.finalised.filter((f) => !f.heldBack).map((f) => f.mapping));
      const encrypted = await encryptKeyFile(secretRef.current.rawKey, mapping, passphrase);
      downloadJSON(encrypted, 'privacyscript-batch.privacyscript.key');
    },
    [state]
  );

  /** Stop scanning: the running file is abandoned and nothing is produced. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cancelNer();
  }, []);

  const reset = useCallback(() => {
    secretRef.current = null;
    setState(INITIAL);
  }, []);

  return { state, analyse, cancel, decide, decideAll, setReadable, release, downloadZip, downloadKey, reset };
}
