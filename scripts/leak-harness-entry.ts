/**
 * Bundled entry for scripts/leak-harness.mjs — exposes a single function that
 * runs detect → replace → validate on a text and reports surviving originals.
 */
import { Crypto } from '@peculiar/webcrypto';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { validate } from '@/engine/validate';
import { generateSessionSecret } from '@/engine/crypto';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as unknown as { crypto: Crypto }).crypto = new Crypto();
}

export async function runLeakCheck(text: string) {
  const detection = detect(text);
  const secret = await generateSessionSecret();
  const result = await replaceSpans(text, detection.spans, detection.quasiSpans, {
    mode: 'PSEUDONYMISE',
    secret,
    quasiToRedact: new Set(detection.quasiSpans.map((q) => q.label)),
  });
  const v = await validate(result.text, {
    mode: 'PSEUDONYMISE',
    originalIdentifiers: Object.keys(result.mapping),
  });
  return {
    spanCount: detection.spans.length,
    replacementCount: result.replacements.length,
    passed: v.passed,
    originalsLeaked: v.originalsLeaked,
    outputText: result.text,
  };
}
