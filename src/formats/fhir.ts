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
    if (shouldProcessField(path)) out.push({ path, value: node });
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
 */
const SKIP_FIELDS = new Set([
  'resourceType',
  'system',
  'code',
  'status',
  'use',
  'type',
  'unit',
  'reference',
  'profile',
  'meta',
  'id',
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
 */
export function reconstructFhir(
  resource: unknown,
  replacements: Array<{ path: string; replacement: string }>
): string {
  const clone = JSON.parse(JSON.stringify(resource));
  for (const { path, replacement } of replacements) {
    setByPath(clone, path, replacement);
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
