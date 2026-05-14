/**
 * DOCX pipeline.
 *
 * Parse: mammoth.js extracts the document as either plain text (for engine
 * processing) or as a {value, messages} bundle of HTML / Markdown.
 *
 * Reconstruct: three output options the user chooses on the output screen.
 *   A. DOCX rebuild — write a new .docx via the `docx` library. Formatting is
 *      approximate (paragraph + heading preserved; complex tables/comments lost).
 *      Best for handing back to the same workflow.
 *   B. Markdown — clean MD via mammoth, then re-run engine on the MD body.
 *   C. HTML   — styled HTML body via mammoth, then engine pass.
 *
 * All three options run the engine on text, never on the binary, so the binary
 * never leaves the device and never sees identifiers re-injected.
 */

import mammoth from 'mammoth';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from 'docx';

export type DocxOutputFormat = 'DOCX' | 'MARKDOWN' | 'HTML';

export interface DocxIngestResult {
  text: string;
  /** Markdown body — pre-computed once so the Output screen can switch without
   *  re-parsing the binary. */
  markdown: string;
  html: string;
  /** Paragraphs split for the DOCX rebuilder. Index-aligned with `text` ranges. */
  paragraphs: string[];
}

export async function ingestDocx(bytes: ArrayBuffer): Promise<DocxIngestResult> {
  // mammoth wants a Node Buffer-like or {arrayBuffer}; { arrayBuffer } works.
  const [textResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ arrayBuffer: bytes }),
    mammoth.convertToHtml({ arrayBuffer: bytes }),
  ]);

  const text = textResult.value;
  const html = htmlResult.value;
  // Paragraph split mirrors mammoth's blank-line separation.
  const paragraphs = text.split(/\r?\n+/).filter((p) => p.length > 0);

  return {
    text,
    markdown: htmlToMarkdown(html),
    html,
    paragraphs,
  };
}

/**
 * Minimal HTML → Markdown for mammoth's whitelisted subset (h1-h3, p, ul, ol,
 * li, strong, em, table). Good enough for clinical documents. Anything mammoth
 * does not emit is dropped.
 */
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(?:p|ul|ol|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Replace identifiers in a pre-computed body (markdown or html) using the
 * mapping built from the plain-text engine pass. Mapping is original → token,
 * so we replace longest-first to avoid overlapping replacements.
 */
export function applyMappingToBody(body: string, mapping: Record<string, string>): string {
  const entries = Object.entries(mapping).sort(
    (a, b) => b[0].length - a[0].length
  );
  let out = body;
  for (const [orig, repl] of entries) {
    if (orig.length < 2) continue;
    // Escape regex special chars and apply.
    const re = new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Rebuild a DOCX from de-identified plain text. Each paragraph becomes a
 * paragraph in the output; lines starting with '#' are treated as headings to
 * roughly preserve structure produced by mammoth's text extraction.
 */
export async function rebuildDocx(deidentifiedText: string): Promise<Uint8Array> {
  const paragraphs = deidentifiedText.split(/\r?\n/).map((line) => {
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level =
        headingMatch[1].length === 1
          ? HeadingLevel.HEADING_1
          : headingMatch[1].length === 2
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3;
      return new Paragraph({
        heading: level,
        children: [new TextRun({ text: headingMatch[2], bold: true })],
      });
    }
    return new Paragraph({ children: [new TextRun(line)] });
  });

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });
  return await Packer.toBuffer(doc);
}
