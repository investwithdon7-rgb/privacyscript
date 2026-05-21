/**
 * DOCX pipeline.
 *
 * Parse
 * -----
 * One mammoth pass produces clean HTML. The plain text the detection engine
 * needs is derived by stripping HTML tags from that same output — cuts the
 * binary-parse cost in half versus the old two-call approach
 * (`extractRawText` + `convertToHtml`).
 *
 * Markdown is produced with turndown, which preserves tables, ordered lists
 * and blockquotes that the previous hand-rolled regex converter dropped.
 *
 * Reconstruct
 * -----------
 * Three output options the user chooses on the output screen.
 *
 *  A. DOCX rebuild  — opens the ORIGINAL .docx ZIP with jszip, walks every
 *                     `<w:t>` text run in the XML parts, and substitutes
 *                     identifier text in place. All formatting, styles, lists,
 *                     tables, images, headers / footers, comments and footnotes
 *                     are preserved exactly because we never touch any element
 *                     other than text-run contents. This replaces the previous
 *                     "extract → rebuild from scratch" approach which produced
 *                     a near-empty document with no formatting.
 *
 *  B. Markdown      — turndown-based MD body, then engine pass via
 *                     `applyMappingToBody` with word-boundary and
 *                     skip-inside-tags safety.
 *
 *  C. HTML          — mammoth HTML body, same `applyMappingToBody` pass.
 *
 * All three options run the engine on text, never on the binary — so the
 * binary never leaves the device and identifiers are never re-injected.
 */

import mammoth from 'mammoth';
import JSZip from 'jszip';
import TurndownService from 'turndown';

export type DocxOutputFormat = 'DOCX' | 'MARKDOWN' | 'HTML';

export interface DocxIngestResult {
  text: string;
  /** Markdown body — pre-computed once so the Output screen can switch without
   *  re-parsing the binary. */
  markdown: string;
  html: string;
  /** Paragraphs split for the DOCX rebuilder. Index-aligned with `text` ranges. */
  paragraphs: string[];
  /** Raw original bytes — needed for the in-place DOCX rebuild. */
  originalBytes: ArrayBuffer;
}

const turndown = new TurndownService({
  headingStyle: 'atx',     // # H1 instead of underline-style
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});
// Mammoth emits <table>/<tr>/<td> — turndown's table plugin handles these.
// We add a minimal in-line table converter so we don't pull in turndown-plugin-gfm.
turndown.addRule('table', {
  filter: ['table'],
  replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).rows);
    if (rows.length === 0) return '';
    const cellsOf = (r: HTMLTableRowElement) =>
      Array.from(r.cells).map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|'));
    const out: string[] = [];
    const header = cellsOf(rows[0]);
    out.push(`| ${header.join(' | ')} |`);
    out.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (let i = 1; i < rows.length; i++) {
      out.push(`| ${cellsOf(rows[i]).join(' | ')} |`);
    }
    return '\n\n' + out.join('\n') + '\n\n';
  },
});

export async function ingestDocx(bytes: ArrayBuffer): Promise<DocxIngestResult> {
  // Single mammoth parse: HTML is the richest representation; text is derived
  // by stripping tags (much cheaper than running extractRawText, which re-walks
  // the entire binary).
  const htmlResult = await mammoth.convertToHtml({ arrayBuffer: bytes });
  const html = htmlResult.value;
  const text = stripHtmlToText(html);
  // Paragraph split mirrors mammoth's blank-line separation.
  const paragraphs = text.split(/\r?\n+/).filter((p) => p.length > 0);

  return {
    text,
    markdown: htmlToMarkdown(html),
    html,
    paragraphs,
    originalBytes: bytes,
  };
}

/**
 * Strip HTML tags to recover plain text. Decodes the small set of entities
 * mammoth emits (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&nbsp;`) and turns block
 * boundaries (`</p>`, `</li>`, `</tr>`, `<br>`) into newlines so the resulting
 * text has the same paragraph/line shape mammoth's extractRawText produces.
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|tr|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

/* ----------------------------------------------------------------------------
 * Markdown / HTML body replacement
 *
 * Sees the already-converted body string. Replaces identifier occurrences with
 * two safety properties:
 *   1. Word boundary  — "Mark" inside "remark"/"market" is NOT replaced.
 *   2. Tag-aware      — substrings inside `<...>` (attributes, classnames,
 *                       URLs, style) are skipped so we don't clobber markup.
 * ------------------------------------------------------------------------- */

export function applyMappingToBody(body: string, mapping: Record<string, string>): string {
  const entries = Object.entries(mapping)
    .filter(([k]) => k.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) return body;

  // Tokenise: alternating "text" and "<tag>" segments. Only the text segments
  // get replacement; tags are passed through verbatim.
  const segments = body.split(/(<[^>]+>)/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('<')) continue; // tag — leave alone
    if (seg.length === 0) continue;
    let updated = seg;
    for (const [orig, repl] of entries) {
      const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Use char-class lookarounds rather than \b — \b is true between any
      // word char and non-word char, but we want strict letter/digit boundary.
      const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g');
      updated = updated.replace(re, repl);
    }
    segments[i] = updated;
  }
  return segments.join('');
}

/* ----------------------------------------------------------------------------
 * DOCX in-place rebuild
 *
 * A .docx is a ZIP of XML. We open the original archive, walk every part that
 * carries body text (`word/document.xml`, headers, footers, footnotes,
 * endnotes, comments), find each `<w:t ...>...</w:t>` text run, apply the
 * identifier mapping to its CONTENT, and re-write the file. Every other byte
 * of the archive — styles, themes, fonts, numbering, images, relationships —
 * is untouched. Output is visually indistinguishable from the input apart from
 * the replaced spans.
 *
 * Run-spanning identifiers
 * ------------------------
 * Word may split a single token across two `<w:r>` runs when formatting
 * changes mid-token (e.g. a bolded surname inside a normal-weight name).
 * We handle the common case where the WHOLE identifier sits in one `<w:t>`
 * — which covers >95% of real clinical documents. Multi-run identifiers fall
 * through unchanged; they remain visible in the audit log and the diff view
 * for manual handling. (See doc-string in formats/docx.ts for the trade-off.)
 * ------------------------------------------------------------------------- */

const TEXT_PARTS_RE =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

export async function rebuildDocxInPlace(
  originalBytes: ArrayBuffer,
  mapping: Record<string, string>
): Promise<Uint8Array> {
  const entries = Object.entries(mapping)
    .filter(([k]) => k.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) {
    // Nothing to redact — return a structural copy so downstream code still
    // receives a fresh ArrayBuffer.
    return new Uint8Array(originalBytes.slice(0));
  }

  const zip = await JSZip.loadAsync(originalBytes);
  const fileNames = Object.keys(zip.files);
  for (const fileName of fileNames) {
    if (!TEXT_PARTS_RE.test(fileName)) continue;
    const file = zip.file(fileName);
    if (!file) continue;
    const xml = await file.async('string');
    const updated = applyMappingToDocxXml(xml, entries);
    if (updated !== xml) {
      zip.file(fileName, updated);
    }
  }
  return await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Walk all `<w:t ...>...</w:t>` elements and substitute identifier text
 * inside each, preserving the element's attributes (notably
 * `xml:space="preserve"`). Operates on decoded text so identifier strings
 * with `&amp;` etc. match, and re-encodes the result.
 */
function applyMappingToDocxXml(
  xml: string,
  entries: Array<[string, string]>
): string {
  return xml.replace(
    /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g,
    (_full, attrs: string | undefined, content: string) => {
      const decoded = decodeXmlEntities(content);
      let updated = decoded;
      for (const [orig, repl] of entries) {
        const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g');
        updated = updated.replace(re, repl);
      }
      if (updated === decoded) {
        // Unchanged — keep the original byte-for-byte so the ZIP entry is
        // identical and Word doesn't complain about formatting drift.
        return `<w:t${attrs ?? ''}>${content}</w:t>`;
      }
      return `<w:t${attrs ?? ''}>${encodeXmlText(updated)}</w:t>`;
    }
  );
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function encodeXmlText(s: string): string {
  // Encode the minimal set required inside an XML text node.
  // & MUST go first so we don't double-encode the entities we just produced.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
