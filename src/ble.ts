/**
 * Lock unlock via gatewaygo's localhost CLI.
 *
 * Architecture pivot (2026-05-06):
 *   We no longer use the Allwinner H3 BlueZ Bluetooth radio for BLE GATT
 *   unlocks. Instead, gatewaygo runs locally as the mesh driver and we
 *   issue `bleunlock <MAC>` to its CLI on 127.0.0.1:5299. gatewaygo handles
 *   the Wirepas mesh routing and the BLE-style command framing.
 *
 *   This module preserves the same exported interface as before
 *   (UnlockArgs / UnlockResult / unlockLock), so backend integration is
 *   unchanged. The offlineKey and offlineUnlockCmd fields are accepted but
 *   unused — gatewaygo encrypts at the Wirepas network layer using the
 *   chip's pre-provisioned cipher keys.
 */

import * as net from 'net';

const CLI_HOST = '127.0.0.1';
const CLI_PORT = 5299;
const UNLOCK_TIMEOUT_MS = 8_000;

export interface UnlockArgs {
  mac:               string;
  offlineKey:        string;
  offlineUnlockCmd:  string;
}
export interface UnlockResult {
  success:  boolean;
  message:  string;
  duration: number;
  battery?: number;
}

console.log('[ble] using gatewaygo CLI bridge (127.0.0.1:5299)');

/** Normalize a MAC to gatewaygo's expected colon-separated upper-case form. */
function normalizeMac(s: string): string {
  const clean = s.replace(/[:\s-]/g, '').toUpperCase();
  if (clean.length !== 12) throw new Error(`invalid mac: ${s}`);
  return clean.match(/.{2}/g)!.join(':');
}

export function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const start = Date.now();
  const mac = normalizeMac(args.mac);
  console.log(`[ble] unlock ${mac} (via gatewaygo CLI)`);

  return new Promise<UnlockResult>((resolve) => {
    const sock = new net.Socket();
    let buf = '';
    let resolved = false;

    const finish = (result: UnlockResult) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        success: false,
        message: `timeout (${UNLOCK_TIMEOUT_MS}ms) — no response from gatewaygo`,
        duration: Date.now() - start,
      });
    }, UNLOCK_TIMEOUT_MS);

    sock.setTimeout(UNLOCK_TIMEOUT_MS + 500);

    sock.on('connect', () => {
      sock.write(`bleunlock ${mac}\n`);
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // gatewaygo replies with stdout-style log lines. Two outcomes we look for:
      //  - "Send blesendcmd"          → command issued to mesh (best-effort confirmation)
      //  - "ResultType_SUCCESS"       → lock actually responded back through mesh
      //  - "ResultType_FAILED"        → lock declined / mesh delivery failed
      if (buf.includes('ResultType_SUCCESS')) {
        clearTimeout(timer);
        finish({
          success:  true,
          message:  'unlocked (mesh ack)',
          duration: Date.now() - start,
        });
      } else if (buf.includes('ResultType_FAILED') || buf.includes('not found')) {
        clearTimeout(timer);
        finish({
          success:  false,
          message:  buf.split('\n').find(l => /FAILED|not found/.test(l)) ?? 'mesh delivery failed',
          duration: Date.now() - start,
        });
      }
      // If we only see "Send blesendcmd", we wait the full timeout in case
      // a SUCCESS callback follows. The lock physically clicks even before
      // we see ResultType_SUCCESS, so the user's experience is fine either way.
    });

    sock.on('end', () => {
      clearTimeout(timer);
      // gatewaygo closed the socket. If we saw a "Send blesendcmd" we treat
      // that as a soft success — the command was issued and the mesh is
      // best-effort. The lock will or won't click depending on RF; the
      // backend's broadcast-to-all-bridges pattern means another gateway
      // probably succeeded.
      if (buf.includes('Send blesendcmd')) {
        finish({
          success:  true,
          message:  'queued via mesh',
          duration: Date.now() - start,
        });
      } else {
        finish({
          success:  false,
          message:  buf.trim().split('\n').slice(-1)[0] || 'gatewaygo closed without ack',
          duration: Date.now() - start,
        });
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      finish({
        success:  false,
        message:  `gatewaygo CLI error: ${err.message}`,
        duration: Date.now() - start,
      });
    });

    sock.connect(CLI_PORT, CLI_HOST);
  });
}
