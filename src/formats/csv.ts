/**
 * CSV format handler.
 *
 * Strategy: PapaParse with header row detection. Build a flat (row, col) leaf
 * list, run the engine on the joined leaf text, then write the de-identified
 * values back to a CSV.
 *
 * Column hints: any column header containing 'name', 'phone', 'email', etc.
 * is *not* used to skip detection — the engine catches those by content. The
 * header is only used to label rows in the audit log and for the diff viewer.
 *
 * Numeric / boolean / date columns are processed exactly like text columns
 * because they may still contain PII (a "deceasedBoolean" doesn't, but a
 * "birthDate" definitely does).
 */

import Papa from 'papaparse';

export interface CsvLeaf {
  row: number;
  column: string;
  value: string;
}

export interface CsvIngest {
  headers: string[];
  rows: Record<string, string>[];
  leaves: CsvLeaf[];
}

export function parseCsv(raw: string): CsvIngest {
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  if (parsed.errors.length > 0) {
    // Throw on fatal structural errors — continuing with a malformed parse
    // would produce incorrect leaf offsets and misleading redaction output.
    const fatal = parsed.errors.find(
      (e) => e.type === 'Quotes' || e.type === 'Delimiter' || e.type === 'FieldMismatch'
    );
    if (fatal) throw new Error(`CSV parse error (${fatal.type}): ${fatal.message}`);
    // Non-fatal errors (e.g. TooFewFields on empty trailing rows) are logged
    // to the console for visibility but do not abort processing.
    for (const e of parsed.errors) {
      console.warn(`[PrivacyScript] CSV non-fatal parse warning (${e.type}): ${e.message}`);
    }
  }
  const headers = parsed.meta.fields ?? [];
  const rows = parsed.data;
  const leaves: CsvLeaf[] = [];
  rows.forEach((row, i) => {
    for (const col of headers) {
      const val = row[col];
      if (typeof val === 'string' && val.length > 0) {
        leaves.push({ row: i, column: col, value: val });
      }
    }
  });
  return { headers, rows, leaves };
}

export function reconstructCsv(
  ingest: CsvIngest,
  replacements: Array<{ leaf: CsvLeaf; replacement: string }>
): string {
  const clone = ingest.rows.map((r) => ({ ...r }));
  for (const { leaf, replacement } of replacements) {
    clone[leaf.row][leaf.column] = replacement;
  }
  return Papa.unparse(clone, { columns: ingest.headers });
}
