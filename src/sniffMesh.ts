/**
 * Remote mesh capture — straces gatewaygo's serial reads/writes for a window
 * and returns the (gzipped) strace output. Triggered by the backend via the
 * existing bridge WebSocket. Decoded on the dev side with parseStrace.ts.
 *
 * Why strace instead of opening /dev/ttyS3 ourselves: gatewaygo holds the
 * serial port exclusively. Stopping it briefly would break unlocks for the
 * duration of the capture. Attaching strace to its PID is non-disruptive —
 * gatewaygo keeps running, we just observe its UART syscalls.
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import * as fs from 'fs';
import * as zlib from 'zlib';

const exec = promisify(execCb);
const gzip = promisify(zlib.gzip);

const MAX_SECONDS = 600;    // cap at 10 minutes — anything longer is a config error
const MIN_SECONDS = 5;

/**
 * Run strace against gatewaygo for `seconds`, return gzipped output.
 *
 * Output is the raw strace text — pipe it through `parseStrace.ts` on the
 * dev side to decode Wirepas frames. Includes both directions of UART
 * (host->chip and chip->host).
 */
export async function captureGatewaygoUart(seconds: number): Promise<{ data: Buffer; rawBytes: number; pid: number }> {
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new Error(`seconds must be ${MIN_SECONDS}..${MAX_SECONDS}, got ${seconds}`);
  }

  // 1. Find gatewaygo's PID. Match on the binary name regardless of full path
  //    (could be /usr/local/bin/gatewaygo, /usr/local/bin/gatewaygo-arm-bin, etc.)
  const { stdout: pidOut } = await exec('pgrep -f "gatewaygo" || true');
  const pids = pidOut.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  if (pids.length === 0) {
    throw new Error('gatewaygo not running on this bridge — nothing to strace');
  }
  if (pids.length > 1) {
    console.warn(`[sniff-mesh] multiple gatewaygo PIDs: ${pids.join(',')} — using first (${pids[0]})`);
  }
  const pid = pids[0];

  // 2. Run strace into a temp file. Format expected by parseStrace.ts:
  //    - -y prints fd as e.g. 7</dev/ttyS3> so we can filter to ttyS3
  //    - -x escapes non-printable bytes as \xHH (mandatory for binary capture)
  //    - -s 4096 lets the data string fit a full UART read (chip indications < 256B)
  const outPath = `/tmp/sniff-${Date.now()}-${pid}.strace`;
  console.log(`[sniff-mesh] strace -p ${pid} -> ${outPath} for ${seconds}s`);

  const proc = spawn('strace', [
    '-p', String(pid),
    '-e', 'trace=read,write',
    '-y', '-x', '-s', '4096',
    '-o', outPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  // strace attaches with PTRACE_ATTACH. If the kernel rejects (ptrace_scope
  // restriction, wrong user), strace exits non-zero almost immediately —
  // catch that and surface a clear error.
  const earlyExit = new Promise<number>((resolve) => proc.once('exit', (code) => resolve(code ?? 0)));
  const settled = await Promise.race([
    earlyExit,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  if (settled !== null) {
    throw new Error(`strace exited immediately with code ${settled} — likely permission / ptrace_scope issue`);
  }

  // 3. Sleep for the capture window, then SIGINT strace (graceful detach).
  await new Promise(r => setTimeout(r, seconds * 1000));
  proc.kill('SIGINT');
  await earlyExit;

  // 4. Read, gzip, return. Delete the tmp file on success.
  if (!fs.existsSync(outPath)) {
    throw new Error(`strace produced no output file at ${outPath}`);
  }
  const raw = fs.readFileSync(outPath);
  const rawBytes = raw.length;
  const compressed = await gzip(raw);
  try { fs.unlinkSync(outPath); } catch { /* keep file around if cleanup fails */ }

  console.log(`[sniff-mesh] captured ${rawBytes} bytes -> ${compressed.length} gzipped`);
  return { data: compressed, rawBytes, pid };
}
