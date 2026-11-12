/**
 * Lock unlock via gatewaygo's localhost CLI — with REAL confirmation.
 *
 * Architecture:
 *   gatewaygo runs locally as the mesh driver. We issue `bleunlock <MAC>` to
 *   its CLI on 127.0.0.1:5299 to dispatch the unlock into the Wirepas mesh.
 *
 *   IMPORTANT: gatewaygo does NOT reply on the socket for `bleunlock` (it
 *   redirects stdout to its log file after startup). The OLD code treated the
 *   mere *dispatch* of the command ("Send blesendcmd" in the log) as success —
 *   that was a phantom: the command leaving for the mesh says nothing about
 *   whether the lock actually opened. In the field this made the app report
 *   "Unlocked" while the door stayed shut, with no real reason.
 *
 *   We now CONFIRM the open the same way gatewaygo tracks it: after dispatch we
 *   poll `lock <MAC>` (which DOES reply on the socket, as JSON) and only report
 *   success when the lock itself reports `lockState: UNLOCKED` with a fresh
 *   check-in. Anything else returns an honest, specific reason.
 */

import * as net from 'net';

const CLI_HOST = '127.0.0.1';
const CLI_PORT = 5299;

// How long to wait for the lock to report back after we dispatch the unlock.
const CONFIRM_TIMEOUT_MS = 9_000;
const CONFIRM_POLL_MS    = 600;
// A lock reading is only trustworthy if the lock was heard this recently —
// otherwise gatewaygo is handing us a stale cached state.
const FRESH_SECONDS      = 25;

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

console.log('[ble] using gatewaygo CLI bridge (127.0.0.1:5299) + lock-state confirmation');

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Normalize a MAC to gatewaygo's expected colon-separated upper-case form. */
function normalizeMac(s: string): string {
  const clean = s.replace(/[:\s-]/g, '').toUpperCase();
  if (clean.length !== 12) throw new Error(`invalid mac: ${s}`);
  return clean.match(/.{2}/g)!.join(':');
}

/**
 * Issue a one-shot gatewaygo CLI command and collect its socket reply.
 * `doneWhen` lets a query resolve as soon as the useful payload has arrived
 * (gatewaygo keeps the socket open otherwise). On connect failure the reason
 * is returned via the `error` field so callers can report "gateway offline".
 */
function cliQuery(
  cmd: string,
  opts: { waitMs?: number; doneWhen?: RegExp } = {},
): Promise<{ out: string; error: string | null }> {
  const waitMs = opts.waitMs ?? 2500;
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = '';
    let done = false;
    let err: string | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ out: buf, error: err });
    };
    const hardTimer = setTimeout(finish, waitMs);
    sock.setTimeout(waitMs, finish);
    sock.on('connect', () => { sock.write(cmd + '\n'); });
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (opts.doneWhen && opts.doneWhen.test(buf)) { clearTimeout(hardTimer); finish(); }
    });
    sock.on('error', (e) => { err = e.message; clearTimeout(hardTimer); finish(); });
    sock.on('close', () => { clearTimeout(hardTimer); finish(); });
    sock.connect(CLI_PORT, CLI_HOST);
  });
}

function parseLock(json: string): { state: string | null; seen: number | null; battery: number | null } {
  const state   = (json.match(/"lockState":\s*"([^"]+)"/)           || [])[1] ?? null;
  const seenStr = (json.match(/"secondsSinceLastSeen":\s*(-?\d+)/)  || [])[1];
  const voltStr = (json.match(/"wiredVoltage":\s*([-\d.]+)/)        || [])[1];
  return {
    state,
    seen:    seenStr != null ? parseInt(seenStr, 10) : null,
    battery: voltStr != null ? Math.round(parseFloat(voltStr)) : null,
  };
}

/**
 * Unlock a lock via the mesh and CONFIRM it actually opened.
 *
 * Returns success:true ONLY when the lock reports UNLOCKED with a fresh
 * check-in. Otherwise the message says exactly what went wrong so the app /
 * activity log shows real data instead of a fake "Unlocked".
 */
export async function unlockLock(args: UnlockArgs): Promise<UnlockResult> {
  const start = Date.now();
  let mac: string;
  try {
    mac = normalizeMac(args.mac);
  } catch (e) {
    return { success: false, message: (e as Error).message, duration: Date.now() - start };
  }
  console.log(`[ble] unlock ${mac} via gatewaygo CLI (confirm by lock state)`);

  // 1. Dispatch the unlock into the mesh. gatewaygo won't reply on the socket;
  //    we don't treat this as success — it only means the command was sent.
  const dispatch = await cliQuery(`bleunlock ${mac}`, { waitMs: 2000 });
  if (dispatch.error) {
    return {
      success:  false,
      message:  `gateway offline (gatewaygo CLI: ${dispatch.error})`,
      duration: Date.now() - start,
    };
  }

  // 2. Confirm the REAL open: poll the lock's own reported state.
  let sawFresh = false;
  let lastState: string | null = null;
  let battery: number | null = null;
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { out, error } = await cliQuery(`lock ${mac}`, {
      waitMs: 2500,
      doneWhen: /secondsSinceLastSeen/,
    });
    if (error) {
      return {
        success:  false,
        message:  `gateway offline (gatewaygo CLI: ${error})`,
        duration: Date.now() - start,
      };
    }
    const { state, seen, battery: b } = parseLock(out);
    if (state !== null) lastState = state;
    if (b !== null) battery = b;
    const fresh = seen !== null && seen >= 0 && seen < FRESH_SECONDS;
    if (fresh) sawFresh = true;

    if (fresh && state === 'UNLOCKED') {
      return {
        success:  true,
        message:  'unlocked',
        duration: Date.now() - start,
        battery:  battery ?? undefined,
      };
    }
    await sleep(CONFIRM_POLL_MS);
  }

  // 3. No confirmation within the window — report the honest reason.
  if (!sawFresh) {
    return {
      success:  false,
      message:  'lock not reachable on mesh (no recent check-in from lock)',
      duration: Date.now() - start,
      battery:  battery ?? undefined,
    };
  }
  if (lastState === 'LOCKED') {
    return {
      success:  false,
      message:  'lock received command but did not open (still LOCKED)',
      duration: Date.now() - start,
      battery:  battery ?? undefined,
    };
  }
  return {
    success:  false,
    message:  `lock did not confirm open (last state: ${lastState ?? 'unknown'})`,
    duration: Date.now() - start,
    battery:  battery ?? undefined,
  };
}
