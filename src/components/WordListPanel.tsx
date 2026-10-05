'use client';

import { useEffect, useRef, useState } from 'react';
import { getWordListText, parseWordList, setWordListText, subscribeWordList } from '@/engine/wordlist';
import { downloadText } from '@/engine/output';

/**
 * "Words to always hide": staff, ward and site names, study code names.
 * Kept in this tab's memory only; the user saves and loads it as a file.
 */
export function WordListPanel() {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(getWordListText());
    return subscribeWordList(setText);
  }, []);

  const terms = parseWordList(text);

  const load = async (f: File | undefined) => {
    if (!f) return;
    const loaded = await f.text();
    setWordListText(text.trim() ? `${text.trim()}\n${loaded}` : loaded);
  };

  return (
    <details className="surface rounded-xl px-4 py-3 mt-4" open={terms.length > 0}>
      <summary className="cursor-pointer text-sm font-semibold">
        Words to always hide{terms.length ? ` · ${terms.length}` : ' (optional)'}
      </summary>
      <p className="text-xs text-[color:var(--color-muted)] mt-2">
        Names the detectors may not know: staff, wards, local places, study code names. One per line.
        Start a line with <span className="mono">place:</span>, <span className="mono">org:</span> or{' '}
        <span className="mono">id:</span> for other kinds; everything else is treated as a name. Every
        match is hidden in every file.
      </p>
      <textarea
        className="mono w-full mt-3 rounded-lg p-3 text-sm bg-[color:var(--color-surface-2)] border border-[color:var(--color-border)]"
        rows={4}
        placeholder={'Siobhan Kelly\nplace: Kingsway Clinic\nid: STUDY-77'}
        value={text}
        onChange={(e) => setWordListText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
          Load list
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={terms.length === 0}
          onClick={() => downloadText(text, 'words-to-hide.txt', 'text/plain')}
        >
          Save list
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <span className="text-xs text-[color:var(--color-muted)]">
          Kept only while this tab is open. The list names people, so store a saved copy safely.
        </span>
      </div>
    </details>
  );
}
