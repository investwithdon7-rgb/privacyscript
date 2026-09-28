/**
 * Key file round trip: pseudonymise → encrypt key → open → re-identify.
 * Fictitious data only.
 */

import { describe, expect, it } from 'vitest';
import { Crypto } from '@peculiar/webcrypto';
import { encryptKeyFile, generateSessionSecret } from '@/engine/crypto';
import { replaceSpans } from '@/engine/replace';
import { detect } from '@/engine/detect';
import { invertMapping, openKeyFile, parseKeyFile, reidentifyText } from '@/engine/reidentify';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const PASS = 'correct horse battery staple';

describe('key file', () => {
  it('opens with the right passphrase and restores the original text', async () => {
    const secret = await generateSessionSecret();
    const text = 'Email jane.doe@example.org or call 07700 900123 about the visit on 12/03/2024.';
    const det = detect(text);
    const out = await replaceSpans(text, det.spans, det.quasiSpans, { mode: 'PSEUDONYMISE', secret, quasiToRedact: new Set() });
    expect(out.text).not.toContain('jane.doe@example.org');

    const file = parseKeyFile(JSON.stringify(await encryptKeyFile(secret.rawKey, out.mapping, PASS)));
    const key = await openKeyFile(file, PASS);
    expect(key.dateShiftDays).toBe(out.dateShiftDays);

    const back = reidentifyText(out.text, key);
    expect(back.text).toContain('jane.doe@example.org');
    expect(back.text).toContain('07700 900123');
    expect(back.replaced).toBeGreaterThanOrEqual(2);
  });

  it('refuses a wrong passphrase with a plain message', async () => {
    const secret = await generateSessionSecret();
    const file = await encryptKeyFile(secret.rawKey, { Jane: '[NAME-ABCDEF12]' }, PASS);
    await expect(openKeyFile(file, 'not the passphrase!')).rejects.toThrow(/Wrong passphrase/);
  });

  it('rejects files that are not key files', () => {
    expect(() => parseKeyFile('hello')).toThrow(/not a PrivacyScript key file/);
    expect(() => parseKeyFile('{"a":1}')).toThrow(/not a PrivacyScript key file/);
  });

  it('uses the fullest original when several share one code', () => {
    const codes = invertMapping({ Helen: '[Participant 1]', 'Helen Carter': '[Participant 1]', helen: '[Participant 1]' });
    expect(codes).toEqual([{ code: '[Participant 1]', original: 'Helen Carter', alsoWrittenAs: ['helen', 'Helen'] }]);
  });

  it('does not reverse bare values that could be real text', () => {
    const key = { codes: [{ code: '2023-07-28', original: '2024-03-01', alsoWrittenAs: [] }], dateShiftDays: -217, createdAt: '' };
    expect(reidentifyText('Seen 2023-07-28.', key).text).toBe('Seen 2023-07-28.');
  });
});
