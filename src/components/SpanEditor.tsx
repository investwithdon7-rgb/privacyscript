'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Span } from '@/engine/detect';
import type { IdentifierLabel, IdentifierCategory } from '@/lib/identifiers';

export interface SpanEdit {
  type: 'add' | 'dismiss';
  span: Span;
}

interface SpanEditorProps {
  text: string;
  spans: Span[];
  dismissedKeys: Set<string>;
  onAddSpan: (span: Span) => void;
  onDismissSpan: (key: string) => void;
  onRestoreSpan: (key: string) => void;
}

function spanKey(s: Span): string {
  return `${s.start}:${s.end}:${s.label}`;
}

// Labels the user can assign to a manually-drawn span.
const MANUAL_LABELS: Array<{ label: IdentifierLabel; category: IdentifierCategory; description: string }> = [
  { label: 'NAME', category: 'HIPAA', description: 'Patient / person name' },
  { label: 'DATE', category: 'HIPAA', description: 'Date (DOB, admission, etc.)' },
  { label: 'ADDRESS_LINE', category: 'HIPAA', description: 'Street / address' },
  { label: 'PHONE', category: 'HIPAA', description: 'Phone / fax number' },
  { label: 'EMAIL', category: 'HIPAA', description: 'Email address' },
  { label: 'MRN', category: 'HIPAA', description: 'Medical record number' },
  { label: 'SSN', category: 'HIPAA', description: 'Social security number' },
  { label: 'POSTCODE_UK', category: 'EU', description: 'UK postcode' },
  { label: 'INSTITUTION', category: 'QUASI', description: 'Treating institution' },
  { label: 'OCCUPATION', category: 'QUASI', description: 'Occupation / job title' },
];

const LABEL_COLOUR: Record<string, string> = {
  HIPAA: '#4F46E5',
  EU: '#7C3AED',
  QUASI: '#D97706',
};

export function SpanEditor({
  text,
  spans,
  dismissedKeys,
  onAddSpan,
  onDismissSpan,
  onRestoreSpan,
}: SpanEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ key: string; x: number; y: number } | null>(null);

  // Build character-to-position map so we can translate DOM selection into text offsets.
  // Each text node renders a slice of the full text; we track the cumulative offset.

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) {
      setSelection(null);
      setPickerPos(null);
      return;
    }

    // Walk the selection to figure out start/end character offsets in `text`.
    const range = sel.getRangeAt(0);
    const allNodes: Array<{ node: Node; offset: number }> = [];
    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_TEXT);
    let cumOffset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      allNodes.push({ node, offset: cumOffset });
      cumOffset += (node.textContent ?? '').length;
    }

    const findOffset = (target: Node, targetOffset: number): number => {
      const entry = allNodes.find((n) => n.node === target);
      return entry ? entry.offset + targetOffset : 0;
    };

    const startOffset = findOffset(range.startContainer, range.startOffset);
    const endOffset = findOffset(range.endContainer, range.endOffset);
    if (startOffset >= endOffset) return;

    const selectedText = text.slice(startOffset, endOffset).trim();
    if (selectedText.length < 2) return;

    const rect = range.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    setSelection({ start: startOffset, end: endOffset, text: selectedText });
    setPickerPos({
      x: rect.left - containerRect.left,
      y: rect.bottom - containerRect.top + 8,
    });
    sel.removeAllRanges();
  }, [text]);

  const pickLabel = useCallback(
    (label: IdentifierLabel, category: IdentifierCategory) => {
      if (!selection) return;
      const newSpan: Span = {
        start: selection.start,
        end: selection.end,
        text: selection.text,
        label,
        category,
        source: 'ner', // mark as manual (reuses NER slot)
        confidence: 1,
      };
      onAddSpan(newSpan);
      setSelection(null);
      setPickerPos(null);
    },
    [selection, onAddSpan]
  );

  // Close picker on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerPos && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSelection(null);
        setPickerPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerPos]);

  // Render text with span highlights.
  const sortedSpans = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  sortedSpans.forEach((s, i) => {
    if (s.start > cursor) {
      parts.push(<span key={`t${i}`}>{text.slice(cursor, s.start)}</span>);
    }
    const key = spanKey(s);
    const isDismissed = dismissedKeys.has(key);
    const colour = LABEL_COLOUR[s.category] ?? '#4F46E5';

    parts.push(
      <mark
        key={key}
        data-span-key={key}
        title={`${s.label} (${s.source}${s.confidence != null ? ` · ${Math.round(s.confidence * 100)}%` : ''}). Click to dismiss.`}
        onClick={() => {
          if (isDismissed) {
            onRestoreSpan(key);
          } else {
            setTooltip(null);
            onDismissSpan(key);
          }
        }}
        className="cursor-pointer rounded px-0.5 transition-all"
        style={{
          background: isDismissed ? 'rgba(100,116,139,0.15)' : `${colour}33`,
          borderBottom: isDismissed ? '1px dashed #64748b' : `2px solid ${colour}`,
          color: isDismissed ? 'var(--color-muted)' : 'inherit',
          textDecoration: isDismissed ? 'line-through' : 'none',
        }}
      >
        {text.slice(s.start, s.end)}
        <sup
          className="mono text-[9px] ml-0.5 opacity-60"
          style={{ color: isDismissed ? '#64748b' : colour }}
        >
          {s.label.slice(0, 4)}
        </sup>
      </mark>
    );
    cursor = Math.max(cursor, s.end);
  });

  if (cursor < text.length) {
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
  }

  return (
    <div className="surface rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold">Span editor</h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1">
            <strong>Click</strong> a highlighted span to dismiss it as a false positive.
            <strong> Select text</strong> to add a new span the engine missed.
            Dismissed spans are struck-through and will not be redacted.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="tag">{spans.filter(s => !dismissedKeys.has(spanKey(s))).length} active</span>
          <span className="tag">{dismissedKeys.size} dismissed</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4 text-xs">
        {Object.entries(LABEL_COLOUR).map(([cat, colour]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: `${colour}33`, border: `1px solid ${colour}` }} />
            <span className="text-[color:var(--color-muted)]">{cat}</span>
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgba(100,116,139,0.15)', border: '1px dashed #64748b' }} />
          <span className="text-[color:var(--color-muted)]">Dismissed</span>
        </span>
      </div>

      {/* Document text with interactive spans */}
      <div
        ref={containerRef}
        onMouseUp={handleMouseUp}
        className="relative surface-2 rounded-xl p-4 text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto select-text"
        style={{ fontFamily: 'inherit', lineHeight: 1.8 }}
      >
        {parts}

        {/* Label picker popover */}
        {pickerPos && selection && (
          <div
            className="absolute z-50 surface rounded-xl border border-[color:var(--color-border)] shadow-xl p-3 w-64"
            style={{ left: Math.min(pickerPos.x, 300), top: pickerPos.y }}
          >
            <div className="mono text-xs text-[color:var(--color-muted)] mb-2 uppercase tracking-widest">
              Label &ldquo;{selection.text.slice(0, 30)}{selection.text.length > 30 ? '…' : ''}&rdquo;
            </div>
            <ul className="space-y-1">
              {MANUAL_LABELS.map(({ label, category, description }) => (
                <li key={label}>
                  <button
                    type="button"
                    onClick={() => pickLabel(label, category)}
                    className="w-full text-left px-3 py-1.5 rounded-lg text-sm hover:bg-[color:var(--color-surface-2)] transition-colors flex items-center justify-between"
                  >
                    <span>{label}</span>
                    <span className="text-xs text-[color:var(--color-muted)]">{description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => { setSelection(null); setPickerPos(null); }}
              className="mt-2 w-full text-xs text-[color:var(--color-muted)] hover:text-white py-1"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-[color:var(--color-muted)] mono">
        {tooltip && <span>Click &ldquo;{tooltip.key}&rdquo; again to restore.</span>}
        Select text in the document above to add a missed identifier.
      </p>
    </div>
  );
}
