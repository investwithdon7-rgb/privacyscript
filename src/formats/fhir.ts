/**
 * FHIR R4 JSON handler.
 *
 * Strategy: walk the resource tree, collect every string leaf with its JSON
 * path, run detection+replacement on each leaf independently (with a shared
 * mapping for cross-field consistency in pseudonymise mode), then write the
 * results back into a deep clone of the original.
 *
 * We intentionally do not use fhir.js — it is Node-oriented and unnecessary
 * for the in/out we need (parse + reconstruct).
 */

export interface FhirLeaf {
  path: string;
  value: string;
  /**
   * For FHIR `reference` fields only: the "ResourceType/" prefix that must be
   * prepended when writing back. The `value` carries only the local ID part
   * (the substring after the final "/") so the detection engine sees a bare ID
   * rather than a URL. reconstructFhir restores the prefix automatically.
   */
  referencePrefix?: string;
}

export function parseFhir(json: string): { resource: unknown; leaves: FhirLeaf[] } {
  const resource = JSON.parse(json);
  const leaves: FhirLeaf[] = [];
  walk(resource, '', leaves);
  return { resource, leaves };
}

function walk(node: unknown, path: string, out: FhirLeaf[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (shouldProcessField(path)) {
      // `reference` fields look like "Patient/12345" or "urn:uuid:…".
      // We only want to run detection on the local ID part (after the last "/")
      // so the engine sees a bare identifier rather than a URL or resource type.
      // Fragments ("#contained") and entries with no slash are skipped.
      const leafKey = path.split('.').pop()?.replace(/\[\d+\]/, '');
      if (leafKey === 'reference') {
        const slashIdx = node.lastIndexOf('/');
        if (slashIdx < 0 || node.startsWith('#')) return; // structural / fragment ref
        out.push({
          path,
          value: node.slice(slashIdx + 1),
          referencePrefix: node.slice(0, slashIdx + 1),
        });
        return;
      }
      out.push({ path, value: node });
    }
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    walk(v, path ? `${path}.${k}` : k, out);
  }
}

/**
 * Skip fields where redaction would corrupt the FHIR semantics.
 * resourceType, system, code, status, etc. are structural.
 *
 * NOTE: `reference` and `id` are intentionally NOT listed here.
 * - `id` values are resource identifiers (MRNs, UUIDs) that must be redacted.
 * - `reference` values are handled specially in walk(): only the local ID part
 *   (after the final "/") is extracted and processed; the prefix is restored in
 *   reconstructFhir() via FhirLeaf.referencePrefix.
 */
const SKIP_FIELDS = new Set([
  'resourceType',
  'system',
  'code',
  'status',
  'use',
  'type',
  'unit',
  'profile',
  'meta',
  'fullUrl',
  'versionId',
  'gender',
]);

function shouldProcessField(path: string): boolean {
  const leaf = path.split('.').pop()?.replace(/\[\d+\]/, '');
  if (!leaf) return false;
  if (SKIP_FIELDS.has(leaf)) return false;
  // Skip structural URI/system paths.
  if (leaf.endsWith('System') || leaf.endsWith('Url')) return false;
  return true;
}

/**
 * Apply de-identified values back into a deep clone of the original resource.
 * Each leaf is set by walking its JSON path.
 *
 * For `reference` leaves, referencePrefix is prepended so the written value
 * remains "ResourceType/<replacement>" rather than a bare token.
 */
export function reconstructFhir(
  resource: unknown,
  replacements: Array<{ path: string; replacement: string; referencePrefix?: string }>
): string {
  const clone = JSON.parse(JSON.stringify(resource));
  for (const { path, replacement, referencePrefix } of replacements) {
    setByPath(clone, path, (referencePrefix ?? '') + replacement);
  }
  return JSON.stringify(clone, null, 2);
}

function setByPath(root: unknown, path: string, value: string): void {
  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    cur = /^\d+$/.test(p) ? cur[parseInt(p, 10)] : cur[p];
    if (cur === undefined) return;
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) cur[parseInt(last, 10)] = value;
  else cur[last] = value;
}
