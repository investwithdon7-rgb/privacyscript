'use client';

import { useCallback, useRef, useState } from 'react';

interface DropZoneProps {
  accept: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}

export function DropZone({ accept, disabled, onFile }: DropZoneProps) {
  const [hot, setHot] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFile(files[0]);
    },
    [onFile]
  );

  return (
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
      className={`mt-8 p-12 rounded-2xl text-center transition-colors cursor-pointer border-2 border-dashed ${
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
        Plain text · FHIR R4 JSON · HL7 v2 · CSV · PDF · DOCX
      </div>
      <div className="mono text-xs text-[color:var(--color-muted)] uppercase tracking-widest">
        Processing happens entirely on this device. Nothing is uploaded.
      </div>
    </div>
  );
}
