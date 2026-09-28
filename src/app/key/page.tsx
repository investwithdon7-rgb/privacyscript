'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { downloadText } from '@/engine/output';
import { openKeyFile, parseKeyFile, reidentifyText, type OpenedKey } from '@/engine/reidentify';

const TEXT_TYPES = '.txt,.md,.vtt,.srt,.csv,.tsv,.json,.hl7';
const MIME: Record<string, string> = {
  vtt: 'text/vtt', csv: 'text/csv', json: 'application/json', hl7: 'application/hl7-v2', md: 'text/markdown',
};

const heading = 'mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]';
const inputClass =
  'surface-2 rounded-lg px-3 py-2 text-sm w-full border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-primary)]';

function describeShift(days: number): string {
  const n = Math.abs(days);
  const unit = n === 1 ? 'day' : 'days';
  return days < 0
    ? `Dates were moved ${n} ${unit} earlier. To get a real date, add ${n} ${unit}.`
    : `Dates were moved ${n} ${unit} later. To get a real date, subtract ${n} ${unit}.`;
}

export default function KeyPage() {
  const router = useRouter();
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Decrypted table: memory only, gone when the page closes or "Close key" is used.
  const [opened, setOpened] = useState<OpenedKey | null>(null);
  const [query, setQuery] = useState('');
  const [reverseMessage, setReverseMessage] = useState<string | null>(null);

  const open = async () => {
    if (!keyFile) return;
    setBusy(true);
    setError(null);
    try {
      const key = await openKeyFile(parseKeyFile(await keyFile.text()), passphrase);
      setOpened(key);
      setPassphrase('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setOpened(null);
    setKeyFile(null);
    setQuery('');
    setReverseMessage(null);
  };

  const reverse = async (file: File) => {
    if (!opened) return;
    const { text, replaced } = reidentifyText(await file.text(), opened);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'txt';
    const base = file.name.replace(/\.[^.]+$/, '').replace(/\.deidentified$/, '');
    downloadText(text, `${base}.reidentified.${ext}`, MIME[ext] ?? 'text/plain');
    setReverseMessage(
      replaced === 0
        ? `No codes from this key were found in ${file.name}. Was it made with a different key?`
        : `Restored ${replaced} code${replaced === 1 ? '' : 's'} in ${file.name}. The download contains personal data again.`
    );
  };

  const rows = useMemo(() => {
    if (!opened) return [];
    const q = query.trim().toLowerCase();
    return q
      ? opened.codes.filter((c) =>
          [c.code, c.original, ...c.alsoWrittenAs].some((v) => v.toLowerCase().includes(q))
        )
      : opened.codes;
  }, [opened, query]);

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6 pb-16">
      <Brand subtitle="Open a key file" />

      <section className="mt-12">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h1 className="text-3xl font-bold">Open a key file</h1>
          <button onClick={() => router.push('/')} className="btn-secondary text-sm">
            Back
          </button>
        </div>
        <p className="text-[color:var(--color-muted)] max-w-2xl">
          Use the key file saved when you pseudonymised data to look up who a code belongs to, or
          to turn a pseudonymised file back into the original. The key is opened on this device
          only and is forgotten when you close this page.
        </p>

        {!opened ? (
          <div className="surface rounded-2xl p-6 mt-8 max-w-xl">
            <h2 className={heading}>Your key file</h2>
            <input
              type="file"
              accept=".key,.json"
              className="mt-3 block text-sm"
              onChange={(e) => { setKeyFile(e.target.files?.[0] ?? null); setError(null); }}
            />
            <h2 className={`${heading} mt-5`}>Passphrase</h2>
            <input
              type="password"
              autoComplete="current-password"
              className={`${inputClass} mt-2`}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void open(); }}
            />
            {error && (
              <p className="text-sm mt-3" style={{ color: 'var(--color-danger)' }}>{error}</p>
            )}
            <div className="mt-5">
              <button
                type="button"
                className="btn-primary disabled:opacity-40"
                disabled={!keyFile || passphrase.length === 0 || busy}
                onClick={() => void open()}
              >
                {busy ? 'Opening…' : 'Open key'}
              </button>
            </div>
            <p className="text-xs text-[color:var(--color-muted)] mt-4">
              Only pseudonymised data has a key. Anonymised data cannot be reversed, by design.
            </p>
          </div>
        ) : (
          <>
            <div className="surface rounded-2xl p-6 mt-8">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Key opened</h2>
                  <p className="text-sm text-[color:var(--color-muted)] mt-1">
                    {opened.codes.length} code{opened.codes.length === 1 ? '' : 's'}
                    {opened.createdAt ? ` · made ${new Date(opened.createdAt).toLocaleString()}` : ''}
                  </p>
                  {opened.dateShiftDays !== null && (
                    <p className="text-sm mt-2">{describeShift(opened.dateShiftDays)}</p>
                  )}
                </div>
                <button type="button" className="btn-secondary" onClick={close}>
                  Close key
                </button>
              </div>
            </div>

            <div className="surface rounded-2xl p-6 mt-4">
              <h2 className="text-lg font-semibold">Turn a file back into the original</h2>
              <p className="text-sm text-[color:var(--color-muted)] mt-1">
                Choose a pseudonymised text file made with this key (TXT, VTT, SRT, CSV, JSON, HL7).
                The restored copy downloads to this device. Word and PDF files are not supported yet.
              </p>
              <input
                type="file"
                accept={TEXT_TYPES}
                className="mt-3 block text-sm"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void reverse(f); e.target.value = ''; }}
              />
              {reverseMessage && <p className="text-sm mt-3">{reverseMessage}</p>}
              <p className="text-xs mt-3" style={{ color: 'var(--color-warning)' }}>
                A restored file is personal data again. Keep it under the same access control as
                the original.
              </p>
            </div>

            <div className="surface rounded-2xl p-6 mt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Look up a code</h2>
                <input
                  className={`${inputClass} max-w-xs`}
                  placeholder="Search a code or a name"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search codes"
                />
              </div>
              <div className="overflow-x-auto mt-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[color:var(--color-muted)] mono text-xs uppercase tracking-wider border-b border-[color:var(--color-border)]">
                      <th className="py-2 pr-4">Code</th>
                      <th className="py-2 pr-4">Original</th>
                      <th className="py-2">Also written as</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--color-border)]">
                    {rows.slice(0, 300).map((c) => (
                      <tr key={c.code}>
                        <td className="py-2 pr-4 mono whitespace-nowrap">{c.code}</td>
                        <td className="py-2 pr-4">{c.original}</td>
                        <td className="py-2 text-[color:var(--color-muted)]">{c.alsoWrittenAs.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 300 && (
                  <p className="text-xs text-[color:var(--color-muted)] mt-2">
                    Showing 300 of {rows.length}. Search to narrow it down.
                  </p>
                )}
                {rows.length === 0 && (
                  <p className="text-sm text-[color:var(--color-muted)] mt-3">No matching codes.</p>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
