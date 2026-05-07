/**
 * Lock unlock via gatewaygo's localhost CLI.
 *
 * Architecture:
 *   gatewaygo runs locally as the mesh driver. We issue `bleunlock <MAC>` to
 *   its CLI on 127.0.0.1:5299. gatewaygo handles Wirepas mesh routing and
 *   BLE-style command framing.
 *
 *   IMPORTANT (2026-05-07 finding): gatewaygo redirects its stdout to its
 *   log file (/var/log/log_gatewaygo.log) shortly after startup, so the TCP
 *   socket gets ZERO data back from a `bleunlock` command. The mesh TX still
 *   happens — gatewaygo writes a "Send blesendcmd to: Lock:<n> Mac:<short>"
 *   line to its log — but you can't read that line on the socket.
 *
 *   We therefore tail the log file looking for our MAC's confirmation rather
 *   than parsing socket output.
 */

import * as fs from 'fs';
import * as net from 'net';

const CLI_HOST = '127.0.0.1';
const CLI_PORT = 5299;
const UNLOCK_TIMEOUT_MS = 6_000;
const LOG_POLL_MS = 250;

const LOG_PATH_CANDIDATES = [
  process.env.GATEWAYGO_LOG,
  '/var/log/log_gatewaygo.log',
  '/var/log.hdd/log_gatewaygo.log',
].filter(Boolean) as string[];

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

console.log('[ble] using gatewaygo CLI bridge (127.0.0.1:5299) + log tail');

/** Pick the gatewaygo log path most likely to be active right now. */
function pickLogPath(): string | null {
  // Prefer a candidate that's been written to recently
  for (const p of LOG_PATH_CANDIDATES) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs < 5 * 60_000) return p;
    } catch { /* try next */ }
  }
  // Fall back to first that exists
  for (const p of LOG_PATH_CANDIDATES) {
    try { fs.statSync(p); return p; } catch { /* try next */ }
  }
  return null;
}

/** Normalize a MAC to gatewaygo's expected colon-separated upper-case form. */
function normalizeMac(s: string): string {
  const clean = s.replace(/[:\s-]/g, '').toUpperCase();
  if (clean.length !== 12) throw new Error(`invalid mac: ${s}`);
  return clean.match(/.{2}/g)!.join(':');
}

/** gatewaygo logs use the lower 3 bytes of the MAC, e.g. "Mac:8CDBAB". */
function shortMac(mac: string): string {
  return mac.replace(/:/g, '').slice(-6).toUpperCase();
}

/** Read bytes from `fromPos` to current EOF. */
function readNewBytes(path: string, fromPos: number): { content: string; newPos: number } {
  try {
    const st = fs.statSync(path);
    if (st.size <= fromPos) return { content: '', newPos: fromPos };
    const fd = fs.openSync(path, 'r');
    const len = st.size - fromPos;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromPos);
    fs.closeSync(fd);
    return { content: buf.toString('utf8'), newPos: st.size };
  } catch {
    return { content: '', newPos: fromPos };
  }
}

export function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const start    = Date.now();
  const mac      = normalizeMac(args.mac);
  const macShort = shortMac(mac);
  console.log(`[ble] unlock ${mac} (short ${macShort}) via gatewaygo CLI`);

  // Tail the active gatewaygo log starting at its current EOF
  const logPath = pickLogPath();
  let logPos = 0;
  if (logPath) {
    try { logPos = fs.statSync(logPath).size; } catch { /* file may not exist yet */ }
  }

  return new Promise<UnlockResult>((resolve) => {
    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const sock = new net.Socket();
    let sawSendCmd = false;

    const finish = (result: UnlockResult) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    sock.setTimeout(UNLOCK_TIMEOUT_MS + 500);

    sock.on('connect', () => {
      sock.write(`bleunlock ${mac}\n`);
    });

    sock.on('error', (err) => {
      finish({
        success:  false,
        message:  `gatewaygo CLI error: ${err.message}`,
        duration: Date.now() - start,
      });
    });

    // gatewaygo currently doesn't write back on the bleunlock socket, but if
    // a future version does, capture & inspect.
    let sockBuf = '';
    sock.on('data', (chunk) => {
      sockBuf += chunk.toString('utf8');
      if (/ResultType_SUCCESS/.test(sockBuf)) {
        finish({ success: true,  message: 'unlocked (mesh ack)',          duration: Date.now() - start });
      } else if (/ResultType_FAILED|not found/.test(sockBuf)) {
        finish({ success: false, message: 'mesh delivery failed (socket)', duration: Date.now() - start });
      }
    });

    sock.on('end', () => {
      // Socket closed. If the log already confirmed Send blesendcmd, soft-success.
      // Otherwise leave the timeout to handle the unknown case.
      if (sawSendCmd) {
        finish({ success: true, message: 'queued via mesh', duration: Date.now() - start });
      }
    });

    // Poll the log file for our MAC's confirmation
    if (logPath) {
      const sendRe = new RegExp(`Send blesendcmd[^\\n]*Mac:${macShort}`, 'i');
      pollTimer = setInterval(() => {
        const { content, newPos } = readNewBytes(logPath, logPos);
        logPos = newPos;
        if (content.length === 0) return;
        if (sendRe.test(content)) {
          sawSendCmd = true;
          finish({
            success:  true,
            message:  'queued via mesh (Send blesendcmd in log)',
            duration: Date.now() - start,
          });
        } else if (/ResultType_FAILED/.test(content)) {
          finish({
            success:  false,
            message:  'mesh delivery failed (ResultType_FAILED in log)',
            duration: Date.now() - start,
          });
        }
      }, LOG_POLL_MS);
    }

    timeoutTimer = setTimeout(() => {
      finish({
        success:  false,
        message:  logPath
          ? `timeout (${UNLOCK_TIMEOUT_MS}ms) — no Send blesendcmd in log`
          : `timeout (${UNLOCK_TIMEOUT_MS}ms) — no gatewaygo log file found`,
        duration: Date.now() - start,
      });
    }, UNLOCK_TIMEOUT_MS);

    sock.connect(CLI_PORT, CLI_HOST);
  });
}
