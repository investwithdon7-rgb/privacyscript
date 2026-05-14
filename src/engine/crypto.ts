import { KEY_FILE_PARAMS } from '@/lib/constants';

/**
 * Session secret — a CryptoKey imported as HMAC-SHA256. Lives in memory only.
 * On tab close it is gone. The user owns persistence via the key file download.
 */
export interface SessionSecret {
  hmacKey: CryptoKey;
  /** Raw key material (32 bytes) — needed to write the re-id key file. */
  rawKey: Uint8Array;
}

/**
 * Generate a fresh 256-bit HMAC key for a session. Random bytes from the
 * platform CSPRNG (Web Crypto). Imported into a CryptoKey for sign operations.
 */
export async function generateSessionSecret(): Promise<SessionSecret> {
  const rawKey = new Uint8Array(32);
  crypto.getRandomValues(rawKey);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return { hmacKey, rawKey };
}

/**
 * Deterministic pseudonym for (label, token). Same secret + label + token
 * always yields the same pseudonym in a session.
 *
 * Format: [LABEL-XXXXXXXX] — 8 hex chars of HMAC-SHA256(secret, "label:token").
 */
export async function generatePseudonym(
  secret: SessionSecret,
  label: string,
  token: string
): Promise<string> {
  const data = new TextEncoder().encode(`${label}:${token}`);
  const sig = await crypto.subtle.sign('HMAC', secret.hmacKey, data);
  const bytes = new Uint8Array(sig);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `[${label.toUpperCase()}-${hex.slice(0, 8).toUpperCase()}]`;
}

/**
 * Encrypt the re-identification key file with a user-provided passphrase.
 * Layout: PBKDF2(passphrase, salt, iters) -> AES-GCM key -> AES-GCM(plaintext).
 *
 * The output JSON contains everything needed to decrypt with the passphrase:
 * salt, iv, iterations, ciphertext. The passphrase itself is never persisted.
 */
export interface EncryptedKeyFile {
  version: 1;
  algorithm: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  createdAt: string;
}

export async function encryptKeyFile(
  rawKey: Uint8Array,
  mapping: Record<string, string>,
  passphrase: string
): Promise<EncryptedKeyFile> {
  if (passphrase.length < 12) {
    throw new Error('Passphrase must be at least 12 characters.');
  }

  const salt = new Uint8Array(KEY_FILE_PARAMS.saltBytes);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(KEY_FILE_PARAMS.ivBytes);
  crypto.getRandomValues(iv);

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
      salt,
      iterations: KEY_FILE_PARAMS.pbkdf2Iterations,
      hash: KEY_FILE_PARAMS.hash,
    },
    passKey,
    { name: 'AES-GCM', length: KEY_FILE_PARAMS.aesKeyBits },
    false,
    ['encrypt']
  );

  const payload = new TextEncoder().encode(
    JSON.stringify({
      sessionKey: bytesToB64(rawKey),
      mapping,
    })
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    payload
  );

  return {
    version: 1,
    algorithm: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iterations: KEY_FILE_PARAMS.pbkdf2Iterations,
    saltB64: bytesToB64(salt),
    ivB64: bytesToB64(iv),
    ciphertextB64: bytesToB64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString(),
  };
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return typeof btoa !== 'undefined' ? btoa(s) : Buffer.from(b).toString('base64');
}
