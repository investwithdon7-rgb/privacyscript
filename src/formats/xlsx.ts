/**
 * Minimal XLSX reader for survey exports (Qualtrics, REDCap, SurveyMonkey,
 * Microsoft Forms all offer .xlsx). Reads the FIRST worksheet into a 2-D
 * string grid using jszip (already a dependency) — no spreadsheet library,
 * no network, no formula evaluation (cached values are used).
 *
 * Output is converted to CSV text and fed through the CSV pipeline, so the
 * de-identified download is a .csv file. The UI tells the user this.
 */

import JSZip from 'jszip';

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'",
};

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** Concatenate every <t> run inside a string item (handles rich text). */
function textOf(xml: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Built-in number formats that are dates/times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function excelSerialToIso(serial: number): string {
  // Excel epoch 1899-12-30 (accounts for the 1900 leap-year bug).
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const iso = d.toISOString();
  // Whole days → date only; otherwise date + time (seconds precision).
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

async function readDateStyleIndexes(zip: JSZip): Promise<Set<number>> {
  const xml = await zip.file('xl/styles.xml')?.async('string');
  const dateStyles = new Set<number>();
  if (!xml) return dateStyles;
  const customDate = new Set<number>();
  const numFmtRe = /<numFmt\s+[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml))) {
    // Strip quoted literals and [colour] blocks, then look for date tokens.
    const code = decodeXml(m[2]).replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[dmyhs]/i.test(code) && !/^[#0.,%\s]*$/.test(code)) customDate.add(+m[1]);
  }
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const xfRe = /<xf\s[^>]*?numFmtId="(\d+)"/g;
  let i = 0;
  while ((m = xfRe.exec(cellXfs))) {
    const id = +m[1];
    if (BUILTIN_DATE_FMTS.has(id) || customDate.has(id)) dateStyles.add(i);
    i++;
  }
  return dateStyles;
}

async function firstSheetPath(zip: JSZip): Promise<string> {
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  const rid = workbook && /<sheet\s[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  if (rid && rels) {
    const relRe = new RegExp(`<Relationship\\s[^>]*Id="${rid}"[^>]*Target="([^"]+)"`);
    const alt = new RegExp(`<Relationship\\s[^>]*Target="([^"]+)"[^>]*Id="${rid}"`);
    const target = relRe.exec(rels)?.[1] ?? alt.exec(rels)?.[1];
    if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return 'xl/worksheets/sheet1.xml';
}

/** Read the first worksheet as a grid of strings. */
export async function readXlsxGrid(bytes: ArrayBuffer): Promise<string[][]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('This file is not a valid .xlsx workbook. Try exporting it as CSV instead.');
  }
  const sheetPath = await firstSheetPath(zip);
  const sheet = await zip.file(sheetPath)?.async('string');
  if (!sheet) throw new Error('The workbook has no readable worksheet.');

  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(sstXml))) shared.push(textOf(m[1]));

  const dateStyles = await readDateStyleIndexes(zip);

  const grid: string[][] = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rowOrdinal = 0;
  while ((m = rowRe.exec(sheet))) {
    const rowRef = /\sr="(\d+)"/.exec(m[1])?.[1];
    const rowIdx = rowRef ? +rowRef - 1 : rowOrdinal;
    rowOrdinal = rowIdx + 1;
    const row: string[] = [];
    let cm: RegExpExecArray | null;
    let colOrdinal = 0;
    cellRe.lastIndex = 0;
    const rowBody = m[2] ?? '';
    while ((cm = cellRe.exec(rowBody))) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /\sr="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const col = ref ? colIndex(ref) : colOrdinal;
      colOrdinal = col + 1;
      const type = /\st="([^"]+)"/.exec(attrs)?.[1];
      const style = +(/\ss="(\d+)"/.exec(attrs)?.[1] ?? -1);
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = raw !== undefined ? shared[+raw] ?? '' : '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = raw !== undefined ? decodeXml(raw) : '';
      else if (raw !== undefined) {
        const num = Number(raw);
        value = dateStyles.has(style) && isFinite(num) ? excelSerialToIso(num) : raw;
      }
      row[col] = value;
    }
    grid[rowIdx] = Array.from(row, (v) => v ?? '');
  }
  // Fill sparse rows and drop trailing empty rows.
  const dense = Array.from(grid, (r) => r ?? []);
  while (dense.length && dense[dense.length - 1].every((v) => !v)) dense.pop();
  return dense;
}

/** Read the first worksheet and serialise it as CSV for the CSV pipeline. */
export async function xlsxToCsv(bytes: ArrayBuffer): Promise<string> {
  const grid = await readXlsxGrid(bytes);
  if (grid.length === 0) throw new Error('The first worksheet is empty.');
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const Papa = (await import('papaparse')).default;
  return Papa.unparse(grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')));
}
