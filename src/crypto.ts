import * as crypto from 'crypto';

/**
 * Noke offline unlock for "scheduled" unlock commands.
 * Ported from noke-mobile-library-android NokeDevice.scheduledOfflineUnlock().
 * The backend stores scheduledUnlockCmd, so we use this variant
 * (no timestamp/checksum injection — just AES-128 ECB decrypt with
 * the offlineKey + session sum as the combined key).
 */
export function generateUnlockCommand(
  offlineKeyHex: string,
  offlineUnlockCmdHex: string,
  sessionHex: string,
): string {
  const offlineKey = Buffer.from(offlineKeyHex, 'hex');
  const unlockCmd  = Buffer.from(offlineUnlockCmdHex, 'hex');
  const sessionAll = Buffer.from(sessionHex, 'hex');

  if (offlineKey.length !== 16) throw new Error('offlineKey must be 16 bytes');
  if (unlockCmd.length !== 20)  throw new Error('offlineUnlockCmd must be 20 bytes');
  if (sessionAll.length < 20)   throw new Error('session must be 20 bytes');

  const header  = unlockCmd.subarray(0, 4);
  const cmddata = Buffer.from(unlockCmd.subarray(4, 20));

  // Combined key = offlineKey[i] + session[i] (mod 256), bytes 0..15
  const preSessionKey = Buffer.alloc(16);
  for (let x = 0; x < 16; x++) {
    preSessionKey[x] = (offlineKey[x] + sessionAll[x]) & 0xff;
  }

  // AES-128 ECB DECRYPT (Noke's "encrypt" direction is decrypt)
  const decipher = crypto.createDecipheriv('aes-128-ecb', preSessionKey, null);
  decipher.setAutoPadding(false);
  const transformed = Buffer.concat([decipher.update(cmddata), decipher.final()]);

  return Buffer.concat([header, transformed]).toString('hex');
}

export function parseSession(sessionHex: string): {
  batteryLevel: number;
  isLocked: boolean;
  rawSession: Buffer;
} {
  const buf = Buffer.from(sessionHex, 'hex');
  return {
    batteryLevel: buf[2] ?? 0,
    isLocked: ((buf[3] ?? 0) & 0x01) === 0,
    rawSession: buf,
  };
}
