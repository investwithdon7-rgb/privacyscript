/**
 * Re-identification with the user's own key file (pseudonymise mode only).
 *
 * The key file is AES-GCM encrypted with a key derived from the user's
 * passphrase (PBKDF2). Decryption happens in this browser; the decrypted
 * table lives only in memory for as long as the page is open. Nothing is
 * stored or sent anywhere — the same guarantee as the rest of the app.
 */

import type { EncryptedKeyFile } from '@/engine/crypto';
import { deriveDateShift } from '@/engine/replace';
import { KEY_FILE_PARAMS } from '@/lib/constants';

export interface OpenedKey {
  /** code → original, one original per code (the fullest form). */
  codes: Array<{ code: string; original: string; alsoWrittenAs: string[] }>;
  /** Days dates were shifted by; subtract to restore. Null if unknown. */
  dateShiftDays: number | null;
  createdAt: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseKeyFile(json: string): EncryptedKeyFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('This is not a PrivacyScript key file (it is not valid JSON).');
  }
  const k = data as Partial<EncryptedKeyFile>;
  if (k.version !== 1 || k.algorithm !== 'AES-GCM-256' || !k.ciphertextB64 || !k.saltB64 || !k.ivB64) {
    throw new Error('This is not a PrivacyScript key file.');
  }
  return k as EncryptedKeyFile;
}

/** Decrypt a key file. Throws a plain-language error on a wrong passphrase. */
export async function openKeyFile(file: EncryptedKeyFile, passphrase: string): Promise<OpenedKey> {
  const passKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(file.saltB64),
      iterations: file.iterations || KEY_FILE_PARAMS.pbkdf2Iterations,
      hash: KEY_FILE_PARAMS.hash,
    },
    passKey,
    { name: 'AES-GCM', length: KEY_FILE_PARAMS.aesKeyBits },
    false,
    ['decrypt']
  );

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(file.ivB64) },
      aesKey,
      b64ToBytes(file.ciphertextB64)
    );
  } catch {
    // AES-GCM authentication fails for a wrong passphrase or an altered file.
    throw new Error('Wrong passphrase, or the key file has been changed.');
  }

  const payload = JSON.parse(new TextDecoder().decode(plain)) as {
    sessionKey?: string;
    mapping: Record<string, string>;
  };

  let dateShiftDays: number | null = null;
  if (payload.sessionKey) {
    const rawKey = b64ToBytes(payload.sessionKey);
    const hmacKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    dateShiftDays = await deriveDateShift({ hmacKey, rawKey });
  }

  return { codes: invertMapping(payload.mapping), dateShiftDays, createdAt: file.createdAt };
}

/**
 * original → code becomes code → original. Several originals can share one
 * code ("Helen", "Helen Carter", "helen" → "[Participant 1]"); the longest
 * is the fullest form and is used for re-identification.
 */
export function invertMapping(mapping: Record<string, string>): OpenedKey['codes'] {
  const byCode = new Map<string, string[]>();
  for (const [original, code] of Object.entries(mapping)) {
    const list = byCode.get(code) ?? [];
    list.push(original);
    byCode.set(code, list);
  }
  return Array.from(byCode.entries())
    .map(([code, originals]) => {
      const sorted = [...new Set(originals)].sort((a, b) => b.length - a.length || a.localeCompare(b));
      return { code, original: sorted[0], alsoWrittenAs: sorted.slice(1) };
    })
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/** Codes that cannot be safely reversed by plain text replacement. */
function isReversible(code: string): boolean {
  // Codes are bracketed tokens ("[NAME-3F7A91B2]", "[Person 2]"). A bare
  // value (e.g. a shifted date "2023-07-28") could also be real text.
  return /^\[[^\]]+\]$/.test(code);
}

/** Replace every code in `text` with its original. Returns the count. */
export function reidentifyText(text: string, key: OpenedKey): { text: string; replaced: number } {
  const codes = key.codes.filter((c) => isReversible(c.code)).sort((a, b) => b.code.length - a.code.length);
  let replaced = 0;
  let out = text;
  for (const { code, original } of codes) {
    const parts = out.split(code);
    if (parts.length > 1) {
      replaced += parts.length - 1;
      out = parts.join(original);
    }
  }
  return { text: out, replaced };
}
