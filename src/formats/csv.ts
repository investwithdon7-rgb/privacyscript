/**
 * CSV format handler.
 *
 * Strategy: PapaParse with header row detection. Build a flat (row, col) leaf
 * list, run the engine on the joined leaf text, then write the de-identified
 * values back to a CSV.
 *
 * Column hints: headers never SKIP detection — the engine still scans every
 * value by content. Headers that clearly denote names/addresses additionally
 * FORCE redaction of that column's values (see forcedLabelForCsvColumn),
 * because isolated surnames give the NER model nothing to work with.
 *
 * Numeric / boolean / date columns are processed exactly like text columns
 * because they may still contain PII (a "deceasedBoolean" doesn't, but a
 * "birthDate" definitely does).
 */

import Papa from 'papaparse';
import type { IdentifierLabel } from '@/lib/identifiers';

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

/**
 * Structural PII forcing for CSV.
 *
 * A column headed "family" or "surname" IS a name column — its values are
 * redacted even when regex/NER produce no evidence (isolated surnames carry
 * no sentence context for the NER model to work with).
 */
const CSV_NAME_COLUMN =
  /^(?:family|given|surname|forename|middle[_\s]?name|first[_\s]?name|last[_\s]?name|full[_\s]?name|patient[_\s]?name|maiden[_\s]?name|name)$/i;
const CSV_ADDRESS_COLUMN = /^(?:street|city|town|district|line[_\s]?\d*)$/i;

export function forcedLabelForCsvColumn(column: string): IdentifierLabel | null {
  const trimmed = column.trim();
  // FHIR-flattened exports use dotted headers ("name.family", "address.line") —
  // match on the leaf segment, and treat any address.* column as an address
  // except country (a country code alone identifies nobody).
  const leaf = trimmed.split('.').pop()!.trim();
  if (CSV_NAME_COLUMN.test(leaf)) return 'NAME';
  if (/address/i.test(trimmed) && !/country/i.test(trimmed)) return 'ADDRESS_LINE';
  if (CSV_ADDRESS_COLUMN.test(leaf)) return 'ADDRESS_LINE';
  return null;
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
