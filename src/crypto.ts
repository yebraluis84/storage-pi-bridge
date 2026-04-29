/**
 * Noke offline unlock cryptography (reverse engineered).
 *
 * The lock validates an unlock command by combining:
 *   - Its stored 16-byte offlineKey (we have this from /user/locks/)
 *   - 16 bytes of session data the lock broadcasts on each connection
 *
 * Both are XORed into a single AES-128-ECB key, which decrypts the
 * 16-byte unlockCmd payload. The first byte of the decrypted payload
 * must equal 0x01, and bytes 2-5 contain the timestamp the lock will
 * compare against its own clock.
 */

import * as crypto from 'crypto';

/**
 * Generate an unlock command for a Noke lock.
 *
 * @param offlineKeyHex      - 32-char hex (16-byte AES key, from Noke's /user/locks/)
 * @param offlineUnlockCmdHex - 40-char hex (20-byte unlock template, from Noke)
 * @param sessionHex         - 40-char hex (20-byte session blob, read from lock's session characteristic)
 * @returns 20-byte unlock command, hex encoded
 */
export function generateUnlockCommand(
  offlineKeyHex: string,
  offlineUnlockCmdHex: string,
  sessionHex: string,
): string {
  const offlineKey = Buffer.from(offlineKeyHex, 'hex');
  const sessionAll = Buffer.from(sessionHex, 'hex');

  if (offlineKey.length !== 16) throw new Error(`offlineKey must be 16 bytes, got ${offlineKey.length}`);
  if (sessionAll.length < 20)   throw new Error(`session must be 20 bytes, got ${sessionAll.length}`);

  // The lock's session message is 20 bytes; the last 16 bytes are the session key material
  const session = sessionAll.subarray(4, 20);

  // Combine offlineKey + session byte-wise to form the AES key
  const combined = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    combined[i] = offlineKey[i] ^ session[i];
  }

  // The "offlineUnlockCmd" we got from Noke is the AES-encrypted unlock payload
  // template. Decrypt to verify, then re-encrypt with the session-mixed key.
  const cmd = Buffer.from(offlineUnlockCmdHex, 'hex');
  if (cmd.length !== 20) throw new Error(`offlineUnlockCmd must be 20 bytes, got ${cmd.length}`);

  // First 4 bytes are the command header (type + timestamp), unencrypted
  const header  = cmd.subarray(0, 4);
  const payload = cmd.subarray(4, 20);

  // Encrypt payload with combined key
  const cipher  = crypto.createCipheriv('aes-128-ecb', combined, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);

  // Concatenate: header + encrypted payload
  const result = Buffer.concat([header, encrypted]);

  // Recompute the checksum byte (last byte = sum of bytes 0..14 mod 256)
  let checksum = 0;
  for (let i = 0; i < 19; i++) checksum = (checksum + result[i]) & 0xff;
  result[19] = checksum;

  return result.toString('hex');
}

/**
 * Parse the session blob the lock advertises.
 * Returns useful metadata.
 */
export function parseSession(sessionHex: string): {
  batteryLevel: number;
  isLocked:     boolean;
  rawSession:   Buffer;
} {
  const buf = Buffer.from(sessionHex, 'hex');
  return {
    batteryLevel: buf[2] ?? 0,
    isLocked:     ((buf[3] ?? 0) & 0x01) === 0,
    rawSession:   buf,
  };
}
