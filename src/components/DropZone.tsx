'use client';

import { useCallback, useRef, useState } from 'react';

interface DropZoneProps {
  accept: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}

type Tab = 'file' | 'paste';

export function DropZone({ accept, disabled, onFile }: DropZoneProps) {
  const [hot, setHot] = useState(false);
  const [tab, setTab] = useState<Tab>('file');
  const [pastedText, setPastedText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFile(files[0]);
    },
    [onFile]
  );

  const handlePasteSubmit = useCallback(() => {
    const trimmed = pastedText.trim();
    if (!trimmed) return;
    // Create a synthetic File object so the rest of the pipeline is unchanged.
    const blob = new Blob([trimmed], { type: 'text/plain' });
    const file = new File([blob], 'pasted-record.txt', { type: 'text/plain', lastModified: Date.now() });
    setPastedText('');
    onFile(file);
  }, [pastedText, onFile]);

  // Allow paste via Ctrl+V into the whole DropZone when on file tab.
  const handleGlobalPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (disabled || tab !== 'file') return;
      const text = e.clipboardData.getData('text');
      if (text.trim().length > 20) {
        // Switch to paste tab with the pasted content pre-filled.
        setPastedText(text);
        setTab('paste');
      }
    },
    [disabled, tab]
  );

  return (
    <div className="mt-8" onPaste={handleGlobalPaste}>
      {/* Tab switcher */}
      <div className="flex gap-1 mb-0" role="tablist">
        {(['file', 'paste'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => !disabled && setTab(t)}
            className="px-4 py-2 text-sm font-medium rounded-t-xl border border-b-0 transition-colors"
            style={{
              background: tab === t ? 'var(--color-surface)' : 'transparent',
              borderColor: tab === t ? 'var(--color-border)' : 'transparent',
              color: tab === t ? 'white' : 'var(--color-muted)',
            }}
            disabled={!!disabled}
          >
            {t === 'file' ? 'Upload file' : 'Paste text'}
          </button>
        ))}
      </div>

      {tab === 'file' ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            if (!disabled) handleFiles(e.dataTransfer.files);
          }}
          className={`p-12 rounded-b-2xl rounded-tr-2xl text-center transition-colors cursor-pointer border-2 border-dashed ${
            hot ? 'bg-[color:var(--color-surface-2)]' : 'surface'
          } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
          style={{ borderColor: hot ? '#4F46E5' : 'var(--color-border)' }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div className="text-lg font-semibold mb-2">
            Drop a health record here, or click to browse
          </div>
          <div className="text-sm text-[color:var(--color-muted)] mb-4">
            Plain text · FHIR R4 JSON · HL7 v2 · CSV · PDF · DOCX · DICOM (.dcm)
          </div>
          <div className="mono text-xs text-[color:var(--color-muted)] uppercase tracking-widest">
            Processing happens entirely on this device. Nothing is uploaded.
          </div>
        </div>
      ) : (
        <div
          className="surface rounded-b-2xl rounded-tr-2xl p-6"
          style={{ borderTop: 'none' }}
        >
          <label className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)] mb-2 block">
            Paste record text
          </label>
          <textarea
            ref={textareaRef}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            disabled={!!disabled}
            placeholder="Paste the contents of a discharge summary, clinical note, or any health record…"
            className="w-full h-48 bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded-xl px-4 py-3 text-sm font-mono resize-none focus:outline-none focus:border-[#4F46E5] transition-colors"
            style={{ color: 'var(--color-text)' }}
          />
          <div className="mt-3 flex items-center justify-between gap-4 flex-wrap">
            <span className="mono text-xs text-[color:var(--color-muted)]">
              {pastedText.trim().length > 0
                ? `${pastedText.trim().length.toLocaleString()} characters`
                : 'Nothing pasted yet'}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPastedText('')}
                className="btn-secondary text-sm"
                disabled={!pastedText.trim()}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handlePasteSubmit}
                className="btn-primary text-sm"
                disabled={!pastedText.trim() || !!disabled}
              >
                Process pasted text
              </button>
            </div>
          </div>
          <div className="mt-3 mono text-xs text-[color:var(--color-muted)]">
            Processed entirely in this browser. Nothing leaves your device.
          </div>
        </div>
      )}
    </div>
  );
}
