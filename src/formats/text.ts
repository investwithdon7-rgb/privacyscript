/**
 * Plain text passthrough. The detect/replace engine operates on raw strings,
 * so this is mostly a pair of identity functions wrapped for symmetry with
 * the other format handlers.
 */

export function ingestText(raw: string): string {
  return raw;
}

export function reconstructText(deidentified: string): string {
  return deidentified;
}
