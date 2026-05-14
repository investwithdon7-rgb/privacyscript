'use client';

import type { Span } from '@/engine/detect';

interface DiffViewerProps {
  original: string;
  spans: Span[];
  deidentified: string;
}

export function DiffViewer({ original, spans, deidentified }: DiffViewerProps) {
  return (
    <div className="grid md:grid-cols-2 gap-4 mt-6">
      <Panel title="Original" body={<HighlightedText text={original} spans={spans} />} />
      <Panel title="De-identified" body={<pre className="whitespace-pre-wrap text-sm mono">{deidentified}</pre>} />
    </div>
  );
}

function Panel({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="surface rounded-2xl p-4 max-h-[60vh] overflow-y-auto">
      <div className="mono text-xs text-[color:var(--color-muted)] uppercase tracking-widest mb-2">
        {title}
      </div>
      {body}
    </div>
  );
}

function HighlightedText({ text, spans }: { text: string; spans: Span[] }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((s, i) => {
    if (s.start > cursor) parts.push(<span key={`t-${i}`}>{text.slice(cursor, s.start)}</span>);
    parts.push(
      <span key={`s-${i}`} className="identifier-highlight mono">
        {text.slice(s.start, s.end)}
      </span>
    );
    cursor = s.end;
  });
  if (cursor < text.length) parts.push(<span key="rest">{text.slice(cursor)}</span>);
  return <pre className="whitespace-pre-wrap text-sm">{parts}</pre>;
}
