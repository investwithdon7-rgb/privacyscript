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
  { label: 'REFERENCE_ID', category: 'HIPAA', description: 'Other unique ID / code' },
  { label: 'POSTCODE_UK', category: 'EU', description: 'UK postcode' },
  { label: 'INSTITUTION', category: 'QUASI', description: 'Treating institution' },
  { label: 'OCCUPATION', category: 'QUASI', description: 'Occupation / job title' },
];

const LABEL_COLOUR: Record<string, string> = {
  HIPAA: '#4F46E5',
  EU: '#7C3AED',
  QUASI: '#D97706',
};

const SOURCE_NAME: Record<string, string> = {
  rule: 'pattern rule',
  ner: 'AI model',
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
  const [spanMenu, setSpanMenu] = useState<{ span: Span; key: string; x: number; y: number } | null>(null);

  // Translate a DOM point into a character offset in `text`. Only text nodes
  // that render actual document text count — nodes inside [data-offset-ignore]
  // (the little label superscripts, the popovers) are skipped. Counting them
  // used to shift every selection by ~4 characters per preceding highlight.
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) {
      setSelection(null);
      setPickerPos(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const allNodes: Array<{ node: Node; offset: number }> = [];
    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_TEXT);
    let cumOffset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node.parentElement)?.closest('[data-offset-ignore]')) continue;
      allNodes.push({ node, offset: cumOffset });
      cumOffset += (node.textContent ?? '').length;
    }
    const totalLength = cumOffset;

    const findOffset = (target: Node, targetOffset: number): number => {
      if (target.nodeType === Node.TEXT_NODE) {
        const entry = allNodes.find((n) => n.node === target);
        return entry ? entry.offset + targetOffset : 0;
      }
      // Element boundary (e.g. triple-click selects the paragraph): resolve to
      // the first counted text node at or after the child index.
      const children = target.childNodes;
      for (let i = targetOffset; i < children.length; i++) {
        const child = children[i];
        const first =
          child.nodeType === Node.TEXT_NODE
            ? child
            : document.createTreeWalker(child, NodeFilter.SHOW_TEXT).nextNode();
        if (!first) continue;
        const entry = allNodes.find((n) => n.node === first);
        if (entry) return entry.offset;
      }
      return totalLength;
    };

    let startOffset = findOffset(range.startContainer, range.startOffset);
    let endOffset = findOffset(range.endContainer, range.endOffset);
    // Trim whitespace off the edges so the span covers exactly the visible words.
    while (startOffset < endOffset && /\s/.test(text[startOffset])) startOffset++;
    while (endOffset > startOffset && /\s/.test(text[endOffset - 1])) endOffset--;
    if (endOffset - startOffset < 2) return;

    const selectedText = text.slice(startOffset, endOffset);

    const rect = range.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    setSpanMenu(null);
    setSelection({ start: startOffset, end: endOffset, text: selectedText });
    setPickerPos({
      x: rect.left - containerRect.left + containerRef.current.scrollLeft,
      y: rect.bottom - containerRect.top + containerRef.current.scrollTop + 8,
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

  const openSpanMenu = useCallback((e: React.MouseEvent<HTMLElement>, s: Span, key: string) => {
    if (!containerRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    setSelection(null);
    setPickerPos(null);
    setSpanMenu({
      span: s,
      key,
      x: rect.left - containerRect.left + containerRef.current.scrollLeft,
      y: rect.bottom - containerRect.top + containerRef.current.scrollTop + 8,
    });
  }, []);

  // Close popovers on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (spanMenu && !target.closest('[data-span-menu]') && !target.closest('mark')) {
        setSpanMenu(null);
      }
      if (pickerPos && containerRef.current && !containerRef.current.contains(target)) {
        setSelection(null);
        setPickerPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerPos, spanMenu]);

  // Render text with span highlights. Overlapping spans are clipped to the
  // unrendered region — re-rendering overlapped text would make the visible
  // text diverge from `text` and corrupt the selection offset mapping above.
  const sortedSpans = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  sortedSpans.forEach((s, i) => {
    const renderStart = Math.max(s.start, cursor);
    if (renderStart >= s.end) return; // fully covered by a previous span
    if (s.start > cursor) {
      parts.push(<span key={`t${i}`}>{text.slice(cursor, s.start)}</span>);
    }
    const key = spanKey(s);
    const isDismissed = dismissedKeys.has(key);
    const colour = LABEL_COLOUR[s.category] ?? '#4F46E5';

    parts.push(
      <mark
        key={`${key}#${i}`}
        data-span-key={key}
        title={`${s.label} — click for options`}
        onClick={(e) => openSpanMenu(e, s, key)}
        className="cursor-pointer rounded px-0.5 transition-all"
        style={{
          background: isDismissed ? 'rgba(100,116,139,0.15)' : `${colour}33`,
          borderBottom: isDismissed ? '1px dashed #64748b' : `2px solid ${colour}`,
          color: isDismissed ? 'var(--color-muted)' : 'inherit',
          textDecoration: isDismissed ? 'line-through' : 'none',
        }}
      >
        {text.slice(renderStart, s.end)}
        <sup
          data-offset-ignore
          className="mono text-[9px] ml-0.5 opacity-60 select-none"
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

  const menuSpan = spanMenu?.span;
  const menuDismissed = spanMenu ? dismissedKeys.has(spanMenu.key) : false;

  return (
    <div className="surface rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review what will be redacted</h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1">
            Every highlighted item below will be replaced in the output.
            Wrongly highlighted? <strong>Click it</strong> and choose &ldquo;Don&rsquo;t redact&rdquo;.
            Something missed? <strong>Select the text</strong> with your mouse and pick a label.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="tag">{spans.filter(s => !dismissedKeys.has(spanKey(s))).length} will be redacted</span>
          <span className="tag">{dismissedKeys.size} kept as-is</span>
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
          <span className="text-[color:var(--color-muted)]">Kept as-is (won&rsquo;t be redacted)</span>
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

        {/* Span action menu (opens on click of a highlight) */}
        {spanMenu && menuSpan && (
          <div
            data-span-menu
            data-offset-ignore
            className="absolute z-50 surface rounded-xl border border-[color:var(--color-border)] shadow-xl p-3 w-72"
            style={{ left: Math.min(spanMenu.x, 300), top: spanMenu.y }}
          >
            <div className="mono text-xs text-[color:var(--color-muted)] mb-1 uppercase tracking-widest">
              {menuSpan.label}
            </div>
            <div className="text-sm mb-2 break-words">
              &ldquo;{menuSpan.text.slice(0, 60)}{menuSpan.text.length > 60 ? '…' : ''}&rdquo;
            </div>
            <div className="text-xs text-[color:var(--color-muted)] mb-3">
              Found by {SOURCE_NAME[menuSpan.source] ?? menuSpan.source}
              {menuSpan.source === 'ner' && menuSpan.confidence != null && menuSpan.confidence < 1
                ? ` · ${Math.round(menuSpan.confidence * 100)}% confidence`
                : ''}
            </div>
            {menuDismissed ? (
              <button
                type="button"
                onClick={() => { onRestoreSpan(spanMenu.key); setSpanMenu(null); }}
                className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-[color:var(--color-surface-2)] transition-colors"
              >
                <span className="font-semibold">Redact this again</span>
                <span className="block text-xs text-[color:var(--color-muted)] mt-0.5">
                  It will be replaced in the output.
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { onDismissSpan(spanMenu.key); setSpanMenu(null); }}
                className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-[color:var(--color-surface-2)] transition-colors"
              >
                <span className="font-semibold">Don&rsquo;t redact — this isn&rsquo;t an identifier</span>
                <span className="block text-xs text-[color:var(--color-muted)] mt-0.5">
                  The text stays unchanged in the output.
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setSpanMenu(null)}
              className="mt-1 w-full text-xs text-[color:var(--color-muted)] hover:text-white py-1"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Label picker popover (opens after selecting text) */}
        {pickerPos && selection && (
          <div
            data-offset-ignore
            className="absolute z-50 surface rounded-xl border border-[color:var(--color-border)] shadow-xl p-3 w-64"
            style={{ left: Math.min(pickerPos.x, 300), top: pickerPos.y }}
          >
            <div className="mono text-xs text-[color:var(--color-muted)] mb-2 uppercase tracking-widest">
              Redact &ldquo;{selection.text.slice(0, 30)}{selection.text.length > 30 ? '…' : ''}&rdquo; as
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
        Tip: drag across any text above to redact something the engine missed.
      </p>
    </div>
  );
}
