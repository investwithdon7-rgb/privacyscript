export type RecordFormat =
  | 'TEXT'
  | 'FHIR_R4'
  | 'HL7_V2'
  | 'PDF_TYPED'
  | 'PDF_SCANNED'
  | 'DOCX'
  | 'CSV'
  | 'UNKNOWN';

export interface IngestResult {
  format: RecordFormat;
  text: string;
  /** For structured formats: a list of (path, value) leaf pairs we processed. */
  fieldMap?: Array<{ path: string; value: string }>;
  /** Original structured object (FHIR/HL7) — used for reconstruction. */
  original?: unknown;
  /** Raw bytes for binary formats (PDF/DOCX). */
  bytes?: ArrayBuffer;
  /** Original filename + size for the audit log. */
  filename: string;
  size: number;
}

const HL7_SEGMENT_RE = /^MSH\|/;
const FHIR_RESOURCE_KEYS = new Set([
  'resourceType',
  'Patient',
  'Bundle',
  'Observation',
  'Encounter',
  'Condition',
]);

/**
 * Decide which format an uploaded file is. Uses extension first, then a
 * content sniff for robustness.
 */
export function detectFormat(filename: string, content: string): RecordFormat {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'hl7') return 'HL7_V2';
  if (ext === 'json') {
    return looksLikeFhir(content) ? 'FHIR_R4' : 'TEXT';
  }
  if (ext === 'pdf') return 'PDF_TYPED'; // PDF subtype resolved later in the PDF pipeline
  if (ext === 'docx') return 'DOCX';
  if (ext === 'csv' || ext === 'tsv') return 'CSV';
  if (ext === 'txt' || ext === 'md') return 'TEXT';

  // Sniff content
  if (HL7_SEGMENT_RE.test(content.trim())) return 'HL7_V2';
  if (looksLikeFhir(content)) return 'FHIR_R4';

  return 'TEXT';
}

function looksLikeFhir(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return false;
    const keys = new Set(Object.keys(parsed));
    if (FHIR_RESOURCE_KEYS.has(parsed.resourceType)) return true;
    for (const k of keys) if (FHIR_RESOURCE_KEYS.has(k)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Read a File object as text. Used for the text-based formats. Binary formats
 * are read via .arrayBuffer() in their own handlers.
 */
export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Detect format from filename only — used for binary inputs before we read. */
export function detectFormatByExt(filename: string): RecordFormat {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'hl7':
      return 'HL7_V2';
    case 'json':
      return 'FHIR_R4';
    case 'pdf':
      return 'PDF_TYPED';
    case 'docx':
      return 'DOCX';
    case 'csv':
    case 'tsv':
      return 'CSV';
    case 'txt':
    case 'md':
      return 'TEXT';
    default:
      return 'UNKNOWN';
  }
}
